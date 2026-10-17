import { defineRoute } from "../../shared/http/route.js";
import { z } from "../../shared/openapi/zod.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { UserParams, commonErrors, dataResponse, errorResponses, jsonBody } from "../../shared/openapi/schemas.js";
import { optionalSignIn, signedIn } from "../../shared/openapi/security.js";
import { ActivityQuery, AdjustBody, ApplyCodeBody, CodeQuery, LeaderboardQuery, LeaderboardRowSchema, LimitQuery, LooseObject, SearchQuery, SocialBody } from "./points.schemas.js";

/** Vendor points, the leaderboard and referral codes. */

const tags = ["Points"];
const writeLimit = rateLimit({ name: "points-write", limit: 30, windowMs: 60_000 });

export const leaderboard = defineRoute({
  method: "get",
  path: "/points/leaderboard",
  tags,
  summary: "The vendor leaderboard",
  description: "Replaces get_points_leaderboard(). Finished weeks get their winner first.",
  security: optionalSignIn,
  request: { query: LeaderboardQuery },
  responses: { 200: dataResponse(z.array(LeaderboardRowSchema), "Shops by points."), ...errorResponses(400), ...commonErrors },
});

export const pastWinners = defineRoute({
  method: "get",
  path: "/points/winners",
  tags,
  summary: "Past Vendors of the Week",
  description: "Replaces get_past_week_winners(): newest first, 1 to 52 (12 by default).",
  security: optionalSignIn,
  request: { query: LimitQuery },
  responses: { 200: dataResponse(z.array(LooseObject), "Winners."), ...errorResponses(400), ...commonErrors },
});

export const spotlight = defineRoute({
  method: "get",
  path: "/points/spotlight",
  tags,
  summary: "Last week's winner and this week's top three",
  description: "Replaces get_vendor_spotlight().",
  security: optionalSignIn,
  responses: { 200: dataResponse(LooseObject, "Spotlight."), ...commonErrors },
});

export const mySummary = defineRoute({
  method: "get",
  path: "/points/me",
  tags,
  summary: "The caller's points",
  description: "Replaces get_my_points_summary(): totals, rank, breakdowns, daily and weekly history, streak, referrals.",
  security: optionalSignIn,
  responses: { 200: dataResponse(LooseObject, "Summary ({ signed_in: false } when signed out)."), ...commonErrors },
});

export const myActivity = defineRoute({
  method: "get",
  path: "/points/me/activity",
  tags,
  summary: "The caller's points history",
  description: "Replaces get_my_points_activity().",
  security: optionalSignIn,
  request: { query: ActivityQuery },
  responses: { 200: dataResponse(z.array(LooseObject), "Entries, newest first."), ...errorResponses(400), ...commonErrors },
});

export const validateCode = defineRoute({
  method: "get",
  path: "/referrals/validate",
  tags,
  summary: "Check a referral code",
  description: "Replaces validate_referral_code().",
  security: optionalSignIn,
  request: { query: CodeQuery },
  responses: { 200: dataResponse(LooseObject, "{ valid, business_name?, logo_url? }"), ...errorResponses(400), ...commonErrors },
});

export const applyCode = defineRoute({
  method: "post",
  path: "/referrals/apply",
  tags,
  summary: "Join through a shop's referral code",
  description: "Replaces apply_referral_code(): within 7 days of signing up, once. Answers { ok, error?, message? } like the original.",
  security: optionalSignIn,
  middleware: [writeLimit] as const,
  request: { body: jsonBody(ApplyCodeBody) },
  responses: { 200: dataResponse(LooseObject, "Result."), ...errorResponses(400, 415, 429), ...commonErrors },
});

export const adjust = defineRoute({
  method: "post",
  path: "/admin/points/adjustments",
  tags,
  summary: "Add or take away points (admins)",
  description: "Replaces admin_adjust_points(). Answers { ok, error? } like the original.",
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { body: jsonBody(AdjustBody) },
  responses: { 200: dataResponse(LooseObject, "Result."), ...errorResponses(400, 415, 429), ...commonErrors },
});

export const awardSocial = defineRoute({
  method: "post",
  path: "/admin/points/social",
  tags,
  summary: "Points for following Levromart (admins)",
  description: "Replaces admin_award_social_points(): the account is found by phone number.",
  security: signedIn,
  middleware: [writeLimit] as const,
  request: { body: jsonBody(SocialBody) },
  responses: { 200: dataResponse(LooseObject, "Result."), ...errorResponses(400, 415, 429), ...commonErrors },
});

export const recentAdjustments = defineRoute({
  method: "get",
  path: "/admin/points/users/{userId}/adjustments",
  tags,
  summary: "A user's last 10 adjustments (admins)",
  description: "Replaces admin_recent_points_adjustments().",
  security: signedIn,
  request: { params: UserParams },
  responses: { 200: dataResponse(z.array(LooseObject), "Adjustments."), ...errorResponses(400), ...commonErrors },
});

export const recentSkips = defineRoute({
  method: "get",
  path: "/admin/points/skips",
  tags,
  summary: "Points not given because of a limit (admins)",
  description: "Replaces admin_recent_points_skips().",
  security: signedIn,
  request: { query: LimitQuery },
  responses: { 200: dataResponse(z.array(LooseObject), "Skips."), ...errorResponses(400), ...commonErrors },
});

export const searchUsers = defineRoute({
  method: "get",
  path: "/admin/points/users",
  tags,
  summary: "Find an account to adjust (admins)",
  description: "Replaces admin_search_points_users(): by name, email, shop name or phone.",
  security: signedIn,
  request: { query: SearchQuery },
  responses: { 200: dataResponse(z.array(LooseObject), "At most 12."), ...errorResponses(400), ...commonErrors },
});

export const pointsRules = defineRoute({
  method: "get",
  path: "/points/rules",
  tags,
  summary: "What each activity earns",
  description: 'Replaces `from("points_rules").select("*").eq("active", true).order("sort_order")`.',
  security: optionalSignIn,
  responses: { 200: dataResponse(z.array(z.record(z.string(), z.unknown())), "The active rules."), ...commonErrors },
});
