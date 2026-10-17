import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { jsonRow, jsonRows } from "../json.js";

/** voice_calls, as the app's table queries read it (as the user: only the caller, the callee and admins see a call). */
export class VoiceCallsRepository {
  constructor(private readonly db: Executor) {}

  /** `select("id,caller_id,callee_id,status,created_at,answered_at,ended_at").eq("conversation_id", id).order("created_at").limit(100)` - the chat's call log. */
  log(conversationId: string): Promise<{ id: string; caller_id: string; callee_id: string; status: string; created_at: string; answered_at: string | null; ended_at: string | null }[]> {
    return jsonRows(
      this.db,
      sql`select id, caller_id, callee_id, status, created_at, answered_at, ended_at from public.voice_calls
          where conversation_id = ${conversationId} order by created_at asc limit 100`,
    );
  }

  /** `select("status").eq("id", id).maybeSingle()` */
  async status(callId: string): Promise<string | null> {
    return (await jsonRow<{ status: string }>(this.db, sql`select status from public.voice_calls where id = ${callId}`))?.status ?? null;
  }

  /** `select("id,conversation_id,created_at,caller_id").eq("callee_id", me).eq("status", "ringing").gt("created_at", since).limit(1)` */
  ringing(me: string, since: string): Promise<{ id: string; conversation_id: string; created_at: string; caller_id: string }[]> {
    return jsonRows(
      this.db,
      sql`select id, conversation_id, created_at, caller_id from public.voice_calls
          where callee_id = ${me} and status = 'ringing' and created_at > ${since}::timestamptz limit 1`,
    );
  }
}
