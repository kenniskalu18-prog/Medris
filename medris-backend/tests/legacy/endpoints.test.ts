import crypto from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";
import { accessToken, buildTestApp, seedNotification, seedProduct, seedUser, seedVendor, uuid } from "../support/fixtures.js";
import { TEST_ENV, jsonRequest, setTestEnv, stubFetch } from "../helpers.js";

/**
 * The original endpoints, end to end against the test database: same paths,
 * bodies, statuses and responses as before; the database writes they make are
 * asserted directly. External services (Paystack, Supabase Auth/Storage,
 * Resend, push) are stubbed.
 */
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

async function order(buyerId: string, vendorId: string, values: { status?: string; total?: number; payoutStatus?: string; createdAt?: string } = {}) {
  const id = uuid();
  await db.query(
    `insert into public.orders (id, buyer_id, vendor_id, order_type, status, delivery_method, total_amount, payout_status, created_at)
     values ($1, $2, $3, 'sale', $4, 'pickup', $5, $6, $7)`,
    [id, buyerId, vendorId, values.status ?? "pending", values.total ?? 5000, values.payoutStatus ?? "not_applicable", values.createdAt ?? new Date().toISOString()],
  );
  return id;
}

async function marketplace() {
  const owner = await seedUser(db, { role: "vendor" });
  const vendor = await seedVendor(db, owner.id);
  const buyer = await seedUser(db);
  return { owner, vendor, buyer };
}

describe("routing and guards", () => {
  it("returns JSON 404 for unknown API paths", async () => {
    const res = await app.fetch(new Request("https://app.test/api/does-not-exist"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it.each(["/api/chat", "/api/notify", "/api/auth-otp", "/api/initiate-payment", "/api/order-payout-action"])("%s only accepts POST", async (path) => {
    const res = await app.fetch(new Request(`https://app.test${path}`));
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: "Method not allowed" });
  });

  it("daily cron requires the shared secret", async () => {
    expect((await app.fetch(new Request("https://app.test/api/daily-cron"))).status).toBe(401);
    expect((await app.fetch(new Request("https://app.test/api/daily-cron", { method: "PUT" }))).status).toBe(405);
  });
});

describe("/api/daily-cron", () => {
  it("runs the billing jobs and trims read notifications older than 60 days", async () => {
    const user = await seedUser(db);
    const old = new Date(Date.now() - 61 * 86_400_000).toISOString();
    const oldRead = await seedNotification(db, user.id, { read: true, createdAt: old });
    const oldUnread = await seedNotification(db, user.id, { read: false, createdAt: old });
    const res = await app.fetch(new Request("https://app.test/api/daily-cron", { headers: { Authorization: `Bearer ${TEST_ENV.CRON_SECRET}` } }));
    expect(res.status).toBe(200);
    // The billing jobs' own summaries (process_listing_billing_reminders, process_commission_deadline_reminders).
    expect(await res.json()).toEqual({
      ok: true,
      notificationsTrimmed: true,
      listings_paused: 0,
      notifications_created: 0,
      processed_at: expect.any(String),
      commissionReminders: { notifications_created: 0, processed_at: expect.any(String) },
    });
    const left = (await db.query<{ id: string }>(`select id from public.notifications where user_id = $1`, [user.id])).map((r) => r.id);
    expect(left).toEqual([oldUnread]);
    expect(left).not.toContain(oldRead);
  });
});

describe("/api/order-reminders", () => {
  it("accepts only the exact bearer secret", async () => {
    expect((await app.fetch(new Request("https://app.test/api/order-reminders", { method: "POST", headers: { "x-cron-secret": TEST_ENV.CRON_SECRET } }))).status).toBe(401);
  });

  it("notifies both sides of an old confirmed order once per 30 minutes", async () => {
    const { owner, vendor, buyer } = await marketplace();
    const id = await order(buyer.id, vendor.id, { status: "confirmed", createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString() });
    const run = () => app.fetch(new Request("https://app.test/api/order-reminders", { method: "POST", headers: { Authorization: `Bearer ${TEST_ENV.CRON_SECRET}` } }));
    const first = (await (await run()).json()) as { checked: number; reminded: number };
    expect(first.reminded).toBeGreaterThanOrEqual(1);
    const notes = await db.query<{ user_id: string; type: string; target_params: { orderId: string } }>(
      // (Placing the order already notified both sides through the database's order triggers.)
      `select user_id, type, target_params from public.notifications where target_params->>'orderId' = $1 and type = 'order_reminder'`,
      [id],
    );
    expect(notes.map((n) => n.user_id).sort()).toEqual([buyer.id, owner.id].sort());
    expect(notes.every((n) => n.type === "order_reminder")).toBe(true);
    // Stamped, so the next run within 30 minutes skips it.
    await run();
    expect(await db.query(`select 1 from public.notifications where target_params->>'orderId' = $1 and type = 'order_reminder'`, [id])).toHaveLength(2);
  });
});

describe("/api/notify", () => {
  it("rejects database calls without the webhook secret", async () => {
    const res = await app.fetch(jsonRequest("/api/notify", { notificationId: uuid() }));
    expect(res.status).toBe(401);
  });

  it("validates the call id before touching the database", async () => {
    const res = await app.fetch(jsonRequest("/api/notify", { action: "decline-call", callId: "nope", token: "x" }));
    expect(res.status).toBe(400);
  });

  it("decline-call only works with the token minted for that call and callee", async () => {
    const caller = await seedUser(db);
    const callee = await seedUser(db, { role: "vendor" });
    const shop = await seedVendor(db, callee.id);
    const conversation = uuid();
    await db.query(`insert into public.conversations (id, buyer_id, vendor_id) values ($1, $2, $3)`, [conversation, caller.id, shop.id]);
    const callId = uuid();
    await db.query(`insert into public.voice_calls (id, conversation_id, caller_id, callee_id, status) values ($1, $2, $3, $4, 'ringing')`, [callId, conversation, caller.id, callee.id]);
    const token = crypto.createHmac("sha256", TEST_ENV.SUPABASE_SERVICE_ROLE_KEY).update(`call:${callId}:${callee.id}`).digest("hex");
    expect((await app.fetch(jsonRequest("/api/notify", { action: "decline-call", callId, token: "wrong" }))).status).toBe(401);
    expect(await (await app.fetch(jsonRequest("/api/notify", { action: "decline-call", callId, token }))).json()).toEqual({ ok: true });
    const [row] = await db.query<{ status: string; ended_at: string | null }>(`select status, ended_at from public.voice_calls where id = $1`, [callId]);
    expect(row?.status).toBe("declined");
    expect(row?.ended_at).not.toBeNull();
  });

  it("e-mails and skips push for a user who has the app open", async () => {
    const user = await seedUser(db, { email: "notify-me@example.com" });
    const id = await seedNotification(db, user.id, { type: "new_order" });
    await db.query(`insert into public.app_presence (user_id, seen_at) values ($1, now())`, [user.id]);
    vi.stubEnv("RESEND_API_KEY", "re_test");
    const { calls } = stubFetch([{ method: "POST", match: "api.resend.com/emails", json: { id: "email_1" } }]);
    const res = await app.fetch(jsonRequest("/api/notify", { notificationId: id }, { headers: { "x-webhook-secret": TEST_ENV.EMAIL_WEBHOOK_SECRET } }));
    expect(await res.json()).toMatchObject({ email: { sent: true }, push: { sent: 0, reason: "user is in the app" } });
    expect(JSON.parse(calls[0]!.body!).to).toBe("notify-me@example.com");
  });

  it("reports a missing notification without failing", async () => {
    const res = await app.fetch(jsonRequest("/api/notify", { notificationId: uuid() }, { headers: { "x-webhook-secret": TEST_ENV.EMAIL_WEBHOOK_SECRET } }));
    expect(await res.json()).toEqual({ email: { sent: false, reason: "notification not found" }, push: { sent: 0 } });
  });
});

describe("/api/vendor-payments", () => {
  it("rejects unknown and prototype-named actions", async () => {
    for (const action of ["list-banks", "toString", "constructor"]) {
      const res = await app.fetch(jsonRequest("/api/vendor-payments", { action }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Unknown payment action" });
    }
    expect((await app.fetch(jsonRequest("/api/listing-payments", { action: "nope" }))).status).toBe(400);
    expect(await (await app.fetch(new Request("https://app.test/api/vendor-payments"))).json()).toEqual({ error: "payment reference is required" });
  });

  it("r2 presign refuses folders outside the public image folders", async () => {
    const res = await app.fetch(jsonRequest("/api/vendor-payments", { action: "r2-presign-upload", accessToken: "t", key: "vendor-docs/x.pdf", contentType: "application/pdf" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown upload folder." });
  });

  it("starts a ₦999 listing payment only for the owner's own monthly listing", async () => {
    const { owner, vendor, buyer } = await marketplace();
    const product = await seedProduct(db, vendor.id);
    await db.query(`update public.products set billing_model = 'monthly', billing_status = 'pending_payment' where id = $1`, [product]);
    const { calls } = stubFetch([{ method: "POST", match: "api.paystack.co/transaction/initialize", json: { status: true, data: { authorization_url: "https://checkout.paystack.com/x" } } }]);

    const notMine = await app.fetch(jsonRequest("/api/vendor-payments", { action: "pay-listing", kind: "product", id: product, accessToken: await accessToken(buyer.id) }));
    expect(notMine.status).toBe(403);

    const res = await app.fetch(jsonRequest("/api/vendor-payments", { action: "pay-listing", kind: "product", id: product, accessToken: await accessToken(owner.id) }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorization_url: string; reference: string; amount: number };
    expect(body).toMatchObject({ authorization_url: "https://checkout.paystack.com/x", amount: 999 });
    const [row] = await db.query<{ billing_status: string; billing_reference: string; status: string }>(`select billing_status, billing_reference, status from public.products where id = $1`, [product]);
    expect(row).toEqual({ billing_status: "pending_payment", billing_reference: body.reference, status: "paused" });
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ amount: 99900, reference: body.reference, metadata: { listing_id: product, vendor_id: vendor.id, kind: "product" } });
    const intents = await db.query(`select user_id, status from public.listing_payment_intents where reference = $1`, [body.reference]);
    expect(intents).toEqual([{ user_id: owner.id, status: "pending" }]);
  });

  it("sets up monthly card billing with a server-computed amount", async () => {
    const { owner, vendor } = await marketplace();
    await db.query(`update public.vendors set billing_model = 'monthly' where id = $1`, [vendor.id]);
    await seedProduct(db, vendor.id);
    stubFetch([{ method: "POST", match: "transaction/initialize", json: { status: true, data: { authorization_url: "https://checkout.paystack.com/b" } } }]);
    const res = await app.fetch(jsonRequest("/api/vendor-payments", { action: "setup-monthly-billing", accessToken: await accessToken(owner.id) }));
    const body = (await res.json()) as { reference: string };
    expect(res.status).toBe(200);
    const [charge] = await db.query<{ amount: string; listing_count: number; status: string }>(`select amount::text, listing_count, status from public.vendor_monthly_charges where provider_reference = $1`, [body.reference]);
    expect(charge).toEqual({ amount: "1500", listing_count: 1, status: "pending" });
  });

  it("starts a commission payment through create_commission_payment_intent as the vendor", async () => {
    const { owner, vendor, buyer } = await marketplace();
    // Only commission on completed orders counts (create_commission_payment_intent()).
    const completed = await order(buyer.id, vendor.id, { status: "completed" });
    await db.query(`insert into public.commission_charges (vendor_id, order_id, amount, status) values ($1, $2, 750, 'owed')`, [vendor.id, completed]);
    const { calls } = stubFetch([{ method: "POST", match: "transaction/initialize", json: { status: true, data: { authorization_url: "https://checkout.paystack.com/c" } } }]);
    const res = await app.fetch(jsonRequest("/api/vendor-payments", { action: "pay-commission", accessToken: await accessToken(owner.id) }));
    expect(res.status).toBe(200);
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ amount: 75000 });
  });
});

describe("Paystack", () => {
  const sign = (body: string) => crypto.createHmac("sha512", TEST_ENV.PAYSTACK_SECRET_KEY).update(body).digest("hex");
  const webhook = (payload: unknown) => {
    const body = JSON.stringify(payload);
    return app.fetch(new Request("https://app.test/api/paystack-webhook", { method: "POST", body, headers: { "x-paystack-signature": sign(body) } }));
  };

  it("rejects an invalid signature", async () => {
    const res = await app.fetch(new Request("https://app.test/api/paystack-webhook", { method: "POST", body: "{}", headers: { "x-paystack-signature": "bad" } }));
    expect(res.status).toBe(401);
  });

  it("starts a card payment for the buyer's own order and marks it paid on charge.success", async () => {
    const { vendor, buyer } = await marketplace();
    const id = await order(buyer.id, vendor.id, { total: 4200 });
    const { calls } = stubFetch([{ method: "POST", match: "transaction/initialize", json: { status: true, data: { authorization_url: "https://checkout.paystack.com/o" } } }]);

    const stranger = await seedUser(db);
    const refused = await app.fetch(jsonRequest("/api/initiate-payment", { orderId: id, accessToken: await accessToken(stranger.id) }));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "not authorized" }); // create_payment_intent()'s own message, kept by the port

    const res = await app.fetch(jsonRequest("/api/initiate-payment", { orderId: id, accessToken: await accessToken(buyer.id) }));
    const body = (await res.json()) as { reference: string };
    expect(res.status).toBe(200);
    // The amount comes from the order, in kobo - never the client's: a sale's total (B2, see below).
    const [due] = await db.query<{ amount: string }>(`select total_amount::text as amount from public.orders where id = $1`, [id]);
    const kobo = Math.round(Number(due!.amount) * 100);
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ amount: kobo, reference: body.reference });

    expect(await (await webhook({ event: "charge.success", data: { reference: body.reference, status: "success", amount: kobo } })).json()).toEqual({ received: true });
    const [payment] = await db.query<{ status: string; paid_at: string | null }>(`select status, paid_at from public.payments where provider_reference = $1`, [body.reference]);
    expect(payment?.status).toBe("paid");
    expect(payment?.paid_at).not.toBeNull();
  });

  // BASELINE_FINDINGS B2: for a pay-before order the order trigger sets deposit_amount = total_amount,
  // and the database's create_payment_intent() charges total + deposit - twice the price. The
  // backend's port (PaymentClaimsService.paymentIntent) charges a sale's total once.
  it("charges a pay-before order's total exactly once", async () => {
    const { vendor, buyer } = await marketplace();
    const id = await order(buyer.id, vendor.id, { total: 4200 });
    const { calls } = stubFetch([{ method: "POST", match: "transaction/initialize", json: { status: true, data: { authorization_url: "https://checkout.paystack.com/o" } } }]);
    await app.fetch(jsonRequest("/api/initiate-payment", { orderId: id, accessToken: await accessToken(buyer.id) }));
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ amount: 420000 });
  });

  it("settles a commission payment and every owed charge", async () => {
    const { vendor } = await marketplace();
    await db.query(`insert into public.commission_charges (vendor_id, amount, status) values ($1, 300, 'owed'), ($1, 200, 'owed')`, [vendor.id]);
    await db.query(`insert into public.commission_settlements (vendor_id, amount, status, provider_reference) values ($1, 500, 'pending', 'commission_xyz')`, [vendor.id]);
    await webhook({ event: "charge.success", data: { reference: "commission_xyz", status: "success", amount: 50000 } });
    expect(await db.query(`select status from public.commission_charges where vendor_id = $1 and status = 'owed'`, [vendor.id])).toHaveLength(0);
    expect(await db.query(`select status from public.commission_settlements where provider_reference = 'commission_xyz'`)).toEqual([{ status: "paid" }]);
  });

  it("activates monthly billing from a billing_ reference, keeping fields Paystack did not send", async () => {
    const { vendor } = await marketplace();
    await db.query(`update public.vendors set paystack_customer_code = 'CUS_old' where id = $1`, [vendor.id]);
    await db.query(`insert into public.vendor_monthly_charges (vendor_id, listing_count, amount, status, provider_reference) values ($1, 1, 1500, 'pending', 'billing_abc')`, [vendor.id]);
    await webhook({ event: "charge.success", data: { reference: "billing_abc", status: "success", amount: 150000, authorization: { authorization_code: "AUTH_1" } } });
    const [v] = await db.query<{ monthly_billing_status: string; paystack_authorization_code: string; paystack_customer_code: string }>(
      `select monthly_billing_status, paystack_authorization_code, paystack_customer_code from public.vendors where id = $1`,
      [vendor.id],
    );
    expect(v).toEqual({ monthly_billing_status: "active", paystack_authorization_code: "AUTH_1", paystack_customer_code: "CUS_old" });
  });

  it("activates a ₦999 monthly listing named in the metadata, once", async () => {
    const { vendor } = await marketplace();
    const product = await seedProduct(db, vendor.id, { status: "paused" });
    await db.query(`update public.products set billing_model = 'monthly', billing_status = 'pending_payment', billing_reference = 'levro_listing_1' where id = $1`, [product]);
    const payload = {
      event: "charge.success",
      data: { reference: "levro_listing_1", status: "success", amount: 99900, metadata: { purpose: "levromart_listing_monthly", kind: "product", listing_id: product, vendor_id: vendor.id } },
    };
    expect((await webhook(payload)).status).toBe(200);
    const [row] = await db.query<{ status: string; billing_status: string; billing_reference: string | null; paid: boolean }>(
      `select status, billing_status, billing_reference, billing_paid_until > now() + interval '27 days' as paid from public.products where id = $1`,
      [product],
    );
    expect(row).toEqual({ status: "active", billing_status: "active", billing_reference: null, paid: true });
    // A retried webhook does not extend the period again.
    const before = await db.query(`select billing_paid_until from public.products where id = $1`, [product]);
    expect((await webhook(payload)).status).toBe(200);
    expect(await db.query(`select billing_paid_until from public.products where id = $1`, [product])).toEqual(before);
  });
});

describe("/api/order-payout-action", () => {
  // KNOWN ISSUE (docs/BASELINE_FINDINGS.md): the live transition_order_status() lets only the vendor
  // complete an order, so "release" cannot complete it for a buyer (or an admin). These tests describe
  // what the endpoint does against the real database today.
  it("release: a stranger is refused, and the database refuses a buyer completing the order", async () => {
    const { vendor, buyer } = await marketplace();
    const id = await order(buyer.id, vendor.id, { status: "handed_over" });
    const stranger = await seedUser(db);
    const refused = await app.fetch(jsonRequest("/api/order-payout-action", { action: "release", orderId: id, accessToken: await accessToken(stranger.id) }));
    expect(refused.status).toBe(403);

    const res = await app.fetch(jsonRequest("/api/order-payout-action", { action: "release", orderId: id, accessToken: await accessToken(buyer.id) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "buyers may only cancel eligible orders or return handed-over rentals" });
    expect(await db.query(`select status from public.orders where id = $1`, [id])).toEqual([{ status: "handed_over" }]);
  });

  it("vendor-decline cancels through vendor_decline_order as the vendor and refunds a paid card order", async () => {
    const { owner, vendor, buyer } = await marketplace();
    const id = await order(buyer.id, vendor.id, { status: "pending", payoutStatus: "held" });
    await db.query(`insert into public.payments (order_id, payment_type, amount, method, status, provider_reference, paid_at) values ($1, 'sale_price', 5000, 'card', 'paid', 'medris_ref1', now())`, [id]);
    const { calls } = stubFetch([{ method: "POST", match: "api.paystack.co/refund", json: { status: true, data: {} } }]);
    const res = await app.fetch(jsonRequest("/api/order-payout-action", { action: "vendor-decline", orderId: id, reason: "Out of stock", accessToken: await accessToken(owner.id) }));
    expect(await res.json()).toEqual({ cancelled: true, refunded: true });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ transaction: "medris_ref1" });
    expect(await db.query(`select status, payout_status, cancellation_reason from public.orders where id = $1`, [id])).toEqual([
      { status: "cancelled", payout_status: "refunded", cancellation_reason: "Out of stock" },
    ]);
  });

  it("refund and mark-manual are admin-only", async () => {
    const { vendor, buyer } = await marketplace();
    const id = await order(buyer.id, vendor.id, { status: "completed", payoutStatus: "held" });
    const buyerToken = await accessToken(buyer.id);
    expect((await app.fetch(jsonRequest("/api/order-payout-action", { action: "refund", orderId: id, accessToken: buyerToken }))).status).toBe(403);
    expect((await app.fetch(jsonRequest("/api/order-payout-action", { action: "mark-manual", orderId: id, accessToken: buyerToken }))).status).toBe(403);
  });

  // KNOWN ISSUE (docs/BASELINE_FINDINGS.md): the live orders table only allows payout_status
  // not_applicable / held / released / refunded, so "paid_manual" is refused. The app never calls this
  // action. The error must not leak the SQL or its values.
  it("mark-manual fails on the real schema without leaking the query, and changes nothing", async () => {
    const { vendor, buyer } = await marketplace();
    const id = await order(buyer.id, vendor.id, { status: "completed", payoutStatus: "held" });
    const admin = await seedUser(db, { role: "admin" });
    const res = await app.fetch(jsonRequest("/api/order-payout-action", { action: "mark-manual", orderId: id, accessToken: await accessToken(admin.id) }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'new row for relation "orders" violates check constraint "orders_payout_status_check"' });
    expect(await db.query(`select payout_status from public.orders where id = $1`, [id])).toEqual([{ payout_status: "held" }]);
  });

  it("answers 404 for an unknown or malformed order id", async () => {
    const user = await seedUser(db);
    const token = await accessToken(user.id);
    for (const orderId of [uuid(), "not-a-uuid"]) {
      const res = await app.fetch(jsonRequest("/api/order-payout-action", { action: "release", orderId, accessToken: token }));
      expect(res.status).toBe(404);
    }
  });
});

describe("/api/auth-otp", () => {
  it("issues a code to admins only and verifies it once", async () => {
    const admin = await seedUser(db, { role: "admin" });
    await db.query(`update public.users set otp_verified_at = now() - interval '8 days' where id = $1`, [admin.id]);
    const token = await accessToken(admin.id);
    expect(await (await app.fetch(jsonRequest("/api/auth-otp", { action: "send", accessToken: token }))).json()).toEqual({ ok: true, otpRequired: true });
    const [otp] = await db.query<{ code: string }>(`select code from public.admin_login_otps where user_id = $1`, [admin.id]);
    expect(otp?.code).toMatch(/^\d{6}$/);

    expect(await (await app.fetch(jsonRequest("/api/auth-otp", { action: "verify", accessToken: token, code: "000000" }))).json()).toEqual({ ok: false, error: "That code is incorrect or has expired." });
    expect(await (await app.fetch(jsonRequest("/api/auth-otp", { action: "verify", accessToken: token, code: otp!.code }))).json()).toEqual({ ok: true });
    expect(await (await app.fetch(jsonRequest("/api/auth-otp", { action: "verify", accessToken: token, code: otp!.code }))).json()).toMatchObject({ ok: false });

    const buyer = await seedUser(db);
    const buyerToken = await accessToken(buyer.id);
    expect(await (await app.fetch(jsonRequest("/api/auth-otp", { action: "send", accessToken: buyerToken }))).json()).toEqual({ ok: true, otpRequired: false });
    expect((await app.fetch(jsonRequest("/api/auth-otp", { action: "verify", accessToken: buyerToken, code: "1" }))).status).toBe(403);
  });
});

describe("link previews", () => {
  it("fills the preview tags from the database for a verified storefront", async () => {
    const { vendor } = await marketplace();
    await db.query(`update public.vendors set business_name = 'Ada <Shop>', bio = 'Fresh bread' where id = $1`, [vendor.id]);
    vi.stubEnv("STATIC_ASSETS_DIR", new URL("../fixtures/static", import.meta.url).pathname);
    const res = await app.fetch(new Request(`https://app.test/s/${vendor.id}`, { headers: { host: "levromart.test" } }));
    const html = await res.text();
    expect(html).toContain("Ada &lt;Shop&gt; | Levromart");
    expect(html).toContain(`https://levromart.test/api/delete-account?ogstore=${vendor.id}`);
  });
});
