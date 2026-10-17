import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DataContext } from "../../src/database/context.js";
import { CartService } from "../../src/modules/cart/cart.service.js";
import { FavoritesService } from "../../src/modules/favorites/favorites.service.js";
import { FollowsService } from "../../src/modules/follows/follows.service.js";
import { identityOf, seedPackage, seedProduct, seedUser, seedVendor } from "../support/fixtures.js";
import { comparable, runIsolated, runTableQuery, type CompareOptions, type RunOutcome } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/**
 * The app's direct table queries on cart_items (Levi's voice commands), favorites, package_favorites and
 * vendor_follows (the wishlist and "Following" pages), against the endpoints that replace them.
 */
describe("parity: table queries - cart, wishlist and followed shops", () => {
  let db: TestDatabase;
  let buyer: string;
  let other: string;
  let shop: string;
  let hiddenShop: string;
  let phone: string;
  let kettle: string;
  let pkg: string;
  let hiddenPkg: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    buyer = (await seedUser(db)).id;
    other = (await seedUser(db)).id;
    const owner = (await seedUser(db, { role: "vendor" })).id;
    const hiddenOwner = (await seedUser(db, { role: "vendor" })).id;
    shop = (await seedVendor(db, owner, { name: "Dayo Gadgets" })).id;
    hiddenShop = (await seedVendor(db, hiddenOwner, { name: "Pending Place", verified: false })).id;
    phone = await seedProduct(db, shop, { name: "Phone" });
    kettle = await seedProduct(db, shop, { name: "Kettle" });
    const hiddenProduct = await seedProduct(db, hiddenShop, { name: "Hidden" });
    pkg = await seedPackage(db, shop, { name: "Starter pack" });
    hiddenPkg = await seedPackage(db, hiddenShop, { name: "Hidden pack" });
    await db.query(`insert into public.package_items (package_id, product_id, quantity) values ($1, $2, 2), ($1, $3, 1)`, [pkg, phone, kettle]);
    await db.query(`insert into public.cart_items (buyer_id, product_id, quantity) values ($1, $2, 3), ($1, $3, 1), ($4, $2, 1)`, [buyer, phone, kettle, other]);
    await db.query(`insert into public.favorites (buyer_id, product_id, created_at) values ($1, $2, now() - interval '2 hours'), ($1, $3, now() - interval '1 hour'), ($1, $4, now())`, [buyer, phone, kettle, hiddenProduct]);
    await db.query(`insert into public.package_favorites (buyer_id, package_id, created_at) values ($1, $2, now() - interval '1 hour'), ($1, $3, now())`, [buyer, pkg, hiddenPkg]);
    await db.query(`insert into public.vendor_follows (vendor_id, follower_id, created_at) values ($1, $3, now() - interval '1 day'), ($2, $3, now())`, [shop, hiddenShop, buyer]);
  }, 60_000);
  afterAll(() => db.close());

  const me = (id: string) => identityOf(id);
  async function same(original: Promise<RunOutcome>, port: Promise<RunOutcome>, options?: CompareOptions) {
    const [o, p] = [await original, await port];
    const { original: a, port: b } = comparable(o, p, options);
    expect(b).toEqual(a);
    return o;
  }
  const cart = (ctx: DataContext) => new CartService(() => ctx);

  describe("cart_items (Levi)", () => {
    it("remove a product from the cart", async () => {
      for (const product of [phone, kettle]) {
        await same(
          runTableQuery(db, me(buyer), sql`delete from public.cart_items where buyer_id = ${buyer} and product_id = ${product}`, false),
          runIsolated(db, (ctx) => cart(ctx).removeProduct(me(buyer), product).then(() => null)),
        );
      }
    });
    it("how many lines are in the cart", async () => {
      const o = await runTableQuery(db, me(buyer), sql`select id from public.cart_items where buyer_id = ${buyer}`);
      const p = await runIsolated(db, (ctx) => cart(ctx).count(me(buyer)));
      expect(p.result).toEqual({ count: (o.result as unknown[]).length });
    });
    it("the cart with each product's type, prices, stock and shop name", async () => {
      const o = await runTableQuery(
        db,
        me(buyer),
        sql`select ci.id, ci.product_id,
                   (select json_build_object('id', p.id, 'name', p.name, 'listing_type', p.listing_type, 'sale_price', p.sale_price, 'rental_rate', p.rental_rate,
                                             'quantity_available', p.quantity_available, 'status', p.status, 'is_service', p.is_service,
                                             'vendor', (select json_build_object('business_name', v.business_name) from public.vendors v where v.id = p.vendor_id))
                    from public.products p where p.id = ci.product_id) as product
            from public.cart_items ci where ci.buyer_id = ${buyer}`,
      );
      const p = await runIsolated(db, (ctx) => cart(ctx).list(me(buyer)));
      const pick = (x: Record<string, unknown> & { product: Record<string, unknown> & { vendor: { business_name: string } } }) => ({
        id: x.id,
        product: {
          id: x.product.id,
          name: x.product.name,
          listing_type: x.product.listing_type,
          sale_price: x.product.sale_price,
          rental_rate: x.product.rental_rate,
          quantity_available: x.product.quantity_available,
          status: x.product.status,
          is_service: x.product.is_service,
          vendor: { business_name: x.product.vendor.business_name },
        },
      });
      const items = p.result as unknown as Parameters<typeof pick>[0][];
      const byId = (rows: { id: unknown }[]) => [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
      expect(byId(items.map(pick))).toEqual(byId((o.result as Record<string, unknown>[]).map(({ product_id: _drop, ...rest }) => rest) as { id: unknown }[]));
    });
  });

  describe("favorites and package_favorites (wishlist)", () => {
    const fav = (ctx: DataContext) => new FavoritesService(() => ctx);
    it("saved products, newest first (a product the buyer can no longer see is null)", async () => {
      for (const who of [buyer, other]) {
        await same(
          runTableQuery(
            db,
            me(who),
            sql`select (select json_build_object('id', p.id, 'name', p.name, 'listing_type', p.listing_type, 'sale_price', p.sale_price, 'rental_rate', p.rental_rate,
                                                 'rental_rate_unit', p.rental_rate_unit, 'photos', p.photos, 'quantity_available', p.quantity_available,
                                                 'condition', p.condition, 'is_service', p.is_service, 'service_price_unit', p.service_price_unit, 'status', p.status,
                                                 'vendor', (select json_build_object('id', v.id, 'business_name', v.business_name, 'verification_status', v.verification_status,
                                                                                     'is_active', v.is_active, 'logo_url', v.logo_url) from public.vendors v where v.id = p.vendor_id))
                        from public.products p where p.id = f.product_id) as product
                from public.favorites f where f.buyer_id = ${who} order by f.created_at desc`,
          ),
          runIsolated(db, (ctx) => fav(ctx).savedProducts(me(who))),
        );
      }
    });
    it("saved packages with shop and items (a package whose shop is hidden is null)", async () => {
      const o = await same(
        runTableQuery(
          db,
          me(buyer),
          sql`select (select json_build_object('id', vp.id, 'vendor_id', vp.vendor_id, 'name', vp.name, 'description', vp.description, 'price', vp.price,
                                               'photos', vp.photos, 'created_at', vp.created_at, 'status', vp.status,
                                               'vendor', json_build_object('id', v.id, 'business_name', v.business_name, 'logo_url', v.logo_url,
                                                                           'delivery_fee', v.delivery_fee, 'verification_status', v.verification_status, 'is_active', v.is_active),
                                               'items', coalesce((select json_agg(json_build_object('quantity', pi.quantity,
                                                     'product', (select json_build_object('id', pr.id, 'name', pr.name, 'photos', pr.photos) from public.products pr where pr.id = pi.product_id)))
                                                   from public.package_items pi where pi.package_id = vp.id), '[]'::json))
                      from public.vendor_packages vp join public.vendors v on v.id = vp.vendor_id where vp.id = pf.package_id) as package
              from public.package_favorites pf where pf.buyer_id = ${buyer} order by pf.created_at desc`,
        ),
        runIsolated(db, (ctx) => fav(ctx).savedPackages(me(buyer))),
      );
      const rows = o.result as { package: { items: unknown[] } | null }[];
      expect(rows.map((r) => r.package?.items.length ?? null).sort()).toEqual([2, null]);
    });
  });

  describe("vendor_follows (Following page)", () => {
    it("followed shops the follower can see, newest first", async () => {
      const o = await same(
        runTableQuery(
          db,
          me(buyer),
          sql`select json_build_object('id', v.id, 'business_name', v.business_name, 'logo_url', v.logo_url, 'cover_image_url', v.cover_image_url,
                                       'bio', v.bio, 'city', v.city, 'avg_rating', v.avg_rating, 'review_count', v.review_count,
                                       'verification_status', v.verification_status, 'is_active', v.is_active, 'sector_id', v.sector_id) as vendor
              from public.vendor_follows f join public.vendors v on v.id = f.vendor_id where f.follower_id = ${buyer} order by f.created_at desc`,
        ),
        runIsolated(db, (ctx) => new FollowsService(() => ctx).followedShops(me(buyer))),
      );
      expect((o.result as { vendor: { id: string } }[]).map((r) => r.vendor.id)).toContain(shop);
    });
  });
});
