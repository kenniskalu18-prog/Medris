// Runs monthly via Vercel Cron (see vercel.json). Charges every vendor on
// monthly billing for their current listing count (₦1,500/listing), using
// the card saved during setup-monthly-billing.js. A failed charge
// auto-pauses the vendor's storefront — same visible effect as an admin
// pausing them manually — until they update their card and it goes
// through, at which point they'd need to redo setup-monthly-billing to
// re-activate. A vendor with zero active listings owes nothing that month
// and is just skipped, no charge attempted.
const { env } = require("./_util");

module.exports = async function handler(req, res) {
  try {
    const expected = process.env.CRON_SECRET;
    if (expected && req.headers.authorization !== `Bearer ${expected}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const SUPABASE_URL = env("SUPABASE_URL");
    const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
    const PAYSTACK_SECRET_KEY = env("PAYSTACK_SECRET_KEY");
    const svcAuth = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
    const svcHeaders = { ...svcAuth, "Content-Type": "application/json", Prefer: "return=minimal" };

    const dueRes = await fetch(
      `${SUPABASE_URL}/rest/v1/vendors?billing_model=eq.monthly&monthly_billing_status=eq.active&next_monthly_charge_at=lte.${new Date().toISOString()}&select=id,user_id,business_name,paystack_authorization_code,paystack_customer_code`,
      { headers: svcAuth }
    );
    const due = await dueRes.json();

    const results = [];
    for (const v of due || []) {
      try {
        const amtRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/compute_monthly_billing_amount`, {
          method: "POST", headers: svcHeaders, body: JSON.stringify({ p_vendor_id: v.id }),
        });
        const [{ listing_count, amount }] = await amtRes.json();
        const nextMonth = new Date();
        nextMonth.setMonth(nextMonth.getMonth() + 1);

        if (Number(listing_count) === 0) {
          await fetch(`${SUPABASE_URL}/rest/v1/vendors?id=eq.${v.id}`, {
            method: "PATCH", headers: svcHeaders,
            body: JSON.stringify({ next_monthly_charge_at: nextMonth.toISOString() }),
          });
          results.push({ vendorId: v.id, charged: false, reason: "no active listings" });
          continue;
        }

        if (!v.paystack_authorization_code) {
          await markPastDue(SUPABASE_URL, svcHeaders, v, "no saved card on file");
          results.push({ vendorId: v.id, charged: false, reason: "no saved card" });
          continue;
        }

        const uRes = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${v.user_id}&select=email,name`, { headers: svcAuth });
        const [u] = await uRes.json();

        const chargeRes = await fetch("https://api.paystack.co/transaction/charge_authorization", {
          method: "POST",
          headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            authorization_code: v.paystack_authorization_code,
            email: u?.email,
            amount: Math.round(Number(amount) * 100),
          }),
        });
        const chargeJson = await chargeRes.json();
        const success = chargeRes.ok && chargeJson.status && chargeJson.data?.status === "success";

        await fetch(`${SUPABASE_URL}/rest/v1/vendor_monthly_charges`, {
          method: "POST", headers: svcHeaders,
          body: JSON.stringify({
            vendor_id: v.id, listing_count, amount,
            status: success ? "paid" : "failed",
            provider_reference: chargeJson.data?.reference || null,
            failure_reason: success ? null : (chargeJson.data?.gateway_response || chargeJson.message || "charge failed"),
          }),
        });

        if (success) {
          await fetch(`${SUPABASE_URL}/rest/v1/vendors?id=eq.${v.id}`, {
            method: "PATCH", headers: svcHeaders,
            body: JSON.stringify({ next_monthly_charge_at: nextMonth.toISOString() }),
          });
          results.push({ vendorId: v.id, charged: true, amount });
        } else {
          await markPastDue(SUPABASE_URL, svcHeaders, v, chargeJson.data?.gateway_response || chargeJson.message || "charge failed");
          results.push({ vendorId: v.id, charged: false, reason: "charge declined" });
        }
      } catch (err) {
        results.push({ vendorId: v.id, charged: false, reason: err.message });
      }
    }

    res.status(200).json({ checked: (due || []).length, results });
  } catch (err) {
    res.status(500).json({ error: err.message || "Server error" });
  }
};

// Inserting straight into `notifications` (rather than calling
// create_notification) is fine here — there's no "actor" for a system
// billing event. The existing notify_email_on_notification /
// notify_push_on_notification triggers on that table pick this up and
// send the email + push automatically, same as every other notification
// in the app, so there's no separate email call needed here.
async function markPastDue(SUPABASE_URL, svcHeaders, vendor, reason) {
  await fetch(`${SUPABASE_URL}/rest/v1/vendors?id=eq.${vendor.id}`, {
    method: "PATCH", headers: svcHeaders,
    body: JSON.stringify({ monthly_billing_status: "past_due", is_active: false }),
  });
  await fetch(`${SUPABASE_URL}/rest/v1/notifications`, {
    method: "POST", headers: svcHeaders,
    body: JSON.stringify({
      user_id: vendor.user_id,
      type: "billing_past_due",
      title: "Monthly billing failed — storefront paused",
      body: `We couldn't charge your card for this month's listing fee (${reason}). Your storefront is paused until this is sorted out.`,
      target_view: "vendorEditProfile",
      target_params: {},
    }),
  });
}
