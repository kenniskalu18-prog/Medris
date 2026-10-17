import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";
import { accessToken, buildTestApp, seedUser, seedVendor, uuid } from "../support/fixtures.js";
import { jsonRequest, setTestEnv, stubFetch } from "../helpers.js";

/**
 * /api/delete-account (+ /api/register, /api/account-exists): same requests and
 * responses as before; profiles and data now go through the database layer,
 * login accounts and files still through Supabase Auth / Storage (stubbed).
 */
describe("account actions (/api/delete-account)", () => {
  let db: TestDatabase;
  let app: ReturnType<typeof buildTestApp>;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => db?.close());
  beforeEach(() => {
    setTestEnv();
    app = buildTestApp(db);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("ensure-profile never deletes an account when the profile row exists", async () => {
    const user = await seedUser(db);
    const { calls } = stubFetch([]);
    const res = await app.fetch(jsonRequest("/api/delete-account", { action: "ensure-profile", accessToken: await accessToken(user.id) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, created: false });
    expect(calls).toHaveLength(0);
    expect(await db.query(`select 1 from public.users where id = $1`, [user.id])).toHaveLength(1);
  });

  it("ensure-profile re-creates a missing profile row as a buyer, without deleting anything", async () => {
    const id = uuid();
    // An auth account whose profile row went missing (the sign-up triggers normally create it).
    await db.query(`insert into auth.users (id, email) values ($1, 'ada@example.com')`, [id]);
    await db.query(`delete from public.users where id = $1`, [id]);
    stubFetch([{ match: "/auth/v1/user", json: { id, email: "ada@example.com", user_metadata: { name: "Ada", phone: "08012345678", role: "vendor" } } }]);
    const res = await app.fetch(jsonRequest("/api/delete-account", { action: "ensure-profile", accessToken: await accessToken(id) }));
    expect(await res.json()).toEqual({ ok: true, created: true });
    const [row] = await db.query<{ role: string; name: string; phone: string; city: string }>(`select role, name, phone, city from public.users where id = $1`, [id]);
    expect(row).toEqual({ role: "buyer", name: "Ada", phone: "08012345678", city: "Lagos" });
  });

  it("rejects an expired or forged token", async () => {
    const res = await app.fetch(jsonRequest("/api/delete-account", { action: "ensure-profile", accessToken: await accessToken(uuid(), { expiresIn: "-1m" }) }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid or expired session. Please log in again." });
  });

  it("rejects an unknown action instead of deleting the account", async () => {
    const user = await seedUser(db);
    const { calls } = stubFetch([]);
    const res = await app.fetch(jsonRequest("/api/delete-account", { action: "something-else", accessToken: await accessToken(user.id) }));
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
    expect(await db.query(`select 1 from public.users where id = $1`, [user.id])).toHaveLength(1);
  });

  it("still deletes when the app's Delete account screen sends no action", async () => {
    const user = await seedUser(db);
    const { calls } = stubFetch([
      { method: "POST", match: "/storage/v1/object/list/", json: [] },
      { method: "DELETE", match: `/auth/v1/admin/users/${user.id}`, json: {} },
    ]);
    const res = await app.fetch(jsonRequest("/api/delete-account", { accessToken: await accessToken(user.id) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(await db.query(`select 1 from public.users where id = $1`, [user.id])).toHaveLength(0);
    expect(calls.some((c) => c.method === "DELETE" && c.url.includes(`/auth/v1/admin/users/${user.id}`))).toBe(true);
    // avatars + vendor-docs listed for the user's own folder
    expect(calls.filter((c) => c.url.includes("/storage/v1/object/list/")).map((c) => JSON.parse(c.body!).prefix)).toEqual([user.id, user.id]);
  });

  it("blocks vendor account deletion while orders are active or commission is owed", async () => {
    const owner = await seedUser(db, { role: "vendor" });
    const vendor = await seedVendor(db, owner.id);
    const buyer = await seedUser(db, { phone: "08031110000" }); // orders require the buyer's phone
    await db.query(`insert into public.orders (id, buyer_id, vendor_id, order_type, status, delivery_method) values ($1, $2, $3, 'sale', 'pending', 'pickup')`, [uuid(), buyer.id, vendor.id]);
    stubFetch([]);
    const res = await app.fetch(jsonRequest("/api/delete-account", { accessToken: await accessToken(owner.id) }));
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: expect.stringContaining("1 order(s) are still active") });

    // No longer active. (Completing it would need a paid payment: the order triggers turn an
    // unpaid "completed" into "payment_unresolved".)
    await db.query(`update public.orders set status = 'cancelled' where vendor_id = $1`, [vendor.id]);
    await db.query(`insert into public.commission_charges (vendor_id, amount, status) values ($1, 1500, 'owed')`, [vendor.id]);
    const owed = await app.fetch(jsonRequest("/api/delete-account", { accessToken: await accessToken(owner.id) }));
    expect(await owed.json()).toEqual({ error: "You have ₦1,500 in unsettled commission. Clear it before deleting your vendor account." });
  });

  it("registers through Supabase Auth and fills a missing profile; refuses a used phone", async () => {
    const newId = uuid();
    // Supabase Auth creates the user; its sign-up triggers then create the profile row.
    const createAuthUser = async (body: string | undefined) => {
      const { email, user_metadata } = JSON.parse(body ?? "{}") as { email: string; user_metadata: unknown };
      await db.query(`insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data) values ($1, $2, '$2a$10$hash', now(), $3)`, [
        newId,
        email,
        JSON.stringify(user_metadata),
      ]);
    };
    // The referral code belongs to an active vendor (the real apply_referral_internal() checks it).
    const referrer = await seedUser(db);
    await seedVendor(db, referrer.id, { referralCode: "AB12" });
    const { calls } = stubFetch([{ method: "POST", match: "/auth/v1/admin/users", json: { id: newId }, effect: createAuthUser }]);
    const res = await app.fetch(
      jsonRequest("/api/register", { action: "register", name: "Bola", phone: "0803 555 0000", password: "longenough", role: "vendor", referral_code: "ab-12" }),
    );
    expect(res.status).toBe(201);
    // The sign-up trigger (trg_zz_apply_signup_referral) already applied the code when Supabase created
    // the user, so the endpoint's own "safety net" call answers already_used - as on the live site.
    expect(await res.json()).toEqual({
      created: true,
      userId: newId,
      loginEmail: "p2348035550000@accounts.levromart.app",
      referral: { ok: false, error: "already_used", message: "You have already used a referral code." },
    });
    const createBody = JSON.parse(calls[0]!.body!);
    expect(createBody).toMatchObject({ email: "p2348035550000@accounts.levromart.app", email_confirm: true, user_metadata: { role: "buyer", requested_role: "vendor" } });
    const [row] = await db.query<{ role: string; has_password: boolean }>(`select role, has_password from public.users where id = $1`, [newId]);
    expect(row).toEqual({ role: "buyer", has_password: true });
    expect(await db.query(`select code from public.referrals where referred_user_id = $1`, [newId])).toEqual([{ code: "AB12" }]);

    const again = await app.fetch(jsonRequest("/api/register", { action: "register", name: "Bola", phone: "0803 555 0000", password: "longenough", role: "buyer" }));
    expect(again.status).toBe(409);
  });

  it("validates registration input with the original messages", async () => {
    stubFetch([]);
    const missingName = await app.fetch(jsonRequest("/api/register", { action: "register", phone: "08012345678", password: "longenough", role: "buyer" }));
    expect(missingName.status).toBe(400);
    expect(await missingName.json()).toEqual({ error: "Full name is required." });
    const shortPassword = await app.fetch(jsonRequest("/api/register", { action: "register", name: "Ada", phone: "08012345678", password: "short", role: "buyer" }));
    expect(await shortPassword.json()).toEqual({ error: "Password must be at least 8 characters." });
  });

  it("answers account-exists from the profile table and Supabase Auth", async () => {
    await seedUser(db, { email: "known@example.com" });
    stubFetch([{ method: "GET", match: "/auth/v1/admin/users?page=1", json: { users: [] } }]);
    const res = await app.fetch(jsonRequest("/api/account-exists", { action: "account-exists", email: "Known@Example.com" }));
    expect(await res.json()).toEqual({ exists: true, hasPublicProfile: true, hasAuthAccount: false });
  });

  it("serves TURN servers on GET /api/turn and GET /api/delete-account?turn=1", async () => {
    stubFetch([]);
    for (const path of ["/api/turn", "/api/delete-account?turn=1"]) {
      const res = await app.fetch(new Request(`https://app.test${path}`));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, max-age=600");
      const body = (await res.json()) as { iceServers: unknown[]; source: string };
      expect(body.iceServers.length).toBeGreaterThan(0);
      expect(body.source).toBe("open-relay (shared, unreliable)");
    }
  });

  it("answers other methods with 405", async () => {
    const res = await app.fetch(new Request("https://app.test/api/delete-account", { method: "PUT" }));
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: "Method not allowed." });
  });
});
