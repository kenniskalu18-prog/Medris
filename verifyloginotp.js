// POST { accessToken, code } -> { ok: boolean, error? }
// Checks the code against the most recent unused, unexpired one sent by
// send-login-otp for this account. Marks it used on success so the same
// code can't be replayed.
const { readBody, env } = require("./_util");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  try {
    const { accessToken, code } = JSON.parse(await readBody(req));
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
  } catch (err) {
    res.status(500).json({ error: err.message || "Server error" });
  }
};
