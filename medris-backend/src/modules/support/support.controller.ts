import { controller, created, ok } from "../../shared/http/route.js";
import * as routes from "./support.routes.js";

/** Support - see support.routes.ts for the contract. */
export const supportController = controller()
  .route(routes.myRequests, async ({ services, user }) => ok(await services.support.mine(user())))
  .route(routes.createRequest, async ({ services, user, input }) => created(await services.support.create(user(), input.body.subject, input.body.message)))
  .route(routes.setAttachments, async ({ services, user, input }) => ok(await services.support.setAttachments(user(), input.params.requestId, input.body.attachments)))
  .route(routes.deleteRequest, async ({ services, user, input }) => ok(await services.support.remove(user(), input.params.requestId)))
  .route(routes.allRequests, async ({ services, user }) => ok(await services.support.all(user())))
  .route(routes.answerRequest, async ({ services, user, input }) => ok(await services.support.answer(user(), input.params.requestId, input.body.status, input.body.admin_reply)));
