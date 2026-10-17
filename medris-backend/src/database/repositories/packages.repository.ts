import { sql, type SQL } from "drizzle-orm";
import type { Executor } from "../client.js";
import { uuidArray } from "../arrays.js";
import { jsonReturning, jsonRow, jsonRows } from "../json.js";

const SHOP = sql`(select json_build_object('id', v.id, 'business_name', v.business_name, 'previous_business_name', v.previous_business_name,
    'name_changed_at', v.name_changed_at, 'city', v.city, 'address', v.address, 'phone', v.phone,
    'whatsapp_number', case when v.whatsapp_visible then v.whatsapp_number end, 'whatsapp_visible', v.whatsapp_visible,
    'avg_rating', v.avg_rating, 'review_count', v.review_count, 'verification_status', v.verification_status, 'is_active', v.is_active,
    'logo_url', v.logo_url, 'delivery_fee', v.delivery_fee, 'delivery_fee_mode', v.delivery_fee_mode, 'delivery_fee_per_km', v.delivery_fee_per_km,
    'lat', v.lat, 'lng', v.lng) from public.vendors v where v.id = vp.vendor_id)`;
const ITEMS = sql`coalesce((select json_agg(json_build_object('product_id', pi.product_id, 'quantity', pi.quantity,
    'product', (select json_build_object('id', p.id, 'name', p.name, 'sale_price', p.sale_price, 'rental_rate', p.rental_rate, 'rental_rate_unit', p.rental_rate_unit,
                                         'photos', p.photos, 'quantity_available', p.quantity_available, 'condition', p.condition, 'listing_type', p.listing_type,
                                         'is_service', p.is_service, 'service_price_unit', p.service_price_unit, 'category_id', p.category_id,
                                         'category', (select json_build_object('name', c.name, 'sector_id', c.sector_id) from public.categories c where c.id = p.category_id))
                from public.products p where p.id = pi.product_id)))
  from public.package_items pi where pi.package_id = vp.id), '[]'::json)`;
const LIVE = sql`vp.status = 'active' and exists (select 1 from public.vendors v where v.id = vp.vendor_id and v.verification_status = 'verified' and v.is_active = true and v.deleted_at is null)`;
const like = (s: string) => `%${s.replace(/[%_\\]/g, "")}%`;

export interface PackageFilter {
  ids: string[] | null;
  vendorId: string | null;
  qAny: string | null;
  /** Packages with an item whose product name contains this. */
  qItems: string | null;
  orderBy: "newest" | "none";
  view: "card" | "index";
  limit: number;
}

export interface PackageFields {
  name?: string;
  description?: string | null;
  price?: number;
  photos?: unknown[];
}

/**
 * Packages (bundles) as the app's table queries read and changed them. Run as the user: row-level security
 * (active packages of live shops for everyone; one's own; admins) and the triggers (follower news, points,
 * monthly submissions) still decide.
 */
export class PackagesRepository {
  constructor(private readonly db: Executor) {}

  /** The marketplace lists: active packages of verified, active shops, with shop and items. */
  feed(f: PackageFilter): Promise<Record<string, unknown>[]> {
    const where: SQL[] = [LIVE];
    if (f.ids) where.push(sql`vp.id = any(${uuidArray(f.ids)})`);
    if (f.vendorId) where.push(sql`vp.vendor_id = ${f.vendorId}`);
    if (f.qAny) where.push(sql`(vp.name ilike ${like(f.qAny)} or vp.description ilike ${like(f.qAny)})`);
    if (f.qItems) where.push(sql`exists (select 1 from public.package_items pi join public.products p on p.id = pi.product_id where pi.package_id = vp.id and p.name ilike ${like(f.qItems)})`);
    const row =
      f.view === "index"
        ? sql`json_build_object('id', vp.id, 'vendor_id', vp.vendor_id, 'name', vp.name, 'description', vp.description, 'price', vp.price)`
        : sql`(to_jsonb(vp) - 'billing_reference') || jsonb_build_object('vendor', ${SHOP}, 'items', ${ITEMS})`;
    return jsonRows<{ r: Record<string, unknown> }>(
      this.db,
      sql`select ${row} as r from public.vendor_packages vp where ${sql.join(where, sql` and `)} ${f.orderBy === "newest" ? sql`order by vp.created_at desc` : sql``} limit ${f.limit}`,
    ).then((rows) => rows.map((x) => x.r));
  }

  /** One package with its shop and items, if the caller may see it. */
  async detail(me: string | null, packageId: string): Promise<Record<string, unknown> | null> {
    const row = await jsonRow<{ r: Record<string, unknown> }>(
      this.db,
      sql`select case when exists (select 1 from public.vendors v where v.id = vp.vendor_id and v.user_id = ${me}::uuid) then to_jsonb(vp) else to_jsonb(vp) - 'billing_reference' end
                 || jsonb_build_object('vendor', ${SHOP}, 'items', ${ITEMS}) as r
          from public.vendor_packages vp where vp.id = ${packageId}`,
    );
    return row?.r ?? null;
  }

  async ownShop(me: string): Promise<string | null> {
    return (await jsonRow<{ id: string }>(this.db, sql`select id from public.vendors where user_id = ${me} and deleted_at is null limit 1`))?.id ?? null;
  }

  /** `select("*, items:package_items(product_id, quantity, product:products(name))").eq("vendor_id", shop).order("created_at", desc)` */
  mine(shopId: string): Promise<Record<string, unknown>[]> {
    return jsonRows<{ r: Record<string, unknown> }>(
      this.db,
      sql`select to_jsonb(vp) || jsonb_build_object('items', coalesce((select json_agg(json_build_object('product_id', pi.product_id, 'quantity', pi.quantity,
                   'product', (select json_build_object('name', p.name) from public.products p where p.id = pi.product_id))) from public.package_items pi where pi.package_id = vp.id), '[]'::json)) as r
          from public.vendor_packages vp where vp.vendor_id = ${shopId} order by vp.created_at desc`,
    ).then((rows) => rows.map((x) => x.r));
  }

  /** Whether every product is one of the shop's own (a package may only bundle the shop's products). */
  async ownProducts(shopId: string, productIds: string[]): Promise<boolean> {
    if (productIds.length === 0) return true;
    const row = await jsonRow<{ n: number }>(this.db, sql`select count(distinct id)::int as n from public.products where vendor_id = ${shopId} and id = any(${uuidArray(productIds)})`);
    return row!.n === new Set(productIds).size;
  }

  /** A new package and its items, in one go. A monthly package starts paused until its fee is paid (FIX S13). */
  async create(shopId: string, f: PackageFields, items: { product_id: string; quantity: number }[], billingModel: "commission" | "monthly"): Promise<Record<string, unknown>> {
    const monthly = billingModel === "monthly";
    const [row] = await jsonReturning<Record<string, unknown> & { id: string }>(
      this.db,
      sql`insert into public.vendor_packages (vendor_id, name, description, price, photos, billing_model, billing_status, status)
          values (${shopId}, ${f.name ?? null}, ${f.description ?? null}, ${f.price ?? null}::numeric, coalesce(${f.photos ? JSON.stringify(f.photos) : null}::jsonb, '[]'::jsonb),
                  ${billingModel}, ${monthly ? "pending_payment" : "active"}, ${monthly ? sql`'paused'::public.product_status` : sql`'active'::public.product_status`})
          returning *`,
    );
    await this.replaceItems(row!.id, items);
    return row!;
  }

  /** Changes the package and replaces its items (`update(payload)`, then `package_items` delete and insert). */
  async update(shopId: string, packageId: string, f: PackageFields, items: { product_id: string; quantity: number }[] | null): Promise<Record<string, unknown> | null> {
    const sets: SQL[] = [];
    if (f.name !== undefined) sets.push(sql`name = ${f.name}`);
    if (f.description !== undefined) sets.push(sql`description = ${f.description}`);
    if (f.price !== undefined) sets.push(sql`price = ${f.price}::numeric`);
    if (f.photos !== undefined) sets.push(sql`photos = ${JSON.stringify(f.photos)}::jsonb`);
    const [row] = await jsonReturning<Record<string, unknown>>(
      this.db,
      sets.length
        ? sql`update public.vendor_packages set ${sql.join(sets, sql`, `)} where id = ${packageId} and vendor_id = ${shopId} returning *`
        : sql`update public.vendor_packages set name = name where id = ${packageId} and vendor_id = ${shopId} returning *`,
    );
    if (!row) return null;
    if (items) await this.replaceItems(packageId, items);
    return row;
  }

  private async replaceItems(packageId: string, items: { product_id: string; quantity: number }[]): Promise<void> {
    await this.db.execute(sql`delete from public.package_items where package_id = ${packageId}`);
    for (const it of items) {
      await this.db.execute(sql`insert into public.package_items (package_id, product_id, quantity) values (${packageId}, ${it.product_id}, ${it.quantity})`);
    }
  }

  /** Pause, discard or reactivate; a monthly package goes live again only while its paid period runs (FIX S13). */
  async setStatus(shopId: string, packageId: string, status: "active" | "paused" | "removed"): Promise<{ updated: number; needsPayment: boolean }> {
    const p = await jsonRow<{ billing_model: string; paid: boolean }>(
      this.db,
      sql`select billing_model, coalesce(billing_paid_until > now(), false) as paid from public.vendor_packages where id = ${packageId} and vendor_id = ${shopId}`,
    );
    if (!p) return { updated: 0, needsPayment: false };
    if (status === "active" && p.billing_model === "monthly" && !p.paid) return { updated: 0, needsPayment: true };
    const rows = await jsonReturning(this.db, sql`update public.vendor_packages set status = ${status}::public.product_status where id = ${packageId} and vendor_id = ${shopId} returning id`);
    return { updated: rows.length, needsPayment: false };
  }

  /** `delete().eq("id", id).eq("vendor_id", shop)` */
  async remove(shopId: string, packageId: string): Promise<number> {
    return (await jsonReturning(this.db, sql`delete from public.vendor_packages where id = ${packageId} and vendor_id = ${shopId} returning id`)).length;
  }
}
