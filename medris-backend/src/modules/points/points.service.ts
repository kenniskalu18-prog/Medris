import type { DataContext, Identity } from "../../database/context.js";
import { AccessRepository } from "../../database/repositories/access.repository.js";
import { NotificationWriter } from "../../database/repositories/notification-writer.repository.js";
import { PointsReadsRepository, PointsRepository, type LeaderboardRow } from "../../database/repositories/points.repository.js";
import { ReferralsRepository } from "../../database/repositories/referrals.repository.js";
import { isSqlBlank, sqlTrim } from "../../lib/sql-text.js";

type Tx = Parameters<Parameters<DataContext["asService"]>[0]>[0];

/** Days back from `day` ('YYYY-MM-DD'), as 'YYYY-MM-DD'. */
function daysBefore(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Vendor points: the leaderboard, Vendor of the Week, the caller's summary and activity,
 * referral codes, and the admin tools.
 */
export class PointsService {
  constructor(private readonly db: () => DataContext) {}

  /** Writes that the original did inside a SECURITY DEFINER function: on the caller's behalf when signed in. */
  private write<T>(me: Identity | null, work: (tx: Tx) => Promise<T>): Promise<T> {
    return me ? this.db().onBehalfOf(me, work) : this.db().asService(work);
  }

  /**
   * Replaces: public.get_points_leaderboard(text, integer) - shops by points for 'week' (default),
   * 'last_week', 'month' or 'all'. Finished weeks get their winner first.
   */
  leaderboard(me: Identity | null, period: string | null, limit: number | null): Promise<LeaderboardRow[]> {
    return this.write(me, async (tx) => {
      const points = new PointsRepository(tx);
      await points.finalizeWeeks();
      return points.leaderboard(period, limit, me?.userId ?? null);
    });
  }

  /** Replaces: public.get_past_week_winners(integer) */
  pastWinners(limit: number | null): Promise<Record<string, unknown>[]> {
    return this.db().asService((tx) => new PointsReadsRepository(tx).pastWinners(limit));
  }

  /** Replaces: public.get_vendor_spotlight() - last week's winner and this week's top three (with points). */
  spotlight(me: Identity | null): Promise<Record<string, unknown>> {
    return this.write(me, async (tx) => {
      const points = new PointsRepository(tx);
      const reads = new PointsReadsRepository(tx);
      await points.finalizeWeeks();
      const winner = (await reads.lastWeeksWinner())?.winner ?? null;
      const leaders = (await points.leaderboard("week", 3, me?.userId ?? null))
        .filter((t) => t.points > 0)
        .map((t) => ({ rank: t.rank, vendor_id: t.vendor_id, business_name: t.business_name, logo_url: t.logo_url, points: t.points }));
      return { winner, leaders, week_ends_at: await reads.weekEndsAt() };
    });
  }

  /** Replaces: public.get_my_points_summary() - everything the "My points" screen shows. */
  async summary(me: Identity | null): Promise<Record<string, unknown>> {
    if (!me) return { signed_in: false };
    return this.db().onBehalfOf(me, async (tx) => {
      const reads = new PointsReadsRepository(tx);
      const shop = await reads.shopOf(me.userId);
      const totals = (await reads.totals(me.userId))!;
      let rank: number | null = null;
      let total: number | null = null;
      let nextName: string | null = null;
      let nextPoints: number | null = null;
      let leaderPoints: number | null = null;
      if (shop) {
        const points = new PointsRepository(tx);
        await points.finalizeWeeks();
        const board = await points.leaderboard("week", 300, me.userId);
        rank = board.find((t) => t.is_me)?.rank ?? null;
        total = board.length;
        if (rank !== null && rank > 1) {
          const next = board.find((t) => t.rank === rank! - 1);
          nextName = next?.business_name ?? null;
          nextPoints = next?.points ?? null;
        }
        leaderPoints = board.length > 0 ? Math.max(...board.slice(0, 1).map((t) => t.points)) : null;
      }
      const parts = (await reads.summaryParts(me.userId))!;
      const { today_date: today, ...rest } = parts as Record<string, unknown> & { today_date: string };
      return {
        signed_in: true,
        is_vendor: shop !== null,
        vendor_id: shop?.id ?? null,
        business_name: shop?.business_name ?? null,
        logo_url: shop?.logo_url ?? null,
        referral_code: shop?.referral_code ?? null,
        rank,
        vendor_total: total,
        week_leader_points: leaderPoints,
        next_name: nextName,
        next_points: nextPoints,
        streak: this.streak(today, await reads.positiveDays(me.userId)),
        ...totals,
        ...rest,
      };
    });
  }

  /** Consecutive days with points, ending today (or yesterday, when nothing was earned yet today); at most 400. */
  private streak(today: string, days: string[]): number {
    const earned = new Set(days);
    let day = earned.has(today) ? today : daysBefore(today, 1);
    let streak = 0;
    while (streak < 400 && earned.has(day)) {
      streak += 1;
      day = daysBefore(day, 1);
    }
    return streak;
  }

  /** Replaces: public.get_my_points_activity(integer, timestamp with time zone) */
  async activity(me: Identity | null, limit: number | null, before: string | null): Promise<Record<string, unknown>[]> {
    if (!me) return [];
    return this.db().asService((tx) => new PointsReadsRepository(tx).activity(me.userId, limit, before));
  }

  /** Replaces: public.validate_referral_code(text) - whether a code belongs to a live shop (and which). */
  validateCode(code: string | null): Promise<Record<string, unknown>> {
    return this.db().asService(async (tx) => {
      const reads = new PointsReadsRepository(tx);
      const c = await reads.normaliseCode(code);
      if ([...c].length < 4) return { valid: false };
      const shop = await reads.shopByCode(c);
      if (!shop) return { valid: false };
      return { valid: true, business_name: shop.business_name, logo_url: shop.logo_url };
    });
  }

  /** Replaces: public.apply_referral_code(text) - the caller joined through a shop's code (within 7 days of signing up). */
  async applyCode(me: Identity | null, code: string | null): Promise<Record<string, unknown>> {
    if (!me) return { ok: false, error: "not_signed_in" };
    return this.db().onBehalfOf(me, (tx) => this.applyReferral(tx, me.userId, code, false));
  }

  /** apply_referral_internal() (see ReferralsRepository.apply), inside the caller's transaction. */
  applyReferral(tx: Tx, userId: string | null, code: string | null, skipCustomer: boolean): Promise<Record<string, unknown>> {
    return new ReferralsRepository(tx).apply(userId, code, skipCustomer);
  }

  /* ------------------------------------------------------------------------- admin */

  /** Replaces: public.admin_adjust_points(uuid, integer, text) - add or take away up to 10,000 points; the user is told. */
  async adjust(me: Identity | null, userId: string, amount: number | null, note: string | null): Promise<Record<string, unknown>> {
    return this.write(me, async (tx) => {
      if (!(await new AccessRepository(tx).isAdmin(me?.userId))) return { ok: false, error: "forbidden" };
      if (amount == null || amount === 0) return { ok: false, error: "bad_points", message: "Enter a number of points." };
      if (Math.abs(amount) > 10000) return { ok: false, error: "too_big", message: "That is too many points in one go." };
      if (!(await new PointsReadsRepository(tx).userExists(userId))) return { ok: false, error: "not_found" };
      const text = isSqlBlank(note) ? "Adjustment by Levromart" : sqlTrim(note!);
      const key = `admin:${crypto.randomUUID()}`;
      const applied = await new PointsRepository(tx).award({ userId, kind: "admin_adjustment", key, sourceUserId: me!.userId, note: text, meta: {}, points: amount, notify: false });
      await new NotificationWriter(tx).create({
        userId,
        type: "points",
        title: `${amount > 0 ? "+" : ""}${amount} points`,
        body: text,
        targetView: "leaderboard",
        targetParams: { tab: "activity" },
        actorId: null,
      });
      return { ok: true, applied };
    });
  }

  /** Replaces: public.admin_award_social_points(text, text) - points for following Levromart (Instagram, TikTok, LinkedIn), found by phone. */
  async awardSocial(me: Identity | null, phone: string | null, platform: string | null): Promise<Record<string, unknown>> {
    return this.write(me, async (tx) => {
      if (!(await new AccessRepository(tx).isAdmin(me?.userId))) return { ok: false, error: "forbidden" };
      const pf = (platform ?? "").toLowerCase();
      if (!["instagram", "tiktok", "linkedin"].includes(pf)) return { ok: false, error: "bad_platform" };
      const digits = (phone ?? "").replace(/\D/g, "").slice(-10);
      if (digits.length < 10) return { ok: false, error: "bad_phone", message: "Enter the full phone number." };
      const reads = new PointsReadsRepository(tx);
      const users = await reads.usersByPhone(digits);
      if (users.length === 0) return { ok: false, error: "not_found", message: "No account uses that phone number." };
      if (users.length > 1) return { ok: false, error: "ambiguous", message: "More than one account uses that number." };
      const user = users[0]!;
      const name = pf.charAt(0).toUpperCase() + pf.slice(1);
      const points = new PointsRepository(tx);
      const awarded = await points.award({ userId: user.id, kind: "social_follow", key: `social:${pf}`, sourceUserId: null, note: `Followed Levromart on ${name}` });
      let referrerAwarded = 0;
      const upline = await reads.referralOf(user.id);
      if (upline) {
        referrerAwarded = await points.award({
          userId: upline.referrer_user_id,
          kind: "ref_social",
          key: `refsocial:${pf}:${user.id}`,
          sourceUserId: user.id,
          note: `Your referral followed us on ${name}`,
        });
      }
      return { ok: true, name: user.name, awarded, referrer_awarded: referrerAwarded, already: awarded === 0 };
    });
  }

  /** Replaces: public.admin_recent_points_adjustments(uuid) - empty for anyone but admins. */
  recentAdjustments(me: Identity | null, userId: string): Promise<Record<string, unknown>[]> {
    return this.db().asService(async (tx) => ((await new AccessRepository(tx).isAdmin(me?.userId)) ? new PointsReadsRepository(tx).recentAdjustments(userId) : []));
  }

  /** Replaces: public.admin_recent_points_skips(integer) - points not given (caps), still unresolved; empty for anyone but admins. */
  recentSkips(me: Identity | null, limit: number | null): Promise<Record<string, unknown>[]> {
    return this.db().asService(async (tx) => ((await new AccessRepository(tx).isAdmin(me?.userId)) ? new PointsReadsRepository(tx).recentSkips(limit) : []));
  }

  /** Replaces: public.admin_search_points_users(text) - at most 12, shops first; empty for anyone but admins or under 2 characters. */
  searchUsers(me: Identity | null, query: string | null): Promise<Record<string, unknown>[]> {
    return this.db().asService(async (tx) => {
      if (!(await new AccessRepository(tx).isAdmin(me?.userId))) return [];
      const q = sqlTrim(query ?? "");
      if ([...q].length < 2) return [];
      return new PointsReadsRepository(tx).searchUsers(q, (query ?? "").replace(/\D/g, ""));
    });
  }

  /** What each activity earns (active rules, in display order). Replaces the app's select on points_rules; anyone may read them. */
  rules(me: Identity | null): Promise<Record<string, unknown>[]> {
    return me ? this.db().asUser(me, (tx) => new PointsReadsRepository(tx).activeRules()) : this.db().asAnon((tx) => new PointsReadsRepository(tx).activeRules());
  }
}
