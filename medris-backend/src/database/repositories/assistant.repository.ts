import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { jsonReturning, jsonRow, jsonRows } from "../json.js";
import type { AiConversationHit, SharedAiMessage } from "../../modules/assistant/assistant.schemas.js";

/** Levi's saved conversations (ai_conversations / ai_messages): search, sharing and reactions. */
export class AssistantRepository {
  constructor(private readonly db: Executor) {}

  /** search_ai_conversations(text): the user's conversations whose title or messages match. */
  search(userId: string | null, query: string): Promise<AiConversationHit[]> {
    return jsonRows<AiConversationHit>(
      this.db,
      sql`select distinct c.id, c.title, c.updated_at
          from public.ai_conversations c left join public.ai_messages m on m.conversation_id = c.id
          where c.user_id = ${userId}::uuid and (c.title ilike '%' || ${query} || '%' or m.content ilike '%' || ${query} || '%')
          order by c.updated_at desc
          limit 50`,
    );
  }

  /** get_shared_ai_conversation(uuid): the messages of the conversation shared under that token. */
  shared(token: string): Promise<SharedAiMessage[]> {
    return jsonRows<SharedAiMessage>(
      this.db,
      sql`select c.title, m.role, m.content, m.created_at
          from public.ai_conversations c join public.ai_messages m on m.conversation_id = c.id
          where c.share_token = ${token}
          order by m.created_at asc`,
    );
  }

  async ownsConversation(userId: string, conversationId: string): Promise<boolean> {
    return (await jsonRow(this.db, sql`select 1 as x from public.ai_conversations where id = ${conversationId} and user_id = ${userId}`)) !== null;
  }

  /** Shares (keeping an existing token) or unshares; returns the token or null. */
  async setShared(conversationId: string, shared: boolean): Promise<string | null> {
    if (!shared) {
      await this.db.execute(sql`update public.ai_conversations set share_token = null where id = ${conversationId}`);
      return null;
    }
    const [row] = await jsonReturning<{ share_token: string }>(
      this.db,
      sql`update public.ai_conversations set share_token = coalesce(share_token, gen_random_uuid()) where id = ${conversationId} returning share_token`,
    );
    return row?.share_token ?? null;
  }

  /** The owner of a message's conversation and the message's current reaction. */
  messageOwner(messageId: string): Promise<{ owner: string | null; reaction: string | null } | null> {
    return jsonRow(
      this.db,
      sql`select c.user_id as owner, am.reaction from public.ai_messages am join public.ai_conversations c on c.id = am.conversation_id where am.id = ${messageId}`,
    );
  }

  async setReaction(messageId: string, reaction: string | null): Promise<void> {
    await this.db.execute(sql`update public.ai_messages set reaction = ${reaction} where id = ${messageId}`);
  }
}
