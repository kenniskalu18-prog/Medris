import { defineRoute } from "../../shared/http/route.js";
import { requireUser } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { commonErrors, dataResponse, errorResponses, jsonBody } from "../../shared/openapi/schemas.js";
import { optionalSignIn, signedIn } from "../../shared/openapi/security.js";
import { z } from "../../shared/openapi/zod.js";
import {
  FollowPreferencesBody,
  FollowPreferencesRowSchema,
  FollowStateSchema,
  FollowerCountSchema,
  FollowerDetailedSchema,
  FollowerNetworkEntrySchema,
  FollowerSchema,
  FollowingSchema,
  FollowsSchema,
  SetFollowingBody,
  SetFollowingResult,
  UnfollowResult,
  VendorFollowStateSchema,
  VendorIdsQuery,
  VendorParams,
} from "./follows.schemas.js";

/**
 * Shops the signed-in user follows. toggle_vendor_follow() keeps its rules
 * (no following your own shop, the follower notifications, points).
 */

const tags = ["Follows"];
const writeLimit = rateLimit({ name: "follows-write", limit: 60, windowMs: 60_000 });
const writeErrors = { ...errorResponses(400, 401, 415, 429), ...commonErrors };
const readErrors = { ...errorResponses(400), ...commonErrors };

export const listFollows = defineRoute({
  method: "get",
  path: "/follows",
  tags,
  summary: "Followed shops",
  security: signedIn,
  middleware: [requireUser] as const,
  responses: { 200: dataResponse(FollowsSchema, "Followed vendor ids (up to 2000) and the total."), ...errorResponses(401), ...commonErrors },
});

export const isFollowing = defineRoute({
  method: "get",
  path: "/follows/{vendorId}",
  tags,
  summary: "Is the user following this shop?",
  security: signedIn,
  middleware: [requireUser] as const,
  request: { params: VendorParams },
  responses: { 200: dataResponse(FollowingSchema, "Whether the user follows the shop."), ...errorResponses(400, 401), ...commonErrors },
});

export const setFollowing = defineRoute({
  method: "put",
  path: "/follows/{vendorId}",
  tags,
  summary: "Follow or unfollow a shop",
  description: "Runs toggle_vendor_follow().",
  security: signedIn,
  middleware: [requireUser, writeLimit] as const,
  request: { params: VendorParams, body: jsonBody(SetFollowingBody) },
  responses: { 200: dataResponse(SetFollowingResult, "Done."), ...writeErrors },
});

export const unfollow = defineRoute({
  method: "delete",
  path: "/follows/{vendorId}",
  tags,
  summary: "Unfollow a shop",
  description: "Deletes the follow row directly (the comment menu's unfollow).",
  security: signedIn,
  middleware: [requireUser, writeLimit] as const,
  request: { params: VendorParams },
  responses: { 200: dataResponse(UnfollowResult, "Removed (0 when not following)."), ...writeErrors },
});

/* ------------------------------------------------------- ported database functions */

export const followStates = defineRoute({
  method: "get",
  path: "/follows/states",
  tags,
  summary: "Follow state of several shops",
  description: "Replaces get_vendor_follow_states(): follower count, whether the caller follows, and their notification settings.",
  security: optionalSignIn,
  request: { query: VendorIdsQuery },
  responses: { 200: dataResponse(z.array(VendorFollowStateSchema), "One row per requested id, in order."), ...readErrors },
});

export const followState = defineRoute({
  method: "get",
  path: "/follows/{vendorId}/state",
  tags,
  summary: "Follow state of one shop",
  description: "Replaces get_vendor_follow_state() (a one-row list, as before).",
  security: optionalSignIn,
  request: { params: VendorParams },
  responses: { 200: dataResponse(z.array(FollowStateSchema), "One row."), ...readErrors },
});

export const setFollowPreferences = defineRoute({
  method: "put",
  path: "/follows/{vendorId}/preferences",
  tags,
  summary: "Notification settings for a followed shop",
  description: "Replaces set_vendor_follow_preferences(). Mute for 1h / 8h / always, or choose which news to hear about.",
  security: signedIn,
  middleware: [requireUser, writeLimit] as const,
  request: { params: VendorParams, body: jsonBody(FollowPreferencesBody) },
  responses: { 200: dataResponse(FollowPreferencesRowSchema, "The saved settings."), ...writeErrors },
});

export const followerCounts = defineRoute({
  method: "get",
  path: "/vendors/follower-counts",
  tags,
  summary: "Follower counts",
  description: "Replaces get_vendor_follower_counts(). Unknown ids are left out.",
  security: optionalSignIn,
  request: { query: VendorIdsQuery },
  responses: { 200: dataResponse(z.array(FollowerCountSchema), "Counts."), ...readErrors },
});

export const vendorFollowers = defineRoute({
  method: "get",
  path: "/vendors/{vendorId}/followers",
  tags,
  summary: "A shop's followers (owner only)",
  description: "Replaces get_vendor_followers(). Newest first.",
  security: signedIn,
  request: { params: VendorParams },
  responses: { 200: dataResponse(z.array(FollowerSchema), "Followers."), ...errorResponses(400, 403), ...commonErrors },
});

export const vendorFollowersDetailed = defineRoute({
  method: "get",
  path: "/vendors/{vendorId}/followers/detailed",
  tags,
  summary: "A shop's followers with their network links (owner only)",
  description: "Replaces get_vendor_followers_v2().",
  security: signedIn,
  request: { params: VendorParams },
  responses: { 200: dataResponse(z.array(FollowerDetailedSchema), "Followers, shops first."), ...errorResponses(400, 403), ...commonErrors },
});

export const followerNetwork = defineRoute({
  method: "get",
  path: "/vendors/{vendorId}/follower-network",
  tags,
  summary: "Shops that follow a shop",
  description: "Replaces get_vendor_follower_network(), ranked by their link to the caller.",
  security: optionalSignIn,
  request: { params: VendorParams },
  responses: { 200: dataResponse(z.array(FollowerNetworkEntrySchema), "Shops."), ...readErrors },
});

export const followedShops = defineRoute({
  method: "get",
  path: "/follows/shops",
  tags,
  summary: "The shops the caller follows, with their card details",
  description:
    'Replaces `from("vendor_follows").select("vendor:vendors!inner(id,business_name,logo_url,cover_image_url,bio,city,avg_rating,review_count,' +
    'verification_status,is_active,sector_id)").eq("follower_id", me).order("created_at", desc)`.',
  security: signedIn,
  middleware: [requireUser] as const,
  responses: { 200: dataResponse(z.array(z.object({ vendor: z.record(z.string(), z.unknown()) })), "Newest follow first."), ...errorResponses(401), ...commonErrors },
});
