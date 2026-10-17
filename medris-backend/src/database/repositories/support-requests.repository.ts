import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { jsonReturning, jsonRows } from "../json.js";

/**
 * Support requests, as the app's table queries used them. Run as the user: row-level security (one's
 * own requests; admins read and answer all) still decides.
 */
export class SupportRequestsRepository {
  constructor(private readonly db: Executor) {}

  /** `select("id,subject,message,status,admin_reply,attachments,created_at,updated_at").eq("user_id", me).order("created_at", desc)` */
  mine(me: string): Promise<Record<string, unknown>[]> {
    return jsonRows(
      this.db,
      sql`select id, subject, message, status, admin_reply, attachments, created_at, updated_at from public.support_requests
          where user_id = ${me} order by created_at desc`,
    );
  }

  /** `insert({ user_id: me, subject, message, attachments: [] }).select("id").single()` */
  async create(me: string, subject: string, message: string): Promise<string> {
    const [row] = await jsonReturning<{ id: string }>(
      this.db,
      sql`insert into public.support_requests (user_id, subject, message, attachments) values (${me}, ${subject}, ${message}, '[]'::jsonb) returning id`,
    );
    return row!.id;
  }

  /** Whether the request is the user's own. */
  async isOwn(me: string, requestId: string): Promise<boolean> {
    return (await jsonRows(this.db, sql`select 1 as x from public.support_requests where id = ${requestId} and user_id = ${me}`)).length > 0;
  }

  /** Sets a request's attachments (the files are already uploaded). Only ever this column. */
  async setAttachments(requestId: string, attachments: unknown[]): Promise<number> {
    return (await jsonReturning(this.db, sql`update public.support_requests set attachments = ${JSON.stringify(attachments)}::jsonb where id = ${requestId} returning id`)).length;
  }

  /** `delete().eq("id", id).eq("user_id", me)` - how many went. */
  async remove(me: string, requestId: string): Promise<number> {
    return (await jsonReturning(this.db, sql`delete from public.support_requests where id = ${requestId} and user_id = ${me} returning id`)).length;
  }

  /** `select("id,user_id,subject,message,status,admin_reply,attachments,created_at,updated_at").order("created_at", desc)` (admins see all). */
  all(): Promise<Record<string, unknown>[]> {
    return jsonRows(
      this.db,
      sql`select id, user_id, subject, message, status, admin_reply, attachments, created_at, updated_at from public.support_requests order by created_at desc`,
    );
  }

  /** `update({ status, admin_reply }).eq("id", id)` - how many changed (0 for anyone but an admin). */
  async answer(requestId: string, status: string, adminReply: string | null): Promise<number> {
    return (await jsonReturning(this.db, sql`update public.support_requests set status = ${status}, admin_reply = ${adminReply} where id = ${requestId} returning id`)).length;
  }
}
