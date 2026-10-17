import { defineRoute } from "../../shared/http/route.js";
import { z } from "../../shared/openapi/zod.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { VendorIdParams, commonErrors, dataResponse, errorResponses, jsonBody } from "../../shared/openapi/schemas.js";
import { signedIn } from "../../shared/openapi/security.js";

/** The admin's vendor tools (admins only; the super admin for permanent deletion). */

const tags = ["Admin: vendors"];
const writeLimit = rateLimit({ name: "admin-vendors-write", limit: 60, windowMs: 60_000 });
const write = { tags, security: signedIn, middleware: [writeLimit] as const };
const Result = z.looseObject({}).openapi("AdminVendorResult", { description: "As the database function returned it." });
const Rows = z.array(z.looseObject({}));
const writeErrors = { ...errorResponses(400, 403, 404, 415, 429), ...commonErrors };

export const setStatus = defineRoute({
  method: "put",
  path: "/admin/vendors/{vendorId}/status",
  ...write,
  summary: "Approve, reject or set back to pending",
  description: "Replaces admin_set_vendor_status().",
  request: { params: VendorIdParams, body: jsonBody(z.object({ status: z.string().max(40) }).openapi("VendorStatusRequest")) },
  responses: { 200: dataResponse(Result, "New state."), ...writeErrors },
});

export const reject = defineRoute({
  method: "post",
  path: "/admin/vendors/{vendorId}/rejection",
  ...write,
  summary: "Reject an application with a reason",
  description: "Replaces admin_reject_vendor().",
  request: { params: VendorIdParams, body: jsonBody(z.object({ reason: z.string().max(5000).nullish() }).openapi("RejectVendorRequest")) },
  responses: { 200: dataResponse(Result, "Rejected."), ...writeErrors },
});

export const setStorefront = defineRoute({
  method: "put",
  path: "/admin/vendors/{vendorId}/storefront",
  ...write,
  summary: "Pause or reactivate a storefront",
  description: "Replaces admin_set_vendor_storefront_active().",
  request: { params: VendorIdParams, body: jsonBody(z.object({ active: z.boolean() }).openapi("AdminStorefrontRequest")) },
  responses: { 200: dataResponse(Result, "New state."), ...writeErrors },
});

export const forceUnlock = defineRoute({
  method: "post",
  path: "/admin/vendors/{vendorId}/unlock",
  ...write,
  summary: "Reopen a storefront locked for unpaid commission",
  description: "Replaces admin_force_unlock_vendor(). The commission stays owed.",
  request: { params: VendorIdParams },
  responses: { 200: dataResponse(Result, "Unlocked."), ...writeErrors },
});

export const recycle = defineRoute({
  method: "delete",
  path: "/admin/vendors/{vendorId}",
  ...write,
  summary: "Move a shop to the recycle bin",
  description: "Replaces admin_delete_vendor().",
  request: { params: VendorIdParams },
  responses: { 200: dataResponse(Result, "Recycled."), ...writeErrors },
});

export const restore = defineRoute({
  method: "post",
  path: "/admin/vendors/{vendorId}/restore",
  ...write,
  summary: "Restore a shop from the recycle bin",
  description: "Replaces admin_restore_vendor().",
  request: { params: VendorIdParams },
  responses: { 200: dataResponse(Result, "Restored."), ...writeErrors },
});

export const erase = defineRoute({
  method: "delete",
  path: "/admin/vendors/{vendorId}/permanently",
  ...write,
  summary: "Erase a recycled shop (super admin)",
  description: "Replaces admin_permanently_delete_vendor().",
  request: { params: VendorIdParams },
  responses: { 200: dataResponse(Result, "Erased."), ...writeErrors },
});

export const locked = defineRoute({
  method: "get",
  path: "/admin/vendors/locked",
  tags,
  security: signedIn,
  summary: "Storefronts switched off by an admin or for commission",
  description: "Replaces admin_list_locked_vendors().",
  responses: { 200: dataResponse(Rows, "Shops."), ...errorResponses(403), ...commonErrors },
});

export const transactions = defineRoute({
  method: "get",
  path: "/admin/transactions",
  tags,
  security: signedIn,
  summary: "The latest 300 payments",
  description: "Replaces admin_list_transactions(). Empty for anyone but admins.",
  responses: { 200: dataResponse(Rows, "Payments."), ...commonErrors },
});

export const payouts = defineRoute({
  method: "get",
  path: "/admin/vendors/payouts",
  tags,
  security: signedIn,
  summary: "Every shop's bank details, sales and commission",
  description: "Replaces admin_list_vendor_payouts(). Empty for anyone but admins.",
  responses: { 200: dataResponse(Rows, "Shops."), ...commonErrors },
});

export const reviewStudent = defineRoute({
  method: "put",
  path: "/admin/vendors/{vendorId}/student-verification",
  ...write,
  summary: "Decide a student verification",
  description: "Replaces admin_review_student_verification().",
  request: {
    params: VendorIdParams,
    body: jsonBody(z.object({ status: z.string().max(20), note: z.string().max(2000).nullish() }).openapi("StudentVerificationDecision")),
  },
  responses: { 200: dataResponse(z.object({ success: z.literal(true), status: z.string() }), "Decided."), ...writeErrors },
});
