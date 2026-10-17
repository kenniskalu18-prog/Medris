import { controller, ok } from "../../shared/http/route.js";
import * as routes from "./notifications.routes.js";

/** /api/v1/notifications - see notifications.routes.ts for the contract. */
export const notificationsController = controller()
  .route(routes.listNotifications, async ({ services, user, input }) => ok(await services.notifications.panel(user(), input.query)))
  .route(routes.unreadCount, async ({ services, user, input }) => ok(await services.notifications.unreadCount(user(), input.query)))
  .route(routes.recentUnread, async ({ services, user, input }) => ok(await services.notifications.recentUnread(user(), input.query.limit)))
  .route(routes.markRead, async ({ services, user, input }) => ok(await services.notifications.markRead(user(), input.body)))
  .route(routes.notifySelf, async ({ services, user, input }) =>
    ok(
      await services.notifications.notifySelf(user(), {
        type: input.body.type,
        title: input.body.title,
        body: input.body.body ?? null,
        targetView: input.body.targetView ?? null,
        targetParams: input.body.targetParams ?? null,
      }),
    ),
  )
  .route(routes.savePushSubscription, async ({ services, user, input }) => ok(await services.notifications.savePushSubscription(user(), input.body)));
