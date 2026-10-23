import crypto from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setDataContextProvider } from "../../src/database/index.js";
import { grossUpForBuyerFees } from "../../src/integrations/paystack/index.js";
import { PaymentClaimsService } from "../../src/modules/payment-claims/payment-claims.service.js";
import { PaystackCheckoutService } from "../../src/modules/paystack-checkout/paystack-checkout.service.js";
import { PaystackWebhookService } from "../../src/modules/paystack-webhook/paystack-webhook.service.js";
import { identityOf, seedOrder, seedProduct, seedUser, seedVendor } from "../support/fixtures.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

const SECRET = "sk_test_checkout_secret";

describe("paystack order checkout (issue #95)", () => {
  let db: TestDatabase;
  let on: PaystackCheckoutService;
  let off: PaystackCheckoutService;
  let hooks: PaystackWebhookService;
  let buyer: string;
  let other: string;
  let owner: string;
  let shop: string;
  let product: string;
  const savedKey = process.env.PAYSTACK_SECRET_KEY;
  const initCalls: Record<string, unknown>[] = [];
  let verifyAnswer: (reference: string) => Response = () => new Response("{}", { status: 404 });

  beforeAll(async () => {
    process.env.PAYSTACK_SECRET_KEY = SECRET;
    db = await createTestDatabase();
    setDataContextProvider(() => db.data);
    on = new PaystackCheckoutService(() => db.data, true);
    off = new PaystackCheckoutService(() => db.data, false);
    hooks = new PaystackWebhookService(() => db.data);
    buyer = (await seedUser(db)).id;
    other = (await seedUser(db)).id;
    owner = (await seedUser(db, { role: "vendor" })).id;
    shop = (await seedVendor(db, owner, { name: "Dayo" })).id;
    product = await seedProduct(db, shop);
  }, 60_000);
  beforeEach(() => {
    initCalls.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith("/transaction/initialize")) {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          initCalls.push(body);
          return new Response(JSON.stringify({ status: true, data: { authorization_url: `https://checkout.paystack.test/${body.reference}`, access_code: `ac_${body.reference}`, reference: body.reference } }), { status: 200 });
        }
        const m = /\/transaction\/verify\/([^/?]+)/.exec(u);
        if (m) return verifyAnswer(decodeURIComponent(m[1]!));
        return new Response("{}", { status: 404 });
      }),
    );
  });
  afterEach(() => {
    verifyAnswer = () => new Response("{}", { status: 404 });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    setDataContextProvider(null);
    if (savedKey === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = savedKey;
    await db.close();
  });

  const me = (id: string) => identityOf(id);
  const newOrder = async (total: number, set = "", status = "pending", delivery: "pickup" | "delivery" = "pickup") => {
    const id = await seedOrder(db, buyer, shop, { productIds: [product], total, delivery });
    if (status !== "pending") await db.query(`update public.orders set status = $2 where id = $1`, [id, status]);
    if (set) await db.query(`update public.orders set ${set} where id = $1`, [id]);
    return id;
  };
  const ok = (data: unknown) => new Response(JSON.stringify({ status: true, data }), { status: 200 });
  const paidAnswer = (reference: string, id: number, amountKobo: number) => ok({ id, status: "success", reference, amount: amountKobo, currency: "NGN", channel: "card", paid_at: new Date().toISOString() });
  const orderStatus = async (id: string) => (await db.query<{ status: string }>(`select status::text from public.orders where id = $1`, [id]))[0]!.status;
  const attempts = (orderId: string) => db.query<{ reference: string; status: string; amount_kobo: string; purpose: string }>(`select reference, status, amount_kobo::text, purpose from public.paystack_transactions where order_id = $1 order by created_at`, [orderId]);

  it("is refused while the switch is off, for other people's orders and for orders that cannot be paid", async () => {
    const o = await newOrder(1500);
    await expect(off.initialize(me(buyer), o, "https://app")).rejects.toMatchObject({ status: 404, code: "feature_disabled" });
    await expect(on.initialize(me(other), o, "https://app")).rejects.toMatchObject({ status: 403 });
    const cancelled = await newOrder(1500, "", "cancelled");
    await expect(on.initialize(me(buyer), cancelled, "https://app")).rejects.toMatchObject({ status: 400 });
  });

  it("charges the order amount from the database plus Paystack's fee (paid by the buyer)", async () => {
    const o = await newOrder(1500);
    const out = await on.initialize(me(buyer), o, "https://app.test");
    const { grossKobo, feeKobo } = grossUpForBuyerFees(150_000);
    expect(out).toMatchObject({ amountNaira: grossKobo / 100, feeNaira: feeKobo / 100, orderAmountNaira: 1500 });
    expect(initCalls).toHaveLength(1);
    expect(initCalls[0]).toMatchObject({ amount: grossKobo, email: expect.any(String), metadata: { order_id: o, purpose: "order_payment", net_kobo: 150_000, fee_kobo: feeKobo } });
    expect(String(initCalls[0]!.callback_url)).toContain(`https://app.test/?paid=1&reference=${out.reference}`);
    // the order's own payment row carries the order amount only, never the fee
    expect(Number((await db.query<{ amount: string }>(`select amount::text from public.payments where order_id = $1 and provider_reference = $2`, [o, out.reference]))[0]!.amount)).toBe(1500);
  });

  it("a double tap gets the same link and starts one payment", async () => {
    const o = await newOrder(1500);
    const a = await on.initialize(me(buyer), o, "https://app");
    const b = await on.initialize(me(buyer), o, "https://app");
    expect(b.reference).toBe(a.reference);
    expect(b.authorizationUrl).toBe(a.authorizationUrl);
    expect(initCalls).toHaveLength(1);
    expect(await attempts(o)).toHaveLength(1);
  });

  it("two taps at the same moment leave exactly one open attempt", async () => {
    const o = await newOrder(1500);
    const results = await Promise.allSettled([on.initialize(me(buyer), o, "https://app"), on.initialize(me(buyer), o, "https://app")]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect((await attempts(o)).filter((x) => x.status === "initialized")).toHaveLength(1);
  });

  it("an edited order amount abandons the old attempt and starts a new one", async () => {
    const o = await newOrder(1500);
    const first = await on.initialize(me(buyer), o, "https://app");
    await db.query(`update public.orders set total_amount = 2000 where id = $1`, [o]);
    const second = await on.initialize(me(buyer), o, "https://app");
    expect(second.reference).not.toBe(first.reference);
    const rows = await attempts(o);
    expect(rows.find((r) => r.reference === first.reference)!.status).toBe("abandoned");
    expect(rows.find((r) => r.reference === second.reference)!.status).toBe("initialized");
  });

  it("when Paystack says it was paid with less, nothing is settled", async () => {
    const o = await newOrder(1500);
    const { reference } = await on.initialize(me(buyer), o, "https://app");
    verifyAnswer = () => paidAnswer(reference, 7001, 100_000); // less than the recorded amount
    const res = await on.status(me(buyer), reference);
    expect(res.status).toBe("initialized");
    expect(await orderStatus(o)).toBe("pending");
    expect((await db.query<{ status: string }>(`select status from public.payments where order_id = $1`, [o]))[0]!.status).toBe("pending");
  });

  it("the buyer coming back and the webhook at the same moment settle once", async () => {
    const o = await newOrder(1500);
    const { reference } = await on.initialize(me(buyer), o, "https://app");
    const { grossKobo } = grossUpForBuyerFees(150_000);
    verifyAnswer = () => paidAnswer(reference, 7002, grossKobo);
    const raw = JSON.stringify({ event: "charge.success", data: { id: 7002, reference } });
    const sig = crypto.createHmac("sha512", SECRET).update(raw).digest("hex");
    const [status, hook] = await Promise.all([on.status(me(buyer), reference), hooks.handle(raw, sig)]);
    expect(hook.status).toBe(200);
    expect(status.status).toBe("success");
    expect((await db.query<{ status: string }>(`select status from public.payments where order_id = $1`, [o]))[0]!.status).toBe("paid");
    const toVendor = await db.query(`select 1 from public.notifications where user_id = $1 and title = 'Order paid: deliver now' and target_params->>'orderId' = $2`, [owner, o]);
    expect(toVendor).toHaveLength(1);
    // asking again changes nothing
    expect((await on.status(me(buyer), reference)).status).toBe("success");
    expect((await db.query(`select 1 from public.notifications where user_id = $1 and title = 'Order paid: deliver now' and target_params->>'orderId' = $2`, [owner, o]))).toHaveLength(1);
  });

  it("only the buyer (or an admin) can see a payment's status", async () => {
    const o = await newOrder(1500);
    const { reference } = await on.initialize(me(buyer), o, "https://app");
    await expect(on.status(me(other), reference)).rejects.toMatchObject({ status: 404 });
  });

  it("pay after delivery: the deposit first, then the exact balance after delivery", async () => {
    const o = await newOrder(10_000, "payment_timing = 'pay_after', payment_deposit_percent = 25, delivery_fee = 1000", "pending", "delivery");
    const dep = await on.initialize(me(buyer), o, "https://app");
    expect(dep.orderAmountNaira).toBe(2250); // (10,000 - 1,000 delivery) x 25%
    verifyAnswer = (ref) => paidAnswer(ref, 7003, Math.round(dep.amountNaira * 100));
    await on.status(me(buyer), dep.reference);
    expect(await orderStatus(o)).toBe("confirmed");
    expect((await attempts(o)).find((r) => r.reference === dep.reference)!.purpose).toBe("order_payment");

    await db.query(`update public.orders set status = 'handed_over' where id = $1`, [o]);
    const bal = await on.initialize(me(buyer), o, "https://app");
    expect(bal.orderAmountNaira).toBe(7750); // exactly what is left
    expect((await attempts(o)).find((r) => r.reference === bal.reference)!.purpose).toBe("order_balance");
    verifyAnswer = (ref) => paidAnswer(ref, 7004, Math.round(bal.amountNaira * 100));
    await on.status(me(buyer), bal.reference);
    expect(await orderStatus(o)).not.toBe("confirmed"); // never back a step
    await expect(on.initialize(me(buyer), o, "https://app")).rejects.toMatchObject({ status: 400 }); // nothing left to pay
  });

  it("an order being paid with Paystack cannot also be reported as a bank transfer", async () => {
    const o = await newOrder(1500);
    await on.initialize(me(buyer), o, "https://app");
    await expect(new PaymentClaimsService(() => db.data).report(me(buyer), o, 1500)).rejects.toMatchObject({ status: 400 });
  });
});
