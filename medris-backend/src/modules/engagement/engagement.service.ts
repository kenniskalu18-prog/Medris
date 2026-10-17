import type { DataContext, Identity } from "../../database/context.js";
import { EngagementRepository } from "../../database/repositories/engagement.repository.js";
import type {
  CommentAuthor,
  FavoriteCount,
  PackageCommentCount,
  PackageFavoriteCount,
  ProductCommentCount,
  ProductReview,
  ReviewableOrder,
  VendorStats,
} from "./engagement.schemas.js";
import { CommentsRepository, type CommentRow, type EngagementSettings, type ListingKind } from "../../database/repositories/comments.repository.js";
import { forbidden } from "../../shared/errors/app-error.js";
import { ReviewsRepository } from "../../database/repositories/reviews.repository.js";

/**
 * Public counters and listing statistics. Everything here was a SECURITY DEFINER
 * function anyone could call (signed in or not); the reads run with the service
 * role and only ever return these aggregate or public fields.
 */
export class EngagementService {
  constructor(private readonly db: () => DataContext) {}

  private read<T>(work: (repo: EngagementRepository) => Promise<T>): Promise<T> {
    return this.db().asService((tx) => work(new EngagementRepository(tx)));
  }

  /** Replaces: public.get_favorite_counts(uuid[]) */
  favoriteCounts(productIds: string[]): Promise<FavoriteCount[]> {
    return this.read((r) => r.favoriteCounts(productIds));
  }

  /** Replaces: public.get_package_favorite_counts(uuid[]) */
  packageFavoriteCounts(packageIds: string[]): Promise<PackageFavoriteCount[]> {
    return this.read((r) => r.packageFavoriteCounts(packageIds));
  }

  /** Replaces: public.get_product_comment_counts(uuid[]) */
  productCommentCounts(productIds: string[]): Promise<ProductCommentCount[]> {
    return this.read((r) => r.productCommentCounts(productIds));
  }

  /** Replaces: public.get_package_comment_counts(uuid[]) */
  packageCommentCounts(packageIds: string[]): Promise<PackageCommentCount[]> {
    return this.read((r) => r.packageCommentCounts(packageIds));
  }

  /** Replaces: public.get_comment_authors(uuid[]) */
  commentAuthors(userIds: string[]): Promise<CommentAuthor[]> {
    return this.read((r) => r.commentAuthors(userIds));
  }

  /** Replaces: public.get_vendor_stats(uuid) */
  vendorStats(vendorId: string): Promise<VendorStats[]> {
    return this.read((r) => r.vendorStats(vendorId));
  }

  /** Replaces: public.increment_product_view(uuid) */
  async countProductView(productId: string): Promise<{ done: true }> {
    await this.read((r) => r.countProductView(productId));
    return { done: true };
  }

  /** Replaces: public.increment_vendor_profile_view(uuid) */
  async countProfileView(vendorId: string): Promise<{ done: true }> {
    await this.read((r) => r.countProfileView(vendorId));
    return { done: true };
  }

  /** Replaces: public.get_product_reviews(uuid) */
  productReviews(productId: string): Promise<ProductReview[]> {
    return this.read((r) => r.productReviews(productId));
  }

  /** Replaces: public.get_reviewable_order_for_product(uuid) - the caller's own orders only (none when signed out). */
  reviewableOrder(me: Identity | null, productId: string): Promise<ReviewableOrder[]> {
    return this.read((r) => r.reviewableOrder(me?.userId ?? null, productId));
  }

  /** Reports a product or package comment. Replaces the app's insert into comment_reports; runs as the user. */
  reportComment(me: Identity, kind: "product" | "package", commentId: string, reason: string | null): Promise<{ reported: true; alreadyReported: boolean }> {
    return this.db().asUser(me, (tx) => new EngagementRepository(tx).reportComment(me.userId, kind, commentId, reason));
  }

  /**
   * A listing's comments (newest first, up to 120) and their likes. Replaces the app's two selects; runs as the
   * caller (signed out too), so a package's followers-only comments stay hidden from others.
   */
  async listingComments(me: Identity | null, kind: ListingKind, listingId: string): Promise<{ comments: CommentRow[]; likes: { id: string; comment_id: string; user_id: string }[] }> {
    const read = async (tx: Parameters<Parameters<DataContext["asAnon"]>[0]>[0]) => {
      const repo = new CommentsRepository(tx);
      const comments = await repo.comments(kind, listingId);
      return { comments, likes: await repo.likes(kind, comments.map((c) => c.id)) };
    };
    return me ? this.db().asUser(me, read) : this.db().asAnon(read);
  }

  /** Posts a comment (or a reply). Refused (403) when comments are off, or followers-only and the caller does not follow the shop. */
  async addComment(me: Identity, kind: ListingKind, listingId: string, content: string, parentId: string | null): Promise<{ id: string }> {
    return { id: await this.db().asUser(me, (tx) => new CommentsRepository(tx).add(kind, me.userId, listingId, content, parentId)) };
  }

  async deleteComment(me: Identity, kind: ListingKind, commentId: string): Promise<{ removed: number }> {
    return { removed: await this.db().asUser(me, (tx) => new CommentsRepository(tx).remove(kind, me.userId, commentId)) };
  }

  async toggleCommentLike(me: Identity, kind: ListingKind, commentId: string): Promise<{ liked: boolean }> {
    return { liked: await this.db().asUser(me, (tx) => new CommentsRepository(tx).toggleLike(kind, me.userId, commentId)) };
  }

  /** A listing's like and comment settings (null when the shop never changed them: everyone, comments on). */
  listingSettings(me: Identity | null, kind: ListingKind, listingId: string): Promise<EngagementSettings | null> {
    const read = (tx: Parameters<Parameters<DataContext["asAnon"]>[0]>[0]) => new CommentsRepository(tx).settings(kind, listingId);
    return me ? this.db().asUser(me, read) : this.db().asAnon(read);
  }

  /** Who may see the like counts of several listings. */
  settingsFor(me: Identity | null, kind: ListingKind, listingIds: string[]): Promise<Record<string, unknown>[]> {
    const read = (tx: Parameters<Parameters<DataContext["asAnon"]>[0]>[0]) => new CommentsRepository(tx).settingsFor(kind, listingIds);
    return me ? this.db().asUser(me, read) : this.db().asAnon(read);
  }

  /**
   * The shop owner saves a listing's like and comment settings. FIX S6: the listing must belong to that
   * shop (the table only checked the shop, so a vendor could switch off comments on another shop's listing).
   */
  async saveSettings(me: Identity, kind: ListingKind, listingId: string, vendorId: string, s: Partial<Omit<EngagementSettings, "vendor_id">>): Promise<{ saved: true }> {
    await this.db().asUser(me, async (tx) => {
      const repo = new CommentsRepository(tx);
      if (!(await repo.listingOfShop(kind, listingId, vendorId))) throw forbidden("This listing does not belong to that shop.");
      await repo.saveSettings(kind, listingId, vendorId, s);
    });
    return { saved: true };
  }

  /** A shop's latest reviews (newest first). Replaces the storefront's select on reviews; anyone may read them. */
  shopReviews(me: Identity | null, vendorId: string, limit: number): Promise<Record<string, unknown>[]> {
    const read = (tx: Parameters<Parameters<DataContext["asAnon"]>[0]>[0]) => new ReviewsRepository(tx).shopReviews(vendorId, limit);
    return me ? this.db().asUser(me, read) : this.db().asAnon(read);
  }

  /**
   * The buyer reviews a completed, paid order. Replaces the insert into reviews. FIX S8: the review is
   * always for the order's own shop (the table accepted any shop id with any of one's orders).
   */
  async reviewOrder(me: Identity, orderId: string, rating: number, comment: string | null): Promise<{ id: string }> {
    return this.db().asUser(me, async (tx) => {
      const reviews = new ReviewsRepository(tx);
      const vendorId = await reviews.orderShop(me.userId, orderId);
      if (!vendorId) throw forbidden("You can only review your own orders.");
      return { id: await reviews.add(me.userId, orderId, vendorId, rating, comment) };
    });
  }

  /** Which of these orders the caller already reviewed. */
  async reviewedOrders(me: Identity, orderIds: string[]): Promise<{ orderIds: string[] }> {
    return { orderIds: await this.db().asUser(me, (tx) => new ReviewsRepository(tx).reviewedOrders(me.userId, orderIds)) };
  }

  /** Products' average rating and review count (products without reviews are left out). */
  productRatings(me: Identity | null, productIds: string[]): Promise<{ product_id: string; avg_rating: number; review_count: number }[]> {
    const read = (tx: Parameters<Parameters<DataContext["asAnon"]>[0]>[0]) => new ReviewsRepository(tx).productRatings(productIds);
    return me ? this.db().asUser(me, read) : this.db().asAnon(read);
  }

  /** How often the caller's shop page was viewed since a time (0 for someone else's shop). */
  async profileViewsSince(me: Identity, vendorId: string, since: string): Promise<{ count: number }> {
    return { count: await this.db().asUser(me, (tx) => new EngagementRepository(tx).profileViewsSince(vendorId, since)) };
  }
}
