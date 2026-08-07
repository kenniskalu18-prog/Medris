// POST { notificationId }, header x-webhook-secret -> { email, push }
// Called by a single Postgres trigger (net.http_post) every time a row is
// inserted into `notifications` — see migration medris_035/036/046/065.
// This is what makes every in-app notification also become an email and a
// push, without each client action having to remember to trigger either.
// Merged from the old separate notify-email.js / notify-push.js into one
// function that fires both channels per call (Vercel's Hobby plan caps
// deployments at 12 serverless functions, and the DB only needs to make
// one webhook call per notification now instead of two).
const webpush = require("web-push");
const { readBody, env, sendNotificationEmail } = require("./_util");

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
    if (!n) { res.status(200).json({ email: { sent: false, reason: "notification not found" }, push: { sent: 0 } }); return; }

    const [email, push] = await Promise.all([
      sendEmail(SUPABASE_URL, svcHeaders, n),
      sendPush(SUPABASE_URL, svcHeaders, n),
    ]);
    res.status(200).json({ email, push });
  } catch (err) {
    res.status(500).json({ error: err.message || "Server error" });
  }
};

async function sendEmail(SUPABASE_URL, svcHeaders, n) {
  const uRes = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${n.user_id}&select=email,name`, { headers: svcHeaders });
  const [u] = await uRes.json();
  if (!u?.email) return { sent: false, reason: "no email on file" };

  const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
  if (!RESEND_API_KEY) return { sent: false, reason: "RESEND_API_KEY not configured" };

  const origin = "https://levromart.vercel.app";
  const link = `${origin}/?nview=${encodeURIComponent(n.target_view || "home")}&nparams=${encodeURIComponent(JSON.stringify(n.target_params || {}))}`;

  const result = await sendNotificationEmail(RESEND_API_KEY, { to: u.email, name: u.name, title: n.title, body: n.body, link });
  return { sent: result.ok, status: result.status, error: result.error };
}

async function sendPush(SUPABASE_URL, svcHeaders, n) {
  const subsRes = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?user_id=eq.${n.user_id}&select=*`, { headers: svcHeaders });
  const subs = await subsRes.json();
  if (!subs || subs.length === 0) return { sent: 0, reason: "no push subscriptions" };

  const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
  if (!VAPID_PRIVATE_KEY) return { sent: 0, reason: "VAPID_PRIVATE_KEY not configured" };
  webpush.setVapidDetails("mailto:support@levromart.app", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const origin = "https://levromart.vercel.app";
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
  return { sent };
}
