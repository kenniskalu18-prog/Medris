import { defineRoute } from "../../shared/http/route.js";
import { requireUser } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { IdParams, commonErrors, dataResponse, errorResponses } from "../../shared/openapi/schemas.js";
import { signedIn } from "../../shared/openapi/security.js";
import { FavoritesSchema, SavedResult, UnsavedResult } from "./favorites.schemas.js";
import { z } from "../../shared/openapi/zod.js";

/** Saved products and packages of the signed-in user. RLS keeps the rows private to their owner. */

const tags = ["Favorites"];
const writeLimit = rateLimit({ name: "favorites-write", limit: 120, windowMs: 60_000 });
const writeErrors = { ...errorResponses(400, 401, 429), ...commonErrors };

export const listFavorites = defineRoute({
  method: "get",
  path: "/favorites",
  tags,
  summary: "Saved product and package ids",
  security: signedIn,
  middleware: [requireUser] as const,
  responses: { 200: dataResponse(FavoritesSchema, "The saved ids."), ...errorResponses(401), ...commonErrors },
});

function saveRoute(kind: "products" | "packages") {
  const noun = kind === "products" ? "product" : "package";
  return defineRoute({
    method: "put",
    path: `/favorites/${kind}/{id}`,
    tags,
    summary: `Save a ${noun}`,
    description: "Idempotent: saving twice keeps one row.",
    security: signedIn,
    middleware: [requireUser, writeLimit] as const,
    request: { params: IdParams },
    responses: { 200: dataResponse(SavedResult, "Saved."), ...writeErrors },
  });
}

function unsaveRoute(kind: "products" | "packages") {
  const noun = kind === "products" ? "product" : "package";
  return defineRoute({
    method: "delete",
    path: `/favorites/${kind}/{id}`,
    tags,
    summary: `Remove a saved ${noun}`,
    security: signedIn,
    middleware: [requireUser, writeLimit] as const,
    request: { params: IdParams },
    responses: { 200: dataResponse(UnsavedResult, "Removed (0 when it was not saved)."), ...writeErrors },
  });
}

export const saveProduct = saveRoute("products");
export const unsaveProduct = unsaveRoute("products");
export const savePackage = saveRoute("packages");
export const unsavePackage = unsaveRoute("packages");

export const savedProducts = defineRoute({
  method: "get",
  path: "/favorites/products",
  tags,
  summary: "The wishlist's saved products, with their shop",
  description:
    'Replaces `from("favorites").select("product:products(id, name, listing_type, sale_price, rental_rate, rental_rate_unit, photos, ' +
    'quantity_available, condition, is_service, service_price_unit, status, vendor:vendors(...))").eq("buyer_id", me).order("created_at", desc)`. ' +
    "`product` is null when it can no longer be seen.",
  security: signedIn,
  middleware: [requireUser] as const,
  responses: { 200: dataResponse(z.array(z.object({ product: z.record(z.string(), z.unknown()).nullable() })), "Newest first."), ...errorResponses(401), ...commonErrors },
});

export const savedPackages = defineRoute({
  method: "get",
  path: "/favorites/packages",
  tags,
  summary: "The wishlist's saved packages, with their shop and items",
  description:
    'Replaces `from("package_favorites").select("package:vendor_packages(id, vendor_id, name, description, price, photos, created_at, status, ' +
    'vendor:vendors!inner(...), items:package_items(quantity, product:products(id,name,photos)))").eq("buyer_id", me).order("created_at", desc)`. ' +
    "`package` is null when it or its shop can no longer be seen.",
  security: signedIn,
  middleware: [requireUser] as const,
  responses: { 200: dataResponse(z.array(z.object({ package: z.record(z.string(), z.unknown()).nullable() })), "Newest first."), ...errorResponses(401), ...commonErrors },
});
