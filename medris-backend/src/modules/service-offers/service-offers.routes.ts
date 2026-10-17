import { defineRoute } from "../../shared/http/route.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { commonErrors, dataResponse, errorResponses, idParam, jsonBody, OrderParams } from "../../shared/openapi/schemas.js";
import { signedIn } from "../../shared/openapi/security.js";
import { CreateOfferBody, OfferIdSchema, OfferParams, OfferResultSchema, ReportPaymentBody, RespondBody } from "./service-offers.schemas.js";
import { z } from "../../shared/openapi/zod.js";

/** Negotiated service bookings. */

const tags = ["Service offers"];
const writeLimit = rateLimit({ name: "service-offers-write", limit: 30, windowMs: 60_000 });
const write = { tags, security: signedIn, middleware: [writeLimit] as const };

export const createOffer = defineRoute({
  method: "post",
  path: "/service-offers",
  ...write,
  summary: "Propose a price for a service",
  description: "Replaces create_service_offer(): commission-billed services of verified shops; the shop is told.",
  request: { body: jsonBody(CreateOfferBody) },
  responses: { 201: dataResponse(OfferIdSchema, "The offer."), ...errorResponses(400, 403, 415, 429), ...commonErrors },
});

export const respondOffer = defineRoute({
  method: "post",
  path: "/service-offers/{offerId}/response",
  ...write,
  summary: "Accept, decline or counter",
  description: "Replaces respond_service_offer(): only the side whose turn it is; accepting creates the order.",
  request: { params: OfferParams, body: jsonBody(RespondBody) },
  responses: { 200: dataResponse(OfferResultSchema, "The new state."), ...errorResponses(400, 403, 404, 409, 415, 429), ...commonErrors },
});

export const reportPayment = defineRoute({
  method: "post",
  path: "/orders/{orderId}/service-payment",
  ...write,
  summary: "The buyer reports paying for a service",
  description: "Replaces report_service_offer_payment(): the amount must be the agreed price.",
  request: { params: OrderParams, body: jsonBody(ReportPaymentBody) },
  responses: { 200: dataResponse(OfferResultSchema, "Reported."), ...errorResponses(400, 403, 415, 429), ...commonErrors },
});

export const confirmPayment = defineRoute({
  method: "post",
  path: "/service-offers/{offerId}/payment/confirm",
  ...write,
  summary: "The vendor confirms the payment",
  description: "Replaces confirm_service_offer_payment(): completes the order and the booking.",
  request: { params: OfferParams },
  responses: { 200: dataResponse(OfferResultSchema, "Completed."), ...errorResponses(400, 403, 404, 429), ...commonErrors },
});

export const disputePayment = defineRoute({
  method: "post",
  path: "/service-offers/{offerId}/payment/dispute",
  ...write,
  summary: "The vendor disputes the payment",
  description: "Replaces dispute_service_offer_payment(): opens a dispute for Levromart.",
  request: { params: OfferParams },
  responses: { 200: dataResponse(OfferResultSchema, "Disputed."), ...errorResponses(400, 403, 404, 429), ...commonErrors },
});

export const offersForListing = defineRoute({
  method: "get",
  path: "/service-offers",
  tags,
  summary: "The caller's negotiations on a listing",
  description: 'Replaces `from("service_offers").select(...).eq("listing_id", id).order("updated_at", desc).limit(20)`.',
  security: signedIn,
  request: { query: z.object({ listingId: idParam }) },
  responses: { 200: dataResponse(z.array(z.record(z.string(), z.unknown())), "Newest first."), ...errorResponses(400, 401), ...commonErrors },
});

export const getOffer = defineRoute({
  method: "get",
  path: "/service-offers/{offerId}",
  tags,
  summary: "One negotiation",
  description: 'Replaces `from("service_offers").select(...).eq("id", id).maybeSingle()`. Null when the caller is not part of it.',
  security: signedIn,
  request: { params: z.object({ offerId: idParam }) },
  responses: { 200: dataResponse(z.record(z.string(), z.unknown()).nullable(), "The negotiation."), ...errorResponses(400, 401), ...commonErrors },
});
