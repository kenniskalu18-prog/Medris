import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { uuidArray } from "../arrays.js";
import { jsonReturning, jsonRow, jsonRows } from "../json.js";

/**
 * Levi chat history (ai_conversations, ai_messages), as the app's table queries used it. Run as the
 * user: only one's own chats (row-level security); a new message moves its chat to the top (trigger).
 */
export class AiChatsRepository {
  constructor(private readonly db: Executor) {}

  /** `from("ai_conversations").select("id, title, updated_at").order("updated_at", desc).limit(50)` */
  conversations(): Promise<{ id: string; title: string | null; updated_at: string }[]> {
    return jsonRows(this.db, sql`select id, title, updated_at from public.ai_conversations order by updated_at desc limit 50`);
  }

  /** `insert({ user_id: me, title }).select("id").single()` */
  async createConversation(me: string, title: string | null): Promise<string> {
    return (await jsonReturning<{ id: string }>(this.db, sql`insert into public.ai_conversations (user_id, title) values (${me}, ${title}) returning id`))[0]!.id;
  }

  /** `delete().in("id", ids)` - how many went (another user's chats are untouched). */
  async deleteConversations(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return (await jsonReturning(this.db, sql`delete from public.ai_conversations where id = any(${uuidArray(ids)}) returning id`)).length;
  }

  /** `from("ai_messages").select("id, role, content, reaction, created_at").eq("conversation_id", id).order("created_at")` */
  messages(conversationId: string): Promise<{ id: string; role: string; content: string; reaction: string | null; created_at: string }[]> {
    return jsonRows(this.db, sql`select id, role, content, reaction, created_at from public.ai_messages where conversation_id = ${conversationId} order by created_at asc`);
  }

  /** `insert({ conversation_id, role, content }).select("id").single()` */
  async addMessage(conversationId: string, role: string, content: string): Promise<string> {
    return (await jsonReturning<{ id: string }>(this.db, sql`insert into public.ai_messages (conversation_id, role, content) values (${conversationId}, ${role}, ${content}) returning id`))[0]!.id;
  }

  /** `select("conversation_id,created_at").eq("id", id).maybeSingle()` */
  message(messageId: string): Promise<{ conversation_id: string; created_at: string } | null> {
    return jsonRow(this.db, sql`select conversation_id, created_at from public.ai_messages where id = ${messageId}`);
  }
}
