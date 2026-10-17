import { controller, created, ok } from "../../shared/http/route.js";
import * as routes from "./assistant.routes.js";

/** Levi's saved conversations - see assistant.routes.ts for the contract. */
export const assistantController = controller()
  .route(routes.searchConversations, async ({ services, identity, input }) => ok(await services.assistant.search(identity, input.query.q)))
  .route(routes.sharedConversation, async ({ services, input }) => ok(await services.assistant.shared(input.params.token)))
  .route(routes.setConversationShared, async ({ services, user, input }) =>
    ok(await services.assistant.setShared(user(), input.params.conversationId, input.body.shared)),
  )
  .route(routes.toggleMessageReaction, async ({ services, user, input }) =>
    ok(await services.assistant.toggleReaction(user(), input.params.messageId, input.body.emoji)),
  )
  .route(routes.listHistory, async ({ services, user }) => ok(await services.assistant.history(user())))
  .route(routes.startConversation, async ({ services, user, input }) => created(await services.assistant.startConversation(user(), input.body.title ?? null)))
  .route(routes.deleteConversations, async ({ services, user, input }) => ok(await services.assistant.deleteConversations(user(), input.body.ids)))
  .route(routes.conversationMessages, async ({ services, user, input }) => ok(await services.assistant.conversationMessages(user(), input.params.conversationId)))
  .route(routes.addMessage, async ({ services, user, input }) => created(await services.assistant.addMessage(user(), input.params.conversationId, input.body.role, input.body.content)))
  .route(routes.aiMessage, async ({ services, user, input }) => ok(await services.assistant.message(user(), input.params.messageId)));
