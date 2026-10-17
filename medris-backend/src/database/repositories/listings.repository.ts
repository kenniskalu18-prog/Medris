import { sql, type SQL } from "drizzle-orm";
import type { Executor } from "../client.js";
import { textArray, uuidArray } from "../arrays.js";
import { jsonReturning, jsonRow, jsonRows } from "../json.js";

/** The shop embedded in a public product row (what the product cards and pages show). */
const SHOP = sql`(select json_build_object('id', v.id, 'business_name', v.business_name, 'previous_business_name', v.previous_business_name,
    'name_changed_at', v.name_changed_at, 'city', v.city, 'address', v.address, 'phone', v.phone,
    'whatsapp_number', case when v.whatsapp_visible then v.whatsapp_number end, 'whatsapp_visible', v.whatsapp_visible,
    'avg_rating', v.avg_rating, 'review_count', v.review_count, 'verification_status', v.verification_status, 'cac_number', v.cac_number,
    'created_at', v.created_at, 'is_active', v.is_active, 'logo_url', v.logo_url, 'delivery_fee', v.delivery_fee,
    'delivery_fee_mode', v.delivery_fee_mode, 'delivery_fee_per_km', v.delivery_fee_per_km, 'lat', v.lat, 'lng', v.lng,
    'business_hours', v.business_hours, 'allow_after_hours_messages', v.allow_after_hours_messages, 'sector_id', v.sector_id,
    'campus_id', v.campus_id, 'operating_scope', v.operating_scope, 'operating_campuses', v.operating_campuses, 'student_verified', v.student_verified)
  from public.vendors v where v.id = p.vendor_id)`;
const CATEGORY = sql`(select json_build_object('id', c.id, 'name', c.name, 'sector_id', c.sector_id) from public.categories c where c.id = p.category_id)`;
/** Product columns only the shop's owner and admins need. */
const PUBLIC_PRODUCT = sql`to_jsonb(p) - 'billing_reference' - 'admin_deleted_by'`;
const LIVE_SHOP = sql`exists (select 1 from public.vendors v where v.id = p.vendor_id and v.verification_status = 'verified' and v.is_active = true and v.deleted_at is null)`;

export interface ListingFilter {
  ids: string[] | null;
  vendorId: string | null;
  categoryIds: string[] | null;
  sectorId: string | null;
  isService: boolean | null;
  /** Listing types to include (rent → rent and both, sale → sale and both, as the app asked). */
  listingTypes: string[] | null;
  /** Name contains. */
  q: string | null;
  /** Name or description contains. */
  qAny: string | null;
  inStock: boolean;
  orderBy: "views" | "newest" | "id" | "name" | "none";
  /** card: every public column with shop and category; index: the light rows the browse and search indexes keep. */
  view: "card" | "index";
  withVariants: boolean;
  limit: number;
  offset: number;
}

/** The fields of a listing its shop edits. */
export interface ListingFields {
  name?: string;
  description?: string | null;
  category_id?: string | null;
  condition?: string;
  listing_type?: string;
  is_service?: boolean;
  service_price_unit?: string | null;
  sale_price?: number | null;
  discount_price?: number | null;
  delivery_fee_mode?: string;
  delivery_fee?: number;
  delivery_fee_per_km?: number;
  payment_timing?: string;
  payment_deposit_percent?: number;
  rental_rate?: number | null;
  rental_rate_unit?: string | null;
  deposit_amount?: number | null;
  quantity_total?: number;
  quantity_available?: number;
  track_quantity?: boolean;
  photos?: string[];
}

const like = (s: string) => `%${s.replace(/[%_\\]/g, "")}%`;

/**
 * Products (listings) as the app's table queries read and changed them. Run as the user: row-level
 * security (active listings of live shops for everyone; one's own; admins) and the triggers (default
 * category, follower news, points, low stock, monthly submissions) still decide.
 */
export class ListingsRepository {
  constructor(private readonly db: Executor) {}

  /** The marketplace lists (home, browse, search, Levi, similar items): active listings of verified, active shops. */
  feed(f: ListingFilter): Promise<Record<string, unknown>[]> {
    const where: SQL[] = [sql`p.status = 'active'`, LIVE_SHOP];
    if (f.ids) where.push(sql`p.id = any(${uuidArray(f.ids)})`);
    if (f.vendorId) where.push(sql`p.vendor_id = ${f.vendorId}`);
    if (f.categoryIds) where.push(sql`p.category_id = any(${uuidArray(f.categoryIds)})`);
    if (f.sectorId) where.push(sql`exists (select 1 from public.categories c where c.id = p.category_id and c.sector_id = ${f.sectorId})`);
    if (f.isService != null) where.push(sql`p.is_service = ${f.isService}`);
    if (f.listingTypes) where.push(sql`p.listing_type::text = any(${textArray(f.listingTypes)})`);
    if (f.q) where.push(sql`p.name ilike ${like(f.q)}`);
    if (f.qAny) where.push(sql`(p.name ilike ${like(f.qAny)} or p.description ilike ${like(f.qAny)})`);
    if (f.inStock) where.push(sql`coalesce(p.quantity_available, 0) > 0`);
    const order =
      f.orderBy === "views"
        ? sql`order by p.view_count desc, p.id`
        : f.orderBy === "newest"
          ? sql`order by p.created_at desc`
          : f.orderBy === "id"
            ? sql`order by p.id`
            : f.orderBy === "name"
              ? sql`order by p.name`
              : sql``;
    const row =
      f.view === "index"
        ? sql`json_build_object('id', p.id, 'vendor_id', p.vendor_id, 'category_id', p.category_id, 'name', p.name, 'description', p.description,
                                'listing_type', p.listing_type, 'is_service', p.is_service, 'photos', p.photos, 'created_at', p.created_at, 'view_count', p.view_count,
                                'category', (select json_build_object('name', c.name, 'sector_id', c.sector_id) from public.categories c where c.id = p.category_id),
                                'vendor', (select json_build_object('id', v.id, 'business_name', v.business_name, 'campus_id', v.campus_id, 'operating_scope', v.operating_scope,
                                                                    'operating_campuses', v.operating_campuses) from public.vendors v where v.id = p.vendor_id))`
        : sql`${PUBLIC_PRODUCT} || jsonb_build_object('vendor', ${SHOP}, 'category', ${CATEGORY}
                ${f.withVariants ? sql`, 'variants', coalesce((select json_agg(to_json(pv) order by pv.sort_order, pv.created_at) from public.product_variants pv where pv.product_id = p.id), '[]'::json)` : sql``})`;
    return jsonRows<{ r: Record<string, unknown> }>(
      this.db,
      sql`select ${row} as r from public.products p where ${sql.join(where, sql` and `)} ${order} limit ${f.limit} offset ${f.offset}`,
    ).then((rows) => rows.map((x) => x.r));
  }

  /** One listing as the product page reads it (`select("*, vendor:vendors(...), category:categories(...)")`), if the caller may see it. */
  async detail(me: string | null, productId: string): Promise<Record<string, unknown> | null> {
    const row = await jsonRow<{ r: Record<string, unknown> }>(
      this.db,
      sql`select case when exists (select 1 from public.vendors v where v.id = p.vendor_id and v.user_id = ${me}::uuid) then to_jsonb(p) else ${PUBLIC_PRODUCT} end
                 || jsonb_build_object('vendor', ${SHOP}, 'category', ${CATEGORY}) as r
          from public.products p where p.id = ${productId}`,
    );
    return row?.r ?? null;
  }

  /** The caller's own live shop id. */
  async ownShop(me: string): Promise<string | null> {
    return (await jsonRow<{ id: string }>(this.db, sql`select id from public.vendors where user_id = ${me} and deleted_at is null limit 1`))?.id ?? null;
  }

  /** The shop's own listings, newest first (`select("*, category:categories(name)").eq("vendor_id", id)`), optionally without removed ones or by name. */
  mine(shopId: string, o: { includeRemoved: boolean; q: string | null; activeOnly: boolean }): Promise<Record<string, unknown>[]> {
    return jsonRows<{ r: Record<string, unknown> }>(
      this.db,
      sql`select to_jsonb(p) || jsonb_build_object('category', (select json_build_object('name', c.name) from public.categories c where c.id = p.category_id)) as r
          from public.products p where p.vendor_id = ${shopId}
          ${o.includeRemoved ? sql`` : sql`and p.status <> 'removed'`} ${o.activeOnly ? sql`and p.status = 'active'` : sql``}
          ${o.q ? sql`and p.name ilike ${like(o.q)}` : sql``}
          order by p.created_at desc`,
    ).then((rows) => rows.map((x) => x.r));
  }

  /** One of the shop's own listings (`select("*").eq("id", id).eq("vendor_id", shop)`). */
  mineOne(shopId: string, productId: string): Promise<Record<string, unknown> | null> {
    return jsonRow(this.db, sql`select p.* from public.products p where p.id = ${productId} and p.vendor_id = ${shopId}`);
  }

  /** `select("id").eq("vendor_id", shop).eq("billing_reference", ref)` - the listing a paid draft already created. */
  async byReference(shopId: string, reference: string): Promise<string | null> {
    return (await jsonRow<{ id: string }>(this.db, sql`select id from public.products where vendor_id = ${shopId} and billing_reference = ${reference}`))?.id ?? null;
  }

  /** The given fields as [column, value] pairs (typed casts), in a fixed order. */
  private static columns(f: ListingFields): [string, SQL][] {
    const out: [string, SQL][] = [];
    const add = (k: keyof ListingFields, v: SQL) => {
      if (f[k] !== undefined) out.push([k, v]);
    };
    add("name", sql`${f.name ?? null}`);
    add("description", sql`${f.description ?? null}`);
    add("category_id", sql`${f.category_id ?? null}::uuid`);
    add("condition", sql`${f.condition ?? null}::public.product_condition`);
    add("listing_type", sql`${f.listing_type ?? null}::public.listing_type`);
    add("is_service", sql`${f.is_service ?? null}::boolean`);
    add("service_price_unit", sql`${f.service_price_unit ?? null}`);
    add("sale_price", sql`${f.sale_price ?? null}::numeric`);
    add("discount_price", sql`${f.discount_price ?? null}::numeric`);
    add("delivery_fee_mode", sql`${f.delivery_fee_mode ?? null}`);
    add("delivery_fee", sql`${f.delivery_fee ?? null}::numeric`);
    add("delivery_fee_per_km", sql`${f.delivery_fee_per_km ?? null}::numeric`);
    add("payment_timing", sql`${f.payment_timing ?? null}`);
    add("payment_deposit_percent", sql`${f.payment_deposit_percent ?? null}::numeric`);
    add("rental_rate", sql`${f.rental_rate ?? null}::numeric`);
    add("rental_rate_unit", sql`${f.rental_rate_unit ?? null}`);
    add("deposit_amount", sql`${f.deposit_amount ?? null}::numeric`);
    add("quantity_total", sql`${f.quantity_total ?? null}::int`);
    add("quantity_available", sql`${f.quantity_available ?? null}::int`);
    add("track_quantity", sql`${f.track_quantity ?? null}::boolean`);
    add("photos", sql`${textArray(f.photos ?? [])}`);
    return out;
  }

  private static assignments(f: ListingFields): SQL[] {
    return ListingsRepository.columns(f).map(([c, v]) => sql`${sql.raw(c)} = ${v}`);
  }

  /**
   * A new listing of the shop. FIX S13: the billing is set here - a monthly listing starts paused until its fee
   * is paid (the app set status and billing itself, so a listing could go live without paying); a commission
   * listing is active.
   */
  async create(shopId: string, f: ListingFields, billingModel: "commission" | "monthly", reference: string | null): Promise<Record<string, unknown>> {
    const monthly = billingModel === "monthly";
    // Only the fields given (the table's defaults for the rest); a new listing's stock is its total.
    const given = { ...f, quantity_available: f.quantity_total ?? f.quantity_available };
    const assigned = ListingsRepository.columns(given);
    const [row] = await jsonReturning<Record<string, unknown>>(
      this.db,
      sql`insert into public.products (vendor_id, ${sql.join(assigned.map(([c]) => sql.raw(c)), sql`, `)}${assigned.length ? sql`, ` : sql``}
                                       billing_model, billing_status, billing_paid_until, billing_reference, status)
          values (${shopId}, ${sql.join(assigned.map(([, v]) => v), sql`, `)}${assigned.length ? sql`, ` : sql``}
                  ${billingModel}, ${monthly ? "pending_payment" : "active"}, null, ${reference},
                  ${monthly ? sql`'paused'::public.product_status` : sql`'active'::public.product_status`})
          returning *`,
    );
    return row!;
  }

  /** `update({ ...fields }).eq("id", id).eq("vendor_id", shop).select("*").single()` - the editor's fields only. */
  async update(shopId: string, productId: string, f: ListingFields): Promise<Record<string, unknown> | null> {
    const sets = ListingsRepository.assignments(f);
    if (sets.length === 0) return this.mineOne(shopId, productId);
    const [row] = await jsonReturning<Record<string, unknown>>(
      this.db,
      sql`update public.products set ${sql.join(sets, sql`, `)} where id = ${productId} and vendor_id = ${shopId} returning *`,
    );
    return row ?? null;
  }

  /**
   * Pause, discard or reactivate one of the shop's listings. FIX S13: a monthly listing goes live again only
   * while its paid period runs (the app checked that in the browser); discarding can also stop its billing.
   */
  async setStatus(shopId: string, productId: string, status: "active" | "paused" | "removed", cancelBilling: boolean): Promise<{ updated: number; needsPayment: boolean }> {
    const p = await jsonRow<{ billing_model: string; billing_status: string; paid: boolean }>(
      this.db,
      sql`select billing_model, billing_status, coalesce(billing_paid_until > now(), false) as paid from public.products where id = ${productId} and vendor_id = ${shopId}`,
    );
    if (!p) return { updated: 0, needsPayment: false };
    if (status === "active" && p.billing_model === "monthly" && !p.paid) return { updated: 0, needsPayment: true };
    const billing = status === "active" && p.billing_model === "monthly" ? sql`, billing_status = 'active'` : cancelBilling ? sql`, billing_status = 'cancelled'` : sql``;
    const rows = await jsonReturning(
      this.db,
      sql`update public.products set status = ${status}::public.product_status ${billing} where id = ${productId} and vendor_id = ${shopId} returning id`,
    );
    return { updated: rows.length, needsPayment: false };
  }

  /** `update({ billing_reference: null })` once the paid draft's payment was consumed. */
  async clearReference(shopId: string, productId: string): Promise<number> {
    return (await jsonReturning(this.db, sql`update public.products set billing_reference = null where id = ${productId} and vendor_id = ${shopId} returning id`)).length;
  }

  /** `delete().eq("id", id).eq("vendor_id", shop)` - refused (foreign key) once the listing has orders, as before. */
  async remove(shopId: string, productId: string): Promise<number> {
    return (await jsonReturning(this.db, sql`delete from public.products where id = ${productId} and vendor_id = ${shopId} returning id`)).length;
  }
}
