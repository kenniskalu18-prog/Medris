import { defineRoute } from "../../shared/http/route.js";
import { z } from "../../shared/openapi/zod.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { OrderParams, commonErrors, dataResponse, errorResponses } from "../../shared/openapi/schemas.js";
import { requireUser } from "../../middleware/auth.js";
import { signedIn } from "../../shared/openapi/security.js";

/** Paying for an order with Paystack (needs the PAYSTACK_CHECKOUT_ENABLED switch). */

const tags = ["Payments"];
const startLimit = rateLimit({ name: "paystack-initialize", limit: 20, windowMs: 60_000 });
const readLimit = rateLimit({ name: "paystack-status", limit: 120, windowMs: 60_000 });

const InitializeResult = z
  .object({
    authorizationUrl: z.string(),
    accessCode: z.string(),
    reference: z.string(),
    amountNaira: z.number().describe("What the buyer pays now: the order amount plus Paystack's fee."),
    feeNaira: z.number().describe("Paystack's fee, paid by the buyer."),
    orderAmountNaira: z.number().describe("The part of the payment that goes to the order."),
  })
  .openapi("PaystackInitializeResult");

export const paymentsConfig = defineRoute({
  method: "get",
  path: "/payments/config",
  tags,
  summary: "Is Paystack checkout switched on?",
  description: "Tells the app whether to offer \"Pay now (Paystack)\". Controlled by `PAYSTACK_CHECKOUT_ENABLED` (default off).",
  security: signedIn,
  middleware: [requireUser] as const,
  responses: { 200: dataResponse(z.object({ paystackCheckout: z.boolean() }).openapi("PaymentsConfig"), "The switch."), ...errorResponses(401), ...commonErrors },
});

export const initializePayment = defineRoute({
  method: "post",
  path: "/orders/{orderId}/paystack/initialize",
  tags,
  security: signedIn,
  middleware: [requireUser, startLimit] as const,
  summary: "Start a Paystack payment for an order",
  description:
    "The caller must be the order's buyer. The amount comes only from the database: the full total for pay-before, the delivery deposit " +
    "for pay-after-delivery, then the balance after delivery; **plus Paystack's fee, which the buyer pays**. A double tap returns the same " +
    "link; if the order's amount changed the old attempt is abandoned. The order is only confirmed when Paystack confirms the payment. " +
    "404 `feature_disabled` while the switch is off.",
  request: { params: OrderParams },
  responses: { 200: dataResponse(InitializeResult, "Open `authorizationUrl` (or use `accessCode` with Paystack Inline)."), ...errorResponses(400, 403, 404, 409, 429, 503), ...commonErrors },
});

export const paymentStatus = defineRoute({
  method: "get",
  path: "/payments/paystack/{reference}",
  tags,
  security: signedIn,
  middleware: [requireUser, readLimit] as const,
  summary: "Where a Paystack payment stands",
  description:
    "For the payment's buyer or an admin. While the payment is still open, asks Paystack and settles it through the same steps as the " +
    "webhook (so the app does not wait for the webhook). Answers `{ status, orderStatus }`.",
  request: { params: z.object({ reference: z.string().min(1).max(100) }) },
  responses: {
    200: dataResponse(z.object({ status: z.string(), orderStatus: z.string().nullable() }).openapi("PaystackPaymentStatus"), "The payment and order status."),
    ...errorResponses(401, 404, 429),
    ...commonErrors,
  },
});
