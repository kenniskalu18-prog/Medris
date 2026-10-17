import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";

/**
 * push_subscriptions, as the app's table query used it. Run as the user: row-level security
 * (only one's own subscriptions) still decides.
 */
export class PushSubscriptionsRepository {
  constructor(private readonly db: Executor) {}

  /**
   * `upsert({ user_id: me, endpoint, p256dh, auth_key }, { onConflict: "endpoint" })` - this phone's
   * subscription, replacing the keys when the endpoint is already saved. An endpoint saved for another
   * account is refused by row-level security, as before.
   */
  async save(me: string, endpoint: string, p256dh: string, authKey: string): Promise<void> {
    await this.db.execute(sql`
      insert into public.push_subscriptions (user_id, endpoint, p256dh, auth_key) values (${me}, ${endpoint}, ${p256dh}, ${authKey})
      on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth_key = excluded.auth_key`);
  }
}
