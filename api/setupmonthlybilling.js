// POST { accessToken } -> { authorization_url, reference }
// First charge for a vendor switching to monthly billing (₦1,500 per
// currently-active listing). This first payment is also how the card gets
// saved: a successful Paystack card charge returns a reusable
// authorization_code, which settleReference (see _util.js, "billing_"
// prefix) stores on the vendor row for every charge after this one —
// charge-monthly-vendors.js reuses it monthly without asking the vendor
// to re-enter their card.
const { readBody, env } = require("./_util");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  try {
    const { accessToken } = JSON.parse(await readBody(req));
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

    const origin = req.headers.origin || `https://${req.headers.host}`;
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
  } catch (err) {
    res.status(500).json({ error: err.message || "Server error" });
  }
};
