import { defineRoute } from "../../shared/http/route.js";
import { z } from "../../shared/openapi/zod.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { commonErrors, dataResponse, errorResponses, idParam, jsonBody } from "../../shared/openapi/schemas.js";
import { signedIn } from "../../shared/openapi/security.js";

/** Placing orders. */

const tags = ["Checkout"];
const checkoutLimit = rateLimit({ name: "checkout", limit: 20, windowMs: 60_000 });
const write = { tags, security: signedIn, middleware: [checkoutLimit] as const };
const Created = z.object({ id: z.string() }).openapi("CreatedOrder");
const errors = { ...errorResponses(400, 401, 403, 415, 429), ...commonErrors };

const Delivery = z
  .object({
    method: z.string().max(20).openapi({ description: "pickup or delivery." }),
    address: z.string().max(1000).nullish(),
    phone: z.string().max(40).nullish(),
    lat: z.number().nullish(),
    lng: z.number().nullish(),
  })
  .openapi("CheckoutDelivery");

export const sale = defineRoute({
  method: "post",
  path: "/checkout/sale",
  ...write,
  summary: "Buy one product",
  description: "Replaces create_sale_order().",
  request: {
    body: jsonBody(
      z
        .object({
          vendorId: idParam,
          productId: idParam,
          variantId: idParam.nullish(),
          quantity: z.number().int(),
          delivery: Delivery,
          buyerNote: z.string().max(2000).nullish(),
        })
        .openapi("SaleCheckoutRequest"),
    ),
  },
  responses: { 201: dataResponse(Created, "The order."), ...errors },
});

export const rental = defineRoute({
  method: "post",
  path: "/checkout/rental",
  ...write,
  summary: "Rent a product for dates",
  description: "Replaces create_rental_order().",
  request: {
    body: jsonBody(
      z
        .object({
          vendorId: idParam,
          productId: idParam,
          quantity: z.number().int(),
          startDate: z.iso.date(),
          endDate: z.iso.date(),
          delivery: Delivery,
        })
        .openapi("RentalCheckoutRequest"),
    ),
  },
  responses: { 201: dataResponse(Created, "The order."), ...errors },
});

export const cart = defineRoute({
  method: "post",
  path: "/checkout/cart",
  ...write,
  summary: "Order a shop's cart lines",
  description: "Replaces create_cart_order(): items [{ product_id, variant_id?, quantity }].",
  request: {
    body: jsonBody(
      z
        .object({ vendorId: idParam, items: z.array(z.looseObject({})).max(200), delivery: Delivery, buyerNote: z.string().max(2000).nullish() })
        .openapi("CartCheckoutRequest"),
    ),
  },
  responses: { 201: dataResponse(Created, "The order."), ...errors },
});

export const pkg = defineRoute({
  method: "post",
  path: "/checkout/package",
  ...write,
  summary: "Order a package",
  description: "Replaces create_package_order().",
  request: { body: jsonBody(z.object({ packageId: idParam, delivery: Delivery }).openapi("PackageCheckoutRequest")) },
  responses: { 201: dataResponse(Created, "The order."), ...errors },
});

