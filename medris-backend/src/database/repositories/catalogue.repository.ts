import { sql } from "drizzle-orm";
import type { CatalogueRow } from "../../contracts/v1.js";
import type { Executor } from "../client.js";
import { rowsOf } from "../client.js";
import { jsonReturning, jsonRow, jsonRows } from "../json.js";

/**
 * Reference data for the catalogue. Rows are returned with every column, as
 * the app's `select("*")` did, and serialised by PostgreSQL itself (to_json),
 * so values look exactly as they did through Supabase's REST API.
 */
export class CatalogueRepository {
  constructor(private readonly db: Executor) {}

  async listSectors(order: "sort_order" | "name"): Promise<CatalogueRow[]> {
    const orderBy = order === "name" ? sql`s.name` : sql`s.sort_order`;
    const result = await this.db.execute(sql`
      select coalesce(json_agg(to_json(s) order by ${orderBy}), '[]'::json) as rows
      from public.sectors s`);
    return (rowsOf<{ rows: CatalogueRow[] }>(result)[0]?.rows ?? []);
  }

  async listCategories(options: { sectorId?: string }): Promise<CatalogueRow[]> {
    const where = options.sectorId ? sql`where c.sector_id = ${options.sectorId}` : sql``;
    const result = await this.db.execute(sql`
      select coalesce(json_agg(to_json(c) order by c.name), '[]'::json) as rows
      from public.categories c ${where}`);
    return (rowsOf<{ rows: CatalogueRow[] }>(result)[0]?.rows ?? []);
  }

  /* ------------------------------------------- sectors and categories vendors add */

  /** A sector with this name, ignoring case (create_vendor_sector). */
  async sectorNamed(name: string): Promise<string | null> {
    const row = await jsonRow<{ id: string }>(this.db, sql`select id from public.sectors where lower(name) = lower(btrim(${name}::text)) limit 1`);
    return row?.id ?? null;
  }

  /**
   * A new sector at the end of the list. FIX (BASELINE_FINDINGS B8): create_vendor_sector() inserted no
   * slug, which the table requires, so it always failed; the slug is derived from the name the way
   * get_or_create_custom_sector() does it, and a sector already holding that slug is returned.
   */
  async insertSector(name: string): Promise<string> {
    const [created] = rowsOf<{ id: string }>(
      await this.db.execute(sql`
        insert into public.sectors (slug, name, sort_order)
        values ('custom-' || substr(md5(lower(btrim(${name}::text))), 1, 20), btrim(${name}::text), 999)
        on conflict (slug) do update set slug = excluded.slug
        returning id`),
    );
    return created!.id;
  }

  async sectorExists(sectorId: string | null): Promise<boolean> {
    if (!sectorId) return false;
    return (await jsonRow(this.db, sql`select 1 as x from public.sectors where id = ${sectorId}`)) !== null;
  }

  /** A category group (parent) of this sector. */
  async categoryInSector(categoryId: string | null, sectorId: string): Promise<boolean> {
    if (!categoryId) return false;
    return (await jsonRow(this.db, sql`select 1 as x from public.categories where id = ${categoryId} and sector_id = ${sectorId}`)) !== null;
  }

  async subcategoryNamed(parentId: string, sectorId: string, name: string): Promise<string | null> {
    const row = await jsonRow<{ id: string }>(
      this.db,
      sql`select id from public.categories where parent_category_id = ${parentId} and sector_id = ${sectorId} and lower(name) = lower(btrim(${name}::text)) limit 1`,
    );
    return row?.id ?? null;
  }

  async insertCategory(name: string, parentId: string, sectorId: string): Promise<string> {
    const [created] = rowsOf<{ id: string }>(
      await this.db.execute(sql`insert into public.categories (name, parent_category_id, sector_id) values (btrim(${name}::text), ${parentId}, ${sectorId}) returning id`),
    );
    return created!.id;
  }

  /**
   * get_or_create_custom_sector(): the name with runs of spaces collapsed; an existing sector
   * of that name (ignoring case and outer spaces), else a new one with a slug derived from the
   * name, the shapes icon and the next sort position.
   */
  async customSector(name: string): Promise<string> {
    const existing = await jsonRow<{ id: string }>(this.db, sql`select id from public.sectors where lower(trim(name)) = lower(${name}) limit 1`);
    if (existing) return existing.id;
    const [created] = rowsOf<{ id: string }>(
      await this.db.execute(sql`
        insert into public.sectors (slug, name, icon, sort_order)
        values ('custom-' || substr(md5(lower(${name}::text)), 1, 20), ${name}, 'fa-shapes', coalesce((select max(sort_order) from public.sectors), 0) + 1)
        on conflict (slug) do update set name = excluded.name
        returning id`),
    );
    return created!.id;
  }

  /** The name as get_or_create_custom_sector() cleaned it: trimmed, runs of white space made one space. */
  async cleanSectorName(name: string | null): Promise<string> {
    const row = await jsonRow<{ name: string }>(this.db, sql`select regexp_replace(trim(coalesce(${name}::text, '')), '[[:space:]]+', ' ', 'g') as name`);
    return row?.name ?? "";
  }

  /* ------------------------------------------------------------- service price hint */

  /** get_service_price_hint(): completed service offers on a listing - how many, lowest and highest price. */
  servicePriceHint(listingId: string): Promise<{ booking_count: number; min_price: number | null; max_price: number | null }[]> {
    return jsonRows(
      this.db,
      sql`select count(*)::bigint as booking_count, min(current_price)::numeric as min_price, max(current_price)::numeric as max_price
          from public.service_offers where listing_id = ${listingId} and status = 'completed'`,
    );
  }

  /**
   * Replaces: public.ensure_default_category(uuid) - the sector's "Other" top-level category, and under it a
   * category named after the sector (both created when missing). Null for no or an unknown sector.
   */
  async ensureDefaultCategory(sectorId: string | null): Promise<string | null> {
    if (!sectorId) return null;
    const sector = await jsonRow<{ name: string | null }>(this.db, sql`select name from public.sectors where id = ${sectorId}`);
    if (sector?.name == null) return null;
    let parent = (await jsonRow<{ id: string }>(
      this.db,
      sql`select id from public.categories where sector_id = ${sectorId} and parent_category_id is null and lower(name) = 'other' limit 1`,
    ))?.id;
    parent ??= (await jsonReturning<{ id: string }>(
      this.db,
      sql`insert into public.categories (name, sector_id, parent_category_id) values ('Other', ${sectorId}, null) returning id`,
    ))[0]!.id;
    const existing = await jsonRow<{ id: string }>(
      this.db,
      sql`select id from public.categories where sector_id = ${sectorId} and parent_category_id = ${parent} and lower(name) = lower(${sector.name}) limit 1`,
    );
    if (existing) return existing.id;
    return (await jsonReturning<{ id: string }>(
      this.db,
      sql`insert into public.categories (name, sector_id, parent_category_id) values (${sector.name}, ${sectorId}, ${parent}) returning id`,
    ))[0]!.id;
  }
}
