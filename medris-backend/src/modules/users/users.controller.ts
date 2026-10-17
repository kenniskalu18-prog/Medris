import { controller, ok } from "../../shared/http/route.js";
import * as routes from "./users.routes.js";

/** /api/v1/me - see users.routes.ts for the contract. */
export const usersController = controller()
  .route(routes.getMe, async ({ services, user }) => ok(await services.users.me(user())))
  .route(routes.getProfile, async ({ services, user }) => ok(await services.users.profile(user())))
  .route(routes.updateProfile, async ({ services, user, input }) => ok(await services.users.updateProfile(user(), input.body)))
  .route(routes.selectRole, async ({ services, user }) => ok(await services.users.selectRole(user())))
  .route(routes.peopleCounts, async ({ services, user }) => ok(await services.users.counts(user())))
  .route(routes.people, async ({ services, user }) => ok(await services.users.people(user())))
  .route(routes.adminsList, async ({ services, user }) => ok(await services.users.admins(user())))
  .route(routes.usersByIds, async ({ services, user, input }) => ok(await services.users.byIds(user(), input.query.ids)));
