const { readBody, env } = require("./_util");

function serviceHeaders(key) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json"
  };
}

function normalizePhone(phone) {
  let digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0") && digits.length === 11) digits = "234" + digits.slice(1);
  return digits;
}

function phoneAlias(phone) {
  const digits = normalizePhone(phone);
  return digits ? `p${digits}@accounts.levromart.app` : "";
}

async function readJson(response) {
  return response.json().catch(() => ({}));
}

async function listAuthUsers(supabaseUrl, key, wantedEmail) {
  const headers = serviceHeaders(key);
  const target = String(wantedEmail || "").trim().toLowerCase();
  if (!target) return null;

  for (let page = 1; page <= 20; page++) {
    const response = await fetch(
      `${supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=1000`,
      { headers }
    );
    if (!response.ok) return null;
    const data = await readJson(response);
    const users = Array.isArray(data) ? data : (data.users || []);
    const match = users.find(
      user => String(user?.email || "").trim().toLowerCase() === target
    );
    if (match) return match;
    if (users.length < 1000) break;
  }
  return null;
}

async function publicUserByEmail(supabaseUrl, key, email) {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/users?email=eq.${encodeURIComponent(email)}&select=id,email,phone`,
    { headers: serviceHeaders(key) }
  );
  if (!response.ok) return null;
  const rows = await readJson(response);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function publicUserByPhone(supabaseUrl, key, phone) {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/users?phone=eq.${encodeURIComponent(phone)}&select=id,email,phone`,
    { headers: serviceHeaders(key) }
  );
  if (!response.ok) return null;
  const rows = await readJson(response);
  return Array.isArray(rows) ? rows[0] || null : null;
}

/* ============================================================
   ACCOUNT EXISTS
   This stays inside the existing delete-account function so Vercel
   does not get another serverless function.
   ============================================================ */
async function accountExists(body, res) {
  const email = String(body?.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "A valid email address is required." });
  }

  const supabaseUrl = env("SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: "Supabase server configuration is incomplete." });
  }

  const profile = await publicUserByEmail(supabaseUrl, serviceKey, email);
  const authUser = await listAuthUsers(supabaseUrl, serviceKey, email);

  return res.status(200).json({
    exists: Boolean(profile || authUser),
    hasPublicProfile: Boolean(profile),
    hasAuthAccount: Boolean(authUser)
  });
}

/* ============================================================
   REGISTER ACCOUNT
   Email is optional. Phone is required.
   No confirmation email is sent.
   ============================================================ */
async function registerAccount(body, res) {
  const cleanEmail = String(body?.email || "").trim().toLowerCase();
  const cleanName = String(body?.name || "").trim();
  const cleanPhone = String(body?.phone || "").trim();
  const normalizedPhone = normalizePhone(cleanPhone);
  const role = body?.role;
  const password = String(body?.password || "");
  const city = String(body?.city || "").trim();

  if (!cleanName) return res.status(400).json({ error: "Full name is required." });
  if (!normalizedPhone || normalizedPhone.length < 10) return res.status(400).json({ error: "A valid phone number is required." });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  if (role !== "buyer" && role !== "vendor") return res.status(400).json({ error: "Invalid account type." });
  if (cleanEmail && !cleanEmail.includes("@")) return res.status(400).json({ error: "Enter a valid email address or leave email blank." });

  const supabaseUrl = env("SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Supabase server configuration is incomplete." });

  const headers = serviceHeaders(serviceKey);

  // Phone is the required unique registration identifier.
  const existingPhone = await publicUserByPhone(supabaseUrl, serviceKey, cleanPhone);
  if (existingPhone) {
    return res.status(409).json({ error: "An account with that phone number already exists. Please log in instead." });
  }

  // If an email was supplied, check both the public profile and Auth.
  if (cleanEmail) {
    const existingProfile = await publicUserByEmail(supabaseUrl, serviceKey, cleanEmail);
    const existingAuth = await listAuthUsers(supabaseUrl, serviceKey, cleanEmail);
    if (existingProfile || existingAuth) {
      return res.status(409).json({ error: "A user with this email address has already been registered. Please log in instead." });
    }
  }

  // Supabase Auth needs an identifier. For phone-only accounts we use a
  // private synthetic email that never sends mail and is never displayed as
  // the user's real email address by the UI.
  const authEmail = cleanEmail || phoneAlias(cleanPhone);

  const createResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      email: authEmail,
      password,
      email_confirm: true,
      user_metadata: {
        name: cleanName,
        phone: cleanPhone,
        city,
        role,
        email_optional: !cleanEmail
      }
    })
  });

  const created = await readJson(createResponse);
  if (!createResponse.ok || !created?.id) {
    return res.status(createResponse.status || 400).json({
      error: created?.msg || created?.message || created?.error_description || "Could not create the account."
    });
  }

  const profileResponse = await fetch(`${supabaseUrl}/rest/v1/users`, {
    method: "POST",
    headers: {
      ...headers,
      Prefer: "resolution=ignore-duplicates,return=minimal"
    },
    body: JSON.stringify({
      id: created.id,
      name: cleanName,
      email: cleanEmail || null,
      phone: cleanPhone,
      city,
      role,
      role_selected: true,
      has_password: true
    })
  });

  if (!profileResponse.ok && profileResponse.status !== 409) {
    await fetch(`${supabaseUrl}/auth/v1/admin/users/${created.id}`, {
      method: "DELETE",
      headers
    }).catch(() => {});

    const detail = await profileResponse.text().catch(() => "");
    return res.status(500).json({ error: detail || "Could not create the account profile." });
  }

  return res.status(201).json({
    created: true,
    userId: created.id,
    loginEmail: authEmail
  });
}

/* ============================================================
   DELETE ACCOUNT
   ============================================================ */
async function deleteAccount(body, res) {
  const accessToken = body?.accessToken;
  if (!accessToken) return res.status(400).json({ error: "accessToken is required." });

  const supabaseUrl = env("SUPABASE_URL");
  const anonKey = env("SUPABASE_ANON_KEY");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) return res.status(500).json({ error: "Supabase server configuration is incomplete." });

  const svcHeaders = serviceHeaders(serviceKey);
  const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` }
  });
  const me = await readJson(userResponse);
  if (!userResponse.ok || !me?.id) return res.status(401).json({ error: "Invalid or expired session. Please log in again." });

  const uid = me.id;

  const vendorResponse = await fetch(
    `${supabaseUrl}/rest/v1/vendors?user_id=eq.${encodeURIComponent(uid)}&select=id`,
    { headers: svcHeaders }
  );
  const vendorRows = vendorResponse.ok ? await readJson(vendorResponse) : [];
  const vendorIds = (Array.isArray(vendorRows) ? vendorRows : []).map(row => row.id).filter(Boolean);

  if (vendorIds.length) {
    const ids = vendorIds.join(",");
    const ordersResponse = await fetch(
      `${supabaseUrl}/rest/v1/orders?vendor_id=in.(${ids})&status=not.in.(completed,cancelled)&select=id,status`,
      { headers: svcHeaders }
    );
    const activeOrders = ordersResponse.ok ? await readJson(ordersResponse) : [];
    if (Array.isArray(activeOrders) && activeOrders.length) {
      return res.status(400).json({
        error: `You cannot delete your vendor account while ${activeOrders.length} order(s) are still active. Complete or cancel every active order first.`
      });
    }

    const commissionResponse = await fetch(
      `${supabaseUrl}/rest/v1/commission_charges?vendor_id=in.(${ids})&status=eq.owed&select=amount`,
      { headers: svcHeaders }
    );
    if (commissionResponse.ok) {
      const charges = await readJson(commissionResponse);
      const owed = (Array.isArray(charges) ? charges : []).reduce((sum, row) => sum + Number(row?.amount || 0), 0);
      if (owed > 0) {
        return res.status(400).json({
          error: `You have ₦${owed.toLocaleString()} in unsettled commission. Clear it before deleting your vendor account.`
        });
      }
    }
  }

  // Capture conversations before the SQL wipe so their storage attachments
  // can also be removed.
  let conversationIds = [];
  const conversationFilter = vendorIds.length
    ? `or=(buyer_id.eq.${uid},vendor_id.in.(${vendorIds.join(",")}))`
    : `buyer_id=eq.${uid}`;
  const conversationResponse = await fetch(
    `${supabaseUrl}/rest/v1/conversations?${conversationFilter}&select=id`,
    { headers: svcHeaders }
  );
  if (conversationResponse.ok) {
    const rows = await readJson(conversationResponse);
    conversationIds = (Array.isArray(rows) ? rows : []).map(row => row.id).filter(Boolean);
  }

  // The SQL function performs the FK-safe public-table deletion. It MUST
  // delete chat_usage before users; otherwise PostgreSQL rejects the wipe.
  const deleteResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/delete_my_account`, {
    method: "POST",
    headers: svcHeaders,
    body: JSON.stringify({ p_user_id: uid })
  });
  const deleteBody = await readJson(deleteResponse);
  if (!deleteResponse.ok) {
    return res.status(500).json({
      error: deleteBody?.message || deleteBody?.hint || deleteBody?.details || "Account data could not be fully deleted. Run the updated delete_my_account SQL function in Supabase first."
    });
  }

  async function listStorage(bucket, prefix) {
    if (!prefix) return [];
    const response = await fetch(`${supabaseUrl}/storage/v1/object/list/${encodeURIComponent(bucket)}`, {
      method: "POST",
      headers: svcHeaders,
      body: JSON.stringify({ prefix, limit: 1000, offset: 0, sortBy: { column: "name", order: "asc" } })
    });
    if (!response.ok) return [];
    const rows = await readJson(response);
    return (Array.isArray(rows) ? rows : []).filter(row => row?.name && !String(row.name).endsWith("/"));
  }

  async function removeStorage(bucket, names) {
    if (!names.length) return;
    const response = await fetch(`${supabaseUrl}/storage/v1/object/remove`, {
      method: "POST",
      headers: svcHeaders,
      body: JSON.stringify(names.map(name => ({ bucket_id: bucket, name })))
    });
    if (!response.ok) throw new Error(`Could not delete files from ${bucket}.`);
  }

  const storageTargets = [
    ["avatars", [uid]],
    ["vendor-docs", [uid]],
    ["vendor-logos", vendorIds],
    ["product-photos", vendorIds],
    ["chat-attachments", conversationIds.map(id => `conv/${id}`)]
  ];

  for (const [bucket, prefixes] of storageTargets) {
    for (const prefix of prefixes) {
      const objects = await listStorage(bucket, prefix);
      await removeStorage(bucket, objects.map(object => object.name));
    }
  }

  // Hard-delete the Auth identity. Supabase documents that a normal admin
  // delete removes the auth.users row and cascades its sessions/refresh
  // tokens. Existing access JWTs cannot be retroactively changed, so the
  // frontend also validates the current user before treating a session as
  // logged in.
  const authDeleteResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users/${uid}`, {
    method: "DELETE",
    headers: svcHeaders
  });

  if (!authDeleteResponse.ok) {
    const detail = await authDeleteResponse.text().catch(() => "");
    return res.status(500).json({
      error: detail || "Marketplace data was deleted, but the authentication account could not be removed."
    });
  }

  return res.status(200).json({ deleted: true });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });

  try {
    const rawBody = await readBody(req);
    const body = typeof rawBody === "string" ? JSON.parse(rawBody || "{}") : (rawBody || {});
    const action = String(body.action || "").toLowerCase();

    if (action === "account-exists" || action === "check-email") return accountExists(body, res);
    if (action === "register") return registerAccount(body, res);
    return deleteAccount(body, res);
  } catch (error) {
    console.error("Levromart account API error:", error);
    return res.status(500).json({ error: error?.message || "Could not complete the account request." });
  }
};
