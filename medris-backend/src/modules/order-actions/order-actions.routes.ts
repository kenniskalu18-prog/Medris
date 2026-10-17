import { defineRoute } from "../../shared/http/route.js";
import { z } from "../../shared/openapi/zod.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { commonErrors, dataResponse, DoneSchema, errorResponses, idList, idParam, isoDateTime, jsonBody, OrderParams } from "../../shared/openapi/schemas.js";
import { optionalSignIn, signedIn } from "../../shared/openapi/security.js";

/** What happens to an order after checkout. */

const tags = ["Order actions"];
const writeLimit = rateLimit({ name: "order-actions-write", limit: 60, windowMs: 60_000 });
const write = { tags, security: signedIn, middleware: [writeLimit] as const };
const writeErrors = { ...errorResponses(400, 401, 403, 404, 415, 429), ...commonErrors };
const Lines = z.array(z.looseObject({})).max(200);

export const transition = defineRoute({
  method: "post",
  path: "/orders/{orderId}/status",
  ...write,
  summary: "Move an order on",
  description: "Replaces transition_order_status(): confirm, complete, cancel, hand-over return of a rental.",
  request: { params: OrderParams, body: jsonBody(z.object({ status: z.string().max(40) }).openapi("OrderStatusRequest")) },
  responses: { 200: dataResponse(DoneSchema, "Done."), ...writeErrors },
});

export const confirmReceived = defineRoute({
  method: "post",
  path: "/orders/{orderId}/received",
  ...write,
  summary: "The buyer confirms they received it",
  description: "Replaces buyer_confirm_received().",
  request: { params: OrderParams },
  responses: { 200: dataResponse(z.object({ success: z.literal(true) }), "Completed."), ...writeErrors },
});

export const decline = defineRoute({
  method: "post",
  path: "/orders/{orderId}/decline",
  ...write,
  summary: "The vendor declines or cancels an order",
  description: "Replaces vendor_decline_order().",
  request: { params: OrderParams, body: jsonBody(z.object({ reason: z.string().max(2000).nullish() }).openapi("DeclineOrderRequest")) },
  responses: { 200: dataResponse(DoneSchema, "Declined."), ...writeErrors },
});

export const addNote = defineRoute({
  method: "post",
  path: "/orders/{orderId}/notes",
  ...write,
  summary: "Send a note on an order",
  description: "Replaces add_order_note().",
  request: { params: OrderParams, body: jsonBody(z.object({ body: z.string().max(2000).nullish() }).openapi("OrderNoteRequest")) },
  responses: { 201: dataResponse(z.object({ id: z.string() }), "The note."), ...writeErrors },
});

export const editPending = defineRoute({
  method: "put",
  path: "/orders/{orderId}/items",
  ...write,
  summary: "The buyer edits a pending order",
  description: "Replaces edit_pending_order(): items [{ order_item_id, quantity }] (0 removes a line), note and delivery details.",
  request: {
    params: OrderParams,
    body: jsonBody(
      z
        .object({
          items: Lines,
          buyerNote: z.string().max(2000).nullish(),
          deliveryAddress: z.string().max(1000).nullish(),
          deliveryPhone: z.string().max(40).nullish(),
        })
        .openapi("EditOrderRequest"),
    ),
  },
  responses: { 200: dataResponse(DoneSchema, "Saved."), ...writeErrors },
});

export const buyerContact = defineRoute({
  method: "get",
  path: "/orders/{orderId}/buyer-contact",
  tags,
  security: optionalSignIn,
  summary: "The buyer's name for the vendor",
  description: "Replaces get_order_buyer_contact(): hidden until the order is accepted; admins also see the phone.",
  request: { params: OrderParams },
  responses: { 200: dataResponse(z.array(z.object({ name: z.string().nullable(), phone: z.string().nullable() })), "Zero or one row."), ...errorResponses(400), ...commonErrors },
});

export const buyerNames = defineRoute({
  method: "get",
  path: "/orders/buyer-names",
  tags,
  security: optionalSignIn,
  summary: "Buyers' names for several orders",
  description: "Replaces get_orders_buyer_names().",
  request: { query: z.object({ orderIds: idList("Order ids.") }) },
  responses: { 200: dataResponse(z.array(z.object({ order_id: z.string(), name: z.string().nullable() })), "Rows."), ...errorResponses(400), ...commonErrors },
});

export const remind = defineRoute({
  method: "post",
  path: "/orders/{orderId}/reminder",
  ...write,
  summary: "Remind the vendor about a pending order",
  description: "Replaces send_order_reminder().",
  request: { params: OrderParams },
  responses: { 200: dataResponse(z.object({ id: z.string() }), "The notification."), ...writeErrors },
});

export const setLocation = defineRoute({
  method: "put",
  path: "/orders/{orderId}/buyer-location",
  ...write,
  summary: "Where to deliver",
  description: "Replaces set_order_buyer_location(): pending delivery orders only.",
  request: { params: OrderParams, body: jsonBody(z.object({ lat: z.number().nullish(), lng: z.number().nullish() }).openapi("BuyerLocationRequest")) },
  responses: { 200: dataResponse(DoneSchema, "Saved."), ...writeErrors },
});

export const suggestQuantity = defineRoute({
  method: "post",
  path: "/orders/{orderId}/quantity-suggestion",
  ...write,
  summary: "The vendor suggests smaller quantities",
  description: "Replaces vendor_suggest_order_quantity(): items [{ id, quantity }].",
  request: { params: OrderParams, body: jsonBody(z.object({ items: Lines, note: z.string().max(2000).nullish() }).openapi("SuggestQuantityRequest")) },
  responses: { 200: dataResponse(z.object({ order_id: z.string(), summary: z.string() }), "Suggested."), ...writeErrors },
});

export const respondToProposal = defineRoute({
  method: "post",
  path: "/orders/{orderId}/quantity-suggestion/response",
  ...write,
  summary: "The buyer accepts or refuses the suggestion",
  description: "Replaces buyer_respond_quantity_proposal().",
  request: { params: OrderParams, body: jsonBody(z.object({ accept: z.boolean() }).openapi("QuantityResponseRequest")) },
  responses: { 200: dataResponse(z.object({ order_id: z.string(), accepted: z.boolean() }), "Done."), ...writeErrors },
});

export const listNotes = defineRoute({
  method: "get",
  path: "/orders/{orderId}/notes",
  tags,
  summary: "An order's notes",
  description: 'Replaces `from("order_notes").select("id,sender_id,body,created_at").eq("order_id", id).order("created_at").limit(60)`. Others get an empty list.',
  security: signedIn,
  request: { params: OrderParams },
  responses: {
    200: dataResponse(z.array(z.object({ id: z.string(), sender_id: z.string(), body: z.string(), created_at: z.string() })), "Oldest first."),
    ...errorResponses(400, 401),
    ...commonErrors,
  },
});

export const listPayments = defineRoute({
  method: "get",
  path: "/orders/{orderId}/payments",
  tags,
  summary: "An order's payments",
  description: 'Replaces `from("payments").select("id,status,amount")` and `select("payment_type,status")` `.eq("order_id", id)`. Others get an empty list.',
  security: signedIn,
  request: { params: OrderParams },
  responses: {
    200: dataResponse(z.array(z.object({ id: z.string(), payment_type: z.string(), status: z.string(), amount: z.number() })), "The payments."),
    ...errorResponses(400, 401),
    ...commonErrors,
  },
});

const OrderRow = z.record(z.string(), z.unknown());
const csv = (description: string) =>
  z
    .string()
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.enum(["pending", "confirmed", "handed_over", "completed", "cancelled", "disputed", "payment_unresolved", "returned"])).max(10))
    .openapi({ description, example: "pending,confirmed" });

export const orderDetail = defineRoute({
  method: "get",
  path: "/orders/{orderId}",
  tags,
  summary: "One order, as the order page shows it",
  description:
    'Replaces `from("orders").select("*, vendor:vendors(...), items:order_items(*, variant:product_variants(name), product:products(...)), payments(*), review:reviews(id), disputes(...), package:vendor_packages(name)")` ' +
    "and every narrower select of one order. Null when the caller is not its buyer, its shop or an admin.",
  security: signedIn,
  request: { params: OrderParams },
  responses: { 200: dataResponse(OrderRow.nullable(), "The order."), ...errorResponses(400, 401), ...commonErrors },
});

export const orderList = defineRoute({
  method: "get",
  path: "/orders",
  tags,
  summary: "Order lists",
  description:
    "Replaces the order lists' selects on orders (purchases, sales, earnings, sold items, Levi's orders, escalated payments, the live-update check): " +
    "every column, with buyer (name), shop (name, city, logo), items (with product) and payments.",
  security: signedIn,
  request: {
    query: z.object({
      side: z.enum(["buyer", "vendor", "either"]).default("buyer"),
      vendorId: idParam.optional(),
      status: csv("Statuses.").optional(),
      payoutStatus: z.string().max(40).optional(),
      escalated: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
      createdFrom: isoDateTime.optional(),
      createdTo: isoDateTime.optional(),
      orderBy: z.enum(["created_at", "payout_released_at", "payment_escalated_at"]).default("created_at"),
      limit: z.coerce.number().int().min(1).max(1000).default(1000),
    }),
  },
  responses: { 200: dataResponse(z.array(OrderRow), "The orders."), ...errorResponses(400, 401), ...commonErrors },
});

export const orderCounts = defineRoute({
  method: "get",
  path: "/orders/counts",
  tags,
  summary: "Order badges and profile numbers",
  description: "Replaces the head-count queries on orders: the caller's open and all purchases (and per open status), the shop's open sales and those since a time.",
  security: signedIn,
  request: { query: z.object({ vendorId: idParam.optional(), since: isoDateTime.optional() }) },
  responses: { 200: dataResponse(z.record(z.string(), z.unknown()), "The counts."), ...errorResponses(400, 401), ...commonErrors },
});

export const completedBetween = defineRoute({
  method: "get",
  path: "/orders/completed-between",
  tags,
  summary: "Whether a buyer has a completed order with a shop",
  description: 'Replaces `from("orders").select("id", { count: "exact", head: true }).eq("buyer_id", b).eq("vendor_id", v).eq("status", "completed")`.',
  security: signedIn,
  request: { query: z.object({ buyerId: idParam, vendorId: idParam }) },
  responses: { 200: dataResponse(z.object({ completed: z.boolean() }), "The answer."), ...errorResponses(400, 401), ...commonErrors },
});
