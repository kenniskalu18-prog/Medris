const { readBody, env } = require("./_util");

function normalizePhone(phone) {
  let digits = String(phone || "").replace(/\D/g, "");

  if (digits.startsWith("00")) {
    digits = digits.slice(2);
  }

  if (digits.startsWith("0") && digits.length === 11) {
    digits = "234" + digits.slice(1);
  }

  return digits;
}

function aliasFromPhone(phone) {
  const digits = normalizePhone(phone);
  return digits ? `p${digits}@accounts.levromart.app` : "";
}

function serviceHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };
}


/* ============================================================
   ACCOUNT EXISTS
   ============================================================ */

async function accountExists(body, res) {
  const email = String(body?.email || "").trim().toLowerCase();

  if (!email || !email.includes("@")) {
    return res.status(400).json({
      error: "A valid email is required.",
    });
  }

  const SUPABASE_URL = env("SUPABASE_URL");
  const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

  const headers = serviceHeaders(SERVICE_KEY);

  /*
   * Check the public profile first.
   * We only return a boolean and never expose account information.
   */
  const profileRes = await fetch(
    `${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(
      email
    )}&select=id&limit=1`,
    {
      headers,
    }
  );

  if (profileRes.ok) {
    const rows = await profileRes.json().catch(() => []);

    if (Array.isArray(rows) && rows.length > 0) {
      return res.status(200).json({
        exists: true,
      });
    }
  }

  /*
   * Then check Supabase Auth.
   */
  const authRes = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`,
    {
      headers,
    }
  );

  if (authRes.ok) {
    const data = await authRes.json().catch(() => ({}));

    const users = Array.isArray(data)
      ? data
      : data?.users || [];

    const exists = users.some(
      (user) =>
        String(user?.email || "").toLowerCase() === email
    );

    return res.status(200).json({
      exists,
    });
  }

  return res.status(200).json({
    exists: false,
  });
}


/* ============================================================
   REGISTER ACCOUNT
   ============================================================ */

async function registerAccount(body, res) {
  const {
    email,
    password,
    name,
    phone,
    city,
    role,
  } = body || {};

  const normalizedPhone = normalizePhone(phone);

  if (
    !name ||
    !password ||
    password.length < 8 ||
    normalizedPhone.length < 10
  ) {
    return res.status(400).json({
      error:
        "Name, a valid phone number, and a password of at least 8 characters are required.",
    });
  }

  if (role !== "buyer" && role !== "vendor") {
    return res.status(400).json({
      error: "Invalid account role.",
    });
  }

  const SUPABASE_URL = env("SUPABASE_URL");
  const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

  const headers = serviceHeaders(SERVICE_KEY);

  /*
   * Email is optional.
   *
   * If the user does not provide an email, create an internal
   * login alias based on the phone number.
   */
  const authEmail =
    String(email || "").trim().toLowerCase() ||
    aliasFromPhone(phone);

  if (!authEmail) {
    return res.status(400).json({
      error: "A valid phone number is required.",
    });
  }

  /*
   * Prevent duplicate accounts.
   */
  const existingRes = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(
      authEmail
    )}`,
    {
      headers,
    }
  );

  if (existingRes.ok) {
    const data = await existingRes.json().catch(() => ({}));

    const users = Array.isArray(data)
      ? data
      : data?.users || [];

    const alreadyExists = users.some(
      (user) =>
        String(user?.email || "").toLowerCase() ===
        authEmail.toLowerCase()
    );

    if (alreadyExists) {
      return res.status(409).json({
        error:
          "An account with that email or phone already exists. Log in instead.",
      });
    }
  }

  /*
   * Create the Auth account from the server.
   *
   * email_confirm:true means Supabase will NOT require the
   * normal confirmation-email flow.
   */
  const createRes = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        email: authEmail,
        password,
        email_confirm: true,
        user_metadata: {
          name,
          phone: String(phone).trim(),
          city: String(city || "").trim(),
          role,
        },
      }),
    }
  );

  const created = await createRes.json().catch(() => ({}));

  if (!createRes.ok || !created?.id) {
    return res.status(createRes.status || 400).json({
      error:
        created?.msg ||
        created?.message ||
        "Could not create the account.",
    });
  }

  /*
   * Create the public profile.
   *
   * The ignore-duplicates preference makes this safe if the
   * project's existing handle_new_user trigger already created
   * the row.
   */
  const profileRes = await fetch(
    `${SUPABASE_URL}/rest/v1/users?select=id`,
    {
      method: "POST",
      headers: {
        ...headers,
        Prefer: "resolution=ignore-duplicates,return=minimal",
      },
      body: JSON.stringify({
        id: created.id,
        name,
        email: authEmail,
        phone: String(phone).trim(),
        city: String(city || "").trim(),
        role,
        role_selected: true,
        has_password: true,
      }),
    }
  );

  if (!profileRes.ok && profileRes.status !== 409) {
    /*
     * Roll back the Auth account if the profile could not
     * be created. This prevents half-created accounts.
     */
    await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users/${created.id}`,
      {
        method: "DELETE",
        headers,
      }
    );

    const detail = await profileRes.text().catch(() => "");

    return res.status(500).json({
      error:
        detail ||
        "Could not create the account profile.",
    });
  }

  return res.status(201).json({
    created: true,
  });
}


/* ============================================================
   DELETE ACCOUNT
   ============================================================ */

async function deleteAccount(body, res) {
  const accessToken = body?.accessToken;

  if (!accessToken) {
    return res.status(400).json({
      error: "accessToken is required",
    });
  }

  const SUPABASE_URL = env("SUPABASE_URL");
  const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY");
  const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

  const anonHeaders = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${accessToken}`,
  };

  const svcHeaders = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
  };

  /*
   * Verify the current session.
   */
  const meRes = await fetch(
    `${SUPABASE_URL}/auth/v1/user`,
    {
      headers: anonHeaders,
    }
  );

  const me = await meRes.json().catch(() => ({}));

  if (!meRes.ok || !me?.id) {
    return res.status(401).json({
      error: "Invalid session",
    });
  }

  const uid = me.id;

  /*
   * Find vendor records belonging to this account.
   */
  const vendorRes = await fetch(
    `${SUPABASE_URL}/rest/v1/vendors?user_id=eq.${uid}&select=id`,
    {
      headers: svcHeaders,
    }
  );

  const vendorRows = vendorRes.ok
    ? await vendorRes.json()
    : [];

  const vendorIds = (vendorRows || [])
    .map((vendor) => vendor.id)
    .filter(Boolean);

  /*
   * VENDOR DELETION RULE
   *
   * Vendors cannot delete while any order is still active.
   *
   * Buyers are deliberately NOT checked here, meaning buyers
   * may delete their accounts even if they have pending orders.
   */
  if (vendorIds.length) {
    const activeRes = await fetch(
      `${SUPABASE_URL}/rest/v1/orders?vendor_id=in.(${vendorIds.join(
        ","
      )})&status=not.in.(completed,cancelled)&select=id,status`,
      {
        headers: svcHeaders,
      }
    );

    const activeRows = activeRes.ok
      ? await activeRes.json()
      : [];

    if ((activeRows || []).length) {
      return res.status(400).json({
        error:
          `You cannot delete a vendor account while ${activeRows.length} ` +
          `order(s) are still active. Complete or cancel every vendor order first.`,
      });
    }

    /*
     * Vendors must also clear unsettled commission.
     */
    const commissionRes = await fetch(
      `${SUPABASE_URL}/rest/v1/commission_charges?vendor_id=in.(${vendorIds.join(
        ","
      )})&status=eq.owed&select=amount`,
      {
        headers: svcHeaders,
      }
    );

    if (commissionRes.ok) {
      const charges = await commissionRes.json();

      const owed = (charges || []).reduce(
        (sum, row) =>
          sum + Number(row?.amount || 0),
        0
      );

      if (owed > 0) {
        return res.status(400).json({
          error:
            `You have ₦${owed.toLocaleString()} in unsettled commission. ` +
            `Clear it before deleting your vendor account.`,
        });
      }
    }
  }

  /*
   * Capture conversation IDs before database deletion so their
   * attachment folders can also be removed.
   */
  let conversationIds = [];

  const conversationFilter = vendorIds.length
    ? `or=(buyer_id.eq.${uid},vendor_id.in.(${vendorIds.join(
        ","
      )}))`
    : `buyer_id=eq.${uid}`;

  const convRes = await fetch(
    `${SUPABASE_URL}/rest/v1/conversations?${conversationFilter}&select=id`,
    {
      headers: svcHeaders,
    }
  );

  if (convRes.ok) {
    const rows = await convRes.json();

    conversationIds = (rows || [])
      .map((row) => row.id)
      .filter(Boolean);
  }

  /*
   * Storage helper.
   */
  async function listStorage(bucket, prefix) {
    if (!prefix) return [];

    const response = await fetch(
      `${SUPABASE_URL}/storage/v1/object/list/${encodeURIComponent(
        bucket
      )}`,
      {
        method: "POST",
        headers: svcHeaders,
        body: JSON.stringify({
          prefix,
          limit: 1000,
          offset: 0,
          sortBy: {
            column: "name",
            order: "asc",
          },
        }),
      }
    );

    if (!response.ok) return [];

    const rows = await response.json().catch(() => []);

    return (rows || []).filter(
      (row) =>
        row?.name &&
        !String(row.name).endsWith("/")
    );
  }

  async function removeStorage(bucket, names) {
    if (!names.length) return;

    const response = await fetch(
      `${SUPABASE_URL}/storage/v1/object/remove`,
      {
        method: "POST",
        headers: svcHeaders,
        body: JSON.stringify(
          names.map((name) => ({
            bucket_id: bucket,
            name,
          }))
        ),
      }
    );

    if (!response.ok) {
      throw new Error(
        `Could not delete files from ${bucket}.`
      );
    }
  }

  /*
   * The database function is the source of truth for the complete
   * database wipe.
   *
   * This must exist in Supabase:
   *
   * delete_my_account()
   */
  const rpcRes = await fetch(
    `${SUPABASE_URL}/rest/v1/rpc/delete_my_account`,
    {
      method: "POST",
      headers: svcHeaders,
      body: "{}",
    }
  );

  const rpcBody = await rpcRes.json().catch(() => ({}));

  if (!rpcRes.ok) {
    return res.status(500).json({
      error:
        rpcBody?.message ||
        rpcBody?.hint ||
        rpcBody?.details ||
        "The account deletion function is not installed or could not complete. Run delete_my_account.sql in Supabase first.",
    });
  }

  /*
   * Remove Storage objects belonging to the user.
   */
  const storageTargets = [
    ["avatars", [uid]],
    ["vendor-docs", [uid]],
    ["vendor-logos", vendorIds],
    ["product-photos", vendorIds],
    [
      "chat-attachments",
      conversationIds.map(
        (id) => `conv/${id}`
      ),
    ],
  ];

  for (const [bucket, prefixes] of storageTargets) {
    for (const prefix of prefixes) {
      const objects = await listStorage(
        bucket,
        prefix
      );

      await removeStorage(
        bucket,
        objects.map((object) => object.name)
      );
    }
  }

  /*
   * Finally delete the Supabase Auth identity.
   */
  const authDelete = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users/${uid}`,
    {
      method: "DELETE",
      headers: svcHeaders,
    }
  );

  if (!authDelete.ok) {
    const detail = await authDelete
      .text()
      .catch(() => "");

    return res.status(500).json({
      error:
        detail ||
        "Marketplace data was deleted, but the authentication identity could not be removed. Contact an administrator.",
    });
  }

  return res.status(200).json({
    deleted: true,
  });
}


/* ============================================================
   SINGLE VERCEL FUNCTION
   ============================================================ */

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  try {
    const body = JSON.parse(
      await readBody(req)
    );

    /*
     * We intentionally support the old frontend calls without
     * requiring index.html to be rewritten.
     *
     * /api/delete-account
     *   -> accessToken
     *
     * /api/register
     *   -> password + name + role
     *
     * /api/account-exists
     *   -> email only
     *
     * An explicit "action" is also supported for future use.
     */
    const action = String(
      body?.action || ""
    ).trim().toLowerCase();

    if (
      action === "register" ||
      (!action &&
        body?.password &&
        body?.name &&
        body?.role)
    ) {
      return await registerAccount(
        body,
        res
      );
    }

    if (
      action === "account-exists" ||
      (!action &&
        body?.email &&
        !body?.password &&
        !body?.accessToken)
    ) {
      return await accountExists(
        body,
        res
      );
    }

    if (
      action === "delete" ||
      body?.accessToken
    ) {
      return await deleteAccount(
        body,
        res
      );
    }

    return res.status(400).json({
      error:
        "Invalid account operation.",
    });
  } catch (err) {
    console.error(
      "Account API error:",
      err
    );

    return res.status(500).json({
      error:
        err?.message ||
        "Server error",
    });
  }
};
