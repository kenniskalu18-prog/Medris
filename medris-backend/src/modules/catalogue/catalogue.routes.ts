import { defineRoute } from "../../shared/http/route.js";
import { z } from "../../shared/openapi/zod.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { commonErrors, dataResponse, errorResponses, jsonBody } from "../../shared/openapi/schemas.js";
import { optionalSignIn, signedIn } from "../../shared/openapi/security.js";
import {
  CatalogueRowSchema,
  CategoriesQuery,
  CreateCategoryBody,
  CreateSectorBody,
  CreatedId,
  ListingParams,
  SearchHitSchema,
  SearchIdSchema,
  SearchIdsQuery,
  SearchQuery,
  SectorsQuery,
  ServicePriceHintSchema,
} from "./catalogue.schemas.js";

/**
 * Public catalogue reference data. Read as the caller (anon when signed out),
 * so the tables' public-read policies decide visibility, as before.
 */

const tags = ["Catalogue"];

export const listSectors = defineRoute({
  method: "get",
  path: "/catalogue/sectors",
  tags,
  summary: "List sectors",
  security: optionalSignIn,
  request: { query: SectorsQuery },
  responses: { 200: dataResponse(z.array(CatalogueRowSchema), "Every sector."), ...errorResponses(400, 401), ...commonErrors },
});

export const listCategories = defineRoute({
  method: "get",
  path: "/catalogue/categories",
  tags,
  summary: "List categories",
  description: "Sorted by name; optionally only one sector's.",
  security: optionalSignIn,
  request: { query: CategoriesQuery },
  responses: { 200: dataResponse(z.array(CatalogueRowSchema), "The categories."), ...errorResponses(400, 401), ...commonErrors },
});

const writeLimit = rateLimit({ name: "catalogue-write", limit: 20, windowMs: 60_000 });

export const searchProducts = defineRoute({
  method: "get",
  path: "/catalogue/search",
  tags,
  summary: "Search products",
  description: "Replaces search_products_full_v2(): typo-tolerant, best matches first; active products of verified shops only.",
  security: optionalSignIn,
  request: { query: SearchQuery },
  responses: { 200: dataResponse(z.array(SearchHitSchema), "Matches."), ...errorResponses(400), ...commonErrors },
});

export const searchProductIds = defineRoute({
  method: "get",
  path: "/catalogue/search/ids",
  tags,
  summary: "Search products - ids and scores only",
  description: "Replaces search_product_ids(): the best 500 matches.",
  security: optionalSignIn,
  request: { query: SearchIdsQuery },
  responses: { 200: dataResponse(z.array(SearchIdSchema), "Matches."), ...errorResponses(400), ...commonErrors },
});

export const createSector = defineRoute({
  method: "post",
  path: "/catalogue/sectors",
  tags,
  summary: "Add a sector",
  description: "Replaces create_vendor_sector(): approved shops and admins. An existing sector of the same name is returned instead.",
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { body: jsonBody(CreateSectorBody) },
  responses: { 200: dataResponse(CreatedId, "The sector."), ...errorResponses(400, 403, 415, 429), ...commonErrors },
});

export const createCustomSector = defineRoute({
  method: "post",
  path: "/catalogue/sectors/custom",
  tags,
  summary: "The sector a vendor typed in",
  description: "Replaces get_or_create_custom_sector(): when applying or editing a shop (not admins). An existing sector of that name is reused.",
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { body: jsonBody(CreateSectorBody) },
  responses: { 200: dataResponse(CreatedId, "The sector."), ...errorResponses(400, 401, 415, 429), ...commonErrors },
});

export const createCategory = defineRoute({
  method: "post",
  path: "/catalogue/categories",
  tags,
  summary: "Add a category",
  description: "Replaces create_vendor_category(): approved shops and admins, under a category group of a sector. An existing one of the same name is returned.",
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { body: jsonBody(CreateCategoryBody) },
  responses: { 200: dataResponse(CreatedId, "The category."), ...errorResponses(400, 403, 415, 429), ...commonErrors },
});

export const servicePriceHint = defineRoute({
  method: "get",
  path: "/catalogue/listings/{listingId}/price-hint",
  tags,
  summary: "What completed bookings of a service cost",
  description: "Replaces get_service_price_hint(): number of completed bookings and their lowest and highest price (one row).",
  security: optionalSignIn,
  request: { params: ListingParams },
  responses: { 200: dataResponse(z.array(ServicePriceHintSchema), "One row."), ...errorResponses(400), ...commonErrors },
});
