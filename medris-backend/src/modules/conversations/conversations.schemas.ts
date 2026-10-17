import { z } from "../../shared/openapi/zod.js";
import { idParam } from "../../shared/openapi/schemas.js";

/** Request and response shapes of the chat endpoints (rows exactly as the database functions returned them). */

export const OpenConversationBody = z.object({ vendorId: idParam }).openapi("OpenConversationRequest");
export const ConversationIdSchema = z.object({ id: z.string() }).openapi("ConversationId");

export const ConversationListItemSchema = z
  .object({
    conversation_id: z.string(),
    other_id: z.string().nullable(),
    other_name: z.string().nullable(),
    other_avatar: z.string().nullable(),
    last_message: z.string().nullable(),
    last_message_at: z.string().nullable(),
    unread_count: z.number().int(),
    pinned: z.boolean(),
  })
  .openapi("ConversationListItem");

export const OtherPartySchema = z
  .object({ id: z.string(), name: z.string().nullable(), avatar_url: z.string().nullable(), phone: z.string().nullable() })
  .openapi("ConversationOtherParty");

export const MessageParams = z.object({ messageId: idParam });
export const ListParams = z.object({ listId: idParam });
export const ListConversationParams = z.object({ listId: idParam, conversationId: idParam });

export const EditMessageBody = z.object({ body: z.string().max(2000).nullish() }).openapi("EditMessageRequest");
export const ReactionBody = z.object({ emoji: z.string().max(64).nullish() }).openapi("MessageReactionRequest");
export const ReactionsSchema = z.record(z.string(), z.string()).nullable().openapi("MessageReactions", { description: "user id -> emoji" });

export const ChatListSchema = z.object({ id: z.string(), name: z.string(), conversation_ids: z.array(z.string()) }).openapi("ChatList");
export const CreateChatListBody = z.object({ name: z.string().max(200).nullish() }).openapi("CreateChatListRequest");

export const AdminFindQuery = z.object({ buyerId: idParam, vendorId: idParam });
export const AdminFoundSchema = z.object({ id: z.string().nullable() }).openapi("AdminFoundConversation");
export const AdminListQuery = z.object({
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().optional().openapi({ description: "1 to 300; 100 by default." }),
});
export const ParticipantsSchema = z
  .object({
    buyer_id: z.string(),
    buyer_name: z.string().nullable(),
    buyer_avatar: z.string().nullable(),
    vendor_id: z.string(),
    vendor_name: z.string().nullable(),
    vendor_avatar: z.string().nullable(),
  })
  .openapi("ConversationParticipants");
export const AdminConversationSchema = z
  .object({
    conversation_id: z.string(),
    buyer_id: z.string(),
    buyer_name: z.string().nullable(),
    vendor_id: z.string(),
    vendor_name: z.string().nullable(),
    last_body: z.string().nullable(),
    last_at: z.string().nullable(),
    message_count: z.number(),
  })
  .openapi("AdminConversation");
