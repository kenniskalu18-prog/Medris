import { controller, created, ok } from "../../shared/http/route.js";
import * as routes from "./order-actions.routes.js";

/** Order actions - see order-actions.routes.ts for the contract. */
export const orderActionsController = controller()
  // Fixed paths before /orders/{orderId}.
  .route(routes.orderCounts, async ({ services, user, input }) => ok(await services.orderActions.orderCounts(user(), input.query.vendorId ?? null, input.query.since ?? null)))
  .route(routes.completedBetween, async ({ services, user, input }) => ok(await services.orderActions.completedBetween(user(), input.query.buyerId, input.query.vendorId)))
  .route(routes.orderList, async ({ services, user, input }) =>
    ok(
      await services.orderActions.orderList(user(), {
        side: input.query.side,
        vendorId: input.query.vendorId ?? null,
        statuses: input.query.status ?? null,
        payoutStatus: input.query.payoutStatus ?? null,
        escalated: input.query.escalated,
        createdFrom: input.query.createdFrom ?? null,
        createdTo: input.query.createdTo ?? null,
        orderBy: input.query.orderBy,
        limit: input.query.limit,
      }),
    ),
  )
  .route(routes.buyerNames, async ({ services, identity, input }) => ok(await services.orderActions.buyerNames(identity, input.query.orderIds)))
  .route(routes.transition, async ({ services, identity, input }) => ok(await services.orderActions.transition(identity, input.params.orderId, input.body.status)))
  .route(routes.confirmReceived, async ({ services, identity, input }) => ok(await services.orderActions.confirmReceived(identity, input.params.orderId)))
  .route(routes.decline, async ({ services, identity, input }) => ok(await services.orderActions.decline(identity, input.params.orderId, input.body.reason)))
  .route(routes.addNote, async ({ services, identity, input }) => created(await services.orderActions.addNote(identity, input.params.orderId, input.body.body)))
  .route(routes.editPending, async ({ services, identity, input }) =>
    ok(
      await services.orderActions.editPending(
        identity,
        input.params.orderId,
        input.body.items,
        input.body.buyerNote ?? null,
        input.body.deliveryAddress ?? null,
        input.body.deliveryPhone ?? null,
      ),
    ),
  )
  .route(routes.buyerContact, async ({ services, identity, input }) => ok(await services.orderActions.buyerContact(identity, input.params.orderId)))
  .route(routes.remind, async ({ services, identity, input }) => ok(await services.orderActions.remind(identity, input.params.orderId)))
  .route(routes.setLocation, async ({ services, identity, input }) =>
    ok(await services.orderActions.setLocation(identity, input.params.orderId, input.body.lat ?? null, input.body.lng ?? null)),
  )
  .route(routes.suggestQuantity, async ({ services, identity, input }) =>
    ok(await services.orderActions.suggestQuantity(identity, input.params.orderId, input.body.items, input.body.note ?? null)),
  )
  .route(routes.respondToProposal, async ({ services, identity, input }) => ok(await services.orderActions.respondToProposal(identity, input.params.orderId, input.body.accept)))
  .route(routes.listNotes, async ({ services, user, input }) => ok(await services.orderActions.notes(user(), input.params.orderId)))
  .route(routes.listPayments, async ({ services, user, input }) => ok(await services.orderActions.payments(user(), input.params.orderId)))
  .route(routes.orderDetail, async ({ services, user, input }) => ok(await services.orderActions.orderDetail(user(), input.params.orderId)));
