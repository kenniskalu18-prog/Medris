import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { jsonReturning, jsonRows } from "../json.js";

export interface MessagePinRow {
  id: string;
  conversation_id: string;
  message_id: string;
  pinned_at: string;
  expires_at: string | null;
}

/**
 * message_pins (a user's pinned messages in one conversation), as the app's table queries used it.
 * Run as the user: row-level security (own pins, in conversations one is part of) and the trigger
 * that limits pins still decide.
 */
export class MessagePinsRepository {
  constructor(private readonly db: Executor) {}

  /** `select("id,conversation_id,message_id,pinned_at,expires_at").eq(conversation).eq(user).order("pinned_at", desc).limit(4)` */
  list(me: string, conversationId: string): Promise<MessagePinRow[]> {
    return jsonRows(
      this.db,
      sql`select id, conversation_id, message_id, pinned_at, expires_at from public.message_pins
          where conversation_id = ${conversationId} and user_id = ${me}
          order by pinned_at desc limit 4`,
    );
  }

  /** `insert({ user_id: me, conversation_id, message_id })` */
  async pin(me: string, conversationId: string, messageId: string): Promise<void> {
    await this.db.execute(sql`insert into public.message_pins (user_id, conversation_id, message_id) values (${me}, ${conversationId}, ${messageId})`);
  }

  /** `delete().eq(user).eq(conversation).eq(message)` - how many rows went. */
  async unpin(me: string, conversationId: string, messageId: string): Promise<number> {
    return (
      await jsonReturning(
        this.db,
        sql`delete from public.message_pins where user_id = ${me} and conversation_id = ${conversationId} and message_id = ${messageId} returning id`,
      )
    ).length;
  }
}
