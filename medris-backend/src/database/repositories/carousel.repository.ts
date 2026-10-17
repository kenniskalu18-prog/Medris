import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { jsonReturning, jsonRow, jsonRows } from "../json.js";

export interface CarouselSlideInput {
  storage_path: string | null;
  image_url: string;
  link_url?: string | null;
  alt_text?: string | null;
  sort_order?: number;
  is_active?: boolean;
}

/** The home page's banners (homepage_carousel_slides). Run as the user: everyone sees active ones; only admins see the rest and change them. */
export class CarouselRepository {
  constructor(private readonly db: Executor) {}

  /** `select("id,storage_path,image_url,link_url,alt_text,sort_order,is_active,created_by,created_at,updated_at").order("sort_order").order("created_at")[.eq("is_active", true)]` */
  slides(activeOnly: boolean): Promise<Record<string, unknown>[]> {
    return jsonRows(
      this.db,
      sql`select id, storage_path, image_url, link_url, alt_text, sort_order, is_active, created_by, created_at, updated_at
          from public.homepage_carousel_slides ${activeOnly ? sql`where is_active = true` : sql``}
          order by sort_order asc, created_at asc`,
    );
  }

  /**
   * `insert(payload)` / `insert(rows)`. FIX B14: a banner bundled with the app has no stored file; the app sent
   * storage_path null, which the column refuses, so "publish bundled banners" always failed - it is stored as ''.
   */
  async add(adminId: string, slides: CarouselSlideInput[]): Promise<number> {
    let n = 0;
    for (const s of slides) {
      await this.db.execute(sql`
        insert into public.homepage_carousel_slides (storage_path, image_url, link_url, alt_text, sort_order, is_active, created_by)
        values (coalesce(${s.storage_path}::text, ''), ${s.image_url}, ${s.link_url ?? null}, ${s.alt_text ?? null}, coalesce(${s.sort_order ?? null}::int, 0),
                coalesce(${s.is_active ?? null}::boolean, true), ${adminId})`);
      n += 1;
    }
    return n;
  }

  /** `update({ ...fields }).eq("id", id)` - only the fields given (updated_at is set by the trigger). How many changed. */
  async update(id: string, f: { alt_text?: string | null; link_url?: string | null; sort_order?: number; is_active?: boolean; storage_path?: string; image_url?: string }): Promise<number> {
    const sets = [
      f.alt_text !== undefined ? sql`alt_text = ${f.alt_text}` : null,
      f.link_url !== undefined ? sql`link_url = ${f.link_url}` : null,
      f.sort_order !== undefined ? sql`sort_order = ${f.sort_order}` : null,
      f.is_active !== undefined ? sql`is_active = ${f.is_active}` : null,
      f.storage_path !== undefined ? sql`storage_path = ${f.storage_path}` : null,
      f.image_url !== undefined ? sql`image_url = ${f.image_url}` : null,
    ].filter((x) => x !== null);
    if (sets.length === 0) return 0;
    return (await jsonReturning(this.db, sql`update public.homepage_carousel_slides set ${sql.join(sets, sql`, `)}, updated_at = now() where id = ${id} returning id`)).length;
  }

  /** `delete().eq("id", id)` after reading its storage_path: returns the path of the removed banner's file (to delete it), if any. */
  async remove(id: string): Promise<{ removed: boolean; storage_path: string | null }> {
    const row = await jsonRow<{ storage_path: string | null }>(this.db, sql`select storage_path from public.homepage_carousel_slides where id = ${id}`);
    const removed = (await jsonReturning(this.db, sql`delete from public.homepage_carousel_slides where id = ${id} returning id`)).length > 0;
    return { removed, storage_path: removed ? row?.storage_path || null : null };
  }
}
