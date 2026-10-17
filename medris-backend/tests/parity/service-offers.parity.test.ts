import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DataContext, Identity } from "../../src/database/context.js";
import { ServiceOffersService } from "../../src/modules/service-offers/service-offers.service.js";
import { asUserSeed, identityOf, seedProduct, seedUser, seedVendor, setRole, uuid } from "../support/fixtures.js";
import { comparable, runIsolated, runOriginal, type CompareOptions, type RunOutcome } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/** ServiceOffersService replaces the service-booking functions; each case runs the original and the port on the same rows. */
describe("parity: service offers", () => {
  let db: TestDatabase;
  let admin: string;
  let buyer: string;
  let owner: string;
  let stranger: string;
  let service: string;
  let monthlyService: string;
  let plainProduct: string;
  let shop: string;
  const offers: Record<string, string> = {};
  const orders: Record<string, string> = {};

  beforeAll(async () => {
    db = await createTestDatabase();
    admin = (await seedUser(db)).id;
    await setRole(db, admin, "admin");
    buyer = (await seedUser(db, { name: "Ngozi Buyer" })).id;
    owner = (await seedUser(db, { role: "vendor" })).id;
    stranger = (await seedUser(db)).id;
    shop = (await seedVendor(db, owner, { name: "Fix-It Ltd" })).id;
    service = await seedProduct(db, shop, { name: "Phone repair" });
    monthlyService = await seedProduct(db, shop, { name: "Laptop repair" });
    plainProduct = await seedProduct(db, shop, { name: "Charger" });
    await db.query(`update public.products set is_service = true, service_price_unit = 'flat' where id in ($1, $2)`, [service, monthlyService]);
    await db.query(`update public.products set billing_model = 'monthly' where id = $1`, [monthlyService]);

    const offer = async (name: string, fields: { by?: string; status?: string; rounds?: number; expires?: string; price?: number } = {}) => {
      const [row] = await db.query<{ id: string }>(
        `insert into public.service_offers (listing_id, buyer_id, vendor_id, description, current_price, current_offer_by, status, round_count, expires_at)
         values ($1, $2, $3, 'Cracked screen', $4, $5, $6, $7, now() + $8::interval) returning id`,
        [service, buyer, shop, fields.price ?? 15000, fields.by ?? "buyer", fields.status ?? "pending", fields.rounds ?? 1, fields.expires ?? "72 hours"],
      );
      offers[name] = row!.id;
    };
    await offer("buyersTurnOver", { by: "buyer" });
    await offer("vendorCountered", { by: "vendor", status: "countered", rounds: 2, price: 18000.5 });
    await offer("expired", { expires: "-1 hour" });
    await offer("maxRounds", { by: "buyer", status: "countered", rounds: 7 });
    await offer("declined", { status: "declined" });
    // Three accepted by the shop through the real function: one awaiting payment, one reported, one disputed.
    for (const name of ["awaiting", "reported", "disputed"]) {
      await offer(name);
      await asUserSeed(db, owner, [[`select public.respond_service_offer($1, 'accept')`, [offers[name]]]]);
      const [row] = await db.query<{ order_id: string }>(`select order_id from public.service_offers where id = $1`, [offers[name]]);
      orders[name] = row!.order_id;
    }
    await asUserSeed(db, buyer, [
      [`select public.report_service_offer_payment($1, 15000)`, [orders.reported]],
      [`select public.report_service_offer_payment($1, 15000)`, [orders.disputed]],
    ]);
    await asUserSeed(db, owner, [[`select public.dispute_service_offer_payment($1)`, [offers.disputed]]]);
  }, 60_000);
  afterAll(() => db.close());

  const port = (ctx: DataContext) => new ServiceOffersService(() => ctx);
  const me = (id: string | null): Identity | null => (id ? identityOf(id) : null);
  async function same(original: Promise<RunOutcome>, ported: Promise<RunOutcome>, options?: CompareOptions) {
    const { original: a, port: b } = comparable(await original, await ported, options);
    expect(b).toEqual(a);
    return a;
  }
  type Who = () => string | null;

  describe("create_service_offer", () => {
    const cases: [string, Who, () => string, string | null, number | null][] = [
      ["a buyer proposes a price (rounded), the shop is told", () => buyer, () => service, "  Screen replacement  ", 12345.678],
      ["the shop's own service is refused", () => owner, () => service, "x", 100],
      ["admins are refused", () => admin, () => service, "x", 100],
      ["a description is required", () => buyer, () => service, "   ", 100],
      ["a price is required", () => buyer, () => service, "x", null],
      ["a price must be positive", () => buyer, () => service, "x", -5],
      ["not a service", () => buyer, () => plainProduct, "x", 100],
      ["a monthly-billed service cannot be negotiated", () => buyer, () => monthlyService, "x", 100],
      ["an unknown listing", () => buyer, () => uuid(), "x", 100],
      ["signed out", () => null, () => service, "x", 100],
    ];
    for (const [label, who, listing, description, price] of cases) {
      it(label, () =>
        same(
          runOriginal(db, me(who()), "create_service_offer", { p_listing_id: listing(), p_description: description, p_price: price }),
          runIsolated(db, (ctx) => port(ctx).create(me(who()), listing(), description, price).then((r) => r.id)),
        ),
      );
    }
  });

  describe("respond_service_offer", () => {
    const cases: [string, Who, string, string | null, number | null, number | null][] = [
      ["the shop accepts: an order to pay directly", () => owner, "buyersTurnOver", "accept", null, 15000],
      ["the shop declines", () => owner, "buyersTurnOver", "decline", null, null],
      ["the shop counters (rounded)", () => owner, "buyersTurnOver", "counter", 16000.555, null],
      ["the buyer accepts the shop's counter", () => buyer, "vendorCountered", "accept", null, 18000.5],
      ["the buyer counters back", () => buyer, "vendorCountered", "counter", 17000, null],
      ["not the buyer's turn", () => buyer, "buyersTurnOver", "accept", null, null],
      ["not the shop's turn", () => owner, "vendorCountered", "accept", null, null],
      ["someone else", () => stranger, "buyersTurnOver", "decline", null, null],
      ["the price changed meanwhile", () => owner, "buyersTurnOver", "accept", null, 15000.02],
      ["a difference of one kobo is the same price", () => owner, "buyersTurnOver", "accept", null, 15000.01],
      ["an expired offer", () => owner, "expired", "accept", null, null],
      ["a declined offer", () => owner, "declined", "accept", null, null],
      ["after 7 rounds no more counters", () => owner, "maxRounds", "counter", 100, null],
      ["a counter needs a price", () => owner, "buyersTurnOver", "counter", null, null],
      ["an unknown action", () => owner, "buyersTurnOver", "haggle", null, null],
      ["signed out", () => null, "buyersTurnOver", "decline", null, null],
    ];
    for (const [label, who, offer, action, price, expected] of cases) {
      it(label, () =>
        same(
          runOriginal(db, me(who()), "respond_service_offer", { p_offer_id: offers[offer], p_action: action, p_price: price, p_expected_price: expected }),
          runIsolated(db, (ctx) => port(ctx).respond(me(who()), offers[offer]!, action, price, expected)),
        ),
      );
    }
    it("an unknown offer", () =>
      same(
        runOriginal(db, me(owner), "respond_service_offer", { p_offer_id: uuid(), p_action: "accept" }),
        runIsolated(db, (ctx) => port(ctx).respond(me(owner), uuid(), "accept", null, null)),
      ));
  });

  describe("report_service_offer_payment", () => {
    const cases: [string, Who, string, number | null][] = [
      ["the buyer reports the agreed amount", () => buyer, "awaiting", 15000],
      ["the wrong amount", () => buyer, "awaiting", 14000],
      ["no amount", () => buyer, "awaiting", null],
      ["not the buyer", () => owner, "awaiting", 15000],
      ["signed out", () => null, "awaiting", 15000],
    ];
    for (const [label, who, offer, amount] of cases) {
      it(label, () =>
        same(
          runOriginal(db, me(who()), "report_service_offer_payment", { p_order_id: orders[offer], p_amount: amount }),
          runIsolated(db, (ctx) => port(ctx).reportPayment(me(who()), orders[offer]!, amount)),
        ),
      );
    }
    it("FIX B9: reporting again updates the same payment (the original always failed)", async () => {
      const original = await runOriginal(db, me(buyer), "report_service_offer_payment", { p_order_id: orders.reported, p_amount: 15000.01 });
      expect(original.error?.message).toMatch(/null value in column "expires_at"/);
      const ported = await runIsolated(db, (ctx) => port(ctx).reportPayment(me(buyer), orders.reported!, 15000.01));
      expect(ported.error).toBeUndefined();
      expect(ported.changes.payments!.inserted).toHaveLength(0);
      expect(ported.changes.payments!.updated).toHaveLength(1);
      expect(ported.changes.payments!.updated[0]!.after).toMatchObject({ amount: 15000.01, status: "pending", provider_reference: "service_offer_report" });
      expect(ported.changes.notifications!.inserted.length).toBeGreaterThan(0);
    });
    it("a disputed booking can be reported again (both)", () =>
      same(
        runOriginal(db, me(buyer), "report_service_offer_payment", { p_order_id: orders.disputed, p_amount: 15000 }),
        runIsolated(db, (ctx) => port(ctx).reportPayment(me(buyer), orders.disputed!, 15000)),
      ));
    it("an order that is not a service booking", () =>
      same(
        runOriginal(db, me(buyer), "report_service_offer_payment", { p_order_id: uuid(), p_amount: 1 }),
        runIsolated(db, (ctx) => port(ctx).reportPayment(me(buyer), uuid(), 1)),
      ));
  });

  describe("confirm_service_offer_payment / dispute_service_offer_payment", () => {
    const cases: [string, Who, string][] = [
      ["the shop, a reported payment", () => owner, "reported"],
      ["the shop, a disputed payment", () => owner, "disputed"],
      ["the shop, nothing reported yet", () => owner, "awaiting"],
      ["the buyer", () => buyer, "reported"],
      ["signed out", () => null, "reported"],
    ];
    for (const [label, who, offer] of cases) {
      it(`confirm: ${label}`, () =>
        same(
          runOriginal(db, me(who()), "confirm_service_offer_payment", { p_offer_id: offers[offer] }),
          runIsolated(db, (ctx) => port(ctx).confirmPayment(me(who()), offers[offer]!)),
        ),
      );
      it(`dispute: ${label}`, () =>
        same(
          runOriginal(db, me(who()), "dispute_service_offer_payment", { p_offer_id: offers[offer] }),
          runIsolated(db, (ctx) => port(ctx).disputePayment(me(who()), offers[offer]!)),
        ),
      );
    }
    for (const fn of ["confirm_service_offer_payment", "dispute_service_offer_payment"] as const) {
      it(`${fn}: an unknown offer`, () =>
        same(
          runOriginal(db, me(owner), fn, { p_offer_id: uuid() }),
          runIsolated(db, (ctx) => (fn === "confirm_service_offer_payment" ? port(ctx).confirmPayment(me(owner), uuid()) : port(ctx).disputePayment(me(owner), uuid()))),
        ),
      );
    }
  });
});
