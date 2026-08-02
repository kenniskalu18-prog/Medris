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

module.exports = { readBody, env, settleReference };
