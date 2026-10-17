import { controller, created, ok } from "../../shared/http/route.js";
import * as routes from "./service-offers.routes.js";

/** Service bookings - see service-offers.routes.ts for the contract. */
export const serviceOffersController = controller()
  .route(routes.createOffer, async ({ services, identity, input }) =>
    created(await services.serviceOffers.create(identity, input.body.listingId, input.body.description, input.body.price)),
  )
  .route(routes.respondOffer, async ({ services, identity, input }) =>
    ok(await services.serviceOffers.respond(identity, input.params.offerId, input.body.action, input.body.price, input.body.expectedPrice)),
  )
  .route(routes.reportPayment, async ({ services, identity, input }) => ok(await services.serviceOffers.reportPayment(identity, input.params.orderId, input.body.amount)))
  .route(routes.confirmPayment, async ({ services, identity, input }) => ok(await services.serviceOffers.confirmPayment(identity, input.params.offerId)))
  .route(routes.disputePayment, async ({ services, identity, input }) => ok(await services.serviceOffers.disputePayment(identity, input.params.offerId)))
  .route(routes.offersForListing, async ({ services, user, input }) => ok(await services.serviceOffers.forListing(user(), input.query.listingId)))
  .route(routes.getOffer, async ({ services, user, input }) => ok(await services.serviceOffers.one(user(), input.params.offerId)));
