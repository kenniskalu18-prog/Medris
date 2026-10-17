/* eslint-disable @typescript-eslint/no-explicit-any -- tool payloads are untyped JSON from PostgREST and Gemini */
import type { DataContext, Identity } from "../../database/context.js";
import { LeviRepository } from "../../database/repositories/levi.repository.js";
import { CartRepository } from "../../database/repositories/cart.repository.js";
import { cleanText, enc, haversineKm, normalize, relatedTerms, scoreText } from "./levi.text.js";

/**
 * Levi's tools. Each one authorises itself: catalogue tools read only
 * active listings of verified, active vendors; "my_*" tools are always
 * scoped to the signed-in user id resolved from their token on the server.
 * Gemini never gets SQL access or a key.
 */

export interface LeviContext {
  data: DataContext;
  /** The verified caller; cart writes run as this user so the database applies its own rules. */
  identity: Identity;
  userId: string;
  lat: number | null;
  lng: number | null;
}

type Row = Record<string, any>;
type Args = Record<string, any>;

interface QueryResult {
  ok: boolean;
  data: any;
}

const TOOL_CACHE_TTL = 20_000;

/**
 * Runs one read as service_role. A failure (bad id from the model, database
 * hiccup) comes back as { ok: false } - what a failed REST call gave before -
 * so a tool degrades to "nothing found" instead of breaking the chat.
 */
async function query(ctx: LeviContext, read: (repo: LeviRepository) => Promise<Row[]>): Promise<QueryResult> {
  try {
    return { ok: true, data: await ctx.data.asService((tx) => read(new LeviRepository(tx))) };
  } catch {
    return { ok: false, data: null };
  }
}

interface Catalog {
  sectors: Row[];
  categories: Row[];
  vendors: Row[];
}

// Small per-instance cache of the slow-changing catalogue tables.
let catalogCache: { expires: number; value: Catalog | null } = { expires: 0, value: null };

async function getCatalog(ctx: LeviContext): Promise<Catalog> {
  if (catalogCache.value && catalogCache.expires > Date.now()) return catalogCache.value;
  const [sectorsRes, categoriesRes, vendorsRes] = await Promise.all([
    query(ctx, (r) => r.sectors()),
    query(ctx, (r) => r.categories()),
    query(ctx, (r) => r.verifiedVendors()),
  ]);
  const value: Catalog = {
    sectors: sectorsRes.ok ? sectorsRes.data || [] : [],
    categories: categoriesRes.ok ? categoriesRes.data || [] : [],
    vendors: vendorsRes.ok ? vendorsRes.data || [] : [],
  };
  catalogCache = { expires: Date.now() + TOOL_CACHE_TTL, value };
  return value;
}

async function getProductSnapshot(ctx: LeviContext): Promise<Row[]> {
  const res = await query(ctx, (r) => r.activeProducts());
  return res.ok ? res.data || [] : [];
}

function categoryOf(catalog: Catalog, product: Row): Row | undefined {
  return catalog.categories.find((c) => String(c.id) === String(product.category_id));
}
function sectorOf(catalog: Catalog, product: Row, category?: Row): Row | undefined {
  return catalog.sectors.find((s) => String(s.id) === String(category?.sector_id || product.vendor?.sector_id));
}

function productSearchScore(product: Row, query: string, catalog: Catalog, options: Args = {}): number {
  const category = categoryOf(catalog, product);
  const sector = sectorOf(catalog, product, category);
  const terms = relatedTerms(query);
  const fields = [product.name, product.description, category?.name, sector?.name, product.vendor?.business_name].filter(Boolean);
  let score = normalize(query) ? scoreText(query, fields) : 1;
  const hay = fields.map(normalize).join(" ");
  for (const term of terms) if (hay.includes(normalize(term))) score += term === normalize(query) ? 7 : 2;
  if (options.listingType) {
    const lt = normalize(product.listing_type);
    if (options.listingType === "rent" && !["rent", "both"].includes(lt)) return -Infinity;
    if (options.listingType === "sale" && !["sale", "both"].includes(lt)) return -Infinity;
  }
  if (options.category && normalize(category?.name) !== normalize(options.category) && !hay.includes(normalize(options.category))) return -Infinity;
  if (options.sector && normalize(sector?.name) !== normalize(options.sector) && !hay.includes(normalize(options.sector))) return -Infinity;
  if (options.buyOnly && !["sale", "both"].includes(normalize(product.listing_type))) return -Infinity;
  if (options.rentOnly && !["rent", "both"].includes(normalize(product.listing_type))) return -Infinity;
  if (Number(product.quantity_available ?? 1) <= 0 && options.inStock !== false) score -= 8;
  return score;
}

function publicProduct(product: Row, catalog: Catalog, buyerLat: number | null, buyerLng: number | null): Row {
  const category = categoryOf(catalog, product);
  const sector = sectorOf(catalog, product, category);
  const distanceKm = buyerLat != null && buyerLng != null ? haversineKm(buyerLat, buyerLng, Number(product.vendor?.lat), Number(product.vendor?.lng)) : null;
  return {
    id: product.id,
    name: product.name,
    description: cleanText(product.description, 220),
    category: category?.name || null,
    sector: sector?.name || null,
    listing_type: product.listing_type,
    sale_price: product.sale_price,
    discount_price: product.discount_price,
    rental_rate: product.rental_rate,
    rental_rate_unit: product.rental_rate_unit,
    is_service: !!product.is_service,
    quantity_available: product.quantity_available,
    view_count: product.view_count,
    created_at: product.created_at,
    vendor: product.vendor
      ? {
          id: product.vendor.id,
          business_name: product.vendor.business_name,
          city: product.vendor.city,
          avg_rating: product.vendor.avg_rating,
          review_count: product.vendor.review_count,
          distance_km: Number.isFinite(distanceKm) ? Number((distanceKm as number).toFixed(2)) : null,
        }
      : null,
  };
}

/* ---------------------------------------------------------- catalogue tools */

async function searchProducts(args: Args, ctx: LeviContext) {
  const catalog = await getCatalog(ctx);
  const products = await getProductSnapshot(ctx);
  const q = cleanText(args.query, 120);
  const scored = products.map((p) => ({ p, score: productSearchScore(p, q, catalog, args) })).filter((x) => x.score > 0);
  const { lat: buyerLat, lng: buyerLng } = ctx;
  scored.sort((a, b) => {
    if (args.nearest && buyerLat != null && buyerLng != null) {
      const da = haversineKm(buyerLat, buyerLng, Number(a.p.vendor?.lat), Number(a.p.vendor?.lng));
      const db = haversineKm(buyerLat, buyerLng, Number(b.p.vendor?.lat), Number(b.p.vendor?.lng));
      if (da !== db) return da - db;
    }
    if (args.sort === "rating") return Number(b.p.vendor?.avg_rating || 0) - Number(a.p.vendor?.avg_rating || 0);
    if (args.sort === "newest") return new Date(b.p.created_at || 0).getTime() - new Date(a.p.created_at || 0).getTime();
    if (args.sort === "popular") return Number(b.p.view_count || 0) - Number(a.p.view_count || 0);
    return b.score - a.score;
  });
  const rows = scored.slice(0, Math.max(1, Math.min(20, Number(args.limit) || 8))).map((x) => publicProduct(x.p, catalog, buyerLat, buyerLng));
  return { query: q, count: scored.length, results: rows };
}

async function searchVendors(args: Args, ctx: LeviContext) {
  const catalog = await getCatalog(ctx);
  let vendors = [...catalog.vendors];
  const q = cleanText(args.query, 120);
  const sector = cleanText(args.sector, 80);
  const city = cleanText(args.city, 80);
  const sectorName = (v: Row) => catalog.sectors.find((s) => String(s.id) === String(v.sector_id))?.name || null;
  if (sector) {
    const sectorRow = catalog.sectors.find((s) => normalize(s.name) === normalize(sector) || normalize(s.name).includes(normalize(sector)));
    if (sectorRow) vendors = vendors.filter((v) => String(v.sector_id) === String(sectorRow.id));
  }
  if (city) vendors = vendors.filter((v) => normalize(v.city).includes(normalize(city)));
  if (args.minRating != null) vendors = vendors.filter((v) => Number(v.avg_rating || 0) >= Number(args.minRating));

  // "Who sells shoes?": resolve the need against the catalogue, then keep the vendors that carry those listings.
  if (args.productQuery) {
    const productResult = await searchProducts(
      { query: args.productQuery, listingType: args.listingType, rentOnly: !!args.rentOnly, buyOnly: !!args.buyOnly, limit: 20, nearest: !!args.nearest },
      ctx,
    );
    const ids = new Set((productResult.results || []).map((p) => p.vendor?.id).filter(Boolean));
    vendors = vendors.filter((v) => ids.has(v.id));
  } else if (q) {
    const scored = vendors.map((v) => ({ v, score: scoreText(q, [v.business_name, v.city, sectorName(v)]) })).filter((x) => x.score > 0);
    vendors = scored.sort((a, b) => b.score - a.score).map((x) => x.v);
  }

  const nearest = !!args.nearest && ctx.lat != null && ctx.lng != null;
  const out: Row[] = vendors.map((v) => {
    const distance = nearest ? haversineKm(ctx.lat as number, ctx.lng as number, Number(v.lat), Number(v.lng)) : null;
    return { ...v, sector: sectorName(v), distance_km: Number.isFinite(distance) ? Number((distance as number).toFixed(2)) : null };
  });
  out.sort((a, b) => {
    if (nearest) return (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity);
    if (args.sort === "rating") return Number(b.avg_rating || 0) - Number(a.avg_rating || 0);
    if (args.sort === "reviews") return Number(b.review_count || 0) - Number(a.review_count || 0);
    return normalize(a.business_name).localeCompare(normalize(b.business_name));
  });
  return {
    count: out.length,
    location_available: ctx.lat != null && ctx.lng != null,
    results: out
      .slice(0, Math.max(1, Math.min(30, Number(args.limit) || 10)))
      .map((v) => ({ id: v.id, business_name: v.business_name, city: v.city, sector: v.sector, avg_rating: v.avg_rating, review_count: v.review_count, distance_km: v.distance_km })),
  };
}

async function getCatalogOverview(ctx: LeviContext) {
  const catalog = await getCatalog(ctx);
  const products = await getProductSnapshot(ctx);
  const sectorMap = new Map(catalog.sectors.map((s) => [String(s.id), s.name]));
  const productCounts: Record<string, number> = {};
  const vendorCounts: Record<string, number> = {};
  for (const p of products) {
    const c = categoryOf(catalog, p);
    const key = sectorMap.get(String(c?.sector_id || p.vendor?.sector_id)) || "Other";
    productCounts[key] = (productCounts[key] || 0) + 1;
  }
  for (const v of catalog.vendors) {
    const key = sectorMap.get(String(v.sector_id)) || "Other";
    vendorCounts[key] = (vendorCounts[key] || 0) + 1;
  }
  return {
    sectors: catalog.sectors.map((s) => ({ id: s.id, name: s.name })),
    categories: catalog.categories.slice(0, 200),
    verified_active_vendors: catalog.vendors.length,
    active_products: products.length,
    vendor_counts_by_sector: vendorCounts,
    product_counts_by_sector: productCounts,
    category_count: catalog.categories.length,
  };
}

async function searchPackages(args: Args, ctx: LeviContext) {
  const q = cleanText(args.query, 120);
  const terms = relatedTerms(q);
  const res = await query(ctx, (r) => r.activePackages());
  const rows: Row[] = res.ok ? res.data || [] : [];
  const scored = rows
    .map((pkg) => {
      const text = [pkg.name, pkg.description, pkg.vendor?.business_name, pkg.vendor?.city].filter(Boolean).join(" ");
      let score = q ? scoreText(q, [text]) : 1;
      for (const term of terms) if (normalize(text).includes(normalize(term))) score += term === normalize(q) ? 6 : 2;
      return { pkg, score };
    })
    .filter((x) => !q || x.score > 0);
  scored.sort((a, b) => b.score - a.score || new Date(b.pkg.created_at || 0).getTime() - new Date(a.pkg.created_at || 0).getTime());
  return {
    query: q,
    count: scored.length,
    results: scored.slice(0, Math.min(15, Number(args.limit) || 8)).map(({ pkg }) => ({
      id: pkg.id,
      name: pkg.name,
      description: cleanText(pkg.description, 220),
      price: pkg.price,
      created_at: pkg.created_at,
      vendor: pkg.vendor
        ? { id: pkg.vendor.id, business_name: pkg.vendor.business_name, city: pkg.vendor.city, avg_rating: pkg.vendor.avg_rating, review_count: pkg.vendor.review_count }
        : null,
    })),
  };
}

async function searchEverything(args: Args, ctx: LeviContext) {
  const q = cleanText(args.query, 120);
  const catalog = await getCatalog(ctx);
  const [products, packages, vendors] = await Promise.all([
    searchProducts({ query: q, sector: args.sector || "", category: args.category || "", listingType: args.listingType, nearest: !!args.nearest, sort: args.sort || "relevance", limit: 8 }, ctx),
    searchPackages({ query: q, limit: 6 }, ctx),
    searchVendors(
      {
        query: q,
        productQuery: args.productQuery || "",
        sector: args.sector || "",
        city: args.city || "",
        minRating: args.minRating,
        listingType: args.listingType,
        nearest: !!args.nearest,
        sort: args.sort === "rating" ? "rating" : "name",
        limit: 6,
      },
      ctx,
    ),
  ]);
  const related = relatedTerms(q);
  const matches = (name: unknown) => related.some((t) => normalize(name).includes(normalize(t)) || normalize(t).includes(normalize(name)));
  const categories = catalog.categories.filter((c) => matches(c.name)).slice(0, 8).map((c) => ({ id: c.id, name: c.name, sector_id: c.sector_id }));
  const sectors = catalog.sectors.filter((s) => matches(s.name)).slice(0, 5).map((s) => ({ id: s.id, name: s.name }));
  return { query: q, products: products.results, packages: packages.results, vendors: vendors.results, categories, sectors };
}

async function getProductByIdOrQuery(args: Args, ctx: LeviContext) {
  if (args.productId) {
    const res = await query(ctx, (r) => r.product(String(args.productId)));
    const catalog = await getCatalog(ctx);
    return { results: res.ok ? (res.data || []).map((p: Row) => publicProduct(p, catalog, ctx.lat, ctx.lng)) : [] };
  }
  return searchProducts({ query: args.query || "", limit: args.limit || 8, nearest: !!args.nearest, sort: args.sort || "relevance" }, ctx);
}

async function getVendorByIdOrQuery(args: Args, ctx: LeviContext): Promise<{ results: Row[] }> {
  if (args.vendorId) {
    const res = await query(ctx, (r) => r.vendor(String(args.vendorId)));
    const catalog = await getCatalog(ctx);
    return {
      results: res.ok
        ? (res.data || []).map((v: Row) => ({
            ...v,
            sector: catalog.sectors.find((s) => String(s.id) === String(v.sector_id))?.name || null,
            distance_km: ctx.lat != null && ctx.lng != null ? Number(haversineKm(ctx.lat, ctx.lng, Number(v.lat), Number(v.lng)).toFixed(2)) : null,
          }))
        : [],
    };
  }
  return searchVendors({ query: args.query || "", sector: args.sector || "", city: args.city || "", minRating: args.minRating, nearest: !!args.nearest, sort: args.sort || "rating", limit: args.limit || 8 }, ctx);
}

async function getLatestProducts(args: Args, ctx: LeviContext) {
  return searchProducts({ query: args.query || "", sector: args.sector || "", category: args.category || "", listingType: args.listingType, limit: args.limit || 10, sort: "newest", inStock: true }, ctx);
}

async function getPopularProducts(args: Args, ctx: LeviContext) {
  const products = await getProductSnapshot(ctx);
  const catalog = await getCatalog(ctx);
  const rows = products
    .map((p) => {
      const category = categoryOf(catalog, p);
      const sector = sectorOf(catalog, p, category);
      return { p, sector: sector?.name || null, category: category?.name || null };
    })
    .filter((x) => !args.sector || normalize(x.sector).includes(normalize(args.sector)));
  rows.sort((a, b) => Number(b.p.view_count || 0) - Number(a.p.view_count || 0));
  return { results: rows.slice(0, Math.min(15, Number(args.limit) || 10)).map((x) => publicProduct(x.p, catalog, ctx.lat, ctx.lng)) };
}

async function getMarketplaceTrends(ctx: LeviContext) {
  const products = await getProductSnapshot(ctx);
  const catalog = await getCatalog(ctx);
  const sectorMap = new Map(catalog.sectors.map((s) => [String(s.id), s.name]));
  const rows = products.map((p) => {
    const c = categoryOf(catalog, p);
    return {
      id: p.id,
      name: p.name,
      views: Number(p.view_count || 0),
      created_at: p.created_at,
      category: c?.name || null,
      sector: sectorMap.get(String(c?.sector_id || p.vendor?.sector_id)) || null,
      vendor: p.vendor?.business_name || null,
    };
  });
  const bySector: Record<string, number> = {};
  for (const r of rows) bySector[r.sector || "Other"] = (bySector[r.sector || "Other"] || 0) + 1;
  const popular = rows.slice().sort((a, b) => b.views - a.views).slice(0, 10);
  const newest = rows.slice().sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()).slice(0, 10);
  return { active_products: rows.length, verified_vendors: catalog.vendors.length, products_by_sector: bySector, popular, newest };
}

/* --------------------------------------------------- the signed-in user's own */

export async function getMyVendor(ctx: LeviContext): Promise<Row | null> {
  const res = await query(ctx, (r) => r.myVendor(ctx.userId));
  return res.ok ? res.data?.[0] || null : null;
}

async function getMyProfile(ctx: LeviContext) {
  const res = await query(ctx, (r) => r.myProfile(ctx.userId));
  return { profile: res.ok ? res.data?.[0] || null : null };
}

async function getMyWishlist(ctx: LeviContext) {
  const res = await query(ctx, (r) => r.myWishlist(ctx.userId));
  return { items: res.ok ? res.data || [] : [] };
}

async function getMyVendorProducts(ctx: LeviContext) {
  const vendor = await getMyVendor(ctx);
  if (!vendor) return { is_vendor: false, products: [] };
  const res = await query(ctx, (r) => r.vendorProducts(String(vendor.id)));
  return { is_vendor: true, vendor: { id: vendor.id, business_name: vendor.business_name }, products: res.ok ? res.data || [] : [] };
}

async function getMyVendorOrders(ctx: LeviContext) {
  const vendor = await getMyVendor(ctx);
  if (!vendor) return { is_vendor: false, orders: [] };
  const res = await query(ctx, (r) => r.vendorOrders(String(vendor.id)));
  return { is_vendor: true, vendor: { id: vendor.id, business_name: vendor.business_name }, orders: res.ok ? res.data || [] : [] };
}

async function getMyCart(ctx: LeviContext) {
  const res = await query(ctx, (r) => r.myCart(ctx.userId));
  return { items: res.ok ? res.data || [] : [] };
}

async function getMyOrders(args: Args, ctx: LeviContext) {
  const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));
  const res = await query(ctx, (r) => r.myOrders(ctx.userId, args.status ? String(args.status) : null, limit));
  const orders: Row[] = res.ok ? res.data || [] : [];
  const ordinal = Number(args.ordinal);
  if (Number.isInteger(ordinal) && ordinal > 0) {
    const order = orders[ordinal - 1] || null;
    return { orders: order ? [order] : [], ordinal, found: !!order, total_returned: orders.length };
  }
  return { orders };
}

async function getMyMessages(args: Args, ctx: LeviContext) {
  const vendor = await getMyVendor(ctx);
  const convRes = await query(ctx, (r) => r.conversations(vendor ? { vendorId: String(vendor.id) } : { buyerId: ctx.userId }));
  if (!convRes.ok) return { conversations: [] };
  const convs: Row[] = convRes.data || [];
  const ids = convs.map((c) => c.id).filter(Boolean);
  if (!ids.length) return { conversations: [] };
  const messagesRes = await query(ctx, (r) => r.messagesIn(ids.map(String)));
  const messages: Row[] = messagesRes.ok ? messagesRes.data || [] : [];
  return {
    conversations: convs
      .map((c) => {
        const rows = messages.filter((m) => String(m.conversation_id) === String(c.id));
        const last = rows[0];
        return {
          conversation_id: c.id,
          vendor: c.vendor || null,
          buyer: vendor ? c.buyer || null : null,
          unread: rows.filter((m) => String(m.sender_id) !== String(ctx.userId) && !m.read_at).length,
          last_message: last ? { body: cleanText(last.body, 220), created_at: last.created_at } : null,
        };
      })
      .slice(0, Number(args.limit) || 20),
  };
}

async function getVendorAnalytics(ctx: LeviContext) {
  const vendor = await getMyVendor(ctx);
  if (!vendor) return { is_vendor: false };
  const [ordersRes, productsRes, orderItemsRes] = await Promise.all([
    query(ctx, (r) => r.vendorOrderSummaries(String(vendor.id))),
    query(ctx, (r) => r.vendorProductStats(String(vendor.id))),
    query(ctx, (r) => r.vendorOrderItems(String(vendor.id))),
  ]);
  const orders: Row[] = ordersRes.ok ? ordersRes.data || [] : [];
  const products: Row[] = productsRes.ok ? productsRes.data || [] : [];
  const productIds = products.map((p) => p.id).filter(Boolean).slice(0, 500);
  const favRes = productIds.length ? await query(ctx, (r) => r.favoritesOf(productIds.map(String))) : { ok: true, data: [] };
  const favorites: Row[] = favRes.ok ? favRes.data || [] : [];
  const orderItems: Row[] = orderItemsRes.ok ? orderItemsRes.data || [] : [];
  const completed = orders.filter((o) => o.status === "completed");
  const revenue = completed.reduce((sum, o) => sum + Number(o.total_amount || 0), 0);
  const soldByProduct: Record<string, number> = {};
  for (const row of orderItems) if (row.order?.status === "completed") soldByProduct[row.product_id] = (soldByProduct[row.product_id] || 0) + Number(row.quantity || 0);
  const favoriteByProduct: Record<string, number> = {};
  for (const row of favorites) favoriteByProduct[row.product_id] = (favoriteByProduct[row.product_id] || 0) + 1;
  const withStats = (p: Row) => ({ ...p, units_sold: soldByProduct[p.id] || 0, wishlist_saves: favoriteByProduct[p.id] || 0 });
  return {
    is_vendor: true,
    vendor: { id: vendor.id, business_name: vendor.business_name, rating: vendor.avg_rating, reviews: vendor.review_count, active: vendor.is_active, verification: vendor.verification_status },
    orders: { total: orders.length, completed: completed.length, pending: orders.filter((o) => ["pending", "confirmed"].includes(o.status)).length, revenue },
    products: products.map(withStats).slice(0, 100),
    low_view_products: products.slice().sort((a, b) => Number(a.view_count || 0) - Number(b.view_count || 0)).slice(0, 10).map(withStats),
    top_products_by_sales: products.slice().sort((a, b) => (soldByProduct[b.id] || 0) - (soldByProduct[a.id] || 0)).slice(0, 10).map(withStats),
  };
}

/* ------------------------------------------------------------------ actions */

async function addToCart(args: Args, ctx: LeviContext) {
  const productId = cleanText(args.productId, 100);
  const quantity = Math.max(1, Math.min(20, Number(args.quantity) || 1));
  if (!productId) return { ok: false, message: "No product id supplied." };
  const pRes = await query(ctx, (r) => r.purchasableProduct(productId));
  const p: Row | null = pRes.ok ? pRes.data?.[0] : null;
  if (!p) return { ok: false, message: "That listing is no longer available." };
  if (p.is_service || !["sale", "both"].includes(String(p.listing_type))) return { ok: false, message: "That listing needs to be opened rather than added directly to the cart." };
  if (Number(p.quantity_available || 0) < 1) return { ok: false, message: `${p.name} is out of stock.` };
  // The cart write itself runs with the user's own token, so the database applies its own rules.
  try {
    await ctx.data.onBehalfOf(ctx.identity, (tx) => new CartRepository(tx).add(ctx.identity.userId, productId, quantity));
  } catch {
    return { ok: false, message: "I couldn't add that item to the cart." };
  }
  return { ok: true, product: { id: p.id, name: p.name, vendor: p.vendor?.business_name }, quantity, clientDirective: `[[CARTSYNC]]` };
}

async function clearCart(ctx: LeviContext) {
  const existing = await query(ctx, (r) => r.cartIds(ctx.userId));
  if (!existing.ok) return { ok: false, message: "I couldn't read your cart right now." };
  const count = (existing.data || []).length;
  if (!count) return { ok: true, alreadyEmpty: true, count: 0, message: "Your cart is already empty." };
  // Confirmation-gated: the browser asks the user before deleting anything.
  return { ok: true, requiresConfirmation: true, count, clientDirective: "[[CLEARCART_CONFIRM]]" };
}

async function removeFromCart(args: Args, ctx: LeviContext) {
  const productId = cleanText(args.productId, 100);
  const res = await query(ctx, (r) => r.cartLine(ctx.userId, productId));
  const row: Row | null = res.ok ? res.data?.[0] : null;
  if (!row) return { ok: false, message: "That item isn't in your cart." };
  const del = await query(ctx, async (r) => {
    await r.deleteCartLine(ctx.userId, String(row.id));
    return [];
  });
  if (!del.ok) return { ok: false, message: "I couldn't remove that item." };
  return { ok: true, product: { id: productId, name: row.product?.name || "item" }, clientDirective: `[[CARTSYNC]]` };
}

async function draftMessage(args: Args, ctx: LeviContext) {
  const vendorId = cleanText(args.vendorId, 100);
  const message = cleanText(args.message, 1000);
  if (!vendorId || !message) return { ok: false, message: "A real vendor and message are required." };
  const v = await getVendorByIdOrQuery({ vendorId }, ctx);
  const vendor = v.results?.[0];
  if (!vendor) return { ok: false, message: "That vendor could not be found." };
  return { ok: true, vendor: { id: vendor.id, business_name: vendor.business_name }, clientDirective: `[[DRAFTMSG vendorId=${vendor.id}]]${message}[[/DRAFTMSG]]` };
}

async function requestItem(args: Args) {
  const text = cleanText(args.query, 160);
  if (!text) return { ok: false, message: "Tell me what item you want requested." };
  return { ok: true, clientDirective: `[[NAV:requestEquipment|prefill=${enc(text)}]]` };
}

/* ----------------------------------------------------------------- dispatch */

const TOOLS: Record<string, (args: Args, ctx: LeviContext) => Promise<unknown>> = {
  search_products: searchProducts,
  search_vendors: searchVendors,
  get_catalog_overview: (_a, ctx) => getCatalogOverview(ctx),
  get_product: getProductByIdOrQuery,
  get_vendor: getVendorByIdOrQuery,
  get_latest_products: getLatestProducts,
  get_popular_products: getPopularProducts,
  get_my_cart: (_a, ctx) => getMyCart(ctx),
  get_my_orders: getMyOrders,
  get_my_messages: getMyMessages,
  get_my_vendor_analytics: (_a, ctx) => getVendorAnalytics(ctx),
  add_to_cart: addToCart,
  remove_from_cart: removeFromCart,
  clear_cart: (_a, ctx) => clearCart(ctx),
  search_everything: searchEverything,
  search_packages: searchPackages,
  get_my_profile: (_a, ctx) => getMyProfile(ctx),
  get_my_wishlist: (_a, ctx) => getMyWishlist(ctx),
  get_my_vendor_products: (_a, ctx) => getMyVendorProducts(ctx),
  get_my_vendor_orders: (_a, ctx) => getMyVendorOrders(ctx),
  get_marketplace_trends: (_a, ctx) => getMarketplaceTrends(ctx),
  draft_message: draftMessage,
  request_item: (args) => requestItem(args),
};

export function executeTool(name: string, args: Args | undefined, ctx: LeviContext): Promise<unknown> {
  const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;
  if (!tool) return Promise.resolve({ ok: false, message: `Unknown Levi tool: ${name}` });
  return tool(args || {}, ctx);
}
