import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { uuidArray } from "../arrays.js";
import { jsonReturning, jsonRow, jsonRows } from "../json.js";

/**
 * Reviews, as the app's table queries read and wrote them. Run as the user: row-level security (only
 * the buyer of a completed, paid order) and the triggers (buyer's name and photo, the shop's rating,
 * points, the shop's notification) still decide.
 */
export class ReviewsRepository {
  constructor(private readonly db: Executor) {}

  /** `select("id, rating, comment, buyer_name, buyer_avatar_url, created_at").eq("vendor_id", id).order("created_at", desc).limit(n)` */
  shopReviews(vendorId: string, limit: number): Promise<{ id: string; rating: number; comment: string | null; buyer_name: string | null; buyer_avatar_url: string | null; created_at: string }[]> {
    return jsonRows(
      this.db,
      sql`select id, rating, comment, buyer_name, buyer_avatar_url, created_at from public.reviews where vendor_id = ${vendorId} order by created_at desc limit ${limit}`,
    );
  }

  /** The order's shop, when the caller is its buyer (the review is always for that shop - FIX S8). */
  async orderShop(buyerId: string, orderId: string): Promise<string | null> {
    return (await jsonRow<{ vendor_id: string }>(this.db, sql`select vendor_id from public.orders where id = ${orderId} and buyer_id = ${buyerId}`))?.vendor_id ?? null;
  }

  /** `insert({ order_id, buyer_id: me, vendor_id, rating, comment })` */
  async add(buyerId: string, orderId: string, vendorId: string, rating: number, comment: string | null): Promise<string> {
    const [row] = await jsonReturning<{ id: string }>(
      this.db,
      sql`insert into public.reviews (order_id, buyer_id, vendor_id, rating, comment) values (${orderId}, ${buyerId}, ${vendorId}, ${rating}, ${comment}) returning id`,
    );
    return row!.id;
  }

  /** `select("order_id").eq("buyer_id", me).in("order_id", ids)` (and `select("id").eq("order_id", id).eq("buyer_id", me).maybeSingle()`) */
  async reviewedOrders(buyerId: string, orderIds: string[]): Promise<string[]> {
    if (orderIds.length === 0) return [];
    const rows = await jsonRows<{ order_id: string }>(this.db, sql`select order_id from public.reviews where buyer_id = ${buyerId} and order_id = any(${uuidArray(orderIds)})`);
    return rows.map((r) => r.order_id);
  }

  /** `from("product_rating_stats").select("product_id,avg_rating,review_count").in("product_id", ids)` */
  productRatings(productIds: string[]): Promise<{ product_id: string; avg_rating: number; review_count: number }[]> {
    if (productIds.length === 0) return Promise.resolve([]);
    return jsonRows(this.db, sql`select product_id, avg_rating, review_count from public.product_rating_stats where product_id = any(${uuidArray(productIds)})`);
  }
}
