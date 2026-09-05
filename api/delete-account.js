const { readBody, env } = require("./_util");

function serviceHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json"
  };
}

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
    role
  } = body || {};

  const cleanEmail =
    String(email || "").trim().toLowerCase();

  const cleanName =
    String(name || "").trim();

  const cleanPhone =
    String(phone || "").trim();

  const normalizedPhone =
    normalizePhone(cleanPhone);

  if (!cleanEmail || !cleanEmail.includes("@")) {
    return res.status(400).json({
      error: "A valid email address is required."
    });
  }

  if (!cleanName) {
    return res.status(400).json({
      error: "Full name is required."
    });
  }

  if (!cleanPhone || normalizedPhone.length < 10) {
    return res.status(400).json({
      error: "A valid phone number is required."
    });
  }

  if (!password || password.length < 8) {
    return res.status(400).json({
      error:
        "Password must be at least 8 characters."
    });
  }

  if (
    role !== "buyer" &&
    role !== "vendor"
  ) {
    return res.status(400).json({
      error: "Invalid account type."
    });
  }

  const SUPABASE_URL =
    env("SUPABASE_URL");

  const SERVICE_KEY =
    env("SUPABASE_SERVICE_ROLE_KEY");

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({
      error:
        "Supabase server configuration is incomplete."
    });
  }

  const headers =
    serviceHeaders(SERVICE_KEY);


  /* ----------------------------------------------------------
     CHECK WHETHER EMAIL ALREADY EXISTS
     ---------------------------------------------------------- */

  const existingResponse =
    await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(cleanEmail)}`,
      {
        headers
      }
    );

  if (existingResponse.ok) {

    const existingData =
      await existingResponse
        .json()
        .catch(() => ({}));

    const users =
      Array.isArray(existingData)
        ? existingData
        : existingData?.users || [];

    const exists =
      users.some(
        user =>
          String(user?.email || "")
            .toLowerCase() === cleanEmail
      );

    if (exists) {
      return res.status(409).json({
        error:
          "An account with that email already exists. Please log in instead."
      });
    }
  }


  /* ----------------------------------------------------------
     CREATE SUPABASE AUTH USER
     
     email_confirm:true is the important part.
     
     It means:
     - account is immediately confirmed
     - no confirmation link is required
     - no confirmation email is sent
     ---------------------------------------------------------- */

  const createResponse =
    await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          email: cleanEmail,
          password,
          email_confirm: true,
          user_metadata: {
            name: cleanName,
            phone: cleanPhone,
            city:
              String(city || "").trim(),
            role
          }
        })
      }
    );

  const created =
    await createResponse
      .json()
      .catch(() => ({}));

  if (
    !createResponse.ok ||
    !created?.id
  ) {
    return res.status(
      createResponse.status || 400
    ).json({
      error:
        created?.msg ||
        created?.message ||
        "Could not create the account."
    });
  }


  /* ----------------------------------------------------------
     CREATE PUBLIC USER PROFILE
     ---------------------------------------------------------- */

  const profileResponse =
    await fetch(
      `${SUPABASE_URL}/rest/v1/users`,
      {
        method: "POST",
        headers: {
          ...headers,
          Prefer:
            "resolution=ignore-duplicates,return=minimal"
        },
        body: JSON.stringify({
          id: created.id,
          name: cleanName,
          email: cleanEmail,
          phone: cleanPhone,
          city:
            String(city || "").trim(),
          role,
          role_selected: true,
          has_password: true
        })
      }
    );

  if (
    !profileResponse.ok &&
    profileResponse.status !== 409
  ) {

    // Roll back Auth if profile creation fails.
    await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users/${created.id}`,
      {
        method: "DELETE",
        headers
      }
    );

    const detail =
      await profileResponse
        .text()
        .catch(() => "");

    return res.status(500).json({
      error:
        detail ||
        "Could not create the account profile."
    });
  }


  return res.status(201).json({
    created: true,
    userId: created.id
  });
}


/* ============================================================
   DELETE ACCOUNT
   ============================================================ */

async function deleteAccount(body, res) {

  const accessToken =
    body?.accessToken;

  if (!accessToken) {
    return res.status(400).json({
      error: "accessToken is required."
    });
  }

  const SUPABASE_URL =
    env("SUPABASE_URL");

  const SUPABASE_ANON_KEY =
    env("SUPABASE_ANON_KEY");

  const SERVICE_KEY =
    env("SUPABASE_SERVICE_ROLE_KEY");

  const anonHeaders = {
    apikey: SUPABASE_ANON_KEY,
    Authorization:
      `Bearer ${accessToken}`
  };

  const svcHeaders =
    serviceHeaders(SERVICE_KEY);


  /* ----------------------------------------------------------
     VERIFY SESSION
     ---------------------------------------------------------- */

  const meResponse =
    await fetch(
      `${SUPABASE_URL}/auth/v1/user`,
      {
        headers: anonHeaders
      }
    );

  const me =
    await meResponse
      .json()
      .catch(() => ({}));

  if (
    !meResponse.ok ||
    !me?.id
  ) {
    return res.status(401).json({
      error: "Invalid session."
    });
  }

  const uid = me.id;


  /* ----------------------------------------------------------
     FIND VENDOR RECORDS
     ---------------------------------------------------------- */

  const vendorResponse =
    await fetch(
      `${SUPABASE_URL}/rest/v1/vendors` +
      `?user_id=eq.${encodeURIComponent(uid)}` +
      `&select=id`,
      {
        headers: svcHeaders
      }
    );

  const vendorRows =
    vendorResponse.ok
      ? await vendorResponse.json()
      : [];

  const vendorIds =
    (vendorRows || [])
      .map(row => row.id)
      .filter(Boolean);


  /* ----------------------------------------------------------
     VENDOR DELETION RESTRICTIONS
     ---------------------------------------------------------- */

  if (vendorIds.length) {

    const ids =
      vendorIds.join(",");


    // Active orders block vendor deletion.
    const ordersResponse =
      await fetch(
        `${SUPABASE_URL}/rest/v1/orders` +
        `?vendor_id=in.(${ids})` +
        `&status=not.in.(completed,cancelled)` +
        `&select=id,status`,
        {
          headers: svcHeaders
        }
      );

    const activeOrders =
      ordersResponse.ok
        ? await ordersResponse.json()
        : [];

    if (activeOrders.length) {
      return res.status(400).json({
        error:
          `You cannot delete your vendor account while ` +
          `${activeOrders.length} order(s) are still active. ` +
          `Complete or cancel every active order first.`
      });
    }


    // Unsettled commission blocks vendor deletion.
    const commissionResponse =
      await fetch(
        `${SUPABASE_URL}/rest/v1/commission_charges` +
        `?vendor_id=in.(${ids})` +
        `&status=eq.owed` +
        `&select=amount`,
        {
          headers: svcHeaders
        }
      );

    if (commissionResponse.ok) {

      const charges =
        await commissionResponse.json();

      const owed =
        (charges || []).reduce(
          (sum, row) =>
            sum +
            Number(row?.amount || 0),
          0
        );

      if (owed > 0) {
        return res.status(400).json({
          error:
            `You have ₦${owed.toLocaleString()} ` +
            `in unsettled commission. ` +
            `Clear it before deleting your vendor account.`
        });
      }
    }
  }


  /* ----------------------------------------------------------
     CAPTURE CONVERSATIONS BEFORE DATABASE WIPE
     ---------------------------------------------------------- */

  let conversationIds = [];

  const conversationFilter =
    vendorIds.length
      ? `or=(buyer_id.eq.${uid},vendor_id.in.(${vendorIds.join(",")}))`
      : `buyer_id=eq.${uid}`;

  const conversationResponse =
    await fetch(
      `${SUPABASE_URL}/rest/v1/conversations` +
      `?${conversationFilter}&select=id`,
      {
        headers: svcHeaders
      }
    );

  if (conversationResponse.ok) {

    const rows =
      await conversationResponse.json();

    conversationIds =
      (rows || [])
        .map(row => row.id)
        .filter(Boolean);
  }


  /* ----------------------------------------------------------
     DATABASE WIPE
     ---------------------------------------------------------- */

  const deleteResponse =
    await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/delete_my_account`,
      {
        method: "POST",
        headers: svcHeaders,
        body: JSON.stringify({
          p_user_id: uid
        })
      }
    );

  const deleteBody =
    await deleteResponse
      .json()
      .catch(() => ({}));

  if (!deleteResponse.ok) {

    return res.status(500).json({
      error:
        deleteBody?.message ||
        deleteBody?.hint ||
        deleteBody?.details ||
        "The delete_my_account function is not installed in Supabase."
    });
  }


  /* ----------------------------------------------------------
     STORAGE CLEANUP
     ---------------------------------------------------------- */

  async function listStorage(
    bucket,
    prefix
  ) {

    if (!prefix) return [];

    const response =
      await fetch(
        `${SUPABASE_URL}/storage/v1/object/list/${encodeURIComponent(bucket)}`,
        {
          method: "POST",
          headers: svcHeaders,
          body: JSON.stringify({
            prefix,
            limit: 1000,
            offset: 0,
            sortBy: {
              column: "name",
              order: "asc"
            }
          })
        }
      );

    if (!response.ok) {
      return [];
    }

    const rows =
      await response
        .json()
        .catch(() => []);

    return (rows || []).filter(
      row =>
        row?.name &&
        !String(row.name)
          .endsWith("/")
    );
  }


  async function removeStorage(
    bucket,
    names
  ) {

    if (!names.length) return;

    const response =
      await fetch(
        `${SUPABASE_URL}/storage/v1/object/remove`,
        {
          method: "POST",
          headers: svcHeaders,
          body: JSON.stringify(
            names.map(name => ({
              bucket_id: bucket,
              name
            }))
          )
        }
      );

    if (!response.ok) {
      throw new Error(
        `Could not delete files from ${bucket}.`
      );
    }
  }


  const storageTargets = [

    ["avatars", [uid]],

    ["vendor-docs", [uid]],

    ["vendor-logos", vendorIds],

    ["product-photos", vendorIds],

    [
      "chat-attachments",
      conversationIds.map(
        id => `conv/${id}`
      )
    ]

  ];


  for (
    const [bucket, prefixes]
    of storageTargets
  ) {

    for (
      const prefix
      of prefixes
    ) {

      const objects =
        await listStorage(
          bucket,
          prefix
        );

      await removeStorage(
        bucket,
        objects.map(
          object => object.name
        )
      );
    }
  }


  /* ----------------------------------------------------------
     DELETE AUTH IDENTITY
     
     THIS is what makes the email available again.
     ---------------------------------------------------------- */

  const authDeleteResponse =
    await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users/${uid}`,
      {
        method: "DELETE",
        headers: svcHeaders
      }
    );

  if (!authDeleteResponse.ok) {

    const detail =
      await authDeleteResponse
        .text()
        .catch(() => "");

    return res.status(500).json({
      error:
        detail ||
        "Marketplace data was deleted, but the authentication account could not be removed."
    });
  }


  return res.status(200).json({
    deleted: true
  });
}


/* ============================================================
   SINGLE VERCEL FUNCTION
   ============================================================ */

module.exports = async function handler(
  req,
  res
) {

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed."
    });
  }

  try {

    const rawBody =
      await readBody(req);

    const body =
      typeof rawBody === "string"
        ? JSON.parse(rawBody || "{}")
        : (rawBody || {});


    // Registration uses this SAME function.
    if (body.action === "register") {
      return await registerAccount(
        body,
        res
      );
    }


    // Everything else with an accessToken
    // is an account-deletion request.
    return await deleteAccount(
      body,
      res
    );

  } catch (error) {

    console.error(
      "Levromart account API error:",
      error
    );

    return res.status(500).json({
      error:
        error?.message ||
        "Could not complete the account request."
    });
  }
};
