import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DataContext } from "../../src/database/context.js";
import { ListingsService } from "../../src/modules/listings/listings.service.js";
import { identityOf, seedPackage, seedProduct, seedUser, seedVendor } from "../support/fixtures.js";
import { comparable, runIsolated, runTableQuery, type CompareOptions, type RunOutcome } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/** The app's direct table queries on vendor_packages and package_items, against the endpoints that replace them. */
describe("parity: table queries - packages", () => {
  let db: TestDatabase;
  let buyer: string;
  let owner: string;
  let rivalOwner: string;
  let shop: string;
  let rivalShop: string;
  let phone: string;
  let case_: string;
  let rivalProduct: string;
  let pkg: string;
  let pausedPkg: string;
  let monthlyPkg: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    buyer = (await seedUser(db)).id;
    owner = (await seedUser(db, { role: "vendor" })).id;
    rivalOwner = (await seedUser(db, { role: "vendor" })).id;
    shop = (await seedVendor(db, owner, { name: "Dayo Gadgets" })).id;
    rivalShop = (await seedVendor(db, rivalOwner, { name: "Rival" })).id;
    phone = await seedProduct(db, shop, { name: "Phone" });
    case_ = await seedProduct(db, shop, { name: "Case" });
    rivalProduct = await seedProduct(db, rivalShop, { name: "Rival charger" });
    pkg = await seedPackage(db, shop, { name: "Starter pack", price: 30000 });
    pausedPkg = await seedPackage(db, shop, { name: "Old pack", status: "paused" });
    monthlyPkg = await seedPackage(db, shop, { name: "Monthly pack", status: "paused" });
    await db.query(`update public.vendor_packages set billing_model = 'monthly', billing_status = 'past_due', billing_paid_until = now() - interval '1 day' where id = $1`, [monthlyPkg]);
    await db.query(`insert into public.package_items (package_id, product_id, quantity) values ($1, $2, 1), ($1, $3, 2)`, [pkg, phone, case_]);
  }, 60_000);
  afterAll(() => db.close());

  const me = (id: string) => identityOf(id);
  const svc = (ctx: DataContext) => new ListingsService(() => ctx);
  async function same(original: Promise<RunOutcome>, port: Promise<RunOutcome>, options?: CompareOptions) {
    const [o, p] = [await original, await port];
    const { original: a, port: b } = comparable(o, p, options);
    expect(b).toEqual(a);
    return o;
  }

  it("the marketplace: live packages with items; one package; the owner's list", async () => {
    const all = await runIsolated(db, (ctx) => svc(ctx).packageFeed(null, { ids: null, vendorId: null, qAny: null, qItems: null, orderBy: "newest", view: "card", limit: 500 }));
    expect((all.result as { id: string; items: unknown[] }[]).map((p) => [p.id, p.items.length])).toEqual([[pkg, 2]]);
    const one = await runIsolated(db, (ctx) => svc(ctx).packageDetail(null, pausedPkg));
    expect(one.result).toBeNull();
    const ownerView = await runIsolated(db, (ctx) => svc(ctx).packageDetail(me(owner), pausedPkg));
    expect(ownerView.result).toMatchObject({ id: pausedPkg, status: "paused" });
    const mine = await runIsolated(db, (ctx) => svc(ctx).myPackages(me(owner)));
    expect((mine.result as unknown[]).length).toBe(3);
    const search = await runIsolated(db, (ctx) => svc(ctx).packageFeed(null, { ids: null, vendorId: null, qAny: "starter", qItems: null, orderBy: "none", view: "index", limit: 10 }));
    expect(search.result).toEqual([{ id: pkg, vendor_id: shop, name: "Starter pack", description: null, price: 30000 }]);
    const byItem = await runIsolated(db, (ctx) => svc(ctx).packageFeed(null, { ids: null, vendorId: null, qAny: null, qItems: "case", orderBy: "none", view: "index", limit: 10 }));
    expect((byItem.result as { id: string }[]).map((p) => p.id)).toEqual([pkg]);
  });

  it("add a package with items (commission: live); update it and replace items", async () => {
    const created = await runIsolated(db, async (ctx) => {
      const row = await svc(ctx).createPackage(me(owner), { name: "Combo", price: 20000, photos: [] }, [{ product_id: phone, quantity: 1 }], "commission");
      return svc(ctx).packageDetail(me(owner), String(row.id));
    });
    expect(created.result).toMatchObject({ name: "Combo", status: "active", billing_status: "active", items: [{ product_id: phone, quantity: 1 }] });
    await same(
      runIsolated(db, (ctx) =>
        ctx.asCaller(me(owner), async (tx) => {
          await tx.execute(sql`update public.vendor_packages set name = 'Starter pack 2', price = 25000 where id = ${pkg}`);
          await tx.execute(sql`delete from public.package_items where package_id = ${pkg}`);
          await tx.execute(sql`insert into public.package_items (package_id, product_id, quantity) values (${pkg}, ${case_}, 3)`);
          return null;
        }),
      ),
      runIsolated(db, (ctx) => svc(ctx).updatePackage(me(owner), pkg, { name: "Starter pack 2", price: 25000 }, [{ product_id: case_, quantity: 3 }]).then(() => null)),
    );
  });

  it("FINDING: the table lets a package bundle another shop's product; the endpoint refuses", async () => {
    const forged = await runTableQuery(db, me(owner), sql`insert into public.package_items (package_id, product_id, quantity) values (${pkg}, ${rivalProduct}, 1) returning product_id`);
    expect(forged.result).toEqual([{ product_id: rivalProduct }]);
    const port = await runIsolated(db, (ctx) => svc(ctx).updatePackage(me(owner), pkg, {}, [{ product_id: rivalProduct, quantity: 1 }]));
    expect(port.error?.message).toBe("A package can only contain your own products.");
  });

  it("status: pause and reactivate; a monthly package past its paid period stays off (FIX S13); delete", async () => {
    for (const status of ["paused", "active"] as const) {
      await same(
        runTableQuery(db, me(owner), sql`update public.vendor_packages set status = ${status}::public.product_status where id = ${pausedPkg} and vendor_id = ${shop}`, false),
        runIsolated(db, (ctx) => svc(ctx).setPackageStatus(me(owner), pausedPkg, status).then(() => null)),
      );
    }
    const port = await runIsolated(db, (ctx) => svc(ctx).setPackageStatus(me(owner), monthlyPkg, "active"));
    expect(port.error?.message).toBe("This monthly listing needs its fee paid before it can go live again.");
    await same(
      runTableQuery(db, me(owner), sql`delete from public.vendor_packages where id = ${pausedPkg} and vendor_id = ${shop}`, false),
      runIsolated(db, (ctx) => svc(ctx).removePackage(me(owner), pausedPkg).then(() => null)),
    );
    const notOwner = await runIsolated(db, (ctx) => svc(ctx).removePackage(me(buyer), pkg));
    expect(notOwner.error?.message).toBe("You do not have a shop.");
  });
});
