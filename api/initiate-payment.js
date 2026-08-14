// POST { orderId, accessToken } -> { authorization_url, reference }
// The buyer's own access token is used to call create_payment_intent, so
// Postgres enforces "this order belongs to you" — this endpoint never
// trusts orderId + amount from the client alone.
const { readBody, env } = require("./_util");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  try {
    const { orderId, accessToken } = JSON.parse(await readBody(req));
    if (!orderId || !accessToken) { res.status(400).json({ error: "orderId and accessToken are required" }); return; }

    const SUPABASE_URL = env("SUPABASE_URL");
    const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY");
    const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
    const PAYSTACK_SECRET_KEY = env("PAYSTACK_SECRET_KEY");

    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/create_payment_intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ p_order_id: orderId }),
    });
    const rpcJson = await rpcRes.json();
    if (!rpcRes.ok) { res.status(400).json({ error: rpcJson.message || "Could not start payment." }); return; }
    const intent = Array.isArray(rpcJson) ? rpcJson[0] : rpcJson;
    const { reference, amount } = intent;

    const orderRes = await fetch(
      `${SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}&select=buyer:users(email),vendor:vendors(paystack_subaccount_code)`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    const [orderRow] = await orderRes.json();
    const email = orderRow?.buyer?.email;
    if (!email) { res.status(400).json({ error: "Could not resolve buyer email." }); return; }

    // Split payment: if the vendor has payouts set up, Paystack sends their
    // cut straight to their bank account at settlement (next business day),
    // automatically, at the subaccount's stored percentage_charge — no
    // manual release step, no Transfers API call, so this works fine on a
    // Starter Business account. (Was full escrow — held on the platform's
    // balance until the buyer confirmed receipt — until the Starter/
    // Registered Business distinction made that impractical for now; can
    // switch back once the account is upgraded.) Vendors without payouts
    // set up yet still fall back to the full amount landing on the
    // platform's balance, same as before, needing a manual payout.
    const subaccountCode = orderRow?.vendor?.paystack_subaccount_code || null;

    const origin = req.headers.origin || `https://${req.headers.host}`;
    const initRes = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        amount: Math.round(Number(amount) * 100), // kobo
        reference,
        callback_url: `${origin}/?paid=1&reference=${encodeURIComponent(reference)}&orderId=${encodeURIComponent(orderId)}`,
        ...(subaccountCode ? { subaccount: subaccountCode } : {}),
      }),
    });
    const initJson = await initRes.json();
    if (!initRes.ok || !initJson.status) { res.status(400).json({ error: initJson.message || "Paystack error" }); return; }

    res.status(200).json({ authorization_url: initJson.data.authorization_url, reference });
  } catch (err) {
    res.status(500).json({ error: err.message || "Server error" });
  }
};
