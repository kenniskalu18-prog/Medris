// POST { notificationId }, header x-webhook-secret -> { sent: number }
// Called by the same Postgres trigger pattern as api/notify-email.js (see
// migration medris_046) — every notification row also fires this, so push
// and email are two independent channels for the same event. Needs
// VAPID_PRIVATE_KEY set in Vercel; the matching public key is hardcoded
// client-side in index.html (VAPID public keys are meant to be public).
const webpush = require("web-push");
const { readBody, env } = require("./_util");

const VAPID_PUBLIC_KEY = "BJ7h-JVsXaOpYXY5st5L7esSDOPjhRROincFPTT013a1ZY3U62WIKPAoFEDzBgFB8g3H2DBNX1iRw8GzdPWR88k";

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
    if (!n) { res.status(200).json({ sent: 0, reason: "notification not found" }); return; }

    const subsRes = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?user_id=eq.${n.user_id}&select=*`, { headers: svcHeaders });
    const subs = await subsRes.json();
    if (!subs || subs.length === 0) { res.status(200).json({ sent: 0, reason: "no push subscriptions" }); return; }

    const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
    if (!VAPID_PRIVATE_KEY) { res.status(200).json({ sent: 0, reason: "VAPID_PRIVATE_KEY not configured" }); return; }
    webpush.setVapidDetails("mailto:support@levromart.app", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

    const origin = "https://medriss.vercel.app";
    const url = `${origin}/?nview=${encodeURIComponent(n.target_view || "home")}&nparams=${encodeURIComponent(JSON.stringify(n.target_params || {}))}`;
    const payload = JSON.stringify({ title: n.title, body: n.body, url });

    let sent = 0;
    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, payload);
        sent++;
      } catch (err) {
        // 404/410 = the browser unsubscribed or the subscription expired — clean it up.
        if (err.statusCode === 404 || err.statusCode === 410) {
          await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?id=eq.${s.id}`, { method: "DELETE", headers: svcHeaders });
        }
      }
    }));

    res.status(200).json({ sent });
  } catch (err) {
    res.status(500).json({ error: err.message || "Server error" });
  }
};
