// POST { notificationId }, header x-webhook-secret -> { sent: boolean }
// Called by a Postgres trigger (net.http_post) every time a row is
// inserted into `notifications` — see migration medris_035/036. This is
// what makes every in-app notification also become an email, without
// each client action having to remember to trigger one.
const { readBody, env, sendNotificationEmail } = require("./_util");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  try {
    if (req.headers["x-webhook-secret"] !== env("EMAIL_WEBHOOK_SECRET")) { res.status(401).json({ error: "Unauthorized" }); return; }

    const { notificationId } = JSON.parse(await readBody(req));
    if (!notificationId) { res.status(400).json({ error: "notificationId required" }); return; }

    const SUPABASE_URL = env("SUPABASE_URL");
    const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
    const svcHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

    const nRes = await fetch(`${SUPABASE_URL}/rest/v1/notifications?id=eq.${notificationId}&select=*`, { headers: svcHeaders });
    const [n] = await nRes.json();
    if (!n) { res.status(200).json({ sent: false, reason: "notification not found" }); return; }

    const uRes = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${n.user_id}&select=email,name`, { headers: svcHeaders });
    const [u] = await uRes.json();
    if (!u?.email) { res.status(200).json({ sent: false, reason: "no email on file" }); return; }

    const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
    if (!RESEND_API_KEY) { res.status(200).json({ sent: false, reason: "RESEND_API_KEY not configured" }); return; }

    const origin = "https://medriss.vercel.app";
    const link = `${origin}/?nview=${encodeURIComponent(n.target_view || "home")}&nparams=${encodeURIComponent(JSON.stringify(n.target_params || {}))}`;

    const result = await sendNotificationEmail(RESEND_API_KEY, { to: u.email, name: u.name, title: n.title, body: n.body, link });
    res.status(200).json({ sent: result.ok, status: result.status, error: result.error });
  } catch (err) {
    res.status(500).json({ error: err.message || "Server error" });
  }
};
