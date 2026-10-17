import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { rowsOf } from "../client.js";
import { jsonRow, jsonRows } from "../json.js";

export interface ConversationListItem {
  conversation_id: string;
  other_id: string | null;
  other_name: string | null;
  other_avatar: string | null;
  last_message: string | null;
  last_message_at: string | null;
  unread_count: number;
  pinned: boolean;
}

export interface OtherParty {
  id: string;
  name: string | null;
  avatar_url: string | null;
  phone: string | null;
}

export interface ChatList {
  id: string;
  name: string;
  conversation_ids: string[];
}

export interface ConversationParticipants {
  buyer_id: string;
  buyer_name: string | null;
  buyer_avatar: string | null;
  vendor_id: string;
  vendor_name: string | null;
  vendor_avatar: string | null;
}

export interface AdminConversationRow {
  conversation_id: string;
  buyer_id: string;
  buyer_name: string | null;
  vendor_id: string;
  vendor_name: string | null;
  last_body: string | null;
  last_at: string | null;
  message_count: number;
}

/** A message as the edit / delete / reaction rules need it; `past_window` = sent more than 30 minutes ago. */
export interface MessageForChange {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  deleted: boolean;
  past_window: boolean;
}

/**
 * Buyer-vendor conversations, their messages and the caller's chat lists. Every query takes
 * the caller's id explicitly (the database functions read auth.uid()).
 */
export class ConversationsRepository {
  constructor(private readonly db: Executor) {}

  /**
   * Replaces: public.buyer_can_message_vendor(uuid, uuid) - chat is open while the buyer has an accepted order with the shop
   * (confirmed, handed over, returned, payment unresolved, disputed), and for 24 hours after one completes.
   */
  async buyerCanMessageVendor(buyerId: string, vendorId: string): Promise<boolean> {
    const row = await jsonRow<{ ok: boolean }>(
      this.db,
      sql`select exists (
            select 1 from public.orders o
            where o.buyer_id = ${buyerId} and o.vendor_id = ${vendorId}
              and (o.status in ('confirmed','handed_over','returned','payment_unresolved','disputed')
                   or (o.status = 'completed' and coalesce(o.completed_at, o.status_changed_at, o.created_at) > now() - interval '24 hours'))
          ) as ok`,
    );
    return row?.ok ?? false;
  }

  async find(buyerId: string, vendorId: string): Promise<string | null> {
    const row = await jsonRow<{ id: string }>(this.db, sql`select id from public.conversations where buyer_id = ${buyerId} and vendor_id = ${vendorId}`);
    return row?.id ?? null;
  }

  async create(buyerId: string, vendorId: string): Promise<string> {
    const [row] = rowsOf<{ id: string }>(await this.db.execute(sql`insert into public.conversations (buyer_id, vendor_id) values (${buyerId}, ${vendorId}) returning id`));
    return row!.id;
  }

  /** list_my_conversations(): open conversations, pinned first, then by latest message. */
  listFor(userId: string): Promise<ConversationListItem[]> {
    const me = sql`${userId}::uuid`;
    return jsonRows<ConversationListItem>(
      this.db,
      sql`select
            c.id as conversation_id,
            case when c.buyer_id = ${me} then v.user_id else bu.id end as other_id,
            case when c.buyer_id = ${me} then coalesce(v.business_name, vu.name) else bu.name end as other_name,
            case when c.buyer_id = ${me} then coalesce(v.logo_url, vu.avatar_url) else bu.avatar_url end as other_avatar,
            lm.body as last_message,
            lm.created_at as last_message_at,
            greatest(
              (select count(*)::int from public.messages m2 where m2.conversation_id = c.id and m2.read_at is null and m2.sender_id <> ${me}),
              case when (case when c.buyer_id = ${me} then c.marked_unread_by_buyer else c.marked_unread_by_vendor end) then 1 else 0 end
            ) as unread_count,
            case when c.buyer_id = ${me} then c.pinned_by_buyer else c.pinned_by_vendor end as pinned
          from public.conversations c
          join public.vendors v on v.id = c.vendor_id
          left join public.users bu on bu.id = c.buyer_id
          left join public.users vu on vu.id = v.user_id
          left join lateral (
            select body, created_at from public.messages m where m.conversation_id = c.id order by m.created_at desc limit 1
          ) lm on true
          where (c.buyer_id = ${me} or v.user_id = ${me})
            and exists (
              select 1 from public.orders o
              where o.buyer_id = c.buyer_id and o.vendor_id = c.vendor_id
                and (o.status in ('confirmed','handed_over','returned','payment_unresolved','disputed')
                     or (o.status = 'completed' and coalesce(o.completed_at, o.status_changed_at, o.created_at) > now() - interval '24 hours')))
          order by (case when c.buyer_id = ${me} then c.pinned_by_buyer else c.pinned_by_vendor end) desc,
                   coalesce(lm.created_at, c.created_at) desc`,
    );
  }

  /** The caller's side of a conversation they take part in (as the buyer or the shop owner); null otherwise. */
  async participation(userId: string, conversationId: string): Promise<{ buyer_id: string; vendor_id: string; is_buyer: boolean } | null> {
    return jsonRow(
      this.db,
      sql`select c.buyer_id, c.vendor_id, (c.buyer_id = ${userId}::uuid) as is_buyer
          from public.conversations c join public.vendors v on v.id = c.vendor_id
          where c.id = ${conversationId} and (c.buyer_id = ${userId}::uuid or v.user_id = ${userId}::uuid)`,
    );
  }

  /** conversation_is_open(): the caller takes part and chat is currently allowed between the two. */
  async isOpen(userId: string, conversationId: string): Promise<boolean> {
    const row = await jsonRow<{ ok: boolean }>(
      this.db,
      sql`select exists (
            select 1 from public.conversations c join public.vendors v on v.id = c.vendor_id
            where c.id = ${conversationId} and (c.buyer_id = ${userId}::uuid or v.user_id = ${userId}::uuid)
              and exists (
                select 1 from public.orders o
                where o.buyer_id = c.buyer_id and o.vendor_id = c.vendor_id
                  and (o.status in ('confirmed','handed_over','returned','payment_unresolved','disputed')
                       or (o.status = 'completed' and coalesce(o.completed_at, o.status_changed_at, o.created_at) > now() - interval '24 hours')))
          ) as ok`,
    );
    return row?.ok ?? false;
  }

  /**
   * mark_conversation_opened(): the other side's messages become read (and delivered) in every
   * conversation of this buyer-shop pair - older data has duplicates - and the "marked unread"
   * flags of the pair are cleared.
   */
  async markOpened(userId: string, buyerId: string, vendorId: string): Promise<void> {
    await this.db.execute(sql`
      update public.messages m
      set read_at = now(), delivered_at = coalesce(delivered_at, now())
      where m.sender_id <> ${userId}::uuid
        and m.conversation_id in (
          select c2.id from public.conversations c2 join public.vendors v2 on v2.id = c2.vendor_id
          where c2.buyer_id = ${buyerId} and c2.vendor_id = ${vendorId} and (c2.buyer_id = ${userId}::uuid or v2.user_id = ${userId}::uuid))
        and m.read_at is null`);
    await this.db.execute(sql`
      update public.conversations c set marked_unread_by_buyer = false, marked_unread_by_vendor = false
      where c.buyer_id = ${buyerId} and c.vendor_id = ${vendorId}`);
  }

  /** get_conversation_other_party(): the other person's profile (for the shop owner, the buyer; for the buyer, the shop owner). */
  otherParty(userId: string, conversationId: string): Promise<OtherParty[]> {
    return jsonRows<OtherParty>(
      this.db,
      sql`select u.id, u.name, u.avatar_url, u.phone
          from public.conversations c
          join public.vendors v on v.id = c.vendor_id
          join public.users u on u.id = (case when c.buyer_id = ${userId}::uuid then v.user_id else c.buyer_id end)
          where c.id = ${conversationId} and (c.buyer_id = ${userId}::uuid or v.user_id = ${userId}::uuid)`,
    );
  }

  /** toggle_conversation_pin(): which side the caller is on - null when the conversation does not exist. */
  async sides(userId: string, conversationId: string): Promise<{ is_buyer: boolean; is_vendor: boolean } | null> {
    return jsonRow(
      this.db,
      sql`select c.buyer_id = ${userId}::uuid as is_buyer, v.user_id = ${userId}::uuid as is_vendor
          from public.conversations c join public.vendors v on v.id = c.vendor_id where c.id = ${conversationId}`,
    );
  }

  /** Flips the caller's own pin or "marked unread" flag; returns the new value (null when there is no such conversation). */
  async toggleFlag(conversationId: string, column: "pinned_by_buyer" | "pinned_by_vendor" | "marked_unread_by_buyer" | "marked_unread_by_vendor"): Promise<boolean | null> {
    const col = sql.identifier(column);
    const [row] = rowsOf<{ value: boolean }>(
      await this.db.execute(sql`update public.conversations set ${col} = not ${col} where id = ${conversationId} returning ${col} as value`),
    );
    return row?.value ?? null;
  }

  /* ---------------------------------------------------------------------- messages */

  /** The message, locked for the change. */
  async lockMessage(messageId: string): Promise<MessageForChange | null> {
    const [row] = rowsOf<MessageForChange>(
      await this.db.execute(sql`
        select id, conversation_id, sender_id, deleted_at is not null as deleted, created_at < now() - interval '30 minutes' as past_window
        from public.messages where id = ${messageId} for update`),
    );
    return row ?? null;
  }

  async softDeleteMessage(messageId: string): Promise<void> {
    await this.db.execute(sql`update public.messages set deleted_at = now() where id = ${messageId}`);
  }

  async editMessage(messageId: string, body: string): Promise<void> {
    await this.db.execute(sql`update public.messages set body = ${body}, edited_at = now() where id = ${messageId}`);
  }

  async messageConversation(messageId: string): Promise<string | null> {
    const row = await jsonRow<{ conversation_id: string }>(this.db, sql`select conversation_id from public.messages where id = ${messageId}`);
    return row?.conversation_id ?? null;
  }

  /** toggle_message_reaction()'s participant test: the buyer or the shop owner. */
  async takesPart(userId: string, conversationId: string): Promise<boolean> {
    const row = await jsonRow(
      this.db,
      sql`select 1 as x from public.conversations c
          where c.id = ${conversationId} and (c.buyer_id = ${userId}::uuid or (select vendors.user_id from public.vendors where vendors.id = c.vendor_id) = ${userId}::uuid)`,
    );
    return row !== null;
  }

  /** Sets the caller's reaction, or removes it when it is the same emoji; returns every reaction ({ userId: emoji }). */
  async toggleReaction(messageId: string, userId: string, emoji: string): Promise<Record<string, string> | null> {
    const [row] = rowsOf<{ reactions: Record<string, string> | null }>(
      await this.db.execute(sql`
        update public.messages
        set reactions = case when reactions->>${userId}::text = ${emoji}::text then reactions - ${userId}::text
                             else reactions || jsonb_build_object(${userId}::text, ${emoji}::text) end
        where id = ${messageId}
        returning reactions`),
    );
    return row?.reactions ?? null;
  }

  /* -------------------------------------------------------------------- chat lists */

  async createList(userId: string, name: string): Promise<string> {
    const [row] = rowsOf<{ id: string }>(await this.db.execute(sql`insert into public.chat_lists (user_id, name) values (${userId}, trim(${name}::text)) returning id`));
    return row!.id;
  }

  async deleteList(userId: string, listId: string): Promise<void> {
    await this.db.execute(sql`delete from public.chat_lists where id = ${listId} and user_id = ${userId}`);
  }

  /** list_my_chat_lists(): the caller's lists in creation order, with their conversation ids. */
  lists(userId: string): Promise<ChatList[]> {
    return jsonRows<ChatList>(
      this.db,
      sql`select cl.id, cl.name, coalesce(array_agg(clc.conversation_id) filter (where clc.conversation_id is not null), '{}') as conversation_ids
          from public.chat_lists cl
          left join public.chat_list_conversations clc on clc.list_id = cl.id
          where cl.user_id = ${userId}
          group by cl.id, cl.name, cl.created_at
          order by cl.created_at`,
    );
  }

  async ownsList(userId: string, listId: string): Promise<boolean> {
    return (await jsonRow(this.db, sql`select 1 as x from public.chat_lists where id = ${listId} and user_id = ${userId}`)) !== null;
  }

  /** toggle_conversation_in_list()'s test (a left join: a conversation whose shop is gone still counts for its buyer). */
  async isMine(userId: string, conversationId: string): Promise<boolean> {
    const row = await jsonRow(
      this.db,
      sql`select 1 as x from public.conversations c left join public.vendors v on v.id = c.vendor_id
          where c.id = ${conversationId} and (c.buyer_id = ${userId}::uuid or v.user_id = ${userId}::uuid)`,
    );
    return row !== null;
  }

  /** Adds the conversation to the list, or removes it when it is there; true when it is now in the list. */
  async toggleInList(listId: string, conversationId: string): Promise<boolean> {
    const removed = rowsOf(
      await this.db.execute(sql`delete from public.chat_list_conversations where list_id = ${listId} and conversation_id = ${conversationId} returning list_id`),
    );
    if (removed.length > 0) return false;
    await this.db.execute(sql`insert into public.chat_list_conversations (list_id, conversation_id) values (${listId}, ${conversationId})`);
    return true;
  }

  /* ------------------------------------------------------------------------- admin */

  async adminFind(buyerId: string, vendorId: string): Promise<string | null> {
    const row = await jsonRow<{ id: string }>(this.db, sql`select id from public.conversations where buyer_id = ${buyerId} and vendor_id = ${vendorId} limit 1`);
    return row?.id ?? null;
  }

  adminParticipants(conversationId: string): Promise<ConversationParticipants[]> {
    return jsonRows<ConversationParticipants>(
      this.db,
      sql`select bu.id as buyer_id, bu.name as buyer_name, bu.avatar_url as buyer_avatar, v.id as vendor_id, v.business_name as vendor_name, v.logo_url as vendor_avatar
          from public.conversations c
          join public.vendors v on v.id = c.vendor_id
          join public.users bu on bu.id = c.buyer_id
          where c.id = ${conversationId}`,
    );
  }

  /** admin_list_conversations(): latest activity first; search on the buyer's or the shop's name; 1 to 300 rows (100 by default). */
  adminList(search: string | null, limit: number | null): Promise<AdminConversationRow[]> {
    return jsonRows<AdminConversationRow>(
      this.db,
      sql`select c.id as conversation_id, c.buyer_id, bu.name as buyer_name, v.id as vendor_id, v.business_name as vendor_name,
                 lm.body as last_body, lm.created_at as last_at, coalesce(mc.n, 0) as message_count
          from public.conversations c
          join public.vendors v on v.id = c.vendor_id
          left join public.users bu on bu.id = c.buyer_id
          left join lateral (select m.body, m.created_at from public.messages m where m.conversation_id = c.id order by m.created_at desc limit 1) lm on true
          left join lateral (select count(*) n from public.messages m where m.conversation_id = c.id) mc on true
          where (${search}::text is null or ${search}::text = '' or bu.name ilike '%' || ${search}::text || '%' or v.business_name ilike '%' || ${search}::text || '%')
          order by lm.created_at desc nulls last
          limit greatest(1, least(coalesce(${limit}::int, 100), 300))`,
    );
  }
}
