import type { FollowsResponse } from "../../contracts/v1.js";
import type { DataContext, Identity } from "../../database/context.js";
import { FollowReadsRepository, FollowsRepository } from "../../database/repositories/follows.repository.js";
import { badRequest, forbidden, notFound, unauthenticated } from "../../shared/errors/app-error.js";
import type { FollowState, Follower, FollowerCount, FollowerDetailed, FollowerNetworkEntry, VendorFollowState } from "./follows.schemas.js";

type Row = Record<string, unknown>;

export const MUTE_MODES = ["none", "1h", "8h", "always"] as const;

export interface FollowPreferencesInput {
  muteMode: string;
  notifyNewListing: boolean;
  notifyNewService: boolean;
  notifyNewPackage: boolean;
  notifyNewVariety: boolean;
  notifyPriceChange: boolean;
  notifyDiscount: boolean;
}

/** Shops a user follows. Reads run as the user (RLS); following replaces toggle_vendor_follow(). */
export class FollowsService {
  constructor(private readonly db: () => DataContext) {}

  list(me: Identity): Promise<FollowsResponse> {
    return this.db().asUser(me, async (tx) => {
      const repo = new FollowsRepository(tx);
      const vendorIds = await repo.vendorIds(me.userId);
      return { vendorIds, count: await repo.count(me.userId) };
    });
  }

  async isFollowing(me: Identity, vendorId: string): Promise<{ following: boolean }> {
    const following = await this.db().asUser(me, (tx) => new FollowsRepository(tx).isFollowing(me.userId, vendorId));
    return { following };
  }

  /**
   * Follows or unfollows a shop. Replaces: public.toggle_vendor_follow(p_vendor_id, p_following)
   * - same checks, messages and rows; `result` is the new state, as the function returned.
   */
  async setFollowing(me: Identity, vendorId: string, following: boolean): Promise<{ following: boolean; result: boolean }> {
    const result = await this.db().onBehalfOf(me, async (tx) => {
      const repo = new FollowsRepository(tx);
      const vendor = await repo.followableVendor(vendorId);
      if (!vendor) throw notFound("Vendor is not currently available.");
      if (vendor.user_id === me.userId) throw badRequest("You cannot follow your own shop.");
      if (following) await repo.follow(me.userId, vendorId);
      else await repo.unfollowWithPreferences(me.userId, vendorId);
      return following;
    });
    return { following, result };
  }

  /** Replaces: public.get_vendor_follow_state(uuid). Signed out: `following` is false and the preferences are defaults. */
  followState(me: Identity | null, vendorId: string): Promise<FollowState[]> {
    return this.db().asService((tx) => new FollowReadsRepository(tx).followState(me?.userId ?? null, vendorId));
  }

  /** Replaces: public.get_vendor_follow_states(uuid[]) */
  followStates(me: Identity | null, vendorIds: string[]): Promise<VendorFollowState[]> {
    return this.db().asService((tx) => new FollowReadsRepository(tx).followStates(me?.userId ?? null, vendorIds));
  }

  /** Replaces: public.get_vendor_follower_counts(uuid[]) */
  followerCounts(vendorIds: string[]): Promise<FollowerCount[]> {
    return this.db().asService((tx) => new FollowReadsRepository(tx).followerCounts(vendorIds));
  }

  /** Replaces: public.get_vendor_followers(uuid) - the shop's owner only. */
  followers(me: Identity | null, vendorId: string): Promise<Follower[]> {
    return this.db().asService(async (tx) => {
      const repo = new FollowReadsRepository(tx);
      await this.requireOwner(repo, me, vendorId);
      return repo.followers(vendorId);
    });
  }

  /** Replaces: public.get_vendor_followers_v2(uuid) - the shop's owner only. */
  followersDetailed(me: Identity | null, vendorId: string): Promise<FollowerDetailed[]> {
    return this.db().asService(async (tx) => {
      const repo = new FollowReadsRepository(tx);
      const ownerId = await this.requireOwner(repo, me, vendorId);
      return repo.followersDetailed(ownerId, vendorId);
    });
  }

  /** Replaces: public.get_vendor_follower_network(uuid) */
  followerNetwork(me: Identity | null, vendorId: string): Promise<FollowerNetworkEntry[]> {
    return this.db().asService((tx) => new FollowReadsRepository(tx).followerNetwork(me?.userId ?? null, vendorId));
  }

  /** Replaces: public.set_vendor_follow_preferences(uuid, text, boolean, boolean, boolean, boolean, boolean, boolean) */
  async setPreferences(me: Identity | null, vendorId: string, input: FollowPreferencesInput): Promise<Row> {
    if (!me) throw unauthenticated("Authentication required.");
    return this.db().onBehalfOf(me, async (tx) => {
      const repo = new FollowReadsRepository(tx);
      if (!(await repo.follows(me.userId, vendorId))) throw badRequest("Follow the vendor before changing notification preferences.");
      if (!(MUTE_MODES as readonly string[]).includes(input.muteMode)) throw badRequest("Invalid mute duration.");
      return repo.savePreferences(me.userId, vendorId, {
        muteMode: input.muteMode,
        listing: input.notifyNewListing,
        service: input.notifyNewService,
        package: input.notifyNewPackage,
        variety: input.notifyNewVariety,
        priceChange: input.notifyPriceChange,
        discount: input.notifyDiscount,
      });
    });
  }

  private async requireOwner(repo: FollowReadsRepository, me: Identity | null, vendorId: string): Promise<string> {
    const ownerId = await repo.liveVendorOwner(vendorId);
    if (!ownerId || ownerId !== me?.userId) throw forbidden("Only the vendor owner can view the follower list");
    return ownerId;
  }

  async unfollow(me: Identity, vendorId: string): Promise<{ following: false; removed: number }> {
    const removed = await this.db().asUser(me, (tx) => new FollowsRepository(tx).unfollow(me.userId, vendorId));
    return { following: false, removed };
  }

  /** The shops the caller follows, newest follow first, with their card details. Replaces the "Following" page's select on vendor_follows. */
  followedShops(me: Identity): Promise<{ vendor: Record<string, unknown> }[]> {
    return this.db().asUser(me, (tx) => new FollowsRepository(tx).followedShops(me.userId));
  }
}
