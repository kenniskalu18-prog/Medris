// POST { action: "send" | "verify", accessToken, code? }
// Admin-only email OTP, required after the password on every fresh login
// (not on ordinary page reloads) — this account has real power
// (approve/delete vendors, finance access), so it gets the extra step;
// buyer/vendor accounts don't have anything worth adding that friction for.
// Merged from the old separate send-login-otp.js / verify-login-otp.js —
// same two flows, just picked by `action` now (Vercel's Hobby plan caps
// deployments at 12 serverless functions, so related endpoints share a
// file rather than each getting its own).
const { readBody, env, sendNotificationEmail } = require("./_util");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  try {
    const body = JSON.parse(await readBody(req));
    if (body.action === "verify") return verifyOtp(body, res);
    return sendOtp(body, res);
  } catch (err) {
    res.status(500).json({ error: err.message || "Server error" });
  }
};

async function sendOtp({ accessToken }, res) {
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
}

async function verifyOtp({ accessToken, code }, res) {
  if (!accessToken || !code) { res.status(400).json({ error: "accessToken and code are required" }); return; }

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

  const otpRes = await fetch(
    `${SUPABASE_URL}/rest/v1/admin_login_otps?user_id=eq.${me.id}&used_at=is.null&order=created_at.desc&limit=1&select=id,code,expires_at`,
    { headers: svcAuth }
  );
  const [otp] = await otpRes.json();

  if (!otp || otp.code !== String(code).trim() || new Date(otp.expires_at) < new Date()) {
    res.status(200).json({ ok: false, error: "That code is incorrect or has expired." });
    return;
  }

  await fetch(`${SUPABASE_URL}/rest/v1/admin_login_otps?id=eq.${otp.id}`, {
    method: "PATCH", headers: svcHeaders,
    body: JSON.stringify({ used_at: new Date().toISOString() }),
  });

  res.status(200).json({ ok: true });
}
