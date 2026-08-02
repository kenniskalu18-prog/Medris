// Paystack calls this directly (server-to-server) whenever a transaction
// event happens. This is the authoritative confirmation path — it does not
// depend on the buyer's browser being open, unlike verify-payment.js.
// Configure this URL in the Paystack dashboard: Settings -> API Keys & Webhooks.
const crypto = require("crypto");
const { env, settleReference } = require("./_util");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).end(); return; }
  try {
    const rawBody = await readRawBody(req);
    const signature = req.headers["x-paystack-signature"];
    const expected = crypto.createHmac("sha512", env("PAYSTACK_SECRET_KEY")).update(rawBody).digest("hex");
    if (!signature || signature !== expected) { res.status(401).json({ error: "Invalid signature" }); return; }

    const event = JSON.parse(rawBody);
    if (event.event === "charge.success") {
      await settleReference(event.data.reference);
    }
    res.status(200).json({ received: true });
  } catch (err) {
    res.status(500).json({ error: err.message || "Server error" });
  }
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
