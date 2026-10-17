import { defineRoute } from "../../shared/http/route.js";
import { z } from "../../shared/openapi/zod.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { DoneSchema, OrderParams, commonErrors, dataResponse, errorResponses, idParam, jsonBody } from "../../shared/openapi/schemas.js";
import { signedIn } from "../../shared/openapi/security.js";

/** Direct (bank transfer) payments between buyer and vendor, and disputes. */

const tags = ["Payment claims"];
const writeLimit = rateLimit({ name: "payment-claims-write", limit: 30, windowMs: 60_000 });
const write = { tags, security: signedIn, middleware: [writeLimit] as const };
const Result = z.looseObject({}).openapi("PaymentClaimResult", { description: "As the database function returned it." });
const errors = { ...errorResponses(400, 403, 404, 415, 429), ...commonErrors };
const DisputeParams = z.object({ disputeId: idParam });
const Reason = z.object({ reason: z.string().max(4000).nullish() }).openapi("ReasonRequest");
const Notes = z.object({ notes: z.string().max(4000).nullish() }).openapi("AdminNotesRequest");

export const report = defineRoute({
  method: "post",
  path: "/orders/{orderId}/payment-report",
  ...write,
  summary: "The buyer reports paying the vendor",
  description: "Replaces buyer_report_manual_payment(): the amount must match what is outstanding.",
  request: { params: OrderParams, body: jsonBody(z.object({ amount: z.number().nullish() }).openapi("PaymentReportRequest")) },
  responses: { 200: dataResponse(Result, "Reported."), ...errors },
});

export const vendorConfirm = defineRoute({
  method: "post",
  path: "/orders/{orderId}/payment-report/confirm",
  ...write,
  summary: "The vendor confirms the reported payment",
  description: "Replaces vendor_confirm_reported_payment().",
  request: { params: OrderParams },
  responses: { 200: dataResponse(Result, "Confirmed."), ...errors },
});

export const vendorDispute = defineRoute({
  method: "post",
  path: "/orders/{orderId}/payment-report/dispute",
  ...write,
  summary: "The vendor disputes the reported payment",
  description: "Replaces vendor_dispute_reported_payment().",
  request: { params: OrderParams, body: jsonBody(Reason) },
  responses: { 200: dataResponse(Result, "Disputed."), ...errors },
});

export const vendorConfirmUnreported = defineRoute({
  method: "post",
  path: "/orders/{orderId}/direct-payment/confirm",
  ...write,
  summary: "The vendor records money the buyer paid without reporting it",
  description: "Replaces vendor_confirm_unreported_payment(): at the payment follow-up stage.",
  request: { params: OrderParams },
  responses: { 200: dataResponse(Result, "Recorded."), ...errors },
});

export const vendorDisputeUnreported = defineRoute({
  method: "post",
  path: "/orders/{orderId}/direct-payment/dispute",
  ...write,
  summary: "The vendor says the buyer did not pay",
  description: "Replaces vendor_dispute_unreported_payment().",
  request: { params: OrderParams, body: jsonBody(Reason) },
  responses: { 200: dataResponse(Result, "Disputed."), ...errors },
});

export const adminConfirm = defineRoute({
  method: "post",
  path: "/admin/orders/{orderId}/payment-report/confirm",
  ...write,
  summary: "Levromart verifies a payment claim (admins)",
  description: "Replaces admin_confirm_reported_payment().",
  request: { params: OrderParams, body: jsonBody(Notes) },
  responses: { 200: dataResponse(Result, "Verified."), ...errors },
});

export const adminReject = defineRoute({
  method: "post",
  path: "/admin/orders/{orderId}/payment-report/reject",
  ...write,
  summary: "Levromart rejects a payment claim (admins)",
  description: "Replaces admin_reject_reported_payment(): the order is cancelled.",
  request: { params: OrderParams, body: jsonBody(Notes) },
  responses: { 200: dataResponse(Result, "Rejected."), ...errors },
});

export const recordOffline = defineRoute({
  method: "post",
  path: "/orders/{orderId}/offline-payments",
  ...write,
  summary: "The vendor confirms the amount the buyer reported",
  description: "Replaces record_offline_payment().",
  request: {
    params: OrderParams,
    body: jsonBody(z.object({ paymentType: z.string().max(40), amount: z.number().nullish(), method: z.string().max(40) }).openapi("OfflinePaymentRequest")),
  },
  responses: { 200: dataResponse(z.object({ id: z.string() }), "The payment."), ...errors },
});

export const raise = defineRoute({
  method: "post",
  path: "/orders/{orderId}/disputes",
  ...write,
  summary: "Report a problem with an order",
  description: "Replaces raise_dispute(): the buyer or the vendor; up to 3 photos they uploaded for the order ({ path, name, type }).",
  request: { params: OrderParams, body: jsonBody(z.object({ reason: z.string().max(4000).nullish(), attachments: z.unknown().optional() }).openapi("RaiseDisputeRequest")) },
  responses: { 201: dataResponse(z.object({ id: z.string() }), "The dispute."), ...errors },
});

export const resolve = defineRoute({
  method: "post",
  path: "/admin/disputes/{disputeId}/resolve",
  ...write,
  summary: "Close a dispute (admins)",
  description: "Replaces resolve_dispute(): optionally setting the order's status.",
  request: { params: DisputeParams, body: jsonBody(z.object({ notes: z.string().max(4000).nullish(), orderStatus: z.string().max(40).nullish() }).openapi("ResolveDisputeRequest")) },
  responses: { 200: dataResponse(DoneSchema, "Resolved."), ...errors },
});

export const respond = defineRoute({
  method: "post",
  path: "/disputes/{disputeId}/vendor-response",
  ...write,
  summary: "The vendor's side of a dispute",
  description: "Replaces vendor_respond_to_dispute().",
  request: { params: DisputeParams, body: jsonBody(z.object({ response: z.string().max(4000).nullish() }).openapi("DisputeResponseRequest")) },
  responses: { 200: dataResponse(DoneSchema, "Saved."), ...errors },
});

export const cancelOverdue = defineRoute({
  method: "post",
  path: "/admin/orders/{orderId}/cancel-overdue",
  ...write,
  summary: "Cancel an order whose payment was never verified (admins)",
  description: "Replaces admin_cancel_confirmed_overdue_order().",
  request: { params: OrderParams },
  responses: { 200: dataResponse(Result, "Cancelled."), ...errors },
});
