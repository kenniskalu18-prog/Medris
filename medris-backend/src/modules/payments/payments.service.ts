import { AppError } from "../../shared/errors/app-error.js";
import { PaymentClaimsService } from "../payment-claims/payment-claims.service.js";
import { findPgError } from "../../database/errors.js";
import { getDataContext } from "../../database/index.js";
import { OrdersRepository } from "../../database/repositories/orders.repository.js";
import { initializeTransaction, isValidWebhookSignature, verifyTransaction, type PaystackTransaction } from "../../integrations/paystack.js";
import type { ServiceResult } from "../../shared/types/service.js";
import { identityFromAccessToken } from "../auth/caller.js";
import { MONTHLY_LISTING_KOBO, settleListingPaymentFromWebhook } from "../vendor-payments/listing-payment.service.js";
import { settleReference } from "./settlement.service.js";

/**
 * Card payments for orders through Paystack:
 *  - start a checkout for an order (amount from the database, never the client);
 *  - confirm right after checkout (the webhook stays the source of truth);
 *  - the signed Paystack webhook that settles payments.
 */

export async function initiatePayment(body: { orderId?: string; accessToken?: string }, origin: string): Promise<ServiceResult> {
  const { orderId, accessToken } = body;
  if (!orderId || !accessToken) return { status: 400, body: { error: "orderId and accessToken are required" } };

  // The port of create_payment_intent() checks "this order belongs to you" (and charges the total once: B2).
  const me = await identityFromAccessToken(accessToken);
  if (!me) return { status: 400, body: { error: "Could not start payment." } };
  const data = getDataContext();
  let intent: { reference: string; amount: number };
  try {
    [intent] = (await new PaymentClaimsService(() => data).paymentIntent(me, orderId)) as [{ reference: string; amount: number }];
  } catch (err) {
    if (err instanceof AppError && err.status < 500) return { status: 400, body: { error: err.message || "Could not start payment." } };
    const pg = findPgError(err);
    if (!pg) throw err;
    return { status: 400, body: { error: pg.message || "Could not start payment." } };
  }
  const { reference, amount } = intent;

  const orderRow = await data.asService((tx) => new OrdersRepository(tx).checkoutContacts(orderId));
  const email = orderRow?.buyer?.email;
  if (!email) return { status: 400, body: { error: "Could not resolve buyer email." } };

  // Split payment: a vendor with payouts set up receives their cut at
  // settlement through their Paystack subaccount; otherwise the full amount
  // lands on the platform balance for a manual payout.
  const subaccountCode = orderRow?.vendor?.paystack_subaccount_code || null;
  const { res: initRes, json: initJson } = await initializeTransaction({
    email,
    amount: Math.round(Number(amount) * 100), // kobo
    reference,
    callback_url: `${origin}/?paid=1&reference=${encodeURIComponent(reference)}&orderId=${encodeURIComponent(orderId)}`,
    ...(subaccountCode ? { subaccount: subaccountCode } : {}),
  });
  if (!initRes.ok || !initJson.status) return { status: 400, body: { error: initJson.message || "Paystack error" } };
  return { status: 200, body: { authorization_url: initJson.data?.authorization_url, reference } };
}

export async function verifyPayment(reference: string | undefined): Promise<ServiceResult> {
  if (!reference) return { status: 400, body: { error: "reference is required" } };
  const { res, json: verifyJson } = await verifyTransaction(reference);
  if (!res.ok || !verifyJson.status) return { status: 400, body: { error: verifyJson.message || "Verify failed" } };
  if (verifyJson.data?.status === "success") await settleReference(reference, verifyJson.data);
  return { status: 200, body: { status: verifyJson.data?.status } };
}

export async function handlePaystackWebhook(rawBody: string, signature: string | undefined): Promise<ServiceResult> {
  if (!isValidWebhookSignature(rawBody, signature)) return { status: 401, body: { error: "Invalid signature" } };
  const event = JSON.parse(rawBody) as { event?: string; data?: PaystackTransaction };
  if (event.event === "charge.success") {
    const tx = event.data || {};
    const metadata = (tx.metadata || {}) as Record<string, unknown>;
    // A successful ₦999 listing payment activates that exact listing even if
    // the vendor's browser closed before the callback.
    if (
      metadata?.purpose === "levromart_listing_monthly" &&
      metadata?.listing_id &&
      metadata?.vendor_id &&
      (metadata?.kind === "product" || metadata?.kind === "package") &&
      tx.status === "success" &&
      Number(tx.amount) === MONTHLY_LISTING_KOBO
    ) {
      await settleListingPaymentFromWebhook(tx.reference as string, metadata);
    } else {
      await settleReference(tx.reference as string, tx);
    }
  }
  return { status: 200, body: { received: true } };
}
