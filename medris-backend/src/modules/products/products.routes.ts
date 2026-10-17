import { defineRoute } from "../../shared/http/route.js";
import { z } from "../../shared/openapi/zod.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { ProductParams, VendorIdParams, commonErrors, dataResponse, errorResponses, jsonBody } from "../../shared/openapi/schemas.js";
import { signedIn } from "../../shared/openapi/security.js";
import { InventoryDeletionSchema, InventoryItemSchema, ProductRegionSchema, SaveVariantsBody, VariantSchema } from "./products.schemas.js";

/** Product varieties, the admin inventory, and where a shop's products sell. */

const tags = ["Products"];
const writeLimit = rateLimit({ name: "products-write", limit: 30, windowMs: 60_000 });

export const productVariants = defineRoute({
  method: "get",
  path: "/products/{productId}/variants",
  tags,
  summary: "A product's varieties, for editing",
  description: "Replaces get_owned_product_variants(): the shop owner or an admin. Ordered as arranged.",
  security: signedIn,
  request: { params: ProductParams },
  responses: { 200: dataResponse(z.array(VariantSchema), "Varieties."), ...errorResponses(400, 403), ...commonErrors },
});

export const saveProductVariants = defineRoute({
  method: "put",
  path: "/products/{productId}/variants",
  tags,
  summary: "Save a product's varieties",
  description:
    "Replaces save_product_variants(): the complete list in one go - known ids are updated, others added, varieties left out deleted. Returns the saved list.",
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { params: ProductParams, body: jsonBody(SaveVariantsBody) },
  responses: { 200: dataResponse(z.array(VariantSchema), "Saved."), ...errorResponses(400, 403, 404, 415, 429), ...commonErrors },
});

export const adminInventory = defineRoute({
  method: "get",
  path: "/admin/inventory",
  tags,
  summary: "Every product in the inventory (admins)",
  description: "Replaces admin_get_inventory(). Products removed by an admin are left out.",
  security: signedIn,
  responses: { 200: dataResponse(z.array(InventoryItemSchema), "Products."), ...errorResponses(403), ...commonErrors },
});

export const adminDeleteInventoryProduct = defineRoute({
  method: "delete",
  path: "/admin/inventory/{productId}",
  tags,
  summary: "Delete a product from the inventory (admins)",
  description: "Replaces admin_delete_inventory_product(): deleted for good when never ordered, otherwise hidden so order history keeps it.",
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { params: ProductParams },
  responses: { 200: dataResponse(InventoryDeletionSchema, "Done."), ...errorResponses(400, 403, 404, 429), ...commonErrors },
});

export const vendorProductRegions = defineRoute({
  method: "get",
  path: "/vendors/{vendorId}/product-regions",
  tags,
  summary: "Where a shop's products sell",
  description: "Replaces get_vendor_product_regions(): orders and units per product and buyer city (not cancelled). The owner or an admin.",
  security: signedIn,
  request: { params: VendorIdParams },
  responses: { 200: dataResponse(z.array(ProductRegionSchema), "Rows."), ...errorResponses(400, 403), ...commonErrors },
});
