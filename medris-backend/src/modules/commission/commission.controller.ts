import { controller, created, ok } from "../../shared/http/route.js";
import * as routes from "./commission.routes.js";

/** Commission and monthly listings - see commission.routes.ts for the contract. */
export const commissionController = controller()
  .route(routes.owed, async ({ services, identity, input }) => ok(await services.commission.owed(identity, input.params.vendorId)))
  .route(routes.deadline, async ({ services, identity, input }) => ok(await services.commission.deadline(identity, input.params.vendorId)))
  .route(routes.breakdown, async ({ services, identity, input }) => ok(await services.commission.breakdown(identity, input.params.vendorId)))
  .route(routes.enforce, async ({ services, identity, input }) => ok(await services.commission.enforceDeadlines(identity, input.params.vendorId)))
  .route(routes.hourReminders, async ({ services, identity, input }) => ok(await services.commission.hourReminders(identity, input.params.vendorId)))
  .route(routes.monthlyBillingAmount, async ({ services, input }) => ok(await services.commission.monthlyBillingAmount(input.params.vendorId)))
  .route(routes.submitMonthly, async ({ services, identity, input }) =>
    created(await services.commission.submitMonthlyPayment(identity, input.body.kind, input.body.listingId, input.body.payerName ?? null, input.body.receiptPath ?? null)),
  )
  .route(routes.approveMonthly, async ({ services, identity, input }) => ok(await services.commission.approveMonthly(identity, input.params.submissionId)))
  .route(routes.rejectMonthly, async ({ services, identity, input }) => ok(await services.commission.rejectMonthly(identity, input.params.submissionId, input.body.note ?? null)))
  .route(routes.deactivateMonthly, async ({ services, identity, input }) =>
    ok(await services.commission.deactivateMonthly(identity, input.params.submissionId, input.body.note ?? null)),
  )
  .route(routes.owedCharges, async ({ services, user, input }) => ok(await services.commission.owedCharges(user(), input.params.vendorId)));
