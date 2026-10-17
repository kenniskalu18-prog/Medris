import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, truncate, type TestDatabase } from "../support/test-db.js";
import { accessToken, buildTestApp, call, seedProduct, seedUser, seedVendor } from "../support/fixtures.js";

describe("/api/v1/cart", () => {
  let db: TestDatabase;
  let app: ReturnType<typeof buildTestApp>;
  let buyer: { id: string };
  let token: string;
  let vendorOwner: { id: string };
  let vendor: { id: string };
  let product: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = buildTestApp(db);
  });
  afterAll(async () => db?.close());
  beforeEach(async () => {
    await truncate(db, ["cart_items"]);
    buyer = await seedUser(db);
    token = await accessToken(buyer.id);
    vendorOwner = await seedUser(db, { role: "vendor" });
    vendor = await seedVendor(db, vendorOwner.id, { name: "Ada's Shop" });
    product = await seedProduct(db, vendor.id, { price: 2500, name: "Kettle" });
  });

  it("requires a signed-in user", async () => {
    expect((await call(app, "GET", "/api/v1/cart")).status).toBe(401);
    const bad = await call(app, "GET", "/api/v1/cart", { token: "not-a-jwt" });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ error: { code: "unauthenticated", message: "Invalid or expired session. Please log in again." } });
  });

  it("adds through add_to_cart(), merges quantities and lists items in the cart page's shape", async () => {
    expect((await call(app, "POST", "/api/v1/cart/items", { token, body: { productId: product, quantity: 2 } })).status).toBe(201);
    expect((await call(app, "POST", "/api/v1/cart/items", { token, body: { productId: product } })).status).toBe(201);

    const res = await call(app, "GET", "/api/v1/cart", { token });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- nested JSON under test
    const { data } = (await res.json()) as { data: Record<string, any>[] };
    expect(data).toHaveLength(1);
    const item = data[0]!;
    expect(item.quantity).toBe(3);
    expect(item.variant).toBeNull();
    expect(item.product).toMatchObject({ id: product, name: "Kettle", sale_price: 2500, status: "active", photos: ["https://img.test/a.jpg"] });
    expect(item.product.vendor).toMatchObject({ id: vendor.id, business_name: "Ada's Shop", verification_status: "verified", is_active: true, lat: 6.5 });
    // Timestamps in PostgREST's ISO format, as the app parsed before.
    expect(item.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$/);

    const count = await call(app, "GET", "/api/v1/cart/count", { token });
    expect(await count.json()).toEqual({ data: { count: 1 } });
  });

  it("passes the database's own refusal message through (own product)", async () => {
    const ownToken = await accessToken(vendorOwner.id);
    const res = await call(app, "POST", "/api/v1/cart/items", { token: ownToken, body: { productId: product, quantity: 1 } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "bad_request", message: "You can't buy from your own shop." } });
  });

  it("validates input", async () => {
    const res = await call(app, "POST", "/api/v1/cart/items", { token, body: { productId: "nope", quantity: 0 } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: { path: string }[] } };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details.map((d) => d.path).sort()).toEqual(["productId", "quantity"]);

    const notJson = await app.fetch(new Request("https://app.test/api/v1/cart/items", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{oops" }));
    expect(notJson.status).toBe(400);
  });

  it("changes quantities and removes only the caller's own items", async () => {
    await call(app, "POST", "/api/v1/cart/items", { token, body: { productId: product } });
    const [{ id: itemId }] = (await db.query<{ id: string }>(`select id from public.cart_items where buyer_id = $1`, [buyer.id])) as [{ id: string }];

    const other = await seedUser(db);
    const otherToken = await accessToken(other.id);
    expect((await call(app, "PATCH", `/api/v1/cart/items/${itemId}`, { token: otherToken, body: { quantity: 9 } })).status).toBe(404);
    expect(await (await call(app, "DELETE", `/api/v1/cart/items/${itemId}`, { token: otherToken })).json()).toEqual({ data: { removed: 0 } });

    expect((await call(app, "PATCH", `/api/v1/cart/items/${itemId}`, { token, body: { quantity: 0 } })).status).toBe(400);
    expect((await call(app, "PATCH", `/api/v1/cart/items/${itemId}`, { token, body: { quantity: 4 } })).status).toBe(200);
    const [row] = await db.query<{ quantity: number }>(`select quantity from public.cart_items where id = $1`, [itemId]);
    expect(row?.quantity).toBe(4);

    expect(await (await call(app, "POST", "/api/v1/cart/items/delete", { token, body: { ids: [itemId] } })).json()).toEqual({ data: { removed: 1 } });
  });

  it("empties the cart", async () => {
    const second = await seedProduct(db, vendor.id);
    await call(app, "POST", "/api/v1/cart/items", { token, body: { productId: product } });
    await call(app, "POST", "/api/v1/cart/items", { token, body: { productId: second } });
    expect(await (await call(app, "DELETE", "/api/v1/cart", { token })).json()).toEqual({ data: { removed: 2 } });
  });

  it("shows products that are no longer visible as null (the page treats them as unavailable)", async () => {
    await call(app, "POST", "/api/v1/cart/items", { token, body: { productId: product } });
    await db.query(`update public.products set status = 'paused' where id = $1`, [product]);
    const { data } = (await (await call(app, "GET", "/api/v1/cart", { token })).json()) as { data: { product: unknown }[] };
    expect(data[0]?.product).toBeNull();
  });
});
