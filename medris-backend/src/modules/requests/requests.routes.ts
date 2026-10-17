import { defineRoute } from "../../shared/http/route.js";
import { z } from "../../shared/openapi/zod.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { commonErrors, dataResponse, errorResponses, idParam, jsonBody } from "../../shared/openapi/schemas.js";
import { optionalSignIn, signedIn } from "../../shared/openapi/security.js";

/** Buyers' requests and shops' offers. Replaces the app's table queries on equipment_requests and request_offers. */

const tags = ["Requests"];
const writeLimit = rateLimit({ name: "requests-write", limit: 30, windowMs: 60_000 });
const RequestParams = z.object({ requestId: idParam });
const Row = z.record(z.string(), z.unknown());
const isoDate = z.iso.date().openapi({ example: "2026-11-01" });

export const myRequests = defineRoute({
  method: "get",
  path: "/requests/mine",
  tags,
  summary: "The caller's requests, with the offers on them",
  description: 'Replaces `from("equipment_requests").select("*, offers:request_offers(id, vendor_id, message, price, status, created_at, vendor:vendors(...))").eq("buyer_id", me).order("created_at", desc)`.',
  security: signedIn,
  responses: { 200: dataResponse(z.array(Row), "Newest first."), ...errorResponses(401), ...commonErrors },
});

export const openRequests = defineRoute({
  method: "get",
  path: "/requests/open",
  tags,
  summary: "Open requests (for shops to answer)",
  description: 'Replaces `from("equipment_requests").select("*, offers:request_offers(id, vendor_id, status)").eq("status", "open").order("created_at", desc)`. Offers: only those the caller may see.',
  security: optionalSignIn,
  responses: { 200: dataResponse(z.array(Row), "Newest first."), ...commonErrors },
});

export const createRequest = defineRoute({
  method: "post",
  path: "/requests",
  tags,
  summary: "Post a request",
  description: "Replaces the insert into equipment_requests (the buyer's name and photo come from their profile).",
  security: signedIn,
  middleware: [writeLimit] as const,
  request: {
    body: jsonBody(
      z.object({
        title: z.string().min(1).max(200),
        description: z.string().max(2000).nullable().optional(),
        category_id: idParam.nullable().optional(),
        city: z.string().max(100).nullable().optional(),
        needed_from: isoDate.nullable().optional(),
        needed_to: isoDate.nullable().optional(),
        request_type: z.enum(["rent", "buy"]).default("rent"),
        photos: z.array(z.string().max(1000)).max(10).default([]),
        campus_id: z.string().max(200).nullable().optional(),
      }),
    ),
  },
  responses: { 201: dataResponse(z.object({ id: z.string() }), "The new request."), ...errorResponses(400, 401, 415, 429), ...commonErrors },
});

export const cancelRequest = defineRoute({
  method: "post",
  path: "/requests/{requestId}/cancel",
  tags,
  summary: "Cancel one's open request",
  description: 'Replaces `update({ status: "cancelled" }).eq("id", id).eq("buyer_id", me).eq("status", "open")`.',
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { params: RequestParams },
  responses: { 200: dataResponse(z.object({ cancelled: z.number().int() }), "How many changed."), ...errorResponses(400, 401, 429), ...commonErrors },
});

export const offer = defineRoute({
  method: "post",
  path: "/requests/{requestId}/offers",
  tags,
  summary: "A shop answers a request",
  description: "Replaces the insert into request_offers. Only the shop's owner, on an open request (403).",
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { params: RequestParams, body: jsonBody(z.object({ vendorId: idParam, message: z.string().max(2000).nullable().optional(), price: z.number().min(0).nullable().optional() })) },
  responses: { 201: dataResponse(z.object({ id: z.string() }), "The offer."), ...errorResponses(400, 401, 403, 415, 429), ...commonErrors },
});
