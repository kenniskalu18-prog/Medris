import { defineRoute } from "../../shared/http/route.js";
import { z } from "../../shared/openapi/zod.js";
import { requireUser } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { commonErrors, dataResponse, errorResponses, idParam, jsonBody } from "../../shared/openapi/schemas.js";
import { optionalSignIn, signedIn } from "../../shared/openapi/security.js";
import {
  AiConversationHitSchema,
  AiConversationParams,
  AiMessageParams,
  ReactionBody,
  ReactionResult,
  SearchQuery,
  SetSharedBody,
  SetSharedResult,
  ShareTokenParams,
  SharedAiMessageSchema,
} from "./assistant.schemas.js";

/** Levi's saved conversations. */

const tags = ["Assistant"];
const writeLimit = rateLimit({ name: "assistant-write", limit: 60, windowMs: 60_000 });

export const searchConversations = defineRoute({
  method: "get",
  path: "/assistant/conversations/search",
  tags,
  summary: "Search the caller's Levi conversations",
  description: "Replaces search_ai_conversations(). Up to 50, most recent first.",
  security: signedIn,
  request: { query: SearchQuery },
  responses: { 200: dataResponse(z.array(AiConversationHitSchema), "Matches."), ...errorResponses(400), ...commonErrors },
});

export const sharedConversation = defineRoute({
  method: "get",
  path: "/assistant/shared/{token}",
  tags,
  summary: "A shared Levi conversation",
  description: "Replaces get_shared_ai_conversation(). Anyone with the link.",
  security: optionalSignIn,
  request: { params: ShareTokenParams },
  responses: { 200: dataResponse(z.array(SharedAiMessageSchema), "Messages, oldest first."), ...errorResponses(400), ...commonErrors },
});

export const setConversationShared = defineRoute({
  method: "put",
  path: "/assistant/conversations/{conversationId}/shared",
  tags,
  summary: "Share or unshare a conversation",
  description: "Replaces set_ai_conversation_shared(). Returns the share token, or null.",
  security: signedIn,
  middleware: [requireUser, writeLimit] as const,
  request: { params: AiConversationParams, body: jsonBody(SetSharedBody) },
  responses: { 200: dataResponse(SetSharedResult, "Done."), ...errorResponses(400, 401, 404, 415, 429), ...commonErrors },
});

export const toggleMessageReaction = defineRoute({
  method: "post",
  path: "/assistant/messages/{messageId}/reaction",
  tags,
  summary: "React to a Levi message",
  description: "Replaces toggle_ai_message_reaction(). The same emoji again removes it.",
  security: signedIn,
  middleware: [requireUser, writeLimit] as const,
  request: { params: AiMessageParams, body: jsonBody(ReactionBody) },
  responses: { 200: dataResponse(ReactionResult, "The reaction now set (or null)."), ...errorResponses(400, 401, 403, 404, 415, 429), ...commonErrors },
});

const AiMessageRowSchema = z
  .object({ id: z.string(), role: z.string(), content: z.string(), reaction: z.string().nullable(), created_at: z.string() })
  .openapi("AiMessageRow");

export const listHistory = defineRoute({
  method: "get",
  path: "/assistant/conversations",
  tags,
  summary: "The caller's Levi chats",
  description: 'Replaces `from("ai_conversations").select("id, title, updated_at").order("updated_at", desc).limit(50)`.',
  security: signedIn,
  responses: {
    200: dataResponse(z.array(z.object({ id: z.string(), title: z.string().nullable(), updated_at: z.string() })), "Most recent first."),
    ...errorResponses(401),
    ...commonErrors,
  },
});

export const startConversation = defineRoute({
  method: "post",
  path: "/assistant/conversations",
  tags,
  summary: "Start a Levi chat",
  description: 'Replaces `from("ai_conversations").insert({ user_id, title }).select("id").single()`.',
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { body: jsonBody(z.object({ title: z.string().max(200).nullable().optional() })) },
  responses: { 201: dataResponse(z.object({ id: z.string() }), "The new chat."), ...errorResponses(400, 401, 415, 429), ...commonErrors },
});

export const deleteConversations = defineRoute({
  method: "post",
  path: "/assistant/conversations/delete",
  tags,
  summary: "Delete Levi chats",
  description: 'Replaces `from("ai_conversations").delete().in("id", ids)` (and `.eq("id", id)`). Other people\'s chats are untouched.',
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { body: jsonBody(z.object({ ids: z.array(idParam).min(1).max(200) })) },
  responses: { 200: dataResponse(z.object({ deleted: z.number().int() }), "How many went."), ...errorResponses(400, 401, 415, 429), ...commonErrors },
});

export const conversationMessages = defineRoute({
  method: "get",
  path: "/assistant/conversations/{conversationId}/messages",
  tags,
  summary: "A Levi chat's messages",
  description: 'Replaces `from("ai_messages").select("id, role, content, reaction, created_at").eq("conversation_id", id).order("created_at")`.',
  security: signedIn,
  request: { params: AiConversationParams },
  responses: { 200: dataResponse(z.array(AiMessageRowSchema), "Oldest first."), ...errorResponses(400, 401), ...commonErrors },
});

export const addMessage = defineRoute({
  method: "post",
  path: "/assistant/conversations/{conversationId}/messages",
  tags,
  summary: "Save a message in a Levi chat",
  description: 'Replaces `from("ai_messages").insert({ conversation_id, role, content }).select("id").single()`. Only in one\'s own chats (403).',
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { params: AiConversationParams, body: jsonBody(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(20000) })) },
  responses: { 201: dataResponse(z.object({ id: z.string() }), "The new message."), ...errorResponses(400, 401, 403, 415, 429), ...commonErrors },
});

export const aiMessage = defineRoute({
  method: "get",
  path: "/assistant/messages/{messageId}",
  tags,
  summary: "Which chat a Levi message is in",
  description: 'Replaces `from("ai_messages").select("conversation_id,created_at").eq("id", id).maybeSingle()`.',
  security: signedIn,
  request: { params: z.object({ messageId: idParam }) },
  responses: { 200: dataResponse(z.object({ conversation_id: z.string(), created_at: z.string() }).nullable(), "Or null."), ...errorResponses(400, 401), ...commonErrors },
});
