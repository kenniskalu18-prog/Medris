// POST { orderId, eventType, accessToken } -> { sent: ["buyer","vendor"] }
// eventType: "placed" (order just created) or "status_changed".
// Called from the browser right after the order is created or its status
// is updated — mirrors the pattern used elsewhere in this app (e.g.
// logAdminAction) rather than a DB webhook, so it needs no extra
// Supabase configuration beyond the env vars below.
const { readBody, env, sendOrderEmails } = require("./_util");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  try {
    const { orderId, eventType, accessToken } = JSON.parse(await readBody(req));
    if (!orderId || !eventType || !accessToken) { res.status(400).json({ error: "orderId, eventType and accessToken are required" }); return; }

    const SUPABASE_URL = env("SUPABASE_URL");
    const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY");
    const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
    const svcHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

    const meRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
    });
    const me = await meRes.json();
    if (!meRes.ok || !me?.id) { res.status(401).json({ error: "Invalid session" }); return; }

    const orderRes = await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}&select=*`, { headers: svcHeaders });
    const [order] = await orderRes.json();
    if (!order) { res.status(404).json({ error: "Order not found" }); return; }

    const [vendorRes, buyerRes, itemsRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/vendors?id=eq.${order.vendor_id}&select=id,business_name,user_id`, { headers: svcHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${order.buyer_id}&select=id,name,email`, { headers: svcHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/order_items?order_id=eq.${orderId}&select=quantity,unit_price,rental_start_date,rental_end_date,product:products(name)`, { headers: svcHeaders }),
    ]);
    const [vendorRow] = await vendorRes.json();
    const [buyer] = await buyerRes.json();
    const items = await itemsRes.json();

    if (order.buyer_id !== me.id && vendorRow?.user_id !== me.id) { res.status(403).json({ error: "Not authorized for this order" }); return; }

    let vendorEmail = null;
    if (vendorRow?.user_id) {
      const vUserRes = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${vendorRow.user_id}&select=email`, { headers: svcHeaders });
      const [vUser] = await vUserRes.json();
      vendorEmail = vUser?.email || null;
    }

    const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
    const origin = req.headers.origin || `https://${req.headers.host}`;
    const result = await sendOrderEmails({
      resendKey: RESEND_API_KEY, origin, order, items, buyer,
      vendorBusinessName: vendorRow?.business_name || "the vendor", vendorEmail, eventType,
    });
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || "Server error" });
  }
};
