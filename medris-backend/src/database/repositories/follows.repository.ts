import { and, count, eq, sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { uuidArray } from "../arrays.js";
import { jsonReturning, jsonRow, jsonRows } from "../json.js";
import { vendorFollows } from "../schema/index.js";
import type {
  FollowState,
  Follower,
  FollowerCount,
  FollowerDetailed,
  FollowerNetworkEntry,
  VendorFollowState,
} from "../../modules/follows/follows.schemas.js";

/** Shops a user follows (vendor_follows, with vendor_follow_preferences alongside). */
export class FollowsRepository {
  constructor(private readonly db: Executor) {}

  /** Followed vendor ids (the app caps the list at 2000). */
  async vendorIds(followerId: string, limit = 2000): Promise<string[]> {
    const rows = await this.db.select({ id: vendorFollows.vendorId }).from(vendorFollows).where(eq(vendorFollows.followerId, followerId)).limit(limit);
    return rows.map((r) => r.id);
  }

  async count(followerId: string): Promise<number> {
    const [row] = await this.db.select({ n: count() }).from(vendorFollows).where(eq(vendorFollows.followerId, followerId));
    return Number(row?.n ?? 0);
  }

  async isFollowing(followerId: string, vendorId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: vendorFollows.id })
      .from(vendorFollows)
      .where(and(eq(vendorFollows.followerId, followerId), eq(vendorFollows.vendorId, vendorId)))
      .limit(1);
    return rows.length > 0;
  }

  /** A shop that can be followed: verified, active and not deleted. */
  followableVendor(vendorId: string): Promise<{ id: string; user_id: string } | null> {
    return jsonRow(
      this.db,
      sql`select id, user_id from public.vendors
          where id = ${vendorId} and deleted_at is null and verification_status = 'verified' and is_active = true`,
    );
  }

  /** Follows (idempotent) with default notification preferences; the follow triggers notify the shop. */
  async follow(followerId: string, vendorId: string): Promise<void> {
    await this.db.execute(sql`insert into public.vendor_follows (follower_id, vendor_id) values (${followerId}, ${vendorId}) on conflict do nothing`);
    await this.db.execute(
      sql`insert into public.vendor_follow_preferences (follower_id, vendor_id) values (${followerId}, ${vendorId})
          on conflict (follower_id, vendor_id) do nothing`,
    );
  }

  /** Unfollows and forgets the notification preferences. */
  async unfollowWithPreferences(followerId: string, vendorId: string): Promise<void> {
    await this.db.execute(sql`delete from public.vendor_follows where follower_id = ${followerId} and vendor_id = ${vendorId}`);
    await this.db.execute(sql`delete from public.vendor_follow_preferences where follower_id = ${followerId} and vendor_id = ${vendorId}`);
  }

  async unfollow(followerId: string, vendorId: string): Promise<number> {
    const rows = await this.db
      .delete(vendorFollows)
      .where(and(eq(vendorFollows.followerId, followerId), eq(vendorFollows.vendorId, vendorId)))
      .returning({ id: vendorFollows.id });
    return rows.length;
  }

  /**
   * The "Following" page: `from("vendor_follows").select("vendor:vendors!inner(id,business_name,logo_url,cover_image_url,bio,city,
   * avg_rating,review_count,verification_status,is_active,sector_id)").eq("follower_id", me).order("created_at", desc)`.
   * Follows of shops the caller may not see are left out (the inner join). Run as the user.
   */
  followedShops(followerId: string): Promise<{ vendor: Record<string, unknown> }[]> {
    return jsonRows(
      this.db,
      sql`select json_build_object('id', v.id, 'business_name', v.business_name, 'logo_url', v.logo_url, 'cover_image_url', v.cover_image_url,
                                   'bio', v.bio, 'city', v.city, 'avg_rating', v.avg_rating, 'review_count', v.review_count,
                                   'verification_status', v.verification_status, 'is_active', v.is_active, 'sector_id', v.sector_id) as vendor
          from public.vendor_follows f join public.vendors v on v.id = f.vendor_id
          where f.follower_id = ${followerId} order by f.created_at desc`,
    );
  }
}

/* ------------------------------------------------------------------------------------------
 * Ported read queries. Each is the database function's own query with auth.uid() replaced by
 * the caller passed in (null when signed out); they run with the service role, as the
 * SECURITY DEFINER originals did, so every filter on the caller is explicit here.
 * ---------------------------------------------------------------------------------------- */

const FOLLOW_STATE_COLUMNS = sql`
  p.muted_until, coalesce(p.mute_mode, 'none') as mute_mode,
  coalesce(p.notify_new_listing, true) as notify_new_listing, coalesce(p.notify_new_service, true) as notify_new_service,
  coalesce(p.notify_new_package, true) as notify_new_package, coalesce(p.notify_new_variety, true) as notify_new_variety,
  coalesce(p.notify_price_change, true) as notify_price_change, coalesce(p.notify_discount, true) as notify_discount`;

export class FollowReadsRepository {
  constructor(private readonly db: Executor) {}

  /** get_vendor_follow_state(p_vendor_id): one row. */
  followState(viewerId: string | null, vendorId: string): Promise<FollowState[]> {
    return jsonRows<FollowState>(
      this.db,
      sql`select (select count(*) from public.vendor_follows vf where vf.vendor_id = ${vendorId}) as follower_count,
                 exists(select 1 from public.vendor_follows vf where vf.vendor_id = ${vendorId} and vf.follower_id = ${viewerId}::uuid) as following,
                 ${FOLLOW_STATE_COLUMNS}
          from (select 1) x
          left join public.vendor_follow_preferences p on p.vendor_id = ${vendorId} and p.follower_id = ${viewerId}::uuid`,
    );
  }

  /** get_vendor_follow_states(p_vendor_ids): one row per requested id, in the given order. */
  followStates(viewerId: string | null, vendorIds: string[]): Promise<VendorFollowState[]> {
    return jsonRows<VendorFollowState>(
      this.db,
      sql`select requested.id as vendor_id,
                 (select count(*) from public.vendor_follows vf where vf.vendor_id = requested.id) as follower_count,
                 exists(select 1 from public.vendor_follows vf where vf.vendor_id = requested.id and vf.follower_id = ${viewerId}::uuid) as following,
                 ${FOLLOW_STATE_COLUMNS}
          from unnest(${uuidArray(vendorIds)}) with ordinality as requested(id, n)
          left join public.vendor_follow_preferences p on p.vendor_id = requested.id and p.follower_id = ${viewerId}::uuid
          order by requested.n`,
    );
  }

  /** get_vendor_follower_counts(p_vendor_ids): existing vendors only. */
  followerCounts(vendorIds: string[]): Promise<FollowerCount[]> {
    return jsonRows<FollowerCount>(
      this.db,
      sql`select v.id as vendor_id, count(vf.follower_id)::bigint as follower_count
          from unnest(${uuidArray(vendorIds)}) as requested(id)
          join public.vendors v on v.id = requested.id
          left join public.vendor_follows vf on vf.vendor_id = v.id
          group by v.id`,
    );
  }

  /** The owner of a vendor that is not deleted (null when there is none). */
  async liveVendorOwner(vendorId: string): Promise<string | null> {
    const row = await jsonRow<{ user_id: string }>(this.db, sql`select user_id from public.vendors where id = ${vendorId} and deleted_at is null`);
    return row?.user_id ?? null;
  }

  /** get_vendor_followers(p_vendor_id), after the owner check. */
  followers(vendorId: string): Promise<Follower[]> {
    return jsonRows<Follower>(
      this.db,
      sql`select coalesce(u.name, 'Levromart user') as name, u.avatar_url, vf.created_at as followed_at
          from public.vendor_follows vf join public.users u on u.id = vf.follower_id
          where vf.vendor_id = ${vendorId}
          order by vf.created_at desc`,
    );
  }

  /** get_vendor_followers_v2(p_vendor_id), after the owner check: followers with their link to the owner's network. */
  followersDetailed(ownerId: string, vendorId: string): Promise<FollowerDetailed[]> {
    return jsonRows<FollowerDetailed>(
      this.db,
      sql`with live as (select v.id, v.user_id, v.business_name, v.city, v.sector_id from public.vendors v
                        where v.deleted_at is null and v.is_active = true and v.verification_status = 'verified'),
          edges as (select l.id as src, vf.vendor_id as dst from public.vendor_follows vf join live l on l.user_id = vf.follower_id),
          f1 as (select vf.vendor_id as v from public.vendor_follows vf where vf.follower_id = ${ownerId}),
          d2 as (select e.dst as v, (array_agg(l.business_name order by l.business_name))[1] as via
                 from f1 join edges e on e.src = f1.v join live l on l.id = f1.v where e.dst not in (select v from f1) group by e.dst),
          d3 as (select e.dst as v, (array_agg(l.business_name order by l.business_name))[1] as via
                 from d2 join edges e on e.src = d2.v join live l on l.id = d2.v
                 where e.dst not in (select v from f1) and e.dst not in (select v from d2) group by e.dst)
          select u.id as follower_id, coalesce(l.business_name, u.name, 'Levromart user') as name, u.avatar_url, vf.created_at as followed_at,
            (l.id is not null) as is_vendor, l.id as vendor_id, l.business_name, s.name as sector_name, l.city,
            (case when l.id is not null then
                (case when exists(select 1 from f1 where f1.v = l.id) then 1 when exists(select 1 from d2 where d2.v = l.id) then 2
                      when exists(select 1 from d3 where d3.v = l.id) then 3 else 0 end)
              else (case when exists(select 1 from public.vendor_follows c join f1 on f1.v = c.vendor_id where c.follower_id = u.id) then 2 else 0 end) end)::smallint as link_level,
            (case when l.id is not null then coalesce((select via from d2 where d2.v = l.id), (select via from d3 where d3.v = l.id))
              else (select (array_agg(x.business_name order by x.business_name))[1] from public.vendor_follows c join f1 on f1.v = c.vendor_id
                    join public.vendors x on x.id = c.vendor_id where c.follower_id = u.id) end) as via_name,
            (l.id is not null and exists(select 1 from f1 where f1.v = l.id)) as is_following
          from public.vendor_follows vf join public.users u on u.id = vf.follower_id
          left join live l on l.user_id = u.id left join public.sectors s on s.id = l.sector_id
          where vf.vendor_id = ${vendorId}
          order by (case when l.id is not null then 0 else 1 end), 10, vf.created_at desc`,
    );
  }

  /** get_vendor_follower_network(p_vendor_id): the shops among a vendor's followers, ranked by their link to the viewer. */
  followerNetwork(viewerId: string | null, vendorId: string): Promise<FollowerNetworkEntry[]> {
    return jsonRows<FollowerNetworkEntry>(
      this.db,
      sql`with live as (select v.id, v.user_id, v.business_name, v.logo_url, v.city, v.sector_id from public.vendors v
                        where v.deleted_at is null and v.is_active = true and v.verification_status = 'verified'),
          edges as (select l.id as src, vf.vendor_id as dst from public.vendor_follows vf join live l on l.user_id = vf.follower_id),
          f1 as (select vf.vendor_id as v from public.vendor_follows vf where vf.follower_id = ${viewerId}::uuid),
          d2 as (select e.dst as v, (array_agg(l.business_name order by l.business_name))[1] as via
                 from f1 join edges e on e.src = f1.v join live l on l.id = f1.v where e.dst not in (select v from f1) group by e.dst),
          d3 as (select e.dst as v, (array_agg(l.business_name order by l.business_name))[1] as via
                 from d2 join edges e on e.src = d2.v join live l on l.id = d2.v
                 where e.dst not in (select v from f1) and e.dst not in (select v from d2) group by e.dst),
          fans as (select l.id, l.business_name, l.logo_url, l.city, l.sector_id, l.user_id
                   from public.vendor_follows vf join live l on l.user_id = vf.follower_id where vf.vendor_id = ${vendorId}),
          out as (
            select fa.id as vendor_id, fa.business_name, fa.logo_url, fa.city, s.name as sector_name,
                   (select count(*) from public.vendor_follows x where x.vendor_id = fa.id) as follower_count,
                   exists(select 1 from f1 where f1.v = fa.id) as is_following,
                   (fa.user_id = ${viewerId}::uuid) as is_me,
                   (case when exists(select 1 from f1 where f1.v = fa.id) then 1 when exists(select 1 from d2 where d2.v = fa.id) then 2
                         when exists(select 1 from d3 where d3.v = fa.id) then 3 else 0 end)::smallint as link_level,
                   coalesce((select via from d2 where d2.v = fa.id), (select via from d3 where d3.v = fa.id)) as via_name
            from fans fa left join public.sectors s on s.id = fa.sector_id)
          select * from out order by (case link_level when 0 then 9 else link_level end), follower_count desc, business_name`,
    );
  }

  /** Whether the user follows the vendor. */
  async follows(followerId: string, vendorId: string): Promise<boolean> {
    const row = await jsonRow(this.db, sql`select 1 as x from public.vendor_follows where follower_id = ${followerId} and vendor_id = ${vendorId}`);
    return row !== null;
  }

  /** set_vendor_follow_preferences(): upsert and return the whole row. */
  async savePreferences(
    followerId: string,
    vendorId: string,
    p: { muteMode: string; listing: boolean; service: boolean; package: boolean; variety: boolean; priceChange: boolean; discount: boolean },
  ): Promise<Record<string, unknown>> {
    // The mute end is computed by the database clock, as before.
    const mutedUntil = sql`case ${p.muteMode}::text when '1h' then now() + interval '1 hour' when '8h' then now() + interval '8 hours' else null end`;
    const [row] = await jsonReturning(
      this.db,
      sql`insert into public.vendor_follow_preferences (follower_id, vendor_id, muted_until, mute_mode, notify_new_listing, notify_new_service,
                                                        notify_new_package, notify_new_variety, notify_price_change, notify_discount, updated_at)
          values (${followerId}, ${vendorId}, ${mutedUntil}, ${p.muteMode}, ${p.listing}, ${p.service}, ${p.package}, ${p.variety},
                  ${p.priceChange}, ${p.discount}, now())
          on conflict (follower_id, vendor_id) do update set muted_until = excluded.muted_until, mute_mode = excluded.mute_mode,
            notify_new_listing = excluded.notify_new_listing, notify_new_service = excluded.notify_new_service,
            notify_new_package = excluded.notify_new_package, notify_new_variety = excluded.notify_new_variety,
            notify_price_change = excluded.notify_price_change, notify_discount = excluded.notify_discount, updated_at = now()
          returning *`,
    );
    return row!; // an upsert always returns its row
  }
}
