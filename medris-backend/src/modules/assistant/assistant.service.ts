import type { DataContext, Identity } from "../../database/context.js";
import { AssistantRepository } from "../../database/repositories/assistant.repository.js";
import { badRequest, forbidden, notFound, unauthenticated } from "../../shared/errors/app-error.js";
import type { AiConversationHit, SharedAiMessage } from "./assistant.schemas.js";
import { AiChatsRepository } from "../../database/repositories/ai-chats.repository.js";

/** Levi's saved conversations: search, share links and message reactions. */
export class AssistantService {
  constructor(private readonly db: () => DataContext) {}

  /** Replaces: public.search_ai_conversations(text) - the caller's own conversations (none when signed out). */
  search(me: Identity | null, query: string): Promise<AiConversationHit[]> {
    return this.db().asService((tx) => new AssistantRepository(tx).search(me?.userId ?? null, query));
  }

  /** Replaces: public.get_shared_ai_conversation(uuid) - anyone with the link. */
  shared(token: string): Promise<SharedAiMessage[]> {
    return this.db().asService((tx) => new AssistantRepository(tx).shared(token));
  }

  /** Replaces: public.set_ai_conversation_shared(uuid, boolean) - returns the share token (null when unshared). */
  async setShared(me: Identity | null, conversationId: string, shared: boolean): Promise<{ shareToken: string | null }> {
    if (!me) throw notFound("Conversation not found");
    const shareToken = await this.db().onBehalfOf(me, async (tx) => {
      const repo = new AssistantRepository(tx);
      if (!(await repo.ownsConversation(me.userId, conversationId))) throw notFound("Conversation not found");
      return repo.setShared(conversationId, shared);
    });
    return { shareToken };
  }

  /** Replaces: public.toggle_ai_message_reaction(uuid, text) - the same emoji again removes it. */
  async toggleReaction(me: Identity | null, messageId: string, emoji: string | null | undefined): Promise<{ reaction: string | null }> {
    if (!me) throw unauthenticated("Not authenticated");
    // Length in characters (code points), as PostgreSQL's length() counted them.
    if (!emoji || [...emoji].length > 8) throw badRequest("Invalid emoji");
    const reaction = await this.db().onBehalfOf(me, async (tx) => {
      const repo = new AssistantRepository(tx);
      const message = await repo.messageOwner(messageId);
      if (!message?.owner) throw notFound("Message not found");
      if (message.owner !== me.userId) throw forbidden("Not your conversation");
      const next = message.reaction === emoji ? null : emoji;
      await repo.setReaction(messageId, next);
      return next;
    });
    return { reaction };
  }

  /** The caller's Levi chats, most recent first (up to 50). Replaces the app's table queries on ai_conversations; runs as the user. */
  history(me: Identity): Promise<{ id: string; title: string | null; updated_at: string }[]> {
    return this.db().asUser(me, (tx) => new AiChatsRepository(tx).conversations());
  }

  async startConversation(me: Identity, title: string | null): Promise<{ id: string }> {
    return { id: await this.db().asUser(me, (tx) => new AiChatsRepository(tx).createConversation(me.userId, title)) };
  }

  async deleteConversations(me: Identity, ids: string[]): Promise<{ deleted: number }> {
    return { deleted: await this.db().asUser(me, (tx) => new AiChatsRepository(tx).deleteConversations(ids)) };
  }

  /** A Levi chat's messages, oldest first. Replaces the app's selects on ai_messages. */
  conversationMessages(me: Identity, conversationId: string): Promise<{ id: string; role: string; content: string; reaction: string | null; created_at: string }[]> {
    return this.db().asUser(me, (tx) => new AiChatsRepository(tx).messages(conversationId));
  }

  async addMessage(me: Identity, conversationId: string, role: "user" | "assistant", content: string): Promise<{ id: string }> {
    return { id: await this.db().asUser(me, (tx) => new AiChatsRepository(tx).addMessage(conversationId, role, content)) };
  }

  /** Which chat a message is in, and when it was written. */
  message(me: Identity, messageId: string): Promise<{ conversation_id: string; created_at: string } | null> {
    return this.db().asUser(me, (tx) => new AiChatsRepository(tx).message(messageId));
  }
}
