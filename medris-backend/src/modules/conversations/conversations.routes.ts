import { defineRoute } from "../../shared/http/route.js";
import { z } from "../../shared/openapi/zod.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { commonErrors, ConversationParams, dataResponse, DoneSchema, errorResponses, idList, idParam, isoDateTime, jsonBody } from "../../shared/openapi/schemas.js";
import { optionalSignIn, signedIn } from "../../shared/openapi/security.js";
import {
  AdminConversationSchema,
  AdminFindQuery,
  AdminFoundSchema,
  AdminListQuery,
  ChatListSchema,
  ConversationIdSchema,
  ConversationListItemSchema,
  CreateChatListBody,
  EditMessageBody,
  ListConversationParams,
  ListParams,
  MessageParams,
  OpenConversationBody,
  OtherPartySchema,
  ParticipantsSchema,
  ReactionBody,
  ReactionsSchema,
} from "./conversations.schemas.js";

/** Buyer-shop chat. */

const tags = ["Conversations"];
const writeLimit = rateLimit({ name: "conversations-write", limit: 120, windowMs: 60_000 });
const write = (summary: string, description: string) => ({ tags, summary, description, security: signedIn, middleware: [writeLimit] as const });

export const openConversation = defineRoute({
  method: "post",
  path: "/conversations",
  ...write("Open the chat with a shop", "Replaces get_or_create_conversation(): the buyer's conversation, created on first use; only with an accepted order."),
  request: { body: jsonBody(OpenConversationBody) },
  responses: { 200: dataResponse(ConversationIdSchema, "The conversation."), ...errorResponses(400, 401, 403, 415, 429), ...commonErrors },
});

export const listConversations = defineRoute({
  method: "get",
  path: "/conversations",
  tags,
  summary: "The caller's inbox",
  description: "Replaces list_my_conversations(): open conversations, pinned first, then by latest message.",
  security: optionalSignIn,
  responses: { 200: dataResponse(z.array(ConversationListItemSchema), "Conversations."), ...commonErrors },
});

export const conversationIsOpen = defineRoute({
  method: "get",
  path: "/conversations/{conversationId}/open",
  tags,
  summary: "Can the caller still write here?",
  description: "Replaces conversation_is_open().",
  security: optionalSignIn,
  request: { params: ConversationParams },
  responses: { 200: dataResponse(z.object({ open: z.boolean() }), "Whether it is open."), ...errorResponses(400), ...commonErrors },
});

export const markConversationOpened = defineRoute({
  method: "post",
  path: "/conversations/{conversationId}/opened",
  ...write("Mark a conversation as read", "Replaces mark_conversation_opened()."),
  request: { params: ConversationParams },
  responses: { 200: dataResponse(DoneSchema, "Done."), ...errorResponses(400, 404, 429), ...commonErrors },
});

export const conversationOtherParty = defineRoute({
  method: "get",
  path: "/conversations/{conversationId}/other-party",
  tags,
  summary: "Who the caller is talking to",
  description: "Replaces get_conversation_other_party(): name, picture and phone.",
  security: optionalSignIn,
  request: { params: ConversationParams },
  responses: { 200: dataResponse(z.array(OtherPartySchema), "Zero or one row."), ...errorResponses(400), ...commonErrors },
});

export const togglePin = defineRoute({
  method: "post",
  path: "/conversations/{conversationId}/pin",
  ...write("Pin or unpin a conversation", "Replaces toggle_conversation_pin(): returns the new value."),
  request: { params: ConversationParams },
  responses: { 200: dataResponse(z.object({ pinned: z.boolean().nullable() }), "New value."), ...errorResponses(400, 403, 429), ...commonErrors },
});

export const toggleUnread = defineRoute({
  method: "post",
  path: "/conversations/{conversationId}/unread",
  ...write("Mark a conversation unread, or not", "Replaces toggle_conversation_unread(): returns the new value."),
  request: { params: ConversationParams },
  responses: { 200: dataResponse(z.object({ unread: z.boolean().nullable() }), "New value."), ...errorResponses(400, 404, 429), ...commonErrors },
});

export const deleteMessage = defineRoute({
  method: "delete",
  path: "/messages/{messageId}",
  ...write("Delete one's own message", "Replaces delete_message(): within 30 minutes of sending."),
  request: { params: MessageParams },
  responses: { 200: dataResponse(DoneSchema, "Deleted."), ...errorResponses(400, 403, 404, 429), ...commonErrors },
});

export const editMessage = defineRoute({
  method: "patch",
  path: "/messages/{messageId}",
  ...write("Edit one's own message", "Replaces edit_message(): within 30 minutes of sending."),
  request: { params: MessageParams, body: jsonBody(EditMessageBody) },
  responses: { 200: dataResponse(DoneSchema, "Edited."), ...errorResponses(400, 403, 404, 415, 429), ...commonErrors },
});

export const toggleReaction = defineRoute({
  method: "post",
  path: "/messages/{messageId}/reaction",
  ...write("React to a message", "Replaces toggle_message_reaction(): the same emoji again removes it. Returns every reaction."),
  request: { params: MessageParams, body: jsonBody(ReactionBody) },
  responses: { 200: dataResponse(ReactionsSchema, "Reactions."), ...errorResponses(400, 401, 403, 404, 415, 429), ...commonErrors },
});

export const listChatLists = defineRoute({
  method: "get",
  path: "/chat-lists",
  tags,
  summary: "The caller's chat lists",
  description: "Replaces list_my_chat_lists().",
  security: optionalSignIn,
  responses: { 200: dataResponse(z.array(ChatListSchema), "Lists."), ...commonErrors },
});

export const createChatList = defineRoute({
  method: "post",
  path: "/chat-lists",
  ...write("Create a chat list", "Replaces create_chat_list()."),
  request: { body: jsonBody(CreateChatListBody) },
  responses: { 201: dataResponse(ConversationIdSchema, "Created."), ...errorResponses(400, 401, 415, 429), ...commonErrors },
});

export const deleteChatList = defineRoute({
  method: "delete",
  path: "/chat-lists/{listId}",
  ...write("Delete a chat list", "Replaces delete_chat_list(): only the caller's own."),
  request: { params: ListParams },
  responses: { 200: dataResponse(DoneSchema, "Done."), ...errorResponses(400, 429), ...commonErrors },
});

export const toggleInList = defineRoute({
  method: "post",
  path: "/chat-lists/{listId}/conversations/{conversationId}",
  ...write("Add a conversation to a list, or remove it", "Replaces toggle_conversation_in_list(): true when it is now in the list."),
  request: { params: ListConversationParams },
  responses: { 200: dataResponse(z.object({ inList: z.boolean() }), "New state."), ...errorResponses(400, 404, 429), ...commonErrors },
});

export const adminFindConversation = defineRoute({
  method: "get",
  path: "/admin/conversations/find",
  tags,
  summary: "A buyer's conversation with a shop (admins)",
  description: "Replaces admin_find_conversation(): null for anyone else.",
  security: signedIn,
  request: { query: AdminFindQuery },
  responses: { 200: dataResponse(AdminFoundSchema, "The id, or null."), ...errorResponses(400), ...commonErrors },
});

export const adminListConversations = defineRoute({
  method: "get",
  path: "/admin/conversations",
  tags,
  summary: "Every conversation (admins)",
  description: "Replaces admin_list_conversations(): latest activity first, searchable by buyer or shop name. Empty for anyone else.",
  security: signedIn,
  request: { query: AdminListQuery },
  responses: { 200: dataResponse(z.array(AdminConversationSchema), "Conversations."), ...errorResponses(400), ...commonErrors },
});

export const adminConversationParticipants = defineRoute({
  method: "get",
  path: "/admin/conversations/{conversationId}/participants",
  tags,
  summary: "The two sides of a conversation (admins)",
  description: "Replaces admin_get_conversation_participants(): empty for anyone else.",
  security: signedIn,
  request: { params: ConversationParams },
  responses: { 200: dataResponse(z.array(ParticipantsSchema), "Zero or one row."), ...errorResponses(400), ...commonErrors },
});

const MessagePinSchema = z
  .object({ id: z.string(), conversation_id: z.string(), message_id: z.string(), pinned_at: z.string(), expires_at: z.string().nullable() })
  .openapi("MessagePin");
const PinParams = z.object({ conversationId: idParam, messageId: idParam });

export const listMessagePins = defineRoute({
  method: "get",
  path: "/conversations/{conversationId}/message-pins",
  tags,
  summary: "The caller's pinned messages in a conversation",
  description: 'Replaces `from("message_pins").select("id,conversation_id,message_id,pinned_at,expires_at").eq(conversation).eq(user).order("pinned_at", desc).limit(4)`.',
  security: signedIn,
  request: { params: ConversationParams },
  responses: { 200: dataResponse(z.array(MessagePinSchema), "Newest first, up to 4."), ...errorResponses(400, 401), ...commonErrors },
});

export const pinMessage = defineRoute({
  method: "put",
  path: "/conversations/{conversationId}/message-pins/{messageId}",
  ...write("Pin a message", "Replaces the insert into message_pins. At most 4 per chat (the database's message); only messages of the caller's own conversations."),
  request: { params: PinParams },
  responses: { 200: dataResponse(z.object({ pinned: z.literal(true) }), "Pinned."), ...errorResponses(400, 401, 403, 409, 429), ...commonErrors },
});

export const unpinMessage = defineRoute({
  method: "delete",
  path: "/conversations/{conversationId}/message-pins/{messageId}",
  ...write("Unpin a message", "Replaces the delete from message_pins."),
  request: { params: PinParams },
  responses: { 200: dataResponse(z.object({ pinned: z.literal(false), removed: z.number().int() }), "Unpinned."), ...errorResponses(400, 401, 429), ...commonErrors },
});

const MessageRowSchema = z.record(z.string(), z.unknown()).openapi("MessageRow", { description: "A messages row, every column." });
const ReplyPreviewSchema = z
  .object({ id: z.string(), sender_id: z.string(), body: z.string(), attachment_name: z.string().nullable(), deleted_at: z.string().nullable() })
  .openapi("ReplyPreview");
const VendorEmbedSchema = z
  .object({
    id: z.string(),
    business_name: z.string().nullable(),
    logo_url: z.string().nullable(),
    user_id: z.string().nullable(),
    phone: z.string().nullable(),
    whatsapp_number: z.string().nullable(),
    whatsapp_visible: z.boolean().nullable(),
  })
  .nullable();

export const getConversation = defineRoute({
  method: "get",
  path: "/conversations/{conversationId}",
  tags,
  summary: "A conversation and its shop",
  description:
    'Replaces `from("conversations").select("id, buyer_id, vendor:vendors(id, business_name, logo_url, user_id, phone, whatsapp_number, whatsapp_visible)").eq("id", id).maybeSingle()` ' +
    'and `select("buyer_id, vendor_id")`. Null when the caller may not see it.',
  security: signedIn,
  request: { params: ConversationParams },
  responses: {
    200: dataResponse(z.object({ id: z.string(), buyer_id: z.string(), vendor_id: z.string(), vendor: VendorEmbedSchema }).nullable(), "The conversation, or null."),
    ...errorResponses(400, 401),
    ...commonErrors,
  },
});

export const directConversation = defineRoute({
  method: "post",
  path: "/conversations/direct",
  ...write(
    "The chat between a buyer and a shop, created on first use",
    "Replaces the order screens' select on conversations followed by an insert. Either side may start it; admins may not (403).",
  ),
  request: { body: jsonBody(z.object({ buyerId: idParam, vendorId: idParam })) },
  responses: { 200: dataResponse(z.object({ id: z.string(), created: z.boolean() }), "The conversation."), ...errorResponses(400, 401, 403, 409, 415, 429), ...commonErrors },
});

export const listMessages = defineRoute({
  method: "get",
  path: "/conversations/{conversationId}/messages",
  tags,
  summary: "A conversation's messages",
  description:
    'Replaces `from("messages").select("*").eq("conversation_id", id)[.gt("created_at", after)].order("created_at", …).limit(n)`. ' +
    "Newest first by default; up to 1000 (Supabase's row limit).",
  security: signedIn,
  request: {
    params: ConversationParams,
    query: z.object({
      order: z.enum(["asc", "desc"]).default("desc"),
      limit: z.coerce.number().int().min(1).max(1000).default(1000),
      after: isoDateTime.optional(),
    }),
  },
  responses: { 200: dataResponse(z.array(MessageRowSchema), "The messages."), ...errorResponses(400, 401), ...commonErrors },
});

export const messagePreviews = defineRoute({
  method: "get",
  path: "/messages",
  tags,
  summary: "Messages that replies quote",
  description: 'Replaces `from("messages").select("id,sender_id,body,attachment_name,deleted_at").in("id", ids)` (and `.eq("id", id).maybeSingle()`).',
  security: signedIn,
  request: { query: z.object({ ids: idList("Message ids.", 200) }) },
  responses: { 200: dataResponse(z.array(ReplyPreviewSchema), "The messages the caller may see."), ...errorResponses(400, 401), ...commonErrors },
});

export const sendMessage = defineRoute({
  method: "post",
  path: "/conversations/{conversationId}/messages",
  ...write(
    "Send a message",
    'Replaces `from("messages").insert({ conversation_id, sender_id, body, reply_to_id, attachment_* }).select("*").single()`. ' +
      "Refused (403) outside one's own chats and when either side has blocked the other.",
  ),
  request: {
    params: ConversationParams,
    body: jsonBody(
      z.object({
        body: z.string().max(2000).default(""),
        replyToId: idParam.nullable().optional(),
        attachment: z
          .object({ url: z.string().min(1).max(1000), name: z.string().max(300).nullable().optional(), type: z.string().max(100).nullable().optional(), size: z.number().int().min(0).nullable().optional() })
          .nullable()
          .optional(),
      }),
    ),
  },
  responses: { 201: dataResponse(MessageRowSchema, "The new message."), ...errorResponses(400, 401, 403, 415, 429), ...commonErrors },
});

export const markMessagesRead = defineRoute({
  method: "post",
  path: "/messages/read",
  ...write("Mark messages read", 'Replaces `from("messages").update({ read_at, delivered_at }).in("id", ids)` (and `.eq("id", id)`); only those two times change.'),
  request: { body: jsonBody(z.object({ ids: z.array(idParam).min(1).max(500) })) },
  responses: { 200: dataResponse(z.object({ updated: z.number().int() }), "How many changed."), ...errorResponses(400, 401, 415, 429), ...commonErrors },
});

export const markMessagesDelivered = defineRoute({
  method: "post",
  path: "/messages/delivered",
  ...write("Mark every message to the caller delivered", 'Replaces `from("messages").update({ delivered_at }).is("delivered_at", null).neq("sender_id", me)`.'),
  responses: { 200: dataResponse(z.object({ updated: z.number().int() }), "How many changed."), ...errorResponses(401, 429), ...commonErrors },
});
