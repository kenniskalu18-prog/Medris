import { controller, created, ok } from "../../shared/http/route.js";
import * as routes from "./conversations.routes.js";

/** Buyer-shop chat - see conversations.routes.ts for the contract. */
export const conversationsController = controller()
  .route(routes.openConversation, async ({ services, identity, input }) => ok(await services.conversations.open(identity, input.body.vendorId)))
  .route(routes.listConversations, async ({ services, identity }) => ok(await services.conversations.list(identity)))
  .route(routes.conversationIsOpen, async ({ services, identity, input }) => ok(await services.conversations.isOpen(identity, input.params.conversationId)))
  .route(routes.markConversationOpened, async ({ services, identity, input }) => ok(await services.conversations.markOpened(identity, input.params.conversationId)))
  .route(routes.conversationOtherParty, async ({ services, identity, input }) => ok(await services.conversations.otherParty(identity, input.params.conversationId)))
  .route(routes.togglePin, async ({ services, identity, input }) => ok(await services.conversations.togglePin(identity, input.params.conversationId)))
  .route(routes.toggleUnread, async ({ services, identity, input }) => ok(await services.conversations.toggleUnread(identity, input.params.conversationId)))
  .route(routes.deleteMessage, async ({ services, identity, input }) => ok(await services.conversations.deleteMessage(identity, input.params.messageId)))
  .route(routes.editMessage, async ({ services, identity, input }) => ok(await services.conversations.editMessage(identity, input.params.messageId, input.body.body)))
  .route(routes.toggleReaction, async ({ services, identity, input }) =>
    ok(await services.conversations.toggleReaction(identity, input.params.messageId, input.body.emoji)),
  )
  .route(routes.listChatLists, async ({ services, identity }) => ok(await services.conversations.lists(identity)))
  .route(routes.createChatList, async ({ services, identity, input }) => created(await services.conversations.createList(identity, input.body.name)))
  .route(routes.deleteChatList, async ({ services, identity, input }) => ok(await services.conversations.deleteList(identity, input.params.listId)))
  .route(routes.toggleInList, async ({ services, identity, input }) =>
    ok(await services.conversations.toggleInList(identity, input.params.listId, input.params.conversationId)),
  )
  .route(routes.adminFindConversation, async ({ services, identity, input }) =>
    ok(await services.conversations.adminFind(identity, input.query.buyerId, input.query.vendorId)),
  )
  .route(routes.adminListConversations, async ({ services, identity, input }) =>
    ok(await services.conversations.adminList(identity, input.query.search ?? null, input.query.limit ?? null)),
  )
  .route(routes.adminConversationParticipants, async ({ services, identity, input }) =>
    ok(await services.conversations.adminParticipants(identity, input.params.conversationId)),
  )
  .route(routes.listMessagePins, async ({ services, user, input }) => ok(await services.conversations.messagePins(user(), input.params.conversationId)))
  .route(routes.pinMessage, async ({ services, user, input }) => ok(await services.conversations.pinMessage(user(), input.params.conversationId, input.params.messageId)))
  .route(routes.unpinMessage, async ({ services, user, input }) => ok(await services.conversations.unpinMessage(user(), input.params.conversationId, input.params.messageId)))
  .route(routes.getConversation, async ({ services, user, input }) => ok(await services.conversations.conversation(user(), input.params.conversationId)))
  .route(routes.directConversation, async ({ services, user, input }) => ok(await services.conversations.direct(user(), input.body.buyerId, input.body.vendorId)))
  .route(routes.listMessages, async ({ services, user, input }) => ok(await services.conversations.messages(user(), input.params.conversationId, input.query)))
  .route(routes.messagePreviews, async ({ services, user, input }) => ok(await services.conversations.messagePreviews(user(), input.query.ids)))
  .route(routes.sendMessage, async ({ services, user, input }) =>
    created(
      await services.conversations.sendMessage(user(), input.params.conversationId, {
        body: input.body.body,
        replyToId: input.body.replyToId ?? null,
        attachment: input.body.attachment
          ? { url: input.body.attachment.url, name: input.body.attachment.name ?? null, type: input.body.attachment.type ?? null, size: input.body.attachment.size ?? null }
          : null,
      }),
    ),
  )
  .route(routes.markMessagesRead, async ({ services, user, input }) => ok(await services.conversations.markMessagesRead(user(), input.body.ids)))
  .route(routes.markMessagesDelivered, async ({ services, user }) => ok(await services.conversations.markMessagesDelivered(user())));
