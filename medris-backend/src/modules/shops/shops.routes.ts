import { defineRoute } from "../../shared/http/route.js";
import { z } from "../../shared/openapi/zod.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { commonErrors, dataResponse, DoneSchema, errorResponses, idList, idParam, jsonBody, VendorIdParams } from "../../shared/openapi/schemas.js";
import { optionalSignIn, signedIn } from "../../shared/openapi/security.js";

/** A vendor's own shop. */

const tags = ["Shops"];
const writeLimit = rateLimit({ name: "shops-write", limit: 20, windowMs: 60_000 });
const write = { tags, security: signedIn, middleware: [writeLimit] as const };
const text = (max: number) => z.string().max(max).nullish();

export const ApplicationBody = z
  .object({
    sectorId: idParam.nullish(),
    businessName: text(200),
    address: text(500),
    city: text(120),
    phone: text(40),
    whatsapp: text(40),
    cacNumber: text(60),
    bio: text(2000),
    bankCode: text(20),
    bankName: text(120),
    accountName: text(200),
    accountNumber: text(20),
  })
  .openapi("VendorApplicationRequest");

export const submitApplication = defineRoute({
  method: "post",
  path: "/shops/application",
  ...write,
  summary: "Apply to sell (or apply again)",
  description: "Replaces submit_vendor_application(): the applicant and every admin are told.",
  request: { body: jsonBody(ApplicationBody) },
  responses: { 201: dataResponse(z.object({ id: z.string() }), "The shop's id."), ...errorResponses(400, 401, 415, 429), ...commonErrors },
});

export const setStorefront = defineRoute({
  method: "put",
  path: "/shops/mine/storefront",
  ...write,
  summary: "Show or hide one's storefront",
  description: "Replaces vendor_set_storefront_active(): refused while an admin paused it or commission is owed.",
  request: { body: jsonBody(z.object({ active: z.boolean() }).openapi("StorefrontRequest")) },
  responses: { 200: dataResponse(z.looseObject({ success: z.literal(true) }), "New state."), ...errorResponses(400, 403, 404, 415, 429), ...commonErrors },
});

export const setBillingModel = defineRoute({
  method: "put",
  path: "/shops/mine/billing-model",
  ...write,
  summary: "Commission per sale, or a monthly listing fee",
  description: "Replaces set_vendor_billing_model().",
  request: { body: jsonBody(z.object({ billingModel: z.string().max(20) }).openapi("BillingModelRequest")) },
  responses: { 200: dataResponse(DoneSchema, "Saved."), ...errorResponses(400, 404, 415, 429), ...commonErrors },
});

export const submitFaceCheck = defineRoute({
  method: "post",
  path: "/shops/mine/student-verification/face-check",
  ...write,
  summary: "Record the student selfie and ID-card check",
  description: "Replaces submit_face_check().",
  request: {
    body: jsonBody(
      z
        .object({
          selfieUrl: text(1000),
          distance: z.number().nullish(),
          match: text(20),
          liveness: z.boolean().nullish(),
          ocrMatric: z.boolean().nullish(),
          ocrName: z.boolean().nullish(),
          ocrText: text(4000),
        })
        .openapi("FaceCheckRequest"),
    ),
  },
  responses: { 200: dataResponse(DoneSchema, "Saved."), ...errorResponses(400, 404, 415, 429), ...commonErrors },
});

const ShopRow = z.record(z.string(), z.unknown());

export const myShop = defineRoute({
  method: "get",
  path: "/shops/mine",
  tags,
  summary: "The caller's own shop (every column)",
  description: 'Replaces `from("vendors").select("*").eq("user_id", me).is("deleted_at", null).maybeSingle()` and its narrower versions. Null without a shop.',
  security: signedIn,
  responses: { 200: dataResponse(ShopRow.nullable(), "The shop."), ...errorResponses(401), ...commonErrors },
});

export const updateMyShop = defineRoute({
  method: "patch",
  path: "/shops/mine",
  ...write,
  summary: "Change one's shop details",
  description:
    "Replaces the app's updates of vendors: profile, logo and header, location, hours, WhatsApp, campus and request settings, documents. " +
    "Only these fields (the table allowed every column, including verification - BASELINE_FINDINGS S11).",
  request: {
    body: jsonBody(
      z.object({
        business_name: z.string().min(1).max(120).optional(),
        sector_id: idParam.optional(),
        address: text(500).optional(),
        city: text(100).optional(),
        phone: text(30).optional(),
        whatsapp_number: text(30).optional(),
        whatsapp_visible: z.boolean().optional(),
        bio: text(2000).optional(),
        opening_hours: text(500).optional(),
        business_hours: z.record(z.string(), z.unknown()).nullable().optional(),
        allow_after_hours_messages: z.boolean().optional(),
        logo_url: text(1000).optional(),
        cover_url: text(1000).optional(),
        lat: z.number().min(-90).max(90).nullable().optional(),
        lng: z.number().min(-180).max(180).nullable().optional(),
        request_pref: z.string().max(20).optional(),
        operating_scope: z.string().max(20).optional(),
        operating_campuses: z.array(z.string().max(200)).max(50).optional(),
        request_campus_scope: z.string().max(20).optional(),
        campus_id: text(200).optional(),
        campus_setup_done: z.boolean().optional(),
        verification_docs: z.array(z.string().max(500)).max(20).optional(),
      }),
    ),
  },
  responses: { 200: dataResponse(z.object({ updated: z.number().int() }), "How many changed."), ...errorResponses(400, 401, 415, 429), ...commonErrors },
});

export const setPayout = defineRoute({
  method: "put",
  path: "/shops/mine/payout",
  ...write,
  summary: "Save the shop's payout account",
  description: "Replaces the app's update of vendors' bank and Paystack fields after the account check.",
  request: {
    body: jsonBody(
      z.object({
        bank_code: z.string().min(1).max(20),
        bank_name: z.string().min(1).max(120),
        account_name: z.string().max(200).nullable(),
        account_number: z.string().min(6).max(20),
        paystack_subaccount_code: z.string().max(100).nullable(),
      }),
    ),
  },
  responses: { 200: dataResponse(z.object({ updated: z.number().int() }), "How many changed."), ...errorResponses(400, 401, 415, 429), ...commonErrors },
});

export const removeApplication = defineRoute({
  method: "delete",
  path: "/shops/{vendorId}/application",
  ...write,
  summary: "Withdraw a half-finished application",
  description: 'Replaces `from("vendors").delete().eq("id", id).eq("user_id", me)` (the clean-up after a failed step). The table does not let users delete shops, so nothing is removed, as before.',
  request: { params: VendorIdParams },
  responses: { 200: dataResponse(z.object({ removed: z.number().int() }), "How many went."), ...errorResponses(400, 401, 429), ...commonErrors },
});

export const listShops = defineRoute({
  method: "get",
  path: "/shops",
  tags,
  summary: "Shop lists",
  description:
    "Replaces the app's list selects on vendors (home, shops page, search, Levi, maps): verified, active shops (`anyStatus` = any the caller may see), " +
    "optionally by ids, sector, name or student verification; the columns anyone may see.",
  security: optionalSignIn,
  request: {
    query: z.object({
      ids: idList("Shop ids.", 1000).optional(),
      sectorId: idParam.optional(),
      q: z.string().max(100).optional(),
      studentVerified: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
      anyStatus: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
      orderBy: z.enum(["name", "rating", "id", "none"]).default("none"),
      limit: z.coerce.number().int().min(1).max(5000).default(1000),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  },
  responses: { 200: dataResponse(z.array(ShopRow), "The shops."), ...errorResponses(400), ...commonErrors },
});

export const getShop = defineRoute({
  method: "get",
  path: "/shops/{vendorId}",
  tags,
  summary: "One shop, with its sector",
  description:
    'Replaces `from("vendors").select("*, sector:sectors(name, icon)").eq("id", id)[.eq("verification_status", "verified")][.eq("is_active", true)]` and every narrower select of one shop. ' +
    "Every column for its owner and admins; the public ones for others (BASELINE_FINDINGS S12).",
  security: optionalSignIn,
  request: {
    params: VendorIdParams,
    query: z.object({
      verified: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
      active: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
    }),
  },
  responses: { 200: dataResponse(ShopRow.nullable(), "The shop, or null."), ...errorResponses(400), ...commonErrors },
});

export const adminShops = defineRoute({
  method: "get",
  path: "/admin/shops",
  tags,
  summary: "Applications and shops, or the recycle bin (admins)",
  description: "Replaces the admin's selects on vendors with the applicant (name, email): live ones (optionally one status), newest first, or deleted ones.",
  security: signedIn,
  request: { query: z.object({ deleted: z.enum(["true", "false"]).default("false").transform((v) => v === "true"), status: z.enum(["pending", "verified", "rejected"]).optional() }) },
  responses: { 200: dataResponse(z.array(ShopRow), "The shops."), ...errorResponses(400, 401), ...commonErrors },
});

export const variants = defineRoute({
  method: "get",
  path: "/product-variants",
  tags,
  summary: "The varieties of some listings",
  description: 'Replaces `from("product_variants").select("*").in("product_id", ids)` (and `.eq("product_id", id)`), ordered by sort order then age.',
  security: optionalSignIn,
  request: { query: z.object({ productIds: idList("Product ids.", 500) }) },
  responses: { 200: dataResponse(z.array(ShopRow), "The varieties the caller may see."), ...errorResponses(400), ...commonErrors },
});

export const studentVerification = defineRoute({
  method: "get",
  path: "/shops/{vendorId}/student-verification",
  tags,
  summary: "A shop's student verification",
  description: 'Replaces `from("vendor_student_verification").select("*").eq("vendor_id", id).maybeSingle()`. Only its owner and admins see it.',
  security: signedIn,
  request: { params: VendorIdParams },
  responses: { 200: dataResponse(ShopRow.nullable(), "The record."), ...errorResponses(400, 401), ...commonErrors },
});

export const studentVerificationStatuses = defineRoute({
  method: "get",
  path: "/student-verifications",
  tags,
  summary: "Student verification statuses",
  description: 'Replaces `from("vendor_student_verification").select("vendor_id,status,matric_pending")` (admins: all; a shop: its own).',
  security: signedIn,
  responses: { 200: dataResponse(z.array(z.object({ vendor_id: z.string(), status: z.string(), matric_pending: z.boolean() })), "The statuses."), ...errorResponses(401), ...commonErrors },
});

export const submitStudentVerification = defineRoute({
  method: "put",
  path: "/shops/mine/student-verification",
  ...write,
  summary: "Submit (or resubmit) student verification",
  description: 'Replaces `from("vendor_student_verification").upsert({ vendor_id, ... }, { onConflict: "vendor_id" })`. Always pending again; an approved one cannot be changed (403).',
  request: {
    body: jsonBody(
      z.object({
        matric_number: text(50).default(null),
        matric_pending: z.boolean().default(false),
        faculty: text(200).default(null),
        department: text(200).default(null),
        level: text(50).default(null),
        id_card_url: text(1000).default(null),
        biodata_url: text(1000).default(null),
        selfie_url: text(1000).default(null),
        face_distance: z.number().nullable().default(null),
        face_match: z.enum(["strong", "possible", "mismatch", "unchecked"]).nullable().default(null),
        face_liveness: z.boolean().nullable().default(null),
        face_checked_at: z.string().max(40).nullable().default(null),
        face_v: z.number().int().min(0).nullable().default(null),
      }),
    ),
  },
  responses: { 200: dataResponse(z.object({ submitted: z.literal(true) }), "Submitted."), ...errorResponses(400, 401, 403, 404, 415, 429), ...commonErrors },
});

export const recordStudentOcr = defineRoute({
  method: "post",
  path: "/shops/mine/student-verification/ocr",
  ...write,
  summary: "Record what the ID card's text check found",
  description: "Replaces `update({ ocr_matric_found, ocr_name_found, ocr_text, ocr_checked_at, status: \"pending\" })` of vendor_student_verification.",
  request: { body: jsonBody(z.object({ matric: z.boolean().nullable(), name: z.boolean().nullable(), text: z.string().max(10000).nullable() })) },
  responses: { 200: dataResponse(z.object({ updated: z.number().int() }), "How many changed."), ...errorResponses(400, 401, 404, 415, 429), ...commonErrors },
});

export const mySubmissions = defineRoute({
  method: "get",
  path: "/shops/mine/monthly-submissions",
  tags,
  summary: "The caller's shop's monthly-listing receipts",
  description: 'Replaces `from("monthly_listing_submissions").select(...).eq("vendor_id", shop)[.eq("kind", kind)].order("submitted_at", desc).limit(100)`.',
  security: signedIn,
  request: { query: z.object({ kind: z.enum(["product", "package"]).optional() }) },
  responses: { 200: dataResponse(z.array(ShopRow), "Newest first."), ...errorResponses(400, 401), ...commonErrors },
});

export const pendingSubmission = defineRoute({
  method: "get",
  path: "/monthly-submissions/pending/{kind}/{listingId}",
  tags,
  summary: "A listing's pending monthly-listing receipt",
  description: 'Replaces `from("monthly_listing_submissions").select(...).eq("kind", kind).eq("listing_id", id).eq("status", "pending")...maybeSingle()`.',
  security: signedIn,
  request: { params: z.object({ kind: z.enum(["product", "package"]), listingId: idParam }) },
  responses: { 200: dataResponse(ShopRow.nullable(), "The receipt, or null."), ...errorResponses(400, 401), ...commonErrors },
});

export const pendingSubmissions = defineRoute({
  method: "get",
  path: "/monthly-submissions/pending",
  tags,
  summary: "Pending monthly-listing receipts",
  description: 'Replaces `from("monthly_listing_submissions").select("id,kind,listing_id,vendor_id").eq("status", "pending")` (a vendor: only their shop\'s).',
  security: signedIn,
  responses: { 200: dataResponse(z.array(z.object({ id: z.string(), kind: z.string(), listing_id: z.string(), vendor_id: z.string() })), "The receipts."), ...errorResponses(401), ...commonErrors },
});

export const latestSubmissions = defineRoute({
  method: "get",
  path: "/admin/monthly-submissions",
  tags,
  summary: "The latest monthly-listing receipts (admins)",
  description: 'Replaces `from("monthly_listing_submissions").select(...).order("submitted_at", desc).limit(100)`.',
  security: signedIn,
  responses: { 200: dataResponse(z.array(ShopRow), "Newest first."), ...errorResponses(401), ...commonErrors },
});
