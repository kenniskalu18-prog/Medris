import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DataContext, Identity } from "../../src/database/context.js";
import { OrderActionsService } from "../../src/modules/order-actions/order-actions.service.js";
import { identityOf, seedOrder, seedPackage, seedProduct, seedUser, seedVendor, setRole, uuid } from "../support/fixtures.js";
import { bothRefused, comparable, runIsolated, runOriginal, type CompareOptions, type RunOutcome } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/** OrderActionsService replaces the order functions used after checkout; each case runs the original and the port on the same rows. */
describe("parity: order actions", () => {
  let db: TestDatabase;
  let admin: string;
  let buyer: string;
  let owner: string;
  let stranger: string;
  let shop: string;
  let rice: string;
  let beans: string;
  const o: Record<string, string> = {};
  const lines: Record<string, string> = {};

  beforeAll(async () => {
    db = await createTestDatabase();
    admin = (await seedUser(db)).id;
    await setRole(db, admin, "admin");
    buyer = (await seedUser(db, { name: "Bisi Buyer" })).id;
    owner = (await seedUser(db, { role: "vendor" })).id;
    stranger = (await seedUser(db)).id;
    shop = (await seedVendor(db, owner, { name: "Grain Store" })).id;
    rice = await seedProduct(db, shop, { name: "Rice 10kg" });
    beans = await seedProduct(db, shop, { name: "Beans 5kg" });
    await db.query(`update public.products set quantity_total = 20, quantity_available = 10 where id in ($1, $2)`, [rice, beans]);

    const order = async (name: string, status: string, options: { delivery?: "pickup" | "delivery"; type?: string; extra?: string } = {}) => {
      o[name] = await seedOrder(db, buyer, shop, { status: "pending", productIds: [rice, beans], delivery: options.delivery });
      if (options.type) await db.query(`update public.orders set order_type = $2 where id = $1`, [o[name], options.type]);
      if (status !== "pending") await db.query(`update public.orders set status = $2 where id = $1`, [o[name], status]);
      if (options.extra) await db.query(`update public.orders set ${options.extra} where id = $1`, [o[name]]);
    };
    const paid = (name: string, type: string) =>
      db.query(`insert into public.payments (order_id, payment_type, amount, method, status) values ($1, $2, 2500, 'transfer', 'paid')`, [o[name], type]);
    await order("pending", "pending");
    await order("pendingDelivery", "pending", { delivery: "delivery" });
    await order("confirmed", "confirmed");
    await order("confirmedPaid", "confirmed", { extra: "awaiting_confirmation_since = now()" });
    await paid("confirmedPaid", "sale_price");
    await order("handedDelivery", "handed_over", { delivery: "delivery", extra: "awaiting_confirmation_since = now(), payment_timing = 'pay_after'" });
    await paid("handedDelivery", "sale_price");
    await order("handedDeliveryUnpaid", "handed_over", { delivery: "delivery", extra: "awaiting_confirmation_since = now(), payment_timing = 'pay_after'" });
    await paid("handedDeliveryUnpaid", "sale_price");
    await order("rental", "handed_over", { type: "rental" });
    await order("completed", "completed");
    await order("cancelled", "cancelled");
    await order("withProposal", "pending");
    const [r1, r2] = await db.query<{ id: string; product_id: string }>(`select id, product_id from public.order_items where order_id = $1 order by product_id = $2 desc`, [
      o.pending,
      rice,
    ]);
    lines.pendingRice = r1!.id;
    lines.pendingBeans = r2!.id;
    await db.query(`update public.order_items set quantity = 3 where order_id in ($1, $2)`, [o.pending, o.withProposal]);
    const proposalLines = await db.query<{ id: string; quantity: number }>(`select id, quantity from public.order_items where order_id = $1`, [o.withProposal]);
    await db.query(`update public.orders set quantity_proposal = $2::jsonb where id = $1`, [
      o.withProposal,
      JSON.stringify({ items: proposalLines.map((l, i) => ({ id: l.id, name: "x", requested: l.quantity, suggested: i === 0 ? 1 : 3 })), note: null }),
    ]);
    const pkg = await seedPackage(db, shop);
    await order("package", "pending", { extra: `package_id = '${pkg}'` });
    await db.query(`insert into public.order_notes (order_id, sender_id, body) select $1, $2, 'note ' || g from generate_series(1, 10) g`, [o.confirmed, owner]);
  }, 60_000);
  afterAll(() => db.close());

  const port = (ctx: DataContext) => new OrderActionsService(() => ctx);
  const me = (id: string | null): Identity | null => (id ? identityOf(id) : null);
  async function same(original: Promise<RunOutcome>, ported: Promise<RunOutcome>, options?: CompareOptions) {
    const { original: a, port: b } = comparable(await original, await ported, options);
    expect(b).toEqual(a);
    return a;
  }
  const voidResult = { result: () => null };
  type Who = () => string | null;

  describe("transition_order_status", () => {
    const cases: [string, Who, string, string][] = [
      ["the vendor confirms", () => owner, "pending", "confirmed"],
      ["the vendor cancels a pending order", () => owner, "pending", "cancelled"],
      ["the vendor completes a paid order", () => owner, "confirmedPaid", "completed"],
      ["not before the payment is verified", () => owner, "confirmed", "completed"],
      ["a delivery order: deposit and fee needed", () => owner, "handedDelivery", "completed"],
      ["the vendor marks a rental returned", () => owner, "rental", "returned"],
      ["an invalid step for the vendor", () => owner, "completed", "pending"],
      ["the buyer cancels a pending order", () => buyer, "pending", "cancelled"],
      ["the buyer cancels a confirmed order", () => buyer, "confirmed", "cancelled"],
      ["the buyer returns a rental", () => buyer, "rental", "returned"],
      ["the buyer cannot confirm", () => buyer, "pending", "confirmed"],
      ["the buyer cannot complete", () => buyer, "confirmedPaid", "completed"],
      ["someone else", () => stranger, "pending", "cancelled"],
      ["not a status", () => owner, "pending", "shipped"],
    ];
    for (const [label, who, order, status] of cases) {
      it(label, () =>
        same(
          runOriginal(db, me(who()), "transition_order_status", { p_order_id: o[order], p_new_status: status }),
          runIsolated(db, (ctx) => port(ctx).transition(me(who()), o[order]!, status)),
          voidResult,
        ),
      );
    }
    it("an unknown order", () =>
      same(
        runOriginal(db, me(owner), "transition_order_status", { p_order_id: uuid(), p_new_status: "confirmed" }),
        runIsolated(db, (ctx) => port(ctx).transition(me(owner), uuid(), "confirmed")),
        voidResult,
      ));
    it("signed out: refused by both", async () => {
      const a = await runOriginal(db, null, "transition_order_status", { p_order_id: o.pending, p_new_status: "cancelled" });
      const b = await runIsolated(db, (ctx) => port(ctx).transition(null, o.pending!, "cancelled"));
      expect(bothRefused(a, b)).toBe(true);
    });
  });

  describe("buyer_confirm_received", () => {
    const cases: [string, Who, string][] = [
      ["a paid order waiting for the buyer", () => buyer, "confirmedPaid"],
      ["a delivery paid after delivery, deposit missing", () => buyer, "handedDeliveryUnpaid"],
      ["not waiting for confirmation", () => buyer, "pending"],
      ["not the buyer", () => owner, "confirmedPaid"],
      ["signed out", () => null, "confirmedPaid"],
    ];
    for (const [label, who, order] of cases) {
      it(label, () =>
        same(runOriginal(db, me(who()), "buyer_confirm_received", { p_order_id: o[order] }), runIsolated(db, (ctx) => port(ctx).confirmReceived(me(who()), o[order]!))),
      );
    }
  });

  describe("vendor_decline_order", () => {
    const cases: [string, Who, string, string | null][] = [
      ["with a reason", () => owner, "pending", "  Out of stock  "],
      ["without one", () => owner, "confirmed", "   "],
      ["too late", () => owner, "completed", null],
      ["not the vendor", () => buyer, "pending", null],
      ["signed out", () => null, "pending", null],
    ];
    for (const [label, who, order, reason] of cases) {
      it(label, () =>
        same(
          runOriginal(db, me(who()), "vendor_decline_order", { p_order_id: o[order], p_reason: reason }),
          runIsolated(db, (ctx) => port(ctx).decline(me(who()), o[order]!, reason)),
          voidResult,
        ),
      );
    }
  });

  describe("add_order_note", () => {
    const cases: [string, Who, string, string | null][] = [
      ["the buyer writes; the vendor is told", () => buyer, "pending", `  ${"Please pack well. ".repeat(6)}`],
      ["the vendor replies", () => owner, "pending", "Sure"],
      ["the note limit", () => owner, "confirmed", "Again"],
      ["a closed order", () => buyer, "completed", "Hi"],
      ["empty", () => buyer, "pending", "   "],
      ["too long", () => buyer, "pending", "x".repeat(501)],
      ["not a party", () => stranger, "pending", "Hi"],
      ["signed out", () => null, "pending", "Hi"],
    ];
    for (const [label, who, order, body] of cases) {
      it(label, () =>
        same(
          runOriginal(db, me(who()), "add_order_note", { p_order_id: o[order], p_body: body }),
          runIsolated(db, (ctx) => port(ctx).addNote(me(who()), o[order]!, body).then((r) => r.id)),
        ),
      );
    }
  });

  describe("edit_pending_order", () => {
    const items = (rice: number | string, beans?: number) => [
      { order_item_id: lines.pendingRice, quantity: rice },
      ...(beans === undefined ? [] : [{ order_item_id: lines.pendingBeans, quantity: beans }]),
    ];
    const cases: [string, Who, string, () => unknown][] = [
      ["more of one, none of the other", () => buyer, "pending", () => items(5)],
      ["fewer of both, new details", () => buyer, "pending", () => items(1, 2)],
      ["more than the stock", () => buyer, "pending", () => items(14, 1)],
      ["nothing left", () => buyer, "pending", () => items(0, 0)],
      ["a line from another order", () => buyer, "pending", () => [...items(1, 1), { order_item_id: uuid(), quantity: 1 }]],
      ["a negative quantity", () => buyer, "pending", () => items(-1, 1)],
      ["a malformed quantity", () => buyer, "pending", () => items("two", 1)],
      ["an empty list", () => buyer, "pending", () => []],
      ["a confirmed order", () => buyer, "confirmed", () => items(1)],
      ["a package order", () => buyer, "package", () => items(1)],
      ["not the buyer", () => owner, "pending", () => items(1)],
      ["signed out", () => null, "pending", () => items(1)],
    ];
    for (const [label, who, order, list] of cases) {
      it(label, () =>
        same(
          runOriginal(db, me(who()), "edit_pending_order", {
            p_order_id: o[order],
            p_items: list(),
            p_buyer_note: " Call me ",
            p_delivery_address: "12 Lekki",
            p_delivery_phone: "0803",
          }),
          runIsolated(db, (ctx) => port(ctx).editPending(me(who()), o[order]!, list(), " Call me ", "12 Lekki", "0803")),
          voidResult,
        ),
      );
    }
  });

  describe("buyer contact", () => {
    for (const [label, who] of [["the vendor", () => owner], ["an admin", () => admin], ["the buyer", () => buyer], ["signed out", () => null]] as const) {
      for (const order of ["pending", "confirmed"]) {
        it(`get_order_buyer_contact (${order}), ${label}`, () =>
          same(runOriginal(db, me(who()), "get_order_buyer_contact", { p_order_id: o[order] }), runIsolated(db, (ctx) => port(ctx).buyerContact(me(who()), o[order]!))),
        );
      }
      if (who() !== null) {
        it(`get_orders_buyer_names, ${label}`, () => {
          const ids = [o.pending!, o.confirmed!, o.cancelled!, uuid()];
          return same(runOriginal(db, me(who()), "get_orders_buyer_names", { p_order_ids: ids }), runIsolated(db, (ctx) => port(ctx).buyerNames(me(who()), ids)));
        });
      }
    }
  });

  describe("send_order_reminder / set_order_buyer_location", () => {
    for (const [label, who, order] of [
      ["a pending order", () => buyer, "pending"],
      ["a confirmed order", () => buyer, "confirmed"],
      ["not the buyer", () => owner, "pending"],
      ["signed out", () => null, "pending"],
    ] as const) {
      it(`reminder: ${label}`, () =>
        same(runOriginal(db, me(who()), "send_order_reminder", { p_order_id: o[order] }), runIsolated(db, (ctx) => port(ctx).remind(me(who()), o[order]!).then((r) => r.id))),
      );
    }
    const locations: [string, Who, string, number | null, number | null][] = [
      ["a pending delivery order", () => buyer, "pendingDelivery", 6.45, 3.39],
      ["a pickup order", () => buyer, "pending", 6.45, 3.39],
      ["out of range", () => buyer, "pendingDelivery", 91, 3],
      ["missing", () => buyer, "pendingDelivery", null, 3],
      ["not the buyer", () => owner, "pendingDelivery", 6.45, 3.39],
      ["signed out", () => null, "pendingDelivery", 6.45, 3.39],
    ];
    for (const [label, who, order, lat, lng] of locations) {
      it(`location: ${label}`, () =>
        same(
          runOriginal(db, me(who()), "set_order_buyer_location", { p_order_id: o[order], p_lat: lat, p_lng: lng }),
          runIsolated(db, (ctx) => port(ctx).setLocation(me(who()), o[order]!, lat, lng)),
          voidResult,
        ),
      );
    }
  });

  describe("quantity suggestions", () => {
    const suggest = (riceQty: number, beansQty?: number) => [
      { id: lines.pendingRice, quantity: riceQty },
      ...(beansQty === undefined ? [] : [{ id: lines.pendingBeans, quantity: beansQty }]),
    ];
    const cases: [string, Who, string, () => unknown, string | null][] = [
      ["the vendor can supply less", () => owner, "pending", () => suggest(2), `  ${"Only two bags left. ".repeat(20)}`],
      ["nothing changed", () => owner, "pending", () => suggest(3, 3), null],
      ["nothing left", () => owner, "pending", () => suggest(0, 0), null],
      ["more than ordered", () => owner, "pending", () => suggest(4), null],
      ["an empty list", () => owner, "pending", () => [], null],
      ["already paid", () => owner, "confirmedPaid", () => suggest(0), null],
      ["not pending", () => owner, "confirmed", () => suggest(0), null],
      ["not the vendor", () => buyer, "pending", () => suggest(1), null],
      ["signed out", () => null, "pending", () => suggest(1), null],
    ];
    for (const [label, who, order, items, note] of cases) {
      it(`suggest: ${label}`, () =>
        same(
          runOriginal(db, me(who()), "vendor_suggest_order_quantity", { p_order_id: o[order], p_items: items(), p_note: note }),
          runIsolated(db, (ctx) => port(ctx).suggestQuantity(me(who()), o[order]!, items(), note)),
        ),
      );
    }
    const responses: [string, Who, string, boolean][] = [
      ["the buyer accepts: new total", () => buyer, "withProposal", true],
      ["the buyer keeps the order", () => buyer, "withProposal", false],
      ["no suggestion", () => buyer, "pending", true],
      ["not the buyer", () => owner, "withProposal", true],
      ["signed out", () => null, "withProposal", true],
    ];
    for (const [label, who, order, accept] of responses) {
      it(`respond: ${label}`, () =>
        same(
          runOriginal(db, me(who()), "buyer_respond_quantity_proposal", { p_order_id: o[order], p_accept: accept }),
          runIsolated(db, (ctx) => port(ctx).respondToProposal(me(who()), o[order]!, accept)),
        ),
      );
    }
  });
});
