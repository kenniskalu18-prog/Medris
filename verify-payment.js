// GET /api/verify-payment?reference=... -> { status }
// Called when the buyer lands back on the app after Paystack checkout, so
// the UI can confirm immediately instead of waiting on the webhook. The
// webhook (paystack-webhook.js) remains the source of truth either way.
const { env } = require("./_util");

module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const reference = url.searchParams.get("reference");
    if (!reference) { res.status(400).json({ error: "reference is required" }); return; }

    const PAYSTACK_SECRET_KEY = env("PAYSTACK_SECRET_KEY");
    const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
    });
    const verifyJson = await verifyRes.json();
    if (!verifyRes.ok || !verifyJson.status) { res.status(400).json({ error: verifyJson.message || "Verify failed" }); return; }

    if (verifyJson.data.status === "success") {
      const SUPABASE_URL = env("SUPABASE_URL");
      const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
      await fetch(`${SUPABASE_URL}/rest/v1/payments?provider_reference=eq.${encodeURIComponent(reference)}`, {
        method: "PATCH",
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ status: "paid" }),
      });
    }
    res.status(200).json({ status: verifyJson.data.status });
  } catch (err) {
    res.status(500).json({ error: err.message || "Server error" });
  }
};
