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

// A successful Paystack charge can be either a buyer's order payment
// (reference starts "medris_") or a vendor settling owed commission on
// their offline sales (reference starts "commission_"). Both the webhook
// and the browser-return verify endpoint need this same routing, so it
// lives here once.
async function settleReference(reference) {
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
  } else {
    await fetch(`${SUPABASE_URL}/rest/v1/payments?provider_reference=eq.${encodeURIComponent(reference)}`, {
      method: "PATCH", headers,
      body: JSON.stringify({ status: "paid" }),
    });
  }
}

const MEDRIS_LOGO_URL = "https://medriss.vercel.app/icon-512.png";
const BRAND_TEAL = "#0e8f7f";
const BRAND_TEAL_DARK = "#075c52";

function naira(n) {
  return "₦" + Number(n || 0).toLocaleString("en-NG", { maximumFractionDigits: 2 });
}
function fmtDate(d) {
  return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// One shared, inline-styled layout for every transactional email — a
// teal header with the Medris mark, a white content card, and a footer.
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
              <img src="${MEDRIS_LOGO_URL}" width="44" height="44" alt="Medris" style="display:block;margin:0 auto 8px;border-radius:12px;">
              <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.01em;">Medris</span>
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
              <p style="margin:16px 0 0;font-size:12px;color:#7a9089;">Medris — medical equipment rental &amp; sales marketplace, Lagos.<br>This is an automated message about an order on your account.</p>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  </body></html>`;
}

function orderSummaryHtml(order, items) {
  const rows = (items || []).map((it) => {
    const period = it.rental_start_date && it.rental_end_date
      ? `<div style="color:#5c7269;font-size:12px;margin-top:2px;">${fmtDate(it.rental_start_date)} → ${fmtDate(it.rental_end_date)}</div>` : "";
    return `<tr>
      <td style="padding:8px 0;border-bottom:1px solid #eef4f2;font-size:14px;color:#0d201c;">${it.product?.name || "Item"} × ${it.quantity}${period}</td>
      <td style="padding:8px 0;border-bottom:1px solid #eef4f2;font-size:14px;color:#0d201c;text-align:right;">${naira(it.unit_price * it.quantity)}</td>
    </tr>`;
  }).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:10px 0 4px;background:#f6faf9;border-radius:10px;padding:14px 16px;">
    ${rows}
    <tr><td style="padding-top:10px;font-size:14px;font-weight:700;color:#0d201c;">Total</td><td style="padding-top:10px;font-size:14px;font-weight:700;color:#0d201c;text-align:right;">${naira(order.total_amount)}</td></tr>
    ${order.deposit_amount ? `<tr><td style="font-size:12px;color:#5c7269;">Includes refundable deposit</td><td style="font-size:12px;color:#5c7269;text-align:right;">${naira(order.deposit_amount)}</td></tr>` : ""}
  </table>
  ${order.delivery_method ? `<p style="margin:12px 0 0;font-size:13px;color:#5c7269;"><strong style="color:#0d201c;">${order.delivery_method === "delivery" ? "Delivery to" : "Pickup"}:</strong> ${order.delivery_address ? order.delivery_address : order.delivery_method === "pickup" ? "arranged directly with the vendor" : "—"}</p>` : ""}`;
}

const STATUS_COPY = {
  confirmed: { subject: "Your order has been confirmed", heading: "Your order is confirmed ✅", line: "The vendor has accepted your order and is preparing it." },
  handed_over: { subject: "Your equipment is on its way / ready", heading: "Handed over 📦", line: "The equipment has been handed over. If it's a rental, remember to mark it \"returned\" once you're done." },
  returned: { subject: "Equipment marked as returned", heading: "Marked as returned 🔄", line: "The rented equipment has been marked returned. Your deposit (if any) will be settled once the vendor confirms its condition." },
  completed: { subject: "Your order is complete", heading: "Order complete 🎉", line: "This order is now complete. Thanks for using Medris — don't forget to leave a review!" },
  cancelled: { subject: "Your order was cancelled", heading: "Order cancelled", line: "This order has been cancelled. Any amount paid online will be refunded to your original payment method." },
  disputed: { subject: "A dispute was raised on your order", heading: "Dispute raised ⚠️", line: "An issue was reported on this order. A Medris admin is reviewing it and will follow up." },
};

async function sendResendEmail(resendKey, { to, subject, html }) {
  // onboarding@resend.dev is Resend's shared, pre-verified sender — works
  // immediately with no setup, but reads as a resend.dev address to the
  // recipient. Once you verify your own domain in Resend, set EMAIL_FROM
  // in Vercel (e.g. "Medris <orders@yourdomain.com>") to use it instead.
  const from = process.env.EMAIL_FROM || "Medris <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html }),
  });
  return res.ok;
}

// Fires the right email(s) for an order event. eventType is "placed" or
// "status_changed". Never throws — a failed email should never break the
// buyer/vendor's flow, so callers just get back which sends succeeded.
async function sendOrderEmails({ resendKey, origin, order, items, buyer, vendorBusinessName, vendorEmail, eventType }) {
  if (!resendKey) return { sent: [], skipped: "no RESEND_API_KEY configured" };
  const orderUrl = `${origin}/?order=${order.id}`;
  const sent = [];

  if (eventType === "placed") {
    if (buyer?.email) {
      const ok = await sendResendEmail(resendKey, {
        to: buyer.email,
        subject: "Your Medris order has been placed",
        html: emailShell({
          preheader: `Order placed with ${vendorBusinessName}`,
          heading: `Thanks, ${buyer.name || "there"} — your order is in! 🛒`,
          bodyHtml: `<p style="margin:0 0 6px;font-size:14px;color:#3a4a45;">Your order with <strong>${vendorBusinessName}</strong> has been placed and is waiting for the vendor to confirm.</p>${orderSummaryHtml(order, items)}`,
          ctaLabel: "View your order", ctaUrl: orderUrl,
        }),
      });
      if (ok) sent.push("buyer");
    }
    if (vendorEmail) {
      const ok = await sendResendEmail(resendKey, {
        to: vendorEmail,
        subject: "You've received a new order on Medris",
        html: emailShell({
          preheader: `New order from ${buyer?.name || "a buyer"}`,
          heading: "New order received 🔔",
          bodyHtml: `<p style="margin:0 0 6px;font-size:14px;color:#3a4a45;"><strong>${buyer?.name || "A buyer"}</strong> just placed an order on your storefront. Confirm it from your vendor dashboard.</p>${orderSummaryHtml(order, items)}`,
          ctaLabel: "View order in dashboard", ctaUrl: orderUrl,
        }),
      });
      if (ok) sent.push("vendor");
    }
    return { sent };
  }

  // status_changed
  const copy = STATUS_COPY[order.status];
  if (!copy) return { sent };
  if (buyer?.email) {
    const ok = await sendResendEmail(resendKey, {
      to: buyer.email,
      subject: copy.subject,
      html: emailShell({
        preheader: copy.line,
        heading: copy.heading,
        bodyHtml: `<p style="margin:0 0 6px;font-size:14px;color:#3a4a45;">${copy.line}</p>${orderSummaryHtml(order, items)}`,
        ctaLabel: "View your order", ctaUrl: orderUrl,
      }),
    });
    if (ok) sent.push("buyer");
  }
  if (vendorEmail) {
    const ok = await sendResendEmail(resendKey, {
      to: vendorEmail,
      subject: `Order status updated: ${order.status.replace("_", " ")}`,
      html: emailShell({
        preheader: `Order status changed to ${order.status}`,
        heading: `Order status: ${order.status.replace("_", " ")}`,
        bodyHtml: `<p style="margin:0 0 6px;font-size:14px;color:#3a4a45;">This order's status was just updated.</p>${orderSummaryHtml(order, items)}`,
        ctaLabel: "View order", ctaUrl: orderUrl,
      }),
    });
    if (ok) sent.push("vendor");
  }
  return { sent };
}

// Generic email for any row in the `notifications` table — used by
// api/notify-email.js so every in-app notification (new order, buyer
// request, review, dispute update, etc.) also reaches an inbox, without
// needing a bespoke template per notification type.
async function sendNotificationEmail(resendKey, { to, name, title, body, link }) {
  if (!resendKey || !to) return false;
  return sendResendEmail(resendKey, {
    to,
    subject: title,
    html: emailShell({
      preheader: body || title,
      heading: esc(title),
      bodyHtml: `<p style="margin:0 0 6px;font-size:14px;color:#3a4a45;">Hi ${esc(name || "there")},</p>${body ? `<p style="margin:0 0 6px;font-size:14px;color:#3a4a45;">${esc(body)}</p>` : ""}`,
      ctaLabel: "Open in Medris", ctaUrl: link,
    }),
  });
}
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

module.exports = { readBody, env, settleReference, sendOrderEmails, sendNotificationEmail };
