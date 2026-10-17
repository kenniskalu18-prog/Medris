import { z } from "../../shared/openapi/zod.js";
import { idParam } from "../../shared/openapi/schemas.js";

/** Request and response shapes of /api/v1/cart (types: contracts/v1.ts). */

export const MAX_QUANTITY = 10_000;

const money = z.number().nullable();

export const CartVendorSchema = z
  .object({
    id: z.string(),
    business_name: z.string(),
    previous_business_name: z.string().nullable(),
    name_changed_at: z.string().nullable(),
    is_active: z.boolean(),
    verification_status: z.string(),
    delivery_fee: money,
    delivery_fee_mode: z.string().nullable(),
    delivery_fee_per_km: money,
    lat: z.number().nullable(),
    lng: z.number().nullable(),
  })
  .openapi("CartVendor");

export const CartProductSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    listing_type: z.string().nullable(),
    is_service: z.boolean().nullable(),
    sale_price: money,
    discount_price: money,
    rental_rate: money,
    photos: z.array(z.string()).nullable(),
    quantity_available: z.number().nullable(),
    status: z.string(),
    delivery_fee: money,
    delivery_fee_mode: z.string().nullable(),
    delivery_fee_per_km: money,
    vendor: CartVendorSchema.nullable(),
  })
  .openapi("CartProduct");

export const CartItemSchema = z
  .object({
    id: z.string(),
    variant_id: z.string().nullable(),
    quantity: z.number().int(),
    created_at: z.string().openapi({ example: "2026-10-01T12:00:00.123+00:00" }),
    variant: z.record(z.string(), z.unknown()).nullable().openapi({ description: "Every product_variants column, or null." }),
    product: CartProductSchema.nullable().openapi({ description: "Null when the product is no longer visible (shown as unavailable)." }),
  })
  .openapi("CartItem");

export const AddToCartBody = z
  .object({
    productId: idParam,
    quantity: z.coerce.number().int().min(1).max(MAX_QUANTITY).default(1),
    variantId: idParam.nullish(),
  })
  .openapi("AddToCartRequest");

export const AddToCartResult = z.object({ result: z.unknown().openapi({ description: "What add_to_cart() returned." }) });

export const SetQuantityBody = z.object({ quantity: z.coerce.number().int().min(1).max(MAX_QUANTITY) }).openapi("SetCartQuantityRequest");

export const SetQuantityResult = z.object({ id: z.string(), quantity: z.number().int() });

export const BulkDeleteBody = z.object({ ids: z.array(idParam).min(1).max(200) }).openapi("DeleteCartItemsRequest");

export const RemovedResult = z.object({ removed: z.number().int().min(0) });
