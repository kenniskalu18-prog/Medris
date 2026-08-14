// Three actions, one file — kept together because Vercel's Hobby plan caps
// deployments at 12 serverless functions (see the other api/ files for the
// same pattern, e.g. vendor-payments.js).
//
// action: (default/omitted) { messages, accessToken } -> { reply }
//   Proxies to the Gemini API so the API key never touches the browser —
//   same reasoning as the Paystack secret key. Needs GEMINI_API_KEY set in
//   Vercel's environment variables (get a free key at aistudio.google.com).
//   Requires a logged-in user and enforces a per-user daily message cap
//   (increment_chat_usage, in Postgres) so this can't be used by an
//   anonymous script to burn through the Gemini quota.
//
// action: "voices" -> { voices: [{voice_id, name, gender, accent}] }
//   Lists the ElevenLabs voices available on this account.
//
// action: "speak" { text, voiceId, accessToken } -> audio/mpeg bytes
//   Converts text to speech via ElevenLabs. Needs ELEVENLABS_API_KEY set in
//   Vercel's environment variables (get one at elevenlabs.io — there's a
//   free tier, then paid plans). Gated behind login and a per-user daily
//   character budget (increment_tts_usage) since, unlike the free
//   Gemini/browser-voice paths, every character here is real ongoing cost.
const { readBody, env } = require("./_util");

// Google retires Gemini model IDs on a rolling ~4-5 month cadence (2.0
// Flash was fully shut down June 1 2026; 2.5 Flash is next, Oct 16 2026) —
// pinned, current-GA model IDs instead of a "-latest" alias, since "-latest"
// has twice now routed to something either overloaded or already retired.
// If Levi starts erroring again, check ai.google.dev/gemini-api/docs/models
// for the current GA lineup and update these two constants.
const MODEL = "gemini-3.6-flash";
const FALLBACK_MODEL = "gemini-3.5-flash-lite";
const DAILY_MESSAGE_LIMIT = 40;
// ~5-6 spoken replies a day per person at typical reply length — generous
// for normal use, bounded against a runaway loop or bot racking up cost.
const DAILY_TTS_CHAR_LIMIT = 4000;

// The views Levi is allowed to send someone to, and the params each one
// needs. Kept to buyer/vendor-safe destinations only — nothing admin-only,
// nothing that needs an id Levi wasn't actually given.
const NAV_PROMPT =
  "You can take the person somewhere in the app by ending your reply with ONE navigation tag, on its own, in this exact format: [[NAV:view|param=value|param2=value2]] (omit the |param=value part entirely for views that take no params). Only use these views, exactly as spelled, and only with ids that appear in the data given to you above — never invent an id:\n" +
  "- home (no params) — the marketplace homepage\n" +
  "- vendors (no params) — the full vendor directory\n" +
  "- storefront|vendorId=<id> — a specific vendor's shop page\n" +
  "- productDetail|productId=<id> — a specific product/listing page\n" +
  "- wishlist (no params) — the buyer's saved items\n" +
  "- requestEquipment (no params) — post a request for something not found\n" +
  "- buyerOrders (no params) — the buyer's own order history\n" +
  "- settings (no params) — opens the settings panel (theme, accent color, notifications)\n" +
  "Vendor-only, use ONLY if the YOUR STORE DATA block is present (i.e. you know this person is a vendor): vendorDashboard, vendorProducts, vendorOrders|status=all, vendorEditProfile, vendorRequests (none take other params).\n" +
  "Only include a tag when it genuinely helps (someone asks to be taken somewhere, asks 'where do I do X', or you're recommending one specific real vendor/product) — most replies need no tag at all. Never mention the tag itself or its syntax to the person; it's invisible UI plumbing, not something to explain.";

const SYSTEM_PROMPT =
  "You are Levi, the Levromart Assistant — a friendly helper embedded in a multi-sector marketplace for Lagos, Nigeria, covering healthcare equipment, food & groceries, electronics, home & living, fashion & beauty, and services. Help buyers figure out what they need, explain how renting/buying/requesting works on Levromart, and point them to the right action (Browse, a sector, Request an item). Keep answers short (2-4 sentences) and practical, in plain conversational English. You cannot see the user's account, orders, or private data — if asked about a specific order, tell them to check 'My Orders'. You are not a medical professional — for clinical/diagnostic questions about healthcare equipment, tell them to consult a licensed healthcare provider.\n\nYou are given a snapshot of REAL, LIVE vendors and products below, under \"LIVE MARKETPLACE DATA\" — use it to answer questions like \"which vendor sells X\" or \"who do you recommend\" with actual names, ratings, and prices. Never invent a vendor or product that isn't in that snapshot. If nothing in the snapshot matches what someone's asking for, say so plainly and suggest they check Browse or post a Request instead of guessing.\n\nIf a \"YOUR STORE DATA\" block is present below, the person chatting is a vendor asking about their own shop — act as a business advisor: answer questions about their sales, visibility, and how to improve using only the real numbers given there. Never guess at figures you weren't given, and never claim to know another vendor's private numbers (orders, revenue) — only their public rating/review count from the marketplace snapshot above is fair game for comparisons.\n\n" +
  NAV_PROMPT;

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
      `${SUPABASE_URL}/rest/v1/vendors?verification_status=eq.verified&is_active=eq.true&select=id,business_name,city,avg_rating,review_count,sector:sectors(name)&order=avg_rating.desc&limit=15`,
      { headers: svcHeaders }
    ),
    words.length
      ? fetch(
          `${SUPABASE_URL}/rest/v1/products?status=eq.active&or=(${words.map((w) => `name.ilike.*${encodeURIComponent(w)}*`).join(",")})&select=id,name,sale_price,rental_rate,rental_rate_unit,is_service,service_price_unit,vendor:vendors!inner(id,business_name,avg_rating,city,verification_status,is_active)&vendor.verification_status=eq.verified&vendor.is_active=eq.true&limit=15`,
          { headers: svcHeaders }
        )
      : Promise.resolve(null),
  ]);

  const topVendors = topVendorsRes.ok ? await topVendorsRes.json() : [];
  const products = productsRes && productsRes.ok ? await productsRes.json() : [];

  // Vendor/product ids are included specifically so Levi can point someone
  // straight at a real listing with a [[NAV:...]] directive (see NAV_PROMPT)
  // instead of just describing it in words.
  const vendorLines = (topVendors || []).map(
    (v) => `- ${v.business_name} (id: ${v.id}) — ${v.sector?.name || "general"}, ${v.city || "Lagos"} — ★${Number(v.avg_rating || 0).toFixed(1)} (${v.review_count || 0} reviews)`
  );
  const productLines = (products || []).map((p) => {
    const price = p.is_service
      ? `₦${p.sale_price}${p.service_price_unit && p.service_price_unit !== "flat" ? "/" + p.service_price_unit : ""} (service)`
      : p.sale_price != null
        ? `₦${p.sale_price} to buy`
        : p.rental_rate != null
          ? `₦${p.rental_rate}/${p.rental_rate_unit} to rent`
          : "price on request";
    return `- ${p.name} (product id: ${p.id}) — ${price} — sold by ${p.vendor?.business_name || "a vendor"} (vendor id: ${p.vendor?.id || "unknown"}, ★${Number(p.vendor?.avg_rating || 0).toFixed(1)})`;
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

// Resolves a logged-in Supabase user from an access token — shared by all
// three actions below, since voices/speak need to know who's asking just
// as much as the chat completion does (rate limiting, vendor context).
async function requireUser(SUPABASE_URL, SUPABASE_ANON_KEY, accessToken) {
  if (!accessToken) return null;
  const meRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
  });
  const me = await meRes.json();
  return meRes.ok && me?.id ? me : null;
}

async function handleChat(body, res) {
  const { messages, accessToken } = body;
  if (!Array.isArray(messages) || messages.length === 0) { res.status(400).json({ error: "messages array required" }); return; }
  if (!accessToken) { res.status(401).json({ error: "Please log in to use the assistant." }); return; }

  const SUPABASE_URL = env("SUPABASE_URL");
  const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY");

  const me = await requireUser(SUPABASE_URL, SUPABASE_ANON_KEY, accessToken);
  if (!me) { res.status(401).json({ error: "Your session expired — please log in again." }); return; }

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
}

// Lists the ElevenLabs voices available on this account so the client can
// offer a real picker instead of guessing IDs. Cheap, read-only call —
// ElevenLabs doesn't charge per character for this, just for actual speech.
async function handleVoices(body, res) {
  const ELEVENLABS_API_KEY = env("ELEVENLABS_API_KEY");
  const vRes = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": ELEVENLABS_API_KEY },
  });
  const vJson = await vRes.json();
  if (!vRes.ok) { res.status(400).json({ error: vJson.detail?.message || "Could not load voices." }); return; }
  const voices = (vJson.voices || []).map((v) => ({
    voice_id: v.voice_id,
    name: v.name,
    gender: v.labels?.gender || null,
    accent: v.labels?.accent || null,
  }));
  res.status(200).json({ voices });
}

// Converts text to speech via ElevenLabs and streams the audio back —
// gated behind login and a per-user daily character budget (separate from
// the chat message cap: previewing voices or re-hearing replies costs
// characters without sending a new chat message, so it needs its own
// limit) since every character here is real, ongoing money, unlike the
// free Gemini/browser-voice paths.
async function handleSpeak(body, res) {
  const { text, voiceId, accessToken } = body;
  if (!text || !voiceId) { res.status(400).json({ error: "text and voiceId are required" }); return; }
  if (!accessToken) { res.status(401).json({ error: "Please log in." }); return; }

  const SUPABASE_URL = env("SUPABASE_URL");
  const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY");
  const me = await requireUser(SUPABASE_URL, SUPABASE_ANON_KEY, accessToken);
  if (!me) { res.status(401).json({ error: "Your session expired — please log in again." }); return; }

  const clipped = String(text).slice(0, 800);

  const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_tts_usage`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ p_user_id: me.id, p_chars: clipped.length, p_daily_char_limit: DAILY_TTS_CHAR_LIMIT }),
  });
  const withinLimit = await rpcRes.json();
  if (!rpcRes.ok) { res.status(500).json({ error: "Could not check voice usage." }); return; }
  if (withinLimit !== true) { res.status(429).json({ error: "Today's voice budget is used up — text replies still work fine." }); return; }

  const ELEVENLABS_API_KEY = env("ELEVENLABS_API_KEY");
  const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: "POST",
    headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text: clipped, model_id: "eleven_turbo_v2_5" }),
  });
  if (!ttsRes.ok) {
    let message = "Voice service error";
    try { message = (await ttsRes.json()).detail?.message || message; } catch (e) { /* non-JSON error body */ }
    res.status(400).json({ error: message });
    return;
  }
  const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
  res.setHeader("Content-Type", "audio/mpeg");
  res.status(200).send(audioBuffer);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  try {
    const body = JSON.parse(await readBody(req));
    if (body.action === "voices") return handleVoices(body, res);
    if (body.action === "speak") return handleSpeak(body, res);
    return handleChat(body, res);
  } catch (err) {
    res.status(500).json({ error: err.message || "Server error" });
  }
};
