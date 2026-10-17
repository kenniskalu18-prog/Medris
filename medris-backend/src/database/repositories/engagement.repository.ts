import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { uuidArray } from "../arrays.js";
import { jsonReturning, jsonRows } from "../json.js";
import type {
  CommentAuthor,
  FavoriteCount,
  PackageCommentCount,
  PackageFavoriteCount,
  ProductCommentCount,
  ProductReview,
  ReviewableOrder,
  VendorStats,
} from "../../modules/engagement/engagement.schemas.js";

/**
 * Counts, authors and stats shown next to listings (the database's engagement
 * functions, ported). Each query is the original function's own; they run with
 * the service role, as the SECURITY DEFINER originals did.
 */
export class EngagementRepository {
  constructor(private readonly db: Executor) {}

  /** get_favorite_counts(uuid[]): products with at least one save. */
  favoriteCounts(productIds: string[]): Promise<FavoriteCount[]> {
    return jsonRows<FavoriteCount>(
      this.db,
      sql`select f.product_id, count(*)::int as count from public.favorites f where f.product_id = any(${uuidArray(productIds)}) group by f.product_id`,
    );
  }

  /** get_package_favorite_counts(uuid[]): every existing package, 0 included. */
  packageFavoriteCounts(packageIds: string[]): Promise<PackageFavoriteCount[]> {
    return jsonRows<PackageFavoriteCount>(
      this.db,
      sql`select p.id as package_id, count(f.id)::bigint as favorite_count
          from unnest(${uuidArray(packageIds)}) ids(id)
          join public.vendor_packages p on p.id = ids.id
          left join public.package_favorites f on f.package_id = p.id
          group by p.id`,
    );
  }

  /** get_product_comment_counts(uuid[]): products with at least one comment. */
  productCommentCounts(productIds: string[]): Promise<ProductCommentCount[]> {
    return jsonRows<ProductCommentCount>(
      this.db,
      sql`select pc.product_id, count(*)::bigint as comment_count from public.product_comments pc
          where pc.product_id = any(${uuidArray(productIds)}) group by pc.product_id`,
    );
  }

  /** get_package_comment_counts(uuid[]): every existing package, 0 included. */
  packageCommentCounts(packageIds: string[]): Promise<PackageCommentCount[]> {
    return jsonRows<PackageCommentCount>(
      this.db,
      sql`select p.id as package_id, count(c.id)::bigint as comment_count
          from unnest(${uuidArray(packageIds)}) ids(id)
          join public.vendor_packages p on p.id = ids.id
          left join public.package_comments c on c.package_id = p.id
          group by p.id`,
    );
  }

  /** get_comment_authors(uuid[]): name/avatar and, for shop owners, their (oldest live) shop. */
  commentAuthors(userIds: string[]): Promise<CommentAuthor[]> {
    return jsonRows<CommentAuthor>(
      this.db,
      sql`select u.id as user_id, nullif(trim(u.name), '') as name, u.avatar_url, v.id as vendor_id, v.business_name, v.logo_url,
                 v.verification_status, v.student_verified
          from public.users u
          left join lateral (select * from public.vendors vv where vv.user_id = u.id and vv.deleted_at is null order by vv.created_at limit 1) v on true
          where u.id = any(${uuidArray(userIds)})`,
    );
  }

  /** get_vendor_stats(uuid): completed orders, average rating, review count (one row). */
  vendorStats(vendorId: string): Promise<VendorStats[]> {
    return jsonRows<VendorStats>(
      this.db,
      sql`select (select count(*)::int from public.orders where vendor_id = ${vendorId} and status = 'completed') as completed_orders,
                 (select coalesce(avg(rating), 0)::numeric(3,2) from public.reviews where vendor_id = ${vendorId}) as avg_rating,
                 (select count(*)::int from public.reviews where vendor_id = ${vendorId}) as review_count`,
    );
  }

  /** increment_product_view(uuid) */
  async countProductView(productId: string): Promise<void> {
    await this.db.execute(sql`update public.products set view_count = view_count + 1 where id = ${productId}`);
  }

  /** increment_vendor_profile_view(uuid): the counter plus one view event. */
  async countProfileView(vendorId: string): Promise<void> {
    await this.db.execute(sql`update public.vendors set profile_view_count = profile_view_count + 1 where id = ${vendorId}`);
    await this.db.execute(sql`insert into public.vendor_profile_view_events (vendor_id) values (${vendorId})`);
  }

  /** get_product_reviews(uuid): reviews of orders that contained the product, newest first. */
  productReviews(productId: string): Promise<ProductReview[]> {
    return jsonRows<ProductReview>(
      this.db,
      sql`select r.id, r.rating, r.comment, r.buyer_name, r.buyer_avatar_url, r.created_at
          from public.reviews r join public.order_items oi on oi.order_id = r.order_id
          where oi.product_id = ${productId}
          order by r.created_at desc`,
    );
  }

  /** get_reviewable_order_for_product(uuid): the buyer's latest completed, unreviewed order with the product. */
  reviewableOrder(buyerId: string | null, productId: string): Promise<ReviewableOrder[]> {
    return jsonRows<ReviewableOrder>(
      this.db,
      sql`select o.id as order_id, o.vendor_id
          from public.order_items oi join public.orders o on o.id = oi.order_id
          where oi.product_id = ${productId} and o.buyer_id = ${buyerId}::uuid and o.status = 'completed'
            and not exists (select 1 from public.reviews r where r.order_id = o.id)
          order by o.created_at desc
          limit 1`,
    );
  }

  /**
   * `from("comment_reports").insert({ kind, comment_id, reason })` (as the user: reporter_id is them).
   * Reporting the same comment twice keeps the first report; the app treated that as done too.
   */
  async reportComment(me: string, kind: string, commentId: string, reason: string | null): Promise<{ reported: true; alreadyReported: boolean }> {
    const rows = await jsonReturning(
      this.db,
      sql`insert into public.comment_reports (kind, comment_id, reporter_id, reason) values (${kind}, ${commentId}, ${me}, ${reason})
          on conflict (kind, comment_id, reporter_id) do nothing returning id`,
    );
    return { reported: true, alreadyReported: rows.length === 0 };
  }

  /** `from("vendor_profile_view_events").select("id", { count: "exact", head: true }).eq("vendor_id", id).gte("viewed_at", since)` (as the user: own shop only). */
  async profileViewsSince(vendorId: string, since: string): Promise<number> {
    const rows = await jsonRows<{ n: number }>(this.db, sql`select count(*)::int as n from public.vendor_profile_view_events where vendor_id = ${vendorId} and viewed_at >= ${since}::timestamptz`);
    return rows[0]?.n ?? 0;
  }
}
