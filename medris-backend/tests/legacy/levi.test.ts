import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LeviRepository } from "../../src/database/repositories/levi.repository.js";
import { executeTool, type LeviContext } from "../../src/modules/levi/levi.tools.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";
import { seedProduct, seedUser, seedVendor, uuid } from "../support/fixtures.js";

/** Levi's tools read through the data layer; every query is exercised against the test database. */
describe("Levi tools", () => {
  let db: TestDatabase;
  let ctx: LeviContext;
  let vendorCtx: LeviContext;
  let product: string;
  let vendorId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    const owner = await seedUser(db, { role: "vendor" });
    const vendor = await seedVendor(db, owner.id, { name: "Ada Electronics" });
    vendorId = vendor.id;
    product = await seedProduct(db, vendor.id, { name: "Rechargeable lamp", price: 8000 });
    await db.query(`update public.products set quantity_available = 5, view_count = 7 where id = $1`, [product]);
    const buyer = await seedUser(db);
    const orderId = uuid();
    await db.query(`insert into public.orders (id, buyer_id, vendor_id, order_type, status, delivery_method, total_amount, status_changed_at) values ($1, $2, $3, 'sale', 'completed', 'pickup', 8000, now())`, [orderId, buyer.id, vendor.id]);
    await db.query(`insert into public.order_items (order_id, product_id, quantity, unit_price) values ($1, $2, 1, 8000)`, [orderId, product]);
    await db.query(`insert into public.favorites (buyer_id, product_id) values ($1, $2)`, [buyer.id, product]);
    const conversation = uuid();
    await db.query(`insert into public.conversations (id, buyer_id, vendor_id) values ($1, $2, $3)`, [conversation, buyer.id, vendor.id]);
    await db.query(`insert into public.messages (conversation_id, sender_id, body) values ($1, $2, 'Is it available?')`, [conversation, buyer.id]);
    const identity = (userId: string) => ({ userId, email: null, claims: { sub: userId, role: "authenticated" }, source: "supabase-jwt" as const });
    ctx = { data: db.data, identity: identity(buyer.id), userId: buyer.id, lat: 6.5, lng: 3.4 };
    vendorCtx = { data: db.data, identity: identity(owner.id), userId: owner.id, lat: null, lng: null };
  });
  afterAll(async () => db?.close());

  it("every repository query runs", async () => {
    await db.data.asService(async (tx) => {
      const r = new LeviRepository(tx);
      expect((await r.activeProducts())[0]).toMatchObject({ id: product, vendor: { business_name: "Ada Electronics" } });
      expect(await r.activePackages()).toEqual([]);
      expect((await r.product(product))[0]).toMatchObject({ name: "Rechargeable lamp" });
      expect((await r.vendor(vendorId))[0]).toMatchObject({ business_name: "Ada Electronics" });
      expect((await r.vendorOrders(vendorId))[0]).toMatchObject({ status: "completed", items: [{ quantity: 1, product: { id: product } }] });
      expect((await r.vendorOrderItems(vendorId))[0]).toMatchObject({ product_id: product, order: { status: "completed" } });
      expect(await r.favoritesOf([product])).toEqual([{ product_id: product }]);
      expect(await r.sectors()).not.toHaveLength(0);
      // Adding a product without a category files it under a default one (trigger trg_products_default_category).
      expect(await r.categories()).not.toHaveLength(0);
    });
  });

  it("answers the buyer's own questions from their data only", async () => {
    expect(await executeTool("get_my_orders", {}, ctx)).toMatchObject({ orders: [{ status: "completed", vendor: { business_name: "Ada Electronics" }, items: [{ unit_price: 8000 }] }] });
    expect(await executeTool("get_my_wishlist", {}, ctx)).toMatchObject({ items: [{ product: { id: product, vendor: { business_name: "Ada Electronics" } } }] });
    expect(await executeTool("get_my_messages", {}, ctx)).toMatchObject({ conversations: [{ vendor: { business_name: "Ada Electronics" }, unread: 0 }] });
    expect(await executeTool("get_my_profile", {}, ctx)).toMatchObject({ profile: { id: ctx.userId } });
  });

  it("searches the catalogue and adds to the cart as the user", async () => {
    const found = (await executeTool("search_products", { query: "lamp" }, ctx)) as { results: { id: string; vendor: { distance_km: number } }[] };
    expect(found.results[0]?.id).toBe(product);
    expect(found.results[0]?.vendor.distance_km).toBe(0);
    expect(await executeTool("add_to_cart", { productId: product, quantity: 2 }, ctx)).toMatchObject({ ok: true, quantity: 2 });
    expect(await executeTool("get_my_cart", {}, ctx)).toMatchObject({ items: [{ quantity: 2, product: { id: product } }] });
    expect(await executeTool("remove_from_cart", { productId: product }, ctx)).toMatchObject({ ok: true });
    // The vendor cannot add their own product: the database refuses, Levi says so.
    expect(await executeTool("add_to_cart", { productId: product }, vendorCtx)).toEqual({ ok: false, message: "I couldn't add that item to the cart." });
  });

  it("gives vendors their analytics and degrades to empty results on bad ids", async () => {
    expect(await executeTool("get_my_vendor_analytics", {}, vendorCtx)).toMatchObject({ is_vendor: true, orders: { completed: 1, revenue: 8000 } });
    expect(await executeTool("get_product", { productId: "not-an-id" }, ctx)).toEqual({ results: [] });
  });
});
