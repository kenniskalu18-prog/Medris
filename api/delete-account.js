const { readBody, env } = require("./_util");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const body = JSON.parse(await readBody(req));
    const accessToken = body?.accessToken;

    if (!accessToken) {
      return res.status(400).json({
        error: "accessToken is required"
      });
    }

    const SUPABASE_URL = env("SUPABASE_URL");
    const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY");
    const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

    const anonHeaders = {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`
    };

    const svcHeaders = {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json"
    };

    // Verify the current session.
    const meRes = await fetch(
      `${SUPABASE_URL}/auth/v1/user`,
      {
        headers: anonHeaders
      }
    );

    const me = await meRes.json().catch(() => ({}));

    if (!meRes.ok || !me?.id) {
      return res.status(401).json({
        error: "Invalid session"
      });
    }

    const uid = me.id;

    // Find vendor records before deleting anything.
    const vendorRes = await fetch(
      `${SUPABASE_URL}/rest/v1/vendors?user_id=eq.${encodeURIComponent(uid)}&select=id`,
      {
        headers: svcHeaders
      }
    );

    const vendorRows = vendorRes.ok
      ? await vendorRes.json()
      : [];

    const vendorIds = (vendorRows || [])
      .map(row => row.id)
      .filter(Boolean);

    // Buyers may delete even with pending orders.
    // Vendors must finish or cancel all active orders.
    if (vendorIds.length) {
      const ids = vendorIds.join(",");

      const activeRes = await fetch(
        `${SUPABASE_URL}/rest/v1/orders?vendor_id=in.(${ids})&status=not.in.(completed,cancelled)&select=id,status`,
        {
          headers: svcHeaders
        }
      );

      const activeOrders = activeRes.ok
        ? await activeRes.json()
        : [];

      if (activeOrders.length) {
        return res.status(400).json({
          error:
            `You cannot delete a vendor account while ${activeOrders.length} ` +
            `order(s) are still active. Complete or cancel every vendor order first.`
        });
      }

      // Vendors must have no unsettled commission.
      const commissionRes = await fetch(
        `${SUPABASE_URL}/rest/v1/commission_charges?vendor_id=in.(${ids})&status=eq.owed&select=amount`,
        {
          headers: svcHeaders
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
              `Clear it before deleting your vendor account.`
          });
        }
      }
    }

    // Capture conversation IDs before deleting database rows.
    let conversationIds = [];

    const conversationFilter = vendorIds.length
      ? `or=(buyer_id.eq.${uid},vendor_id.in.(${vendorIds.join(",")}))`
      : `buyer_id=eq.${uid}`;

    const convRes = await fetch(
      `${SUPABASE_URL}/rest/v1/conversations?${conversationFilter}&select=id`,
      {
        headers: svcHeaders
      }
    );

    if (convRes.ok) {
      const rows = await convRes.json();

      conversationIds = (rows || [])
        .map(row => row.id)
        .filter(Boolean);
    }

    // Complete database wipe.
    const rpcRes = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/delete_my_account`,
      {
        method: "POST",
        headers: svcHeaders,
        body: JSON.stringify({
          p_user_id: uid
        })
      }
    );

    const rpcBody = await rpcRes.json().catch(() => ({}));

    if (!rpcRes.ok) {
      return res.status(500).json({
        error:
          rpcBody?.message ||
          rpcBody?.hint ||
          rpcBody?.details ||
          "The account deletion function is not installed. Run the delete_my_account SQL in Supabase first."
      });
    }

    // Storage cleanup.
    async function listStorage(bucket, prefix) {
      if (!prefix) return [];

      const response = await fetch(
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

      if (!response.ok) return [];

      const rows = await response.json().catch(() => []);

      return (rows || []).filter(
        row =>
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

    for (const [bucket, prefixes] of storageTargets) {
      for (const prefix of prefixes) {
        const objects = await listStorage(
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

    // IMPORTANT:
    // Delete the actual Supabase Auth identity.
    // This is what allows the same email to register again later.
    const authDelete = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users/${uid}`,
      {
        method: "DELETE",
        headers: svcHeaders
      }
    );

    if (!authDelete.ok) {
      const detail = await authDelete
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

  } catch (err) {
    console.error(
      "Delete account error:",
      err
    );

    return res.status(500).json({
      error:
        err?.message ||
        "Could not delete the account."
    });
  }
};
