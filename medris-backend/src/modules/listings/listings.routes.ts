import { defineRoute } from "../../shared/http/route.js";
import { z } from "../../shared/openapi/zod.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { commonErrors, dataResponse, errorResponses, idList, idParam, jsonBody, PackageParams, ProductParams } from "../../shared/openapi/schemas.js";
import { optionalSignIn, signedIn } from "../../shared/openapi/security.js";

/** Listings: the marketplace reads and the shop owner's editing. Replaces the app's table queries on products. */

const tags = ["Listings"];
const writeLimit = rateLimit({ name: "listings-write", limit: 60, windowMs: 60_000 });
const Row = z.record(z.string(), z.unknown());
const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const money = z.number().min(0).nullable().optional();

const Fields = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  category_id: idParam.nullable().optional(),
  condition: z.string().max(30).optional(),
  listing_type: z.enum(["sale", "rent", "both"]).optional(),
  is_service: z.boolean().optional(),
  service_price_unit: z.string().max(30).nullable().optional(),
  sale_price: money,
  discount_price: money,
  delivery_fee_mode: z.enum(["free", "flat", "distance"]).optional(),
  delivery_fee: z.number().min(0).optional(),
  delivery_fee_per_km: z.number().min(0).optional(),
  payment_timing: z.string().max(30).optional(),
  payment_deposit_percent: z.number().min(0).max(100).optional(),
  rental_rate: money,
  rental_rate_unit: z.string().max(20).nullable().optional(),
  deposit_amount: money,
  quantity_total: z.number().int().min(0).optional(),
  quantity_available: z.number().int().min(0).optional(),
  track_quantity: z.boolean().optional(),
  photos: z.array(z.string().max(1000)).max(20).optional(),
});

export const feed = defineRoute({
  method: "get",
  path: "/products",
  tags,
  summary: "Marketplace listings",
  description:
    "Replaces the app's marketplace selects on products (home, browse, search, Levi, similar items): active listings of verified, active shops, " +
    "filtered and ordered as the screen asked. `view=index` gives the light rows the browse and search indexes keep.",
  security: optionalSignIn,
  request: {
    query: z.object({
      ids: idList("Product ids.", 1000).optional(),
      vendorId: idParam.optional(),
      categoryIds: idList("Category ids.", 500).optional(),
      sectorId: idParam.optional(),
      isService: bool.optional(),
      listingTypes: z
        .string()
        .transform((s) => s.split(",").filter(Boolean))
        .pipe(z.array(z.enum(["sale", "rent", "both"])).max(3))
        .optional(),
      q: z.string().max(100).optional(),
      qAny: z.string().max(100).optional(),
      inStock: bool.default(false),
      orderBy: z.enum(["views", "newest", "id", "name", "none"]).default("none"),
      view: z.enum(["card", "index"]).default("card"),
      withVariants: bool.default(false),
      limit: z.coerce.number().int().min(1).max(5000).default(1000),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  },
  responses: { 200: dataResponse(z.array(Row), "The listings."), ...errorResponses(400), ...commonErrors },
});

export const detail = defineRoute({
  method: "get",
  path: "/products/{productId}",
  tags,
  summary: "One listing, with its shop and category",
  description: 'Replaces `from("products").select("*, vendor:vendors(...), category:categories(...)").eq("id", id)` and its narrower versions. Null when the caller may not see it.',
  security: optionalSignIn,
  request: { params: ProductParams },
  responses: { 200: dataResponse(Row.nullable(), "The listing."), ...errorResponses(400), ...commonErrors },
});

export const myListings = defineRoute({
  method: "get",
  path: "/shops/mine/products",
  tags,
  summary: "The caller's shop's listings",
  description: 'Replaces `from("products").select("*, category:categories(name)").eq("vendor_id", shop).order("created_at", desc)` and its narrower versions.',
  security: signedIn,
  request: { query: z.object({ includeRemoved: bool.default(true), activeOnly: bool.default(false), q: z.string().max(100).optional() }) },
  responses: { 200: dataResponse(z.array(Row), "Newest first."), ...errorResponses(401, 404), ...commonErrors },
});

export const byReference = defineRoute({
  method: "get",
  path: "/shops/mine/products/by-reference/{reference}",
  tags,
  summary: "The listing a paid draft already created",
  description: 'Replaces `from("products").select("id").eq("vendor_id", shop).eq("billing_reference", ref).maybeSingle()`.',
  security: signedIn,
  request: { params: z.object({ reference: z.string().min(1).max(200) }) },
  responses: { 200: dataResponse(z.object({ id: z.string().nullable() }), "The listing id, or null."), ...errorResponses(400, 401, 404), ...commonErrors },
});

export const myListing = defineRoute({
  method: "get",
  path: "/shops/mine/products/{productId}",
  tags,
  summary: "One of the caller's shop's listings (every column)",
  description: 'Replaces `from("products").select("*").eq("id", id).eq("vendor_id", shop)` and its narrower versions.',
  security: signedIn,
  request: { params: ProductParams },
  responses: { 200: dataResponse(Row.nullable(), "The listing."), ...errorResponses(400, 401, 404), ...commonErrors },
});

export const create = defineRoute({
  method: "post",
  path: "/shops/mine/products",
  tags,
  summary: "Add a listing",
  description:
    "Replaces the inserts into products (the editor and the paid-draft flow). A monthly listing starts paused until its fee is paid " +
    "(the payment check activates it); the browser no longer sets status or billing (BASELINE_FINDINGS S13).",
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { body: jsonBody(z.object({ fields: Fields, billingModel: z.enum(["commission", "monthly"]), reference: z.string().max(200).nullable().optional() })) },
  responses: { 201: dataResponse(Row, "The new listing."), ...errorResponses(400, 401, 404, 409, 415, 429), ...commonErrors },
});

export const update = defineRoute({
  method: "patch",
  path: "/shops/mine/products/{productId}",
  tags,
  summary: "Change a listing",
  description: 'Replaces `update({ ...fields, quantity_available, photos }).eq("id", id).eq("vendor_id", shop).select("*").single()`: the editor\'s fields only.',
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { params: ProductParams, body: jsonBody(Fields) },
  responses: { 200: dataResponse(Row, "The listing."), ...errorResponses(400, 401, 404, 415, 429), ...commonErrors },
});

export const setStatus = defineRoute({
  method: "post",
  path: "/shops/mine/products/{productId}/status",
  tags,
  summary: "Pause, discard or reactivate a listing",
  description: "Replaces the status updates of products. A monthly listing whose paid period ended cannot go live again: 409 with `details.needsPayment`.",
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { params: ProductParams, body: jsonBody(z.object({ status: z.enum(["active", "paused", "removed"]), cancelBilling: z.boolean().default(false) })) },
  responses: { 200: dataResponse(z.object({ updated: z.number().int() }), "How many changed."), ...errorResponses(400, 401, 404, 409, 415, 429), ...commonErrors },
});

export const clearReference = defineRoute({
  method: "post",
  path: "/shops/mine/products/{productId}/clear-reference",
  tags,
  summary: "Forget a paid draft's payment reference",
  description: 'Replaces `update({ billing_reference: null }).eq("id", id).eq("vendor_id", shop)`.',
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { params: ProductParams },
  responses: { 200: dataResponse(z.object({ updated: z.number().int() }), "How many changed."), ...errorResponses(400, 401, 404, 429), ...commonErrors },
});

export const remove = defineRoute({
  method: "delete",
  path: "/shops/mine/products/{productId}",
  tags,
  summary: "Delete a listing",
  description: 'Replaces `delete().eq("id", id).eq("vendor_id", shop)`. A listing with orders cannot be deleted (409); the app then discards it instead.',
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { params: ProductParams },
  responses: { 200: dataResponse(z.object({ removed: z.number().int() }), "How many went."), ...errorResponses(400, 401, 404, 409, 429), ...commonErrors },
});

const PackageBody = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  price: z.number().min(0).optional(),
  photos: z.array(z.unknown()).max(20).optional(),
});
const Items = z.array(z.object({ product_id: idParam, quantity: z.number().int().min(1).max(1000) })).max(50);

export const packageFeed = defineRoute({
  method: "get",
  path: "/packages",
  tags,
  summary: "Marketplace packages",
  description:
    "Replaces the app's marketplace selects on vendor_packages (home, search, storefront, Levi): active packages of verified, active shops with shop and items. " +
    "`view=index` gives vendor id, name, description and price only.",
  security: optionalSignIn,
  request: {
    query: z.object({
      ids: idList("Package ids.", 500).optional(),
      vendorId: idParam.optional(),
      qAny: z.string().max(100).optional(),
      qItems: z.string().max(100).optional(),
      orderBy: z.enum(["newest", "none"]).default("none"),
      view: z.enum(["card", "index"]).default("card"),
      limit: z.coerce.number().int().min(1).max(2000).default(500),
    }),
  },
  responses: { 200: dataResponse(z.array(Row), "The packages."), ...errorResponses(400), ...commonErrors },
});

export const packageDetail = defineRoute({
  method: "get",
  path: "/packages/{packageId}",
  tags,
  summary: "One package, with its shop and items",
  description: 'Replaces `from("vendor_packages").select("..., vendor:vendors!inner(...), items:package_items(quantity, product:products(...))").eq("id", id)`. Null when the caller may not see it.',
  security: optionalSignIn,
  request: { params: PackageParams },
  responses: { 200: dataResponse(Row.nullable(), "The package."), ...errorResponses(400), ...commonErrors },
});

export const myPackages = defineRoute({
  method: "get",
  path: "/shops/mine/packages",
  tags,
  summary: "The caller's shop's packages, with items",
  description: 'Replaces `from("vendor_packages").select("*, items:package_items(quantity, product:products(name))").eq("vendor_id", shop)` and its narrower versions.',
  security: signedIn,
  responses: { 200: dataResponse(z.array(Row), "Newest first."), ...errorResponses(401, 404), ...commonErrors },
});

export const createPackage = defineRoute({
  method: "post",
  path: "/shops/mine/packages",
  tags,
  summary: "Add a package",
  description: "Replaces the insert into vendor_packages and its package_items. Only the shop's own products; a monthly package starts paused until paid.",
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { body: jsonBody(z.object({ fields: PackageBody, items: Items, billingModel: z.enum(["commission", "monthly"]) })) },
  responses: { 201: dataResponse(Row, "The new package."), ...errorResponses(400, 401, 404, 415, 429), ...commonErrors },
});

export const updatePackage = defineRoute({
  method: "patch",
  path: "/shops/mine/packages/{packageId}",
  tags,
  summary: "Change a package (and replace its items)",
  description: "Replaces `update(payload)` of vendor_packages and the delete-then-insert of its package_items, in one transaction.",
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { params: PackageParams, body: jsonBody(z.object({ fields: PackageBody, items: Items.nullable().optional() })) },
  responses: { 200: dataResponse(Row, "The package."), ...errorResponses(400, 401, 404, 415, 429), ...commonErrors },
});

export const setPackageStatus = defineRoute({
  method: "post",
  path: "/shops/mine/packages/{packageId}/status",
  tags,
  summary: "Pause, discard or reactivate a package",
  description: "Replaces `update({ status })` of vendor_packages. A monthly package whose paid period ended cannot go live again: 409 with `details.needsPayment`.",
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { params: PackageParams, body: jsonBody(z.object({ status: z.enum(["active", "paused", "removed"]) })) },
  responses: { 200: dataResponse(z.object({ updated: z.number().int() }), "How many changed."), ...errorResponses(400, 401, 404, 409, 415, 429), ...commonErrors },
});

export const removePackage = defineRoute({
  method: "delete",
  path: "/shops/mine/packages/{packageId}",
  tags,
  summary: "Delete a package",
  description: 'Replaces `from("vendor_packages").delete().eq("id", id).eq("vendor_id", shop)`.',
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { params: PackageParams },
  responses: { 200: dataResponse(z.object({ removed: z.number().int() }), "How many went."), ...errorResponses(400, 401, 404, 409, 429), ...commonErrors },
});
