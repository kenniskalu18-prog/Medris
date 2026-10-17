import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DataContext } from "../../src/database/context.js";
import type { ListingFilter } from "../../src/database/repositories/listings.repository.js";
import { ListingsService } from "../../src/modules/listings/listings.service.js";
import { identityOf, seedOrder, seedProduct, seedSector, seedUser, seedVendor, setRole } from "../support/fixtures.js";
import { comparable, runIsolated, runTableQuery, type CompareOptions, type RunOutcome } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/** The app's direct table queries on products (listings), against the endpoints that replace them. */
describe("parity: table queries - listings", () => {
  let db: TestDatabase;
  let admin: string;
  let buyer: string;
  let owner: string;
  let otherOwner: string;
  let shop: string;
  let pendingShop: string;
  let phone: string;
  let kettle: string;
  let paused: string;
  let monthlyExpired: string;
  let sold: string;
  let category: string;
  let sector: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    admin = (await seedUser(db)).id;
    await setRole(db, admin, "admin");
    buyer = (await seedUser(db)).id;
    owner = (await seedUser(db, { role: "vendor" })).id;
    otherOwner = (await seedUser(db)).id;
    shop = (await seedVendor(db, owner, { name: "Dayo Gadgets" })).id;
    pendingShop = (await seedVendor(db, otherOwner, { name: "New Place", verified: false })).id;
    sector = await seedSector(db, { name: "Electronics" });
    category = (await db.query<{ id: string }>(`insert into public.categories (name, sector_id) values ('Phones', $1) returning id`, [sector]))[0]!.id;
    phone = await seedProduct(db, shop, { name: "Phone X" });
    kettle = await seedProduct(db, shop, { name: "Kettle" });
    paused = await seedProduct(db, shop, { name: "Old lamp", status: "paused" });
    await seedProduct(db, pendingShop, { name: "Hidden phone" });
    await db.query(`update public.products set category_id = $2, view_count = 50, description = 'A great phone' where id = $1`, [phone, category]);
    await db.query(`update public.products set view_count = 10, is_service = false where id = $1`, [kettle]);
    monthlyExpired = await seedProduct(db, shop, { name: "Monthly sofa", status: "paused" });
    await db.query(`update public.products set billing_model = 'monthly', billing_status = 'past_due', billing_paid_until = now() - interval '1 day' where id = $1`, [monthlyExpired]);
    sold = await seedProduct(db, shop, { name: "Sold chair" });
    await seedOrder(db, buyer, shop, { productIds: [sold] });
  }, 60_000);
  afterAll(() => db.close());

  const me = (id: string) => identityOf(id);
  const listings = (ctx: DataContext) => new ListingsService(() => ctx);
  async function same(original: Promise<RunOutcome>, port: Promise<RunOutcome>, options?: CompareOptions) {
    const [o, p] = [await original, await port];
    const { original: a, port: b } = comparable(o, p, options);
    expect(b).toEqual(a);
    return o;
  }
  const single = (o: RunOutcome) => ({ ...o, result: (o.result as unknown[] | undefined)?.[0] ?? null });
  const SHOP = sql`(select json_build_object('id', v.id, 'business_name', v.business_name, 'previous_business_name', v.previous_business_name, 'name_changed_at', v.name_changed_at,
      'city', v.city, 'address', v.address, 'phone', v.phone, 'whatsapp_number', case when v.whatsapp_visible then v.whatsapp_number end, 'whatsapp_visible', v.whatsapp_visible,
      'avg_rating', v.avg_rating, 'review_count', v.review_count, 'verification_status', v.verification_status, 'cac_number', v.cac_number, 'created_at', v.created_at,
      'is_active', v.is_active, 'logo_url', v.logo_url, 'delivery_fee', v.delivery_fee, 'delivery_fee_mode', v.delivery_fee_mode, 'delivery_fee_per_km', v.delivery_fee_per_km,
      'lat', v.lat, 'lng', v.lng, 'business_hours', v.business_hours, 'allow_after_hours_messages', v.allow_after_hours_messages, 'sector_id', v.sector_id,
      'campus_id', v.campus_id, 'operating_scope', v.operating_scope, 'operating_campuses', v.operating_campuses, 'student_verified', v.student_verified)
    from public.vendors v where v.id = p.vendor_id)`;
  const CAT = sql`(select json_build_object('id', c.id, 'name', c.name, 'sector_id', c.sector_id) from public.categories c where c.id = p.category_id)`;
  const LIVE = sql`p.status = 'active' and exists (select 1 from public.vendors v where v.id = p.vendor_id and v.verification_status = 'verified' and v.is_active = true and v.deleted_at is null)`;
  const card = sql`to_jsonb(p) - 'billing_reference' - 'admin_deleted_by' || jsonb_build_object('vendor', ${SHOP}, 'category', ${CAT})`;
  const rows = (o: RunOutcome) => ({ ...o, result: ((o.result as { r: unknown }[] | undefined) ?? []).map((x) => x.r) });

  describe("the marketplace", () => {
    const base: ListingFilter = { ids: null, vendorId: null, categoryIds: null, sectorId: null, isService: null, listingTypes: null, q: null, qAny: null, inStock: false, orderBy: "none", view: "card", withVariants: false, limit: 1000, offset: 0 };
    // (built when each test runs: the ids exist only after beforeAll)
    const cases: [string, () => [ListingFilter, ReturnType<typeof sql>]][] = [
      ["most viewed", () => [{ ...base, orderBy: "views" }, sql`order by p.view_count desc, p.id`]],
      ["a category", () => [{ ...base, categoryIds: [category] }, sql`and p.category_id = ${category}`]],
      ["a sector", () => [{ ...base, sectorId: sector }, sql`and exists (select 1 from public.categories c where c.id = p.category_id and c.sector_id = ${sector})`]],
      ["by name", () => [{ ...base, q: "phone" }, sql`and p.name ilike '%phone%'`]],
      ["name or description", () => [{ ...base, qAny: "great" }, sql`and (p.name ilike '%great%' or p.description ilike '%great%')`]],
      ["some ids", () => [{ ...base, ids: [phone, paused] }, sql`and p.id in (${phone}, ${paused})`]],
      ["newest five", () => [{ ...base, orderBy: "newest", limit: 5 }, sql`order by p.created_at desc limit 5`]],
    ];
    for (const [label, make] of cases) {
      it(label, async () => {
        const [filter, tail] = make();
        for (const who of [null, buyer]) {
          await same(
            runTableQuery(db, who ? me(who) : null, sql`select ${card} as r from public.products p where ${LIVE} ${tail}`).then(rows),
            runIsolated(db, (ctx) => listings(ctx).feed(who ? me(who) : null, filter)),
          );
        }
      });
    }
    it("the light index rows", async () => {
      const o = await runIsolated(db, (ctx) => listings(ctx).feed(null, { ...base, view: "index" }));
      expect((o.result as { id: string }[]).map((r) => r.id).sort()).toEqual([kettle, phone, sold].sort());
    });
  });

  it("one listing: anyone sees an active one; the owner sees every column of a paused one", async () => {
    for (const [who, id] of [
      [null, phone],
      [buyer, paused],
      [owner, paused],
    ] as const) {
      const ownerView = who === owner;
      await same(
        runTableQuery(
          db,
          who ? me(who) : null,
          sql`select ${ownerView ? sql`to_jsonb(p)` : sql`to_jsonb(p) - 'billing_reference' - 'admin_deleted_by'`} || jsonb_build_object('vendor', ${SHOP}, 'category', ${CAT}) as r from public.products p where p.id = ${id}`,
        )
          .then(rows)
          .then(single),
        runIsolated(db, (ctx) => listings(ctx).detail(who ? me(who) : null, id)),
      );
    }
  });

  describe("the owner's listings", () => {
    it("the list and one listing", async () => {
      await same(
        runTableQuery(
          db,
          me(owner),
          sql`select to_jsonb(p) || jsonb_build_object('category', (select json_build_object('name', c.name) from public.categories c where c.id = p.category_id)) as r
              from public.products p where p.vendor_id = ${shop} order by p.created_at desc`,
        ).then(rows),
        runIsolated(db, (ctx) => listings(ctx).myListings(me(owner), { includeRemoved: true, activeOnly: false, q: null })),
      );
      await same(runTableQuery(db, me(owner), sql`select p.* from public.products p where p.id = ${kettle} and p.vendor_id = ${shop}`).then(single), runIsolated(db, (ctx) => listings(ctx).myListing(me(owner), kettle)));
    });
    it("add a commission listing (live) and a monthly one (paused until paid)", async () => {
      const fields = { name: "Blender", description: null, sale_price: 15000, quantity_total: 3, listing_type: "sale", condition: "new", photos: ["https://cdn.test/b.jpg"] };
      const live = await same(
        runTableQuery(
          db,
          me(owner),
          sql`insert into public.products (vendor_id, name, description, listing_type, condition, sale_price, quantity_total, quantity_available, photos, billing_model, billing_status, billing_paid_until, billing_reference, status)
              values (${shop}, 'Blender', null, 'sale', 'new', 15000, 3, 3, '{https://cdn.test/b.jpg}', 'commission', 'active', null, null, 'active') returning *`,
        ).then(single),
        runIsolated(db, (ctx) => listings(ctx).create(me(owner), fields, "commission", null)),
      );
      expect(live.result).toMatchObject({ status: "active" });
      const monthly = await runIsolated(db, (ctx) => listings(ctx).create(me(owner), fields, "monthly", "ref_123"));
      expect(monthly.result).toMatchObject({ status: "paused", billing_status: "pending_payment", billing_paid_until: null, billing_reference: "ref_123" });
      expect((await runIsolated(db, (ctx) => listings(ctx).create(me(buyer), fields, "commission", null))).error?.message).toBe("You do not have a shop.");
    });
    it("change, pause, discard, reactivate", async () => {
      await same(
        runTableQuery(db, me(owner), sql`update public.products set name = 'Kettle 2L', sale_price = 9000, quantity_available = 4 where id = ${kettle} and vendor_id = ${shop} returning *`).then(single),
        runIsolated(db, (ctx) => listings(ctx).update(me(owner), kettle, { name: "Kettle 2L", sale_price: 9000, quantity_available: 4 })),
      );
      for (const [status, cancel, q] of [
        ["paused", false, sql`status = 'paused'`],
        ["removed", true, sql`status = 'removed', billing_status = 'cancelled'`],
        ["active", false, sql`status = 'active'`],
      ] as const) {
        await same(
          runTableQuery(db, me(owner), sql`update public.products set ${q} where id = ${paused} and vendor_id = ${shop}`, false),
          runIsolated(db, (ctx) => listings(ctx).setStatus(me(owner), paused, status, cancel).then(() => null)),
        );
      }
    });
    it("delete: a listing without orders goes; one with orders is refused by both", async () => {
      await same(runTableQuery(db, me(owner), sql`delete from public.products where id = ${kettle} and vendor_id = ${shop}`, false), runIsolated(db, (ctx) => listings(ctx).remove(me(owner), kettle).then(() => null)));
      const o = await runTableQuery(db, me(owner), sql`delete from public.products where id = ${sold} and vendor_id = ${shop}`, false);
      const p = await runIsolated(db, (ctx) => listings(ctx).remove(me(owner), sold));
      expect(o.error).toBeDefined();
      expect(p.error?.message).toBe(o.error?.message);
    });
    it("FIX S13: a monthly listing whose paid period ended cannot go live again (the table let the shop switch it on, or create one already active)", async () => {
      const forged = await runTableQuery(db, me(owner), sql`update public.products set status = 'active', billing_status = 'active', billing_paid_until = now() + interval '10 years' where id = ${monthlyExpired} returning status`);
      expect(forged.result).toEqual([{ status: "active" }]);
      const inserted = await runTableQuery(
        db,
        me(owner),
        sql`insert into public.products (vendor_id, name, listing_type, sale_price, quantity_total, quantity_available, billing_model, billing_status, status) values (${shop}, 'Free ride', 'sale', 1000, 1, 1, 'monthly', 'active', 'active') returning status`,
      );
      expect(inserted.result).toEqual([{ status: "active" }]);
      const port = await runIsolated(db, (ctx) => listings(ctx).setStatus(me(owner), monthlyExpired, "active", false));
      expect(port.error?.message).toBe("This monthly listing needs its fee paid before it can go live again.");
      expect(port.changes.products!.updated).toEqual([]);
    });
  });
});
