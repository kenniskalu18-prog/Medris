import { defineRoute } from "../../shared/http/route.js";
import { z } from "../../shared/openapi/zod.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { ConversationParams, DoneSchema, commonErrors, dataResponse, errorResponses } from "../../shared/openapi/schemas.js";
import { optionalSignIn, signedIn } from "../../shared/openapi/security.js";

/** "Online now" and "last seen". */

const tags = ["Presence"];
const presenceLimit = rateLimit({ name: "presence", limit: 120, windowMs: 60_000 });

export const touchPresence = defineRoute({
  method: "post",
  path: "/presence",
  tags,
  summary: "The app is open",
  description: "Replaces touch_presence().",
  security: signedIn,
  middleware: [presenceLimit] as const,
  responses: { 200: dataResponse(DoneSchema, "Done."), ...errorResponses(401, 429), ...commonErrors },
});

export const clearPresence = defineRoute({
  method: "delete",
  path: "/presence",
  tags,
  summary: "The app was closed",
  description: "Replaces clear_presence().",
  security: signedIn,
  middleware: [presenceLimit] as const,
  responses: { 200: dataResponse(DoneSchema, "Done."), ...errorResponses(401, 429), ...commonErrors },
});

export const touchLastSeen = defineRoute({
  method: "post",
  path: "/presence/last-seen",
  tags,
  summary: "Record that the caller was just seen",
  description: "Replaces touch_last_seen(). Signed out, nothing happens.",
  security: optionalSignIn,
  middleware: [presenceLimit] as const,
  responses: { 200: dataResponse(DoneSchema, "Done."), ...errorResponses(429), ...commonErrors },
});

export const conversationPresence = defineRoute({
  method: "get",
  path: "/conversations/{conversationId}/presence",
  tags,
  summary: "When the other person was last active",
  description: "Replaces get_conversation_presence(): latest of last seen, last message and last sign-in.",
  security: optionalSignIn,
  request: { params: ConversationParams },
  responses: { 200: dataResponse(z.object({ last_seen_at: z.string().nullable() }), "Time, or null."), ...errorResponses(400), ...commonErrors },
});
