import bcrypt from "bcryptjs";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createGoogleSignIn } from "../../src/modules/auth/google-oidc.js";
import { createSessionService, hashToken } from "../../src/modules/auth/session.service.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";
import { accessToken, buildTestApp, call, seedUser, testConfig, uuid } from "../support/fixtures.js";

/**
 * Backend-managed sessions are built but OFF in production. These tests run
 * them against the test database to show they work once approved.
 */
const SESSION_ENV = { AUTH_BACKEND_SESSIONS: "true", AUTH_COOKIE_SECURE: "true", APP_ORIGIN: "https://app.test" };

function cookieFrom(res: Response): string {
  const header = res.headers.get("set-cookie") ?? "";
  return header.split(";")[0] ?? "";
}

describe("backend sessions (AUTH_BACKEND_SESSIONS)", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => db?.close());

  it("is off by default: login answers feature_disabled and no cookie is ever read", async () => {
    const app = buildTestApp(db);
    const res = await call(app, "POST", "/api/v1/auth/login", { body: { identifier: "a@b.c", password: "x" } });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "feature_disabled" } });
    const session = await call(app, "GET", "/api/v1/auth/session", { headers: { Cookie: "__Host-medris_session=anything" } });
    expect(await session.json()).toMatchObject({ data: { authenticated: false, backendSessionsEnabled: false } });
  });

  it("signs in with an existing Supabase password hash, then authenticates by cookie", async () => {
    const app = buildTestApp(db, { env: SESSION_ENV });
    const user = await seedUser(db, { email: "Ada@Example.com", password: bcrypt.hashSync("correct horse", 4) });

    const wrong = await call(app, "POST", "/api/v1/auth/login", { body: { identifier: "ada@example.com", password: "nope" } });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();

    const login = await call(app, "POST", "/api/v1/auth/login", { body: { identifier: "ADA@example.com", password: "correct horse" } });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^__Host-medris_session=/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Path=\//);
    const cookie = cookieFrom(login);

    // Only the hash is stored.
    const token = cookie.split("=")[1]!;
    const rows = await db.query<{ token_hash: string; user_id: string }>(`select token_hash, user_id from public.backend_sessions where user_id = $1`, [user.id]);
    expect(rows).toEqual([{ token_hash: hashToken(token), user_id: user.id }]);

    const me = await call(app, "GET", "/api/v1/me", { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ data: { id: user.id } });
    expect(await (await call(app, "GET", "/api/v1/auth/session", { headers: { Cookie: cookie } })).json()).toMatchObject({
      data: { authenticated: true, userId: user.id, method: "cookie", source: "backend-session" },
    });
  });

  it("signs in phone-only accounts by phone number", async () => {
    const app = buildTestApp(db, { env: SESSION_ENV });
    const user = await seedUser(db, { email: "p2348031234567@accounts.levromart.app", password: bcrypt.hashSync("pw-12345678", 4) });
    const res = await call(app, "POST", "/api/v1/auth/login", { body: { identifier: "0803 123 4567", password: "pw-12345678" } });
    expect(await res.json()).toMatchObject({ data: { userId: user.id } });
  });

  it("blocks cross-site state changes made with the cookie (CSRF), but not same-origin ones", async () => {
    const app = buildTestApp(db, { env: SESSION_ENV });
    await seedUser(db, { email: "csrf@example.com", password: bcrypt.hashSync("pw-12345678", 4) });
    const cookie = cookieFrom(await call(app, "POST", "/api/v1/auth/login", { body: { identifier: "csrf@example.com", password: "pw-12345678" } }));

    const forged = await call(app, "DELETE", "/api/v1/cart", { headers: { Cookie: cookie, Origin: "https://evil.example" } });
    expect(forged.status).toBe(403);
    const noOrigin = await call(app, "DELETE", "/api/v1/cart", { headers: { Cookie: cookie } });
    expect(noOrigin.status).toBe(403);
    const sameOrigin = await call(app, "DELETE", "/api/v1/cart", { headers: { Cookie: cookie, Origin: "https://app.test" } });
    expect(sameOrigin.status).toBe(200);
  });

  it("logout revokes the session; logout-all revokes every session of the user", async () => {
    const app = buildTestApp(db, { env: SESSION_ENV });
    await seedUser(db, { email: "out@example.com", password: bcrypt.hashSync("pw-12345678", 4) });
    const login = () => call(app, "POST", "/api/v1/auth/login", { body: { identifier: "out@example.com", password: "pw-12345678" } });
    const a = cookieFrom(await login());
    const b = cookieFrom(await login());
    const c = cookieFrom(await login());

    const out = await call(app, "POST", "/api/v1/auth/logout", { headers: { Cookie: a, Origin: "https://app.test" } });
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    expect((await call(app, "GET", "/api/v1/me", { headers: { Cookie: a } })).status).toBe(401);
    expect((await call(app, "GET", "/api/v1/me", { headers: { Cookie: b } })).status).toBe(200);

    const all = await call(app, "POST", "/api/v1/auth/logout-all", { headers: { Cookie: b, Origin: "https://app.test" } });
    expect(await all.json()).toEqual({ data: { revoked: 2 } });
    expect((await call(app, "GET", "/api/v1/me", { headers: { Cookie: c } })).status).toBe(401);
  });

  it("expires sessions by absolute lifetime and by inactivity", async () => {
    const config = testConfig({ ...SESSION_ENV, AUTH_SESSION_TTL_DAYS: "30", AUTH_SESSION_IDLE_DAYS: "7" });
    let now = new Date("2026-10-01T00:00:00Z");
    const sessions = createSessionService(config, () => db.data, () => now);
    const user = await seedUser(db);
    const created = await sessions.create(user.id, "password");
    expect((await sessions.resolve(created.token))?.userId).toBe(user.id);

    now = new Date("2026-10-07T00:00:00Z"); // 6 days idle: still fine, and refreshes last_seen
    expect((await sessions.resolve(created.token))?.userId).toBe(user.id);
    now = new Date("2026-10-15T00:00:00Z"); // 8 days after last use: idle-expired
    expect(await sessions.resolve(created.token)).toBeNull();

    const second = await sessions.create(user.id, "password");
    for (const day of ["2026-10-20", "2026-10-26", "2026-11-01", "2026-11-07", "2026-11-13"]) {
      now = new Date(`${day}T00:00:00Z`);
      expect((await sessions.resolve(second.token))?.userId).toBe(user.id);
    }
    now = new Date("2026-11-16T00:00:00Z"); // past 30 days from creation (15 Oct)
    expect(await sessions.resolve(second.token)).toBeNull();
  });

  it("refuses banned and unconfirmed accounts, and rate-limits guessing", async () => {
    const app = buildTestApp(db, { env: SESSION_ENV });
    const banned = await seedUser(db, { email: "banned@example.com", password: bcrypt.hashSync("pw-12345678", 4) });
    await db.query(`update auth.users set banned_until = now() + interval '1 day' where id = $1`, [banned.id]);
    expect((await call(app, "POST", "/api/v1/auth/login", { body: { identifier: "banned@example.com", password: "pw-12345678" } })).status).toBe(403);

    const unconfirmed = await seedUser(db, { email: "new@example.com", password: bcrypt.hashSync("pw-12345678", 4) });
    await db.query(`update auth.users set email_confirmed_at = null where id = $1`, [unconfirmed.id]);
    expect((await call(app, "POST", "/api/v1/auth/login", { body: { identifier: "new@example.com", password: "pw-12345678" } })).status).toBe(403);

    let status = 0;
    for (let i = 0; i < 11; i++) {
      status = (await call(app, "POST", "/api/v1/auth/login", { body: { identifier: "nobody@example.com", password: "x" }, headers: { "X-Forwarded-For": "203.0.113.9" } })).status;
    }
    expect(status).toBe(429);
  });

  it("a bearer token still works alongside sessions", async () => {
    const app = buildTestApp(db, { env: SESSION_ENV });
    const user = await seedUser(db);
    const res = await call(app, "GET", "/api/v1/auth/session", { token: await accessToken(user.id) });
    expect(await res.json()).toMatchObject({ data: { authenticated: true, method: "bearer", source: "supabase-jwt" } });
  });
});

describe("Google sign-in through the backend", () => {
  let db: TestDatabase;
  let google: ReturnType<typeof createGoogleSignIn>;
  let signIdToken: (claims: Record<string, unknown>) => Promise<string>;
  let nextIdToken = "";
  const GOOGLE_ENV = {
    ...SESSION_ENV,
    GOOGLE_CLIENT_ID: "client-123.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "google-secret",
    GOOGLE_REDIRECT_URI: "https://app.test/api/v1/auth/google/callback",
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "g1", alg: "RS256" };
    signIdToken = (claims) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "g1" })
        .setIssuer("https://accounts.google.com")
        .setAudience(GOOGLE_ENV.GOOGLE_CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
    google = createGoogleSignIn(testConfig(GOOGLE_ENV), { jwks: createLocalJWKSet({ keys: [jwk] }), exchange: async () => nextIdToken });
  });
  afterAll(async () => db?.close());

  async function signIn(app: ReturnType<typeof buildTestApp>, claims: Record<string, unknown>, returnTo = "/orders") {
    const start = await call(app, "GET", `/api/v1/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`);
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("location")!);
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    const state = location.searchParams.get("state")!;
    const flowCookie = cookieFrom(start);
    nextIdToken = await signIdToken(claims);
    return call(app, "GET", `/api/v1/auth/google/callback?code=abc&state=${state}`, { headers: { Cookie: flowCookie } });
  }

  it("links to the account Supabase already linked to this Google identity", async () => {
    const app = buildTestApp(db, { env: GOOGLE_ENV, services: { google } });
    const user = await seedUser(db, { email: "linked@example.com" });
    await db.query(`insert into auth.identities (user_id, provider, provider_id) values ($1, 'google', 'google-sub-1')`, [user.id]);
    const res = await signIn(app, { sub: "google-sub-1", email: "different@example.com", email_verified: true });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/orders");
    const cookie = (res.headers.get("set-cookie") ?? "").match(/__Host-medris_session=[^;]+/)?.[0] ?? "";
    expect(await (await call(app, "GET", "/api/v1/me", { headers: { Cookie: cookie } })).json()).toMatchObject({ data: { id: user.id } });
  });

  it("links by verified e-mail, never by an unverified one", async () => {
    const app = buildTestApp(db, { env: GOOGLE_ENV, services: { google } });
    const user = await seedUser(db, { email: "match@example.com" });
    const ok = await signIn(app, { sub: "google-sub-2", email: "MATCH@example.com", email_verified: true });
    expect(ok.status).toBe(302);
    const sessions = await db.query(`select 1 from public.backend_sessions where user_id = $1 and auth_method = 'google'`, [user.id]);
    expect(sessions).toHaveLength(1);

    const refused = await signIn(app, { sub: "google-sub-3", email: "match@example.com", email_verified: false });
    expect(refused.status).toBe(403);
  });

  it("creates a new account through Supabase Auth's admin API for a first-time Google user", async () => {
    const app = buildTestApp(db, { env: GOOGLE_ENV, services: { google } });
    const newId = uuid();
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      expect(url).toBe("https://example.supabase.co/auth/v1/admin/users");
      expect(JSON.parse(String(init?.body))).toMatchObject({ email: "brand-new@example.com", email_confirm: true });
      // Supabase creates the auth user; its sign-up triggers create the profile row.
      await db.query(`insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ($1, 'brand-new@example.com', now(), '{"name":"New"}')`, [newId]);
      return new Response(JSON.stringify({ id: newId, email: "brand-new@example.com" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await signIn(app, { sub: "google-sub-new", email: "brand-new@example.com", email_verified: true, name: "New Person" }, "/");
    expect(res.status).toBe(302);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("rejects a callback whose state does not match, and open redirects", async () => {
    const app = buildTestApp(db, { env: GOOGLE_ENV, services: { google } });
    const start = await call(app, "GET", "/api/v1/auth/google/start?returnTo=https://evil.example");
    const flowCookie = cookieFrom(start);
    expect(decodeURIComponent(flowCookie)).toContain('"r":"/"');
    const res = await call(app, "GET", "/api/v1/auth/google/callback?code=abc&state=forged", { headers: { Cookie: flowCookie } });
    expect(res.status).toBe(400);
  });

  it("rejects ID tokens for another client", async () => {
    const app = buildTestApp(db, { env: GOOGLE_ENV, services: { google } });
    const start = await call(app, "GET", "/api/v1/auth/google/start");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    nextIdToken = await new SignJWT({ sub: "x", email: "x@example.com", email_verified: true })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("https://accounts.google.com")
      .setAudience("someone-else")
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("x".repeat(32)));
    const res = await call(app, "GET", `/api/v1/auth/google/callback?code=abc&state=${state}`, { headers: { Cookie: cookieFrom(start) } });
    expect(res.status).toBe(401);
  });
});
