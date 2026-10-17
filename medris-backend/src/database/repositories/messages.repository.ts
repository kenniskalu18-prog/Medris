import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { uuidArray } from "../arrays.js";
import { jsonReturning, jsonRow, jsonRows } from "../json.js";

/** A messages row, every column (`select("*")`). */
export type MessageRow = Record<string, unknown> & { id: string; conversation_id: string; sender_id: string; created_at: string };

export interface ReplyPreview {
  id: string;
  sender_id: string;
  body: string;
  attachment_name: string | null;
  deleted_at: string | null;
}

/**
 * Chat messages, as the app's table queries read and wrote them. Run as the user: messages' row-level
 * security (participants, and admins reading) and its trigger (notify the other side) still decide.
 */
export class MessagesRepository {
  constructor(private readonly db: Executor) {}

  /**
   * `from("messages").select("*").eq("conversation_id", id)[.gt("created_at", after)].order("created_at", …).limit(n)`.
   */
  list(conversationId: string, o: { order: "asc" | "desc"; limit: number; after?: string | null }): Promise<MessageRow[]> {
    return jsonRows(
      this.db,
      sql`select * from public.messages
          where conversation_id = ${conversationId} ${o.after ? sql`and created_at > ${o.after}::timestamptz` : sql``}
          order by created_at ${o.order === "asc" ? sql`asc` : sql`desc`} limit ${o.limit}`,
    );
  }

  /** `select("id,sender_id,body,attachment_name,deleted_at").in("id", ids)` - what a reply quotes. */
  previews(ids: string[]): Promise<ReplyPreview[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return jsonRows(this.db, sql`select id, sender_id, body, attachment_name, deleted_at from public.messages where id = any(${uuidArray(ids)})`);
  }

  /** `insert({ conversation_id, sender_id: me, body, reply_to_id, attachment_* }).select("*").single()` */
  async send(
    me: string,
    conversationId: string,
    m: { body: string; replyToId: string | null; attachment: { url: string; name: string | null; type: string | null; size: number | null } | null },
  ): Promise<MessageRow> {
    const [row] = await jsonReturning<MessageRow>(
      this.db,
      sql`insert into public.messages (conversation_id, sender_id, body, reply_to_id, attachment_url, attachment_name, attachment_type, attachment_size)
          values (${conversationId}, ${me}, ${m.body}, ${m.replyToId}::uuid, ${m.attachment?.url ?? null}, ${m.attachment?.name ?? null},
                  ${m.attachment?.type ?? null}, ${m.attachment?.size ?? null}::int)
          returning *`,
    );
    return row!;
  }

  /**
   * `update({ read_at: now, delivered_at: now }).in("id", ids)` - only read and delivery times (the table's
   * policy would let a participant change any column; see BASELINE_FINDINGS S5). How many changed.
   */
  async markRead(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return (await jsonReturning(this.db, sql`update public.messages set read_at = now(), delivered_at = now() where id = any(${uuidArray(ids)}) returning id`)).length;
  }

  /** `update({ delivered_at: now }).is("delivered_at", null).neq("sender_id", me)` - every message to the caller not yet delivered. */
  async markDelivered(me: string): Promise<number> {
    return (await jsonReturning(this.db, sql`update public.messages set delivered_at = now() where delivered_at is null and sender_id <> ${me} returning id`)).length;
  }
}

export interface ConversationRow {
  id: string;
  buyer_id: string;
  vendor_id: string;
  vendor: {
    id: string;
    business_name: string | null;
    logo_url: string | null;
    user_id: string | null;
    phone: string | null;
    whatsapp_number: string | null;
    whatsapp_visible: boolean | null;
  } | null;
}

/** Conversation rows, as the app's table queries read and created them (as the user: row-level security decides). */
export class ConversationRowsRepository {
  constructor(private readonly db: Executor) {}

  /**
   * `from("conversations").select("id, buyer_id, vendor:vendors(id, business_name, logo_url, user_id, phone, whatsapp_number, whatsapp_visible)")`
   * (and `select("buyer_id, vendor_id")`): the shop is embedded only when the caller may see it, as PostgREST did.
   */
  get(conversationId: string): Promise<ConversationRow | null> {
    return jsonRow(
      this.db,
      sql`select c.id, c.buyer_id, c.vendor_id,
                 (select json_build_object('id', v.id, 'business_name', v.business_name, 'logo_url', v.logo_url, 'user_id', v.user_id,
                                           'phone', v.phone, 'whatsapp_number', v.whatsapp_number, 'whatsapp_visible', v.whatsapp_visible)
                  from public.vendors v where v.id = c.vendor_id) as vendor
          from public.conversations c where c.id = ${conversationId}`,
    );
  }

  /** `select("id").eq("buyer_id", b).eq("vendor_id", v).maybeSingle()` */
  async find(buyerId: string, vendorId: string): Promise<string | null> {
    return (await jsonRow<{ id: string }>(this.db, sql`select id from public.conversations where buyer_id = ${buyerId} and vendor_id = ${vendorId}`))?.id ?? null;
  }

  /** `insert({ buyer_id, vendor_id }).select("id").single()` */
  async create(buyerId: string, vendorId: string): Promise<string> {
    return (await jsonReturning<{ id: string }>(this.db, sql`insert into public.conversations (buyer_id, vendor_id) values (${buyerId}, ${vendorId}) returning id`))[0]!.id;
  }
}
