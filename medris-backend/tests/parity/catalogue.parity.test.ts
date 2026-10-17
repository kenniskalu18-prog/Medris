import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DataContext, Identity } from "../../src/database/context.js";
import { CatalogueService } from "../../src/modules/catalogue/catalogue.service.js";
import { ProductsService } from "../../src/modules/products/products.service.js";
import { identityOf, seedOrder, seedProduct, seedSector, seedUser, seedVendor, setRole, uuid } from "../support/fixtures.js";
import { bothRefused, comparable, runIsolated, runOriginal, type CompareOptions, type RunOutcome } from "../support/parity.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/** CatalogueService and ProductsService replace the catalogue, search and product functions; each case runs the original and the port on the same rows. */
describe("parity: catalogue, search and products", () => {
  let db: TestDatabase;
  let admin: string;
  let owner: string;
  let stranger: string;
  let pendingOwner: string;
  let buyer: string;
  let shop: string;
  let otherShop: string;
  let sector: string;
  let group: string;
  let subcategory: string;
  let dress: string;
  let shoes: string;
  let ordered: string;
  let variantA: string;
  let variantB: string;
  let service: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    admin = (await seedUser(db)).id;
    await setRole(db, admin, "admin");
    owner = (await seedUser(db, { role: "vendor" })).id;
    stranger = (await seedUser(db)).id;
    pendingOwner = (await seedUser(db)).id;
    buyer = (await seedUser(db)).id;
    await db.query(`update public.users set city = 'Lagos' where id = $1`, [buyer]);
    shop = (await seedVendor(db, owner, { name: "Ada Fashion House" })).id;
    otherShop = (await seedVendor(db, (await seedUser(db, { role: "vendor" })).id, { name: "Kano Grains" })).id;
    await seedVendor(db, pendingOwner, { verified: false });

    sector = await seedSector(db, { name: "Fashion" });
    group = uuid();
    subcategory = uuid();
    await db.query(`insert into public.categories (id, name, sector_id) values ($1, 'Clothing', $2)`, [group, sector]);
    await db.query(`insert into public.categories (id, name, sector_id, parent_category_id) values ($1, 'Dresses', $2, $3)`, [subcategory, sector, group]);

    dress = await seedProduct(db, shop, { name: "Red Ankara Dress" });
    shoes = await seedProduct(db, shop, { name: "Leather Sandals" });
    ordered = await seedProduct(db, otherShop, { name: "Ofada Rice 50kg" });
    await seedProduct(db, otherShop, { name: "Brown Beans", status: "paused" });
    await db.query(`update public.products set category_id = $1, description = 'Hand-sewn party gown' where id = $2`, [subcategory, dress]);
    await db.query(`insert into public.search_synonyms (term, synonym) values ('gown', 'dress'), ('slippers', 'sandals')`);

    variantA = uuid();
    variantB = uuid();
    // Outside save_product_variants' batch mode the variety trigger fails (BASELINE_FINDINGS C4), so seed in it.
    await db.query(`do $$ begin
      perform set_config('levromart.batch_variant_save', '1', true);
      insert into public.product_variants (id, product_id, name, sale_price, sort_order, quantity_available)
      values ('${variantA}', '${dress}', 'Small', 9000, 1, 4), ('${variantB}', '${dress}', 'Large', 9500, 2, 1);
    end $$`);

    await seedOrder(db, buyer, otherShop, { status: "completed", productIds: [ordered] });
    await seedOrder(db, buyer, otherShop, { status: "pending", productIds: [ordered] });
    await seedOrder(db, buyer, otherShop, { status: "cancelled", productIds: [ordered] });

    service = await seedProduct(db, shop, { name: "Tailoring" });
    for (const [price, status] of [[15000, "completed"], [22000, "completed"], [99000, "pending"]] as const) {
      await db.query(
        `insert into public.service_offers (listing_id, buyer_id, vendor_id, description, current_price, current_offer_by, status) values ($1, $2, $3, 'A gown', $4, 'buyer', $5)`,
        [service, buyer, shop, price, status],
      );
    }
  }, 60_000);
  afterAll(() => db.close());

  const catalogue = (ctx: DataContext) => new CatalogueService(() => ctx);
  const products = (ctx: DataContext) => new ProductsService(() => ctx);
  const me = (id: string | null): Identity | null => (id ? identityOf(id) : null);
  async function same(original: Promise<RunOutcome>, port: Promise<RunOutcome>, options?: CompareOptions) {
    const { original: a, port: b } = comparable(await original, await port, options);
    expect(b).toEqual(a);
    return a;
  }
  const id = <T extends { id: string }>(p: Promise<T>) => p.then((r) => r.id);

  describe("search_products_full_v2 / search_product_ids", () => {
    const queries = ["red dress", "dreses", "gown", "SLIPPERS", "ada fashion", "rice", "clothing", "hand-sewn", "small", "beans", "", "zzzz"];
    for (const q of queries) {
      for (const who of [null, "buyer"] as const) {
        it(`"${q}" (${who ?? "signed out"})`, () =>
          same(
            runOriginal(db, me(who && buyer), "search_products_full_v2", { p_query: q, p_limit: 20 }),
            runIsolated(db, (ctx) => catalogue(ctx).search(me(who && buyer), q, 20)),
          ),
        );
      }
      it(`ids for "${q}"`, () =>
        same(runOriginal(db, null, "search_product_ids", { p_query: q }), runIsolated(db, (ctx) => catalogue(ctx).searchIds(null, q))),
      );
    }
    it("respects the limit", () =>
      same(
        runOriginal(db, null, "search_products_full_v2", { p_query: "a", p_limit: 1 }),
        runIsolated(db, (ctx) => catalogue(ctx).search(null, "a", 1)),
      ));
  });

  describe("create_vendor_sector", () => {
    const cases: [string, () => string | null, string | null][] = [
      ["an existing name is reused (any case, outer spaces)", () => owner, "  fashion "],
      ["a shop that is not approved is refused", () => pendingOwner, "Toys"],
      ["a buyer is refused", () => stranger, "Toys"],
      ["a blank name is refused", () => owner, "   "],
      ["a missing name is refused", () => owner, null],
    ];
    for (const [name, who, sectorName] of cases) {
      it(name, () =>
        same(
          runOriginal(db, me(who()), "create_vendor_sector", { p_name: sectorName }),
          runIsolated(db, (ctx) => id(catalogue(ctx).createSector(me(who()), sectorName))),
        ),
      );
    }
    // FIX (BASELINE_FINDINGS B8): the original never managed to add a sector (no slug); the port does.
    for (const [label, who, sectorName] of [["an approved shop", () => owner, "Home Decor"], ["an admin", () => admin, "Logistics"]] as const) {
      it(`FIX: ${label} adds a new sector (the original always failed)`, async () => {
        const original = await runOriginal(db, me(who()), "create_vendor_sector", { p_name: sectorName });
        expect(original.error?.message).toMatch(/null value in column "slug"/);
        const port = await runIsolated(db, (ctx) => id(catalogue(ctx).createSector(me(who()), ` ${sectorName} `)));
        expect(port.error).toBeUndefined();
        const [row] = port.changes.sectors!.inserted;
        expect(row).toMatchObject({ id: port.result, name: sectorName, sort_order: 999, icon: "fa-shapes" });
        expect(row!.slug).toMatch(/^custom-[0-9a-f]{20}$/);
      });
    }
    it("signed out: refused", async () => {
      const a = await runOriginal(db, null, "create_vendor_sector", { p_name: "Toys" });
      const b = await runIsolated(db, (ctx) => id(catalogue(ctx).createSector(null, "Toys")));
      expect(bothRefused(a, b) || JSON.stringify(comparable(a, b).original) === JSON.stringify(comparable(a, b).port)).toBe(true);
    });
  });

  describe("create_vendor_category", () => {
    const cases: [string, () => string, () => [string | null, string | null, string | null]][] = [
      ["an approved shop adds a category under a group", () => owner, () => ["Wedding gowns", sector, group]],
      ["an existing name in the group is reused", () => owner, () => [" DRESSES", sector, group]],
      ["an admin may add one", () => admin, () => ["Skirts", sector, group]],
      ["a buyer is refused", () => stranger, () => ["Skirts", sector, group]],
      ["an unknown sector is refused", () => owner, () => ["Skirts", uuid(), group]],
      ["a missing sector is refused", () => owner, () => ["Skirts", null, group]],
      ["a group of another sector is refused", () => owner, () => ["Skirts", sector, uuid()]],
      ["a missing group is refused", () => owner, () => ["Skirts", sector, null]],
      ["a blank name is refused", () => owner, () => [" ", sector, group]],
    ];
    for (const [name, who, args] of cases) {
      it(name, () => {
        const [n, s, p] = args();
        return same(
          runOriginal(db, me(who()), "create_vendor_category", { p_name: n, p_sector_id: s, p_parent_category_id: p }),
          runIsolated(db, (ctx) => id(catalogue(ctx).createCategory(me(who()), { name: n, sectorId: s, parentCategoryId: p }))),
        );
      });
    }
  });

  describe("get_or_create_custom_sector", () => {
    const cases: [string, () => string | null, string | null][] = [
      ["a new sector, spaces collapsed", () => pendingOwner, "  Solar   Panels  "],
      ["an existing one is reused", () => stranger, "FASHION"],
      ["admins are refused", () => admin, "Solar"],
      ["blank is refused", () => stranger, "   "],
      ["missing is refused", () => stranger, null],
      ["signed out is refused", () => null, "Solar"],
    ];
    for (const [name, who, sectorName] of cases) {
      it(name, () =>
        same(
          runOriginal(db, me(who()), "get_or_create_custom_sector", { p_name: sectorName }),
          runIsolated(db, (ctx) => id(catalogue(ctx).customSector(me(who()), sectorName))),
        ),
      );
    }
  });

  describe("get_service_price_hint", () => {
    for (const [label, listing] of [["completed bookings only", () => service], ["no bookings", () => dress]] as const) {
      it(label, () =>
        same(runOriginal(db, null, "get_service_price_hint", { p_listing_id: listing() }), runIsolated(db, (ctx) => catalogue(ctx).servicePriceHint(listing()))),
      );
    }
  });

  describe("get_owned_product_variants", () => {
    const cases: [string, () => string | null, () => string][] = [
      ["the owner", () => owner, () => dress],
      ["an admin", () => admin, () => dress],
      ["a product without varieties", () => owner, () => shoes],
      ["someone else is refused", () => stranger, () => dress],
      ["an unknown product is refused", () => owner, () => uuid()],
      ["signed out is refused", () => null, () => dress],
    ];
    for (const [name, who, product] of cases) {
      it(name, () =>
        same(
          runOriginal(db, me(who()), "get_owned_product_variants", { p_product_id: product() }),
          runIsolated(db, (ctx) => products(ctx).variants(me(who()), product())),
        ),
      );
    }
  });

  describe("save_product_variants", () => {
    const fresh = "00000000-0000-4000-8000-0000000000a1";
    const cases: [string, () => string | null, () => string, () => unknown][] = [
      [
        "updates, adds (with and without an id) and deletes what was left out",
        () => owner,
        () => dress,
        () => [
          { id: variantA, name: " Small ", sale_price: "9200", discount_price: 8000, quantity_available: "3", sort_order: 2, size: "S", color: " red ", description: "" },
          { name: "Medium", sale_price: 9300.5, photo_url: "https://img.test/m.jpg", sort_order: "1" },
          { id: fresh, name: "XL", sale_price: 9900 },
        ],
      ],
      ["an id of another product's variety is added as a new one", () => owner, () => shoes, () => [{ id: variantB, name: "Large", sale_price: 100 }]],
      ["an empty list deletes every variety", () => admin, () => dress, () => []],
      ["a name is required", () => owner, () => dress, () => [{ name: "OK", sale_price: 1 }, { name: "  ", sale_price: "not a number" }]],
      ["a sale price is required", () => owner, () => dress, () => [{ name: "Tiny", sale_price: "" }]],
      ["a sale price must be positive", () => owner, () => dress, () => [{ name: "Tiny", sale_price: 0 }]],
      ["a discount must be lower than the price", () => owner, () => dress, () => [{ name: "Tiny", sale_price: 10, discount_price: 10 }]],
      ["a discount must be positive", () => owner, () => dress, () => [{ name: "Tiny", sale_price: 10, discount_price: "0" }]],
      ["a quantity cannot be negative", () => owner, () => dress, () => [{ name: "Tiny", sale_price: 10, quantity_available: -1 }]],
      ["a malformed price fails like the database", () => owner, () => dress, () => [{ name: "Tiny", sale_price: "ten" }]],
      ["a malformed id fails like the database", () => owner, () => dress, () => [{ id: "nope", name: "Tiny", sale_price: 10 }]],
      ["not a list", () => owner, () => dress, () => ({ name: "Tiny" })],
      ["someone else's product is refused", () => stranger, () => dress, () => []],
      ["an unknown product", () => owner, () => uuid(), () => []],
      ["signed out is refused", () => null, () => dress, () => []],
    ];
    for (const [name, who, product, variants] of cases) {
      it(name, () =>
        same(
          runOriginal(db, me(who()), "save_product_variants", { p_product_id: product(), p_variants: variants() }),
          runIsolated(db, (ctx) => products(ctx).saveVariants(me(who()), product(), variants())),
        ),
      );
    }
  });

  describe("admin_get_inventory / admin_delete_inventory_product", () => {
    it("an admin sees the inventory", async () => {
      const a = await same(runOriginal(db, me(admin), "admin_get_inventory"), runIsolated(db, (ctx) => products(ctx).inventory(me(admin))));
      expect((a.result as unknown[]).length).toBeGreaterThan(3);
    });
    for (const [label, who] of [["a vendor", () => owner], ["a signed-out caller", () => null]] as const) {
      it(`refused for ${label}`, () =>
        same(runOriginal(db, me(who()), "admin_get_inventory"), runIsolated(db, (ctx) => products(ctx).inventory(me(who())))),
      );
    }
    const cases: [string, () => string | null, () => string][] = [
      ["a product never ordered is deleted for good", () => admin, () => shoes],
      ["a product with orders is hidden, history kept", () => admin, () => ordered],
      ["an unknown product", () => admin, () => uuid()],
      ["a vendor is refused", () => owner, () => shoes],
      ["signed out is refused", () => null, () => shoes],
    ];
    for (const [name, who, product] of cases) {
      it(name, () =>
        same(
          runOriginal(db, me(who()), "admin_delete_inventory_product", { p_product_id: product() }),
          runIsolated(db, (ctx) => products(ctx).deleteInventoryProduct(me(who()), product())),
        ),
      );
    }
  });

  describe("get_vendor_product_regions", () => {
    const cases: [string, () => string | null, () => string][] = [
      ["the owner", () => owner, () => shop],
      ["an admin, for a shop with orders", () => admin, () => otherShop],
      ["someone else is refused", () => stranger, () => otherShop],
      ["signed out is refused", () => null, () => otherShop],
    ];
    for (const [name, who, vendor] of cases) {
      it(name, () =>
        same(
          runOriginal(db, me(who()), "get_vendor_product_regions", { p_vendor_id: vendor() }),
          runIsolated(db, (ctx) => products(ctx).productRegions(me(who()), vendor())),
        ),
      );
    }
  });
});
