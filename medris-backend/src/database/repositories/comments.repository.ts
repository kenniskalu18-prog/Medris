import { sql, type SQL } from "drizzle-orm";
import type { Executor } from "../client.js";
import { uuidArray } from "../arrays.js";
import { jsonReturning, jsonRow, jsonRows } from "../json.js";

export type ListingKind = "product" | "package";

/** The tables and key column of one kind of listing. */
const T = {
  product: { comments: sql`public.product_comments`, likes: sql`public.product_comment_likes`, settings: sql`public.product_engagement_settings`, key: sql`product_id`, listings: sql`public.products` },
  package: { comments: sql`public.package_comments`, likes: sql`public.package_comment_likes`, settings: sql`public.package_engagement_settings`, key: sql`package_id`, listings: sql`public.vendor_packages` },
} satisfies Record<ListingKind, Record<string, SQL>>;

export type CommentRow = Record<string, unknown> & {
  id: string;
  user_id: string;
  parent_comment_id: string | null;
  content: string;
  author_name: string;
  author_avatar_url: string | null;
  created_at: string;
  updated_at: string;
  product_id?: string;
  package_id?: string;
};

export interface EngagementSettings {
  vendor_id: string;
  like_visibility: string;
  allow_comments: boolean;
  comment_audience: string;
}

/**
 * Comments, comment likes and engagement settings of products and packages, as the app's table
 * queries used them. Run as the user: row-level security (who may comment - comments on, everyone or
 * followers only; own likes; shop owners' settings) and the triggers (the author's name and photo are
 * copied from their profile; the shop is notified) still decide.
 */
export class CommentsRepository {
  constructor(private readonly db: Executor) {}

  /** `select("id,<key>,user_id,parent_comment_id,content,author_name,author_avatar_url,created_at,updated_at").eq(<key>, id).order("created_at", desc).limit(120)` */
  comments(kind: ListingKind, listingId: string): Promise<CommentRow[]> {
    const t = T[kind];
    return jsonRows(
      this.db,
      sql`select id, ${t.key}, user_id, parent_comment_id, content, author_name, author_avatar_url, created_at, updated_at
          from ${t.comments} where ${t.key} = ${listingId} order by created_at desc limit 120`,
    );
  }

  /** `from(<kind>_comment_likes).select("id,comment_id,user_id").in("comment_id", ids)` */
  likes(kind: ListingKind, commentIds: string[]): Promise<{ id: string; comment_id: string; user_id: string }[]> {
    if (commentIds.length === 0) return Promise.resolve([]);
    return jsonRows(this.db, sql`select id, comment_id, user_id from ${T[kind].likes} where comment_id = any(${uuidArray(commentIds)})`);
  }

  /** `insert({ <key>, user_id: me, parent_comment_id, content, author_name, author_avatar_url })` - the trigger sets the author from the profile. */
  async add(kind: ListingKind, me: string, listingId: string, content: string, parentId: string | null): Promise<string> {
    const t = T[kind];
    const [row] = await jsonReturning<{ id: string }>(
      this.db,
      sql`insert into ${t.comments} (${t.key}, user_id, parent_comment_id, content, author_name, author_avatar_url)
          select ${listingId}, ${me}, ${parentId}::uuid, ${content}, coalesce(nullif(trim(u.name), ''), 'Levromart user'), u.avatar_url
          from (select 1) x left join public.users u on u.id = ${me}
          returning id`,
    );
    return row!.id;
  }

  /** `delete().eq("id", id).eq("user_id", me)` - how many went. */
  async remove(kind: ListingKind, me: string, commentId: string): Promise<number> {
    return (await jsonReturning(this.db, sql`delete from ${T[kind].comments} where id = ${commentId} and user_id = ${me} returning id`)).length;
  }

  /** The like button: the caller's like is removed if there is one, otherwise added. Returns whether they now like it. */
  async toggleLike(kind: ListingKind, me: string, commentId: string): Promise<boolean> {
    const t = T[kind];
    const existing = await jsonRow<{ id: string }>(this.db, sql`select id from ${t.likes} where comment_id = ${commentId} and user_id = ${me}`);
    if (existing) {
      await this.db.execute(sql`delete from ${t.likes} where id = ${existing.id} and user_id = ${me}`);
      return false;
    }
    await this.db.execute(sql`insert into ${t.likes} (comment_id, user_id) values (${commentId}, ${me})`);
    return true;
  }

  /** `from(<kind>_engagement_settings).select("allow_comments,like_visibility,comment_audience,vendor_id").eq(<key>, id).maybeSingle()` */
  settings(kind: ListingKind, listingId: string): Promise<EngagementSettings | null> {
    const t = T[kind];
    return jsonRow(this.db, sql`select vendor_id, like_visibility, allow_comments, comment_audience from ${t.settings} where ${t.key} = ${listingId}`);
  }

  /** `select("<key>,vendor_id,like_visibility").in(<key>, ids)` */
  settingsFor(kind: ListingKind, listingIds: string[]): Promise<Record<string, unknown>[]> {
    if (listingIds.length === 0) return Promise.resolve([]);
    const t = T[kind];
    return jsonRows(this.db, sql`select ${t.key}, vendor_id, like_visibility from ${t.settings} where ${t.key} = any(${uuidArray(listingIds)})`);
  }

  /** Whether the listing belongs to that shop (the settings policies only check the shop - see BASELINE_FINDINGS S6). */
  async listingOfShop(kind: ListingKind, listingId: string, vendorId: string): Promise<boolean> {
    return (await jsonRow(this.db, sql`select 1 as x from ${T[kind].listings} where id = ${listingId} and vendor_id = ${vendorId}`)) !== null;
  }

  /**
   * `upsert({ <key>, vendor_id, like_visibility, allow_comments, comment_audience }, { onConflict: <key> })` -
   * a field left out keeps its current value (or its default on a new row).
   */
  async saveSettings(kind: ListingKind, listingId: string, vendorId: string, s: Partial<Omit<EngagementSettings, "vendor_id">>): Promise<void> {
    const t = T[kind];
    const lv = s.like_visibility ?? null;
    const ac = s.allow_comments ?? null;
    const ca = s.comment_audience ?? null;
    await this.db.execute(sql`
      insert into ${t.settings} (${t.key}, vendor_id, like_visibility, allow_comments, comment_audience)
      values (${listingId}, ${vendorId}, coalesce(${lv}::text, 'everyone'), coalesce(${ac}::boolean, true), coalesce(${ca}::text, 'everyone'))
      on conflict (${t.key}) do update set
        vendor_id = excluded.vendor_id,
        like_visibility = coalesce(${lv}::text, ${t.settings}.like_visibility),
        allow_comments = coalesce(${ac}::boolean, ${t.settings}.allow_comments),
        comment_audience = coalesce(${ca}::text, ${t.settings}.comment_audience)`);
  }
}
