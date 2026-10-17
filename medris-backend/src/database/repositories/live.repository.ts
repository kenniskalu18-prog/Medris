import { sql, type SQL } from "drizzle-orm";
import type { Executor } from "../client.js";
import { jsonRow, jsonRows } from "../json.js";
import { AccessRepository } from "./access.repository.js";

/**
 * The tables whose changes the app watches (the supabase_realtime publication, plus package_comments - B15), with
 * their primary key. Migration 0004 puts the backend_live_notify trigger on exactly these.
 */
export const LIVE_TABLES = {
  disputes: ["id"],
  equipment_requests: ["id"],
  favorites: ["id"],
  messages: ["id"],
  monthly_listing_submissions: ["id"],
  notifications: ["id"],
  order_items: ["id"],
  order_notes: ["id"],
  orders: ["id"],
  package_comment_likes: ["id"],
  package_comments: ["id"],
  payments: ["id"],
  points_weekly: ["user_id", "week_start"],
  product_comment_likes: ["id"],
  product_comments: ["id"],
  product_variants: ["id"],
  products: ["id"],
  request_offers: ["id"],
  service_offers: ["id"],
  vendor_follows: ["id"],
  vendor_packages: ["id"],
  vendors: ["id"],
} as const satisfies Record<string, readonly string[]>;
export type LiveTable = keyof typeof LIVE_TABLES;
export const isLiveTable = (t: string): t is LiveTable => Object.hasOwn(LIVE_TABLES, t);

/** A conversation's typing/presence room, or a voice call's signalling room. */
export type LiveRoom = { kind: "conversation" | "call"; id: string };

/**
 * Reads for the live endpoint. `visibleColumns` and `row` run inside the subscriber's own session (asCaller), so
 * row-level security and column grants decide what each subscriber receives - what Supabase Realtime checked
 * before sending a change.
 */
export class LiveRepository {
  constructor(private readonly db: Executor) {}

  /** The columns of a table the current role may read, in table order. */
  async visibleColumns(table: LiveTable): Promise<string[]> {
    const rows = await jsonRows<{ c: string }>(
      this.db,
      sql`select column_name as c from information_schema.columns
          where table_schema = 'public' and table_name = ${table}
            and has_column_privilege(format('public.%I', ${table}::text), column_name::text, 'SELECT')
          order by ordinal_position`,
    );
    return rows.map((r) => r.c);
  }

  /** The row (only the given columns) if the current role can see it; null otherwise. */
  async row(table: LiveTable, key: Record<string, unknown>, columns: string[]): Promise<Record<string, unknown> | null> {
    if (!columns.length) return null;
    const conditions: SQL[] = LIVE_TABLES[table].map((col) => sql`${sql.identifier(col)} = ${String(key[col] ?? "")}`);
    const picked = sql.join(
      columns.map((c) => sql.identifier(c)),
      sql`, `,
    );
    const found = await jsonRow<{ row: Record<string, unknown> }>(
      this.db,
      sql`select to_jsonb(x) as row from (select ${picked} from public.${sql.identifier(table)} where ${sql.join(conditions, sql` and `)}) x`,
    );
    return found?.row ?? null;
  }

  /** May this user join the room? Conversation: its buyer or the shop's owner. Call: its caller or callee. */
  async canJoin(userId: string, room: LiveRoom): Promise<boolean> {
    if (room.kind === "conversation") return new AccessRepository(this.db).isConversationParticipant(userId, room.id);
    const row = await jsonRow(this.db, sql`select 1 as x from public.voice_calls where id = ${room.id} and (caller_id = ${userId} or callee_id = ${userId})`);
    return Boolean(row);
  }
}
