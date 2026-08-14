// POST { messages: [{role, content}, ...], accessToken } -> { reply }
// Proxies to the Gemini API so the API key never touches the browser —
// same reasoning as the Paystack secret key. Needs GEMINI_API_KEY set in
// Vercel's environment variables (get a free key at aistudio.google.com —
// the free tier has a rate limit but doesn't expire, unlike Anthropic's
// trial credit).
//
// Requires a logged-in user and enforces a per-user daily message cap
// (increment_chat_usage, in Postgres) so this endpoint can't be used by
// an anonymous script to burn through the Gemini quota.
const { readBody, env } = require("./_util");

// "-latest" aliases can route to a newly-released model that's still
// getting hammered by everyone else pointed at the same alias — a pinned,
// GA model is the fallback for exactly that "high demand" case.
const MODEL = "gemini-flash-latest";
const FALLBACK_MODEL = "gemini-2.0-flash";
const DAILY_MESSAGE_LIMIT = 40;
const SYSTEM_PROMPT =
  "You are Levi, the Levromart Assistant — a friendly helper embedded in a multi-sector marketplace for Lagos, Nigeria, covering healthcare equipment, food & groceries, electronics, home & living, fashion & beauty, and services. Help buyers figure out what they need, explain how renting/buying/requesting works on Levromart, and point them to the right action (Browse, a sector, Request an item). Keep answers short (2-4 sentences) and practical, in plain conversational English. You cannot see the user's account, orders, or private data — if asked about a specific order, tell them to check 'My Orders'. You are not a medical professional — for clinical/diagnostic questions about healthcare equipment, tell them to consult a licensed healthcare provider.\n\nYou are given a snapshot of REAL, LIVE vendors and products below, under \"LIVE MARKETPLACE DATA\" — use it to answer questions like \"which vendor sells X\" or \"who do you recommend\" with actual names, ratings, and prices. Never invent a vendor or product that isn't in that snapshot. If nothing in the snapshot matches what someone's asking for, say so plainly and suggest they check Browse or post a Request instead of guessing.\n\nIf a \"YOUR STORE DATA\" block is present below, the person chatting is a vendor asking about their own shop — act as a business advisor: answer questions about their sales, visibility, and how to improve using only the real numbers given there. Never guess at figures you weren't given, and never claim to know another vendor's private numbers (orders, revenue) — only their public rating/review count from the marketplace snapshot above is fair game for comparisons.";

// Pulls a small, relevant slice of real marketplace data to ground the
// model's answers in — without this it can only speak in generalities
// (and, worse, would be tempted to make up vendor names). Keyword-matched
// against the buyer's latest message first (so "who sells rice" surfaces
// actual rice vendors), with a top-rated-vendors fallback list always
// included too, so "who do you recommend" has something to work with even
// when no keyword matches.
async function buildMarketplaceContext(SUPABASE_URL, svcHeaders, latestMessage) {
  const words = String(latestMessage || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .slice(0, 6);

  const [topVendorsRes, productsRes] = await Promise.all([
    fetch(
      `${SUPABASE_URL}/rest/v1/vendors?verification_status=eq.verified&is_active=eq.true&select=business_name,city,avg_rating,review_count,sector:sectors(name)&order=avg_rating.desc&limit=15`,
      { headers: svcHeaders }
    ),
    words.length
      ? fetch(
          `${SUPABASE_URL}/rest/v1/products?status=eq.active&or=(${words.map((w) => `name.ilike.*${encodeURIComponent(w)}*`).join(",")})&select=name,sale_price,rental_rate,rental_rate_unit,is_service,service_price_unit,vendor:vendors!inner(business_name,avg_rating,city,verification_status,is_active)&vendor.verification_status=eq.verified&vendor.is_active=eq.true&limit=15`,
          { headers: svcHeaders }
        )
      : Promise.resolve(null),
  ]);

  const topVendors = topVendorsRes.ok ? await topVendorsRes.json() : [];
  const products = productsRes && productsRes.ok ? await productsRes.json() : [];

  const vendorLines = (topVendors || []).map(
    (v) => `- ${v.business_name} (${v.sector?.name || "general"}, ${v.city || "Lagos"}) — ★${Number(v.avg_rating || 0).toFixed(1)} (${v.review_count || 0} reviews)`
  );
  const productLines = (products || []).map((p) => {
    const price = p.is_service
      ? `₦${p.sale_price}${p.service_price_unit && p.service_price_unit !== "flat" ? "/" + p.service_price_unit : ""} (service)`
      : p.sale_price != null
        ? `₦${p.sale_price} to buy`
        : p.rental_rate != null
          ? `₦${p.rental_rate}/${p.rental_rate_unit} to rent`
          : "price on request";
    return `- ${p.name} — ${price} — sold by ${p.vendor?.business_name || "a vendor"} (★${Number(p.vendor?.avg_rating || 0).toFixed(1)})`;
  });

  return `LIVE MARKETPLACE DATA (as of right now):\nTop-rated verified vendors:\n${vendorLines.join("\n") || "(none yet)"}\n\nProducts/services matching this question:\n${productLines.join("\n") || "(no direct keyword matches — only use the vendor list above, and say so if nothing fits)"}`;
}

// Only runs (and only reveals anything) when the person chatting is
// themselves a vendor — pulled with the service-role key because orders,
// view counts and commission status aren't public data, unlike the
// vendors/products snapshot above. Returns "" for buyers so the prompt
// stays buyer-only and Levi never claims to have business data it wasn't
// actually given.
async function buildVendorContext(SUPABASE_URL, svcServiceHeaders, userId) {
  const vRes = await fetch(
    `${SUPABASE_URL}/rest/v1/vendors?user_id=eq.${userId}&deleted_at=is.null&select=id,business_name,avg_rating,review_count,is_active,verification_status,commission_pct`,
    { headers: svcServiceHeaders }
  );
  if (!vRes.ok) return "";
  const [v] = await vRes.json();
  if (!v) return "";

  const [ordersRes, productsRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/orders?vendor_id=eq.${v.id}&select=status,total_amount`, { headers: svcServiceHeaders }),
    fetch(`${SUPABASE_URL}/rest/v1/products?vendor_id=eq.${v.id}&select=id,view_count,status`, { headers: svcServiceHeaders }),
  ]);
  const orders = ordersRes.ok ? await ordersRes.json() : [];
  const products = productsRes.ok ? await productsRes.json() : [];

  const completed = (orders || []).filter((o) => o.status === "completed");
  const pending = (orders || []).filter((o) => ["pending", "confirmed"].includes(o.status)).length;
  const revenue = completed.reduce((s, o) => s + Number(o.total_amount || 0), 0);
  const activeListings = (products || []).filter((p) => p.status === "active").length;
  const totalViews = (products || []).reduce((s, p) => s + (p.view_count || 0), 0);

  const productIds = (products || []).map((p) => p.id);
  let totalFavorites = 0;
  if (productIds.length) {
    const favRes = await fetch(
      `${SUPABASE_URL}/rest/v1/favorites?product_id=in.(${productIds.join(",")})&select=product_id`,
      { headers: svcServiceHeaders }
    );
    totalFavorites = favRes.ok ? (await favRes.json()).length : 0;
  }

  return `\n\nYOUR STORE DATA (private — this is ${v.business_name}'s own numbers, not visible to anyone else):\n- Verification: ${v.verification_status}, storefront currently ${v.is_active ? "active" : "paused"}\n- Rating: ${Number(v.avg_rating || 0).toFixed(1)} out of 5, from ${v.review_count || 0} review(s)\n- Listings: ${activeListings} active out of ${products.length} total\n- Orders: ${orders.length} total — ${pending} pending/awaiting action, ${completed.length} completed\n- Revenue from completed orders: ₦${revenue.toLocaleString("en-NG")}\n- Product page views (all-time): ${totalViews}\n- Wishlist saves across your listings: ${totalFavorites}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  try {
    const { messages, accessToken } = JSON.parse(await readBody(req));
    if (!Array.isArray(messages) || messages.length === 0) { res.status(400).json({ error: "messages array required" }); return; }
    if (!accessToken) { res.status(401).json({ error: "Please log in to use the assistant." }); return; }

    const SUPABASE_URL = env("SUPABASE_URL");
    const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY");

    const meRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
    });
    const me = await meRes.json();
    if (!meRes.ok || !me?.id) { res.status(401).json({ error: "Your session expired — please log in again." }); return; }

    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_chat_usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ p_user_id: me.id, p_limit: DAILY_MESSAGE_LIMIT }),
    });
    const withinLimit = await rpcRes.json();
    if (!rpcRes.ok) { res.status(500).json({ error: "Could not check chat usage." }); return; }
    if (withinLimit !== true) { res.status(429).json({ error: `You've hit today's chat limit (${DAILY_MESSAGE_LIMIT} messages). Try again tomorrow.` }); return; }

    const GEMINI_API_KEY = env("GEMINI_API_KEY");
    const contents = messages.slice(-20).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content || "").slice(0, 4000) }],
    }));

    const svcAuth = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` };
    const latestMessage = [...messages].reverse().find((m) => m.role !== "assistant")?.content || "";
    let marketplaceContext = "";
    try {
      marketplaceContext = await buildMarketplaceContext(SUPABASE_URL, svcAuth, latestMessage);
    } catch (e) {
      marketplaceContext = "LIVE MARKETPLACE DATA: (unavailable right now — don't name specific vendors or products, point the buyer to Browse instead.)";
    }

    let vendorContext = "";
    try {
      const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
      const svcService = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
      vendorContext = await buildVendorContext(SUPABASE_URL, svcService, me.id);
    } catch (e) {
      vendorContext = "";
    }

    const callGemini = (model) => fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: `${SYSTEM_PROMPT}\n\n${marketplaceContext}${vendorContext}` }] },
          contents,
          generationConfig: { maxOutputTokens: 400 },
        }),
      }
    );

    let apiRes = await callGemini(MODEL);
    let apiJson = await apiRes.json();
    // "-latest" can point at a freshly-released model still under heavy
    // load from everyone else on that same alias — one retry against a
    // pinned, stable model covers that instead of surfacing the error.
    if (!apiRes.ok && MODEL !== FALLBACK_MODEL) {
      apiRes = await callGemini(FALLBACK_MODEL);
      apiJson = await apiRes.json();
    }
    if (!apiRes.ok) { res.status(400).json({ error: apiJson.error?.message || "AI service error" }); return; }

    const reply = apiJson.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, I couldn't come up with a reply just now.";
    res.status(200).json({ reply });
  } catch (err) {
    res.status(500).json({ error: err.message || "Server error" });
  }
};
