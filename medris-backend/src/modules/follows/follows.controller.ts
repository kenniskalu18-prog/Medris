import { controller, ok } from "../../shared/http/route.js";
import * as routes from "./follows.routes.js";

/** /api/v1/follows - see follows.routes.ts for the contract. */
export const followsController = controller()
  // Fixed paths before /follows/{vendorId}, so "states" is not taken for a vendor id.
  .route(routes.followStates, async ({ services, identity, input }) => ok(await services.follows.followStates(identity, input.query.vendorIds)))
  .route(routes.followerCounts, async ({ services, input }) => ok(await services.follows.followerCounts(input.query.vendorIds)))
  .route(routes.followedShops, async ({ services, user }) => ok(await services.follows.followedShops(user())))
  .route(routes.listFollows, async ({ services, user }) => ok(await services.follows.list(user())))
  .route(routes.isFollowing, async ({ services, user, input }) => ok(await services.follows.isFollowing(user(), input.params.vendorId)))
  .route(routes.setFollowing, async ({ services, user, input }) => ok(await services.follows.setFollowing(user(), input.params.vendorId, input.body.following)))
  .route(routes.unfollow, async ({ services, user, input }) => ok(await services.follows.unfollow(user(), input.params.vendorId)))
  .route(routes.followState, async ({ services, identity, input }) => ok(await services.follows.followState(identity, input.params.vendorId)))
  .route(routes.setFollowPreferences, async ({ services, user, input }) =>
    ok(await services.follows.setPreferences(user(), input.params.vendorId, input.body)),
  )
  .route(routes.vendorFollowers, async ({ services, identity, input }) => ok(await services.follows.followers(identity, input.params.vendorId)))
  .route(routes.vendorFollowersDetailed, async ({ services, identity, input }) =>
    ok(await services.follows.followersDetailed(identity, input.params.vendorId)),
  )
  .route(routes.followerNetwork, async ({ services, identity, input }) => ok(await services.follows.followerNetwork(identity, input.params.vendorId)));
