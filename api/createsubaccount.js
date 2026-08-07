// POST { accessToken, bankCode, accountNumber } -> { account_name, subaccount_code }
// Verifies and saves the calling vendor's bank details (bank_code,
// account_number, account_name). The Paystack subaccount created here is
// no longer used to auto-split payments at checkout — since escrow
// (release-payout.js), the platform holds the full charge and pays the
// vendor out separately via a Transfer Recipient built from these same
// saved bank details. Kept as-is because it's still the vendor-facing
// "link your bank account" flow and Paystack's bank-resolve step lives
// here; the subaccount_code itself just goes unused now.
const { readBody, env } = require("./_util");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  try {
    const { accessToken, bankCode, accountNumber } = JSON.parse(await readBody(req));
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
  } catch (err) {
    res.status(500).json({ error: err.message || "Server error" });
  }
};
