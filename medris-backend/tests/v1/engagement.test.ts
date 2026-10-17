import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";
import { accessToken, buildTestApp, call, seedNotification, seedProduct, seedSector, seedUser, seedVendor, uuid } from "../support/fixtures.js";

describe("/api/v1 favorites, follows, notifications, catalogue, me", () => {
  let db: TestDatabase;
  let app: ReturnType<typeof buildTestApp>;
  beforeAll(async () => {
    db = await createTestDatabase();
    app = buildTestApp(db);
  });
  afterAll(async () => db?.close());

  describe("favorites", () => {
    it("saves idempotently, lists ids and removes", async () => {
      const buyer = await seedUser(db);
      const token = await accessToken(buyer.id);
      const owner = await seedUser(db, { role: "vendor" });
      const vendor = await seedVendor(db, owner.id);
      const product = await seedProduct(db, vendor.id);
      const pkg = uuid();
      await db.query(`insert into public.vendor_packages (id, vendor_id, name, price) values ($1, $2, 'Bundle', 5000)`, [pkg, vendor.id]);

      expect(await (await call(app, "PUT", `/api/v1/favorites/products/${product}`, { token })).json()).toEqual({ data: { saved: true, created: true } });
      expect(await (await call(app, "PUT", `/api/v1/favorites/products/${product}`, { token })).json()).toEqual({ data: { saved: true, created: false } });
      await call(app, "PUT", `/api/v1/favorites/packages/${pkg}`, { token });
      expect(await (await call(app, "GET", "/api/v1/favorites", { token })).json()).toEqual({ data: { productIds: [product], packageIds: [pkg] } });

      expect(await (await call(app, "DELETE", `/api/v1/favorites/products/${product}`, { token })).json()).toEqual({ data: { saved: false, removed: 1 } });
      expect(await (await call(app, "GET", "/api/v1/favorites", { token })).json()).toEqual({ data: { productIds: [], packageIds: [pkg] } });
    });

    it("keeps the database's rule that admins cannot save packages", async () => {
      const admin = await seedUser(db, { role: "admin" });
      const owner = await seedUser(db, { role: "vendor" });
      const vendor = await seedVendor(db, owner.id);
      const pkg = uuid();
      await db.query(`insert into public.vendor_packages (id, vendor_id, name, price) values ($1, $2, 'Bundle', 5000)`, [pkg, vendor.id]);
      const res = await call(app, "PUT", `/api/v1/favorites/packages/${pkg}`, { token: await accessToken(admin.id) });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: "forbidden" } });
    });
  });

  describe("follows", () => {
    it("follows through toggle_vendor_follow(), reports state and unfollows", async () => {
      const buyer = await seedUser(db);
      const token = await accessToken(buyer.id);
      const owner = await seedUser(db, { role: "vendor" });
      const vendor = await seedVendor(db, owner.id);

      const put = await call(app, "PUT", `/api/v1/follows/${vendor.id}`, { token, body: { following: true } });
      // toggle_vendor_follow() returns the new state (a boolean), passed through as "result".
      expect(await put.json()).toEqual({ data: { following: true, result: true } });
      expect(await (await call(app, "GET", `/api/v1/follows/${vendor.id}`, { token })).json()).toEqual({ data: { following: true } });
      expect(await (await call(app, "GET", "/api/v1/follows", { token })).json()).toEqual({ data: { vendorIds: [vendor.id], count: 1 } });

      expect(await (await call(app, "DELETE", `/api/v1/follows/${vendor.id}`, { token })).json()).toEqual({ data: { following: false, removed: 1 } });
      expect(await (await call(app, "GET", `/api/v1/follows/${vendor.id}`, { token })).json()).toEqual({ data: { following: false } });
    });

    it("refuses following your own shop with the database's message", async () => {
      const owner = await seedUser(db, { role: "vendor" });
      const vendor = await seedVendor(db, owner.id);
      const res = await call(app, "PUT", `/api/v1/follows/${vendor.id}`, { token: await accessToken(owner.id), body: { following: true } });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { message: "You cannot follow your own shop." } });
    });
  });

  describe("notifications", () => {
    it("lists unread plus recent read ones, newest first, without deleted ones", async () => {
      const user = await seedUser(db);
      const token = await accessToken(user.id);
      const now = Date.now();
      const oldRead = await seedNotification(db, user.id, { read: true, createdAt: new Date(now - 40 * 86_400_000).toISOString() });
      const oldUnread = await seedNotification(db, user.id, { read: false, createdAt: new Date(now - 50 * 86_400_000).toISOString() });
      const recentRead = await seedNotification(db, user.id, { read: true, createdAt: new Date(now - 60_000).toISOString() });
      const deleted = await seedNotification(db, user.id, { deleted: true });
      const someoneElse = await seedNotification(db, (await seedUser(db)).id);

      const { data } = (await (await call(app, "GET", "/api/v1/notifications", { token })).json()) as { data: { id: string; title: string }[] };
      expect(data.map((n) => n.id)).toEqual([recentRead, oldUnread]);
      expect(data.map((n) => n.id)).not.toContain(oldRead);
      expect(data.map((n) => n.id)).not.toContain(deleted);
      expect(data.map((n) => n.id)).not.toContain(someoneElse);
      // all columns, like select("*")
      expect(Object.keys(data[0]!)).toEqual(expect.arrayContaining(["id", "user_id", "type", "title", "target_params", "read", "archived", "deleted_at", "created_at"]));
    });

    it("counts the badge, filters by type and time, and marks read", async () => {
      const user = await seedUser(db);
      const token = await accessToken(user.id);
      const a = await seedNotification(db, user.id, { type: "new_offer", createdAt: new Date(Date.now() - 3_600_000).toISOString() });
      const b = await seedNotification(db, user.id, { type: "new_order" });
      await seedNotification(db, user.id, { archived: true });
      const other = await seedNotification(db, (await seedUser(db)).id);

      expect(await (await call(app, "GET", "/api/v1/notifications/unread-count", { token })).json()).toEqual({ data: { count: 2 } });
      expect(await (await call(app, "GET", "/api/v1/notifications/unread-count?type=new_offer", { token })).json()).toEqual({ data: { count: 1 } });
      const after = encodeURIComponent(new Date(Date.now() - 60_000).toISOString());
      expect(await (await call(app, "GET", `/api/v1/notifications/unread-count?type=new_offer&after=${after}`, { token })).json()).toEqual({ data: { count: 0 } });

      // Someone else's id is silently ignored (0 updated), never changed.
      expect(await (await call(app, "POST", "/api/v1/notifications/read", { token, body: { ids: [a, other] } })).json()).toEqual({ data: { updated: 1 } });
      const [otherRow] = await db.query<{ read: boolean }>(`select read from public.notifications where id = $1`, [other]);
      expect(otherRow?.read).toBe(false);

      expect(await (await call(app, "POST", "/api/v1/notifications/read", { token, body: { ids: [a], read: false } })).json()).toEqual({ data: { updated: 1 } });
      expect(await (await call(app, "POST", "/api/v1/notifications/read", { token, body: { all: true } })).json()).toEqual({ data: { updated: 3 } });
      expect(await (await call(app, "GET", "/api/v1/notifications/unread-count", { token })).json()).toEqual({ data: { count: 0 } });
      expect(b).toBeTruthy();
    });

    it("validates query parameters", async () => {
      const token = await accessToken((await seedUser(db)).id);
      expect((await call(app, "GET", "/api/v1/notifications?readSince=yesterday", { token })).status).toBe(400);
      expect((await call(app, "GET", "/api/v1/notifications?limit=5000", { token })).status).toBe(400);
      expect((await call(app, "POST", "/api/v1/notifications/read", { token, body: { ids: [] } })).status).toBe(400);
    });
  });

  describe("catalogue (public)", () => {
    it("serves sectors and categories to signed-out visitors with every column", async () => {
      const first = await seedSector(db, { name: "Aaa first", sortOrder: -100 });
      await db.query(`insert into public.categories (id, name, sector_id) values ($1, 'Zebra', $2), ($3, 'Apple', $2)`, [uuid(), first, uuid()]);

      const sectors = (await (await call(app, "GET", "/api/v1/catalogue/sectors")).json()) as { data: { id: string; icon: string; slug: string }[] };
      expect(sectors.data[0]).toMatchObject({ id: first, icon: "fa-shapes" });
      const byName = (await (await call(app, "GET", "/api/v1/catalogue/sectors?order=name")).json()) as { data: { name: string }[] };
      const names = byName.data.map((s) => s.name);
      expect(names).toEqual([...names].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));

      const cats = (await (await call(app, "GET", `/api/v1/catalogue/categories?sectorId=${first}`)).json()) as { data: { name: string }[] };
      expect(cats.data.map((c) => c.name)).toEqual(["Apple", "Zebra"]);
      expect((await call(app, "GET", "/api/v1/catalogue/categories?sectorId=x")).status).toBe(400);
      expect((await call(app, "GET", "/api/v1/catalogue/sectors?order=random")).status).toBe(400);
    });
  });

  describe("me", () => {
    it("returns the caller's profile", async () => {
      const user = await seedUser(db, { role: "vendor", phone: "08030000000" });
      const res = await call(app, "GET", "/api/v1/me", { token: await accessToken(user.id) });
      expect(await res.json()).toMatchObject({ data: { id: user.id, role: "vendor", phone: "08030000000", hasPassword: false } });
    });
  });
});
