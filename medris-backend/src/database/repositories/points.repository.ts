import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { rowsOf } from "../client.js";
import { jsonRow, jsonRows } from "../json.js";
import { NotificationWriter } from "./notification-writer.repository.js";

/** Lagos time: points days and weeks (Monday to Sunday) follow it. */
const LAGOS = "Africa/Lagos";

export interface LeaderboardRow {
  rank: number;
  user_id: string;
  vendor_id: string;
  business_name: string | null;
  logo_url: string | null;
  city: string | null;
  avg_rating: number | null;
  review_count: number | null;
  points: number;
  tx_count: number;
  is_me: boolean;
}

export interface AwardInput {
  userId: string | null;
  kind: string;
  /** Unique per user: the same key never earns twice. */
  key: string | null;
  sourceUserId?: string | null;
  note?: string | null;
  /** Extra details; a string is JSON already built by PostgreSQL (keeps numerics exactly as stored). */
  meta?: Record<string, unknown> | string | null;
  /** Fixed points; by default the rule's (only while the rule is active). */
  points?: number | null;
  notify?: boolean;
}

/**
 * The points ledger behind the vendor leaderboard - the database's points helpers, ported:
 *
 *   points_week_start()        -> weekStart()
 *   award_points(...)          -> award(...)
 *   revoke_points(user, key)   -> revoke(...)
 *   points_log_skip(...)       -> logSkip(...)
 *   notify_points(...)         -> notify(...)
 *   points_reconcile_listings() -> reconcileListings()
 *   finalize_points_weeks()    -> finalizeWeeks()
 *   get_points_leaderboard()   -> leaderboard(...)
 *   points_award_order(...)    -> awardOrder(...)
 *   points_award_review(...)   -> awardReview(...)
 *   points_for_new_listing(..) -> forNewListing(...)
 *   points_revoke_listing(...) -> revokeListing(...)
 *   notify_rank_upsert(...)    -> rankChanged(...)
 */
export class PointsRepository {
  constructor(private readonly db: Executor) {}

  /** Replaces: public.points_week_start(timestamp with time zone) - the Monday (Lagos time) of the current points week, as 'YYYY-MM-DD'. */
  async weekStart(): Promise<string> {
    const row = await jsonRow<{ d: string }>(this.db, sql`select date_trunc('week', now() at time zone ${LAGOS})::date as d`);
    return row!.d;
  }

  /**
   * Replaces: public.award_points(uuid, text, text, uuid, text, jsonb, integer, boolean)
   * Adds a ledger entry and the week's total, unless the key was already used, the
   * rule is missing or inactive (when no fixed points are given), or a daily / weekly cap is reached
   * (logged as a skip). Points above zero notify the user (grouped). Returns the points added.
   */
  async award(a: AwardInput): Promise<number> {
    if (!a.userId || a.key == null) return 0;
    if (!(await jsonRow(this.db, sql`select 1 as x from public.users where id = ${a.userId}`))) return 0;
    const rule = await jsonRow<{ label: string; points: number; active: boolean; daily_cap: number | null; weekly_cap: number | null }>(
      this.db,
      sql`select label, points, active, daily_cap, weekly_cap from public.points_rules where kind = ${a.kind}`,
    );
    let points: number;
    if (a.points == null) {
      if (!rule || !rule.active) return 0;
      points = rule.points;
    } else {
      points = a.points;
    }
    if (points === 0) return 0;
    const week = await this.weekStart();
    if (rule && rule.daily_cap != null) {
      const row = await jsonRow<{ n: number }>(
        this.db,
        sql`select count(*)::int as n from public.points_ledger
            where user_id = ${a.userId} and kind = ${a.kind}
              and (created_at at time zone ${LAGOS})::date = (now() at time zone ${LAGOS})::date`,
      );
      if (row!.n >= rule.daily_cap) {
        await this.logSkip(a.userId, a.kind, a.key, `Daily limit of ${rule.daily_cap} reached`);
        return 0;
      }
    }
    if (rule && rule.weekly_cap != null) {
      const row = await jsonRow<{ n: number }>(
        this.db,
        sql`select count(*)::int as n from public.points_ledger where user_id = ${a.userId} and kind = ${a.kind} and week_start = ${week}::date`,
      );
      if (row!.n >= rule.weekly_cap) {
        await this.logSkip(a.userId, a.kind, a.key, `Weekly limit of ${rule.weekly_cap} reached`);
        return 0;
      }
    }
    const note = a.note ?? (rule ? rule.label : null);
    const inserted = rowsOf<{ id: string }>(
      await this.db.execute(sql`
        insert into public.points_ledger (user_id, kind, points, event_key, source_user_id, note, meta, week_start)
        values (${a.userId}, ${a.kind}, ${points}, ${a.key}, ${a.sourceUserId ?? null}::uuid, ${note}, coalesce(${a.meta == null ? null : typeof a.meta === "string" ? a.meta : JSON.stringify(a.meta)}::jsonb, '{}'::jsonb), ${week}::date)
        on conflict (user_id, event_key) do nothing
        returning id`),
    );
    if (inserted.length === 0) return 0;
    await this.db.execute(sql`
      insert into public.points_weekly (user_id, week_start, points, tx_count, last_at)
      values (${a.userId}, ${week}::date, ${points}, ${a.kind === "order_completed" ? 1 : 0}, now())
      on conflict (user_id, week_start) do update set
        points = public.points_weekly.points + excluded.points,
        tx_count = public.points_weekly.tx_count + excluded.tx_count,
        last_at = now(), updated_at = now()`);
    if ((a.notify ?? true) && points > 0) await this.notify(a.userId, points, note);
    return points;
  }

  /** Replaces: public.points_log_skip(uuid, text, text, text) - records why points were not given (once per kind and reference); never fails the caller. */
  async logSkip(userId: string | null, kind: string, ref: string, reason: string): Promise<void> {
    try {
      await this.db.transaction((sp) =>
        sp.execute(sql`insert into public.points_skips (user_id, kind, ref, reason) values (${userId}, ${kind}, ${ref}, ${reason}) on conflict (kind, ref) do nothing`),
      );
    } catch {
      // ignored, as the original did
    }
  }

  /**
   * Replaces: public.notify_points(uuid, integer, text) - one "points" notification per burst - an unread one from the last 3 hours is
   * updated (total, count, moved to now), otherwise a new one.
   */
  async notify(userId: string, points: number, note: string | null): Promise<void> {
    const [open] = rowsOf<{ id: string; metadata: { total?: string | number; count?: string | number } | null }>(
      await this.db.execute(sql`
        select id, metadata from public.notifications
        where user_id = ${userId} and type = 'points' and read = false and archived = false and created_at > now() - interval '3 hours'
        order by created_at desc limit 1 for update`),
    );
    if (open) {
      await this.db.execute(sql`
        update public.notifications set
          title = '+' || (coalesce((metadata->>'total')::int, 0) + ${points}::int) || ' points',
          body = (coalesce((metadata->>'count')::int, 1) + 1) || ' new activities. Tap to see your breakdown.',
          metadata = jsonb_build_object('total', coalesce((metadata->>'total')::int, 0) + ${points}::int, 'count', coalesce((metadata->>'count')::int, 1) + 1),
          created_at = now()
        where id = ${open.id}`);
      return;
    }
    await this.db.execute(sql`
      insert into public.notifications (user_id, type, title, body, target_view, target_params, notification_category, group_key, metadata)
      values (${userId}, 'points', '+' || ${points}::int || ' points', coalesce(${note}::text, 'You earned points'), 'leaderboard',
              '{"tab":"activity"}'::jsonb, 'points', 'points:' || (now() at time zone ${LAGOS})::date, jsonb_build_object('total', ${points}::int, 'count', 1))`);
  }

  /** Replaces: public.revoke_points(uuid, text) - removes a ledger entry and takes it off that week's total. */
  async revoke(userId: string, key: string): Promise<void> {
    const [entry] = rowsOf<{ points: number; week_start: string; kind: string }>(
      await this.db.execute(sql`delete from public.points_ledger where user_id = ${userId} and event_key = ${key} returning points, week_start::text, kind`),
    );
    if (!entry) return;
    await this.db.execute(sql`
      update public.points_weekly set
        points = points - ${entry.points}::int,
        tx_count = greatest(0, tx_count - ${entry.kind === "order_completed" ? 1 : 0}::int),
        updated_at = now()
      where user_id = ${userId} and week_start = ${entry.week_start}::date`);
  }

  /** Replaces: public.points_reconcile_listings() - listing points are taken back once the listing is removed or gone. */
  async reconcileListings(): Promise<void> {
    const gone = await jsonRows<{ user_id: string; event_key: string }>(
      this.db,
      sql`select l.user_id, l.event_key
          from public.points_ledger l
          cross join lateral (select nullif(substring(l.event_key from '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), '')::uuid as lid) k
          where l.kind in ('product_listed', 'ref_vendor_product') and k.lid is not null
            and not exists (select 1 from public.products p where p.id = k.lid and p.status::text <> 'removed' and p.admin_deleted_at is null)
            and not exists (select 1 from public.vendor_packages vp where vp.id = k.lid and vp.status::text <> 'removed')`,
    );
    for (const entry of gone) await this.revoke(entry.user_id, entry.event_key);
  }

  /**
   * Replaces: public.finalize_points_weeks() - first takes back points of removed listings, then names the winner of
   * every finished week that has none yet (the verified, not paused shop with most points, then most
   * sales, then earliest) with the top three, and congratulates the winner.
   */
  async finalizeWeeks(): Promise<void> {
    await this.reconcileListings();
    const weeks = await jsonRows<{ ws: string }>(
      this.db,
      sql`select distinct pw.week_start::text as ws from public.points_weekly pw
          where pw.week_start < date_trunc('week', now() at time zone ${LAGOS})::date
            and not exists (select 1 from public.vendor_week_winners ww where ww.week_start = pw.week_start)`,
    );
    for (const { ws } of weeks) {
      const [won] = rowsOf<{ user_id: string; points: number }>(
        await this.db.execute(sql`
          with ranked as (
            select pw.user_id, v.id vid, v.business_name bn, pw.points pts, pw.tx_count tx,
                   row_number() over (order by pw.points desc, pw.tx_count desc, pw.last_at asc) rn
            from public.points_weekly pw
            join public.vendors v on v.user_id = pw.user_id and v.deleted_at is null
                                 and v.verification_status = 'verified' and coalesce(v.admin_paused, false) = false
            where pw.week_start = ${ws}::date and pw.points > 0),
          top as (
            select jsonb_agg(jsonb_build_object('rank', rn, 'user_id', user_id, 'vendor_id', vid, 'business_name', bn, 'points', pts) order by rn) as t
            from ranked where rn <= 3)
          insert into public.vendor_week_winners (week_start, user_id, vendor_id, points, tx_count, top3)
          select ${ws}::date, (t->0->>'user_id')::uuid, (t->0->>'vendor_id')::uuid, (t->0->>'points')::int,
                 coalesce((select tx_count from public.points_weekly where user_id = (t->0->>'user_id')::uuid and week_start = ${ws}::date), 0), t
          from top where t is not null
          on conflict (week_start) do nothing
          returning user_id, points`),
      );
      if (won) {
        await new NotificationWriter(this.db).create({
          userId: won.user_id,
          type: "points_winner",
          title: "You are Vendor of the Week!",
          body: `You finished first with ${won.points} points. Your shop is being promoted all week.`,
          targetView: "leaderboard",
          targetParams: { tab: "winners" },
          actorId: null,
        });
      }
    }
  }

  /**
   * get_points_leaderboard()'s ranking (without finalising): every verified, active, not paused shop,
   * by points, then sales, then who got there first, then name. 'week' (default), 'last_week', 'all'
   * (weekly totals) or 'month' (this calendar month's ledger). 1 to 300 rows.
   */
  leaderboard(period: string | null, limit: number | null, userId: string | null): Promise<LeaderboardRow[]> {
    const lim = sql`greatest(1, least(coalesce(${limit}::int, 100), 300))`;
    const shops = sql`
      select (row_number() over (order by coalesce(a.pts,0) desc, coalesce(a.tx,0) desc, a.la asc nulls last, v.business_name))::int as rank,
             v.user_id, v.id as vendor_id, v.business_name, v.logo_url, v.city, v.avg_rating, v.review_count,
             greatest(coalesce(a.pts,0),0)::bigint as points, coalesce(a.tx,0)::bigint as tx_count, coalesce(v.user_id = ${userId}::uuid, false) as is_me
      from public.vendors v left join agg a on a.uid = v.user_id
      where v.is_active and v.deleted_at is null and v.verification_status = 'verified' and coalesce(v.admin_paused,false) = false
      order by 1 limit ${lim}`;
    if (period === "month") {
      return jsonRows<LeaderboardRow>(
        this.db,
        sql`with agg as (
              select l.user_id uid, sum(l.points)::bigint pts, (count(*) filter (where l.kind = 'order_completed'))::bigint tx, max(l.created_at) la
              from public.points_ledger l
              where l.created_at >= (date_trunc('month', now() at time zone ${LAGOS}) at time zone ${LAGOS})
              group by l.user_id)
            ${shops}`,
      );
    }
    return jsonRows<LeaderboardRow>(
      this.db,
      sql`with cur as (select date_trunc('week', now() at time zone ${LAGOS})::date as d),
          agg as (
            select pw.user_id uid, sum(pw.points)::bigint pts, sum(pw.tx_count)::bigint tx, max(pw.last_at) la
            from public.points_weekly pw, cur
            where ${period}::text = 'all' or pw.week_start = case when ${period}::text = 'last_week' then cur.d - 7 else cur.d end
            group by pw.user_id)
          ${shops}`,
    );
  }

  /**
   * Replaces: public.points_award_order(uuid, boolean) - a completed sale earns the shop's owner points, unless it is
   * their own order, under the rule's minimum, or the same customer was already counted the rule's
   * number of times this week (each logged as a skip). Returns what happened, in the original's words.
   */
  async awardOrder(orderId: string, notify = true): Promise<string> {
    const o = await jsonRow<{ completed: boolean; buyer_id: string | null; vendor_user: string | null; under_min: boolean; min_text: string; cap: number | null; meta: string }>(
      this.db,
      sql`select o.status::text = 'completed' as completed, o.buyer_id, v.user_id as vendor_user,
                 coalesce(o.total_amount, 0) < coalesce(r.min_amount, 0) as under_min,
                 coalesce(r.min_amount, 0)::bigint::text as min_text, r.per_source_weekly_cap as cap,
                 jsonb_build_object('order_id', o.id, 'amount', o.total_amount)::text as meta
          from public.orders o
          left join public.vendors v on v.id = o.vendor_id
          left join (select * from public.points_rules where kind = 'order_completed' limit 1) r on true
          where o.id = ${orderId}`,
    );
    if (!o || !o.completed) return "not completed";
    if (!o.vendor_user) return "no vendor";
    if (o.vendor_user === o.buyer_id) {
      await this.logSkip(o.vendor_user, "order_completed", orderId, "Your own order does not count");
      return "own order";
    }
    if (o.under_min) {
      await this.logSkip(o.vendor_user, "order_completed", orderId, `Order total is under the ₦${o.min_text} minimum`);
      return "under minimum";
    }
    if (o.cap != null) {
      const week = await this.weekStart();
      const counted = await jsonRow<{ n: number }>(
        this.db,
        sql`select count(*)::int as n from public.points_ledger
            where user_id = ${o.vendor_user} and kind = 'order_completed' and source_user_id = ${o.buyer_id}::uuid and week_start = ${week}::date
              and event_key <> ${`order:${orderId}`}`,
      );
      if (counted!.n >= o.cap) {
        await this.logSkip(o.vendor_user, "order_completed", orderId, `Same customer already counted ${o.cap} times this week`);
        return "customer cap";
      }
    }
    const points = await this.award({ userId: o.vendor_user, kind: "order_completed", key: `order:${orderId}`, sourceUserId: o.buyer_id, note: "Completed sale", meta: o.meta, notify });
    return points > 0 ? "awarded" : "already counted";
  }

  /**
   * Replaces: public.points_award_review(uuid, boolean) - a 3-, 4- or 5-star review earns the shop's owner points,
   * unless they wrote it or the order is under the sales rule's minimum. Returns what happened.
   */
  async awardReview(reviewId: string, notify = true): Promise<string> {
    const rv = await jsonRow<{ buyer_id: string | null; rating: number | null; vendor_user: string | null; under_min: boolean; min_text: string }>(
      this.db,
      sql`select rv.buyer_id, rv.rating, v.user_id as vendor_user,
                 coalesce((select total_amount from public.orders where id = rv.order_id), 0)
                   < coalesce((select min_amount from public.points_rules where kind = 'order_completed'), 0) as under_min,
                 coalesce((select min_amount from public.points_rules where kind = 'order_completed'), 0)::bigint::text as min_text
          from public.reviews rv left join public.vendors v on v.id = rv.vendor_id
          where rv.id = ${reviewId}`,
    );
    if (!rv) return "no review";
    if (!rv.vendor_user) return "no vendor";
    const kind = rv.rating === 5 ? "review_5" : rv.rating === 4 ? "review_4" : rv.rating === 3 ? "review_3" : null;
    if (!kind) return "low rating";
    if (rv.vendor_user === rv.buyer_id) {
      await this.logSkip(rv.vendor_user, kind, reviewId, "A review from yourself does not count");
      return "own review";
    }
    if (rv.under_min) {
      await this.logSkip(rv.vendor_user, kind, reviewId, `Order total is under the ₦${rv.min_text} minimum`);
      return "under minimum";
    }
    const points = await this.award({ userId: rv.vendor_user, kind, key: `review:${reviewId}`, sourceUserId: rv.buyer_id, note: `${rv.rating}-star review`, meta: {}, notify });
    return points > 0 ? "awarded" : "already counted";
  }

  /** The shop owner's referrer (a referral that was not voided), if any. */
  private async referrerOf(userId: string): Promise<string | null> {
    const row = await jsonRow<{ referrer_user_id: string }>(
      this.db,
      sql`select referrer_user_id from public.referrals where referred_user_id = ${userId} and code <> 'VOID' limit 1`,
    );
    return row?.referrer_user_id ?? null;
  }

  private async shopOwner(vendorId: string): Promise<string | null> {
    return (await jsonRow<{ user_id: string | null }>(this.db, sql`select user_id from public.vendors where id = ${vendorId}`))?.user_id ?? null;
  }

  /**
   * Replaces: public.points_for_new_listing(uuid, uuid) - a new listing earns the shop's owner points, and whoever
   * referred them (for the first 10 listings).
   */
  async forNewListing(vendorId: string, listingId: string): Promise<void> {
    const owner = await this.shopOwner(vendorId);
    if (!owner) return;
    await this.award({ userId: owner, kind: "product_listed", key: `listed:${listingId}`, sourceUserId: null, note: "New listing" });
    const referrer = await this.referrerOf(owner);
    if (!referrer) return;
    const counted = await jsonRow<{ n: number }>(
      this.db,
      sql`select count(*)::int as n from public.points_ledger where user_id = ${referrer} and kind = 'ref_vendor_product' and source_user_id = ${owner}`,
    );
    if (counted!.n < 10) {
      await this.award({ userId: referrer, kind: "ref_vendor_product", key: `refprod:${listingId}`, sourceUserId: owner, note: "Referred vendor listed a product" });
    }
  }

  /** Replaces: public.points_revoke_listing(uuid, uuid) - takes back a listing's points from the owner and their referrer. */
  async revokeListing(vendorId: string, listingId: string): Promise<void> {
    const owner = await this.shopOwner(vendorId);
    if (!owner) return;
    await this.revoke(owner, `listed:${listingId}`);
    const referrer = await this.referrerOf(owner);
    if (referrer) await this.revoke(referrer, `refprod:${listingId}`);
  }

  /**
   * Replaces: public.notify_rank_upsert(uuid, text, text, jsonb) - one "rank_change" notification per 20 minutes: an unread one from
   * that window is updated (and moved to now), otherwise a new one.
   */
  async rankChanged(userId: string, title: string, body: string, meta: Record<string, unknown> | null): Promise<void> {
    const metaJson = meta == null ? null : JSON.stringify(meta);
    const [open] = rowsOf<{ id: string }>(
      await this.db.execute(sql`
        select id from public.notifications
        where user_id = ${userId} and type = 'rank_change' and read = false and archived = false and created_at > now() - interval '20 minutes'
        order by created_at desc limit 1 for update`),
    );
    if (open) {
      await this.db.execute(sql`update public.notifications set title = ${title}, body = ${body}, metadata = ${metaJson}::jsonb, created_at = now() where id = ${open.id}`);
      return;
    }
    await this.db.execute(sql`
      insert into public.notifications (user_id, type, title, body, target_view, target_params, notification_category, group_key, metadata)
      values (${userId}, 'rank_change', ${title}, ${body}, 'leaderboard', '{"tab":"ranking"}'::jsonb, 'points', ${`rank:${userId}`}, ${metaJson}::jsonb)`);
  }
}

/** Reads for the points screens (get_my_points_summary, get_my_points_activity, the admin tools). */
export class PointsReadsRepository {
  constructor(private readonly db: Executor) {}

  /** The caller's own live shop (any one, as the original's `limit 1`). */
  shopOf(userId: string): Promise<{ id: string; business_name: string | null; logo_url: string | null; referral_code: string | null } | null> {
    return jsonRow(this.db, sql`select id, business_name, logo_url, referral_code from public.vendors where user_id = ${userId} and deleted_at is null limit 1`);
  }

  /**
   * get_my_points_summary()'s totals (today, this week, this month, all time). Read before the
   * leaderboard finalises the weeks, as the original did (finalising can take listing points back).
   */
  totals(userId: string): Promise<{ today: number; week: number; month: number; all: number } | null> {
    const uid = sql`${userId}::uuid`;
    return jsonRow(
      this.db,
      sql`with k as (select date_trunc('week', now() at time zone ${LAGOS})::date as cur, (now() at time zone ${LAGOS})::date as today)
          select
            (select coalesce(sum(points) filter (where (created_at at time zone ${LAGOS})::date = (select today from k)),0) from public.points_ledger where user_id = ${uid}) as today,
            (select coalesce(sum(points) filter (where week_start = (select cur from k)),0) from public.points_ledger where user_id = ${uid}) as week,
            (select coalesce(sum(points) filter (where created_at >= (date_trunc('month', now() at time zone ${LAGOS}) at time zone ${LAGOS})),0) from public.points_ledger where user_id = ${uid}) as month,
            (select coalesce(sum(points),0) from public.points_ledger where user_id = ${uid}) as "all"`,
    );
  }

  /** The rest of get_my_points_summary(), each part computed exactly as the original did. */
  summaryParts(userId: string): Promise<Record<string, unknown> | null> {
    const uid = sql`${userId}::uuid`;
    const breakdown = (thisWeek: boolean) => sql`
      (select coalesce(jsonb_agg(x order by (x->>'points')::int desc), '[]'::jsonb) from (
        select jsonb_build_object('kind', l.kind, 'label', coalesce(r.label, initcap(replace(l.kind,'_',' '))), 'icon', coalesce(r.icon,'fa-star'),
                                  'points', sum(l.points), 'count', count(*)) x
        from public.points_ledger l left join public.points_rules r on r.kind = l.kind
        where l.user_id = ${uid} ${thisWeek ? sql`and l.week_start = (select cur from k)` : sql``}
        group by l.kind, r.label, r.icon) t)`;
    return jsonRow(
      this.db,
      sql`with k as (select date_trunc('week', now() at time zone ${LAGOS})::date as cur, (now() at time zone ${LAGOS})::date as today)
          select
            ${breakdown(false)} as breakdown_all,
            ${breakdown(true)} as breakdown_week,
            (select jsonb_agg(jsonb_build_object('date', g.d, 'points', coalesce(p.pts,0)) order by g.d)
               from (select ((select today from k) - n) d from generate_series(0, 13) n) g
               left join (select (created_at at time zone ${LAGOS})::date d, sum(points) pts from public.points_ledger
                          where user_id = ${uid} and created_at > now() - interval '16 days' group by 1) p on p.d = g.d) as daily,
            (select jsonb_agg(jsonb_build_object('week_start', g.w, 'points', coalesce(p.points,0)) order by g.w)
               from (select ((select cur from k) - 7 * n) w from generate_series(0, 7) n) g
               left join public.points_weekly p on p.user_id = ${uid} and p.week_start = g.w) as weekly,
            (select count(*) from public.vendor_week_winners where user_id = ${uid} and reward_status <> 'void')::int as weeks_won,
            jsonb_build_object(
              'referred_customers', (select count(*) from public.referrals r where r.referrer_user_id = ${uid} and r.code <> 'VOID' and not exists (select 1 from public.vendors vv where vv.user_id = r.referred_user_id)),
              'referred_vendors', (select count(*) from public.referrals r where r.referrer_user_id = ${uid} and r.code <> 'VOID' and exists (select 1 from public.vendors vv where vv.user_id = r.referred_user_id)),
              'second_level', (select count(*) from public.referrals r2 where r2.code <> 'VOID' and r2.referrer_user_id in (select referred_user_id from public.referrals where referrer_user_id = ${uid} and code <> 'VOID')),
              'points_earned', coalesce((select sum(points) from public.points_ledger where user_id = ${uid} and kind in ('ref_vendor','ref_customer','ref2_vendor','ref2_customer','ref_vendor_product','ref_social')),0),
              'recent', coalesce((select jsonb_agg(jsonb_build_object('name', coalesce(nullif(split_part(coalesce(u.name,''),' ',1),''),'New member'),
                                   'role', case when exists (select 1 from public.vendors vv where vv.user_id = rr.referred_user_id) then 'vendor' else 'customer' end,
                                   'at', rr.created_at) order by rr.created_at desc)
                                 from (select * from public.referrals where referrer_user_id = ${uid} and code <> 'VOID' order by created_at desc limit 8) rr
                                 join public.users u on u.id = rr.referred_user_id), '[]'::jsonb),
              'referred_by', (select vv.business_name from public.referrals rf join public.vendors vv on vv.id = rf.referrer_vendor_id where rf.referred_user_id = ${uid} and rf.code <> 'VOID')
            ) as referrals,
            (select coalesce(jsonb_agg(substring(event_key from 8)), '[]'::jsonb) from public.points_ledger where user_id = ${uid} and event_key like 'social:%') as socials,
            (select cur from k) as week_start,
            (((select cur from k) + 7)::timestamp at time zone ${LAGOS}) as week_ends_at,
            (select today from k)::text as today_date`,
    );
  }

  /** The Lagos days (newest first, 'YYYY-MM-DD') on which the user earned points, up to 402 days back - for the streak. */
  async positiveDays(userId: string): Promise<string[]> {
    const rows = await jsonRows<{ d: string }>(
      this.db,
      sql`select distinct (created_at at time zone ${LAGOS})::date::text as d from public.points_ledger
          where user_id = ${userId} and points > 0 and (created_at at time zone ${LAGOS})::date >= (now() at time zone ${LAGOS})::date - 402
          order by 1 desc`,
    );
    return rows.map((r) => r.d);
  }

  /** get_my_points_activity(): the caller's ledger, newest first, 1 to 100 rows (40 by default), optionally before a time. */
  activity(userId: string, limit: number | null, before: string | null): Promise<Record<string, unknown>[]> {
    return jsonRows(
      this.db,
      sql`select l.id, l.kind, coalesce(r.label, initcap(replace(l.kind,'_',' '))) as label, coalesce(r.icon,'fa-star') as icon, l.points, l.note,
                 nullif(split_part(coalesce(u.name,''),' ',1),'') as source_name, l.created_at
          from public.points_ledger l
          left join public.points_rules r on r.kind = l.kind
          left join public.users u on u.id = l.source_user_id
          where l.user_id = ${userId} and (${before}::timestamptz is null or l.created_at < ${before}::timestamptz)
          order by l.created_at desc limit greatest(1, least(coalesce(${limit}::int, 40), 100))`,
    );
  }

  /** get_past_week_winners(): newest first, 1 to 52 (12 by default); voided wins left out. */
  pastWinners(limit: number | null): Promise<Record<string, unknown>[]> {
    return jsonRows(
      this.db,
      sql`select ww.week_start, ww.vendor_id, v.business_name, v.logo_url, ww.points, ww.top3
          from public.vendor_week_winners ww join public.vendors v on v.id = ww.vendor_id
          where ww.reward_status <> 'void'
          order by ww.week_start desc limit greatest(1, least(coalesce(${limit}::int, 12), 52))`,
    );
  }

  /** get_vendor_spotlight()'s winner: last week's (not voided, shop still live), or null. */
  lastWeeksWinner(): Promise<Record<string, unknown> | null> {
    return jsonRow(
      this.db,
      sql`select jsonb_build_object('vendor_id', v.id, 'business_name', v.business_name, 'logo_url', v.logo_url, 'cover', coalesce(v.cover_url, v.cover_image_url),
                                    'city', v.city, 'avg_rating', v.avg_rating, 'review_count', v.review_count, 'bio', left(coalesce(v.bio,''), 140),
                                    'points', ww.points, 'week_start', ww.week_start) as winner
          from public.vendor_week_winners ww join public.vendors v on v.id = ww.vendor_id
          where ww.week_start = date_trunc('week', now() at time zone ${LAGOS})::date - 7 and ww.reward_status <> 'void' and v.deleted_at is null and v.is_active = true`,
    );
  }

  /** The end of this points week (next Monday 00:00 in Lagos). */
  async weekEndsAt(): Promise<string> {
    const row = await jsonRow<{ at: string }>(this.db, sql`select ((date_trunc('week', now() at time zone ${LAGOS})::date + 7)::timestamp at time zone ${LAGOS}) as at`);
    return row!.at;
  }

  /* ------------------------------------------------------------------------- admin */

  recentAdjustments(userId: string): Promise<Record<string, unknown>[]> {
    return jsonRows(
      this.db,
      sql`select l.created_at, l.points, l.note from public.points_ledger l
          where l.user_id = ${userId} and l.kind = 'admin_adjustment' order by l.created_at desc limit 10`,
    );
  }

  recentSkips(limit: number | null): Promise<Record<string, unknown>[]> {
    return jsonRows(
      this.db,
      sql`select s.created_at, s.kind, s.reason, v.business_name, u.name, s.ref
          from public.points_skips s
          left join public.users u on u.id = s.user_id
          left join public.vendors v on v.user_id = s.user_id and v.deleted_at is null
          where not exists (select 1 from public.points_ledger l where l.user_id = s.user_id and l.event_key in ('order:' || s.ref, 'review:' || s.ref))
          order by s.created_at desc limit greatest(1, least(coalesce(${limit}::int, 30), 100))`,
    );
  }

  /** admin_search_points_users(): by name, email, shop name, or the last 9 digits of a phone number (6+ digits typed). */
  searchUsers(q: string, digits: string): Promise<Record<string, unknown>[]> {
    return jsonRows(
      this.db,
      sql`select u.id as user_id, u.name, u.phone, u.email, u.role::text as role, v.business_name, v.id as vendor_id,
                 coalesce((select sum(l.points) from public.points_ledger l where l.user_id = u.id and l.week_start = date_trunc('week', now() at time zone ${LAGOS})::date), 0)::bigint as week_points,
                 coalesce((select sum(l.points) from public.points_ledger l where l.user_id = u.id), 0)::bigint as all_points
          from public.users u
          left join public.vendors v on v.user_id = u.id and v.deleted_at is null
          where u.name ilike '%' || ${q}::text || '%' or coalesce(u.email, '') ilike '%' || ${q}::text || '%' or coalesce(v.business_name, '') ilike '%' || ${q}::text || '%'
             or (length(${digits}::text) >= 6 and right(regexp_replace(coalesce(u.phone, ''), '[^0-9]', '', 'g'), 9) = right(${digits}::text, 9))
          order by (v.id is not null) desc, u.name
          limit 12`,
    );
  }

  /** Accounts whose phone ends with these 10 digits. */
  usersByPhone(digits10: string): Promise<{ id: string; name: string | null }[]> {
    return jsonRows(this.db, sql`select id, name from public.users where right(regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g'), 10) = ${digits10}`);
  }

  userExists(userId: string): Promise<boolean> {
    return jsonRow(this.db, sql`select 1 as x from public.users where id = ${userId}`).then((r) => r !== null);
  }

  /* ---------------------------------------------------------------------- referrals */

  /** The live, active shop with this referral code. */
  shopByCode(code: string): Promise<{ id: string; user_id: string; business_name: string | null; logo_url: string | null } | null> {
    return jsonRow(this.db, sql`select id, user_id, business_name, logo_url from public.vendors where referral_code = ${code} and deleted_at is null and is_active = true`);
  }

  /** The (not voided) referral that brought this user in. */
  referralOf(userId: string): Promise<{ referrer_user_id: string } | null> {
    return jsonRow(this.db, sql`select referrer_user_id from public.referrals where referred_user_id = ${userId} and code <> 'VOID'`);
  }

  profile(userId: string): Promise<{ id: string; phone: string | null; role: string; too_late: boolean } | null> {
    return jsonRow(this.db, sql`select id, phone, role::text as role, created_at < now() - interval '7 days' as too_late from public.users where id = ${userId}`);
  }

  isVendorAccount(userId: string): Promise<boolean> {
    return jsonRow(this.db, sql`select 1 as x from public.vendors where user_id = ${userId}`).then((r) => r !== null);
  }

  /** Records the referral; replaces only a voided one. */
  async recordReferral(userId: string, shop: { id: string; user_id: string }, code: string): Promise<void> {
    await this.db.execute(sql`
      insert into public.referrals (referred_user_id, referrer_user_id, referrer_vendor_id, code)
      values (${userId}, ${shop.user_id}, ${shop.id}, ${code})
      on conflict (referred_user_id) do update set referrer_user_id = excluded.referrer_user_id,
        referrer_vendor_id = excluded.referrer_vendor_id, code = excluded.code, vendor_awarded = false, created_at = now()
      where public.referrals.code = 'VOID'`);
  }

  /** A referral code as typed: white space removed, upper case. */
  async normaliseCode(code: string | null): Promise<string> {
    const row = await jsonRow<{ c: string }>(this.db, sql`select upper(regexp_replace(coalesce(${code}::text,''), '[[:space:]]', '', 'g')) as c`);
    return row!.c;
  }

  /** `from("points_rules").select("*").eq("active", true).order("sort_order")` - what each activity earns (anyone may read). */
  activeRules(): Promise<Record<string, unknown>[]> {
    return jsonRows(this.db, sql`select * from public.points_rules where active = true order by sort_order`);
  }
}
