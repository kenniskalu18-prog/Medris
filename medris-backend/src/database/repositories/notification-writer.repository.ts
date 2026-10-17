import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { jsonRows } from "../json.js";

/**
 * Writes in-app notifications. Every row is forwarded by the database trigger
 * notify_email_on_notification to /api/notify (email + push), exactly as when the
 * database functions created them.
 *
 *   create_notification(...) -> create(...)
 *   notify_admins(...)       -> notifyAdmins(...)
 *   notify_comment_mentions(...) -> commentMentions(...)
 */
export class NotificationWriter {
  constructor(private readonly db: Executor) {}

  /** Replaces: public.create_notification(uuid, text, text, text, text, jsonb, uuid) - the actor's name and avatar are copied onto the row. Nothing for a null user. */
  async create(n: {
    userId: string | null;
    type: string;
    title: string;
    body: string | null;
    targetView?: string | null;
    targetParams?: Record<string, unknown> | null;
    actorId?: string | null;
  }): Promise<void> {
    if (!n.userId) return;
    await this.db.execute(sql`
      insert into public.notifications (user_id, type, title, body, target_view, target_params, actor_id, actor_name, actor_avatar_url)
      select ${n.userId}, ${n.type}, ${n.title}, ${n.body}, ${n.targetView ?? null}, coalesce(${n.targetParams ? JSON.stringify(n.targetParams) : null}::jsonb, '{}'::jsonb),
             ${n.actorId ?? null}::uuid, u.name, u.avatar_url
      from (select 1) x left join public.users u on u.id = ${n.actorId ?? null}::uuid`);
  }

  /**
   * create() where a failure must not undo the caller's work - the functions' `begin perform
   * create_notification(...); exception when others then null; end`: runs in a savepoint and
   * ignores any error.
   */
  async createQuietly(n: Parameters<NotificationWriter["create"]>[0]): Promise<void> {
    try {
      await this.db.transaction((sp) => new NotificationWriter(sp).create(n));
    } catch {
      // ignored, as the original did
    }
  }

  /** Every admin, with whether they are the super admin. */
  admins(): Promise<{ id: string; is_super_admin: boolean }[]> {
    return jsonRows(this.db, sql`select id, coalesce(is_super_admin, false) as is_super_admin from public.users where role = 'admin'`);
  }

  /** Replaces: public.notify_admins(text, text, text, jsonb, uuid) - one 'admin_alert' notification per admin. */
  async notifyAdmins(title: string, body: string | null, targetView: string | null, targetParams: Record<string, unknown> | null, actorId: string | null): Promise<void> {
    for (const admin of await this.admins()) {
      await this.create({ userId: admin.id, type: "admin_alert", title, body, targetView, targetParams: targetParams ?? {}, actorId });
    }
  }

  /**
   * Replaces: public.notify_comment_mentions(text, uuid, uuid, uuid, text, text, text, text, uuid[]) - every verified, active shop
   * whose name is @mentioned in a comment hears about it (not the author, nor anyone in `skip`).
   */
  async commentMentions(m: {
    kind: string;
    itemId: string;
    commentId: string;
    authorId: string | null;
    authorName: string | null;
    authorAvatar: string | null;
    content: string | null;
    itemName: string | null;
    skip: string[] | null;
  }): Promise<void> {
    if (m.content == null || !m.content.includes("@")) return;
    const shops = await jsonRows<{ id: string; user_id: string }>(
      this.db,
      sql`select id, user_id from public.vendors
          where user_id is not null and verification_status = 'verified' and coalesce(is_active, true)
            and length(business_name) >= 2
            and strpos(lower(${m.content}::text), lower('@' || business_name)) > 0`,
    );
    const skip = m.skip ?? [];
    for (const v of shops) {
      if (v.user_id === m.authorId || skip.includes(v.user_id)) continue;
      const pkg = m.kind === "package";
      await this.db.execute(sql`
        insert into public.notifications (user_id, type, title, body, target_view, target_params, actor_id, actor_name, actor_avatar_url, vendor_id, notification_category, group_key, metadata)
        values (${v.user_id}, 'comment_mention', ${m.authorName}::text || ' mentioned you in a comment on "' || coalesce(${m.itemName}::text, 'a listing') || '"',
                left(${m.content}::text, 180), ${pkg ? "packageDetail" : "productDetail"},
                ${JSON.stringify(pkg ? { packageId: m.itemId, openComments: true } : { productId: m.itemId, openComments: true })}::jsonb,
                ${m.authorId}::uuid, ${m.authorName}, ${m.authorAvatar}, ${v.id}, 'comment_mention', ${`comment-mention:${m.commentId}:${v.id}`},
                ${JSON.stringify({ comment_id: m.commentId, kind: m.kind })}::jsonb)`);
    }
  }
}
