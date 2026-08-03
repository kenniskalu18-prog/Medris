// POST { accessToken } -> { ok: true }
// Called right after a successful password sign-in, but only acted on if
// the account is an admin -- ordinary buyer/vendor logins never hit this.
// Generates a 6-digit code, emails it, and the client won't let the admin
// into the app until they submit it back to verify-login-otp.
const { readBody, env, sendNotificationEmail } = require("./_util");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  try {
    const { accessToken } = JSON.parse(await readBody(req));
    if (!accessToken) { res.status(400).json({ error: "accessToken is required" }); return; }

    const SUPABASE_URL = env("SUPABASE_URL");
    const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY");
    const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
    const svcAuth = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
    const svcHeaders = { ...svcAuth, "Content-Type": "application/json", Prefer: "return=minimal" };

    const meRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
    });
    const me = await meRes.json();
    if (!meRes.ok || !me?.id) { res.status(401).json({ error: "Invalid session" }); return; }

    const uRes = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${me.id}&select=role,name,email`, { headers: svcAuth });
    const [u] = await uRes.json();
    if (!u || u.role !== "admin") { res.status(200).json({ ok: true, otpRequired: false }); return; }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await fetch(`${SUPABASE_URL}/rest/v1/admin_login_otps`, {
      method: "POST", headers: svcHeaders,
      body: JSON.stringify({ user_id: me.id, code, expires_at: expiresAt }),
    });

    const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
    if (RESEND_API_KEY) {
      await sendNotificationEmail(RESEND_API_KEY, {
        to: u.email, name: u.name,
        title: "Your Levromart admin login code",
        body: `Your one-time code is ${code}. It expires in 10 minutes. If this wasn't you, change your password immediately.`,
      });
    }

    res.status(200).json({ ok: true, otpRequired: true });
  } catch (err) {
    res.status(500).json({ error: err.message || "Server error" });
  }
};
