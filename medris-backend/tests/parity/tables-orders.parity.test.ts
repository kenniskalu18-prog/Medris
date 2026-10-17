import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DataContext } from "../../src/database/context.js";
import type { OrderListFilter } from "../../src/database/repositories/order-views.repository.js";
import { OrderActionsService } from "../../src/modules/order-actions/order-actions.service.js";
import { identityOf, seedOrder, seedProduct, seedUser, seedVendor, setRole } from "../support/fixtures.js";
import { comparable, runIsolated, runTableQuery, type CompareOptions, type RunOutcome } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/** The app's direct reads of orders (the order page, lists and counts), against the endpoints that replace them. */
describe("parity: table queries - orders", () => {
  let db: TestDatabase;
  let admin: string;
  let buyer: string;
  let owner: string;
  let stranger: string;
  let shop: string;
  let otherShop: string;
  let confirmed: string;
  let completed: string;
  let pending: string;
  let other: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    admin = (await seedUser(db)).id;
    await setRole(db, admin, "admin");
    buyer = (await seedUser(db, { name: "Bola" })).id;
    owner = (await seedUser(db, { role: "vendor" })).id;
    stranger = (await seedUser(db)).id;
    shop = (await seedVendor(db, owner, { name: "Dayo Gadgets" })).id;
    otherShop = (await seedVendor(db, (await seedUser(db, { role: "vendor" })).id, { name: "Efe" })).id;
    const phone = await seedProduct(db, shop, { name: "Phone" });
    const kettle = await seedProduct(db, otherShop, { name: "Kettle" });
    confirmed = await seedOrder(db, buyer, shop, { status: "confirmed", productIds: [phone], createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString() });
    completed = await seedOrder(db, buyer, shop, { status: "confirmed", productIds: [phone], createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString() });
    await db.query(`insert into public.payments (order_id, payment_type, amount, method, status) values ($1, 'sale_price', 2500, 'transfer', 'paid')`, [completed]);
    await db.query(`update public.orders set status = 'completed', payout_status = 'released', payout_released_at = now() where id = $1`, [completed]);
    await db.query(`insert into public.reviews (order_id, buyer_id, vendor_id, rating) values ($1, $2, $3, 5)`, [completed, buyer, shop]);
    pending = await seedOrder(db, buyer, shop, { status: "pending", productIds: [phone] });
    await db.query(`update public.orders set payment_escalated_at = now() where id = $1`, [confirmed]);
    await db.query(`insert into public.disputes (order_id, raised_by, reason) values ($1, 'buyer', 'late')`, [confirmed]);
    other = await seedOrder(db, stranger, otherShop, { status: "pending", productIds: [kettle] });
  }, 60_000);
  afterAll(() => db.close());

  const me = (id: string) => identityOf(id);
  const orders = (ctx: DataContext) => new OrderActionsService(() => ctx);
  async function same(original: Promise<RunOutcome>, port: Promise<RunOutcome>, options?: CompareOptions) {
    const [o, p] = [await original, await port];
    const { original: a, port: b } = comparable(o, p, options);
    expect(b).toEqual(a);
    return o;
  }
  const single = (o: RunOutcome) => ({ ...o, result: (o.result as unknown[] | undefined)?.[0] ?? null });

  const detailSql = (id: string) => sql`select o.*,
      (select json_build_object('id', v.id, 'business_name', v.business_name, 'phone', v.phone, 'whatsapp_number', v.whatsapp_number, 'whatsapp_visible', v.whatsapp_visible,
         'address', v.address, 'city', v.city, 'opening_hours', v.opening_hours, 'user_id', v.user_id, 'lat', v.lat, 'lng', v.lng, 'logo_url', v.logo_url, 'avg_rating', v.avg_rating,
         'review_count', v.review_count, 'verification_status', v.verification_status, 'bank_code', v.bank_code, 'bank_name', v.bank_name, 'account_number', v.account_number,
         'account_name', v.account_name) from public.vendors v where v.id = o.vendor_id) as vendor,
      (select json_build_object('name', u.name) from public.users u where u.id = o.buyer_id) as buyer,
      coalesce((select json_agg(to_jsonb(oi) || jsonb_build_object('variant', (select json_build_object('name', pv.name) from public.product_variants pv where pv.id = oi.variant_id),
         'product', (select json_build_object('id', p.id, 'name', p.name, 'photos', p.photos, 'is_service', p.is_service, 'quantity_available', p.quantity_available, 'track_quantity', p.track_quantity)
                     from public.products p where p.id = oi.product_id))) from public.order_items oi where oi.order_id = o.id), '[]'::json) as items,
      coalesce((select json_agg(to_json(p)) from public.payments p where p.order_id = o.id), '[]'::json) as payments,
      (select json_build_object('id', r.id) from public.reviews r where r.order_id = o.id) as review,
      coalesce((select json_agg(json_build_object('id', d.id, 'reason', d.reason, 'status', d.status, 'admin_notes', d.admin_notes, 'vendor_response', d.vendor_response,
         'created_at', d.created_at, 'raised_by', d.raised_by, 'attachments', d.attachments)) from public.disputes d where d.order_id = o.id), '[]'::json) as disputes,
      (select json_build_object('name', vp.name) from public.vendor_packages vp where vp.id = o.package_id) as package
    from public.orders o where o.id = ${id}`;

  it("the order page: the buyer, the shop, an admin; a stranger gets nothing", async () => {
    for (const who of [buyer, owner, admin, stranger]) {
      for (const id of [confirmed, completed]) {
        const o = await same(runTableQuery(db, me(who), detailSql(id)).then(single), runIsolated(db, (ctx) => orders(ctx).orderDetail(me(who), id)));
        if (who === stranger) expect(o.result).toBeNull();
      }
    }
  });

  const listSql = (who: string, f: OrderListFilter) => {
    const where = [
      f.side === "buyer" ? sql`o.buyer_id = ${who}` : f.side === "vendor" ? sql`o.vendor_id = ${f.vendorId}` : sql`(o.buyer_id = ${who} or o.vendor_id = ${f.vendorId})`,
      ...(f.statuses ? [sql`o.status::text in (${sql.join(f.statuses.map((s) => sql`${s}`), sql`, `)})`] : []),
      ...(f.payoutStatus ? [sql`o.payout_status = ${f.payoutStatus}`, sql`o.payout_released_at is not null`] : []),
      ...(f.escalated ? [sql`o.payment_escalated_at is not null`] : []),
      ...(f.createdFrom ? [sql`o.created_at >= ${f.createdFrom}::timestamptz`] : []),
    ];
    const order = f.orderBy === "payout_released_at" ? sql`o.payout_released_at desc` : f.orderBy === "payment_escalated_at" ? sql`o.payment_escalated_at asc` : sql`o.created_at desc`;
    return sql`select o.*, (select json_build_object('name', u.name) from public.users u where u.id = o.buyer_id) as buyer,
        (select json_build_object('id', v.id, 'business_name', v.business_name, 'city', v.city, 'logo_url', v.logo_url) from public.vendors v where v.id = o.vendor_id) as vendor,
        coalesce((select json_agg(to_jsonb(oi) || jsonb_build_object('product', (select json_build_object('id', p.id, 'is_service', p.is_service, 'name', p.name, 'photos', p.photos)
          from public.products p where p.id = oi.product_id))) from public.order_items oi where oi.order_id = o.id), '[]'::json) as items,
        coalesce((select json_agg(to_json(p)) from public.payments p where p.order_id = o.id), '[]'::json) as payments
      from public.orders o where ${sql.join(where, sql` and `)} order by ${order} limit ${f.limit}`;
  };
  const base: OrderListFilter = { side: "buyer", vendorId: null, statuses: null, payoutStatus: null, escalated: false, createdFrom: null, createdTo: null, orderBy: "created_at", limit: 1000 };
  const lists: [string, () => string, () => OrderListFilter][] = [
    ["the buyer's purchases", () => buyer, () => base],
    ["the shop's sales", () => owner, () => ({ ...base, side: "vendor", vendorId: shop })],
    ["a stranger asking for the shop's sales", () => stranger, () => ({ ...base, side: "vendor", vendorId: shop })],
    ["open purchases", () => buyer, () => ({ ...base, statuses: ["pending", "confirmed", "payment_unresolved"] })],
    ["earnings (payouts released)", () => owner, () => ({ ...base, side: "vendor", vendorId: shop, payoutStatus: "released", orderBy: "payout_released_at" })],
    ["escalated, confirmed", () => buyer, () => ({ ...base, statuses: ["confirmed"], escalated: true, orderBy: "payment_escalated_at", limit: 10 })],
    ["the live-update check (either side, newest 150)", () => owner, () => ({ ...base, side: "either", vendorId: shop, limit: 150 })],
    ["since a day ago", () => buyer, () => ({ ...base, createdFrom: new Date(Date.now() - 86_400_000).toISOString() })],
  ];
  for (const [label, who, filter] of lists) {
    it(`order list: ${label}`, () => same(runTableQuery(db, me(who()), listSql(who(), filter())), runIsolated(db, (ctx) => orders(ctx).orderList(me(who()), filter()))));
  }

  it("counts and 'have they done business'", async () => {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    for (const [who, vendorId] of [
      [buyer, null],
      [owner, shop],
      [stranger, shop],
    ] as const) {
      const o = await same(
        runTableQuery(
          db,
          me(who),
          sql`select (select count(*)::int from public.orders where buyer_id = ${who} and status::text in ('pending','confirmed','payment_unresolved')) as buyer_open,
                     (select count(*)::int from public.orders where buyer_id = ${who}) as buyer_total,
                     (select coalesce(json_object_agg(s, n), '{}'::json) from (select status::text as s, count(*)::int as n from public.orders where buyer_id = ${who} and status::text in ('pending','confirmed','payment_unresolved') group by status) x) as buyer_by_status,
                     (select count(*)::int from public.orders where vendor_id = ${vendorId}::uuid and status::text in ('pending','confirmed','payment_unresolved')) as vendor_open,
                     (select count(*)::int from public.orders where vendor_id = ${vendorId}::uuid and created_at >= ${since}::timestamptz) as vendor_since`,
        ).then(single),
        runIsolated(db, (ctx) => orders(ctx).orderCounts(me(who), vendorId, since)),
      );
      if (who === owner) expect(o.result).toMatchObject({ vendor_open: 2, vendor_since: 1 });
    }
    for (const who of [buyer, stranger]) {
      await same(
        runTableQuery(db, me(who), sql`select exists (select 1 from public.orders where buyer_id = ${buyer} and vendor_id = ${shop} and status = 'completed') as completed`).then(single),
        runIsolated(db, (ctx) => orders(ctx).completedBetween(me(who), buyer, shop)),
      );
    }
  });

  it("FINDING S10: a buyer or a shop can rewrite an order directly (total, delivery fee, payout), and a buyer can insert an order at any price", async () => {
    const cheaper = await runTableQuery(db, me(buyer), sql`update public.orders set total_amount = 1, delivery_fee = 0 where id = ${pending} returning total_amount`);
    expect(cheaper.result).toEqual([{ total_amount: 1 }]);
    const paidOut = await runTableQuery(db, me(owner), sql`update public.orders set payout_status = 'released', payout_released_at = now() where id = ${confirmed} returning payout_status`);
    expect(paidOut.result).toEqual([{ payout_status: "released" }]);
    const forged = await runTableQuery(
      db,
      me(buyer),
      sql`insert into public.orders (buyer_id, vendor_id, order_type, status, delivery_method, total_amount) values (${buyer}, ${otherShop}, 'sale', 'pending', 'pickup', 1) returning total_amount`,
    );
    expect(forged.result).toEqual([{ total_amount: 1 }]);
    void other;
  });
});
