// POST { action: "send" | "verify" | "set-password", accessToken, code?, password? }
// Email OTP is restricted to admin accounts. Buyer and vendor accounts do not
// use this endpoint for login verification. Admin sessions are re-verified every
// 7 days using users.otp_verified_at.
// New signups get otp_verified_at set to their signup time, so this never
// interrupts someone's very first session -- only returning ones, once the
// 7-day window has actually lapsed.
// Merged from the old separate send-login-otp.js / verify-login-otp.js --
// same two flows, just picked by `action` now (Vercel's Hobby plan caps
// deployments at 12 serverless functions, so related endpoints share a
// file rather than each getting its own).
const OTP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const { readBody, env, sendNotificationEmail } = require("./_util");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  try {
    const body = JSON.parse(await readBody(req));
    if (body.action === "verify") return verifyOtp(body, res);
    if (body.action === "set-password") return setPassword(body, res);
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

  const uRes = await fetch(
    `${SUPABASE_URL}/rest/v1/users?id=eq.${me.id}&select=name,email,role,otp_verified_at`,
    { headers: svcAuth }
  );
  const [u] = await uRes.json();

  if (!u) {
    res.status(200).json({ ok: true, otpRequired: false });
    return;
  }

  // BUYERS AND VENDORS DO NOT REQUIRE OTP.
  if (u.role !== "admin") {
    res.status(200).json({ ok: true, otpRequired: false });
    return;
  }

  const lastVerified = u.otp_verified_at
    ? new Date(u.otp_verified_at).getTime()
    : 0;

  if (Date.now() - lastVerified < OTP_INTERVAL_MS) {
    res.status(200).json({ ok: true, otpRequired: false });
    return;
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  await fetch(`${SUPABASE_URL}/rest/v1/admin_login_otps`, {
    method: "POST",
    headers: svcHeaders,
    body: JSON.stringify({
      user_id: me.id,
      code,
      expires_at: expiresAt
    }),
  });

  const RESEND_API_KEY = process.env.RESEND_API_KEY || "";

  if (RESEND_API_KEY) {
    await sendNotificationEmail(RESEND_API_KEY, {
      to: u.email,
      name: u.name,
      title: "Your Levromart admin login code",
      body: `Your one-time code is ${code}. It expires in 10 minutes. If this wasn't you, change your password immediately.`,
    });
  }

  res.status(200).json({
    ok: true,
    otpRequired: true
  });
}

async function verifyOtp({ accessToken, code }, res) {
  if (!accessToken || !code) {
    res.status(400).json({
      error: "accessToken and code are required"
    });
    return;
  }

  const SUPABASE_URL = env("SUPABASE_URL");
  const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY");
  const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

  const svcAuth = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`
  };

  const svcHeaders = {
    ...svcAuth,
    "Content-Type": "application/json",
    Prefer: "return=minimal"
  };

  const meRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`
    },
  });

  const me = await meRes.json();

  if (!meRes.ok || !me?.id) {
    res.status(401).json({ error: "Invalid session" });
    return;
  }

  // Verify that ONLY an admin can use OTP verification.
  const userRes = await fetch(
    `${SUPABASE_URL}/rest/v1/users?id=eq.${me.id}&select=role`,
    { headers: svcAuth }
  );

  const [userRow] = userRes.ok ? await userRes.json() : [];

  if (!userRow || userRow.role !== "admin") {
    res.status(403).json({
      error: "OTP verification is only available to admin accounts."
    });
    return;
  }

  const otpRes = await fetch(
    `${SUPABASE_URL}/rest/v1/admin_login_otps?user_id=eq.${me.id}&used_at=is.null&order=created_at.desc&limit=1&select=id,code,expires_at`,
    { headers: svcAuth }
  );

  const [otp] = await otpRes.json();

  if (
    !otp ||
    otp.code !== String(code).trim() ||
    new Date(otp.expires_at) < new Date()
  ) {
    res.status(200).json({
      ok: false,
      error: "That code is incorrect or has expired."
    });
    return;
  }

  await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/admin_login_otps?id=eq.${otp.id}`, {
      method: "PATCH",
      headers: svcHeaders,
      body: JSON.stringify({
        used_at: new Date().toISOString()
      }),
    }),

    fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${me.id}`, {
      method: "PATCH",
      headers: svcHeaders,
      body: JSON.stringify({
        otp_verified_at: new Date().toISOString()
      }),
    }),
  ]);

  res.status(200).json({ ok: true });
}

// Sets a password for the calling account through Supabase's admin API
// instead of the regular client-side auth.updateUser() call. An OAuth-only
// account (Google sign-in, no password ever set) has a known rough edge in
// Supabase's own "new password must differ from the old one" check -- it
// can misfire and reject a brand-new password as a duplicate even though
// there was never a real one to compare against. The admin API sets the
// password directly and doesn't run that comparison at all.
async function setPassword({ accessToken, password }, res) {
  if (!accessToken || !password) {
    res.status(400).json({
      error: "accessToken and password are required"
    });
    return;
  }

  if (String(password).length < 8) {
    res.status(400).json({
      error: "Password must be at least 8 characters."
    });
    return;
  }

  const SUPABASE_URL = env("SUPABASE_URL");
  const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY");
  const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

  const svcAuth = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`
  };

  const meRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`
    },
  });

  const me = await meRes.json();

  if (!meRes.ok || !me?.id) {
    res.status(401).json({
      error: "Invalid session"
    });
    return;
  }

  const setRes = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users/${me.id}`,
    {
      method: "PUT",
      headers: {
        ...svcAuth,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ password }),
    }
  );

  const setJson = await setRes.json();

  if (!setRes.ok) {
    res.status(400).json({
      error:
        setJson.msg ||
        setJson.error_description ||
        setJson.message ||
        "Could not set password."
    });
    return;
  }

  await fetch(
    `${SUPABASE_URL}/rest/v1/users?id=eq.${me.id}`,
    {
      method: "PATCH",
      headers: {
        ...svcAuth,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        has_password: true
      }),
    }
  );

  res.status(200).json({ ok: true });
}
