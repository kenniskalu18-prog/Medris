import { z } from "../../shared/openapi/zod.js";
import { idList } from "../../shared/openapi/schemas.js";

/** Request and response shapes of the engagement endpoints (rows exactly as the database functions returned them). */

export const ProductIdsQuery = z.object({ productIds: idList("Product ids.") });
export const PackageIdsQuery = z.object({ packageIds: idList("Package ids.") });
export const UserIdsQuery = z.object({ userIds: idList("User ids.") });

export const FavoriteCountSchema = z.object({ product_id: z.string(), count: z.number().int() }).openapi("FavoriteCount");
export const PackageFavoriteCountSchema = z.object({ package_id: z.string(), favorite_count: z.number() }).openapi("PackageFavoriteCount");
export const ProductCommentCountSchema = z.object({ product_id: z.string(), comment_count: z.number() }).openapi("ProductCommentCount");
export const PackageCommentCountSchema = z.object({ package_id: z.string(), comment_count: z.number() }).openapi("PackageCommentCount");

export const CommentAuthorSchema = z
  .object({
    user_id: z.string(),
    name: z.string().nullable(),
    avatar_url: z.string().nullable(),
    vendor_id: z.string().nullable(),
    business_name: z.string().nullable(),
    logo_url: z.string().nullable(),
    verification_status: z.string().nullable(),
    student_verified: z.boolean().nullable(),
  })
  .openapi("CommentAuthor");

export const VendorStatsSchema = z
  .object({ completed_orders: z.number().int(), avg_rating: z.number(), review_count: z.number().int() })
  .openapi("VendorStats");

export const ProductReviewSchema = z
  .object({
    id: z.string(),
    rating: z.number().int(),
    comment: z.string().nullable(),
    buyer_name: z.string().nullable(),
    buyer_avatar_url: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("ProductReview");

export const ReviewableOrderSchema = z.object({ order_id: z.string(), vendor_id: z.string() }).openapi("ReviewableOrder");

export type FavoriteCount = z.infer<typeof FavoriteCountSchema>;
export type PackageFavoriteCount = z.infer<typeof PackageFavoriteCountSchema>;
export type ProductCommentCount = z.infer<typeof ProductCommentCountSchema>;
export type PackageCommentCount = z.infer<typeof PackageCommentCountSchema>;
export type CommentAuthor = z.infer<typeof CommentAuthorSchema>;
export type VendorStats = z.infer<typeof VendorStatsSchema>;
export type ProductReview = z.infer<typeof ProductReviewSchema>;
export type ReviewableOrder = z.infer<typeof ReviewableOrderSchema>;
