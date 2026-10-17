import type { NotificationRowV1 } from "../../contracts/v1.js";
import type { DataContext, Identity } from "../../database/context.js";
import { NotificationWriter } from "../../database/repositories/notification-writer.repository.js";
import { NotificationsRepository, type RecentUnreadNotification } from "../../database/repositories/notifications.repository.js";
import { PushSubscriptionsRepository } from "../../database/repositories/push-subscriptions.repository.js";

const THIRTY_DAYS_MS = 30 * 86_400_000;

export type MarkReadInput = { all: true } | { ids: string[]; read: boolean };

/** Reading and marking the signed-in user's notifications (runs as the user). */
export class NotificationsService {
  constructor(
    private readonly db: () => DataContext,
    private readonly now: () => number = Date.now,
  ) {}

  /** Unread ones plus read ones from the last 30 days unless `readSince` says otherwise. */
  panel(me: Identity, options: { readSince?: string; limit: number }): Promise<NotificationRowV1[]> {
    const since = options.readSince ?? new Date(this.now() - THIRTY_DAYS_MS).toISOString();
    return this.db().asUser(me, (tx) => new NotificationsRepository(tx).listForPanel(me.userId, since, options.limit));
  }

  async unreadCount(me: Identity, filter: { type?: string; after?: string }): Promise<{ count: number }> {
    const count = await this.db().asUser(me, (tx) => new NotificationsRepository(tx).unreadCount(me.userId, filter));
    return { count };
  }

  recentUnread(me: Identity, limit: number): Promise<RecentUnreadNotification[]> {
    return this.db().asUser(me, (tx) => new NotificationsRepository(tx).recentUnread(me.userId, limit));
  }

  async markRead(me: Identity, input: MarkReadInput): Promise<{ updated: number }> {
    const updated = await this.db().asUser(me, (tx) => {
      const repo = new NotificationsRepository(tx);
      return "all" in input ? repo.markAllRead(me.userId) : repo.setRead(me.userId, input.ids, input.read);
    });
    return { updated };
  }

  /**
   * Replaces: public.create_notification(uuid, text, text, text, text, jsonb, uuid) - as the app used it:
   * a note to oneself (e.g. "a document could not be uploaded").
   * FIX (BASELINE_FINDINGS S2): the original let anyone, signed in or not, send any user any notification
   * (emailed and pushed); here the recipient is always the caller and there is no actor.
   */
  async notifySelf(me: Identity, n: { type: string; title: string; body: string | null; targetView: string | null; targetParams: Record<string, unknown> | null }): Promise<{ done: true }> {
    await this.db().onBehalfOf(me, (tx) => new NotificationWriter(tx).create({ userId: me.userId, ...n, actorId: null }));
    return { done: true };
  }

  /** Saves this phone's push subscription for the caller. Replaces the app's upsert into push_subscriptions; runs as the user. */
  async savePushSubscription(me: Identity, s: { endpoint: string; p256dh: string; auth: string }): Promise<{ saved: true }> {
    await this.db().asUser(me, (tx) => new PushSubscriptionsRepository(tx).save(me.userId, s.endpoint, s.p256dh, s.auth));
    return { saved: true };
  }
}
