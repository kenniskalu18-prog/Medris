import { controller, ok } from "../../shared/http/route.js";
import * as routes from "./calls.routes.js";

/** Voice calls - see calls.routes.ts for the contract. */
export const callsController = controller()
  .route(routes.canCall, async ({ services, identity, input }) => ok(await services.calls.canCall(identity, input.params.conversationId)))
  .route(routes.callParty, async ({ services, identity, input }) => ok(await services.calls.party(identity, input.params.conversationId)))
  .route(routes.startCall, async ({ services, identity, input }) => ok(await services.calls.start(identity, input.params.conversationId)))
  .route(routes.ringAgain, async ({ services, identity, input }) => ok(await services.calls.ringAgain(identity, input.params.callId)))
  .route(routes.updateCall, async ({ services, identity, input }) => ok(await services.calls.update(identity, input.params.callId, input.body.status)))
  .route(routes.callLog, async ({ services, user, input }) => ok(await services.calls.callLog(user(), input.params.conversationId)))
  .route(routes.ringingCalls, async ({ services, user, input }) => ok(await services.calls.ringing(user(), input.query.since)))
  .route(routes.callStatus, async ({ services, user, input }) => ok(await services.calls.callStatus(user(), input.params.callId)));
