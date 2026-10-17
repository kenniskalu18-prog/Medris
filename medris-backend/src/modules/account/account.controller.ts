import { controller, created, ok } from "../../shared/http/route.js";
import * as routes from "./account.routes.js";

/** The user's own account - see account.routes.ts for the contract. */
export const accountController = controller()
  .route(routes.acceptLegalTerms, async ({ services, identity }) => ok(await services.account.acceptLegalTerms(identity)))
  .route(routes.legalTermsConsent, async ({ services, identity }) => ok(await services.account.legalTermsConsent(identity)))
  .route(routes.syncRole, async ({ services, identity }) => ok(await services.account.syncRole(identity)))
  .route(routes.myAppeal, async ({ services, identity }) => ok(await services.account.myAppeal(identity)))
  .route(routes.submitAppeal, async ({ services, identity, input }) => ok(await services.account.submitAppeal(identity, input.body.message)))
  .route(routes.recordAuthActivity, async ({ services, identity, input }) =>
    ok(await services.account.recordAuthActivity(identity, input.body.eventType, input.body.userAgent)),
  )
  .route(routes.requestPasswordReset, async ({ services, input }) => created(await services.account.requestReset(input.body.email)))
  .route(routes.passwordResetStatus, async ({ services, input }) => ok(await services.account.resetStatus(input.params.requestId, input.query.token)))
  .route(routes.completePasswordReset, async ({ services, input }) =>
    ok(await services.account.completeReset(input.params.requestId, input.body.token, input.body.newPassword)),
  );
