import { defineRoute } from "../../shared/http/route.js";
import { z } from "../../shared/openapi/zod.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { VendorIdParams, commonErrors, dataResponse, errorResponses, idParam, jsonBody } from "../../shared/openapi/schemas.js";
import { signedIn } from "../../shared/openapi/security.js";

/** Commission owed to Levromart and ₦1,000 monthly listings. */

const tags = ["Commission & billing"];
const writeLimit = rateLimit({ name: "commission-write", limit: 30, windowMs: 60_000 });
const write = { tags, security: signedIn, middleware: [writeLimit] as const };
const Loose = z.looseObject({}).openapi("CommissionResult", { description: "As the database function returned it." });
const errors = { ...errorResponses(400, 403, 404, 415, 429), ...commonErrors };
const SubmissionParams = z.object({ submissionId: idParam });
const Note = z.object({ note: z.string().max(2000).nullish() }).openapi("MonthlyListingNote");

export const owed = defineRoute({
  method: "get",
  path: "/vendors/{vendorId}/commission/owed",
  tags,
  security: signedIn,
  summary: "Commission owed",
  description: "Replaces get_vendor_commission_owed(): the owner or an admin.",
  request: { params: VendorIdParams },
  responses: { 200: dataResponse(z.object({ owed: z.number() }), "Amount."), ...errorResponses(400, 403), ...commonErrors },
});

export const deadline = defineRoute({
  method: "get",
  path: "/vendors/{vendorId}/commission/deadline",
  tags,
  security: signedIn,
  summary: "Total owed and when the earliest is due",
  description: "Replaces get_vendor_commission_deadline().",
  request: { params: VendorIdParams },
  responses: { 200: dataResponse(z.array(z.object({ total_owed: z.number(), earliest_due_at: z.string().nullable() })), "One row."), ...errorResponses(400), ...commonErrors },
});

export const breakdown = defineRoute({
  method: "get",
  path: "/vendors/{vendorId}/commission/breakdown",
  tags,
  security: signedIn,
  summary: "Each owed charge with its sale",
  description: "Replaces get_vendor_commission_breakdown().",
  request: { params: VendorIdParams },
  responses: { 200: dataResponse(z.array(Loose), "Charges."), ...errorResponses(400, 403), ...commonErrors },
});

export const enforce = defineRoute({
  method: "post",
  path: "/vendors/{vendorId}/commission/enforce",
  ...write,
  summary: "Apply the commission deadline to a shop",
  description: "Replaces enforce_commission_deadlines(): pauses an overdue storefront, reopens a paid one.",
  request: { params: VendorIdParams },
  responses: { 200: dataResponse(z.object({ changed: z.number().int() }), "Shops changed."), ...errors },
});

export const hourReminders = defineRoute({
  method: "post",
  path: "/vendors/{vendorId}/commission/hour-reminders",
  ...write,
  summary: "Last-day commission reminders",
  description: "Replaces process_vendor_commission_hour_reminders().",
  request: { params: VendorIdParams },
  responses: { 200: dataResponse(z.object({ notifications_created: z.number().int() }), "Sent."), ...errors },
});

export const monthlyBillingAmount = defineRoute({
  method: "get",
  path: "/vendors/{vendorId}/monthly-billing/amount",
  tags,
  security: signedIn,
  summary: "Combined monthly billing amount",
  description: "Replaces compute_monthly_billing_amount().",
  request: { params: VendorIdParams },
  responses: { 200: dataResponse(z.array(z.object({ listing_count: z.number().int(), amount: z.number() })), "One row."), ...errorResponses(400), ...commonErrors },
});

export const submitMonthly = defineRoute({
  method: "post",
  path: "/monthly-listings/payments",
  ...write,
  summary: "Send a monthly listing transfer receipt",
  description: "Replaces submit_monthly_listing_payment().",
  request: {
    body: jsonBody(
      z
        .object({ kind: z.string().max(20), listingId: idParam, payerName: z.string().max(200).nullish(), receiptPath: z.string().max(1000).nullish() })
        .openapi("MonthlyListingPaymentRequest"),
    ),
  },
  responses: { 201: dataResponse(z.object({ id: z.string() }), "The submission."), ...errors },
});

export const approveMonthly = defineRoute({
  method: "post",
  path: "/admin/monthly-listings/{submissionId}/approve",
  ...write,
  summary: "Approve a monthly listing payment (admins)",
  description: "Replaces admin_approve_monthly_listing().",
  request: { params: SubmissionParams },
  responses: { 200: dataResponse(Loose, "Approved."), ...errors },
});

export const rejectMonthly = defineRoute({
  method: "post",
  path: "/admin/monthly-listings/{submissionId}/reject",
  ...write,
  summary: "Reject a monthly listing payment (admins)",
  description: "Replaces admin_reject_monthly_listing().",
  request: { params: SubmissionParams, body: jsonBody(Note) },
  responses: { 200: dataResponse(z.object({ ok: z.literal(true) }), "Rejected."), ...errors },
});

export const deactivateMonthly = defineRoute({
  method: "post",
  path: "/admin/monthly-listings/{submissionId}/deactivate",
  ...write,
  summary: "End a monthly listing (admins)",
  description: "Replaces admin_deactivate_monthly_listing().",
  request: { params: SubmissionParams, body: jsonBody(Note) },
  responses: { 200: dataResponse(z.object({ ok: z.literal(true) }), "Deactivated."), ...errors },
});

export const owedCharges = defineRoute({
  method: "get",
  path: "/vendors/{vendorId}/commission/charges",
  tags,
  summary: "The shop's unpaid commission charges",
  description: 'Replaces `from("commission_charges").select("amount,due_at").eq("vendor_id", id).eq("status", "owed").order("due_at")` (and the same with `.limit(1)`).',
  security: signedIn,
  request: { params: VendorIdParams },
  responses: { 200: dataResponse(z.array(z.object({ amount: z.number(), due_at: z.string().nullable() })), "Earliest due first."), ...errorResponses(400, 401), ...commonErrors },
});
