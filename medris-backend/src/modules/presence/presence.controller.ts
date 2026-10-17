import { controller, ok } from "../../shared/http/route.js";
import * as routes from "./presence.routes.js";

/** Presence - see presence.routes.ts for the contract. */
export const presenceController = controller()
  .route(routes.touchPresence, async ({ services, identity }) => ok(await services.presence.touch(identity)))
  .route(routes.clearPresence, async ({ services, identity }) => ok(await services.presence.clear(identity)))
  .route(routes.touchLastSeen, async ({ services, identity }) => ok(await services.presence.touchLastSeen(identity)))
  .route(routes.conversationPresence, async ({ services, identity, input }) =>
    ok(await services.presence.conversationPresence(identity, input.params.conversationId)),
  );
