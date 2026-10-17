import { defineRoute } from "../../shared/http/route.js";
import { z } from "../../shared/openapi/zod.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { UserParams, commonErrors, dataResponse, errorResponses } from "../../shared/openapi/schemas.js";
import { signedIn } from "../../shared/openapi/security.js";

/** Blocking people. Replaces the app's table queries on blocked_users (48-suggestion-box.js, 51-chat-snapshots...js). */

const tags = ["Blocks"];
const writeLimit = rateLimit({ name: "blocks-write", limit: 60, windowMs: 60_000 });

export const listBlocks = defineRoute({
  method: "get",
  path: "/blocks",
  tags,
  summary: "Whom the caller has blocked",
  description: 'Replaces `from("blocked_users").select("blocked_id").eq("blocker_id", me)`.',
  security: signedIn,
  responses: { 200: dataResponse(z.object({ blockedIds: z.array(z.string()) }), "Their ids."), ...errorResponses(401), ...commonErrors },
});

export const blockState = defineRoute({
  method: "get",
  path: "/blocks/{userId}",
  tags,
  summary: "Whether the caller has blocked this person",
  description: 'Replaces `from("blocked_users").select("blocked_id").eq("blocker_id", me).eq("blocked_id", userId).maybeSingle()`.',
  security: signedIn,
  request: { params: UserParams },
  responses: { 200: dataResponse(z.object({ blocked: z.boolean() }), "The state."), ...errorResponses(400, 401), ...commonErrors },
});

export const block = defineRoute({
  method: "put",
  path: "/blocks/{userId}",
  tags,
  summary: "Block someone",
  description: "Replaces the insert into blocked_users. Blocking oneself is refused (403); someone already blocked, 409.",
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { params: UserParams },
  responses: { 200: dataResponse(z.object({ blocked: z.literal(true) }), "Blocked."), ...errorResponses(400, 401, 403, 409, 429), ...commonErrors },
});

export const unblock = defineRoute({
  method: "delete",
  path: "/blocks/{userId}",
  tags,
  summary: "Unblock someone",
  description: "Replaces the delete from blocked_users.",
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { params: UserParams },
  responses: { 200: dataResponse(z.object({ blocked: z.literal(false), removed: z.number().int() }), "Unblocked."), ...errorResponses(400, 401, 429), ...commonErrors },
});
