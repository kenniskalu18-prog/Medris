import type { DataContext, Identity } from "../../database/context.js";
import { CallsRepository } from "../../database/repositories/calls.repository.js";
import { NotificationWriter } from "../../database/repositories/notification-writer.repository.js";
import { NotifyWebhook } from "../../database/repositories/notify-webhook.repository.js";
import { badRequest, forbidden } from "../../shared/errors/app-error.js";
import { VoiceCallsRepository } from "../../database/repositories/voice-calls.repository.js";

export type CallStatus = "active" | "declined" | "missed" | "ended";

/**
 * In-app voice calls between a buyer and a shop. The audio itself is peer to peer (WebRTC, TURN
 * credentials from /api/turn-credentials); this is the call record and the ringing notifications.
 */
export class CallsService {
  constructor(private readonly db: () => DataContext) {}

  /** Replaces: public.can_call_in_conversation(uuid) */
  async canCall(me: Identity | null, conversationId: string): Promise<{ callable: boolean }> {
    if (!me) return { callable: false };
    return { callable: await this.db().asService((tx) => new CallsRepository(tx).canCall(me.userId, conversationId)) };
  }

  /** Replaces: public.get_call_party(uuid) - the name and picture shown while calling. */
  async party(me: Identity | null, conversationId: string): Promise<{ name: string | null; avatar_url: string | null }[]> {
    if (!me) return [];
    return this.db().asService((tx) => new CallsRepository(tx).party(me.userId, conversationId));
  }

  /**
   * Replaces: public.start_voice_call(uuid) - records a ringing call and sends the other side an
   * "Incoming call" notification (pushed to their phone). One ringing call per caller per minute.
   */
  async start(me: Identity | null, conversationId: string): Promise<{ call_id: string; callee_id: string }[]> {
    if (!me) throw forbidden("Authentication required.");
    return this.db().onBehalfOf(me, async (tx) => {
      const calls = new CallsRepository(tx);
      const conversation = await calls.conversation(conversationId);
      if (!conversation) throw badRequest("Conversation not found.");
      if (me.userId !== conversation.buyer_id && me.userId !== conversation.vendor_user_id) throw forbidden("Not your conversation.");
      if (!(await calls.canCall(me.userId, conversationId))) throw forbidden("Calls are available while you have an accepted order together.");
      if (await calls.isRinging(me.userId)) throw badRequest("You already have a call ringing.");

      const callerIsBuyer = me.userId === conversation.buyer_id;
      const calleeId = callerIsBuyer ? conversation.vendor_user_id : conversation.buyer_id;
      let callerName: string | null;
      let callerAvatar: string | null;
      if (me.userId === conversation.vendor_user_id) {
        callerName = conversation.vendor_name;
        callerAvatar = conversation.vendor_logo ?? (await calls.profile(me.userId))?.avatar_url ?? null;
      } else {
        const profile = await calls.profile(me.userId);
        callerName = profile?.name ?? null;
        callerAvatar = profile?.avatar_url ?? null;
      }
      const callId = await calls.create(conversationId, me.userId, calleeId);
      await new NotificationWriter(tx).create({
        userId: calleeId,
        type: "incoming_call",
        title: "Incoming call",
        body: `${callerName ?? "Someone"} is calling you.`,
        targetView: "messages",
        targetParams: { conversationId, callId, callerName: callerName ?? "Someone", callerAvatar },
        actorId: me.userId,
      });
      return [{ call_id: callId, callee_id: calleeId }];
    });
  }

  /**
   * Replaces: public.ring_callee_again(uuid) - the caller's ringing call (under 45 seconds, at most
   * 9 extra rings) pushes its notification again. False when it cannot.
   * FIX (BASELINE_FINDINGS S4): signed out, the original rang anyone's call again.
   */
  async ringAgain(me: Identity | null, callId: string): Promise<{ rang: boolean }> {
    if (!me) return { rang: false };
    return this.db().onBehalfOf(me, async (tx) => {
      const calls = new CallsRepository(tx);
      const call = await calls.find(callId);
      if (!call || call.caller_id !== me.userId || call.status !== "ringing" || call.stale || call.rings >= 9) return { rang: false };
      const notificationId = await calls.incomingCallNotification(call.callee_id, callId);
      if (!notificationId) return { rang: false };
      await calls.countRing(callId);
      await new NotifyWebhook(tx).ringAgain(notificationId);
      return { rang: true };
    });
  }

  /**
   * Replaces: public.update_voice_call(uuid, text) - the callee answers (active) or declines, the
   * caller gives up (missed: the callee is told), either side ends it. Finished calls do not change.
   * FIX (BASELINE_FINDINGS S4): signed out, the original ended anyone's call.
   */
  async update(me: Identity | null, callId: string, status: string): Promise<{ done: true }> {
    if (!me) throw forbidden("Call not found.");
    await this.db().onBehalfOf(me, async (tx) => {
      const calls = new CallsRepository(tx);
      const call = await calls.find(callId);
      if (!call || (me.userId !== call.caller_id && me.userId !== call.callee_id)) throw forbidden("Call not found.");
      if (["ended", "missed", "declined"].includes(call.status)) return;
      const isCallee = me.userId === call.callee_id;
      const isCaller = me.userId === call.caller_id;
      const ringing = call.status === "ringing";
      if (status === "active" && isCallee && ringing) await calls.setStatus(callId, "active");
      else if (status === "declined" && isCallee && ringing) await calls.setStatus(callId, "declined");
      else if (status === "missed" && isCaller && ringing) {
        await calls.setStatus(callId, "missed");
        await new NotificationWriter(tx).create({
          userId: call.callee_id,
          type: "missed_call",
          title: "Missed call",
          body: "You missed a call. Open the chat to call back.",
          targetView: "messages",
          targetParams: { conversationId: call.conversation_id },
          actorId: call.caller_id,
        });
      } else if (status === "ended") await calls.setStatus(callId, "ended");
    });
    return { done: true };
  }

  /** The chat's call log (oldest first, up to 100). Replaces the app's select on voice_calls; runs as the user. */
  callLog(me: Identity, conversationId: string): Promise<{ id: string; caller_id: string; callee_id: string; status: string; created_at: string; answered_at: string | null; ended_at: string | null }[]> {
    return this.db().asUser(me, (tx) => new VoiceCallsRepository(tx).log(conversationId));
  }

  /** A call's status, if the caller is part of it. */
  async callStatus(me: Identity, callId: string): Promise<{ status: string | null }> {
    return { status: await this.db().asUser(me, (tx) => new VoiceCallsRepository(tx).status(callId)) };
  }

  /** A call ringing for the caller that started after `since` (the app's fallback when realtime is down). */
  ringing(me: Identity, since: string): Promise<{ id: string; conversation_id: string; created_at: string; caller_id: string }[]> {
    return this.db().asUser(me, (tx) => new VoiceCallsRepository(tx).ringing(me.userId, since));
  }
}
