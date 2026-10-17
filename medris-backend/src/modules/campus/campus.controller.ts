import { controller, ok } from "../../shared/http/route.js";
import * as routes from "./campus.routes.js";

/** Campus schools - see campus.routes.ts for the contract. */
export const campusController = controller()
  .route(routes.schoolNames, async ({ services }) => ok(await services.campus.schoolNames()))
  .route(routes.submitSchool, async ({ services, identity, input }) => ok(await services.campus.submit(identity, input.body.name ?? null)))
  .route(routes.pendingSchools, async ({ services, identity }) => ok(await services.campus.pending(identity)))
  .route(routes.reviewSchool, async ({ services, identity, input }) =>
    ok(await services.campus.review(identity, input.body.nameNorm, input.body.action, input.body.target ?? null)),
  );
