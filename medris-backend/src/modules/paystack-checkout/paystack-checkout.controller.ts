import { controller, ok } from "../../shared/http/route.js";
import * as routes from "./paystack-checkout.routes.js";

/** /api/v1/orders/{id}/paystack/initialize and /api/v1/payments/... - see paystack-checkout.routes.ts. */
export const paystackCheckoutController = controller()
  .route(routes.paymentsConfig, ({ services }) => ok(services.paystackCheckout.config()))
  .route(routes.initializePayment, async ({ services, user, input, req }) =>
    ok(await services.paystackCheckout.initialize(user(), input.params.orderId, services.config.appOrigin || (req.get("origin") ?? ""))),
  )
  .route(routes.paymentStatus, async ({ services, user, input }) => ok(await services.paystackCheckout.status(user(), input.params.reference)));
