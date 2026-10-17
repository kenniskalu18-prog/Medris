import { controller, created, ok } from "../../shared/http/route.js";
import * as routes from "./requests.routes.js";

/** Requests - see requests.routes.ts for the contract. */
export const requestsController = controller()
  .route(routes.myRequests, async ({ services, user }) => ok(await services.requests.mine(user())))
  .route(routes.openRequests, async ({ services, identity }) => ok(await services.requests.open(identity)))
  .route(routes.createRequest, async ({ services, user, input }) =>
    created(
      await services.requests.create(user(), {
        title: input.body.title,
        description: input.body.description ?? null,
        category_id: input.body.category_id ?? null,
        city: input.body.city ?? null,
        needed_from: input.body.needed_from ?? null,
        needed_to: input.body.needed_to ?? null,
        request_type: input.body.request_type,
        photos: input.body.photos,
        campus_id: input.body.campus_id ?? null,
      }),
    ),
  )
  .route(routes.cancelRequest, async ({ services, user, input }) => ok(await services.requests.cancel(user(), input.params.requestId)))
  .route(routes.offer, async ({ services, user, input }) =>
    created(await services.requests.offer(user(), input.params.requestId, input.body.vendorId, input.body.message ?? null, input.body.price ?? null)),
  );
