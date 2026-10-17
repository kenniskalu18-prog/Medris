import { SignJWT } from "jose";
import { loadConfig, type AppConfig } from "../../src/config/app-config.js";
import { createApp } from "../../src/app.js";
import type { AppServices } from "../../src/container.js";
import { silentLogger } from "../../src/lib/logger.js";
import { RateLimiter } from "../../src/lib/rate-limit.js";
import { SupabaseAccessTokenVerifier } from "../../src/modules/auth/access-token.js";
import { createSessionService } from "../../src/modules/auth/session.service.js";
import { asFetch } from "./http.js";
import type { Identity } from "../../src/database/context.js";
import type { TestDatabase } from "./test-db.js";

/** Shared helpers for tests that run the API against the test database. */

export const JWT_SECRET = "test-jwt-secret-with-at-least-32-characters!";
export const SUPABASE_URL = "https://example.supabase.co";
export const ISSUER = `${SUPABASE_URL}/auth/v1`;

export function testConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "error",
    SUPABASE_URL,
    SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
    SUPABASE_JWT_SECRET: JWT_SECRET,
    DATABASE_URL: "postgres://unused-in-tests/db",
    ...env,
  });
}

/** A Supabase-style access token, signed with the test secret. */
export async function accessToken(
  userId: string,
  options: { role?: string; expiresIn?: string; issuer?: string; secret?: string; email?: string } = {},
): Promise<string> {
  return new SignJWT({ role: options.role ?? "authenticated", email: options.email ?? `${userId.slice(0, 8)}@test.dev`, aud: "authenticated" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setIssuer(options.issuer ?? ISSUER)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "1h")
    .sign(new TextEncoder().encode(options.secret ?? JWT_SECRET));
}

export function buildTestApp(testDb: TestDatabase, options: { env?: Record<string, string>; services?: Partial<AppServices> } = {}) {
  const config = testConfig(options.env);
  const data = () => testDb.data;
  const services: Partial<AppServices> = {
    config,
    logger: silentLogger,
    data,
    accessTokens: new SupabaseAccessTokenVerifier({ jwtSecret: JWT_SECRET, issuer: ISSUER, audience: "authenticated", supabaseUrl: SUPABASE_URL }),
    sessions: createSessionService(config, data),
    google: null,
    rateLimiter: new RateLimiter(),
    ...options.services,
  };
  return asFetch(createApp({ services }));
}

export function call(app: ReturnType<typeof buildTestApp>, method: string, path: string, init: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  return app.fetch(
    new Request(`https://app.test${path}`, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }),
  );
}

/** The identity the backend builds from a verified token, for calling services directly. */
export function identityOf(userId: string, email: string | null = null): Identity {
  return { userId, email, claims: { sub: userId, role: "authenticated", aud: "authenticated", ...(email ? { email } : {}) }, source: "supabase-jwt" };
}

let counter = 0;
export function uuid(): string {
  return crypto.randomUUID();
}

/* --------------------------------------------------------------- seeding */

/** A unique Nigerian-format mobile number (users.phone is unique; placing an order requires one). */
export function testPhone(): string {
  return `070${String(crypto.getRandomValues(new Uint32Array(1))[0]! % 100_000_000).padStart(8, "0")}`;
}

export async function seedUser(
  db: TestDatabase,
  options: { role?: "buyer" | "vendor" | "admin"; email?: string; phone?: string | null; password?: string; name?: string } = {},
) {
  const id = uuid();
  const n = ++counter;
  const name = options.name ?? `User ${n}`;
  const email = options.email ?? `user${n}-${id.slice(0, 6)}@test.dev`;
  const phone = options.phone === undefined ? testPhone() : options.phone;
  // As in production: the sign-up triggers on auth.users create the profile row (public.users).
  await db.query(`insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data) values ($1, $2, $3, now(), $4)`, [
    id,
    email,
    options.password ?? null,
    JSON.stringify({ name, phone }),
  ]);
  await db.query(`update public.users set name = $2, phone = $3 where id = $1`, [id, name, phone]);
  if (options.role && options.role !== "buyer") await setRole(db, id, options.role);
  return { id, email };
}

/**
 * Sets an account's role directly, for test setup only. In the app a role changes
 * through vendor verification or an admin (trigger trg_prevent_self_role_change
 * refuses anything else), so the triggers are switched off for this one statement.
 */
export async function setRole(db: TestDatabase, userId: string, role: "buyer" | "vendor" | "admin") {
  if (!/^[0-9a-f-]{36}$/.test(userId)) throw new Error(`not a uuid: ${userId}`);
  await db.query(`do $$ begin
    perform set_config('session_replication_role', 'replica', true);
    update public.users set role = '${role}' where id = '${userId}';
  end $$`);
}

export async function seedVendor(db: TestDatabase, ownerId: string, options: { verified?: boolean; active?: boolean; name?: string; referralCode?: string } = {}) {
  const sectorId = await seedSector(db);
  const id = uuid();
  await db.query(
    // A complete vendor, as the onboarding rules (trg_enforce_vendor_onboarding_requirements) demand.
    `insert into public.vendors (id, user_id, business_name, sector_id, verification_status, is_active, lat, lng, whatsapp_number, bank_name, bank_code, account_number, referral_code)
     values ($1, $2, $3, $4, $5, $6, 6.5, 3.4, '08031234567', 'Test Bank', '058', '0123456789', $7)`,
    [id, ownerId, options.name ?? `Shop ${++counter}`, sectorId, options.verified === false ? "pending" : "verified", options.active ?? true, options.referralCode ?? null],
  );
  return { id, sectorId };
}

export async function seedSector(db: TestDatabase, options: { name?: string; sortOrder?: number } = {}) {
  const id = uuid();
  const n = ++counter;
  await db.query(`insert into public.sectors (id, slug, name, sort_order) values ($1, $2, $3, $4)`, [id, `sector-${n}`, options.name ?? `Sector ${n}`, options.sortOrder ?? n]);
  return id;
}

export async function seedProduct(db: TestDatabase, vendorId: string, options: { status?: "active" | "paused" | "removed"; price?: number; name?: string } = {}) {
  const id = uuid();
  await db.query(
    `insert into public.products (id, vendor_id, name, listing_type, sale_price, status, photos, delivery_fee_mode) values ($1, $2, $3, 'sale', $4, $5, '{https://img.test/a.jpg}', 'flat')`,
    [id, vendorId, options.name ?? `Product ${++counter}`, options.price ?? 2500, options.status ?? "active"],
  );
  return id;
}

export async function seedNotification(db: TestDatabase, userId: string, options: { read?: boolean; type?: string; createdAt?: string; deleted?: boolean; archived?: boolean } = {}) {
  const id = uuid();
  await db.query(
    `insert into public.notifications (id, user_id, type, title, read, created_at, deleted_at, archived) values ($1, $2, $3, 'Hello', $4, $5, $6, $7)`,
    [id, userId, options.type ?? "system", options.read ?? false, options.createdAt ?? new Date().toISOString(), options.deleted ? new Date().toISOString() : null, options.archived ?? false],
  );
  return id;
}

export async function seedPackage(db: TestDatabase, vendorId: string, options: { name?: string; price?: number; status?: string } = {}) {
  const id = uuid();
  await db.query(`insert into public.vendor_packages (id, vendor_id, name, price, status) values ($1, $2, $3, $4, $5)`, [
    id,
    vendorId,
    options.name ?? `Package ${++counter}`,
    options.price ?? 9000,
    options.status ?? "active",
  ]);
  return id;
}

/** An order with one item per product (the buyer needs a phone; seedUser gives one). */
export async function seedOrder(
  db: TestDatabase,
  buyerId: string,
  vendorId: string,
  options: { status?: string; productIds?: string[]; total?: number; createdAt?: string; delivery?: "pickup" | "delivery" } = {},
) {
  const id = uuid();
  await db.query(
    `insert into public.orders (id, buyer_id, vendor_id, order_type, status, delivery_method, total_amount, created_at)
     values ($1, $2, $3, 'sale', $4, $5, $6, $7)`,
    [id, buyerId, vendorId, options.status ?? "pending", options.delivery ?? "pickup", options.total ?? 5000, options.createdAt ?? new Date().toISOString()],
  );
  for (const productId of options.productIds ?? []) {
    await db.query(`insert into public.order_items (order_id, product_id, quantity, unit_price) values ($1, $2, 1, 2500)`, [id, productId]);
  }
  return id;
}

export async function seedReview(db: TestDatabase, orderId: string, buyerId: string, vendorId: string, rating = 5, comment = "Great") {
  const id = uuid();
  await db.query(`insert into public.reviews (id, order_id, buyer_id, vendor_id, rating, comment) values ($1, $2, $3, $4, $5, $6)`, [
    id,
    orderId,
    buyerId,
    vendorId,
    rating,
    comment,
  ]);
  return id;
}

/**
 * Runs seed statements as a signed-in user (auth.uid() = userId), on one connection,
 * for rows whose triggers read the caller - e.g. snapshot_product_comment_author()
 * copies the commenter's name. The owner role is kept (no RLS), only the identity is set.
 */
export async function asUserSeed(db: TestDatabase, userId: string, statements: [string, unknown[]][]): Promise<void> {
  const { client, release } = await db.sqlClient();
  try {
    await client.query(`select set_config('request.jwt.claims', $1, false), set_config('request.jwt.claim.sub', $2, false)`, [
      JSON.stringify({ sub: userId, role: "authenticated" }),
      userId,
    ]);
    for (const [text, params] of statements) await client.query(text, params);
  } finally {
    await client.query(`select set_config('request.jwt.claims', '', false), set_config('request.jwt.claim.sub', '', false)`);
    release();
  }
}
