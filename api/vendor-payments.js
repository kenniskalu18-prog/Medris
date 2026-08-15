// POST { action, accessToken, ...action-specific fields }
// Merged from the old separate create-subaccount.js / pay-commission.js /
// setup-monthly-billing.js (Vercel's Hobby plan caps deployments at 12
// serverless functions, so these three vendor-facing payment-setup
// endpoints now share a file, picked by `action`).
//
// "create-subaccount" { bankCode, accountNumber } -> { account_name, subaccount_code }
//   Verifies the vendor's bank details with Paystack (which resolves the
//   real account holder name off the account number+bank code — that's
//   how we know it's a real, existing account and not just typed text),
//   then registers a Paystack "subaccount" tied to that account. The
//   returned subaccount_code is what initiate-payment.js later passes to
//   Paystack at checkout to auto-split each charge — Paystack itself
//   holds the subaccount_code -> bank account mapping on its end, so our
//   database only needs to remember the code, not re-send bank details
//   on every order.
//
// "pay-commission" -> { authorization_url, reference }
//   Lets a vendor settle commission owed on their offline (cash/transfer)
//   sales in one tap. No subaccount split — the whole amount is the
//   platform's commission, so it all goes to the main Levromart account.
//
// "setup-monthly-billing" -> { authorization_url, reference }
//   First charge for a vendor switching to monthly billing (₦1,500 per
//   currently-active listing). This first payment is also how the card
//   gets saved: a successful Paystack card charge returns a reusable
//   authorization_code, which settleReference (see _util.js, "billing_"
//   prefix) stores on the vendor row for every charge after this one —
//   the daily-cron.js monthly-charge job reuses it without asking the
//   vendor to re-enter their card.
const { readBody, env } = require("./_util");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  try {
    const body = JSON.parse(await readBody(req));
    const origin = req.headers.origin || `https://${req.headers.host}`;
    if (body.action === "create-subaccount") return createSubaccount(body, res);
    if (body.action === "pay-commission") return payCommission(body, res, origin);
    if (body.action === "setup-monthly-billing") return setupMonthlyBilling(body, res, origin);
    res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    res.status(500).json({ error: err.message || "Server error" });
  }
};

async function createSubaccount({ accessToken, bankCode, accountNumber }, res) {
  if (!accessToken || !bankCode || !accountNumber) {
    res.status(400).json({ error: "accessToken, bankCode and accountNumber are required" });
    return;
  }

  const SUPABASE_URL = env("SUPABASE_URL");
  const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY");
  const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
  const PAYSTACK_SECRET_KEY = env("PAYSTACK_SECRET_KEY");

  const meRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
  });
  const me = await meRes.json();
  if (!meRes.ok || !me?.id) { res.status(401).json({ error: "Invalid session" }); return; }

  const vendorRes = await fetch(`${SUPABASE_URL}/rest/v1/vendors?user_id=eq.${me.id}&select=id,business_name,commission_pct`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
  });
  const [vendorRow] = await vendorRes.json();
  if (!vendorRow) { res.status(404).json({ error: "No vendor profile found for this account." }); return; }

  const resolveRes = await fetch(
    `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
    { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
  );
  const resolveJson = await resolveRes.json();
  if (!resolveRes.ok || !resolveJson.status) { res.status(400).json({ error: resolveJson.message || "Could not verify that bank account." }); return; }
  const accountName = resolveJson.data.account_name;

  const subRes = await fetch("https://api.paystack.co/subaccount", {
    method: "POST",
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      business_name: vendorRow.business_name,
      settlement_bank: bankCode,
      account_number: accountNumber,
      percentage_charge: Number(vendorRow.commission_pct) || 3,
    }),
  });
  const subJson = await subRes.json();
  if (!subRes.ok || !subJson.status) { res.status(400).json({ error: subJson.message || "Could not set up payouts with Paystack." }); return; }

  await fetch(`${SUPABASE_URL}/rest/v1/vendors?id=eq.${vendorRow.id}`, {
    method: "PATCH",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({
      bank_code: bankCode,
      account_number: accountNumber,
      account_name: accountName,
      paystack_subaccount_code: subJson.data.subaccount_code,
    }),
  });

  res.status(200).json({ account_name: accountName, subaccount_code: subJson.data.subaccount_code });
}

async function payCommission({ accessToken }, res, origin) {
  if (!accessToken) { res.status(400).json({ error: "accessToken is required" }); return; }

  const SUPABASE_URL = env("SUPABASE_URL");
  const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY");
  const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
  const PAYSTACK_SECRET_KEY = env("PAYSTACK_SECRET_KEY");

  const meRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
  });
  const me = await meRes.json();
  if (!meRes.ok || !me?.id) { res.status(401).json({ error: "Invalid session" }); return; }

  const vendorRes = await fetch(`${SUPABASE_URL}/rest/v1/vendors?user_id=eq.${me.id}&select=id`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
  });
  const [vendorRow] = await vendorRes.json();
  if (!vendorRow) { res.status(404).json({ error: "No vendor profile found for this account." }); return; }

  const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/create_commission_payment_intent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ p_vendor_id: vendorRow.id }),
  });
  const rpcJson = await rpcRes.json();
  if (!rpcRes.ok) { res.status(400).json({ error: rpcJson.message || "Could not start commission payment." }); return; }
  const intent = Array.isArray(rpcJson) ? rpcJson[0] : rpcJson;
  const { reference, amount } = intent;

  const userRes = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${me.id}&select=email`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  const [userRow] = await userRes.json();
  const email = userRow?.email || me.email;

  const initRes = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      amount: Math.round(Number(amount) * 100), // kobo
      reference,
      callback_url: `${origin}/?commissionPaid=1&reference=${encodeURIComponent(reference)}`,
      // deliberately no subaccount — this whole charge IS the commission
    }),
  });
  const initJson = await initRes.json();
  if (!initRes.ok || !initJson.status) { res.status(400).json({ error: initJson.message || "Paystack error" }); return; }

  res.status(200).json({ authorization_url: initJson.data.authorization_url, reference });
}

async function setupMonthlyBilling({ accessToken }, res, origin) {
  if (!accessToken) { res.status(400).json({ error: "accessToken is required" }); return; }

  const SUPABASE_URL = env("SUPABASE_URL");
  const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY");
  const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
  const PAYSTACK_SECRET_KEY = env("PAYSTACK_SECRET_KEY");
  const svcAuth = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

  const meRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
  });
  const me = await meRes.json();
  if (!meRes.ok || !me?.id) { res.status(401).json({ error: "Invalid session" }); return; }

  const vendorRes = await fetch(`${SUPABASE_URL}/rest/v1/vendors?user_id=eq.${me.id}&select=id,billing_model`, { headers: svcAuth });
  const [vendorRow] = await vendorRes.json();
  if (!vendorRow) { res.status(404).json({ error: "No vendor profile found for this account." }); return; }
  if (vendorRow.billing_model !== "monthly") { res.status(400).json({ error: "Switch to monthly billing in your profile first." }); return; }

  const amountRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/compute_monthly_billing_amount`, {
    method: "POST", headers: { ...svcAuth, "Content-Type": "application/json" },
    body: JSON.stringify({ p_vendor_id: vendorRow.id }),
  });
  const [{ listing_count, amount }] = await amountRes.json();
  const dueAmount = Math.max(Number(amount) || 0, 1500); // at least one month's minimum even with 0 listings yet, so the card still gets saved

  const uRes = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${me.id}&select=email`, { headers: svcAuth });
  const [u] = await uRes.json();
  if (!u?.email) { res.status(400).json({ error: "Could not resolve your email." }); return; }

  const reference = "billing_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  await fetch(`${SUPABASE_URL}/rest/v1/vendor_monthly_charges`, {
    method: "POST", headers: { ...svcAuth, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ vendor_id: vendorRow.id, listing_count, amount: dueAmount, status: "pending", provider_reference: reference }),
  });

  const initRes = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: u.email,
      amount: Math.round(dueAmount * 100),
      reference,
      channels: ["card"], // recurring charges only work off a saved card
      callback_url: `${origin}/?billingSetup=1&reference=${encodeURIComponent(reference)}`,
    }),
  });
  const initJson = await initRes.json();
  if (!initRes.ok || !initJson.status) { res.status(400).json({ error: initJson.message || "Paystack error" }); return; }

  res.status(200).json({ authorization_url: initJson.data.authorization_url, reference });
}
