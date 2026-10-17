import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DataContext } from "../../src/database/context.js";
import { callFunction } from "../../src/database/rpc.js";
import { ScheduledJobsService } from "../../src/modules/scheduled-jobs/scheduled-jobs.service.js";
import { seedOrder, seedProduct, seedUser, seedVendor, setRole } from "../support/fixtures.js";
import { comparable, runIsolated, runOriginalAsService, type RunOutcome } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/**
 * The pg_cron jobs. One seeded world holds orders and requests on both sides of every job's
 * thresholds; each job runs as the original and as the port on the same rows, once and twice.
 */
// parity-tested: auto_cancel_unconfirmed_orders, auto_complete_eligible_orders, escalate_unresolved_payment_orders, process_service_offer_deadlines, remind_unattended_orders, send_background_reminders
describe("parity: scheduled jobs", () => {
  let db: TestDatabase;
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const H = 60;

  beforeAll(async () => {
    process.env.EMAIL_WEBHOOK_SECRET = "<WEBHOOK_SECRET>";
    db = await createTestDatabase();
    for (const name of ["Ada Admin", "Bayo Admin"]) {
      const id = (await seedUser(db, { name })).id;
      await setRole(db, id, "admin");
    }
    const buyer = (await seedUser(db, { name: "Bola" })).id;
    const quietBuyer = (await seedUser(db, { name: "Chi" })).id;
    const owner = (await seedUser(db, { role: "vendor" })).id;
    const shop = (await seedVendor(db, owner, { name: "Ada's Shop" })).id;
    const product = await seedProduct(db, shop, { name: "Kettle" });
    for (const user of [buyer, owner]) {
      await db.query(`insert into public.push_subscriptions (user_id, endpoint, p256dh, auth_key) values ($1, $2, 'k', 'a')`, [user, `https://push.test/${user}`]);
    }

    const order = (status: string, createdMinutesAgo: number, who = buyer, delivery: "pickup" | "delivery" = "pickup") =>
      seedOrder(db, who, shop, { status, productIds: [product], createdAt: ago(createdMinutesAgo), delivery });
    const pay = (orderId: string, type: string, status: string, reference: string | null = null) =>
      db.query(`insert into public.payments (order_id, payment_type, amount, method, status, provider_reference) values ($1, $2, 2500, 'transfer', $3, $4)`, [
        orderId,
        type,
        status,
        reference,
      ]);
    const set = (orderId: string, assignments: string, values: unknown[] = []) => db.query(`update public.orders set ${assignments} where id = $1`, [orderId, ...values]);

    // auto-cancel (30 min) and unattended reminders (3 min .. 24 h; every 170 s in the first hour, then 30 min)
    await order("pending", 31); // cancelled; reminded
    await order("pending", 10, quietBuyer); // reminded only
    await order("pending", 2); // too new for either
    const remindedRecently = await order("pending", 20);
    await set(remindedRecently, "last_reminder_sent_at = $2", [ago(1)]);
    const remindedHalfHourAgo = await order("pending", 2 * H);
    await set(remindedHalfHourAgo, "last_reminder_sent_at = $2", [ago(31)]);
    const remindedTenMinutesAgo = await order("pending", 2 * H);
    await set(remindedTenMinutesAgo, "last_reminder_sent_at = $2", [ago(10)]);
    await order("pending", 25 * H); // older than a day: cancelled, no longer reminded

    // auto-complete (24 h after the final payment)
    const awaiting = async (delivery: "pickup" | "delivery", payments: [string, string][], extra = "") => {
      const id = await order("confirmed", 30 * H, buyer, delivery);
      for (const [type, status] of payments) await pay(id, type, status);
      await set(id, `awaiting_confirmation_since = $2${extra}`, [ago(25 * H)]);
      return id;
    };
    await awaiting("pickup", [["sale_price", "paid"]]); // completed
    await awaiting("delivery", [["sale_price", "paid"]], ", payment_timing = 'pay_after'"); // deposit missing
    await awaiting("delivery", [["delivery_deposit_20", "paid"], ["sale_price", "paid"]], ", payment_timing = 'pay_after'"); // completed
    const disputed = await awaiting("pickup", [["sale_price", "paid"]]);
    await db.query(`insert into public.disputes (order_id, raised_by, reason) values ($1, 'buyer', 'late')`, [disputed]);
    const recent = await order("confirmed", 30 * H);
    await pay(recent, "sale_price", "paid");
    await set(recent, "awaiting_confirmation_since = $2", [ago(2 * H)]); // not yet

    // escalation: a reported payment left unanswered 24 h, and confirmed orders unpaid 24 h
    const unresolved = async (minutesAgo: number, reference: string) => {
      const id = await order("payment_unresolved", 30 * H);
      await pay(id, "sale_price", "pending", reference);
      await set(id, "status = 'payment_unresolved', payment_unresolved_at = $2", [ago(minutesAgo)]);
      return id;
    };
    await unresolved(25 * H, "buyer_report"); // escalated
    await unresolved(25 * H, "paystack"); // not a reported payment
    await unresolved(2 * H, "buyer_report"); // not yet
    const unpaid = await order("confirmed", 30 * H, quietBuyer);
    await set(unpaid, "status_changed_at = $2", [ago(25 * H)]); // escalated, both sides nudged
    const unpaidRecent = await order("confirmed", 30 * H);
    await set(unpaidRecent, "status_changed_at = $2", [ago(H)]); // not yet

    // service requests past their deadline
    const offer = (status: string, expiresMinutesAgo: number) =>
      db.query(
        `insert into public.service_offers (listing_id, buyer_id, vendor_id, description, current_price, current_offer_by, status, expires_at)
         values ($1, $2, $3, 'A gown', 5000, 'buyer', $4, $5)`,
        [product, buyer, shop, status, ago(expiresMinutesAgo)],
      );
    await offer("pending", 60); // expired
    await offer("awaiting_payment", 5); // expired
    await offer("countered", -60); // still open
    await offer("accepted", 60); // not open

    // background reminders: an unread message to the shop, open orders for the buyer
    const [conversation] = await db.query<{ id: string }>(`insert into public.conversations (buyer_id, vendor_id) values ($1, $2) returning id`, [buyer, shop]);
    await db.query(`insert into public.messages (conversation_id, sender_id, body) values ($1, $2, 'hi'), ($1, $2, 'still there?')`, [conversation!.id, buyer]);
  }, 120_000);
  afterAll(() => db.close());

  const port = (ctx: DataContext) => new ScheduledJobsService(() => ctx);
  /** Compares both sides; returns the original's raw outcome. */
  async function same(original: Promise<RunOutcome>, ported: Promise<RunOutcome>) {
    const [o, p] = [await original, await ported];
    const { original: a, port: b } = comparable(o, p);
    expect(b).toEqual(a);
    return o;
  }
  const twice = (work: (ctx: DataContext) => Promise<unknown>) => runIsolated(db, async (ctx) => (await work(ctx), work(ctx)));

  const jobs: [string, (s: ScheduledJobsService) => Promise<unknown>, (r: RunOutcome) => void][] = [
    ["auto_cancel_unconfirmed_orders", (s) => s.autoCancelUnconfirmedOrders(), (r) => expect(r.result).toBe(4)],
    ["auto_complete_eligible_orders", (s) => s.autoCompleteEligibleOrders(), (r) => expect(r.result).toBe(2)],
    ["escalate_unresolved_payment_orders", (s) => s.escalateUnresolvedPaymentOrders(), (r) => expect(r.result).toBe(2)],
    ["process_service_offer_deadlines", (s) => s.processServiceOfferDeadlines(), (r) => expect(r.result).toBe(2)],
    ["remind_unattended_orders", (s) => s.remindUnattendedOrders(), (r) => expect(r.result).toBe(3)],
    ["send_background_reminders", (s) => s.sendBackgroundReminders().then(() => null), (r) => expect(r.changes["net.http_requests"]!.inserted).toHaveLength(1)],
  ];
  for (const [name, run, meaningful] of jobs) {
    describe(name, () => {
      it("once", async () => {
        const original = await same(runOriginalAsService(db, name), runIsolated(db, (ctx) => run(port(ctx))));
        meaningful(original);
      });
      it("twice in a row (the second run repeats nothing it should not)", () =>
        same(
          twice((ctx) => ctx.asService((tx) => callFunction(tx, name))),
          twice((ctx) => run(port(ctx))),
        ));
    });
  }

  it("send_background_reminders posts one reminder per subscribed person, with the counts in words (no push subscription, no reminder)", async () => {
    const outcome = await runIsolated(db, (ctx) => port(ctx).sendBackgroundReminders());
    const [request] = outcome.changes["net.http_requests"]!.inserted as { url: string; body: { reminders: { title: string; body: string; view: string }[] } }[];
    expect(request!.url).toBe("https://levromart.vercel.app/api/notify");
    // the shop's owner has the buyer's two unread messages; the buyer only open orders
    expect(request!.body.reminders.map((r) => [r.title, r.view, r.body]).sort()).toEqual([
      ["Orders need your attention", "buyerOrders", expect.stringMatching(/^\d+ orders not yet completed$/)],
      ["You have unread messages", "messages", expect.stringMatching(/^2 unread messages · \d+ orders not yet completed$/)],
    ]);
  });

  it("run(name) runs each pg_cron job by its name", async () => {
    const outcome = await runIsolated(db, (ctx) => port(ctx).run("auto-cancel-unconfirmed-orders"));
    expect(outcome.result).toBe(4);
    for (const name of ["levromart-points-reconcile", "levromart-finalize-points-week"] as const) {
      expect((await runIsolated(db, (ctx) => port(ctx).run(name))).error).toBeUndefined();
    }
    expect((await runIsolated(db, (ctx) => port(ctx).run("commission-deadline-reminders"))).result).toMatchObject({ notifications_created: 0 });
  });
});
