import { controller, created, ok } from "../../shared/http/route.js";
import * as routes from "./engagement.routes.js";

/** Listing and shop statistics - see engagement.routes.ts for the contract. */
export const engagementController = controller()
  .route(routes.favoriteCounts, async ({ services, input }) => ok(await services.engagement.favoriteCounts(input.query.productIds)))
  .route(routes.packageFavoriteCounts, async ({ services, input }) => ok(await services.engagement.packageFavoriteCounts(input.query.packageIds)))
  .route(routes.productCommentCounts, async ({ services, input }) => ok(await services.engagement.productCommentCounts(input.query.productIds)))
  .route(routes.packageCommentCounts, async ({ services, input }) => ok(await services.engagement.packageCommentCounts(input.query.packageIds)))
  .route(routes.commentAuthors, async ({ services, input }) => ok(await services.engagement.commentAuthors(input.query.userIds)))
  .route(routes.vendorStats, async ({ services, input }) => ok(await services.engagement.vendorStats(input.params.vendorId)))
  .route(routes.countProfileView, async ({ services, input }) => ok(await services.engagement.countProfileView(input.params.vendorId)))
  .route(routes.countProductView, async ({ services, input }) => ok(await services.engagement.countProductView(input.params.productId)))
  .route(routes.productReviews, async ({ services, input }) => ok(await services.engagement.productReviews(input.params.productId)))
  .route(routes.reviewableOrder, async ({ services, identity, input }) => ok(await services.engagement.reviewableOrder(identity, input.params.productId)))
  .route(routes.reportComment, async ({ services, user, input }) => ok(await services.engagement.reportComment(user(), input.body.kind, input.body.commentId, input.body.reason ?? null)))
  .route(routes.productEngagement.comments, async ({ services, identity, input }) => ok(await services.engagement.listingComments(identity, "product", String(input.params.productId))))
  .route(routes.productEngagement.addComment, async ({ services, user, input }) => created(await services.engagement.addComment(user(), "product", String(input.params.productId), input.body.content, input.body.parentCommentId ?? null)))
  .route(routes.productEngagement.deleteComment, async ({ services, user, input }) => ok(await services.engagement.deleteComment(user(), "product", input.params.commentId)))
  .route(routes.productEngagement.toggleLike, async ({ services, user, input }) => ok(await services.engagement.toggleCommentLike(user(), "product", input.params.commentId)))
  .route(routes.productEngagement.settings, async ({ services, identity, input }) => ok(await services.engagement.listingSettings(identity, "product", String(input.params.productId))))
  .route(routes.productEngagement.settingsFor, async ({ services, identity, input }) => ok(await services.engagement.settingsFor(identity, "product", input.query.ids)))
  .route(routes.productEngagement.saveSettings, async ({ services, user, input }) => {
    const { vendorId, ...settings } = input.body;
    return ok(await services.engagement.saveSettings(user(), "product", String(input.params.productId), vendorId, settings));
  })
  .route(routes.packageEngagement.comments, async ({ services, identity, input }) => ok(await services.engagement.listingComments(identity, "package", String(input.params.packageId))))
  .route(routes.packageEngagement.addComment, async ({ services, user, input }) => created(await services.engagement.addComment(user(), "package", String(input.params.packageId), input.body.content, input.body.parentCommentId ?? null)))
  .route(routes.packageEngagement.deleteComment, async ({ services, user, input }) => ok(await services.engagement.deleteComment(user(), "package", input.params.commentId)))
  .route(routes.packageEngagement.toggleLike, async ({ services, user, input }) => ok(await services.engagement.toggleCommentLike(user(), "package", input.params.commentId)))
  .route(routes.packageEngagement.settings, async ({ services, identity, input }) => ok(await services.engagement.listingSettings(identity, "package", String(input.params.packageId))))
  .route(routes.packageEngagement.settingsFor, async ({ services, identity, input }) => ok(await services.engagement.settingsFor(identity, "package", input.query.ids)))
  .route(routes.packageEngagement.saveSettings, async ({ services, user, input }) => {
    const { vendorId, ...settings } = input.body;
    return ok(await services.engagement.saveSettings(user(), "package", String(input.params.packageId), vendorId, settings));
  })
  .route(routes.shopReviews, async ({ services, identity, input }) => ok(await services.engagement.shopReviews(identity, input.params.vendorId, input.query.limit)))
  .route(routes.reviewOrder, async ({ services, user, input }) => created(await services.engagement.reviewOrder(user(), input.params.orderId, input.body.rating, input.body.comment ?? null)))
  .route(routes.reviewedOrders, async ({ services, user, input }) => ok(await services.engagement.reviewedOrders(user(), input.query.orderIds)))
  .route(routes.productRatings, async ({ services, identity, input }) => ok(await services.engagement.productRatings(identity, input.query.productIds)))
  .route(routes.profileViewsSince, async ({ services, user, input }) => ok(await services.engagement.profileViewsSince(user(), input.params.vendorId, input.query.since)));
