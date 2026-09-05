// POST { accessToken } -> { deleted: true }
// Deletes the caller's account. We don't hard-delete the `users` row —
// auth.users has ON DELETE CASCADE onto it, and deleting straight through
// would cascade into orders/reviews too, wiping out history that belongs
// to the *other* party in any past transaction. Instead: anonymize the
// profile and permanently ban the login, which is the standard safe
// pattern for this exact FK-cascade situation.
//
// Anything that's exclusively this user's own data, with no other party
// depending on it, is actually deleted outright rather than anonymized:
// wishlist, Levi chat history, their own notification inbox, and push
// subscriptions. Orders/payments/reviews/messages/equipment requests stay
// (anonymized where the schema allows it) because deleting those rows
// would also destroy the other side's transaction or conversation record
// — e.g. a request's offers cascade from the request itself, so wiping a
// buyer's old request would silently erase a vendor's response to it.

const { readBody, env } = require("./_util");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { accessToken } = JSON.parse(await readBody(req));

    if (!accessToken) {
      res.status(400).json({ error: "accessToken is required" });
      return;
    }

    const SUPABASE_URL = env("SUPABASE_URL");
    const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY");
    const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

    const svcAuth = {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    };

    const svcHeaders = {
      ...svcAuth,
      "Content-Type": "application/json",
    };

    // Verify the user's current Supabase session.
    const meRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const me = await meRes.json();

    if (!meRes.ok || !me?.id) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }

    /*
     * Vendor deletion rule:
     *
     * Vendors may NOT delete their account while:
     * - they have an active/pending order
     * - they have a confirmed order
     * - an order is being handed over
     * - an order is being returned
     * - an order is disputed
     * - they have unsettled commission
     *
     * Buyers are NOT blocked by pending orders.
     */
    const ACTIVE_STATUSES =
      "pending,confirmed,handed_over,returned,disputed";

    // Find whether this user is a vendor.
    const vendorRes = await fetch(
      `${SUPABASE_URL}/rest/v1/vendors?user_id=eq.${me.id}&select=id`,
      {
        headers: svcAuth,
      }
    );

    const vendorRows = await vendorRes.json();
    const [vendorRow] = vendorRows || [];

    if (vendorRow) {
      // Check unsettled vendor commission.
      const owedRes = await fetch(
        `${SUPABASE_URL}/rest/v1/commission_charges?vendor_id=eq.${vendorRow.id}&status=eq.owed&select=amount`,
        {
          headers: svcAuth,
        }
      );

      const owed = await owedRes.json();

      const totalOwed = (owed || []).reduce(
        (sum, row) => sum + Number(row.amount || 0),
        0
      );

      if (totalOwed > 0) {
        res.status(400).json({
          error:
            `You have ₦${totalOwed.toLocaleString()} in unsettled commission. ` +
            `Pay it off first, then delete your account.`,
        });
        return;
      }

      // Check for active vendor orders.
      const activeVendorOrdersRes = await fetch(
        `${SUPABASE_URL}/rest/v1/orders?vendor_id=eq.${vendorRow.id}&status=in.(${ACTIVE_STATUSES})&select=id`,
        {
          headers: svcAuth,
        }
      );

      const activeVendorOrders = await activeVendorOrdersRes.json();

      if ((activeVendorOrders || []).length > 0) {
        res.status(400).json({
          error:
            `You have ${activeVendorOrders.length} order(s) still in progress as a vendor. ` +
            `Complete or cancel them first.`,
        });
        return;
      }
    }

    /*
     * Anonymize the public user profile rather than deleting the row.
     *
     * This protects historical orders, reviews, messages, etc. belonging
     * to the other party in previous transactions.
     */
    const anonEmail = `deleted-${me.id}@medris.invalid`;

    await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${me.id}`, {
      method: "PATCH",
      headers: {
        ...svcHeaders,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        name: "Deleted user",
        email: anonEmail,
        avatar_url: null,
        phone: null,
      }),
    });

    /*
     * If the account belongs to a vendor, deactivate and clear their
     * storefront information.
     */
    if (vendorRow) {
      await fetch(
        `${SUPABASE_URL}/rest/v1/vendors?id=eq.${vendorRow.id}`,
        {
          method: "PATCH",
          headers: {
            ...svcHeaders,
            Prefer: "return=minimal",
          },
          body: JSON.stringify({
            is_active: false,
            bio: null,
            phone: null,
            whatsapp_number: null,
            logo_url: null,
            cac_number: null,
            lat: null,
            lng: null,
            address: null,
            city: null,
            opening_hours: null,
          }),
        }
      );
    }

    /*
     * Delete data that belongs exclusively to the deleted user.
     *
     * Historical orders/conversations/reviews are intentionally preserved
     * because another user may depend on those records.
     */
    await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/favorites?buyer_id=eq.${me.id}`,
        {
          method: "DELETE",
          headers: svcAuth,
        }
      ),

      fetch(
        `${SUPABASE_URL}/rest/v1/ai_conversations?user_id=eq.${me.id}`,
        {
          method: "DELETE",
          headers: svcAuth,
        }
      ),

      fetch(
        `${SUPABASE_URL}/rest/v1/notifications?user_id=eq.${me.id}`,
        {
          method: "DELETE",
          headers: svcAuth,
        }
      ),

      fetch(
        `${SUPABASE_URL}/rest/v1/push_subscriptions?user_id=eq.${me.id}`,
        {
          method: "DELETE",
          headers: svcAuth,
        }
      ),
    ]);

    /*
     * Permanently prevent the deleted account from being used again.
     *
     * We move the authentication email to the anonymized address so the
     * user's original email is released for future registration.
     */
    await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users/${me.id}`,
      {
        method: "PUT",
        headers: svcHeaders,
        body: JSON.stringify({
          ban_duration: "876000h",
          email: anonEmail,
        }),
      }
    );

    res.status(200).json({
      deleted: true,
    });
  } catch (err) {
    console.error("Delete account error:", err);

    res.status(500).json({
      error: err.message || "Server error",
    });
  }
};
