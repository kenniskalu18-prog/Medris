import { controller, ok } from "../../shared/http/route.js";
import * as routes from "./admin-dashboard.routes.js";

/** Admin dashboard - see admin-dashboard.routes.ts for the contract. */
export const adminDashboardController = controller()
  .route(routes.dashboardCounts, async ({ services, user, input }) => ok(await services.adminDashboard.counts(user(), input.query.since)))
  .route(routes.loginLog, async ({ services, user, input }) => ok(await services.adminDashboard.loginLog(user(), input.query.since ?? null)))
  .route(routes.actionLog, async ({ services, user }) => ok(await services.adminDashboard.actionLog(user())))
  .route(routes.logAction, async ({ services, user, input }) =>
    ok(await services.adminDashboard.logAction(user(), { action: input.body.action, targetType: input.body.targetType, targetId: input.body.targetId ?? null, targetLabel: input.body.targetLabel ?? null })),
  )
  .route(routes.disputesQueue, async ({ services, user }) => ok(await services.adminDashboard.disputesQueue(user())));
