// Runs daily via Vercel Cron (see vercel.json). Merged from the old
// separate auto-release-payouts.js / charge-monthly-vendors.js — Vercel's
// Hobby plan caps deployments at 12 serverless functions, and both jobs
// are cheap, independent, daily sweeps, so they now run one after another
// in a single cron hit rather than two.
// Vercel signs cron requests with `Authorization: Bearer $CRON_SECRET`
// automatically when a CRON_SECRET env var is set on the project.
const { env, releaseOrderPayout } = require("./_util");

module.exports = async function handler(req, res) {
  try {
    const expected = process.env.CRON_SECRET;
    if (expected && req.headers.authorization !== `Bearer ${expected}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const [autoRelease, monthlyBilling] = await Promise.all([
      runAutoReleasePayouts(),
      runChargeMonthlyVendors(),
    ]);

    res.status(200).json({ autoRelease, monthlyBilling });
  } catch (err) {
    res.status(500).json({ error: err.message || "Server error" });
  }
};

// Finds every order whose escrow hold has passed its 5-day auto-release
// window with no dispute raised, and releases each one — this is what
// stops a vendor with a genuinely happy buyer from waiting forever just
// because the buyer never got around to tapping "I've received this".
async function runAutoReleasePayouts() {
  const SUPABASE_URL = env("SUPABASE_URL");
  const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
  const svcAuth = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

  // Two different reasons an order can be "held" and need this cron:
  // (1) genuine auto-release — the buyer never tapped "I've received this",
  //     so once the 5-day window passes we release it for them.
  // (2) a stuck retry — the buyer DID confirm (status is already
  //     "completed") but the Paystack transfer itself failed at that
  //     moment (e.g. an OTP requirement on the account), so payout_status
  //     never left "held". That doesn't need to wait on auto_release_at at
  //     all — it should be retried on every run until it goes through.
  const [autoReleaseDueRes, stuckRetryRes] = await Promise.all([
    fetch(
      `${SUPABASE_URL}/rest/v1/orders?payout_status=eq.held&auto_release_at=lte.${new Date().toISOString()}&status=not.in.(disputed,cancelled,completed)&select=id`,
      { headers: svcAuth }
    ),
    fetch(
      `${SUPABASE_URL}/rest/v1/orders?payout_status=eq.held&status=eq.completed&select=id`,
      { headers: svcAuth }
    ),
  ]);
  const autoReleaseDue = await autoReleaseDueRes.json();
  const stuckRetry = await stuckRetryRes.json();
  const seen = new Set();
  const due = [...(autoReleaseDue || []), ...(stuckRetry || [])].filter((o) => (seen.has(o.id) ? false : (seen.add(o.id), true)));

  const results = [];
  for (const o of due || []) {
    try {
      const r = await releaseOrderPayout(o.id);
      results.push({ orderId: o.id, ...r });
    } catch (err) {
      results.push({ orderId: o.id, transferred: false, error: err.message });
    }
  }
  return { checked: (due || []).length, results };
}

// Charges every vendor on monthly billing for their current listing count
// (₦1,500/listing), using the card saved during setup-monthly-billing. A
// failed charge auto-pauses the vendor's storefront — same visible effect
// as an admin pausing them manually — until they update their card and it
// goes through, at which point they'd need to redo billing setup to
// re-activate. A vendor with zero active listings owes nothing that month
// and is just skipped, no charge attempted. This only actually does
// anything on the days a given vendor's next_monthly_charge_at is due, so
// running it daily (rather than the old separate monthly-only schedule)
// is harmless — everyone else in the query is simply not due yet.
async function runChargeMonthlyVendors() {
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
  return { checked: (due || []).length, results };
}

// Inserting straight into `notifications` (rather than calling
// create_notification) is fine here — there's no "actor" for a system
// billing event. The existing notify trigger on that table picks this up
// and sends the email + push automatically, same as every other
// notification in the app, so there's no separate email call needed here.
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
