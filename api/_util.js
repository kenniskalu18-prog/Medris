function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data || "{}"));
    req.on("error", reject);
  });
}

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not configured on this deployment.`);
  return v;
}

// A successful Paystack charge can be a buyer's order payment (reference
// starts "medris_"), a vendor settling owed commission on their offline
// sales ("commission_"), or a vendor setting up monthly billing
// ("billing_"). Both the webhook and the browser-return verify endpoint
// need this same routing, so it lives here once. `txData` is the Paystack
// transaction object (event.data on the webhook, verifyJson.data on the
// browser-return path) -- only the billing_ path actually needs it, to
// pull the card's authorization_code for future recurring charges.
async function settleReference(reference, txData) {
  const SUPABASE_URL = env("SUPABASE_URL");
  const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
  const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" };

  if (reference.startsWith("commission_")) {
    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/commission_settlements?provider_reference=eq.${encodeURIComponent(reference)}&select=id,vendor_id,status`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    const [settlement] = await getRes.json();
    if (!settlement || settlement.status === "paid") return;

    await fetch(`${SUPABASE_URL}/rest/v1/commission_settlements?id=eq.${settlement.id}`, {
      method: "PATCH", headers,
      body: JSON.stringify({ status: "paid", paid_at: new Date().toISOString() }),
    });
    await fetch(`${SUPABASE_URL}/rest/v1/commission_charges?vendor_id=eq.${settlement.vendor_id}&status=eq.owed`, {
      method: "PATCH", headers,
      body: JSON.stringify({ status: "paid", paid_at: new Date().toISOString() }),
    });
  } else if (reference.startsWith("billing_")) {
    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/vendor_monthly_charges?provider_reference=eq.${encodeURIComponent(reference)}&select=id,vendor_id,status`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    const [charge] = await getRes.json();
    if (!charge || charge.status === "paid") return;

    const authCode = txData?.authorization?.authorization_code;
    const customerCode = txData?.customer?.customer_code;
    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1);

    await fetch(`${SUPABASE_URL}/rest/v1/vendors?id=eq.${charge.vendor_id}`, {
      method: "PATCH", headers,
      body: JSON.stringify({
        paystack_authorization_code: authCode,
        paystack_customer_code: customerCode,
        monthly_billing_status: "active",
        next_monthly_charge_at: nextMonth.toISOString(),
      }),
    });
    await fetch(`${SUPABASE_URL}/rest/v1/vendor_monthly_charges?id=eq.${charge.id}`, {
      method: "PATCH", headers,
      body: JSON.stringify({ status: "paid" }),
    });
  } else {
    await fetch(`${SUPABASE_URL}/rest/v1/payments?provider_reference=eq.${encodeURIComponent(reference)}`, {
      method: "PATCH", headers,
      body: JSON.stringify({ status: "paid", paid_at: new Date().toISOString() }),
    });
  }
}

// ---------- ESCROW PAYOUTS ----------
// Paystack "transfer recipient" for a vendor's bank account -- separate
// concept from the old subaccount split, created lazily on first payout
// and cached on the vendor row so it's only ever created once.
async function getOrCreateTransferRecipient(vendor) {
  if (vendor.transfer_recipient_code) return vendor.transfer_recipient_code;

  const SUPABASE_URL = env("SUPABASE_URL");
  const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
  const PAYSTACK_SECRET_KEY = env("PAYSTACK_SECRET_KEY");

  const res = await fetch("https://api.paystack.co/transferrecipient", {
    method: "POST",
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "nuban",
      name: vendor.account_name,
      account_number: vendor.account_number,
      bank_code: vendor.bank_code,
      currency: "NGN",
    }),
  });
  const json = await res.json();
  if (!res.ok || !json.status) throw new Error(json.message || "Could not register the vendor's bank account for payout.");
  const recipientCode = json.data.recipient_code;

  await fetch(`${SUPABASE_URL}/rest/v1/vendors?id=eq.${vendor.id}`, {
    method: "PATCH",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ transfer_recipient_code: recipientCode }),
  });
  return recipientCode;
}

// Actually moves held escrow money to the vendor's bank account and marks
// the order released. Called both when a buyer confirms receipt
// (release-payout.js) and by the daily auto-release cron
// (auto-release-payouts.js) -- identical money-moving logic, only who/what
// triggered it differs. Commission is simply left out of the transfer
// amount (kept in the platform's Paystack balance) -- the deposit, if any,
// passes through to the vendor in full, uncommissioned.
async function releaseOrderPayout(orderId) {
  const SUPABASE_URL = env("SUPABASE_URL");
  const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
  const PAYSTACK_SECRET_KEY = env("PAYSTACK_SECRET_KEY");
  const svcAuth = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
  const svcHeaders = { ...svcAuth, "Content-Type": "application/json", Prefer: "return=minimal" };

  const orderRes = await fetch(
    `${SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}&select=id,payout_status,vendor:vendors(id,commission_pct,bank_code,account_number,account_name,transfer_recipient_code)`,
    { headers: svcAuth }
  );
  const [order] = await orderRes.json();
  if (!order) throw new Error("order not found");
  if (order.payout_status !== "held") return { transferred: false, reason: `payout_status is ${order.payout_status}, nothing to release` };

  const paymentsRes = await fetch(`${SUPABASE_URL}/rest/v1/payments?order_id=eq.${orderId}&status=eq.paid&select=payment_type,amount`, { headers: svcAuth });
  const payments = await paymentsRes.json();
  const feeAmount = (payments || []).filter((p) => p.payment_type === "sale_price" || p.payment_type === "rental_fee").reduce((s, p) => s + Number(p.amount), 0);
  const depositAmount = (payments || []).filter((p) => p.payment_type === "deposit").reduce((s, p) => s + Number(p.amount), 0);
  if (feeAmount <= 0) return { transferred: false, reason: "no paid fee found for this order" };

  if (!order.vendor?.bank_code || !order.vendor?.account_number) {
    throw new Error("Vendor has no payout bank account on file yet.");
  }
  const commissionPct = Number(order.vendor.commission_pct ?? 3);
  const payoutAmount = feeAmount * (1 - commissionPct / 100) + depositAmount;
  const recipientCode = await getOrCreateTransferRecipient(order.vendor);

  const transferRes = await fetch("https://api.paystack.co/transfer", {
    method: "POST",
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "balance",
      amount: Math.round(payoutAmount * 100),
      recipient: recipientCode,
      reason: "Levromart order payout",
      reference: `payout_${orderId}_${Date.now()}`,
    }),
  });
  const transferJson = await transferRes.json();
  if (!transferRes.ok || !transferJson.status) {
    // Newer Paystack business accounts sometimes require a one-time OTP
    // approval on transfers as a fraud check -- if that's what's happening,
    // Paystack's message will say so, and it needs disabling from their
    // dashboard/support before payouts can be fully automatic.
    throw new Error(transferJson.message || "Paystack transfer failed");
  }

  await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}`, {
    method: "PATCH", headers: svcHeaders,
    body: JSON.stringify({
      payout_status: "released",
      payout_released_at: new Date().toISOString(),
      payout_transfer_code: transferJson.data?.transfer_code || transferJson.data?.reference || null,
      status: "completed",
    }),
  });

  return { transferred: true, amount: payoutAmount };
}

// Admin-only path for a dispute where the vendor genuinely never delivered
// -- refunds the buyer's original charge in full via Paystack. For a
// "held" order (escrow, vendor has no subaccount) the vendor was never
// paid, so this comes straight out of money still sitting on the
// platform's balance -- clean. For a "released" order (split payment,
// vendor's cut already settled automatically) Paystack still lets the
// refund go through, but it comes out of the platform's OWN balance since
// a split can't be pulled back from the vendor's side -- the caller is
// expected to have warned about that (see adminRefundOrder in the client).
async function refundOrderPayout(orderId) {
  const SUPABASE_URL = env("SUPABASE_URL");
  const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
  const PAYSTACK_SECRET_KEY = env("PAYSTACK_SECRET_KEY");
  const svcAuth = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
  const svcHeaders = { ...svcAuth, "Content-Type": "application/json", Prefer: "return=minimal" };

  const orderRes = await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}&select=id,payout_status`, { headers: svcAuth });
  const [order] = await orderRes.json();
  if (!order) throw new Error("order not found");
  // payout_status is only set once the order reaches "handed_over" (held or
  // released, per transition_order_status); for an order cancelled before
  // that, it's still null here -- that's fine, there's just nothing to claw
  // back from the vendor's side yet. Only block re-refunding an order that's
  // already been refunded.
  if (order.payout_status === "refunded") throw new Error(`Can't refund, this order was already refunded.`);

  const paymentsRes = await fetch(`${SUPABASE_URL}/rest/v1/payments?order_id=eq.${orderId}&status=eq.paid&select=provider_reference&limit=1`, { headers: svcAuth });
  const [payment] = await paymentsRes.json();
  if (!payment) throw new Error("No paid payment found for this order.");

  const refundRes = await fetch("https://api.paystack.co/refund", {
    method: "POST",
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: payment.provider_reference }),
  });
  const refundJson = await refundRes.json();
  if (!refundRes.ok || !refundJson.status) {
    throw new Error(refundJson.message || "Paystack refund failed");
  }

  await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}`, {
    method: "PATCH", headers: svcHeaders,
    body: JSON.stringify({ payout_status: "refunded", status: "cancelled" }),
  });

  return { refunded: true };
}

const MEDRIS_LOGO_URL = "https://levromart.vercel.app/icon-512.png";
const BRAND_TEAL = "#0e8f7f";
const BRAND_TEAL_DARK = "#075c52";

// One shared, inline-styled layout for every transactional email — a
// teal header with the Levromart mark, a white content card, and a footer.
// Inline styles only: most email clients strip <style> blocks.
function emailShell({ preheader, heading, bodyHtml, ctaLabel, ctaUrl }) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
  <body style="margin:0;padding:0;background:#f3f8f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <span style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader || ""}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f8f7;padding:24px 12px;">
      <tr><td align="center">
        <table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(7,92,82,0.08);">
          <tr>
            <td style="background:linear-gradient(135deg,${BRAND_TEAL} 0%,${BRAND_TEAL_DARK} 100%);padding:28px 28px 22px;text-align:center;">
              <img src="${MEDRIS_LOGO_URL}" width="44" height="44" alt="Levromart" style="display:block;margin:0 auto 8px;border-radius:12px;">
              <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.01em;">Levromart</span>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 28px 8px;">
              <h1 style="margin:0 0 16px;font-size:20px;color:#0d201c;">${heading}</h1>
              ${bodyHtml}
              ${ctaUrl ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 6px;"><tr><td style="border-radius:10px;background:${BRAND_TEAL};"><a href="${ctaUrl}" style="display:inline-block;padding:12px 22px;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;border-radius:10px;">${ctaLabel}</a></td></tr></table>` : ""}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px 28px;border-top:1px solid #e7f1ee;margin-top:20px;">
              <p style="margin:16px 0 0;font-size:12px;color:#7a9089;">Levromart — a marketplace for Lagos, covering healthcare equipment, food, electronics, and more.<br>This is an automated message about an order on your account.</p>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  </body></html>`;
}

async function sendResendEmail(resendKey, { to, subject, html }) {
  // onboarding@resend.dev is Resend's shared, pre-verified sender — works
  // immediately with no setup, but reads as a resend.dev address to the
  // recipient. Once you verify your own domain in Resend, set EMAIL_FROM
  // in Vercel (e.g. "Levromart <orders@yourdomain.com>") to use it instead.
  const from = process.env.EMAIL_FROM || "Levromart <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (res.ok) return { ok: true };
  let errBody;
  try { errBody = await res.json(); } catch (e) { errBody = await res.text().catch(() => ""); }
  return { ok: false, status: res.status, error: (errBody && errBody.message) || JSON.stringify(errBody) };
}

// Generic email for any row in the `notifications` table — used by
// api/notify-email.js so every in-app notification (new order, buyer
// request, review, dispute update, etc.) also reaches an inbox, without
// needing a bespoke template per notification type. Returns the full
// {ok, status, error} result (not just a boolean) so the caller can log
// *why* a send failed instead of just that it failed.
async function sendNotificationEmail(resendKey, { to, name, title, body, link }) {
  if (!resendKey) return { ok: false, error: "RESEND_API_KEY not configured" };
  if (!to) return { ok: false, error: "no recipient email" };
  return sendResendEmail(resendKey, {
    to,
    subject: title,
    html: emailShell({
      preheader: body || title,
      heading: esc(title),
      bodyHtml: `<p style="margin:0 0 6px;font-size:14px;color:#3a4a45;">Hi ${esc(name || "there")},</p>${body ? `<p style="margin:0 0 6px;font-size:14px;color:#3a4a45;">${esc(body)}</p>` : ""}`,
      ctaLabel: "Open in Levromart", ctaUrl: link,
    }),
  });
}
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

module.exports = { readBody, env, settleReference, sendNotificationEmail, releaseOrderPayout, refundOrderPayout };
