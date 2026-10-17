import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DataContext, Identity } from "../../src/database/context.js";
import { callFunction } from "../../src/database/rpc.js";
import { PointsRepository } from "../../src/database/repositories/points.repository.js";
import { PointsService } from "../../src/modules/points/points.service.js";
import { identityOf, seedProduct, seedUser, seedVendor, setRole, uuid } from "../support/fixtures.js";
import { comparable, runIsolated, runOriginal, runOriginalAsService, type CompareOptions, type RunOutcome } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/** PointsService replaces the points, leaderboard and referral functions; each case runs the original and the port on the same rows. */
describe("parity: points and referrals", () => {
  let db: TestDatabase;
  let admin: string;
  let ada: string; // shop owner, leads this week
  let bayo: string; // shop owner, referred by Ada's shop
  let chi: string; // shop owner, no points
  let buyer: string; // new buyer
  let oldBuyer: string; // signed up 30 days ago
  let referred: string; // buyer already referred by Bayo
  let adaShop: string;
  let bayoShop: string;
  let gone: string; // a removed product with listing points

  const week = `date_trunc('week', now() at time zone 'Africa/Lagos')::date`;

  beforeAll(async () => {
    db = await createTestDatabase();
    admin = (await seedUser(db)).id;
    await setRole(db, admin, "admin");
    ada = (await seedUser(db, { role: "vendor", name: "Ada Obi" })).id;
    bayo = (await seedUser(db, { role: "vendor", name: "Bayo Ade" })).id;
    chi = (await seedUser(db, { role: "vendor", name: "Chi Eze" })).id;
    buyer = (await seedUser(db, { name: "Tola New", phone: "08031234567" })).id;
    oldBuyer = (await seedUser(db)).id;
    referred = (await seedUser(db, { name: "Kemi Ref" })).id;
    adaShop = (await seedVendor(db, ada, { name: "Ada Styles", referralCode: "ADA123" })).id;
    bayoShop = (await seedVendor(db, bayo, { name: "Bayo Gadgets", referralCode: "BAYO77" })).id;
    await seedVendor(db, chi, { name: "Chi Foods", referralCode: "CHI999" });
    await db.query(`update public.users set created_at = now() - interval '30 days' where id = $1`, [oldBuyer]);

    await db.query(`
      insert into public.points_rules (kind, label, description, points, daily_cap, weekly_cap, icon) values
        ('order_completed', 'Order completed', 'A sale', 20, null, null, 'fa-bag-shopping'),
        ('product_listed', 'New listing', 'A listing', 5, null, 10, 'fa-tag'),
        ('ref_customer', 'Customer referral', 'A customer joined', 15, null, null, 'fa-user-plus'),
        ('ref2_customer', 'Second-level referral', 'Your referral brought a customer', 5, null, null, 'fa-users'),
        ('social_follow', 'Social follow', 'Followed us', 10, 1, null, 'fa-heart'),
        ('ref_social', 'Referral followed us', 'Your referral followed us', 3, null, null, 'fa-share')`);
    // Bayo's shop came through Ada's code; Kemi through Bayo's.
    await db.query(`insert into public.referrals (referred_user_id, referrer_user_id, referrer_vendor_id, code) values ($1, $2, $3, 'ADA123'), ($4, $5, $6, 'BAYO77')`, [
      bayo,
      ada,
      adaShop,
      referred,
      bayo,
      bayoShop,
    ]);

    gone = await seedProduct(db, adaShop, { status: "removed" });
    const live = await seedProduct(db, adaShop);
    const ledger = (user: string, kind: string, pts: number, key: string, at: string, source: string | null = null) =>
      db.query(
        `insert into public.points_ledger (user_id, kind, points, event_key, source_user_id, created_at, week_start)
         values ($1, $2, $3, $4, $5, now() - $6::interval, date_trunc('week', (now() - $6::interval) at time zone 'Africa/Lagos')::date)`,
        [user, kind, pts, key, source, at],
      );
    await ledger(ada, "order_completed", 20, `order:${uuid()}`, "1 minute", buyer);
    await ledger(ada, "product_listed", 5, `listing:${gone}`, "2 minutes");
    await ledger(ada, "product_listed", 5, `listing:${live}`, "1 day");
    await ledger(ada, "order_completed", 20, `order:${uuid()}`, "2 days");
    await ledger(ada, "social_follow", 10, "social:instagram", "3 days");
    await ledger(bayo, "order_completed", 20, `order:${uuid()}`, "10 days");
    await ledger(ada, "admin_adjustment", -5, `admin:${uuid()}`, "4 hours", admin);
    // Weekly totals rebuilt from the ledger (shop approval already awarded some through the triggers).
    await db.query(`delete from public.points_weekly`);
    await db.query(`
      insert into public.points_weekly (user_id, week_start, points, tx_count, last_at)
      select user_id, week_start, sum(points), count(*) filter (where kind = 'order_completed'), max(created_at)
      from public.points_ledger group by user_id, week_start`);
    // An earlier week already decided, one still to decide (last week's points, no winner yet).
    await db.query(`insert into public.vendor_week_winners (week_start, user_id, vendor_id, points, top3) values (${week} - 21, $1, $2, 99, '[]')`, [bayo, bayoShop]);
    await db.query(`insert into public.points_skips (user_id, kind, ref, reason) values ($1, 'order_completed', 'abc', 'Daily limit of 3 reached')`, [bayo]);
  }, 60_000);
  afterAll(() => db.close());

  const points = (ctx: DataContext) => new PointsService(() => ctx);
  const me = (id: string | null): Identity | null => (id ? identityOf(id) : null);
  async function same(original: Promise<RunOutcome>, port: Promise<RunOutcome>, options?: CompareOptions) {
    const { original: a, port: b } = comparable(await original, await port, options);
    expect(b).toEqual(a);
    return a;
  }

  describe("get_points_leaderboard (finalises finished weeks first)", () => {
    for (const period of ["week", "last_week", "month", "all", null]) {
      for (const [label, who] of [["Ada", () => ada], ["signed out", () => null]] as const) {
        it(`${period ?? "default"}, ${label}`, () =>
          same(
            runOriginal(db, me(who()), "get_points_leaderboard", { p_period: period, p_limit: 100 }),
            runIsolated(db, (ctx) => points(ctx).leaderboard(me(who()), period, 100)),
          ),
        );
      }
    }
    for (const limit of [1, 0, 1000, null]) {
      it(`limit ${limit}`, () =>
        same(
          runOriginal(db, null, "get_points_leaderboard", { p_period: "all", p_limit: limit }),
          runIsolated(db, (ctx) => points(ctx).leaderboard(null, "all", limit)),
        ),
      );
    }
  });

  for (const limit of [12, 1, null]) {
    it(`get_past_week_winners limit ${limit}`, () =>
      same(runOriginal(db, null, "get_past_week_winners", { p_limit: limit }), runIsolated(db, (ctx) => points(ctx).pastWinners(limit))),
    );
  }

  for (const [label, who] of [["signed out", () => null], ["Ada", () => ada]] as const) {
    it(`get_vendor_spotlight, ${label}`, () =>
      same(runOriginal(db, me(who()), "get_vendor_spotlight"), runIsolated(db, (ctx) => points(ctx).spotlight(me(who())))),
    );
  }

  describe("get_my_points_summary", () => {
    for (const [label, who] of [
      ["the leading shop", () => ada],
      ["a shop referred by another", () => bayo],
      ["a shop with no points", () => chi],
      ["a buyer", () => buyer],
      ["signed out", () => null],
    ] as const) {
      it(label, () => same(runOriginal(db, me(who()), "get_my_points_summary"), runIsolated(db, (ctx) => points(ctx).summary(me(who())))));
    }
  });

  describe("get_my_points_activity", () => {
    const cases: [string, () => string | null, number | null, string | null][] = [
      ["default", () => ada, null, null],
      ["limit 2", () => ada, 2, null],
      ["limit 0 means 1", () => ada, 0, null],
      ["before a time", () => ada, 40, new Date(Date.now() - 3_600_000).toISOString()],
      ["signed out", () => null, null, null],
    ];
    for (const [label, who, limit, before] of cases) {
      it(label, () =>
        same(
          runOriginal(db, me(who()), "get_my_points_activity", { p_limit: limit, p_before: before }),
          runIsolated(db, (ctx) => points(ctx).activity(me(who()), limit, before)),
        ),
      );
    }
  });

  describe("validate_referral_code", () => {
    for (const code of ["ADA123", " ada 123 ", "ada1", "NOPE99", "", null]) {
      it(JSON.stringify(code), () =>
        same(runOriginal(db, null, "validate_referral_code", { p_code: code }), runIsolated(db, (ctx) => points(ctx).validateCode(code))),
      );
    }
  });

  describe("apply_referral_code", () => {
    const cases: [string, () => string | null, string | null][] = [
      ["a new buyer: the shop and its referrer get points", () => buyer, "bayo77"],
      ["a new buyer, a shop with no referrer", () => buyer, "ADA123"],
      ["already referred", () => referred, "ADA123"],
      ["after 7 days", () => oldBuyer, "ADA123"],
      ["an unknown code", () => buyer, "NOPE99"],
      ["one's own code", () => ada, "ADA123"],
      ["a vendor account gets referred without customer points", () => chi, "ADA123"],
      ["no code", () => buyer, "  "],
      ["signed out", () => null, "ADA123"],
    ];
    for (const [label, who, code] of cases) {
      it(label, () =>
        same(runOriginal(db, me(who()), "apply_referral_code", { p_code: code }), runIsolated(db, (ctx) => points(ctx).applyCode(me(who()), code))),
      );
    }
  });

  describe("admin_adjust_points", () => {
    // The ledger key holds a random id on both sides.
    const opts: CompareOptions = { volatile: ["event_key"] };
    const cases: [string, () => string | null, () => string, number | null, string | null][] = [
      ["adds points, the user is told", () => admin, () => bayo, 250, "Bonus for the campaign"],
      ["takes points away, default note", () => admin, () => bayo, -30, "  "],
      ["zero is refused", () => admin, () => bayo, 0, null],
      ["missing is refused", () => admin, () => bayo, null, null],
      ["more than 10,000 is refused", () => admin, () => bayo, 10001, null],
      ["an unknown user", () => admin, () => uuid(), 5, null],
      ["not an admin", () => ada, () => bayo, 5, null],
      ["signed out", () => null, () => bayo, 5, null],
    ];
    for (const [label, who, user, amount, note] of cases) {
      it(label, () =>
        same(
          runOriginal(db, me(who()), "admin_adjust_points", { p_user: user(), p_points: amount, p_note: note }),
          runIsolated(db, (ctx) => points(ctx).adjust(me(who()), user(), amount, note)),
          opts,
        ),
      );
    }
  });

  describe("admin_award_social_points", () => {
    const cases: [string, () => string | null, string | null, string | null][] = [
      ["an account by its international number", () => admin, "+234 803 123 4567", "TikTok"],
      ["a referred account: the referrer gets points too", () => admin, "phone-of-kemi", "instagram"],
      ["a platform already awarded", () => admin, "phone-of-ada", "instagram"],
      ["an unknown platform", () => admin, "08031234567", "facebook"],
      ["a short phone number", () => admin, "0803123", "instagram"],
      ["no account with that number", () => admin, "09099999999", "instagram"],
      ["not an admin", () => ada, "08031234567", "instagram"],
    ];
    for (const [label, who, phone, platform] of cases) {
      it(label, async () => {
        let number = phone;
        const owner = phone === "phone-of-ada" ? ada : phone === "phone-of-kemi" ? referred : null;
        if (owner) number = (await db.query<{ phone: string }>(`select phone from public.users where id = $1`, [owner]))[0]!.phone;
        await same(
          runOriginal(db, me(who()), "admin_award_social_points", { p_phone: number, p_platform: platform }),
          runIsolated(db, (ctx) => points(ctx).awardSocial(me(who()), number, platform)),
        );
      });
    }
    it("the daily limit: a second platform the same day", async () => {
      const original = await runIsolated(db, async (ctx) => {
        const call = (platform: string) => ctx.asCaller(me(admin), (tx) => callFunction(tx, "admin_award_social_points", { p_phone: "08031234567", p_platform: platform }));
        await call("tiktok");
        return call("linkedin");
      });
      const port = await runIsolated(db, async (ctx) => {
        await points(ctx).awardSocial(me(admin), "08031234567", "tiktok");
        return points(ctx).awardSocial(me(admin), "08031234567", "linkedin");
      });
      const { original: a, port: b } = comparable(original, port);
      expect(b).toEqual(a);
      expect(a.changes.points_skips).toMatchObject({ inserted: [expect.stringContaining("Daily limit of 1 reached")] });
    });
    it("two accounts with one number", async () => {
      const dup = (await seedUser(db)).id;
      // Phone numbers are unique as typed; the same number written another way still matches.
      await db.query(`update public.users set phone = '+2348031234567' where id = $1`, [dup]);
      await same(
        runOriginal(db, me(admin), "admin_award_social_points", { p_phone: "08031234567", p_platform: "instagram" }),
        runIsolated(db, (ctx) => points(ctx).awardSocial(me(admin), "08031234567", "instagram")),
      );
      await db.query(`update public.users set phone = null where id = $1`, [dup]);
    });
  });

  describe("admin reads", () => {
    for (const [label, who] of [["an admin", () => admin], ["not an admin", () => ada]] as const) {
      it(`admin_recent_points_adjustments, ${label}`, () =>
        same(
          runOriginal(db, me(who()), "admin_recent_points_adjustments", { p_user: ada }),
          runIsolated(db, (ctx) => points(ctx).recentAdjustments(me(who()), ada)),
        ),
      );
      it(`admin_recent_points_skips, ${label}`, () =>
        same(runOriginal(db, me(who()), "admin_recent_points_skips", { p_limit: 30 }), runIsolated(db, (ctx) => points(ctx).recentSkips(me(who()), 30))),
      );
    }
    for (const q of ["ada", "Bayo Gadgets", "x", "  ", "0803 123 4567", "test.dev", null]) {
      it(`admin_search_points_users ${JSON.stringify(q)}`, () =>
        same(runOriginal(db, me(admin), "admin_search_points_users", { p_q: q }), runIsolated(db, (ctx) => points(ctx).searchUsers(me(admin), q))),
      );
    }
    it("admin_search_points_users, not an admin", () =>
      same(runOriginal(db, me(ada), "admin_search_points_users", { p_q: "ada" }), runIsolated(db, (ctx) => points(ctx).searchUsers(me(ada), "ada"))));
  });

  describe("helpers (used by other functions and triggers)", () => {
    const repo = (ctx: DataContext, work: (r: PointsRepository) => Promise<unknown>) => ctx.asService((tx) => work(new PointsRepository(tx)));
    const award = (args: Record<string, unknown>) => ({
      userId: args.p_user as string | null,
      kind: args.p_kind as string,
      key: args.p_key as string | null,
      sourceUserId: (args.p_source as string | undefined) ?? null,
      note: (args.p_note as string | undefined) ?? null,
      meta: (args.p_meta as Record<string, unknown> | undefined) ?? null,
      points: (args.p_points as number | undefined) ?? null,
      notify: (args.p_notify as boolean | undefined) ?? true,
    });
    const awards: [string, () => Record<string, unknown>][] = [
      ["the rule's points, grouped into the open points notification", () => ({ p_user: ada, p_kind: "order_completed", p_key: "order:new-1", p_source: buyer })],
      ["a new notification for someone without an open one", () => ({ p_user: chi, p_kind: "product_listed", p_key: "listing:x", p_note: "Listed a thing" })],
      ["a key already used gives nothing", () => ({ p_user: ada, p_kind: "social_follow", p_key: "social:instagram" })],
      ["another platform, under the daily limit", () => ({ p_user: ada, p_kind: "social_follow", p_key: "social:tiktok" })],
      ["an unknown rule gives nothing", () => ({ p_user: ada, p_kind: "nope", p_key: "nope:1" })],
      ["fixed points without a rule, no notification", () => ({ p_user: bayo, p_kind: "admin_adjustment", p_key: "admin:fixed", p_points: -12, p_notify: false, p_meta: { by: "test" } })],
      ["zero points give nothing", () => ({ p_user: bayo, p_kind: "admin_adjustment", p_key: "admin:zero", p_points: 0 })],
      ["an unknown user", () => ({ p_user: uuid(), p_kind: "order_completed", p_key: "order:z" })],
      ["no key", () => ({ p_user: ada, p_kind: "order_completed", p_key: null })],
    ];
    for (const [label, args] of awards) {
      it(`award_points: ${label}`, () =>
        same(runOriginalAsService(db, "award_points", args()), runIsolated(db, (ctx) => repo(ctx, (r) => r.award(award(args()))))),
      );
    }
    it("award_points: the weekly limit", async () => {
      await db.query(`update public.points_rules set weekly_cap = 1 where kind = 'order_completed'`);
      try {
        const args = { p_user: ada, p_kind: "order_completed", p_key: "order:capped" };
        await same(runOriginalAsService(db, "award_points", args), runIsolated(db, (ctx) => repo(ctx, (r) => r.award(award(args)))));
      } finally {
        await db.query(`update public.points_rules set weekly_cap = null where kind = 'order_completed'`);
      }
    });
    it("award_points: an inactive rule gives nothing", async () => {
      await db.query(`update public.points_rules set active = false where kind = 'ref_customer'`);
      try {
        const args = { p_user: ada, p_kind: "ref_customer", p_key: "refc:x" };
        await same(runOriginalAsService(db, "award_points", args), runIsolated(db, (ctx) => repo(ctx, (r) => r.award(award(args)))));
      } finally {
        await db.query(`update public.points_rules set active = true where kind = 'ref_customer'`);
      }
    });

    for (const [label, key] of [["an entry", () => `listing:${gone}`], ["an unknown key", () => "nope"]] as const) {
      it(`revoke_points: ${label}`, () =>
        same(runOriginalAsService(db, "revoke_points", { p_user: ada, p_key: key() }), runIsolated(db, (ctx) => repo(ctx, (r) => r.revoke(ada, key()))), {
          result: () => null,
        }),
      );
    }
    it("points_reconcile_listings", () =>
      same(runOriginalAsService(db, "points_reconcile_listings"), runIsolated(db, (ctx) => repo(ctx, (r) => r.reconcileListings())), { result: () => null }));
    it("finalize_points_weeks", () =>
      same(runOriginalAsService(db, "finalize_points_weeks"), runIsolated(db, (ctx) => repo(ctx, (r) => r.finalizeWeeks())), { result: () => null }));
    for (const [label, who] of [["with an open points notification", () => ada], ["without one", () => bayo]] as const) {
      it(`notify_points ${label}`, () =>
        same(
          runOriginalAsService(db, "notify_points", { p_user: who(), p_pts: 7, p_note: null }),
          runIsolated(db, (ctx) => repo(ctx, (r) => r.notify(who(), 7, null))),
          { result: () => null },
        ),
      );
    }
    for (const [label, ref] of [["a new skip", "new-ref"], ["one already logged", "abc"]] as const) {
      it(`points_log_skip: ${label}`, () =>
        same(
          runOriginalAsService(db, "points_log_skip", { p_user: bayo, p_kind: "order_completed", p_ref: ref, p_reason: "Daily limit of 3 reached" }),
          runIsolated(db, (ctx) => repo(ctx, (r) => r.logSkip(bayo, "order_completed", ref, "Daily limit of 3 reached"))),
          { result: () => null },
        ),
      );
    }
    it("points_week_start", () => same(runOriginalAsService(db, "points_week_start"), runIsolated(db, (ctx) => repo(ctx, (r) => r.weekStart()))));

    const internal: [string, () => string | null, string | null, boolean][] = [
      ["a buyer, customer points", () => buyer, "BAYO77", false],
      ["a buyer, customer points skipped (sign-up path)", () => buyer, "BAYO77", true],
      ["no user", () => null, "BAYO77", false],
      ["an unknown user", () => uuid(), "BAYO77", false],
    ];
    for (const [label, who, code, skip] of internal) {
      it(`apply_referral_internal: ${label}`, () =>
        same(
          runOriginalAsService(db, "apply_referral_internal", { p_uid: who(), p_code: code, p_skip_customer: skip }),
          runIsolated(db, (ctx) => ctx.asService((tx) => points(ctx).applyReferral(tx, who(), code, skip))),
        ),
      );
    }
  });
});
