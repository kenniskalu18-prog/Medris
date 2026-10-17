import { z } from "../../shared/openapi/zod.js";

/** Request and response shapes of the product endpoints (rows exactly as the database functions returned them). */

export const VariantSchema = z
  .looseObject({ id: z.string(), product_id: z.string(), name: z.string() })
  .openapi("ProductVariant", { description: "A product_variants row with every column." });

export const VariantInput = z
  .looseObject({
    id: z.string().nullish().openapi({ description: "An existing variety of this product to update; otherwise a new one is added (with this id when given)." }),
    name: z.string().nullish(),
    photo_url: z.string().nullish(),
    sale_price: z.union([z.number(), z.string()]).nullish(),
    discount_price: z.union([z.number(), z.string()]).nullish(),
    rental_rate: z.union([z.number(), z.string()]).nullish(),
    sort_order: z.union([z.number(), z.string()]).nullish(),
    quantity_available: z.union([z.number(), z.string()]).nullish(),
    size: z.string().nullish(),
    color: z.string().nullish(),
    description: z.string().nullish(),
  })
  .openapi("ProductVariantInput");

export const SaveVariantsBody = z
  .object({ variants: z.array(VariantInput).max(500).openapi({ description: "The product's complete list of varieties; any left out are deleted." }) })
  .openapi("SaveProductVariantsRequest");

export const InventoryItemSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    price: z.number().nullable(),
    status: z.string(),
    created_at: z.string(),
    vendor_id: z.string(),
    quantity_available: z.number().nullable(),
    quantity_total: z.number().nullable(),
    vendor_name: z.string(),
    category_id: z.string().nullable(),
    category_name: z.string(),
    sector_id: z.string().nullable(),
    sector_name: z.string(),
  })
  .openapi("InventoryItem");

export const InventoryDeletionSchema = z
  .object({
    deleted: z.literal(true),
    permanent: z.boolean().openapi({ description: "False when the product had orders: it is hidden, not deleted." }),
    preserved_order_history: z.literal(true).optional(),
    product_id: z.string(),
    product_name: z.string(),
  })
  .openapi("InventoryDeletion");

export const ProductRegionSchema = z
  .object({ product_id: z.string(), product_name: z.string(), city: z.string(), order_count: z.number(), total_units: z.number() })
  .openapi("ProductRegion");

export type InventoryDeletion = z.infer<typeof InventoryDeletionSchema>;
