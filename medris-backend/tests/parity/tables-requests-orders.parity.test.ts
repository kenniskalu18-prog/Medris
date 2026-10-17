import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DataContext } from "../../src/database/context.js";
import { AdminDashboardService } from "../../src/modules/admin-dashboard/admin-dashboard.service.js";
import { CommissionService } from "../../src/modules/commission/commission.service.js";
import { OrderActionsService } from "../../src/modules/order-actions/order-actions.service.js";
import { RequestsService } from "../../src/modules/requests/requests.service.js";
import { ServiceOffersService } from "../../src/modules/service-offers/service-offers.service.js";
import { identityOf, seedOrder, seedProduct, seedUser, seedVendor, setRole } from "../support/fixtures.js";
import { comparable, runIsolated, runTableQuery, type CompareOptions, type RunOutcome } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/**
 * The app's direct table queries on equipment_requests / request_offers, disputes (the admin queue),
 * payments, service_offers and commission_charges, against the endpoints that replace them.
 */
describe("parity: table queries - requests, disputes queue, payments, service offers, commission charges", () => {
  let db: TestDatabase;
  let admin: string;
  let buyer: string;
  let owner: string;
  let otherOwner: string;
  let stranger: string;
  let shop: string;
  let otherShop: string;
  let openRequest: string;
  let order: string;
  let escalated: string;
  let listing: string;
  let offer: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    admin = (await seedUser(db)).id;
    await setRole(db, admin, "admin");
    buyer = (await seedUser(db, { name: "Bola" })).id;
    owner = (await seedUser(db, { role: "vendor" })).id;
    otherOwner = (await seedUser(db, { role: "vendor" })).id;
    stranger = (await seedUser(db)).id;
    shop = (await seedVendor(db, owner, { name: "Dayo Gadgets" })).id;
    otherShop = (await seedVendor(db, otherOwner, { name: "Efe Rentals" })).id;
    openRequest = (await db.query<{ id: string }>(`insert into public.equipment_requests (buyer_id, title, city) values ($1, 'Generator', 'Lagos') returning id`, [buyer]))[0]!.id;
    await db.query(`insert into public.equipment_requests (buyer_id, title, status) values ($1, 'Old', 'cancelled')`, [buyer]);
    await db.query(`insert into public.request_offers (request_id, vendor_id, message, price) values ($1, $2, 'I have one', 15000), ($1, $3, 'Me too', 12000)`, [openRequest, shop, otherShop]);
    const product = await seedProduct(db, shop);
    order = await seedOrder(db, buyer, shop, { status: "confirmed", productIds: [product] });
    await db.query(`insert into public.payments (order_id, payment_type, amount, method, status) values ($1, 'sale_price', 2500, 'transfer', 'paid')`, [order]);
    await db.query(`insert into public.disputes (order_id, raised_by, reason) values ($1, 'buyer', 'late')`, [order]);
    escalated = await seedOrder(db, buyer, shop, { status: "confirmed", productIds: [product] });
    await db.query(`update public.orders set payment_escalated_at = now() where id = $1`, [escalated]);
    listing = await seedProduct(db, shop, { name: "Tailoring" });
    offer = (
      await db.query<{ id: string }>(
        `insert into public.service_offers (listing_id, buyer_id, vendor_id, description, current_price, current_offer_by) values ($1, $2, $3, 'A gown', 5000, 'buyer') returning id`,
        [listing, buyer, shop],
      )
    )[0]!.id;
    await db.query(`insert into public.commission_charges (vendor_id, order_id, amount, due_at) values ($1, $2, 75, now() + interval '3 days')`, [shop, order]);
  }, 60_000);
  afterAll(() => db.close());

  const me = (id: string) => identityOf(id);
  async function same(original: Promise<RunOutcome>, port: Promise<RunOutcome>, options?: CompareOptions) {
    const [o, p] = [await original, await port];
    const { original: a, port: b } = comparable(o, p, options);
    expect(b).toEqual(a);
    return o;
  }
  async function bothRefused(original: Promise<RunOutcome>, port: Promise<RunOutcome>) {
    const [o, p] = [await original, await port];
    expect(o.error).toBeDefined();
    expect(p.error?.message).toBe(o.error?.message);
  }
  const requests = (ctx: DataContext) => new RequestsService(() => ctx);
  const single = (o: RunOutcome) => ({ ...o, result: (o.result as unknown[] | undefined)?.[0] ?? null });

  describe("equipment_requests and request_offers", () => {
    it("the buyer's requests with every offer and the offering shops", () =>
      same(
        runTableQuery(
          db,
          me(buyer),
          sql`select r.*, coalesce((select json_agg(json_build_object('id', o.id, 'vendor_id', o.vendor_id, 'message', o.message, 'price', o.price, 'status', o.status, 'created_at', o.created_at,
                 'vendor', (select json_build_object('business_name', v.business_name, 'avg_rating', v.avg_rating, 'phone', v.phone, 'whatsapp_number', v.whatsapp_number, 'delivery_fee', v.delivery_fee) from public.vendors v where v.id = o.vendor_id)))
                 from public.request_offers o where o.request_id = r.id), '[]'::json) as offers
              from public.equipment_requests r where r.buyer_id = ${buyer} order by r.created_at desc`,
        ),
        runIsolated(db, (ctx) => requests(ctx).mine(me(buyer))),
      ));
    it("open requests: a shop sees only its own offer on them", async () => {
      for (const who of [owner, stranger]) {
        const o = await same(
          runTableQuery(
            db,
            me(who),
            sql`select r.*, coalesce((select json_agg(json_build_object('id', o.id, 'vendor_id', o.vendor_id, 'status', o.status)) from public.request_offers o where o.request_id = r.id), '[]'::json) as offers
                from public.equipment_requests r where r.status = 'open' order by r.created_at desc`,
          ),
          runIsolated(db, (ctx) => requests(ctx).open(me(who))),
        );
        expect((o.result as { offers: unknown[] }[])[0]!.offers).toHaveLength(who === owner ? 1 : 0);
      }
    });
    it("post a request (shops are notified by the trigger)", () =>
      same(
        runTableQuery(
          db,
          me(buyer),
          sql`insert into public.equipment_requests (buyer_id, title, description, category_id, city, needed_from, needed_to, request_type, photos, campus_id, buyer_name, buyer_avatar_url)
              values (${buyer}, 'Projector', null, null, 'Abuja', '2026-11-01', '2026-11-02', 'rent', '["https://cdn.test/p.jpg"]'::jsonb, null, 'Bola', null)`,
          false,
        ),
        runIsolated(db, (ctx) =>
          requests(ctx)
            .create(me(buyer), { title: "Projector", description: null, category_id: null, city: "Abuja", needed_from: "2026-11-01", needed_to: "2026-11-02", request_type: "rent", photos: ["https://cdn.test/p.jpg"], campus_id: null })
            .then(() => null),
        ),
      ));
    it("cancel (the buyer's own open request only)", async () => {
      for (const who of [buyer, stranger]) {
        await same(
          runTableQuery(db, me(who), sql`update public.equipment_requests set status = 'cancelled' where id = ${openRequest} and buyer_id = ${who} and status = 'open'`, false),
          runIsolated(db, (ctx) => requests(ctx).cancel(me(who), openRequest).then(() => null)),
        );
      }
    });
    it("a shop offers (refused for someone who does not own the shop)", async () => {
      await same(
        runTableQuery(db, me(otherOwner), sql`insert into public.request_offers (request_id, vendor_id, message, price) values (${openRequest}, ${otherShop}, 'Another', 9000)`, false),
        runIsolated(db, (ctx) => requests(ctx).offer(me(otherOwner), openRequest, otherShop, "Another", 9000).then(() => null)),
      );
      await bothRefused(
        runTableQuery(db, me(stranger), sql`insert into public.request_offers (request_id, vendor_id, message, price) values (${openRequest}, ${shop}, 'x', 1)`, false),
        runIsolated(db, (ctx) => requests(ctx).offer(me(stranger), openRequest, shop, "x", 1)),
      );
    });
  });

  it("the admin disputes queue (others see empty lists)", async () => {
    const payments = sql`coalesce((select json_agg(json_build_object('id', p.id, 'payment_type', p.payment_type, 'amount', p.amount, 'status', p.status, 'provider_reference', p.provider_reference, 'created_at', p.created_at, 'paid_at', p.paid_at)) from public.payments p where p.order_id = o.id), '[]'::json)`;
    const shopName = sql`(select json_build_object('business_name', v.business_name) from public.vendors v where v.id = o.vendor_id)`;
    for (const who of [admin, stranger]) {
      const original = await runIsolated(db, (ctx) =>
        ctx.asCaller(me(who), async (tx) => {
          const rows = async (q: ReturnType<typeof sql>) =>
            ((await tx.execute(sql`select coalesce(json_agg(to_json(x)), '[]'::json) as j from (${q}) x`)) as unknown as { rows: { j: unknown[] }[] }).rows[0]!.j;
          return {
            disputes: await rows(sql`select d.*, (select json_build_object('id', o.id, 'order_type', o.order_type, 'buyer_id', o.buyer_id, 'vendor_id', o.vendor_id, 'payout_status', o.payout_status, 'status', o.status,
                       'payment_unresolved_at', o.payment_unresolved_at, 'payment_escalated_at', o.payment_escalated_at, 'total_amount', o.total_amount, 'status_changed_at', o.status_changed_at,
                       'vendor', ${shopName}, 'payments', ${payments}) from public.orders o where o.id = d.order_id) as "order" from public.disputes d where d.status = 'open' order by d.created_at asc`),
            unresolvedPayments: await rows(sql`select o.id, o.order_type, o.buyer_id, o.vendor_id, o.status, o.payment_unresolved_at, o.payment_escalated_at, o.total_amount, o.status_changed_at, ${shopName} as vendor, ${payments} as payments
                       from public.orders o where o.status = 'payment_unresolved' and o.payment_escalated_at is not null order by o.payment_escalated_at asc`),
            unpaidConfirmed: await rows(sql`select o.id, o.order_type, o.buyer_id, o.vendor_id, o.status, o.total_amount, o.status_changed_at, o.payment_escalated_at, ${shopName} as vendor, ${payments} as payments
                       from public.orders o where o.status = 'confirmed' and o.payment_escalated_at is not null order by o.payment_escalated_at asc`),
          };
        }),
      );
      const o = await same(Promise.resolve(original), runIsolated(db, (ctx) => new AdminDashboardService(() => ctx).disputesQueue(me(who))));
      const r = o.result as { disputes: unknown[]; unpaidConfirmed: unknown[] };
      expect([r.disputes.length, r.unpaidConfirmed.length]).toEqual(who === admin ? [1, 1] : [0, 0]);
    }
  });

  it("an order's payments (the buyer, the shop, a stranger)", async () => {
    for (const who of [buyer, owner, stranger]) {
      await same(
        runTableQuery(db, me(who), sql`select id, payment_type, status, amount from public.payments where order_id = ${order}`),
        runIsolated(db, (ctx) => new OrderActionsService(() => ctx).payments(me(who), order)),
      );
    }
  });

  it("service offers: a listing's, and one (only for the two sides)", async () => {
    const cols = sql`id, listing_id, buyer_id, vendor_id, description, current_price, current_offer_by, status, round_count, created_at, updated_at, expires_at, accepted_at, payment_reported_at, completed_at, order_id`;
    for (const who of [buyer, owner, stranger]) {
      await same(
        runTableQuery(db, me(who), sql`select ${cols} from public.service_offers where listing_id = ${listing} order by updated_at desc limit 20`),
        runIsolated(db, (ctx) => new ServiceOffersService(() => ctx).forListing(me(who), listing)),
      );
      await same(runTableQuery(db, me(who), sql`select ${cols} from public.service_offers where id = ${offer}`).then(single), runIsolated(db, (ctx) => new ServiceOffersService(() => ctx).one(me(who), offer)));
    }
  });

  it("the shop's unpaid commission charges (the owner and admins)", async () => {
    for (const who of [owner, admin, buyer]) {
      await same(
        runTableQuery(db, me(who), sql`select amount, due_at from public.commission_charges where vendor_id = ${shop} and status = 'owed' order by due_at asc`),
        runIsolated(db, (ctx) => new CommissionService(() => ctx).owedCharges(me(who), shop)),
      );
    }
  });
});
