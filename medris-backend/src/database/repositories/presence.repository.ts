import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { jsonRow } from "../json.js";

/**
 * Online presence. Two tables: app_presence (the app is open right now: touched while open,
 * cleared when it closes) and user_presence (when someone was last seen, shown in chats).
 */
export class PresenceRepository {
  constructor(private readonly db: Executor) {}

  /** touch_presence() */
  async touchApp(userId: string): Promise<void> {
    await this.db.execute(sql`insert into public.app_presence (user_id, seen_at) values (${userId}, now()) on conflict (user_id) do update set seen_at = now()`);
  }

  /** clear_presence() */
  async clearApp(userId: string): Promise<void> {
    await this.db.execute(sql`delete from public.app_presence where user_id = ${userId}`);
  }

  /** touch_last_seen() */
  async touchLastSeen(userId: string): Promise<void> {
    await this.db.execute(sql`
      insert into public.user_presence (user_id, last_seen_at) values (${userId}, now())
      on conflict (user_id) do update set last_seen_at = excluded.last_seen_at`);
  }

  /** The other person in a conversation the caller takes part in; null otherwise. */
  async otherSide(userId: string, conversationId: string): Promise<string | null> {
    const row = await jsonRow<{ uid: string }>(
      this.db,
      sql`select (case when c.buyer_id = ${userId}::uuid then v.user_id else c.buyer_id end) as uid
          from public.conversations c join public.vendors v on v.id = c.vendor_id
          where c.id = ${conversationId} and (c.buyer_id = ${userId}::uuid or v.user_id = ${userId}::uuid)`,
    );
    return row?.uid ?? null;
  }

  /**
   * get_conversation_presence()'s value for one person: the latest of when they were last seen,
   * their latest message and their last sign-in (read separately with lastSignIn(), which needs the
   * auth reader).
   */
  async lastSeen(userId: string, lastSignInAt: string | null): Promise<string | null> {
    const row = await jsonRow<{ at: string | null }>(
      this.db,
      sql`select greatest(
            (select p.last_seen_at from public.user_presence p where p.user_id = ${userId}::uuid),
            (select max(m.created_at) from public.messages m where m.sender_id = ${userId}::uuid),
            ${lastSignInAt}::timestamptz
          ) as at`,
    );
    return row?.at ?? null;
  }

  /** auth.users.last_sign_in_at - only readable as the auth reader (DataContext.asAuthReader; migration 0003 grants the column). */
  async lastSignIn(userId: string): Promise<string | null> {
    const row = await jsonRow<{ at: string | null }>(this.db, sql`select last_sign_in_at as at from auth.users where id = ${userId}`);
    return row?.at ?? null;
  }
}
