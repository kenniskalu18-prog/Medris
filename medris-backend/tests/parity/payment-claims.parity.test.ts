import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DataContext, Identity } from "../../src/database/context.js";
import { PaymentClaimsService } from "../../src/modules/payment-claims/payment-claims.service.js";
import { asUserSeed, identityOf, seedOrder, seedProduct, seedUser, seedVendor, setRole, uuid } from "../support/fixtures.js";
import { comparable, runIsolated, runOriginal, type CompareOptions, type RunOutcome } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/** PaymentClaimsService replaces the direct-payment and dispute functions; each case runs the original and the port on the same rows. */
describe("parity: payment claims and disputes", () => {
  let db: TestDatabase;
  let admin: string;
  let buyer: string;
  let owner: string;
  let stranger: string;
  let shop: string;
  const o: Record<string, string> = {};
  let openDispute: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    admin = (await seedUser(db)).id;
    await setRole(db, admin, "admin");
    buyer = (await seedUser(db, { name: "Chidi Buyer" })).id;
    owner = (await seedUser(db, { role: "vendor" })).id;
    stranger = (await seedUser(db)).id;
    shop = (await seedVendor(db, owner, { name: "Lagos Electronics" })).id;
    const product = await seedProduct(db, shop);

    const order = async (name: string, set: string, opts: { delivery?: "pickup" | "delivery"; status?: string } = {}) => {
      o[name] = await seedOrder(db, buyer, shop, { status: "pending", productIds: [product], delivery: opts.delivery, total: 10000 });
      // Status first: the order triggers stamp status_changed_at, which some cases then set back.
      if (opts.status) await db.query(`update public.orders set status = $2 where id = $1`, [o[name], opts.status]);
      if (set) await db.query(`update public.orders set ${set} where id = $1`, [o[name]]);
    };
    const pay = (name: string, type: string, amount: number, status = "paid", ref: string | null = null) =>
      db.query(`insert into public.payments (order_id, payment_type, amount, method, status, provider_reference) values ($1, $2, $3, 'transfer', $4, $5)`, [o[name], type, amount, status, ref]);

    await order("pickup", "");
    await order("pickupPaid", "", { status: "confirmed" });
    await pay("pickupPaid", "sale_price", 10000);
    await order("rental", "order_type = 'rental', deposit_amount = 2000", { status: "confirmed" });
    await pay("rental", "rental_fee", 10000);
    await order("payAfter", "payment_timing = 'pay_after', payment_deposit_percent = 25, delivery_fee = 1000", { delivery: "delivery" });
    await order("payAfterDepositPaid", "payment_timing = 'pay_after', payment_deposit_percent = 25, delivery_fee = 1000", { delivery: "delivery", status: "confirmed" });
    await pay("payAfterDepositPaid", "delivery_deposit_20", 2250);
    await order("payBeforeDelivery", "payment_timing = 'pay_before'", { delivery: "delivery" });
    await pay("payBeforeDelivery", "sale_price", 9500, "pending");
    await order("completed", "", { status: "cancelled" });

    // Claims reported through the real function.
    for (const name of ["reported", "reportedAgain", "reportedDeposit", "reportedEscrow", "reportedRental"]) {
      if (name === "reportedDeposit") await order(name, "payment_timing = 'pay_after', payment_deposit_percent = 20, delivery_fee = 0", { delivery: "delivery" });
      else if (name === "reportedRental") await order(name, "order_type = 'rental'", {});
      else if (name === "reportedEscrow") await order(name, "payout_status = 'held'", {});
      else await order(name, "");
      const amount = name === "reportedDeposit" ? 2000 : 10000;
      await asUserSeed(db, buyer, [[`select public.buyer_report_manual_payment($1, $2)`, [o[name], amount]]]);
    }
    const [dispute] = await db.query<{ id: string }>(`insert into public.disputes (order_id, raised_by, reason, admin_notes) values ($1, 'buyer', 'Never arrived', 'First look') returning id`, [o.reportedAgain]);
    openDispute = dispute!.id;

    await order("followUp", "payment_escalated_at = now() - interval '1 hour', status_changed_at = now() - interval '2 days'", { status: "confirmed" });
    await order("followUpDelivery", "payment_timing = 'pay_after', delivery_fee = 500, payment_escalated_at = now(), status_changed_at = now() - interval '2 days'", {
      delivery: "delivery",
      status: "confirmed",
    });
    await order("followUpRecent", "payment_escalated_at = now()", { status: "confirmed" });
    await db.query(`update public.orders set status_changed_at = now() where id = $1`, [o.followUpRecent]);
    await order("followUpPaid", "payment_escalated_at = now(), status_changed_at = now() - interval '2 days'", { status: "confirmed" });
    await pay("followUpPaid", "sale_price", 10000);
  }, 60_000);
  afterAll(() => db.close());

  const port = (ctx: DataContext) => new PaymentClaimsService(() => ctx);
  const me = (id: string | null): Identity | null => (id ? identityOf(id) : null);
  async function same(original: Promise<RunOutcome>, ported: Promise<RunOutcome>, options?: CompareOptions) {
    const { original: a, port: b } = comparable(await original, await ported, options);
    expect(b).toEqual(a);
    return a;
  }
  const voidResult = { result: () => null };
  type Who = () => string | null;

  describe("buyer_report_manual_payment", () => {
    const cases: [string, Who, string, number | null][] = [
      ["pickup: the whole total", () => buyer, "pickup", 10000],
      ["pickup: the wrong amount", () => buyer, "pickup", 9000],
      ["a paid order owes nothing more", () => buyer, "pickupPaid", 10000],
      ["a rental: the refundable deposit next", () => buyer, "rental", 2000],
      ["pay after delivery: the deposit (25% of the items)", () => buyer, "payAfter", 2250],
      ["pay after delivery: then the rest", () => buyer, "payAfterDepositPaid", 7750],
      ["delivered, paid before: the pending amount", () => buyer, "payBeforeDelivery", 9500],
      ["reporting again updates the report", () => buyer, "reported", 10000],
      ["a cancelled order", () => buyer, "completed", 10000],
      ["not positive", () => buyer, "pickup", 0],
      ["not the buyer", () => owner, "pickup", 10000],
      ["signed out", () => null, "pickup", 10000],
    ];
    for (const [label, who, order, amount] of cases) {
      it(label, () =>
        same(runOriginal(db, me(who()), "buyer_report_manual_payment", { p_order_id: o[order], p_amount: amount }), runIsolated(db, (ctx) => port(ctx).report(me(who()), o[order]!, amount))),
      );
    }
  });

  describe("vendor confirms or disputes a reported payment", () => {
    for (const [label, order] of [
      ["a sale: the buyer then confirms receipt", "reported"],
      ["with an open dispute", "reportedAgain"],
      ["a delivery deposit confirms the order", "reportedDeposit"],
      ["held money: completes", "reportedEscrow"],
      ["a rental: completes", "reportedRental"],
      ["nothing reported", "pickup"],
    ] as const) {
      it(`confirm: ${label}`, () =>
        same(runOriginal(db, me(owner), "vendor_confirm_reported_payment", { p_order_id: o[order] }), runIsolated(db, (ctx) => port(ctx).vendorConfirm(me(owner), o[order]!))),
      );
      it(`dispute: ${label}`, () =>
        same(
          runOriginal(db, me(owner), "vendor_dispute_reported_payment", { p_order_id: o[order], p_reason: "No money arrived" }),
          runIsolated(db, (ctx) => port(ctx).vendorDispute(me(owner), o[order]!, "No money arrived")),
        ),
      );
    }
    for (const [label, who, reason] of [
      ["not the vendor", () => buyer, "x"],
      ["signed out", () => null, "x"],
      ["no reason", () => owner, "  "],
    ] as const) {
      it(`confirm: ${label}`, () =>
        same(runOriginal(db, me(who()), "vendor_confirm_reported_payment", { p_order_id: o.reported }), runIsolated(db, (ctx) => port(ctx).vendorConfirm(me(who()), o.reported!))),
      );
      it(`dispute: ${label}`, () =>
        same(
          runOriginal(db, me(who()), "vendor_dispute_reported_payment", { p_order_id: o.reported, p_reason: reason }),
          runIsolated(db, (ctx) => port(ctx).vendorDispute(me(who()), o.reported!, reason)),
        ),
      );
    }
  });

  describe("payment follow-up (nothing reported)", () => {
    for (const [label, order] of [
      ["a sale: recorded, the buyer then confirms", "followUp"],
      ["pay after delivery: the deposit", "followUpDelivery"],
      ["not escalated yet", "pickupPaid"],
      ["not confirmed", "pickup"],
    ] as const) {
      it(`confirm unreported: ${label}`, () =>
        same(
          runOriginal(db, me(owner), "vendor_confirm_unreported_payment", { p_order_id: o[order] }),
          runIsolated(db, (ctx) => port(ctx).vendorConfirmUnreported(me(owner), o[order]!)),
        ),
      );
      it(`dispute unreported: ${label}`, () =>
        same(
          runOriginal(db, me(owner), "vendor_dispute_unreported_payment", { p_order_id: o[order], p_reason: "Not paid" }),
          runIsolated(db, (ctx) => port(ctx).vendorDisputeUnreported(me(owner), o[order]!, "Not paid")),
        ),
      );
    }
    it("dispute unreported: a reason is required", () =>
      same(
        runOriginal(db, me(owner), "vendor_dispute_unreported_payment", { p_order_id: o.followUp, p_reason: "" }),
        runIsolated(db, (ctx) => port(ctx).vendorDisputeUnreported(me(owner), o.followUp!, "")),
      ));
    for (const [label, who, order] of [
      ["cancels after a day", () => admin, "followUp"],
      ["not before a day", () => admin, "followUpRecent"],
      ["not with a verified payment", () => admin, "followUpPaid"],
      ["not an overdue case", () => admin, "pickup"],
      ["not an admin", () => owner, "followUp"],
    ] as const) {
      it(`admin_cancel_confirmed_overdue_order: ${label}`, () =>
        same(
          runOriginal(db, me(who()), "admin_cancel_confirmed_overdue_order", { p_order_id: o[order] }),
          runIsolated(db, (ctx) => port(ctx).cancelOverdue(me(who()), o[order]!)),
        ),
      );
    }
  });

  describe("admin verifies or rejects a claim", () => {
    for (const [label, order, notes] of [
      ["a sale", "reported", null],
      ["with an open dispute and notes", "reportedAgain", "Bank statement checked"],
      ["a delivery deposit", "reportedDeposit", null],
      ["a rental", "reportedRental", null],
      ["nothing reported", "pickup", "x"],
    ] as const) {
      it(`confirm: ${label}`, () =>
        same(
          runOriginal(db, me(admin), "admin_confirm_reported_payment", { p_order_id: o[order], p_admin_notes: notes }),
          runIsolated(db, (ctx) => port(ctx).adminConfirm(me(admin), o[order]!, notes)),
        ),
      );
      it(`reject: ${label}`, () =>
        same(
          runOriginal(db, me(admin), "admin_reject_reported_payment", { p_order_id: o[order], p_admin_notes: notes ?? "Not received" }),
          runIsolated(db, (ctx) => port(ctx).adminReject(me(admin), o[order]!, notes ?? "Not received")),
        ),
      );
    }
    it("reject: notes are required", () =>
      same(
        runOriginal(db, me(admin), "admin_reject_reported_payment", { p_order_id: o.reported, p_admin_notes: " " }),
        runIsolated(db, (ctx) => port(ctx).adminReject(me(admin), o.reported!, " ")),
      ));
    for (const fn of ["admin_confirm_reported_payment", "admin_reject_reported_payment"] as const) {
      it(`${fn}: not an admin`, () =>
        same(
          runOriginal(db, me(owner), fn, { p_order_id: o.reported, p_admin_notes: "x" }),
          runIsolated(db, (ctx) => (fn === "admin_confirm_reported_payment" ? port(ctx).adminConfirm(me(owner), o.reported!, "x") : port(ctx).adminReject(me(owner), o.reported!, "x"))),
        ),
      );
    }
  });

  describe("record_offline_payment", () => {
    const cases: [string, Who, string, number | null, string][] = [
      ["the reported amount", () => owner, "sale_price", 10000, "transfer"],
      ["a different amount", () => owner, "sale_price", 9000, "transfer"],
      ["card is refused", () => owner, "sale_price", 10000, "card"],
      ["nothing reported of that type", () => owner, "deposit", 10000, "cash"],
      ["not positive", () => owner, "sale_price", -1, "transfer"],
      ["not the vendor", () => buyer, "sale_price", 10000, "transfer"],
      ["not a payment type", () => owner, "tip", 10000, "transfer"],
    ];
    for (const [label, who, type, amount, method] of cases) {
      it(label, () =>
        same(
          runOriginal(db, me(who()), "record_offline_payment", { p_order_id: o.reported, p_payment_type: type, p_amount: amount, p_method: method }),
          runIsolated(db, (ctx) => port(ctx).recordOffline(me(who()), o.reported!, type, amount, method).then((r) => r.id)),
        ),
      );
    }
  });

  describe("disputes", () => {
    const att = (path: (o: string) => string, extra: Record<string, unknown> = {}) => (orderId: string) => [{ path: path(orderId), ...extra }];
    const cases: [string, Who, string, string | null, ((orderId: string) => unknown) | undefined][] = [
      ["the buyer reports a problem", () => buyer, "pickupPaid", "Item broken", undefined],
      ["the vendor reports a problem", () => owner, "pickupPaid", "Buyer unreachable", undefined],
      ["with photos the buyer uploaded", () => buyer, "pickupPaid", "Broken", att((id) => `${buyer}/${id}/a.jpg`, { name: "x".repeat(100) })],
      ["no photos", () => buyer, "pickupPaid", "Broken", () => []],
      ["a photo from elsewhere", () => buyer, "pickupPaid", "Broken", att(() => "someone/else.jpg")],
      ["too many photos", () => buyer, "pickupPaid", "Broken", (id) => [1, 2, 3, 4].map((n) => ({ path: `${buyer}/${id}/${n}.jpg` }))],
      ["not a list", () => buyer, "pickupPaid", "Broken", () => ({ path: "x" })],
      ["a reason is required", () => buyer, "pickupPaid", "  ", undefined],
      ["someone else", () => stranger, "pickupPaid", "Broken", undefined],
    ];
    for (const [label, who, order, reason, attachments] of cases) {
      it(`raise_dispute: ${label}`, () => {
        const files = attachments?.(o[order]!);
        const args = { p_order_id: o[order], p_reason: reason, ...(attachments ? { p_attachments: files } : {}) };
        return same(
          runOriginal(db, me(who()), "raise_dispute", args),
          runIsolated(db, (ctx) => port(ctx).raise(me(who()), o[order]!, reason, attachments ? files : undefined).then((r) => r.id)),
        );
      });
    }
    it("FIX S4: raise_dispute (with attachments) signed out - the original disputed the order; the port refuses", async () => {
      const original = await runOriginal(db, null, "raise_dispute", { p_order_id: o.pickupPaid, p_reason: "Freeze it", p_attachments: [] });
      expect(original.changes.disputes!.inserted).toHaveLength(1);
      const ported = await runIsolated(db, (ctx) => port(ctx).raise(null, o.pickupPaid!, "Freeze it", []));
      expect(ported.error?.message).toBe("not authorized");
      expect(ported.changes.disputes!.inserted).toHaveLength(0);
    });
    for (const [label, who, status] of [
      ["resolve with a new order status", () => admin, "completed"],
      ["resolve only", () => admin, null],
      ["not a status", () => admin, "won"],
      ["not an admin", () => owner, null],
    ] as const) {
      it(`resolve_dispute: ${label}`, () =>
        same(
          runOriginal(db, me(who()), "resolve_dispute", { p_dispute_id: openDispute, p_admin_notes: "Settled", p_new_order_status: status }),
          runIsolated(db, (ctx) => port(ctx).resolve(me(who()), openDispute, "Settled", status)),
          voidResult,
        ),
      );
    }
    it("resolve_dispute: unknown", () =>
      same(
        runOriginal(db, me(admin), "resolve_dispute", { p_dispute_id: uuid(), p_admin_notes: "x" }),
        runIsolated(db, (ctx) => port(ctx).resolve(me(admin), uuid(), "x", null)),
        voidResult,
      ));
    for (const [label, who, dispute] of [
      ["the vendor responds", () => owner, () => openDispute],
      ["not the vendor", () => buyer, () => openDispute],
      ["signed out", () => null, () => openDispute],
      ["an unknown dispute", () => owner, () => uuid()],
    ] as const) {
      it(`vendor_respond_to_dispute: ${label}`, () =>
        same(
          runOriginal(db, me(who()), "vendor_respond_to_dispute", { p_dispute_id: dispute(), p_response: "We shipped it" }),
          runIsolated(db, (ctx) => port(ctx).respond(me(who()), dispute(), "We shipped it")),
          voidResult,
        ),
      );
    }
  });

  describe("create_payment_intent", () => {
    // The card reference is random on both sides.
    const opts: CompareOptions = { volatile: ["provider_reference", "reference"] };
    it("a rental: the fee and its refundable deposit", () =>
      same(runOriginal(db, me(buyer), "create_payment_intent", { p_order_id: o.rental }), runIsolated(db, (ctx) => port(ctx).paymentIntent(me(buyer), o.rental!)), opts));
    for (const [label, who, order] of [
      ["a cancelled order", () => buyer, "completed"],
      ["not the buyer", () => owner, "pickup"],
      ["unknown", () => buyer, ""],
    ] as const) {
      it(label, () =>
        same(
          runOriginal(db, me(who()), "create_payment_intent", { p_order_id: o[order] ?? uuid() }),
          runIsolated(db, (ctx) => port(ctx).paymentIntent(me(who()), o[order] ?? uuid())),
          opts,
        ),
      );
    }
    it("FIX B2: a pay-before sale is charged its total once (the original charged it twice)", async () => {
      const original = await runOriginal(db, me(buyer), "create_payment_intent", { p_order_id: o.pickup });
      const charged = (original.result as { amount: number }[])[0]!.amount;
      expect(charged).toBe(20000);
      const ported = await runIsolated(db, (ctx) => port(ctx).paymentIntent(me(buyer), o.pickup!));
      expect((ported.result as { amount: number }[])[0]!.amount).toBe(10000);
      expect(ported.changes.payments!.inserted).toHaveLength(1);
    });
  });
});
