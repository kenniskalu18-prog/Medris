import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RPC_NAMES } from "../../src/modules/rpc/rpc.dispatch.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";
import { accessToken, buildTestApp, call, seedProduct, seedUser, seedVendor } from "../support/fixtures.js";

/** POST /api/v1/rpc/{name}: the app's sb.rpc() calls over HTTP. Each function's behaviour is proven by the parity suite. */
describe("/api/v1/rpc/{name}", () => {
  let db: TestDatabase;
  let app: ReturnType<typeof buildTestApp>;
  beforeAll(async () => {
    db = await createTestDatabase();
    app = buildTestApp(db);
  });
  afterAll(async () => db?.close());

  it("covers every function the app calls in the browser, except those only the server may run", () => {
    expect(RPC_NAMES.length).toBe(218);
    for (const serverOnly of ["increment_chat_usage", "apply_referral_internal", "delete_my_account", "process_listing_billing_reminders"]) {
      expect(RPC_NAMES).not.toContain(serverOnly);
    }
  });

  it("the app sends exactly these names to the backend (medris-frontend/src/services/api/rpc-functions.ts)", () => {
    const listed = readFileSync(new URL("../../../medris-frontend/src/services/api/rpc-functions.ts", import.meta.url), "utf8");
    const names = [...listed.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]).sort();
    expect(names).toEqual(RPC_NAMES);
  });

  it("get_vendor_owner_avatars: the owner's account picture for live, verified shops only", async () => {
    const owner = await seedUser(db, { role: "vendor" });
    await db.query(`update public.users set avatar_url = 'https://cdn.example/a.webp' where id = $1`, [owner.id]);
    const shop = await seedVendor(db, owner.id);
    const pendingOwner = await seedUser(db, { role: "vendor" });
    await db.query(`update public.users set avatar_url = 'https://cdn.example/p.webp' where id = $1`, [pendingOwner.id]);
    const pending = await seedVendor(db, pendingOwner.id, { verified: false });
    const res = await call(app, "POST", "/api/v1/rpc/get_vendor_owner_avatars", { body: { p_vendor_ids: [shop.id, pending.id, "not-a-uuid"] } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ vendor_id: shop.id, avatar_url: "https://cdn.example/a.webp" }] });
  });

  it("answers with what the original returned: rows, a boolean, null", async () => {
    const owner = await seedUser(db, { role: "vendor" });
    const vendor = await seedVendor(db, owner.id);
    const buyer = await seedUser(db);
    const token = await accessToken(buyer.id);

    const stats = await call(app, "POST", "/api/v1/rpc/get_vendor_stats", { body: { p_vendor_id: vendor.id } });
    expect(stats.status).toBe(200);
    expect(await stats.json()).toEqual({ data: [{ completed_orders: 0, avg_rating: 0, review_count: 0 }] });

    const follow = await call(app, "POST", "/api/v1/rpc/toggle_vendor_follow", { token, body: { p_vendor_id: vendor.id, p_following: true } });
    expect(await follow.json()).toEqual({ data: true });

    const seen = await call(app, "POST", "/api/v1/rpc/touch_last_seen", { token, body: {} });
    expect(await seen.json()).toEqual({ data: null });
  });

  it("keeps the original's error message", async () => {
    const owner = await seedUser(db, { role: "vendor" });
    const vendor = await seedVendor(db, owner.id);
    const res = await call(app, "POST", "/api/v1/rpc/toggle_vendor_follow", { token: await accessToken(owner.id), body: { p_vendor_id: vendor.id, p_following: true } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { message: "You cannot follow your own shop." } });
  });

  it("needs a sign-in where the original did", async () => {
    const owner = await seedUser(db, { role: "vendor" });
    const vendor = await seedVendor(db, owner.id);
    const product = await seedProduct(db, vendor.id);
    const res = await call(app, "POST", "/api/v1/rpc/add_to_cart", { body: { p_product_id: product, p_quantity: 1 } });
    expect(res.status).toBe(401);
  });

  it("refuses names it does not answer", async () => {
    const res = await call(app, "POST", "/api/v1/rpc/delete_my_account", { body: {} });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "validation_failed" } });
  });

  it("create_notification only ever notifies the caller (finding S2)", async () => {
    const me = await seedUser(db);
    const someoneElse = await seedUser(db);
    const res = await call(app, "POST", "/api/v1/rpc/create_notification", {
      token: await accessToken(me.id),
      body: { p_user_id: someoneElse.id, p_type: "vendor_application_document_action_needed", p_title: "Hi", p_body: "Body", p_target_view: "home", p_target_params: { vendorId: "x" }, p_actor_id: null },
    });
    expect(await res.json()).toEqual({ data: null });
    const rows = await db.query<{ user_id: string; title: string; target_params: unknown }>(`select user_id, title, target_params from public.notifications where title = 'Hi'`);
    expect(rows).toEqual([{ user_id: me.id, title: "Hi", target_params: { vendorId: "x" } }]);
  });
});
