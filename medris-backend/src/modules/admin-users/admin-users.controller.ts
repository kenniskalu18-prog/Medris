import { controller, ok } from "../../shared/http/route.js";
import * as routes from "./admin-users.routes.js";

/** Admin: accounts - see admin-users.routes.ts for the contract. */
export const adminUsersController = controller()
  .route(routes.pendingAppeals, async ({ services, identity }) => ok(await services.adminUsers.pendingAppeals(identity)))
  .route(routes.denyAppeal, async ({ services, identity, input }) => ok(await services.adminUsers.denyAppeal(identity, input.params.appealId, input.body.response)))
  .route(routes.setUserRole, async ({ services, identity, input }) => ok(await services.adminUsers.setRole(identity, input.body.email, input.body.role)))
  .route(routes.suspendUser, async ({ services, identity, input }) => ok(await services.adminUsers.suspend(identity, input.params.userId, input.body.reason)))
  .route(routes.unsuspendUser, async ({ services, identity, input }) => ok(await services.adminUsers.unsuspend(identity, input.params.userId)))
  .route(routes.passwordResetRequests, async ({ services, identity }) => ok(await services.adminUsers.resetRequests(identity)))
  .route(routes.approvePasswordReset, async ({ services, identity, input }) => ok(await services.adminUsers.approveReset(identity, input.params.requestId)))
  .route(routes.rejectPasswordReset, async ({ services, identity, input }) => ok(await services.adminUsers.rejectReset(identity, input.params.requestId)));
