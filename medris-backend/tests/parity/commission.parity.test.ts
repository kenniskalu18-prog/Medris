import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DataContext, Identity } from "../../src/database/context.js";
import { CommissionService } from "../../src/modules/commission/commission.service.js";
import { identityOf, seedOrder, seedPackage, seedProduct, seedUser, seedVendor, setRole, uuid } from "../support/fixtures.js";
import { comparable, runIsolated, runOriginal, runOriginalAsService, type CompareOptions, type RunOutcome } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/** CommissionService replaces the commission, deadline, reminder and monthly-listing functions; each case runs the original and the port on the same rows. */
describe("parity: commission and billing", () => {
  let db: TestDatabase;
  let admin: string;
  let buyer: string;
  let stranger: string;
  const owner: Record<string, string> = {};
  const shop: Record<string, string> = {};
  const listing: Record<string, string> = {};
  const submission: Record<string, string> = {};

  beforeAll(async () => {
    db = await createTestDatabase();
    admin = (await seedUser(db, { name: "Ada Admin" })).id;
    await setRole(db, admin, "admin");
    buyer = (await seedUser(db, { name: "Bimpe Buyer" })).id;
    stranger = (await seedUser(db)).id;
    for (const name of ["dueSoon", "overdue", "lastHours", "paidUp", "override", "small"]) {
      owner[name] = (await seedUser(db, { role: "vendor" })).id;
      shop[name] = (await seedVendor(db, owner[name]!, { name: `Shop ${name}` })).id;
    }
    // A completed, paid order with a commission charge due `due` from now (the automatic charge replaced).
    const charge = async (name: string, amount: number, due: string) => {
      const product = await seedProduct(db, shop[name]!, { name: `Item for ${name}` });
      const order = await seedOrder(db, buyer, shop[name]!, { productIds: [product], total: amount * 33 });
      await db.query(`insert into public.payments (order_id, payment_type, amount, method, status) values ($1, 'sale_price', $2, 'transfer', 'paid')`, [order, amount * 33]);
      await db.query(`update public.orders set status = 'completed' where id = $1`, [order]);
      await db.query(`delete from public.commission_charges where order_id = $1`, [order]);
      await db.query(`insert into public.commission_charges (vendor_id, order_id, amount, due_at) values ($1, $2, $3, now() + $4::interval)`, [shop[name], order, amount, due]);
    };
    await charge("dueSoon", 150.5, "2 days - 1 hour");
    await charge("dueSoon", 60, "5 days - 1 hour");
    await charge("overdue", 300, "-1 day");
    await charge("lastHours", 120, "4 hours");
    await charge("small", 40, "-2 days");
    await db.query(`update public.vendors set is_active = false, commission_paused = true, commission_pause_reason = 'commission_overdue' where id = $1`, [shop.paidUp]);
    await db.query(`update public.vendors set commission_pause_reason = 'admin_override' where id = $1`, [shop.override]);

    // Monthly listings.
    const monthly = async (name: string, until: string | null, kind: "product" | "package" = "product") => {
      listing[name] = kind === "product" ? await seedProduct(db, shop.dueSoon!, { name: `Monthly ${name}` }) : await seedPackage(db, shop.dueSoon!, { name: `Bundle ${name}` });
      const table = kind === "product" ? "products" : "vendor_packages";
      await db.query(`update public.${table} set billing_model = 'monthly', billing_paid_until = ${until ? `now() + '${until}'::interval` : "null"} where id = $1`, [listing[name]]);
    };
    await monthly("fiveDays", "5 days");
    await monthly("expired", "-2 days");
    await monthly("unpaid", null);
    await monthly("bundle", "1 day", "package");
    await monthly("fresh", null);
    await monthly("freshBundle", null, "package");
    await db.query(`update public.vendors set billing_model = 'monthly', next_monthly_charge_at = now() + interval '1 day' where id = $1`, [shop.overdue]);
    const submit = async (name: string, kind: "product" | "package", listingId: string, status = "pending") => {
      const [row] = await db.query<{ id: string }>(
        `insert into public.monthly_listing_submissions (kind, listing_id, vendor_id, user_id, payer_name, receipt_path, status) values ($1, $2, $3, $4, 'Ada', $5, $6) returning id`,
        [kind, listingId, shop.dueSoon, owner.dueSoon, `${owner.dueSoon}/r.jpg`, status],
      );
      submission[name] = row!.id;
    };
    await submit("product", "product", listing.unpaid!);
    await submit("package", "package", listing.bundle!);
    await submit("reviewed", "product", listing.fiveDays!, "approved");
  }, 60_000);
  afterAll(() => db.close());

  const port = (ctx: DataContext) => new CommissionService(() => ctx);
  const me = (id: string | null): Identity | null => (id ? identityOf(id) : null);
  async function same(original: Promise<RunOutcome>, ported: Promise<RunOutcome>, options?: CompareOptions) {
    const { original: a, port: b } = comparable(await original, await ported, options);
    expect(b).toEqual(a);
    return a;
  }
  type Who = () => string | null;
  const people: [string, Who][] = [
    ["the owner", () => owner.dueSoon!],
    ["an admin", () => admin],
    ["someone else", () => stranger],
  ];

  describe("reads", () => {
    for (const [label, who] of people) {
      it(`get_vendor_commission_owed, ${label}`, () =>
        same(
          runOriginal(db, me(who()), "get_vendor_commission_owed", { p_vendor_id: shop.dueSoon }),
          runIsolated(db, (ctx) => port(ctx).owed(me(who()), shop.dueSoon!).then((r) => r.owed)),
        ),
      );
      it(`get_vendor_commission_deadline, ${label}`, () =>
        same(runOriginal(db, me(who()), "get_vendor_commission_deadline", { p_vendor_id: shop.dueSoon }), runIsolated(db, (ctx) => port(ctx).deadline(me(who()), shop.dueSoon!))),
      );
      it(`get_vendor_commission_breakdown, ${label}`, () =>
        same(runOriginal(db, me(who()), "get_vendor_commission_breakdown", { p_vendor_id: shop.dueSoon }), runIsolated(db, (ctx) => port(ctx).breakdown(me(who()), shop.dueSoon!))),
      );
    }
    it("compute_monthly_billing_amount", () =>
      same(runOriginal(db, null, "compute_monthly_billing_amount", { p_vendor_id: shop.dueSoon }), runIsolated(db, (ctx) => port(ctx).monthlyBillingAmount(shop.dueSoon!))));
  });

  describe("create_commission_payment_intent", () => {
    const opts: CompareOptions = { volatile: ["provider_reference", "reference"] };
    for (const [label, who, vendor] of [
      ["everything owed", () => owner.dueSoon!, () => shop.dueSoon!],
      ["nothing owed", () => owner.paidUp!, () => shop.paidUp!],
      ["someone else's shop", () => stranger, () => shop.dueSoon!],
    ] as const) {
      it(label, () =>
        same(runOriginal(db, me(who()), "create_commission_payment_intent", { p_vendor_id: vendor() }), runIsolated(db, (ctx) => port(ctx).paymentIntent(me(who()), vendor())), opts),
      );
    }
  });

  describe("enforce_commission_deadlines", () => {
    const shops: [string, Who, () => string][] = [
      ["an overdue balance pauses the storefront (admins told)", () => owner.overdue!, () => shop.overdue!],
      ["a paid-up shop reopens", () => owner.paidUp!, () => shop.paidUp!],
      ["an admin override ends when nothing is owed", () => owner.override!, () => shop.override!],
      ["under ₦100 never pauses", () => owner.small!, () => shop.small!],
      ["an admin may run it for a shop", () => admin, () => shop.overdue!],
      ["someone else is refused", () => stranger, () => shop.overdue!],
    ];
    for (const [label, who, vendor] of shops) {
      it(label, () =>
        same(
          runOriginal(db, me(who()), "enforce_commission_deadlines", { p_vendor_id: vendor() }),
          runIsolated(db, (ctx) => port(ctx).enforceDeadlines(me(who()), vendor()).then((r) => r.changed)),
        ),
      );
    }
    it("every shop (the job)", () =>
      same(
        runOriginalAsService(db, "enforce_commission_deadlines", {}),
        runIsolated(db, (ctx) => port(ctx).enforceDeadlines(null, null).then((r) => r.changed)),
      ));
  });

  describe("reminders", () => {
    it("process_commission_deadline_reminders (twice: the second sends nothing)", async () => {
      await same(runOriginalAsService(db, "process_commission_deadline_reminders"), runIsolated(db, (ctx) => port(ctx).deadlineReminders()));
      const twice = (work: (ctx: DataContext) => Promise<unknown>) => runIsolated(db, async (ctx) => (await work(ctx), work(ctx)));
      const { callFunction } = await import("../../src/database/rpc.js");
      await same(
        twice((ctx) => ctx.asService((tx) => callFunction(tx, "process_commission_deadline_reminders"))),
        twice((ctx) => port(ctx).deadlineReminders()),
      );
    });
    // hours_left in the notification's metadata is measured at the moment each side ran.
    const hourOpts: CompareOptions = { volatile: ["metadata"] };
    for (const [label, who, vendor] of [
      ["the last day: the 5-hour reminder", () => owner.lastHours!, () => shop.lastHours!],
      ["not yet in the last day", () => owner.dueSoon!, () => shop.dueSoon!],
      ["someone else is refused", () => stranger, () => shop.lastHours!],
    ] as const) {
      it(`process_vendor_commission_hour_reminders: ${label}`, () =>
        same(
          runOriginal(db, me(who()), "process_vendor_commission_hour_reminders", { p_vendor_id: vendor() }),
          runIsolated(db, (ctx) => port(ctx).hourReminders(me(who()), vendor())),
          hourOpts,
        ),
      );
    }
    it("FIX B11: process_listing_billing_reminders (the original fails once any monthly listing is due)", async () => {
      const original = await runOriginalAsService(db, "process_listing_billing_reminders");
      expect(original.error?.message).toBe('column reference "period_key" is ambiguous');
      const ported = await runIsolated(db, (ctx) => port(ctx).listingBillingReminders());
      expect(ported.result).toMatchObject({ notifications_created: 4, listings_paused: 1 });
      const codes = ported.changes.listing_billing_reminders!.inserted.map((r) => `${r.kind}:${r.reminder_code}`).sort();
      expect(codes).toEqual(["package:1d", "product:5d", "product:expired", "vendor:1d"]);
      const notes = ported.changes.notifications!.inserted.map((n) => n.body as string).sort();
      expect(notes).toEqual([
        "Bundle bundle expires in 1 day. Renew for ₦1,000 to keep it live.",
        "Monthly expired has expired and is paused. Renew for ₦1,000 to restore it.",
        "Monthly fiveDays expires in 5 days. Renew for ₦1,000 to keep it live.",
        "Shop overdue: your combined monthly listing billing renews in 1 day. Review your listings and payment method.",
      ]);
      expect(ported.changes.products!.updated.map((u) => [u.after.status, u.after.billing_status])).toEqual([["paused", "past_due"]]);
      // Run again: nothing new.
      const again = await runIsolated(db, async (ctx) => (await port(ctx).listingBillingReminders(), port(ctx).listingBillingReminders()));
      expect(again.result).toMatchObject({ notifications_created: 0, listings_paused: 0 });
    });
    it("process_listing_billing_reminders with nothing due: both succeed", async () => {
      const hold = await db.query<{ id: string }>(`select id from public.products where billing_model = 'monthly' and billing_paid_until is not null`);
      await db.query(`update public.products set billing_model = 'commission' where id = any($1)`, [hold.map((h) => h.id)]);
      await db.query(`update public.vendor_packages set billing_model = 'commission' where id = $1`, [listing.bundle]);
      await db.query(`update public.vendors set next_monthly_charge_at = now() + interval '3 days' where id = $1`, [shop.overdue]);
      try {
        await same(runOriginalAsService(db, "process_listing_billing_reminders"), runIsolated(db, (ctx) => port(ctx).listingBillingReminders()));
      } finally {
        await db.query(`update public.products set billing_model = 'monthly' where id = any($1)`, [hold.map((h) => h.id)]);
        await db.query(`update public.vendor_packages set billing_model = 'monthly' where id = $1`, [listing.bundle]);
        await db.query(`update public.vendors set next_monthly_charge_at = now() + interval '1 day' where id = $1`, [shop.overdue]);
      }
    });
  });

  describe("monthly listings", () => {
    const submits: [string, Who, string, () => string, string | null, (uid: string) => string | null][] = [
      ["a product receipt", () => owner.dueSoon!, "product", () => listing.fresh!, " Ada Obi ", (uid) => ` ${uid}/receipt.jpg `],
      ["a running month stays live", () => owner.dueSoon!, "product", () => listing.fiveDays!, "Ada", (uid) => `${uid}/r.jpg`],
      ["a package receipt", () => owner.dueSoon!, "package", () => listing.freshBundle!, "Ada", (uid) => `${uid}/r.jpg`],
      ["one already waiting for review", () => owner.dueSoon!, "product", () => listing.unpaid!, "Ada", (uid) => `${uid}/r.jpg`],
      ["a receipt from someone else's folder", () => owner.dueSoon!, "product", () => listing.unpaid!, "Ada", () => "elsewhere/r.jpg"],
      ["not a monthly listing of the shop", () => owner.overdue!, "product", () => listing.unpaid!, "Ada", (uid) => `${uid}/r.jpg`],
      ["a payer name is required", () => owner.dueSoon!, "product", () => listing.unpaid!, " A ", (uid) => `${uid}/r.jpg`],
      ["a receipt is required", () => owner.dueSoon!, "product", () => listing.unpaid!, "Ada", () => " x "],
      ["an unknown type", () => owner.dueSoon!, "service", () => listing.unpaid!, "Ada", (uid) => `${uid}/r.jpg`],
      ["no shop", () => buyer, "product", () => listing.unpaid!, "Ada", (uid) => `${uid}/r.jpg`],
    ];
    for (const [label, who, kind, id, payer, receipt] of submits) {
      it(`submit_monthly_listing_payment: ${label}`, () => {
        const path = receipt(who()!);
        return same(
          runOriginal(db, me(who()), "submit_monthly_listing_payment", { p_kind: kind, p_listing_id: id(), p_payer_name: payer, p_receipt_path: path }),
          runIsolated(db, (ctx) => port(ctx).submitMonthlyPayment(me(who()), kind, id(), payer, path).then((r) => r.id)),
        );
      });
    }
    const reviews: [string, Who, string, string | null][] = [
      ["a product", () => admin, "product", "  Transfer not found  "],
      ["a package", () => admin, "package", null],
      ["already reviewed", () => admin, "reviewed", null],
      ["not an admin", () => owner.dueSoon!, "product", null],
    ];
    for (const [label, who, sub, note] of reviews) {
      it(`admin_approve_monthly_listing: ${label}`, () =>
        same(runOriginal(db, me(who()), "admin_approve_monthly_listing", { p_submission_id: submission[sub] }), runIsolated(db, (ctx) => port(ctx).approveMonthly(me(who()), submission[sub]!))),
      );
      it(`admin_reject_monthly_listing: ${label}`, () =>
        same(
          runOriginal(db, me(who()), "admin_reject_monthly_listing", { p_submission_id: submission[sub], p_note: note }),
          runIsolated(db, (ctx) => port(ctx).rejectMonthly(me(who()), submission[sub]!, note)),
        ),
      );
      it(`admin_deactivate_monthly_listing: ${label}`, () =>
        same(
          runOriginal(db, me(who()), "admin_deactivate_monthly_listing", { p_submission_id: submission[sub], p_note: note }),
          runIsolated(db, (ctx) => port(ctx).deactivateMonthly(me(who()), submission[sub]!, note)),
        ),
      );
    }
    it("an unknown submission", () =>
      same(runOriginal(db, me(admin), "admin_approve_monthly_listing", { p_submission_id: uuid() }), runIsolated(db, (ctx) => port(ctx).approveMonthly(me(admin), uuid()))));
  });
});
