import { defineRoute } from "../../shared/http/route.js";
import { z } from "../../shared/openapi/zod.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { commonErrors, dataResponse, errorResponses, idParam, jsonBody } from "../../shared/openapi/schemas.js";
import { signedIn } from "../../shared/openapi/security.js";

/** Support requests. Replaces the app's table queries on support_requests. */

const tags = ["Support"];
const writeLimit = rateLimit({ name: "support-write", limit: 20, windowMs: 60_000 });
const RequestParams = z.object({ requestId: idParam });
const Row = z.record(z.string(), z.unknown());

export const myRequests = defineRoute({
  method: "get",
  path: "/support-requests",
  tags,
  summary: "The caller's support requests",
  description: 'Replaces `select("id,subject,message,status,admin_reply,attachments,created_at,updated_at").eq("user_id", me).order("created_at", desc)`.',
  security: signedIn,
  responses: { 200: dataResponse(z.array(Row), "Newest first."), ...errorResponses(401), ...commonErrors },
});

export const createRequest = defineRoute({
  method: "post",
  path: "/support-requests",
  tags,
  summary: "Ask for help",
  description: 'Replaces `insert({ user_id, subject, message, attachments: [] }).select("id").single()`.',
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { body: jsonBody(z.object({ subject: z.string().min(1).max(140), message: z.string().min(1).max(4000) })) },
  responses: { 201: dataResponse(z.object({ id: z.string() }), "The new request."), ...errorResponses(400, 401, 415, 429), ...commonErrors },
});

export const setAttachments = defineRoute({
  method: "put",
  path: "/support-requests/{requestId}/attachments",
  tags,
  summary: "Link the uploaded files to one's request",
  description: "Replaces `update({ attachments }).eq(\"id\", id).eq(\"user_id\", me)`, which never saved anything (BASELINE_FINDINGS B13). Paths must be `<user id>/<request id>/...`.",
  security: signedIn,
  middleware: [writeLimit] as const,
  request: {
    params: RequestParams,
    body: jsonBody(
      z.object({
        attachments: z.array(z.object({ path: z.string().min(1).max(500), name: z.string().max(300), type: z.string().max(100), size: z.number().int().min(0) })).max(10),
      }),
    ),
  },
  responses: { 200: dataResponse(z.object({ saved: z.literal(true) }), "Saved."), ...errorResponses(400, 401, 404, 415, 429), ...commonErrors },
});

export const deleteRequest = defineRoute({
  method: "delete",
  path: "/support-requests/{requestId}",
  tags,
  summary: "Delete one's request",
  description: 'Replaces `delete().eq("id", id).eq("user_id", me)` - the table does not allow it, so nothing is removed, as before.',
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { params: RequestParams },
  responses: { 200: dataResponse(z.object({ removed: z.number().int() }), "How many went."), ...errorResponses(400, 401, 429), ...commonErrors },
});

export const allRequests = defineRoute({
  method: "get",
  path: "/admin/support-requests",
  tags,
  summary: "Every support request (admins)",
  description: 'Replaces `select("id,user_id,subject,message,status,admin_reply,attachments,created_at,updated_at").order("created_at", desc)`. Others see only their own.',
  security: signedIn,
  responses: { 200: dataResponse(z.array(Row), "Newest first."), ...errorResponses(401), ...commonErrors },
});

export const answerRequest = defineRoute({
  method: "patch",
  path: "/admin/support-requests/{requestId}",
  tags,
  summary: "Answer a support request (admins)",
  description: 'Replaces `update({ status, admin_reply }).eq("id", id)`. Anyone but an admin changes nothing.',
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { params: RequestParams, body: jsonBody(z.object({ status: z.enum(["open", "in_progress", "resolved", "closed"]), admin_reply: z.string().max(4000).nullable() })) },
  responses: { 200: dataResponse(z.object({ updated: z.number().int() }), "How many changed."), ...errorResponses(400, 401, 415, 429), ...commonErrors },
});
