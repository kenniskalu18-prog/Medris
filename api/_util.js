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

module.exports = { readBody, env, settleReference, sendNotificationEmail };
