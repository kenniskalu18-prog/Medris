import { defineRoute } from "../../shared/http/route.js";
import { z } from "../../shared/openapi/zod.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { commonErrors, dataResponse, errorResponses, idParam, jsonBody } from "../../shared/openapi/schemas.js";
import { optionalSignIn, signedIn } from "../../shared/openapi/security.js";

/** The home page's banners. Replaces the app's table queries on homepage_carousel_slides. */

const tags = ["Carousel"];
const writeLimit = rateLimit({ name: "carousel-write", limit: 60, windowMs: 60_000 });
const SlideParams = z.object({ slideId: idParam });
const SlideInput = z.object({
  storage_path: z.string().max(500).nullable(),
  image_url: z.string().min(1).max(1000),
  link_url: z.string().max(1000).nullable().optional(),
  alt_text: z.string().max(180).nullable().optional(),
  sort_order: z.number().int().min(0).optional(),
  is_active: z.boolean().optional(),
});

export const listSlides = defineRoute({
  method: "get",
  path: "/carousel/slides",
  tags,
  summary: "The home page's banners",
  description:
    'Replaces `select("id,storage_path,image_url,link_url,alt_text,sort_order,is_active,created_by,created_at,updated_at").order("sort_order").order("created_at")[.eq("is_active", true)]`. ' +
    "`includeInactive` shows hidden banners too (admins only; others still get the active ones).",
  security: optionalSignIn,
  request: { query: z.object({ includeInactive: z.enum(["true", "false"]).default("false").transform((v) => v === "true") }) },
  responses: { 200: dataResponse(z.array(z.record(z.string(), z.unknown())), "In display order."), ...errorResponses(400), ...commonErrors },
});

export const addSlides = defineRoute({
  method: "post",
  path: "/admin/carousel/slides",
  tags,
  summary: "Add banners (admins)",
  description: "Replaces the inserts into homepage_carousel_slides (one new banner, or the bundled ones). Not an admin: 403.",
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { body: jsonBody(z.object({ slides: z.array(SlideInput).min(1).max(50) })) },
  responses: { 201: dataResponse(z.object({ added: z.number().int() }), "Added."), ...errorResponses(400, 401, 403, 415, 429), ...commonErrors },
});

export const updateSlide = defineRoute({
  method: "patch",
  path: "/admin/carousel/slides/{slideId}",
  tags,
  summary: "Change a banner (admins)",
  description: "Replaces the updates of homepage_carousel_slides (text and link, order, visible or hidden, a new image). Anyone but an admin changes nothing.",
  security: signedIn,
  middleware: [writeLimit] as const,
  request: {
    params: SlideParams,
    body: jsonBody(
      z.object({
        alt_text: z.string().max(180).nullable().optional(),
        link_url: z.string().max(1000).nullable().optional(),
        sort_order: z.number().int().min(0).optional(),
        is_active: z.boolean().optional(),
        storage_path: z.string().max(500).optional(),
        image_url: z.string().min(1).max(1000).optional(),
      }),
    ),
  },
  responses: { 200: dataResponse(z.object({ updated: z.number().int() }), "How many changed."), ...errorResponses(400, 401, 415, 429), ...commonErrors },
});

export const reorderSlides = defineRoute({
  method: "put",
  path: "/admin/carousel/order",
  tags,
  summary: "Reorder the banners (admins)",
  description: "Replaces the app's one update per banner of sort_order, in one transaction.",
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { body: jsonBody(z.object({ order: z.array(z.object({ id: idParam, sort_order: z.number().int().min(0) })).min(1).max(100) })) },
  responses: { 200: dataResponse(z.object({ updated: z.number().int() }), "How many changed."), ...errorResponses(400, 401, 415, 429), ...commonErrors },
});

export const deleteSlide = defineRoute({
  method: "delete",
  path: "/admin/carousel/slides/{slideId}",
  tags,
  summary: "Delete a banner (admins)",
  description: "Replaces the select of storage_path and the delete. Returns the removed banner's stored file, for the app to delete.",
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { params: SlideParams },
  responses: { 200: dataResponse(z.object({ removed: z.boolean(), storage_path: z.string().nullable() }), "The result."), ...errorResponses(400, 401, 429), ...commonErrors },
});
