import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { jsonReturning, jsonRow, jsonRows } from "../json.js";

/**
 * blocked_users, as the app's table queries used it. Run as the user: the table's row-level
 * security (only one's own blocks; never oneself) still decides.
 */
export class BlocksRepository {
  constructor(private readonly db: Executor) {}

  /** `from("blocked_users").select("blocked_id").eq("blocker_id", me)` */
  blockedIds(me: string): Promise<string[]> {
    return jsonRows<{ blocked_id: string }>(this.db, sql`select blocked_id from public.blocked_users where blocker_id = ${me}`).then((r) => r.map((x) => x.blocked_id));
  }

  /** `...eq("blocker_id", me).eq("blocked_id", other).maybeSingle()` */
  async isBlocked(me: string, other: string): Promise<boolean> {
    return (await jsonRow(this.db, sql`select blocked_id from public.blocked_users where blocker_id = ${me} and blocked_id = ${other}`)) !== null;
  }

  /** `insert({ blocker_id: me, blocked_id: other })` - a second block of the same person fails (primary key), as before. */
  async block(me: string, other: string): Promise<void> {
    await this.db.execute(sql`insert into public.blocked_users (blocker_id, blocked_id) values (${me}, ${other})`);
  }

  /** `delete().eq("blocker_id", me).eq("blocked_id", other)` - how many rows went. */
  async unblock(me: string, other: string): Promise<number> {
    return (await jsonReturning(this.db, sql`delete from public.blocked_users where blocker_id = ${me} and blocked_id = ${other} returning blocked_id`)).length;
  }
}
