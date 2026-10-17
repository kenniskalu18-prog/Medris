import { defineRoute } from "../../shared/http/route.js";
import { z } from "../../shared/openapi/zod.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { commonErrors, CountSchema, dataResponse, DoneSchema, errorResponses, idList, idParam, isoDateTime, jsonBody, OrderParams, ProductParams, VendorIdParams } from "../../shared/openapi/schemas.js";
import { optionalSignIn, signedIn } from "../../shared/openapi/security.js";
import {
  CommentAuthorSchema,
  FavoriteCountSchema,
  PackageCommentCountSchema,
  PackageFavoriteCountSchema,
  PackageIdsQuery,
  ProductCommentCountSchema,
  ProductIdsQuery,
  ProductReviewSchema,
  ReviewableOrderSchema,
  UserIdsQuery,
  VendorStatsSchema,
} from "./engagement.schemas.js";

/** Counts and statistics shown on listings and shops. Signed in or not, as before. */

const tags = ["Engagement"];
const readErrors = { ...errorResponses(400), ...commonErrors };
const viewLimit = rateLimit({ name: "view-count", limit: 120, windowMs: 60_000 });

export const favoriteCounts = defineRoute({
  method: "get",
  path: "/engagement/favorite-counts",
  tags,
  summary: "Saves per product",
  description: "Replaces get_favorite_counts(). Products without saves are left out.",
  security: optionalSignIn,
  request: { query: ProductIdsQuery },
  responses: { 200: dataResponse(z.array(FavoriteCountSchema), "Counts."), ...readErrors },
});

export const packageFavoriteCounts = defineRoute({
  method: "get",
  path: "/engagement/package-favorite-counts",
  tags,
  summary: "Saves per package",
  description: "Replaces get_package_favorite_counts(). Every existing package, 0 included.",
  security: optionalSignIn,
  request: { query: PackageIdsQuery },
  responses: { 200: dataResponse(z.array(PackageFavoriteCountSchema), "Counts."), ...readErrors },
});

export const productCommentCounts = defineRoute({
  method: "get",
  path: "/engagement/product-comment-counts",
  tags,
  summary: "Comments per product",
  description: "Replaces get_product_comment_counts(). Products without comments are left out.",
  security: optionalSignIn,
  request: { query: ProductIdsQuery },
  responses: { 200: dataResponse(z.array(ProductCommentCountSchema), "Counts."), ...readErrors },
});

export const packageCommentCounts = defineRoute({
  method: "get",
  path: "/engagement/package-comment-counts",
  tags,
  summary: "Comments per package",
  description: "Replaces get_package_comment_counts(). Every existing package, 0 included.",
  security: optionalSignIn,
  request: { query: PackageIdsQuery },
  responses: { 200: dataResponse(z.array(PackageCommentCountSchema), "Counts."), ...readErrors },
});

export const commentAuthors = defineRoute({
  method: "get",
  path: "/engagement/comment-authors",
  tags,
  summary: "Names and shops of comment authors",
  description: "Replaces get_comment_authors().",
  security: optionalSignIn,
  request: { query: UserIdsQuery },
  responses: { 200: dataResponse(z.array(CommentAuthorSchema), "Authors."), ...readErrors },
});

export const vendorStats = defineRoute({
  method: "get",
  path: "/vendors/{vendorId}/stats",
  tags,
  summary: "A shop's completed orders and rating",
  description: "Replaces get_vendor_stats() (a one-row list, as before).",
  security: optionalSignIn,
  request: { params: VendorIdParams },
  responses: { 200: dataResponse(z.array(VendorStatsSchema), "One row."), ...readErrors },
});

export const countProfileView = defineRoute({
  method: "post",
  path: "/vendors/{vendorId}/views",
  tags,
  summary: "Count a shop page view",
  description: "Replaces increment_vendor_profile_view().",
  security: optionalSignIn,
  middleware: [viewLimit] as const,
  request: { params: VendorIdParams },
  responses: { 200: dataResponse(DoneSchema, "Counted."), ...readErrors, ...errorResponses(429) },
});

export const countProductView = defineRoute({
  method: "post",
  path: "/products/{productId}/views",
  tags,
  summary: "Count a product page view",
  description: "Replaces increment_product_view().",
  security: optionalSignIn,
  middleware: [viewLimit] as const,
  request: { params: ProductParams },
  responses: { 200: dataResponse(DoneSchema, "Counted."), ...readErrors, ...errorResponses(429) },
});

export const productReviews = defineRoute({
  method: "get",
  path: "/products/{productId}/reviews",
  tags,
  summary: "Reviews of a product",
  description: "Replaces get_product_reviews(): reviews of orders that contained it, newest first.",
  security: optionalSignIn,
  request: { params: ProductParams },
  responses: { 200: dataResponse(z.array(ProductReviewSchema), "Reviews."), ...readErrors },
});

export const reviewableOrder = defineRoute({
  method: "get",
  path: "/products/{productId}/reviewable-order",
  tags,
  summary: "The caller's order of this product that can still be reviewed",
  description: "Replaces get_reviewable_order_for_product(): latest completed order without a review (empty list otherwise).",
  security: optionalSignIn,
  request: { params: ProductParams },
  responses: { 200: dataResponse(z.array(ReviewableOrderSchema), "Zero or one row."), ...readErrors },
});

export const reportComment = defineRoute({
  method: "post",
  path: "/engagement/comment-reports",
  tags,
  summary: "Report a comment",
  description: 'Replaces `from("comment_reports").insert({ kind, comment_id, reason })`. A second report of the same comment keeps the first (`alreadyReported`).',
  security: signedIn,
  request: {
    body: jsonBody(z.object({ kind: z.enum(["product", "package"]), commentId: idParam, reason: z.string().max(200).nullable().optional() })),
  },
  responses: { 200: dataResponse(z.object({ reported: z.literal(true), alreadyReported: z.boolean() }), "Reported."), ...errorResponses(400, 401, 415), ...commonErrors },
});

const commentLimit = rateLimit({ name: "comments-write", limit: 60, windowMs: 60_000 });
const CommentSchema = z.record(z.string(), z.unknown()).openapi("ListingComment", {
  description: "id, product_id or package_id, user_id, parent_comment_id, content, author_name, author_avatar_url, created_at, updated_at.",
});
const EngagementSettingsSchema = z
  .object({ vendor_id: z.string(), like_visibility: z.string(), allow_comments: z.boolean(), comment_audience: z.string() })
  .openapi("EngagementSettings");
const SettingsBody = z.object({
  vendorId: idParam,
  like_visibility: z.enum(["everyone", "followers", "no_one"]).optional(),
  allow_comments: z.boolean().optional(),
  comment_audience: z.enum(["everyone", "followers"]).optional(),
});

/** The comment and settings endpoints of one kind of listing (products, packages). */
function listingEngagement(kind: "product" | "package") {
  const plural = kind === "product" ? "products" : "packages";
  const key = kind === "product" ? "productId" : "packageId";
  const Params = z.object({ [key]: idParam }) as z.ZodObject<Record<string, typeof idParam>>;
  const CommentParams = z.object({ commentId: idParam });
  const table = `${kind}_comments`;
  return {
    comments: defineRoute({
      method: "get",
      path: `/${plural}/{${key}}/comments`,
      tags,
      summary: `A ${kind}'s comments and their likes`,
      description: `Replaces \`from("${table}").select(...).eq("${kind}_id", id).order("created_at", desc).limit(120)\` and the likes \`from("${kind}_comment_likes").select("id,comment_id,user_id").in("comment_id", ids)\`.`,
      security: optionalSignIn,
      request: { params: Params },
      responses: { 200: dataResponse(z.object({ comments: z.array(CommentSchema), likes: z.array(z.object({ id: z.string(), comment_id: z.string(), user_id: z.string() })) }), "Newest first."), ...errorResponses(400), ...commonErrors },
    }),
    addComment: defineRoute({
      method: "post",
      path: `/${plural}/{${key}}/comments`,
      tags,
      summary: `Comment on a ${kind}`,
      description: `Replaces the insert into ${table}. Refused (403) when the shop turned comments off, or allows only followers.`,
      security: signedIn,
      middleware: [commentLimit] as const,
      request: { params: Params, body: jsonBody(z.object({ content: z.string().min(1).max(2000), parentCommentId: idParam.nullable().optional() })) },
      responses: { 201: dataResponse(z.object({ id: z.string() }), "The new comment."), ...errorResponses(400, 401, 403, 415, 429), ...commonErrors },
    }),
    deleteComment: defineRoute({
      method: "delete",
      path: `/${kind}-comments/{commentId}`,
      tags,
      summary: `Delete one's own ${kind} comment`,
      description: `Replaces \`from("${table}").delete().eq("id", id).eq("user_id", me)\`.`,
      security: signedIn,
      middleware: [commentLimit] as const,
      request: { params: CommentParams },
      responses: { 200: dataResponse(z.object({ removed: z.number().int() }), "How many went."), ...errorResponses(400, 401, 429), ...commonErrors },
    }),
    toggleLike: defineRoute({
      method: "post",
      path: `/${kind}-comments/{commentId}/like`,
      tags,
      summary: `Like or unlike a ${kind} comment`,
      description: `Replaces the like button's select on ${kind}_comment_likes followed by a delete or an insert.`,
      security: signedIn,
      middleware: [commentLimit] as const,
      request: { params: CommentParams },
      responses: { 200: dataResponse(z.object({ liked: z.boolean() }), "Whether the caller now likes it."), ...errorResponses(400, 401, 429), ...commonErrors },
    }),
    settings: defineRoute({
      method: "get",
      path: `/${plural}/{${key}}/engagement-settings`,
      tags,
      summary: `A ${kind}'s like and comment settings`,
      description: `Replaces \`from("${kind}_engagement_settings").select("allow_comments,like_visibility,comment_audience,vendor_id").eq("${kind}_id", id).maybeSingle()\`. Null: never changed (everyone, comments on).`,
      security: optionalSignIn,
      request: { params: Params },
      responses: { 200: dataResponse(EngagementSettingsSchema.nullable(), "The settings."), ...errorResponses(400), ...commonErrors },
    }),
    settingsFor: defineRoute({
      method: "get",
      path: `/engagement/${kind}-settings`,
      tags,
      summary: `Like visibility of several ${plural}`,
      description: `Replaces \`from("${kind}_engagement_settings").select("${kind}_id,vendor_id,like_visibility").in("${kind}_id", ids)\`.`,
      security: optionalSignIn,
      request: { query: z.object({ ids: idList(`${kind} ids.`) }) },
      responses: { 200: dataResponse(z.array(z.record(z.string(), z.unknown())), "Listings that have settings."), ...errorResponses(400), ...commonErrors },
    }),
    saveSettings: defineRoute({
      method: "put",
      path: `/${plural}/{${key}}/engagement-settings`,
      tags,
      summary: `The shop saves a ${kind}'s like and comment settings`,
      description: `Replaces \`from("${kind}_engagement_settings").upsert({ ${kind}_id, vendor_id, ... }, { onConflict: "${kind}_id" })\`. The ${kind} must be the shop's own (403).`,
      security: signedIn,
      middleware: [commentLimit] as const,
      request: { params: Params, body: jsonBody(SettingsBody) },
      responses: { 200: dataResponse(z.object({ saved: z.literal(true) }), "Saved."), ...errorResponses(400, 401, 403, 415, 429), ...commonErrors },
    }),
  };
}

export const productEngagement = listingEngagement("product");
export const packageEngagement = listingEngagement("package");

export const shopReviews = defineRoute({
  method: "get",
  path: "/vendors/{vendorId}/reviews",
  tags,
  summary: "A shop's latest reviews",
  description: 'Replaces `from("reviews").select("id, rating, comment, buyer_name, buyer_avatar_url, created_at").eq("vendor_id", id).order("created_at", desc).limit(10)`.',
  security: optionalSignIn,
  request: { params: VendorIdParams, query: z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) }) },
  responses: { 200: dataResponse(z.array(z.record(z.string(), z.unknown())), "Newest first."), ...errorResponses(400), ...commonErrors },
});

export const reviewOrder = defineRoute({
  method: "post",
  path: "/orders/{orderId}/review",
  tags,
  summary: "Review a completed order",
  description:
    "Replaces the insert into reviews. Only the buyer, once the order is completed and paid (403); one review per order (409). " +
    "The review is for the order's shop.",
  security: signedIn,
  middleware: [commentLimit] as const,
  request: { params: OrderParams, body: jsonBody(z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(2000).nullable().optional() })) },
  responses: { 201: dataResponse(z.object({ id: z.string() }), "The review."), ...errorResponses(400, 401, 403, 409, 415, 429), ...commonErrors },
});

export const reviewedOrders = defineRoute({
  method: "get",
  path: "/reviews/mine",
  tags,
  summary: "Which of these orders the caller reviewed",
  description: 'Replaces `from("reviews").select("order_id").eq("buyer_id", me).in("order_id", ids)` and `select("id").eq("order_id", id).eq("buyer_id", me).maybeSingle()`.',
  security: signedIn,
  request: { query: z.object({ orderIds: idList("Order ids.", 200) }) },
  responses: { 200: dataResponse(z.object({ orderIds: z.array(z.string()) }), "The reviewed ones."), ...errorResponses(400, 401), ...commonErrors },
});

export const productRatings = defineRoute({
  method: "get",
  path: "/engagement/product-ratings",
  tags,
  summary: "Products' average rating and review count",
  description: 'Replaces `from("product_rating_stats").select("product_id,avg_rating,review_count").in("product_id", ids)`. Products without reviews are left out.',
  security: optionalSignIn,
  request: { query: z.object({ productIds: idList("Product ids.") }) },
  responses: { 200: dataResponse(z.array(z.object({ product_id: z.string(), avg_rating: z.number(), review_count: z.number().int() })), "The ratings."), ...errorResponses(400), ...commonErrors },
});

export const profileViewsSince = defineRoute({
  method: "get",
  path: "/vendors/{vendorId}/views/count",
  tags,
  summary: "How often the caller's shop page was viewed since a time",
  description: 'Replaces `from("vendor_profile_view_events").select("id", { count: "exact", head: true }).eq("vendor_id", id).gte("viewed_at", since)`. 0 for another shop.',
  security: signedIn,
  request: { params: VendorIdParams, query: z.object({ since: isoDateTime }) },
  responses: { 200: dataResponse(CountSchema, "The count."), ...errorResponses(400, 401), ...commonErrors },
});
