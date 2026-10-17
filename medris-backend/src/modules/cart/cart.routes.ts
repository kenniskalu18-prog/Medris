import { defineRoute } from "../../shared/http/route.js";
import { z } from "../../shared/openapi/zod.js";
import { requireUser } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { commonErrors, CountSchema, dataResponse, errorResponses, IdParams, jsonBody, ProductParams } from "../../shared/openapi/schemas.js";
import { signedIn } from "../../shared/openapi/security.js";
import { AddToCartBody, AddToCartResult, BulkDeleteBody, CartItemSchema, RemovedResult, SetQuantityBody, SetQuantityResult } from "./cart.schemas.js";

/**
 * Route definitions (the API contract) of the signed-in buyer's cart.
 * Rules that already live in the database stay there: add_to_cart() refuses
 * your own products and inactive listings, and a trigger blocks self-purchase
 * on every write.
 */

const tags = ["Cart"];
const writeLimit = rateLimit({ name: "cart-write", limit: 120, windowMs: 60_000 });
const readErrors = { ...errorResponses(401), ...commonErrors };
const writeErrors = { ...errorResponses(400, 401, 415, 429), ...commonErrors };

export const listCart = defineRoute({
  method: "get",
  path: "/cart",
  tags,
  summary: "List the cart",
  description: "Items oldest first, each with its variant, product and the product's vendor.",
  security: signedIn,
  middleware: [requireUser] as const,
  responses: { 200: dataResponse(z.array(CartItemSchema), "The cart items."), ...readErrors },
});

export const countCart = defineRoute({
  method: "get",
  path: "/cart/count",
  tags,
  summary: "Count cart rows (header badge)",
  security: signedIn,
  middleware: [requireUser] as const,
  responses: { 200: dataResponse(CountSchema, "Number of rows."), ...readErrors },
});

export const addToCart = defineRoute({
  method: "post",
  path: "/cart/items",
  tags,
  summary: "Add a product",
  description: "Runs add_to_cart(): checks the product, refuses your own products, merges quantities.",
  security: signedIn,
  middleware: [requireUser, writeLimit] as const,
  request: { body: jsonBody(AddToCartBody) },
  responses: { 201: dataResponse(AddToCartResult, "Added."), ...writeErrors },
});

export const deleteCartItems = defineRoute({
  method: "post",
  path: "/cart/items/delete",
  tags,
  summary: "Remove several items",
  description: "Checkout clean-up and stale items. Only the caller's own rows are touched.",
  security: signedIn,
  middleware: [requireUser, writeLimit] as const,
  request: { body: jsonBody(BulkDeleteBody) },
  responses: { 200: dataResponse(RemovedResult, "Number of rows removed."), ...writeErrors },
});

export const setCartQuantity = defineRoute({
  method: "patch",
  path: "/cart/items/{id}",
  tags,
  summary: "Change an item's quantity",
  security: signedIn,
  middleware: [requireUser, writeLimit] as const,
  request: { params: IdParams, body: jsonBody(SetQuantityBody) },
  responses: { 200: dataResponse(SetQuantityResult, "Updated."), ...writeErrors, ...errorResponses(404) },
});

export const removeCartItem = defineRoute({
  method: "delete",
  path: "/cart/items/{id}",
  tags,
  summary: "Remove an item",
  security: signedIn,
  middleware: [requireUser, writeLimit] as const,
  request: { params: IdParams },
  responses: { 200: dataResponse(RemovedResult, "Number of rows removed (0 when it was not in your cart)."), ...writeErrors },
});

export const clearCart = defineRoute({
  method: "delete",
  path: "/cart",
  tags,
  summary: "Empty the cart",
  security: signedIn,
  middleware: [requireUser, writeLimit] as const,
  responses: { 200: dataResponse(RemovedResult, "Number of rows removed."), ...writeErrors },
});

export const removeCartProduct = defineRoute({
  method: "delete",
  path: "/cart/products/{productId}",
  tags,
  summary: "Remove a product from the cart",
  description: 'Replaces `from("cart_items").delete().eq("buyer_id", me).eq("product_id", id)`: every line of that product.',
  security: signedIn,
  middleware: [requireUser, writeLimit] as const,
  request: { params: ProductParams },
  responses: { 200: dataResponse(RemovedResult, "Number of rows removed."), ...writeErrors },
});
