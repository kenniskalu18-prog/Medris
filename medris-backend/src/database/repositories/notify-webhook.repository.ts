import { sql } from "drizzle-orm";
import { appOrigin, requireEnv } from "../../config/env.js";
import type { Executor } from "../client.js";

/**
 * Calls /api/notify the way the database functions do: through pg_net (net.http_post), so the
 * request is sent only if the transaction commits, with the webhook secret the endpoint checks.
 * The database functions have the URL and the secret written into them; the backend takes them
 * from its configuration (APP_ORIGIN, EMAIL_WEBHOOK_SECRET).
 */
export class NotifyWebhook {
  constructor(private readonly db: Executor) {}

  /** ring_callee_again(): push the incoming-call notification to the callee's phone once more. */
  async ringAgain(notificationId: string): Promise<void> {
    await this.post({ notificationId, ringAgain: true });
  }

  /** send_background_reminders(): one batched push per person (the endpoint sends push only). */
  async reminders(reminders: Record<string, unknown>[]): Promise<void> {
    await this.post({ reminders });
  }

  private async post(body: Record<string, unknown>): Promise<void> {
    const url = `${appOrigin()}/api/notify`;
    const secret = requireEnv("EMAIL_WEBHOOK_SECRET");
    await this.db.execute(sql`
      select net.http_post(
        url := ${url}::text,
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', ${secret}::text),
        body := ${JSON.stringify(body)}::jsonb)`);
  }
}
