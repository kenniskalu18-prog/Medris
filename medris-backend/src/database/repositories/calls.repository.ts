import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { rowsOf } from "../client.js";
import { jsonRow, jsonRows } from "../json.js";

export interface CallRow {
  id: string;
  conversation_id: string;
  caller_id: string;
  callee_id: string;
  status: string;
  rings: number;
  /** Started more than 45 seconds ago (ring_callee_again stops ringing then). */
  stale: boolean;
}

/** In-app voice calls between a buyer and a shop, and app presence. */
export class CallsRepository {
  constructor(private readonly db: Executor) {}

  /**
   * can_call_in_conversation(): the caller takes part, and either chat is open between the two
   * (an accepted order, see buyer_can_message_vendor) or it is an existing chat with messages and no
   * order between them at all.
   */
  async canCall(userId: string, conversationId: string): Promise<boolean> {
    const row = await jsonRow<{ ok: boolean }>(
      this.db,
      sql`select exists (
            select 1 from public.conversations c join public.vendors v on v.id = c.vendor_id
            where c.id = ${conversationId} and (c.buyer_id = ${userId}::uuid or v.user_id = ${userId}::uuid)
              and (
                exists (
                  select 1 from public.orders o
                  where o.buyer_id = c.buyer_id and o.vendor_id = c.vendor_id
                    and (o.status in ('confirmed','handed_over','returned','payment_unresolved','disputed')
                         or (o.status = 'completed' and coalesce(o.completed_at, o.status_changed_at, o.created_at) > now() - interval '24 hours')))
                or (exists (select 1 from public.messages m where m.conversation_id = c.id)
                    and not exists (select 1 from public.orders o where o.buyer_id = c.buyer_id and o.vendor_id = c.vendor_id))
              )
          ) as ok`,
    );
    return row?.ok ?? false;
  }

  /** get_call_party(): who the caller is calling - the shop's name and logo for the buyer, the buyer's for the shop. */
  party(userId: string, conversationId: string): Promise<{ name: string | null; avatar_url: string | null }[]> {
    return jsonRows(
      this.db,
      sql`select case when c.buyer_id = ${userId}::uuid then v.business_name else bu.name end as name,
                 case when c.buyer_id = ${userId}::uuid then coalesce(v.logo_url, vu.avatar_url) else bu.avatar_url end as avatar_url
          from public.conversations c
          join public.vendors v on v.id = c.vendor_id
          left join public.users bu on bu.id = c.buyer_id
          left join public.users vu on vu.id = v.user_id
          where c.id = ${conversationId} and (c.buyer_id = ${userId}::uuid or v.user_id = ${userId}::uuid)`,
    );
  }

  /** The two sides of a conversation and the shop's name and logo. */
  async conversation(conversationId: string): Promise<{ buyer_id: string; vendor_user_id: string; vendor_name: string | null; vendor_logo: string | null } | null> {
    return jsonRow(
      this.db,
      sql`select c.buyer_id, v.user_id as vendor_user_id, v.business_name as vendor_name, v.logo_url as vendor_logo
          from public.conversations c join public.vendors v on v.id = c.vendor_id where c.id = ${conversationId}`,
    );
  }

  /** A call this user started in the last 60 seconds that is still ringing. */
  async isRinging(callerId: string): Promise<boolean> {
    return (await jsonRow(this.db, sql`select 1 as x from public.voice_calls where caller_id = ${callerId} and status = 'ringing' and created_at > now() - interval '60 seconds' limit 1`)) !== null;
  }

  async profile(userId: string): Promise<{ name: string | null; avatar_url: string | null } | null> {
    return jsonRow(this.db, sql`select name, avatar_url from public.users where id = ${userId}`);
  }

  async create(conversationId: string, callerId: string, calleeId: string): Promise<string> {
    const [row] = rowsOf<{ id: string }>(
      await this.db.execute(sql`insert into public.voice_calls (conversation_id, caller_id, callee_id) values (${conversationId}, ${callerId}, ${calleeId}) returning id`),
    );
    return row!.id;
  }

  async find(callId: string): Promise<CallRow | null> {
    return jsonRow<CallRow>(
      this.db,
      sql`select id, conversation_id, caller_id, callee_id, status, rings, created_at < now() - interval '45 seconds' as stale
          from public.voice_calls where id = ${callId}`,
    );
  }

  /** The latest "incoming call" notification of this call (what the callee's phone rings with). */
  async incomingCallNotification(calleeId: string, callId: string): Promise<string | null> {
    const row = await jsonRow<{ id: string }>(
      this.db,
      sql`select n.id from public.notifications n
          where n.type = 'incoming_call' and n.user_id = ${calleeId} and n.target_params->>'callId' = ${callId}::text
          order by n.created_at desc limit 1`,
    );
    return row?.id ?? null;
  }

  async countRing(callId: string): Promise<void> {
    await this.db.execute(sql`update public.voice_calls set rings = rings + 1 where id = ${callId}`);
  }

  /** answered (active), declined, missed, ended - with the matching time stamp. */
  async setStatus(callId: string, status: "active" | "declined" | "missed" | "ended"): Promise<void> {
    if (status === "active") await this.db.execute(sql`update public.voice_calls set status = 'active', answered_at = now() where id = ${callId}`);
    else await this.db.execute(sql`update public.voice_calls set status = ${status}, ended_at = now() where id = ${callId}`);
  }
}
