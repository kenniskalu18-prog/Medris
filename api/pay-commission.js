// POST { accessToken } -> { authorization_url, reference }
// Lets a vendor settle commission owed on their offline (cash/transfer)
// sales in one tap. Unlike initiate-payment.js, this transaction has no
// subaccount split — the whole amount is the platform's commission, so
// it all goes to the main Levromart Paystack account.
const { env } = require("./_util");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  try {
    const { accessToken } = JSON.parse(await readBody(req));
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

    const origin = req.headers.origin || `https://${req.headers.host}`;
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
  } catch (err) {
    res.status(500).json({ error: err.message || "Server error" });
  }
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data || "{}"));
    req.on("error", reject);
  });
}
