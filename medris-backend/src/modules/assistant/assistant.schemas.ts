import { z } from "../../shared/openapi/zod.js";
import { idParam } from "../../shared/openapi/schemas.js";

export const AiConversationHitSchema = z.object({ id: z.string(), title: z.string().nullable(), updated_at: z.string() }).openapi("AiConversationHit");
export const SharedAiMessageSchema = z
  .object({ title: z.string().nullable(), role: z.string(), content: z.string().nullable(), created_at: z.string() })
  .openapi("SharedAiMessage");

export const SearchQuery = z.object({ q: z.string().max(200).default("").openapi({ description: "Text to look for in titles and messages." }) });
export const ShareTokenParams = z.object({ token: idParam });
export const AiConversationParams = z.object({ conversationId: idParam });
export const AiMessageParams = z.object({ messageId: idParam });
export const SetSharedBody = z.object({ shared: z.boolean() }).openapi("SetAiConversationSharedRequest");
export const SetSharedResult = z.object({ shareToken: z.string().nullable() });
export const ReactionBody = z.object({ emoji: z.string().nullish() }).openapi("AiMessageReactionRequest");
export const ReactionResult = z.object({ reaction: z.string().nullable() });

export type AiConversationHit = z.infer<typeof AiConversationHitSchema>;
export type SharedAiMessage = z.infer<typeof SharedAiMessageSchema>;
