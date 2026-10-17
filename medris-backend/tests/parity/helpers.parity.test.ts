import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DataContext } from "../../src/database/context.js";
import { AccessRepository } from "../../src/database/repositories/access.repository.js";
import { CatalogueRepository } from "../../src/database/repositories/catalogue.repository.js";
import { ConversationsRepository } from "../../src/database/repositories/conversations.repository.js";
import { NotificationWriter } from "../../src/database/repositories/notification-writer.repository.js";
import { PointsRepository } from "../../src/database/repositories/points.repository.js";
import { ReferralsRepository } from "../../src/database/repositories/referrals.repository.js";
import { CampusRepository } from "../../src/database/repositories/shops.repository.js";
import { identityOf, seedOrder, seedProduct, seedReview, seedSector, seedUser, seedVendor, setRole, uuid } from "../support/fixtures.js";
import { comparable, runIsolated, runOriginal, runOriginalAsService, type RunOutcome } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/**
 * The helpers other database functions call (access checks, points for orders, reviews and listings,
 * notifications). Each case runs the original and the port on the same rows.
 */
// parity-tested: notify_rank_upsert, points_for_new_listing, points_revoke_listing
describe("parity: helper functions", () => {
  let db: TestDatabase;
  let admin: string;
  let buyer: string;
  let otherBuyer: string;
  let owner: string; // verified shop, referred by referrer's shop
  let referrer: string;
  let pendingOwner: string; // shop not yet verified
  let shop: string;
  let pendingShop: string;
  let product: string;
  const orders: Record<string, string> = {};
  const reviews: Record<string, string> = {};
  let sector: string;
  let sectorWithOther: string;
  let sectorComplete: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    admin = (await seedUser(db, { name: "Ada Admin" })).id;
    await setRole(db, admin, "admin");
    await setRole(db, (await seedUser(db, { name: "Bayo Admin" })).id, "admin");
    buyer = (await seedUser(db, { name: "Bola" })).id;
    otherBuyer = (await seedUser(db, { name: "Chi" })).id;
    owner = (await seedUser(db, { role: "vendor", name: "Dayo" })).id;
    referrer = (await seedUser(db, { role: "vendor", name: "Efe" })).id;
    pendingOwner = (await seedUser(db, { role: "vendor" })).id;
    shop = (await seedVendor(db, owner, { name: "Dayo Gadgets", referralCode: "DAYOG100" })).id;
    const referrerShop = (await seedVendor(db, referrer, { name: "Efe Styles", referralCode: "EFEST100" })).id;
    pendingShop = (await seedVendor(db, pendingOwner, { name: "Pending Place", verified: false })).id;
    product = await seedProduct(db, shop, { name: "Kettle" });
    await db.query(`insert into public.referrals (referred_user_id, referrer_user_id, referrer_vendor_id, code) values ($1, $2, $3, 'EFEST100')`, [owner, referrer, referrerShop]);
    await db.query(`insert into public.blocked_users (blocker_id, blocked_id) values ($1, $2)`, [otherBuyer, owner]);

    await db.query(`
      insert into public.points_rules (kind, label, description, points, min_amount, per_source_weekly_cap) values
        ('order_completed', 'Order completed', 'A sale', 20, 1000, 2),
        ('product_listed', 'New listing', 'A listing', 5, null, null),
        ('ref_vendor_product', 'Referred shop listed', 'Your referral listed', 2, null, null),
        ('review_5', '5-star review', 'Five stars', 10, null, null),
        ('review_4', '4-star review', 'Four stars', 6, null, null),
        ('review_3', '3-star review', 'Three stars', 2, null, null)`);

    const order = async (key: string, who: string, total: number, status = "completed", vendor = shop) => {
      orders[key] = await seedOrder(db, who, vendor, { status, productIds: [product], total });
    };
    await order("completed", buyer, 5000);
    await order("small", buyer, 500);
    await order("pending", buyer, 5000, "pending");
    // An order from the shop's own owner (the app refuses one; it can still exist from before that rule).
    await db.query(`set session_replication_role = replica`);
    await order("own", owner, 5000);
    await db.query(`set session_replication_role = origin`);
    await order("capA", otherBuyer, 5000);
    await order("capB", otherBuyer, 5000);
    await order("capC", otherBuyer, 5000);
    await order("chatOpen", otherBuyer, 5000, "confirmed");
    for (const [key, orderKey, who, rating] of [
      ["five", "completed", buyer, 5],
      ["four", "capA", otherBuyer, 4],
      ["three", "capB", otherBuyer, 3],
      ["two", "capC", otherBuyer, 2],
      ["small", "small", buyer, 5],
      ["own", "own", owner, 5],
    ] as const) {
      reviews[key] = await seedReview(db, orders[orderKey]!, who, shop, rating);
    }
    // The triggers already gave points while seeding; start the points from scratch.
    for (const table of ["points_ledger", "points_weekly", "points_skips", "notifications"]) await db.query(`delete from public.${table}`);
    // Two of the other buyer's orders already counted this week (the cap is 2 per customer).
    for (const key of ["capA", "capB"]) {
      await db.query(
        `insert into public.points_ledger (user_id, kind, points, event_key, source_user_id, week_start)
         values ($1, 'order_completed', 20, $2, $3, date_trunc('week', now() at time zone 'Africa/Lagos')::date)`,
        [owner, `order:${orders[key]}`, otherBuyer],
      );
    }
    await db.query(`update public.orders set completed_at = now() - interval '2 days' where id = $1`, [orders.own]);

    sector = await seedSector(db, { name: "Gadgets" });
    sectorWithOther = await seedSector(db, { name: "Fashion" });
    await db.query(`insert into public.categories (name, sector_id) values ('other', $1)`, [sectorWithOther]);
    sectorComplete = await seedSector(db, { name: "Food" });
    const [parent] = await db.query<{ id: string }>(`insert into public.categories (name, sector_id) values ('Other', $1) returning id`, [sectorComplete]);
    await db.query(`insert into public.categories (name, sector_id, parent_category_id) values ('FOOD', $1, $2)`, [sectorComplete, parent!.id]);
  }, 120_000);
  afterAll(() => db.close());

  async function same(original: Promise<RunOutcome>, ported: Promise<RunOutcome>, volatile: string[] = []) {
    const [o, p] = [await original, await ported];
    const { original: a, port: b } = comparable(o, p, { volatile });
    expect(b).toEqual(a);
    return o;
  }
  const svc = <T>(work: (tx: Parameters<Parameters<DataContext["asService"]>[0]>[0]) => Promise<T>) => (ctx: DataContext) => ctx.asService(work);

  describe("access checks", () => {
    const who = () => [admin, buyer, owner, null] as (string | null)[];
    it("is_admin", async () => {
      for (const me of who()) {
        await same(runOriginal(db, me ? identityOf(me) : null, "is_admin"), runIsolated(db, svc((tx) => new AccessRepository(tx).isAdmin(me))));
      }
    });
    it("owns_vendor", async () => {
      for (const me of who()) {
        for (const vendorId of [shop, pendingShop, uuid()]) {
          await same(
            runOriginal(db, me ? identityOf(me) : null, "owns_vendor", { v_id: vendorId }),
            runIsolated(db, svc((tx) => new AccessRepository(tx).ownsVendor(me, vendorId))),
          );
        }
      }
    });
    it("is_vendor_owner (used by row-level security)", async () => {
      for (const me of who()) {
        for (const vendorId of [shop, pendingShop]) {
          await same(
            runOriginal(db, me ? identityOf(me) : null, "is_vendor_owner", { p_vendor_id: vendorId }),
            runIsolated(db, svc((tx) => new AccessRepository(tx).ownsVendor(me, vendorId))),
          );
        }
      }
    });
    it("is_conversation_participant (used by row-level security)", async () => {
      const [c] = await db.query<{ id: string }>(`insert into public.conversations (buyer_id, vendor_id) values ($1, $2) returning id`, [otherBuyer, shop]);
      try {
        for (const me of [...who(), otherBuyer]) {
          for (const id of [c!.id, uuid()]) {
            const o = await same(
              runOriginal(db, me ? identityOf(me) : null, "is_conversation_participant", { p_conversation_id: id }),
              runIsolated(db, svc((tx) => new AccessRepository(tx).isConversationParticipant(me, id))),
            );
            if (id === c!.id) expect(o.result).toBe(me === owner || me === otherBuyer);
          }
        }
      } finally {
        await db.query(`delete from public.conversations where id = $1`, [c!.id]);
      }
    });
    it("is_vendor_follower (used by row-level security)", async () => {
      await db.query(`insert into public.vendor_follows (vendor_id, follower_id) values ($1, $2)`, [shop, buyer]);
      try {
        for (const me of who()) {
          const o = await same(
            runOriginal(db, me ? identityOf(me) : null, "is_vendor_follower", { p_vendor_id: shop }),
            runIsolated(db, svc((tx) => new AccessRepository(tx).followsVendor(me, shop))),
          );
          expect(o.result).toBe(me === buyer);
        }
      } finally {
        await db.query(`delete from public.vendor_follows where vendor_id = $1 and follower_id = $2`, [shop, buyer]);
      }
    });
    it("resolve_account_role", async () => {
      for (const id of [admin, buyer, owner, pendingOwner, uuid(), null]) {
        await same(runOriginalAsService(db, "resolve_account_role", { p_user_id: id }), runIsolated(db, svc((tx) => new AccessRepository(tx).resolvedRole(id))));
      }
    });
    it("is_blocked_between (either direction)", async () => {
      for (const [a, b] of [
        [otherBuyer, owner],
        [owner, otherBuyer],
        [buyer, owner],
        [null, owner],
      ] as (string | null)[][]) {
        await same(runOriginalAsService(db, "is_blocked_between", { a, b }), runIsolated(db, svc((tx) => new AccessRepository(tx).isBlockedBetween(a!, b!))));
      }
    });
    it("buyer_can_message_vendor (accepted order, or completed in the last 24 hours)", async () => {
      for (const [b, v, expected] of [
        [otherBuyer, shop, true],
        [buyer, shop, true],
        [owner, shop, false],
        [buyer, pendingShop, false],
      ] as [string, string, boolean][]) {
        const o = await same(
          runOriginalAsService(db, "buyer_can_message_vendor", { p_buyer: b, p_vendor: v }),
          runIsolated(db, svc((tx) => new ConversationsRepository(tx).buyerCanMessageVendor(b, v))),
        );
        expect(o.result).toBe(expected);
      }
    });
  });

  describe("text and catalogue", () => {
    it("lv_norm_school", async () => {
      for (const name of ["University of Lagos (UNILAG)", "  O.A.U. Ile-Ife ", "", null, "Ẹ̀kọ́ 1"]) {
        await same(runOriginalAsService(db, "lv_norm_school", { p: name }), runIsolated(db, svc((tx) => new CampusRepository(tx).normalise(name))));
      }
    });
    it("ensure_default_category: creates both, adds only the child, finds both, or nothing", async () => {
      for (const id of [sector, sectorWithOther, sectorComplete, uuid(), null]) {
        await same(
          runOriginalAsService(db, "ensure_default_category", { p_sector_id: id }),
          runIsolated(db, svc((tx) => new CatalogueRepository(tx).ensureDefaultCategory(id))),
          ["result"],
        );
      }
    });
    it("generate_referral_code: same shape as the original's", async () => {
      for (const name of ["Dayo Gadgets", "Ọ́ba & Co.", "A1", null, "x-y-z-w"]) {
        const original = await runOriginalAsService(db, "generate_referral_code", { p_name: name });
        const ported = await runIsolated(db, svc((tx) => new ReferralsRepository(tx).generateCode(name)));
        const base = (original.result as string).slice(0, -3);
        expect(ported.result).toMatch(new RegExp(`^${base}[0-9]{3}$`));
        expect(Object.values(ported.changes).every((c) => c.inserted.length + c.updated.length + c.deleted.length === 0)).toBe(true);
      }
    });
    it("generate_referral_code: skips taken codes, and after 20 tries uses random letters", async () => {
      const taken = await runIsolated(db, svc((tx) => new ReferralsRepository(tx).generateCode("Dayo Gadgets", { digits: (() => { let n = 99; return () => (n += 1); })() })));
      expect(taken.result).toBe("DAYOG101"); // DAYOG100 belongs to Dayo's shop
      const exhausted = await runIsolated(db, svc((tx) => new ReferralsRepository(tx).generateCode("Dayo Gadgets", { digits: () => 100, hex: () => "A1B2C" })));
      expect(exhausted.result).toBe("DAYOGA1B2C");
    });
  });

  describe("notifications", () => {
    it("notify_admins", () =>
      same(
        runOriginalAsService(db, "notify_admins", { p_title: "Heads up", p_body: "Body", p_target_view: "adminDisputes", p_target_params: null, p_actor_id: buyer }),
        runIsolated(db, svc((tx) => new NotificationWriter(tx).notifyAdmins("Heads up", "Body", "adminDisputes", null, buyer))),
      ));
    const mention = (content: string | null, kind = "product", author: string | null = buyer, skip: string[] | null = null) => ({
      kind,
      itemId: product,
      commentId: uuid(),
      authorId: author,
      authorName: "Bola",
      authorAvatar: null,
      content,
      itemName: "Kettle",
      skip,
    });
    for (const [label, m] of [
      ["a product comment mentioning a shop (any case)", () => mention("Ask @dayo gadgets about it, and @Efe Styles too")],
      ["a package comment", () => mention("@Dayo Gadgets do you deliver?", "package")],
      ["the author mentioning their own shop", () => mention("@Dayo Gadgets here", "product", owner)],
      ["a shop that is not verified", () => mention("@Pending Place")],
      ["someone to skip", () => mention("@Dayo Gadgets @Efe Styles", "product", buyer, [referrer])],
      ["no @ at all", () => mention("Dayo Gadgets")],
      ["no text", () => mention(null)],
    ] as const) {
      it(`notify_comment_mentions: ${label}`, () => {
        const n = m();
        return same(
          runOriginalAsService(db, "notify_comment_mentions", {
            p_kind: n.kind,
            p_item_id: n.itemId,
            p_comment_id: n.commentId,
            p_author: n.authorId,
            p_author_name: n.authorName,
            p_author_avatar: n.authorAvatar,
            p_content: n.content,
            p_item_name: n.itemName,
            p_skip: n.skip,
          }),
          runIsolated(db, svc((tx) => new NotificationWriter(tx).commentMentions(n))),
        );
      });
    }
    it("notify_rank_upsert: a new one, then the same one updated", async () => {
      const call = async (ctx: DataContext, original: boolean, title: string) =>
        original
          ? ctx.asService((tx) => import("../../src/database/rpc.js").then(({ callFunction }) => callFunction(tx, "notify_rank_upsert", { p_user: owner, p_title: title, p_body: "b", p_meta: { rank: 2 } })))
          : ctx.asService((tx) => new PointsRepository(tx).rankChanged(owner, title, "b", { rank: 2 }));
      await same(
        runIsolated(db, async (ctx) => (await call(ctx, true, "You moved up"), call(ctx, true, "You moved up again"))),
        runIsolated(db, async (ctx) => (await call(ctx, false, "You moved up"), call(ctx, false, "You moved up again"))),
      );
    });
  });

  describe("points", () => {
    for (const key of ["completed", "small", "pending", "own", "capC", "capA"]) {
      for (const notify of [true, false]) {
        it(`points_award_order: ${key}${notify ? "" : " (no notification)"}`, async () => {
          const o = await same(
            runOriginalAsService(db, "points_award_order", { p_order: orders[key], p_notify: notify }),
            runIsolated(db, (ctx) => ctx.asService((tx) => new PointsRepository(tx).awardOrder(orders[key]!, notify))),
          );
          expect(o.result).toBe({ completed: "awarded", small: "under minimum", pending: "not completed", own: "own order", capC: "customer cap", capA: "already counted" }[key]);
        });
      }
    }
    it("points_award_order: an unknown order", () =>
      same(runOriginalAsService(db, "points_award_order", { p_order: uuid() }), runIsolated(db, (ctx) => ctx.asService((tx) => new PointsRepository(tx).awardOrder(uuid())))));
    for (const key of ["five", "four", "three", "two", "small", "own"]) {
      it(`points_award_review: ${key}`, async () => {
        const o = await same(
          runOriginalAsService(db, "points_award_review", { p_review: reviews[key] }),
          runIsolated(db, (ctx) => ctx.asService((tx) => new PointsRepository(tx).awardReview(reviews[key]!))),
        );
        expect(o.result).toBe({ five: "awarded", four: "awarded", three: "awarded", two: "low rating", small: "under minimum", own: "own review" }[key]);
      });
    }
    it("points_award_review: an unknown review", () =>
      same(runOriginalAsService(db, "points_award_review", { p_review: uuid() }), runIsolated(db, (ctx) => ctx.asService((tx) => new PointsRepository(tx).awardReview(uuid())))));
    it("points_for_new_listing, then points_revoke_listing (the owner and their referrer)", async () => {
      const listing = uuid();
      const orig = (name: string) => (ctx: DataContext) =>
        ctx.asService((tx) => import("../../src/database/rpc.js").then(({ callFunction }) => callFunction(tx, name, { p_vendor: shop, p_listing: listing })));
      const added = await same(runIsolated(db, orig("points_for_new_listing")), runIsolated(db, (ctx) => ctx.asService((tx) => new PointsRepository(tx).forNewListing(shop, listing))));
      expect(added.changes.points_ledger!.inserted).toHaveLength(2);
      await same(
        runIsolated(db, async (ctx) => (await orig("points_for_new_listing")(ctx), orig("points_revoke_listing")(ctx))),
        runIsolated(db, async (ctx) => {
          await ctx.asService((tx) => new PointsRepository(tx).forNewListing(shop, listing));
          return ctx.asService((tx) => new PointsRepository(tx).revokeListing(shop, listing));
        }),
      );
      for (const vendorId of [pendingShop, uuid()]) {
        await same(
          runOriginalAsService(db, "points_for_new_listing", { p_vendor: vendorId, p_listing: listing }),
          runIsolated(db, (ctx) => ctx.asService((tx) => new PointsRepository(tx).forNewListing(vendorId, listing))),
        );
      }
    });
  });
});
