import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DataContext, Identity } from "../../src/database/context.js";
import { CartRepository } from "../../src/database/repositories/cart.repository.js";
import { CheckoutRepository } from "../../src/database/repositories/checkout.repository.js";
import { CheckoutService, type Delivery } from "../../src/modules/checkout/checkout.service.js";
import { identityOf, seedOrder, seedPackage, seedProduct, seedUser, seedVendor, setRole, uuid } from "../support/fixtures.js";
import { comparable, runIsolated, runOriginal, runOriginalAsService, type CompareOptions, type RunOutcome } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/** CheckoutService (and CartRepository.add) replace the checkout functions; each case runs the original and the port on the same rows. */
describe("parity: checkout", () => {
  let db: TestDatabase;
  let admin: string;
  let buyer: string;
  let noPhone: string;
  let owner: string;
  let shop: string;
  let pausedShop: string;
  const p: Record<string, string> = {};
  let variant: string;
  let pricelessVariant: string;
  let otherVariant: string;
  let pkg: string;
  let brokenPkg: string;
  let bookedItem: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    admin = (await seedUser(db)).id;
    await setRole(db, admin, "admin");
    buyer = (await seedUser(db)).id;
    noPhone = (await seedUser(db, { phone: null })).id;
    owner = (await seedUser(db, { role: "vendor" })).id;
    shop = (await seedVendor(db, owner, { name: "Gadget Hub" })).id;
    pausedShop = (await seedVendor(db, (await seedUser(db, { role: "vendor" })).id)).id;
    await db.query(`update public.vendors set is_active = false where id = $1`, [pausedShop]);
    await db.query(`update public.vendors set lat = 6.5244, lng = 3.3792, delivery_fee = 1500 where id = $1`, [shop]);
    const product = async (name: string, sql = "") => {
      p[name] = await seedProduct(db, shop, { name, price: 10000 });
      await db.query(`update public.products set quantity_total = 10, quantity_available = 3 where id = $1`, [p[name]]);
      if (sql) await db.query(`update public.products set ${sql} where id = $1`, [p[name]]);
    };
    await product("phone", "discount_price = 8500, delivery_fee_mode = 'flat', delivery_fee = 1200");
    await product("fakeDiscount"); // plain product; its variety "Blue" carries a discount above its price
    await product("distance", "delivery_fee_mode = 'distance', delivery_fee_per_km = 250");
    await product("payAfter", "payment_timing = 'pay_after', payment_deposit_percent = 45");
    await product("payAfter30", "payment_timing = 'pay_after', payment_deposit_percent = 30");
    await product("untracked", "track_quantity = false");
    await product("monthlyService", "is_service = true, billing_model = 'monthly', service_price_unit = 'flat'");
    await product("rentWeekly", "listing_type = 'rent', sale_price = null, rental_rate = 3000, rental_rate_unit = 'week', deposit_amount = 5000, quantity_total = 2");
    await product("rentDaily", "listing_type = 'rent', sale_price = null, rental_rate = 800, rental_rate_unit = 'day', payment_timing = 'pay_after', quantity_total = 2");
    await product("paused", "status = 'paused'");
    p.elsewhere = await seedProduct(db, pausedShop);
    // Varieties are seeded in "save varieties" mode (BASELINE_FINDINGS C4).
    variant = uuid();
    pricelessVariant = uuid();
    otherVariant = uuid();
    await db.query(`do $$ begin
      perform set_config('levromart.batch_variant_save', '1', true);
      insert into public.product_variants (id, product_id, name, sale_price, discount_price, quantity_available) values
        ('${variant}', '${p.phone}', '128GB', 11000, 9999.99, 2),
        ('${pricelessVariant}', '${p.phone}', 'Display unit', null, null, 1),
        ('${otherVariant}', '${p.fakeDiscount}', 'Blue', 10000, 12000, 5);
    end $$`);
    const booked = await seedOrder(db, buyer, shop, { productIds: [p.rentWeekly!] });
    await db.query(
      `insert into public.bookings (product_id, order_item_id, date_range, quantity)
       select $1, id, daterange('2026-11-03', '2026-11-05', '[]'), 1 from public.order_items where order_id = $2`,
      [p.rentWeekly, booked],
    );
    bookedItem = (await db.query<{ id: string }>(`select id from public.order_items where order_id = $1`, [booked]))[0]!.id;
    pkg = await seedPackage(db, shop, { price: 25000 });
    await db.query(`insert into public.package_items (package_id, product_id, quantity) values ($1, $2, 2), ($1, $3, 1)`, [pkg, p.phone, p.untracked]);
    brokenPkg = await seedPackage(db, shop);
    await db.query(`insert into public.package_items (package_id, product_id, quantity) values ($1, $2, 1)`, [brokenPkg, p.paused]);
    await db.query(`insert into public.cart_items (buyer_id, product_id, quantity) values ($1, $2, 2)`, [buyer, p.phone]);
  }, 60_000);
  afterAll(() => db.close());

  const checkout = (ctx: DataContext) => new CheckoutService(() => ctx);
  const me = (id: string | null): Identity | null => (id ? identityOf(id) : null);
  async function same(original: Promise<RunOutcome>, port: Promise<RunOutcome>, options?: CompareOptions) {
    const { original: a, port: b } = comparable(await original, await port, options);
    expect(b).toEqual(a);
    return a;
  }
  const pickup: Delivery = { method: "pickup", address: null, phone: null };
  const home: Delivery = { method: "delivery", address: "5 Admiralty Way, Lekki", phone: "08030000000", lat: 6.4474, lng: 3.4723 };
  const id = <T extends { id: string }>(x: Promise<T>) => x.then((r) => r.id);

  describe("create_sale_order", () => {
    const cases: [string, () => string | null, () => string, number, Delivery, () => string | null, string | null][] = [
      ["a discounted product, picked up", () => buyer, () => p.phone!, 2, pickup, () => null, "  Please call first  "],
      ["a variety's own price, delivered (flat fee)", () => buyer, () => p.phone!, 1, home, () => variant, null],
      ["a variety's discount above its price is ignored", () => buyer, () => p.fakeDiscount!, 1, pickup, () => otherVariant, null],
      ["more than the stock: stock stops at zero", () => buyer, () => p.phone!, 5, pickup, () => null, null],
      ["a distance fee, by kilometre", () => buyer, () => p.distance!, 1, home, () => null, null],
      ["a distance fee needs the buyer's location", () => buyer, () => p.distance!, 1, { ...home, lat: null }, () => null, null],
      ["pay after delivery: the product's deposit percentage", () => buyer, () => p.payAfter!, 1, home, () => null, null],
      ["untracked stock is not touched", () => buyer, () => p.untracked!, 1, pickup, () => null, null],
      ["a monthly-billed service is commission-exempt", () => buyer, () => p.monthlyService!, 1, pickup, () => null, null],
      ["a variety of another product", () => buyer, () => p.phone!, 1, pickup, () => otherVariant, null],
      ["a variety without a price", () => buyer, () => p.phone!, 1, pickup, () => pricelessVariant, null],
      ["an unknown variety", () => buyer, () => p.phone!, 1, pickup, () => uuid(), null],
      ["a paused product", () => buyer, () => p.paused!, 1, pickup, () => null, null],
      ["a rental-only product", () => buyer, () => p.rentWeekly!, 1, pickup, () => null, null],
      ["zero quantity", () => buyer, () => p.phone!, 0, pickup, () => null, null],
      ["one's own shop", () => owner, () => p.phone!, 1, pickup, () => null, null],
      ["admins", () => admin, () => p.phone!, 1, pickup, () => null, null],
      ["a buyer without a phone number", () => noPhone, () => p.phone!, 1, pickup, () => null, null],
      ["an unknown delivery method", () => buyer, () => p.phone!, 1, { ...pickup, method: "drone" }, () => null, null],
      ["signed out", () => null, () => p.phone!, 1, pickup, () => null, null],
    ];
    for (const [label, who, product, quantity, delivery, variety, note] of cases) {
      it(label, () =>
        same(
          runOriginal(db, me(who()), "create_sale_order", {
            p_vendor_id: shop,
            p_product_id: product(),
            p_quantity: quantity,
            p_delivery_method: delivery.method,
            p_delivery_address: delivery.address,
            p_delivery_phone: delivery.phone,
            p_buyer_lat: delivery.lat ?? null,
            p_buyer_lng: delivery.lng ?? null,
            p_buyer_note: note,
            p_variant_id: variety(),
          }),
          runIsolated(db, (ctx) =>
            id(checkout(ctx).sale(me(who()), { vendorId: shop, productId: product(), quantity, delivery, buyerNote: note, variantId: variety() })),
          ),
        ),
      );
    }
    it("a paused shop", () =>
      same(
        runOriginal(db, me(buyer), "create_sale_order", {
          p_vendor_id: pausedShop,
          p_product_id: p.elsewhere,
          p_quantity: 1,
          p_delivery_method: "pickup",
          p_delivery_address: null,
          p_delivery_phone: null,
          p_buyer_lat: null,
          p_buyer_lng: null,
          p_buyer_note: null,
          p_variant_id: null,
        }),
        runIsolated(db, (ctx) => id(checkout(ctx).sale(me(buyer), { vendorId: pausedShop, productId: p.elsewhere!, quantity: 1, delivery: pickup }))),
      ));
  });

  describe("create_rental_booking (directly)", () => {
    const cases: [string, () => string, number, string, string][] = [
      ["free dates", () => p.rentWeekly!, 1, "2026-12-01", "2026-12-03"],
      ["the last free unit on overlapping dates", () => p.rentWeekly!, 1, "2026-11-05", "2026-11-07"],
      ["more than is free", () => p.rentWeekly!, 2, "2026-11-04", "2026-11-06"],
      ["the end before the start", () => p.rentWeekly!, 1, "2026-11-05", "2026-11-01"],
      ["zero quantity", () => p.rentWeekly!, 0, "2026-11-01", "2026-11-02"],
      ["a product without a stock count", () => p.untracked!, 1, "2026-11-01", "2026-11-02"],
      ["an unknown product", () => "00000000-0000-4000-8000-000000000001", 1, "2026-11-01", "2026-11-02"],
    ];
    for (const [label, product, quantity, start, end] of cases) {
      it(label, () =>
        same(
          runOriginalAsService(db, "create_rental_booking", { p_order_item_id: bookedItem, p_product_id: product(), p_start_date: start, p_end_date: end, p_quantity: quantity }),
          runIsolated(db, (ctx) => ctx.asService((tx) => new CheckoutRepository(tx).book(bookedItem, product(), start, end, quantity))),
          { result: () => null },
        ),
      );
    }
  });

  describe("create_rental_order (and create_rental_booking)", () => {
    const cases: [string, () => string | null, () => string, number, string, string, Delivery][] = [
      ["by the week: 9 days are 2 weeks, deposit per unit", () => buyer, () => p.rentWeekly!, 1, "2026-11-10", "2026-11-18", pickup],
      ["by the day, delivered, paid after", () => buyer, () => p.rentDaily!, 2, "2026-11-01", "2026-11-03", home],
      ["more than is free on those dates", () => buyer, () => p.rentWeekly!, 2, "2026-11-04", "2026-11-06", pickup],
      ["the end before the start", () => buyer, () => p.rentDaily!, 1, "2026-11-05", "2026-11-01", pickup],
      ["not for rent", () => buyer, () => p.phone!, 1, "2026-11-01", "2026-11-02", pickup],
      ["one's own shop", () => owner, () => p.rentDaily!, 1, "2026-11-01", "2026-11-02", pickup],
      ["zero quantity", () => buyer, () => p.rentDaily!, 0, "2026-11-01", "2026-11-02", pickup],
      ["signed out", () => null, () => p.rentDaily!, 1, "2026-11-01", "2026-11-02", pickup],
    ];
    for (const [label, who, product, quantity, start, end, delivery] of cases) {
      it(label, () =>
        same(
          runOriginal(db, me(who()), "create_rental_order", {
            p_vendor_id: shop,
            p_product_id: product(),
            p_quantity: quantity,
            p_start_date: start,
            p_end_date: end,
            p_delivery_method: delivery.method,
            p_delivery_address: delivery.address,
            p_delivery_phone: delivery.phone,
            p_buyer_lat: delivery.lat ?? null,
            p_buyer_lng: delivery.lng ?? null,
          }),
          runIsolated(db, (ctx) =>
            id(checkout(ctx).rental(me(who()), { vendorId: shop, productId: product(), quantity, startDate: start, endDate: end, delivery })),
          ),
        ),
      );
    }
  });

  describe("create_cart_order", () => {
    const line = (product: string, quantity: unknown, variantId: string | null = null) => ({ product_id: product, variant_id: variantId ?? "", quantity });
    const cases: [string, () => string | null, () => unknown[], Delivery, string | null][] = [
      ["several lines, picked up", () => buyer, () => [line(p.phone!, 2), line(p.fakeDiscount!, 1, otherVariant), line(p.untracked!, 4)], pickup, " Gift wrap "],
      ["delivered: a fee per line", () => buyer, () => [line(p.phone!, 1), line(p.distance!, 1)], home, null],
      ["delivered, all paid after with one deposit", () => buyer, () => [line(p.payAfter30!, 1), line(p.payAfter30!, 2)], home, null],
      ["delivered, mixed payment plans", () => buyer, () => [line(p.phone!, 1), line(p.payAfter30!, 1)], home, null],
      ["delivered, different deposits", () => buyer, () => [line(p.payAfter!, 1), line(p.payAfter30!, 1)], home, null],
      ["mixed plans are fine when picked up", () => buyer, () => [line(p.phone!, 1), line(p.payAfter30!, 1)], pickup, null],
      ["an unavailable line", () => buyer, () => [line(p.phone!, 1), line(p.paused!, 1)], pickup, null],
      ["a bad quantity", () => buyer, () => [line(p.phone!, 0)], pickup, null],
      ["a malformed quantity", () => buyer, () => [line(p.phone!, "lots")], pickup, null],
      ["a variety of another product", () => buyer, () => [line(p.phone!, 1, otherVariant)], pickup, null],
      ["an empty cart", () => buyer, () => [], pickup, null],
      ["one's own shop", () => owner, () => [line(p.phone!, 1)], pickup, null],
      ["signed out", () => null, () => [line(p.phone!, 1)], pickup, null],
    ];
    for (const [label, who, items, delivery, note] of cases) {
      it(label, () =>
        same(
          runOriginal(db, me(who()), "create_cart_order", {
            p_vendor_id: shop,
            p_items: items(),
            p_delivery_method: delivery.method,
            p_delivery_address: delivery.address,
            p_delivery_phone: delivery.phone,
            p_buyer_lat: delivery.lat ?? null,
            p_buyer_lng: delivery.lng ?? null,
            p_buyer_note: note,
          }),
          runIsolated(db, (ctx) => id(checkout(ctx).cart(me(who()), { vendorId: shop, items: items(), delivery, buyerNote: note }))),
        ),
      );
    }
  });

  describe("create_package_order", () => {
    const cases: [string, () => string | null, () => string, Delivery][] = [
      ["picked up", () => buyer, () => pkg, pickup],
      ["delivered: the shop's delivery fee", () => buyer, () => pkg, home],
      ["an item no longer available", () => buyer, () => brokenPkg, pickup],
      ["an unknown package", () => buyer, () => uuid(), pickup],
      ["admins", () => admin, () => pkg, pickup],
      ["signed out", () => null, () => pkg, pickup],
    ];
    for (const [label, who, pack, delivery] of cases) {
      it(label, () =>
        same(
          runOriginal(db, me(who()), "create_package_order", {
            p_package_id: pack(),
            p_delivery_method: delivery.method,
            p_delivery_address: delivery.address,
            p_delivery_phone: delivery.phone,
          }),
          runIsolated(db, (ctx) => id(checkout(ctx).package(me(who()), { packageId: pack(), delivery }))),
        ),
      );
    }
  });

  describe("add_to_cart", () => {
    const add = (ctx: DataContext, who: string, product: string, quantity: number | null, variantId: string | null) =>
      ctx.onBehalfOf(identityOf(who), (tx) => new CartRepository(tx).add(who, product, quantity, variantId));
    const cases: [string, () => string, () => string, number | null, () => string | null][] = [
      ["merges with the same line", () => buyer, () => p.phone!, 3, () => null],
      ["a variety is its own line", () => buyer, () => p.phone!, 1, () => variant],
      ["a quantity below 1 counts as 1", () => buyer, () => p.fakeDiscount!, 0, () => null],
      ["a variety of another product", () => buyer, () => p.phone!, 1, () => otherVariant],
      ["a rental", () => buyer, () => p.rentWeekly!, 1, () => null],
      ["a service", () => buyer, () => p.monthlyService!, 1, () => null],
      ["a paused product", () => buyer, () => p.paused!, 1, () => null],
      ["one's own shop", () => owner, () => p.phone!, 1, () => null],
      ["admins", () => admin, () => p.phone!, 1, () => null],
    ];
    for (const [label, who, product, quantity, variety] of cases) {
      it(label, () =>
        same(
          runOriginal(db, me(who()), "add_to_cart", { p_product_id: product(), p_quantity: quantity, p_variant_id: variety() }),
          runIsolated(db, (ctx) => add(ctx, who(), product(), quantity, variety())),
        ),
      );
    }
  });

  describe("compute_product_delivery_fee", () => {
    const fee = (product: () => string, lat: number | null, lng: number | null) =>
      same(
        runOriginalAsService(db, "compute_product_delivery_fee", { p_product_id: product(), p_buyer_lat: lat, p_buyer_lng: lng }),
        runIsolated(db, (ctx) => ctx.asService((tx) => new CheckoutRepository(tx).deliveryFee(product(), lat, lng)).then(Number)),
      );
    it("flat", () => fee(() => p.phone!, null, null));
    it("free by default", () => fee(() => p.fakeDiscount!, null, null));
    it("by distance", () => fee(() => p.distance!, 6.6018, 3.3515));
    it("at least one kilometre", () => fee(() => p.distance!, 6.5245, 3.3792));
    it("by distance needs a location", () => fee(() => p.distance!, null, 3.3));
    it("an unknown product", () => fee(() => uuid(), 6.5, 3.4));
  });
});
