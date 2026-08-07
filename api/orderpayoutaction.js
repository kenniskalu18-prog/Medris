// POST { action: "release" | "refund", orderId, accessToken } -> varies by action
// Merged from the old separate release-payout.js / refund-payout.js
// (Vercel's Hobby plan caps deployments at 12 serverless functions, so
// these two admin/buyer payout actions on an order now share a file).
//
// "release": called when the buyer taps "I've received this" (or an admin
// forces a release from the disputes queue). Transitions the order via
// transition_order_status (using the caller's own token, so Postgres
// re-checks "is this really their order to complete") and then, if
// there's money actually held, moves it to the vendor's bank account.
//
// "refund": admin-only. Used from the disputes queue when a vendor
// genuinely never delivered — refunds the buyer's original charge from
// the platform's own Paystack balance, since escrow means the vendor was
// never paid in the first place.
const { readBody, env, releaseOrderPayout, refundOrderPayout } = require("./_util");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  try {
    const body = JSON.parse(await readBody(req));
    if (body.action === "refund") return refund(body, res);
    return release(body, res);
  } catch (err) {
    res.status(500).json({ error: err.message || "Server error" });
  }
};

async function release({ orderId, accessToken }, res) {
  if (!orderId || !accessToken) { res.status(400).json({ error: "orderId and accessToken are required" }); return; }

  const SUPABASE_URL = env("SUPABASE_URL");
  const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY");
  const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

  const meRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
  });
  const me = await meRes.json();
  if (!meRes.ok || !me?.id) { res.status(401).json({ error: "Invalid session" }); return; }

  const orderRes = await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}&select=id,status,order_type,buyer_id`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  const [order] = await orderRes.json();
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }

  const uRes = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${me.id}&select=role`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  const [u] = await uRes.json();
  if (order.buyer_id !== me.id && u?.role !== "admin") { res.status(403).json({ error: "Only the buyer (or an admin) can confirm this order." }); return; }

  if (order.status !== "completed") {
    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/transition_order_status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ p_order_id: orderId, p_new_status: "completed" }),
    });
    if (!rpcRes.ok) {
      const rpcJson = await rpcRes.json().catch(() => ({}));
      res.status(400).json({ error: rpcJson.message || "Could not complete this order." });
      return;
    }
  }

  // The order is confirmed-received either way at this point — that part
  // succeeded above. If the actual bank transfer fails (e.g. Paystack
  // wants a one-time OTP approval on this account before it'll move
  // money), don't turn that into a scary error for the buyer; they did
  // their part. Surface it as a payout problem an admin needs to chase,
  // not a failed confirmation.
  try {
    const result = await releaseOrderPayout(orderId);
    res.status(200).json({ status: "completed", ...result });
  } catch (payoutErr) {
    res.status(200).json({ status: "completed", transferred: false, payoutError: payoutErr.message });
  }
}

async function refund({ orderId, accessToken }, res) {
  if (!orderId || !accessToken) { res.status(400).json({ error: "orderId and accessToken are required" }); return; }

  const SUPABASE_URL = env("SUPABASE_URL");
  const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY");
  const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

  const meRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
  });
  const me = await meRes.json();
  if (!meRes.ok || !me?.id) { res.status(401).json({ error: "Invalid session" }); return; }

  const uRes = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${me.id}&select=role`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  const [u] = await uRes.json();
  if (u?.role !== "admin") { res.status(403).json({ error: "Admins only." }); return; }

  const result = await refundOrderPayout(orderId);
  res.status(200).json(result);
}
