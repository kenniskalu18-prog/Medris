import type { Identity } from "../../database/context.js";
import { findPgError } from "../../database/errors.js";
import { getDataContext } from "../../database/index.js";
import { BillingRepository } from "../../database/repositories/billing.repository.js";
import { UsersRepository } from "../../database/repositories/users.repository.js";
import { VendorsRepository } from "../../database/repositories/vendors.repository.js";
import { identityFromAccessToken } from "../auth/caller.js";
import { createSubaccount as paystackCreateSubaccount, initializeTransaction, resolveBankAccount } from "../../integrations/paystack.js";
import type { ServiceResult } from "../../shared/types/service.js";
import { AppError } from "../../shared/errors/app-error.js";
import { CommissionService } from "../commission/commission.service.js";

/**
 * Vendor payout set-up and the two vendor billing payments:
 *  - Paystack subaccount (bank account verified with Paystack first),
 *  - settling owed commission by card,
 *  - setting up monthly card billing.
 */

/** The caller's vendor row, read as the caller so RLS applies (as before, with their own token). */
async function ownVendorRow(me: Identity) {
  return getDataContext().asUser(me, (tx) => new VendorsRepository(tx).firstOwnedBy(me.userId));
}

export async function createSubaccount(body: Record<string, unknown>): Promise<ServiceResult> {
  const { accessToken, bankCode, accountNumber } = body as { accessToken?: string; bankCode?: string; accountNumber?: string };
  if (!accessToken || !bankCode || !accountNumber) return { status: 400, body: { error: "accessToken, bankCode and accountNumber are required" } };

  const me = await identityFromAccessToken(accessToken);
  if (!me) return { status: 401, body: { error: "Invalid session" } };

  const vendorRow = await ownVendorRow(me);
  if (!vendorRow) return { status: 404, body: { error: "No vendor profile found for this account." } };

  const { res: resolveRes, json: resolveJson } = await resolveBankAccount(accountNumber, bankCode);
  if (!resolveRes.ok || !resolveJson.status) return { status: 400, body: { error: resolveJson.message || "Could not verify that bank account." } };
  const accountName = resolveJson.data?.account_name;

  const { res: subRes, json: subJson } = await paystackCreateSubaccount({
    business_name: vendorRow.business_name,
    settlement_bank: bankCode,
    account_number: accountNumber,
    percentage_charge: Number(vendorRow.commission_pct) || 3,
  });
  if (!subRes.ok || !subJson.status) return { status: 400, body: { error: subJson.message || "Could not set up payouts with Paystack." } };

  await getDataContext().asService((tx) =>
    new VendorsRepository(tx).update(vendorRow.id, {
      bankCode,
      accountNumber,
      accountName,
      paystackSubaccountCode: subJson.data?.subaccount_code,
    }),
  );
  return { status: 200, body: { account_name: accountName, subaccount_code: subJson.data?.subaccount_code } };
}

export async function payCommission(body: Record<string, unknown>, origin: string): Promise<ServiceResult> {
  const accessToken = body.accessToken as string | undefined;
  if (!accessToken) return { status: 400, body: { error: "accessToken is required" } };

  const me = await identityFromAccessToken(accessToken);
  if (!me) return { status: 401, body: { error: "Invalid session" } };

  const vendorRow = await ownVendorRow(me);
  if (!vendorRow) return { status: 404, body: { error: "No vendor profile found for this account." } };

  let intent: { reference?: string; amount?: number } | undefined;
  try {
    // The port of create_commission_payment_intent() checks the shop is the caller's.
    [intent] = await new CommissionService(getDataContext).paymentIntent(me, vendorRow.id);
  } catch (err) {
    if (err instanceof AppError && err.status < 500) return { status: 400, body: { error: err.message || "Could not start commission payment." } };
    const pg = findPgError(err);
    if (!pg) throw err;
    return { status: 400, body: { error: pg.message || "Could not start commission payment." } };
  }
  const { reference, amount } = intent || {};

  const userRow = await getDataContext().asService((tx) => new UsersRepository(tx).emailAndName(me.userId));
  const email = userRow?.email || me.email;
  if (!email || !reference || !Number.isFinite(Number(amount))) return { status: 400, body: { error: "Could not prepare the commission payment." } };

  const { res: initRes, json: initJson } = await initializeTransaction({
    email,
    amount: Math.round(Number(amount) * 100),
    reference,
    callback_url: `${origin}/?commissionPaid=1&reference=${encodeURIComponent(reference)}`,
  });
  if (!initRes.ok || !initJson.status || !initJson.data?.authorization_url) return { status: 400, body: { error: initJson.message || "Paystack error" } };
  return { status: 200, body: { authorization_url: initJson.data.authorization_url, reference } };
}

/** Minimum monthly charge, in naira. */
const MONTHLY_BILLING_MINIMUM = 1500;

export async function setupMonthlyBilling(body: Record<string, unknown>, origin: string): Promise<ServiceResult> {
  const accessToken = body.accessToken as string | undefined;
  if (!accessToken) return { status: 400, body: { error: "accessToken is required" } };

  const me = await identityFromAccessToken(accessToken);
  if (!me) return { status: 401, body: { error: "Invalid session" } };
  const data = getDataContext();

  const vendorRow = await data.asService((tx) => new VendorsRepository(tx).firstOwnedBy(me.userId));
  if (!vendorRow) return { status: 404, body: { error: "No vendor profile found for this account." } };
  if (vendorRow.billing_model !== "monthly") return { status: 400, body: { error: "Switch to monthly billing in your profile first." } };

  // As before, a failing amount calculation falls back to the minimum charge.
  const intentAmount = await data.asService((tx) => new BillingRepository(tx).computeMonthlyBillingAmount(vendorRow.id)).catch(() => null);
  const listingCount = Number(intentAmount?.listing_count || 0);
  const dueAmount = Math.max(Number(intentAmount?.amount || 0), MONTHLY_BILLING_MINIMUM);

  const u = await data.asService((tx) => new UsersRepository(tx).emailAndName(me.userId));
  if (!u?.email) return { status: 400, body: { error: "Could not resolve your email." } };

  const reference = "billing_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  try {
    await data.asService((tx) => new BillingRepository(tx).insertMonthlyCharge({ vendorId: vendorRow.id, listingCount, amount: dueAmount, reference }));
  } catch {
    return { status: 500, body: { error: "Could not prepare monthly billing." } };
  }

  const { res: initRes, json: initJson } = await initializeTransaction({
    email: u.email,
    amount: Math.round(dueAmount * 100),
    reference,
    channels: ["card"],
    callback_url: `${origin}/?billingSetup=1&reference=${encodeURIComponent(reference)}`,
  });
  if (!initRes.ok || !initJson.status || !initJson.data?.authorization_url) return { status: 400, body: { error: initJson.message || "Paystack error" } };
  return { status: 200, body: { authorization_url: initJson.data.authorization_url, reference } };
}
