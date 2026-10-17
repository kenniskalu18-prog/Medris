import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, missingProductionEnv } from "../../src/config/app-config.js";
import { poolConfig } from "../../src/config/database.js";
import { mapDatabaseError } from "../../src/database/errors.js";
import { toIsoTimestamp } from "../../src/database/schema/types.js";
import { createLogger, redact } from "../../src/lib/logger.js";
import { RateLimiter } from "../../src/lib/rate-limit.js";
import { SupabaseAccessTokenVerifier } from "../../src/modules/auth/access-token.js";
import { safeReturnPath } from "../../src/modules/auth/auth.service.js";
import { restoreRewrittenUrl } from "../../src/vercel.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";
import { ISSUER, JWT_SECRET, accessToken, buildTestApp, call, seedUser, testConfig, uuid } from "../support/fixtures.js";

describe("platform", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => db?.close());

  describe("access-token verification", () => {
    const verifier = new SupabaseAccessTokenVerifier({ jwtSecret: JWT_SECRET, issuer: ISSUER, audience: "authenticated" });
    const user = uuid();

    it("accepts a valid user token and exposes its claims", async () => {
      const identity = await verifier.verify(await accessToken(user, { email: "a@b.c" }));
      expect(identity).toMatchObject({ userId: user, email: "a@b.c", source: "supabase-jwt", claims: { role: "authenticated", sub: user } });
    });

    it.each([
      ["expired", { expiresIn: "-10m" }],
      ["wrong issuer", { issuer: "https://evil.example/auth/v1" }],
      ["wrong secret", { secret: "another-secret-another-secret-another!!" }],
      ["anon key (role anon)", { role: "anon" }],
      ["service key (role service_role)", { role: "service_role" }],
    ])("rejects a token with %s", async (_label, options) => {
      expect(await verifier.verify(await accessToken(user, options))).toBeNull();
    });

    it("rejects garbage and unsupported algorithms", async () => {
      expect(await verifier.verify("abc")).toBeNull();
      const none = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: user, role: "authenticated" })).toString("base64url")}.`;
      expect(await verifier.verify(none)).toBeNull();
    });

    it("verifies asymmetric (ES256) tokens against the project's JWKS", async () => {
      const { publicKey, privateKey } = await generateKeyPair("ES256");
      const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" };
      const es = new SupabaseAccessTokenVerifier({ issuer: ISSUER, audience: "authenticated", jwks: createLocalJWKSet({ keys: [jwk] }) });
      const token = await new SignJWT({ role: "authenticated", aud: "authenticated" })
        .setProtectedHeader({ alg: "ES256", kid: "k1" })
        .setSubject(user)
        .setIssuer(ISSUER)
        .setExpirationTime("5m")
        .sign(privateKey);
      expect((await es.verify(token))?.userId).toBe(user);
    });

    it("falls back to Supabase's /auth/v1/user for HS256 tokens when no secret is configured", async () => {
      const token = await accessToken(user);
      const remote = new SupabaseAccessTokenVerifier({
        supabaseUrl: "https://example.supabase.co",
        anonKey: "anon",
        issuer: ISSUER,
        audience: "authenticated",
        fetch: async () => new Response(JSON.stringify({ id: user }), { status: 200 }),
      });
      expect((await remote.verify(token))?.userId).toBe(user);
      const refused = new SupabaseAccessTokenVerifier({
        supabaseUrl: "https://example.supabase.co",
        anonKey: "anon",
        issuer: ISSUER,
        audience: "authenticated",
        fetch: async () => new Response("{}", { status: 401 }),
      });
      expect(await refused.verify(token)).toBeNull();
    });
  });

  describe("HTTP behaviour", () => {
    it("health endpoints need no token and reveal no configuration", async () => {
      const app = buildTestApp(db);
      const live = await call(app, "GET", "/api/v1/health/live");
      expect(await live.json()).toEqual({ status: "ok" });
      const ready = await call(app, "GET", "/api/v1/health/ready");
      expect(ready.status).toBe(200);
      const body = (await ready.json()) as { status: string; checks: Record<string, unknown> };
      expect(body.status).toBe("ok");
      expect(JSON.stringify(body)).not.toMatch(/unused-in-tests|anon-key|service-key|secret/);
    });

    it("answers unknown /api/v1 paths with the v1 error shape and keeps the legacy shape elsewhere", async () => {
      const app = buildTestApp(db);
      const v1 = await call(app, "GET", "/api/v1/nope");
      expect(v1.status).toBe(404);
      expect(await v1.json()).toMatchObject({ error: { code: "not_found" }, requestId: expect.any(String) });
      expect(await (await call(app, "GET", "/api/nope")).json()).toEqual({ error: "Not found" });
    });

    it("echoes a sane X-Request-Id and generates one otherwise", async () => {
      const app = buildTestApp(db);
      const res = await call(app, "GET", "/api/v1/health/live", { headers: { "X-Request-Id": "abc12345-req" } });
      expect(res.headers.get("x-request-id")).toBe("abc12345-req");
      const res2 = await call(app, "GET", "/api/v1/health/live", { headers: { "X-Request-Id": "<script>" } });
      expect(res2.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("sets security headers on /api/v1 responses", async () => {
      const res = await call(buildTestApp(db), "GET", "/api/v1/health/live");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    });

    it("rate-limits writes per user with Retry-After", async () => {
      const app = buildTestApp(db, { services: { rateLimiter: new RateLimiter() } });
      const user = await seedUser(db);
      const token = await accessToken(user.id);
      let last: Response | undefined;
      for (let i = 0; i < 125; i++) last = await call(app, "POST", "/api/v1/cart/items/delete", { token, body: { ids: [uuid()] } });
      expect(last?.status).toBe(429);
      expect(Number(last?.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(await last?.json()).toMatchObject({ error: { code: "rate_limited" } });
    });

    it("hides internal error details from clients", async () => {
      const app = buildTestApp(db, {
        services: { data: () => ({ asUser: () => Promise.reject(new Error("connection string postgres://secret@host")) }) as never },
      });
      const res = await call(app, "GET", "/api/v1/cart", { token: await accessToken(uuid()) });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain("secret");
      expect(JSON.parse(text)).toMatchObject({ error: { code: "internal_error", message: "Something went wrong. Please try again." } });
    });

    it("returns 503 when the database is not configured", async () => {
      const { serviceUnavailable } = await import("../../src/shared/errors/app-error.js");
      const app = buildTestApp(db, {
        env: { DATABASE_URL: "" },
        services: {
          data: () => {
            throw serviceUnavailable("DATABASE_URL is not configured on this deployment.");
          },
        },
      });
      const ready = await call(app, "GET", "/api/v1/health/ready");
      expect(ready.status).toBe(503);
      expect(await ready.json()).toMatchObject({ status: "unavailable", checks: { databaseConfigured: false } });
      const cart = await call(app, "GET", "/api/v1/cart", { token: await accessToken(uuid()) });
      expect(cart.status).toBe(503);
      expect(await cart.json()).toMatchObject({ error: { code: "service_unavailable", message: "DATABASE_URL is not configured on this deployment." } });
    });
  });

  describe("configuration", () => {
    it("validates and reports every problem by name only", () => {
      try {
        loadConfig({ DATABASE_URL: "mysql://x", DATABASE_POOL_MAX: "0", GOOGLE_CLIENT_ID: "id", AUTH_BACKEND_SESSIONS: "maybe" });
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        const message = (err as Error).message;
        expect(message).toContain("DATABASE_URL");
        expect(message).toContain("DATABASE_POOL_MAX");
        expect(message).toContain("AUTH_BACKEND_SESSIONS");
        expect(message).not.toContain("mysql://x");
      }
      expect(() => loadConfig({ GOOGLE_CLIENT_ID: "id" })).toThrow(/must be set together/);
      expect(() => loadConfig({ AUTH_BACKEND_SESSIONS: "true" })).toThrow(/requires DATABASE_URL/);
    });

    it("applies safe defaults", () => {
      const config = loadConfig({});
      expect(config.auth.backendSessions).toBe(false);
      expect(config.database.sslMode).toBe("require");
      expect(config.rateLimit.enabled).toBe(true);
      expect(missingProductionEnv({ SUPABASE_URL: "x" })).toEqual(["DATABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]);
    });

    it("builds pool settings with TLS from DATABASE_SSL_MODE, ignoring sslmode in the URL", () => {
      const cfg = testConfig({ DATABASE_URL: "postgresql://u:p@db.example.com:6543/postgres?sslmode=disable", DATABASE_POOL_MAX: "2" });
      const pool = poolConfig(cfg);
      expect(pool.ssl).toEqual({ rejectUnauthorized: false });
      expect(pool.connectionString).not.toContain("sslmode");
      expect(pool.max).toBe(2);
      const strict = poolConfig(testConfig({ DATABASE_SSL_MODE: "verify-full", DATABASE_SSL_CA: "-----BEGIN CERTIFICATE-----\\nabc" }));
      expect(strict.ssl).toEqual({ rejectUnauthorized: true, ca: "-----BEGIN CERTIFICATE-----\nabc" });
    });
  });

  describe("small pieces", () => {
    it("redacts secrets in logs", () => {
      const lines: string[] = [];
      const logger = createLogger({ sink: (line) => lines.push(line) });
      logger.info("x", { headers: { authorization: "Bearer abc.def.ghi", cookie: "s=1" }, password: "hunter2", note: "token Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop" });
      expect(lines[0]).not.toMatch(/hunter2|abc\.def|s=1|eyJhbGci/);
      expect(redact({ nested: { apiKey: "k", ok: 1 } })).toEqual({ nested: { apiKey: "[redacted]", ok: 1 } });
    });

    it("maps database errors to safe API errors", () => {
      expect(mapDatabaseError({ code: "P0001", message: "This item is no longer available." })).toMatchObject({ status: 400, message: "This item is no longer available." });
      expect(mapDatabaseError({ code: "42501", message: 'new row violates row-level security policy for table "x"' })).toMatchObject({
        status: 403,
        code: "forbidden",
        message: "You are not allowed to do that.",
      });
      // Messages the database functions raise on purpose reach the app unchanged, whatever their code.
      const raised = (code: string, message: string) => ({ code, message, where: "PL/pgSQL function public.f(uuid) line 4 at RAISE" });
      expect(mapDatabaseError(raised("22023", "You cannot follow your own shop."))).toMatchObject({ status: 400, message: "You cannot follow your own shop." });
      expect(mapDatabaseError(raised("42501", "Only admins can delete inventory products."))).toMatchObject({
        status: 403,
        message: "Only admins can delete inventory products.",
      });
      // ...but PostgreSQL's own errors with those codes stay generic.
      expect(mapDatabaseError({ code: "22P02", message: 'invalid input syntax for type uuid: "x"' })).toMatchObject({ message: "Some of the values sent are not valid." });
      expect(mapDatabaseError({ code: "23505", message: "duplicate key" })).toMatchObject({ status: 409 });
      expect(mapDatabaseError({ code: "57014", message: "canceling statement due to statement timeout" })).toMatchObject({ status: 504 });
      expect(mapDatabaseError({ cause: { code: "08006", message: "connection failure" } })).toMatchObject({ status: 503 });
      expect(mapDatabaseError(new Error("plain"))).toBeNull();
    });

    it("formats timestamps the way PostgREST did", () => {
      expect(toIsoTimestamp("2026-10-10 23:12:19.12+00")).toBe("2026-10-10T23:12:19.12+00:00");
      expect(toIsoTimestamp("2026-10-10 23:12:19+0530")).toBe("2026-10-10T23:12:19+05:30");
      expect(toIsoTimestamp("infinity")).toBe("infinity");
    });

    it("restores /api/v1 paths rewritten by vercel.json and nothing else", () => {
      expect(restoreRewrittenUrl("/api/notify?__route=%2Fapi%2Fv1%2Fcart%2Fitems&x=1")).toBe("/api/v1/cart/items?x=1");
      expect(restoreRewrittenUrl("/api/v1/cart?__route=/api/v1/cart")).toBe("/api/v1/cart");
      expect(restoreRewrittenUrl("/api/notify?__route=/api/chat")).toBe("/api/notify");
      expect(restoreRewrittenUrl("/api/notify?__route=/api/v1/../chat")).toBe("/api/notify");
      expect(restoreRewrittenUrl("/api/notify")).toBe("/api/notify");
    });

    it("only allows same-site return paths after sign-in", () => {
      expect(safeReturnPath("/orders?x=1")).toBe("/orders?x=1");
      for (const bad of ["https://evil.example", "//evil.example", "/\\evil", "javascript:alert(1)", undefined]) expect(safeReturnPath(bad)).toBe("/");
    });
  });
});
