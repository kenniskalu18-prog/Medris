import { controller, created, ok } from "../../shared/http/route.js";
import * as routes from "./payment-claims.routes.js";

/** Payment claims and disputes - see payment-claims.routes.ts for the contract. */
export const paymentClaimsController = controller()
  .route(routes.report, async ({ services, identity, input }) => ok(await services.paymentClaims.report(identity, input.params.orderId, input.body.amount ?? null)))
  .route(routes.vendorConfirm, async ({ services, identity, input }) => ok(await services.paymentClaims.vendorConfirm(identity, input.params.orderId)))
  .route(routes.vendorDispute, async ({ services, identity, input }) => ok(await services.paymentClaims.vendorDispute(identity, input.params.orderId, input.body.reason ?? null)))
  .route(routes.vendorConfirmUnreported, async ({ services, identity, input }) => ok(await services.paymentClaims.vendorConfirmUnreported(identity, input.params.orderId)))
  .route(routes.vendorDisputeUnreported, async ({ services, identity, input }) =>
    ok(await services.paymentClaims.vendorDisputeUnreported(identity, input.params.orderId, input.body.reason ?? null)),
  )
  .route(routes.adminConfirm, async ({ services, identity, input }) => ok(await services.paymentClaims.adminConfirm(identity, input.params.orderId, input.body.notes ?? null)))
  .route(routes.adminReject, async ({ services, identity, input }) => ok(await services.paymentClaims.adminReject(identity, input.params.orderId, input.body.notes ?? null)))
  .route(routes.recordOffline, async ({ services, identity, input }) =>
    ok(await services.paymentClaims.recordOffline(identity, input.params.orderId, input.body.paymentType, input.body.amount ?? null, input.body.method)),
  )
  .route(routes.raise, async ({ services, identity, input }) =>
    created(await services.paymentClaims.raise(identity, input.params.orderId, input.body.reason ?? null, input.body.attachments)),
  )
  .route(routes.resolve, async ({ services, identity, input }) =>
    ok(await services.paymentClaims.resolve(identity, input.params.disputeId, input.body.notes ?? null, input.body.orderStatus ?? null)),
  )
  .route(routes.respond, async ({ services, identity, input }) => ok(await services.paymentClaims.respond(identity, input.params.disputeId, input.body.response ?? null)))
  .route(routes.cancelOverdue, async ({ services, identity, input }) => ok(await services.paymentClaims.cancelOverdue(identity, input.params.orderId)));
