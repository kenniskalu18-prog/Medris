import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { rowsOf } from "../client.js";
import { uuidArray } from "../arrays.js";
import { jsonRow, jsonRows } from "../json.js";

/** A product_variants row with every column, as to_jsonb() renders it. */
export type VariantRow = Record<string, unknown> & { id: string; product_id: string; name: string };

/** One submitted variety, parsed the way save_product_variants() parsed it (see parseVariant). */
export interface ParsedVariant {
  id: string | null;
  name: string | null;
  photo_url: string | null;
  /** Prices as PostgreSQL's numeric text, so no precision is lost on the way back. */
  sale_price: string | null;
  discount_price: string | null;
  rental_rate: string | null;
  sort_order: number;
  quantity_available: number;
  size: string | null;
  color: string | null;
  description: string | null;
}

export interface InventoryItem {
  id: string;
  name: string;
  price: number | null;
  status: string;
  created_at: string;
  vendor_id: string;
  quantity_available: number | null;
  quantity_total: number | null;
  vendor_name: string;
  category_id: string | null;
  category_name: string;
  sector_id: string | null;
  sector_name: string;
}

export interface ProductRegionRow {
  product_id: string;
  product_name: string;
  city: string;
  order_count: number;
  total_units: number;
}

/** Products: varieties, the admin inventory and where a shop's products sell. */
export class ProductsRepository {
  constructor(private readonly db: Executor) {}

  async vendorOf(productId: string): Promise<string | null> {
    const row = await jsonRow<{ vendor_id: string }>(this.db, sql`select vendor_id from public.products where id = ${productId}`);
    return row?.vendor_id ?? null;
  }

  /** Every variety of a product, ordered as the shop arranged them - one JSON array, as the functions returned it. */
  async variants(productId: string): Promise<VariantRow[]> {
    const [row] = rowsOf<{ result: VariantRow[] }>(
      await this.db.execute(sql`
        select coalesce(jsonb_agg(to_jsonb(pv) order by pv.sort_order, pv.created_at), '[]'::jsonb) as result
        from public.product_variants pv where pv.product_id = ${productId}`),
    );
    return row?.result ?? [];
  }

  /**
   * Batch mode for this transaction, as save_product_variants() set it: the variety triggers
   * skip their per-row follower notifications (sent once after the save), and the statement
   * time is bounded.
   */
  async enterBatchVariantSave(): Promise<void> {
    await this.db.execute(sql`select set_config('levromart.batch_variant_save', '1', true), set_config('statement_timeout', '30s', true)`);
  }

  /**
   * One submitted item, converted by PostgreSQL exactly as the original did (so a malformed id,
   * price or quantity fails with the same message): empty strings are missing values, text is
   * trimmed, sort order and quantity default to 0. Values after the name are only converted when
   * there is a name, because the original stopped at "Every variety needs a variety name." first.
   */
  async parseVariant(item: unknown): Promise<ParsedVariant> {
    const row = await jsonRow<ParsedVariant>(
      this.db,
      sql`select v.id, v.name,
                 case when v.name is null then null else nullif(i->>'photo_url','') end as photo_url,
                 case when v.name is null then null else nullif(i->>'sale_price','')::numeric::text end as sale_price,
                 case when v.name is null then null else nullif(i->>'discount_price','')::numeric::text end as discount_price,
                 case when v.name is null then null else nullif(i->>'rental_rate','')::numeric::text end as rental_rate,
                 case when v.name is null then 0 else coalesce(nullif(i->>'sort_order','')::integer, 0) end as sort_order,
                 case when v.name is null then 0 else coalesce(nullif(i->>'quantity_available','')::integer, 0) end as quantity_available,
                 case when v.name is null then null else nullif(trim(i->>'size'),'') end as size,
                 case when v.name is null then null else nullif(trim(i->>'color'),'') end as color,
                 case when v.name is null then null else nullif(trim(i->>'description'),'') end as description
          from (select ${JSON.stringify(item ?? null)}::jsonb as i) x,
               lateral (select nullif(i->>'id','')::uuid as id, nullif(trim(i->>'name'),'') as name) v`,
    );
    return row!;
  }

  async variantBelongs(variantId: string, productId: string): Promise<boolean> {
    return (await jsonRow(this.db, sql`select 1 as x from public.product_variants where id = ${variantId} and product_id = ${productId}`)) !== null;
  }

  async updateVariant(productId: string, v: ParsedVariant & { id: string; name: string }): Promise<void> {
    await this.db.execute(sql`
      update public.product_variants
      set name = ${v.name}, photo_url = ${v.photo_url}, sale_price = ${v.sale_price}::numeric, discount_price = ${v.discount_price}::numeric,
          rental_rate = ${v.rental_rate}::numeric, sort_order = ${v.sort_order}, quantity_available = ${v.quantity_available},
          size = ${v.size}, color = ${v.color}, description = ${v.description}, updated_at = now()
      where id = ${v.id} and product_id = ${productId}`);
  }

  /** A new variety; the id is the submitted one when given, else a new one. Returns the id. */
  async insertVariant(productId: string, v: ParsedVariant & { name: string }): Promise<string> {
    const [row] = rowsOf<{ id: string }>(
      await this.db.execute(sql`
        insert into public.product_variants (id, product_id, name, photo_url, sale_price, discount_price, rental_rate, sort_order, quantity_available, size, color, description)
        values (coalesce(${v.id}::uuid, gen_random_uuid()), ${productId}, ${v.name}, ${v.photo_url}, ${v.sale_price}::numeric, ${v.discount_price}::numeric,
                ${v.rental_rate}::numeric, ${v.sort_order}, ${v.quantity_available}, ${v.size}, ${v.color}, ${v.description})
        returning id`),
    );
    return row!.id;
  }

  /** Removes the varieties of the product that were not submitted. */
  async deleteVariantsExcept(productId: string, keep: string[]): Promise<void> {
    await this.db.execute(sql`
      delete from public.product_variants pv
      where pv.product_id = ${productId} and not (pv.id = any(${uuidArray(keep)}))`);
  }

  /* ------------------------------------------------------------------- admin inventory */

  /** admin_get_inventory(): every product not removed by an admin, with its shop, category and sector names. */
  async inventory(): Promise<InventoryItem[]> {
    const [row] = rowsOf<{ result: InventoryItem[] }>(
      await this.db.execute(sql`
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', p.id,
          'name', p.name,
          'price', coalesce(p.discount_price, p.sale_price, p.rental_rate),
          'status', p.status::text,
          'created_at', p.created_at,
          'vendor_id', p.vendor_id,
          'quantity_available', p.quantity_available,
          'quantity_total', p.quantity_total,
          'vendor_name', coalesce(v.business_name, 'Unknown vendor'),
          'category_id', p.category_id,
          'category_name', coalesce(c.name, 'Uncategorized'),
          'sector_id', coalesce(c.sector_id, v.sector_id),
          'sector_name', coalesce(cs.name, s.name, 'Unassigned')
        ) order by lower(coalesce(p.name, '')), p.created_at desc), '[]'::jsonb) as result
        from public.products p
        left join public.vendors v on v.id = p.vendor_id
        left join public.sectors s on s.id = v.sector_id
        left join public.categories c on c.id = p.category_id
        left join public.sectors cs on cs.id = c.sector_id
        where p.admin_deleted_at is null`),
    );
    return row?.result ?? [];
  }

  /** The product's name (locked for the change), if it is still in the inventory. */
  async lockInventoryProduct(productId: string): Promise<{ name: string | null } | null> {
    const [row] = rowsOf<{ name: string | null }>(
      await this.db.execute(sql`select name from public.products where id = ${productId} and admin_deleted_at is null for update`),
    );
    return row ?? null;
  }

  async hasOrders(productId: string): Promise<boolean> {
    return (await jsonRow(this.db, sql`select 1 as x from public.order_items where product_id = ${productId} limit 1`)) !== null;
  }

  async deleteProduct(productId: string): Promise<void> {
    await this.db.execute(sql`delete from public.products where id = ${productId}`);
  }

  /** Hides a product that has orders: status 'removed', marked as removed by this admin. */
  async adminRemove(productId: string, adminId: string): Promise<void> {
    await this.db.execute(sql`update public.products set status = 'removed', admin_deleted_at = now(), admin_deleted_by = ${adminId} where id = ${productId}`);
  }

  /* ------------------------------------------------------------------- vendor insights */

  /** get_vendor_product_regions(): units and orders per product and buyer city ('Unknown area' when unset), cancelled orders left out. */
  productRegions(vendorId: string): Promise<ProductRegionRow[]> {
    return jsonRows<ProductRegionRow>(
      this.db,
      sql`select oi.product_id, p.name as product_name,
                 coalesce(nullif(trim(u.city), ''), 'Unknown area') as city,
                 count(distinct oi.order_id) as order_count,
                 sum(oi.quantity) as total_units
          from public.order_items oi
          join public.orders o on o.id = oi.order_id
          join public.products p on p.id = oi.product_id
          join public.users u on u.id = o.buyer_id
          where o.vendor_id = ${vendorId} and o.status != 'cancelled'
          group by oi.product_id, p.name, coalesce(nullif(trim(u.city), ''), 'Unknown area')
          order by p.name, order_count desc`,
    );
  }
}
