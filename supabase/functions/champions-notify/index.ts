// MTCP Telehealth Champions — application confirmation + internal notification email.
// Deployed as a Supabase Edge Function so the Resend API key never touches
// client-side code or the Vercel deployment. Configure the secret with:
//   supabase secrets set RESEND_API_KEY=re_xxx --project-ref <ref>
// Optionally also set CHAMPIONS_EMAIL_FROM, e.g. "Mobihealth <noreply@yourdomain.com>".
//
// Internal recipients are hardcoded below -- edit INTERNAL_RECIPIENTS
// directly in this file and redeploy to change them. Currently just the
// test address; add "HR@mobihealthinternational.com" back once testing is done.
const INTERNAL_RECIPIENTS = ["kenniskalu18@gmail.com"];

// Deno.serve is the Supabase Edge Runtime's built-in HTTP entrypoint.
Deno.serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const { email, name, applicationNumber, institution, level, phone, primaryTrack, wantsLeadership } = body;
    if (!email || !applicationNumber) {
      return new Response(JSON.stringify({ ok: false, error: "email and applicationNumber are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (!resendKey) {
      // Not configured yet — fail soft. The application is already saved in the
      // database at this point; email is a nice-to-have, not a hard requirement.
      return new Response(JSON.stringify({ ok: false, error: "RESEND_API_KEY not configured" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const from = Deno.env.get("CHAMPIONS_EMAIL_FROM") || "Mobihealth <onboarding@resend.dev>";
    const submittedOn = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const applicantHtml = `<!doctype html><html><body style="margin:0;padding:0;background:#f6f8fc;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fc;padding:24px 12px;">
        <tr><td align="center">
          <table role="presentation" width="100%" style="max-width:480px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(10,26,69,0.08);">
            <tr><td style="background:linear-gradient(135deg,#0a1a45,#1a56db);padding:26px 26px 20px;text-align:center;">
              <span style="color:#ffffff;font-size:20px;font-weight:800;">MTCP Telehealth Champions</span>
            </td></tr>
            <tr><td style="padding:30px 26px 10px;">
              <h1 style="margin:0 0 14px;font-size:19px;color:#14213d;">Application Received!</h1>
              <p style="margin:0 0 10px;font-size:14px;color:#5a6b8c;">Hi ${esc(name || "there")},</p>
              <p style="margin:0 0 10px;font-size:14px;color:#5a6b8c;">Thank you for applying to become an <strong>MTCP Telehealth Champion</strong>. Your application has been successfully received.</p>
              <table role="presentation" style="width:100%;background:#f6f8fc;border-radius:10px;margin:20px 0;"><tr><td style="padding:14px 16px;">
                <div style="font-size:12px;color:#5a6b8c;margin-bottom:4px;">Reference Number</div>
                <div style="font-size:18px;font-weight:800;color:#1a56db;">${esc(applicationNumber)}</div>
              </td></tr></table>
              <p style="margin:0 0 6px;font-size:13px;color:#5a6b8c;">Submitted on ${submittedOn}.</p>
              <p style="margin:0 0 6px;font-size:13px;color:#5a6b8c;">Please note that submitting this application does not guarantee selection. Our team will be in touch regarding next steps.</p>
            </td></tr>
            <tr><td style="padding:10px 26px 28px;"><p style="margin:0;font-size:12px;color:#9aa7c2;">Mobihealth &middot; MTCP Telehealth Champions Programme</p></td></tr>
          </table>
        </td></tr>
      </table>
    </body></html>`;

    const internalRow = (k: string, v: unknown) =>
      `<tr><td style="padding:5px 10px;color:#5a6b8c;font-size:13px;">${esc(k)}</td><td style="padding:5px 10px;font-size:13px;font-weight:600;color:#14213d;">${esc(v || "—")}</td></tr>`;

    const internalHtml = `<!doctype html><html><body style="margin:0;padding:0;background:#f6f8fc;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fc;padding:24px 12px;">
        <tr><td align="center">
          <table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(10,26,69,0.08);">
            <tr><td style="background:linear-gradient(135deg,#0a1a45,#1a56db);padding:22px 26px;text-align:center;">
              <span style="color:#ffffff;font-size:18px;font-weight:800;">New MTCP Champion Application</span>
            </td></tr>
            <tr><td style="padding:22px 26px;">
              <table role="presentation" style="width:100%;border-collapse:collapse;">
                ${internalRow("Reference", applicationNumber)}
                ${internalRow("Name", name)}
                ${internalRow("Email", email)}
                ${internalRow("Phone", phone)}
                ${internalRow("Institution", institution)}
                ${internalRow("Level", level)}
                ${internalRow("Primary Track", primaryTrack)}
                ${internalRow("Leadership Interest", wantsLeadership ? "Yes" : "No")}
                ${internalRow("Submitted", submittedOn)}
              </table>
              <p style="margin:16px 0 0;font-size:12px;color:#9aa7c2;">Full details are in the admin dashboard.</p>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </body></html>`;

    const [applicantRes, internalRes] = await Promise.all([
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to: email,
          subject: "Your MTCP Telehealth Champion application has been received",
          html: applicantHtml,
        }),
      }),
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to: INTERNAL_RECIPIENTS,
          subject: `New MTCP Champion Application — ${name || email}`,
          html: internalHtml,
        }),
      }),
    ]);

    return new Response(JSON.stringify({ ok: applicantRes.ok, internalOk: internalRes.ok }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
