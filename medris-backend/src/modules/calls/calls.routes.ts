import { defineRoute } from "../../shared/http/route.js";
import { z } from "../../shared/openapi/zod.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { commonErrors, ConversationParams, dataResponse, DoneSchema, errorResponses, idParam, isoDateTime, jsonBody } from "../../shared/openapi/schemas.js";
import { optionalSignIn, signedIn } from "../../shared/openapi/security.js";

/** In-app voice calls. */

const tags = ["Calls"];
const callLimit = rateLimit({ name: "calls", limit: 60, windowMs: 60_000 });
const CallParams = z.object({ callId: idParam });

export const canCall = defineRoute({
  method: "get",
  path: "/conversations/{conversationId}/callable",
  tags,
  summary: "Can the caller call in this conversation?",
  description: "Replaces can_call_in_conversation().",
  security: optionalSignIn,
  request: { params: ConversationParams },
  responses: { 200: dataResponse(z.object({ callable: z.boolean() }), "Whether a call is possible."), ...errorResponses(400), ...commonErrors },
});

export const callParty = defineRoute({
  method: "get",
  path: "/conversations/{conversationId}/call-party",
  tags,
  summary: "Name and picture shown while calling",
  description: "Replaces get_call_party().",
  security: optionalSignIn,
  request: { params: ConversationParams },
  responses: {
    200: dataResponse(z.array(z.object({ name: z.string().nullable(), avatar_url: z.string().nullable() })), "Zero or one row."),
    ...errorResponses(400),
    ...commonErrors,
  },
});

export const startCall = defineRoute({
  method: "post",
  path: "/conversations/{conversationId}/calls",
  tags,
  summary: "Start a voice call",
  description: "Replaces start_voice_call(): records the call and rings the other side (notification + push).",
  security: signedIn,
  middleware: [callLimit] as const,
  request: { params: ConversationParams },
  responses: {
    200: dataResponse(z.array(z.object({ call_id: z.string(), callee_id: z.string() })), "One row."),
    ...errorResponses(400, 403, 429),
    ...commonErrors,
  },
});

export const ringAgain = defineRoute({
  method: "post",
  path: "/calls/{callId}/ring",
  tags,
  summary: "Ring the callee's phone again",
  description: "Replaces ring_callee_again(): only the caller, while ringing (45 s, at most 9 times).",
  security: signedIn,
  middleware: [callLimit] as const,
  request: { params: CallParams },
  responses: { 200: dataResponse(z.object({ rang: z.boolean() }), "Whether it rang."), ...errorResponses(400, 429), ...commonErrors },
});

export const updateCall = defineRoute({
  method: "post",
  path: "/calls/{callId}/status",
  tags,
  summary: "Answer, decline, give up or end a call",
  description: "Replaces update_voice_call(). A missed call notifies the callee.",
  security: signedIn,
  middleware: [callLimit] as const,
  request: { params: CallParams, body: jsonBody(z.object({ status: z.string().max(20) }).openapi("UpdateCallRequest")) },
  responses: { 200: dataResponse(DoneSchema, "Done."), ...errorResponses(400, 403, 415, 429), ...commonErrors },
});

const CallLogRowSchema = z
  .object({ id: z.string(), caller_id: z.string(), callee_id: z.string(), status: z.string(), created_at: z.string(), answered_at: z.string().nullable(), ended_at: z.string().nullable() })
  .openapi("CallLogRow");

export const callLog = defineRoute({
  method: "get",
  path: "/conversations/{conversationId}/calls",
  tags,
  summary: "The chat's call log",
  description: 'Replaces `from("voice_calls").select("id,caller_id,callee_id,status,created_at,answered_at,ended_at").eq("conversation_id", id).order("created_at").limit(100)`.',
  security: signedIn,
  request: { params: ConversationParams },
  responses: { 200: dataResponse(z.array(CallLogRowSchema), "Oldest first."), ...errorResponses(400, 401), ...commonErrors },
});

export const callStatus = defineRoute({
  method: "get",
  path: "/calls/{callId}",
  tags,
  summary: "A call's status",
  description: 'Replaces `from("voice_calls").select("status").eq("id", id).maybeSingle()`. Null when the caller is not part of the call.',
  security: signedIn,
  request: { params: CallParams },
  responses: { 200: dataResponse(z.object({ status: z.string().nullable() }), "The status."), ...errorResponses(400, 401), ...commonErrors },
});

export const ringingCalls = defineRoute({
  method: "get",
  path: "/calls/ringing",
  tags,
  summary: "A call ringing for the caller",
  description: 'Replaces `from("voice_calls").select("id,conversation_id,created_at,caller_id").eq("callee_id", me).eq("status", "ringing").gt("created_at", since).limit(1)`.',
  security: signedIn,
  request: { query: z.object({ since: isoDateTime }) },
  responses: {
    200: dataResponse(z.array(z.object({ id: z.string(), conversation_id: z.string(), created_at: z.string(), caller_id: z.string() })), "At most one."),
    ...errorResponses(400, 401),
    ...commonErrors,
  },
});
