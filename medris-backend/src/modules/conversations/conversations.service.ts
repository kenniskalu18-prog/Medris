import type { DataContext, Identity } from "../../database/context.js";
import { AccessRepository } from "../../database/repositories/access.repository.js";
import {
  ConversationsRepository,
  type AdminConversationRow,
  type ChatList,
  type ConversationListItem,
  type ConversationParticipants,
  type MessageForChange,
  type OtherParty,
} from "../../database/repositories/conversations.repository.js";
import { badRequest, forbidden, notFound, unauthenticated } from "../../shared/errors/app-error.js";
import { isSqlBlank } from "../../lib/sql-text.js";
import { MessagePinsRepository, type MessagePinRow } from "../../database/repositories/message-pins.repository.js";
import { ConversationRowsRepository, MessagesRepository, type ConversationRow, type MessageRow, type ReplyPreview } from "../../database/repositories/messages.repository.js";

/**
 * Buyer-shop chat: conversations, editing and deleting messages, reactions, pins, "mark unread",
 * the caller's chat lists, and the admin views. Sending messages and reading them stay direct
 * table access (row-level security) until the table queries move.
 */
export class ConversationsService {
  constructor(private readonly db: () => DataContext) {}

  /**
   * Replaces: public.get_or_create_conversation(uuid) - the buyer's conversation with a shop, created
   * on first use. Only while chat is open between them (an accepted order); not for admins.
   */
  async open(me: Identity | null, vendorId: string): Promise<{ id: string }> {
    if (!me) throw unauthenticated("must be signed in");
    return this.db().onBehalfOf(me, async (tx) => {
      const repo = new ConversationsRepository(tx);
      if (await new AccessRepository(tx).isAdmin(me.userId)) throw forbidden("admin accounts cannot message vendors");
      if (!(await repo.buyerCanMessageVendor(me.userId, vendorId))) {
        throw forbidden("You can message this vendor once you have placed an order and they have accepted it.");
      }
      return { id: (await repo.find(me.userId, vendorId)) ?? (await repo.create(me.userId, vendorId)) };
    });
  }

  /** Replaces: public.list_my_conversations() - the inbox: open conversations, pinned first, then by latest message. */
  async list(me: Identity | null): Promise<ConversationListItem[]> {
    if (!me) return [];
    return this.db().asService((tx) => new ConversationsRepository(tx).listFor(me.userId));
  }

  /** Replaces: public.conversation_is_open(uuid) - whether the caller can still write in it. */
  async isOpen(me: Identity | null, conversationId: string): Promise<{ open: boolean }> {
    if (!me) return { open: false };
    return { open: await this.db().asService((tx) => new ConversationsRepository(tx).isOpen(me.userId, conversationId)) };
  }

  /** Replaces: public.mark_conversation_opened(uuid) - the other side's messages are read; "marked unread" is cleared. */
  async markOpened(me: Identity | null, conversationId: string): Promise<{ done: true }> {
    if (!me) throw notFound("Conversation not found");
    await this.db().onBehalfOf(me, async (tx) => {
      const repo = new ConversationsRepository(tx);
      const part = await repo.participation(me.userId, conversationId);
      if (!part) throw notFound("Conversation not found");
      await repo.markOpened(me.userId, part.buyer_id, part.vendor_id);
    });
    return { done: true };
  }

  /** Replaces: public.get_conversation_other_party(uuid) - who the caller is talking to (with their phone). */
  async otherParty(me: Identity | null, conversationId: string): Promise<OtherParty[]> {
    if (!me) return [];
    return this.db().asService((tx) => new ConversationsRepository(tx).otherParty(me.userId, conversationId));
  }

  /**
   * Replaces: public.toggle_conversation_pin(uuid) - the caller's own pin; returns the new value
   * (null for a conversation that does not exist, as before).
   * FIX (BASELINE_FINDINGS S4): signed out, the original flipped the shop's pin of any conversation.
   */
  async togglePin(me: Identity | null, conversationId: string): Promise<{ pinned: boolean | null }> {
    if (!me) throw forbidden("not part of this conversation");
    return this.db().onBehalfOf(me, async (tx) => {
      const repo = new ConversationsRepository(tx);
      const sides = await repo.sides(me.userId, conversationId);
      if (sides && !sides.is_buyer && !sides.is_vendor) throw forbidden("not part of this conversation");
      return { pinned: await repo.toggleFlag(conversationId, sides?.is_buyer ? "pinned_by_buyer" : "pinned_by_vendor") };
    });
  }

  /** Replaces: public.toggle_conversation_unread(uuid) - the caller's own "marked unread"; returns the new value. */
  async toggleUnread(me: Identity | null, conversationId: string): Promise<{ unread: boolean | null }> {
    if (!me) throw notFound("Conversation not found");
    return this.db().onBehalfOf(me, async (tx) => {
      const repo = new ConversationsRepository(tx);
      const part = await repo.participation(me.userId, conversationId);
      if (!part) throw notFound("Conversation not found");
      return { unread: await repo.toggleFlag(conversationId, part.is_buyer ? "marked_unread_by_buyer" : "marked_unread_by_vendor") };
    });
  }

  /* ---------------------------------------------------------------------- messages */

  /**
   * Replaces: public.delete_message(uuid) - the sender, within 30 minutes; deleting twice is fine.
   * FIX (BASELINE_FINDINGS S4): signed out, the original deleted anyone's recent message.
   */
  async deleteMessage(me: Identity | null, messageId: string): Promise<{ done: true }> {
    await this.changeOwnMessage(me, messageId, "delete", async (repo, msg) => {
      if (msg.deleted) return;
      if (msg.past_window) throw badRequest("The 30-minute delete window for this message has passed.");
      await repo.softDeleteMessage(messageId);
    });
    return { done: true };
  }

  /**
   * Replaces: public.edit_message(uuid, text) - the sender, within 30 minutes, not after deleting it.
   * FIX (BASELINE_FINDINGS S4): signed out, the original rewrote anyone's recent message.
   */
  async editMessage(me: Identity | null, messageId: string, body: string | null | undefined): Promise<{ done: true }> {
    await this.changeOwnMessage(me, messageId, "edit", async (repo, msg) => {
      if (msg.deleted) throw badRequest("This message was deleted.");
      if (msg.past_window) throw badRequest("The 30-minute edit window for this message has passed.");
      if (isSqlBlank(body)) throw badRequest("Message can't be empty.");
      await repo.editMessage(messageId, body);
    });
    return { done: true };
  }

  /** Replaces: public.toggle_message_reaction(uuid, text) - sets the caller's emoji (the same one again removes it); returns every reaction. */
  async toggleReaction(me: Identity | null, messageId: string, emoji: string | null | undefined): Promise<Record<string, string> | null> {
    if (!me) throw unauthenticated("Not authenticated");
    // PostgreSQL's length(): characters (code points), not UTF-16 units.
    if (emoji == null || emoji.length === 0 || [...emoji].length > 8) throw badRequest("Invalid emoji");
    return this.db().onBehalfOf(me, async (tx) => {
      const repo = new ConversationsRepository(tx);
      const conversationId = await repo.messageConversation(messageId);
      if (!conversationId) throw notFound("Message not found");
      if (!(await repo.takesPart(me.userId, conversationId))) throw forbidden("Not a participant in this conversation");
      return repo.toggleReaction(messageId, me.userId, emoji);
    });
  }

  /** The message locked for the change; only its sender may change it. */
  private async changeOwnMessage(
    me: Identity | null,
    messageId: string,
    verb: "edit" | "delete",
    work: (repo: ConversationsRepository, msg: MessageForChange) => Promise<void>,
  ): Promise<void> {
    const check = async (repo: ConversationsRepository) => {
      const msg = await repo.lockMessage(messageId);
      if (!msg) throw notFound("Message not found.");
      if (!me || msg.sender_id !== me.userId) throw forbidden(`You can only ${verb} your own messages.`);
      return msg;
    };
    if (!me) {
      await this.db().asService((tx) => check(new ConversationsRepository(tx)));
      return;
    }
    await this.db().onBehalfOf(me, async (tx) => {
      const repo = new ConversationsRepository(tx);
      await work(repo, await check(repo));
    });
  }

  /* -------------------------------------------------------------------- chat lists */

  /** Replaces: public.create_chat_list(text) - a named list (folder) of conversations. */
  async createList(me: Identity | null, name: string | null | undefined): Promise<{ id: string }> {
    if (isSqlBlank(name)) throw badRequest("List name cannot be empty");
    if (!me) throw unauthenticated();
    return { id: await this.db().onBehalfOf(me, (tx) => new ConversationsRepository(tx).createList(me.userId, name)) };
  }

  /** Replaces: public.delete_chat_list(uuid) - the caller's own list; anything else is ignored. */
  async deleteList(me: Identity | null, listId: string): Promise<{ done: true }> {
    if (me) await this.db().onBehalfOf(me, (tx) => new ConversationsRepository(tx).deleteList(me.userId, listId));
    return { done: true };
  }

  /** Replaces: public.list_my_chat_lists() */
  async lists(me: Identity | null): Promise<ChatList[]> {
    if (!me) return [];
    return this.db().asService((tx) => new ConversationsRepository(tx).lists(me.userId));
  }

  /** Replaces: public.toggle_conversation_in_list(uuid, uuid) - true when the conversation is now in the list. */
  async toggleInList(me: Identity | null, listId: string, conversationId: string): Promise<{ inList: boolean }> {
    if (!me) throw notFound("List not found");
    return this.db().onBehalfOf(me, async (tx) => {
      const repo = new ConversationsRepository(tx);
      if (!(await repo.ownsList(me.userId, listId))) throw notFound("List not found");
      if (!(await repo.isMine(me.userId, conversationId))) throw notFound("Conversation not found");
      return { inList: await repo.toggleInList(listId, conversationId) };
    });
  }

  /* ------------------------------------------------------------------------- admin */

  /** Replaces: public.admin_find_conversation(uuid, uuid) - null for anyone but admins, as before. */
  async adminFind(me: Identity | null, buyerId: string, vendorId: string): Promise<{ id: string | null }> {
    return this.db().asService(async (tx) => {
      if (!(await new AccessRepository(tx).isAdmin(me?.userId))) return { id: null };
      return { id: await new ConversationsRepository(tx).adminFind(buyerId, vendorId) };
    });
  }

  /** Replaces: public.admin_get_conversation_participants(uuid) - empty for anyone but admins. */
  async adminParticipants(me: Identity | null, conversationId: string): Promise<ConversationParticipants[]> {
    return this.db().asService(async (tx) => {
      if (!(await new AccessRepository(tx).isAdmin(me?.userId))) return [];
      return new ConversationsRepository(tx).adminParticipants(conversationId);
    });
  }

  /** Replaces: public.admin_list_conversations(text, integer) - empty for anyone but admins. */
  async adminList(me: Identity | null, search: string | null, limit: number | null): Promise<AdminConversationRow[]> {
    return this.db().asService(async (tx) => {
      if (!(await new AccessRepository(tx).isAdmin(me?.userId))) return [];
      return new ConversationsRepository(tx).adminList(search, limit);
    });
  }

  /** The caller's pinned messages in a conversation (newest first, up to 4). Replaces the app's select on message_pins; runs as the user. */
  messagePins(me: Identity, conversationId: string): Promise<MessagePinRow[]> {
    return this.db().asUser(me, (tx) => new MessagePinsRepository(tx).list(me.userId, conversationId));
  }

  /** Pins a message; the database refuses a fifth pin and messages outside the caller's conversations, as before. */
  async pinMessage(me: Identity, conversationId: string, messageId: string): Promise<{ pinned: true }> {
    await this.db().asUser(me, (tx) => new MessagePinsRepository(tx).pin(me.userId, conversationId, messageId));
    return { pinned: true };
  }

  async unpinMessage(me: Identity, conversationId: string, messageId: string): Promise<{ pinned: false; removed: number }> {
    const removed = await this.db().asUser(me, (tx) => new MessagePinsRepository(tx).unpin(me.userId, conversationId, messageId));
    return { pinned: false, removed };
  }

  /** A conversation with its shop, when the caller may see it. Replaces the app's select on conversations; runs as the user. */
  conversation(me: Identity, conversationId: string): Promise<ConversationRow | null> {
    return this.db().asUser(me, (tx) => new ConversationRowsRepository(tx).get(conversationId));
  }

  /**
   * The conversation between a buyer and a shop, created on first use - what the order screens did with
   * a select, then an insert (either side of the order may start it; admins may not).
   */
  direct(me: Identity, buyerId: string, vendorId: string): Promise<{ id: string; created: boolean }> {
    return this.db().asUser(me, async (tx) => {
      const rows = new ConversationRowsRepository(tx);
      const existing = await rows.find(buyerId, vendorId);
      if (existing) return { id: existing, created: false };
      return { id: await rows.create(buyerId, vendorId), created: true };
    });
  }

  /** A conversation's messages. Replaces the app's selects on messages; runs as the user. */
  messages(me: Identity, conversationId: string, o: { order: "asc" | "desc"; limit: number; after?: string | null }): Promise<MessageRow[]> {
    return this.db().asUser(me, (tx) => new MessagesRepository(tx).list(conversationId, o));
  }

  /** What replies quote (id, sender, text, attachment name, deleted). */
  messagePreviews(me: Identity, ids: string[]): Promise<ReplyPreview[]> {
    return this.db().asUser(me, (tx) => new MessagesRepository(tx).previews(ids));
  }

  /** Sends a message; the database refuses chats one is not part of and blocked chats, as before. */
  sendMessage(
    me: Identity,
    conversationId: string,
    m: { body: string; replyToId: string | null; attachment: { url: string; name: string | null; type: string | null; size: number | null } | null },
  ): Promise<MessageRow> {
    return this.db().asUser(me, (tx) => new MessagesRepository(tx).send(me.userId, conversationId, m));
  }

  /** Marks messages read (and delivered), now. */
  async markMessagesRead(me: Identity, ids: string[]): Promise<{ updated: number }> {
    return { updated: await this.db().asUser(me, (tx) => new MessagesRepository(tx).markRead(ids)) };
  }

  /** Marks every message to the caller delivered, now (the app did this when it opened). */
  async markMessagesDelivered(me: Identity): Promise<{ updated: number }> {
    return { updated: await this.db().asUser(me, (tx) => new MessagesRepository(tx).markDelivered(me.userId)) };
  }
}
