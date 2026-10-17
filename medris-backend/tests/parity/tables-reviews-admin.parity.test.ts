import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DataContext } from "../../src/database/context.js";
import { AdminDashboardService } from "../../src/modules/admin-dashboard/admin-dashboard.service.js";
import { EngagementService } from "../../src/modules/engagement/engagement.service.js";
import { identityOf, seedOrder, seedProduct, seedUser, seedVendor, setRole } from "../support/fixtures.js";
import { comparable, runIsolated, runTableQuery, type CompareOptions, type RunOutcome } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/**
 * The app's direct table queries on reviews, product_rating_stats, vendor_profile_view_events and the
 * admin screens' tables (auth_activity_logs, support_requests, suggestions, disputes, orders counts,
 * admin_actions), against the endpoints that replace them.
 */
describe("parity: table queries - reviews, ratings, shop views and the admin dashboard", () => {
  let db: TestDatabase;
  let admin: string;
  let buyer: string;
  let owner: string;
  let shop: string;
  let rivalShop: string;
  let product: string;
  let paidOrder: string;
  let unpaidOrder: string;
  let reviewedOrder: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    admin = (await seedUser(db, { name: "Ada Admin" })).id;
    await setRole(db, admin, "admin");
    buyer = (await seedUser(db, { name: "Bola" })).id;
    owner = (await seedUser(db, { role: "vendor" })).id;
    shop = (await seedVendor(db, owner, { name: "Dayo Gadgets" })).id;
    rivalShop = (await seedVendor(db, (await seedUser(db, { role: "vendor" })).id, { name: "Rival" })).id;
    product = await seedProduct(db, shop);
    const completed = async () => {
      const id = await seedOrder(db, buyer, shop, { status: "confirmed", productIds: [product] });
      await db.query(`insert into public.payments (order_id, payment_type, amount, method, status) values ($1, 'sale_price', 2500, 'transfer', 'paid')`, [id]);
      await db.query(`update public.orders set status = 'completed' where id = $1`, [id]);
      return id;
    };
    paidOrder = await completed();
    reviewedOrder = await completed();
    unpaidOrder = await seedOrder(db, buyer, shop, { status: "pending", productIds: [product] });
    await db.query(`insert into public.reviews (order_id, buyer_id, vendor_id, rating, comment) values ($1, $2, $3, 4, 'Good')`, [reviewedOrder, buyer, shop]);
    await db.query(`insert into public.vendor_profile_view_events (vendor_id, viewed_at) values ($1, now()), ($1, now() - interval '2 days')`, [shop]);
    await db.query(`insert into public.auth_activity_logs (user_id, event_type, occurred_at) values ($1, 'login', now()), ($1, 'login', now() - interval '3 days'), ($1, 'logout', now())`, [buyer]);
    await db.query(`insert into public.support_requests (user_id, subject, message, status) values ($1, 'Help', 'Help', 'open'), ($1, 'Done', 'Done', 'resolved')`, [buyer]);
    await db.query(`insert into public.suggestions (sender_id, target_type, message) values ($1, 'platform', 'More shops')`, [buyer]);
    await db.query(`insert into public.admin_actions (admin_id, admin_name, action, target_type) values ($1, 'Ada Admin', 'approve_vendor', 'vendor')`, [admin]);
  }, 60_000);
  afterAll(() => db.close());

  const me = (id: string) => identityOf(id);
  const eng = (ctx: DataContext) => new EngagementService(() => ctx);
  const dash = (ctx: DataContext) => new AdminDashboardService(() => ctx);
  async function same(original: Promise<RunOutcome>, port: Promise<RunOutcome>, options?: CompareOptions) {
    const [o, p] = [await original, await port];
    const { original: a, port: b } = comparable(o, p, options);
    expect(b).toEqual(a);
    return o;
  }
  async function bothRefused(original: Promise<RunOutcome>, port: Promise<RunOutcome>) {
    const [o, p] = [await original, await port];
    expect(o.error).toBeDefined();
    expect(p.error).toBeDefined();
    expect(comparable(o, p).port.changes).toEqual(comparable(o, p).original.changes);
  }

  describe("reviews", () => {
    it("a shop's latest reviews (signed in or out)", async () => {
      for (const who of [buyer, null]) {
        await same(
          runTableQuery(db, who ? me(who) : null, sql`select id, rating, comment, buyer_name, buyer_avatar_url, created_at from public.reviews where vendor_id = ${shop} order by created_at desc limit 10`),
          runIsolated(db, (ctx) => eng(ctx).shopReviews(who ? me(who) : null, shop, 10)),
        );
      }
    });
    it("review a completed, paid order (rating, points and the shop's notification by the triggers)", async () => {
      const o = await same(
        runTableQuery(db, me(buyer), sql`insert into public.reviews (order_id, buyer_id, vendor_id, rating, comment) values (${paidOrder}, ${buyer}, ${shop}, 5, 'Great') returning id`),
        runIsolated(db, (ctx) => eng(ctx).reviewOrder(me(buyer), paidOrder, 5, "Great").then((r) => [r])),
      );
      expect(o.changes.reviews!.inserted).toMatchObject([{ buyer_name: "Bola", vendor_id: shop }]);
    });
    it("refused: an order not yet paid, one already reviewed, someone else's order", async () => {
      await bothRefused(
        runTableQuery(db, me(buyer), sql`insert into public.reviews (order_id, buyer_id, vendor_id, rating) values (${unpaidOrder}, ${buyer}, ${shop}, 5) returning id`),
        runIsolated(db, (ctx) => eng(ctx).reviewOrder(me(buyer), unpaidOrder, 5, null)),
      );
      await bothRefused(
        runTableQuery(db, me(buyer), sql`insert into public.reviews (order_id, buyer_id, vendor_id, rating) values (${reviewedOrder}, ${buyer}, ${shop}, 5) returning id`),
        runIsolated(db, (ctx) => eng(ctx).reviewOrder(me(buyer), reviewedOrder, 5, null)),
      );
      await bothRefused(
        runTableQuery(db, me(owner), sql`insert into public.reviews (order_id, buyer_id, vendor_id, rating) values (${paidOrder}, ${owner}, ${shop}, 5) returning id`),
        runIsolated(db, (ctx) => eng(ctx).reviewOrder(me(owner), paidOrder, 5, null)),
      );
    });
    it("FINDING S8: the table takes a review of any shop with one's own order; the endpoint reviews the order's shop", async () => {
      const forged = await runTableQuery(db, me(buyer), sql`insert into public.reviews (order_id, buyer_id, vendor_id, rating, comment) values (${paidOrder}, ${buyer}, ${rivalShop}, 1, 'Scam') returning vendor_id`);
      expect(forged.result).toEqual([{ vendor_id: rivalShop }]);
      const port = await runIsolated(db, (ctx) => eng(ctx).reviewOrder(me(buyer), paidOrder, 1, "Scam"));
      expect(port.changes.reviews!.inserted).toMatchObject([{ vendor_id: shop }]);
    });
    it("which orders were reviewed; products' ratings", async () => {
      const ids = [paidOrder, reviewedOrder, unpaidOrder];
      await same(
        runTableQuery(db, me(buyer), sql`select order_id from public.reviews where buyer_id = ${buyer} and order_id in (${paidOrder}, ${reviewedOrder}, ${unpaidOrder})`),
        runIsolated(db, (ctx) => eng(ctx).reviewedOrders(me(buyer), ids).then((r) => r.orderIds.map((order_id) => ({ order_id })))),
      );
      await same(
        runTableQuery(db, null, sql`select product_id, avg_rating, review_count from public.product_rating_stats where product_id in (${product})`),
        runIsolated(db, (ctx) => eng(ctx).productRatings(null, [product])),
      );
    });
  });

  it("shop page views since a time: the owner's own shop; 0 for others", async () => {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    for (const who of [owner, buyer]) {
      await same(
        runTableQuery(db, me(who), sql`select count(*)::int as count from public.vendor_profile_view_events where vendor_id = ${shop} and viewed_at >= ${since}::timestamptz`).then((o) => ({ ...o, result: (o.result as unknown[])[0] })),
        runIsolated(db, (ctx) => eng(ctx).profileViewsSince(me(who), shop, since)),
      );
    }
  });

  describe("admin dashboard", () => {
    const since = new Date(Date.now() - 3_600_000).toISOString();
    it("head counts (an admin sees them; anyone else gets 0)", async () => {
      for (const who of [admin, buyer]) {
        const o = await same(
          runTableQuery(
            db,
            me(who),
            sql`select
                  (select count(*)::int from public.auth_activity_logs where event_type = 'login' and occurred_at >= ${since}::timestamptz) as logins_today,
                  (select count(*)::int from public.auth_activity_logs where event_type = 'login') as login_events,
                  (select count(*)::int from public.support_requests where status in ('open', 'in_progress')) as open_support_requests,
                  (select count(*)::int from public.suggestions where status = 'new') as new_suggestions,
                  (select count(*)::int from public.disputes where status = 'open') as open_disputes,
                  (select count(*)::int from public.orders where status = 'payment_unresolved' and payment_escalated_at is not null) as escalated_unresolved_payments,
                  (select count(*)::int from public.orders where status = 'confirmed' and payment_escalated_at is not null) as escalated_unpaid_confirmed,
                  (select count(*)::int from public.vendors where verification_status = 'pending' and deleted_at is null) as pending_shop_applications`,
          ).then((x) => ({ ...x, result: (x.result as unknown[])[0] })),
          runIsolated(db, (ctx) => dash(ctx).counts(me(who), since)),
        );
        if (who === admin) expect(o.result).toMatchObject({ logins_today: 1, login_events: 2, new_suggestions: 1 });
      }
    });
    it("FIX B12: the app's open-disputes count fails ('closed' is not a dispute status), so the dashboard showed 0", async () => {
      const original = await runTableQuery(db, me(admin), sql`select count(*)::int as n from public.disputes where status not in ('resolved', 'closed')`);
      expect(original.error?.message).toMatch(/invalid input value for enum dispute_status: "closed"/);
      const port = await runIsolated(db, async (ctx) => {
        await ctx.asService((tx) => tx.execute(sql`insert into public.disputes (order_id, raised_by, reason) values (${paidOrder}, 'buyer', 'late')`));
        return dash(ctx).counts(me(admin), since);
      });
      expect(port.result).toMatchObject({ open_disputes: 1 });
    });
    it("the sign-in log and the admin action log", async () => {
      for (const who of [admin, buyer]) {
        await same(
          runTableQuery(db, me(who), sql`select id, user_id, event_type, occurred_at, user_agent, ip, source from public.auth_activity_logs where occurred_at >= ${since}::timestamptz order by occurred_at desc limit 2000`),
          runIsolated(db, (ctx) => dash(ctx).loginLog(me(who), since)),
        );
        await same(runTableQuery(db, me(who), sql`select * from public.admin_actions order by created_at desc limit 100`), runIsolated(db, (ctx) => dash(ctx).actionLog(me(who))));
      }
    });
    it("record an admin action (the other admins are notified); refused for others", async () => {
      await same(
        runTableQuery(db, me(admin), sql`insert into public.admin_actions (admin_id, admin_name, action, target_type, target_id, target_label) values (${admin}, 'Ada Admin', 'pause_storefront', 'vendor', ${shop}, 'Dayo Gadgets')`, false),
        runIsolated(db, (ctx) => dash(ctx).logAction(me(admin), { action: "pause_storefront", targetType: "vendor", targetId: shop, targetLabel: "Dayo Gadgets" }).then(() => null)),
      );
      await bothRefused(
        runTableQuery(db, me(buyer), sql`insert into public.admin_actions (admin_id, admin_name, action, target_type) values (${buyer}, 'Bola', 'x', 'vendor')`, false),
        runIsolated(db, (ctx) => dash(ctx).logAction(me(buyer), { action: "x", targetType: "vendor", targetId: null, targetLabel: null })),
      );
    });
  });
});
