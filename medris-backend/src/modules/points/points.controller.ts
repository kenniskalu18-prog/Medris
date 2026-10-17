import { controller, ok } from "../../shared/http/route.js";
import * as routes from "./points.routes.js";

/** Points and referrals - see points.routes.ts for the contract. */
export const pointsController = controller()
  .route(routes.leaderboard, async ({ services, identity, input }) => ok(await services.points.leaderboard(identity, input.query.period, input.query.limit ?? null)))
  .route(routes.pastWinners, async ({ services, input }) => ok(await services.points.pastWinners(input.query.limit ?? null)))
  .route(routes.spotlight, async ({ services, identity }) => ok(await services.points.spotlight(identity)))
  .route(routes.mySummary, async ({ services, identity }) => ok(await services.points.summary(identity)))
  .route(routes.myActivity, async ({ services, identity, input }) => ok(await services.points.activity(identity, input.query.limit ?? null, input.query.before ?? null)))
  .route(routes.validateCode, async ({ services, input }) => ok(await services.points.validateCode(input.query.code)))
  .route(routes.applyCode, async ({ services, identity, input }) => ok(await services.points.applyCode(identity, input.body.code ?? null)))
  .route(routes.adjust, async ({ services, identity, input }) =>
    ok(await services.points.adjust(identity, input.body.userId, input.body.points ?? null, input.body.note ?? null)),
  )
  .route(routes.awardSocial, async ({ services, identity, input }) =>
    ok(await services.points.awardSocial(identity, input.body.phone ?? null, input.body.platform ?? null)),
  )
  .route(routes.recentAdjustments, async ({ services, identity, input }) => ok(await services.points.recentAdjustments(identity, input.params.userId)))
  .route(routes.recentSkips, async ({ services, identity, input }) => ok(await services.points.recentSkips(identity, input.query.limit ?? null)))
  .route(routes.searchUsers, async ({ services, identity, input }) => ok(await services.points.searchUsers(identity, input.query.q)))
  .route(routes.pointsRules, async ({ services, identity }) => ok(await services.points.rules(identity)));
