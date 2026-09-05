// Levromart Levi — /api/chat.js
// POST { messages, accessToken, lat?, lng?, currentView?, currentViewParams?, lastRenderError? }
// Returns: { reply }
//
// PRIMARY AI: OpenAI Responses API
// FALLBACK AI: Gemini generateContent
//
// REQUIRED Vercel environment variables:
//   SUPABASE_URL
//   SUPABASE_ANON_KEY
//   SUPABASE_SERVICE_ROLE_KEY
//   OPENAI_API_KEY
//
// Optional:
//   OPENAI_MODEL
//   GEMINI_API_KEY
//
// The browser NEVER receives either AI API key.

const { readBody, env } = require("./_util");

const DAILY_MESSAGE_LIMIT = 200;
const OPENAI_DEFAULT_MODEL = "gpt-5.6-luna";
const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_FALLBACK_MODEL = "gemini-3.5-flash-lite";


const NAV_PROMPT = `
LEVROMART NAVIGATION RULES:

You may navigate the user by putting exactly ONE of these tags at the very end of your reply:

[[NAV:home]]

[[NAV:vendors]]

[[NAV:storefront|vendorId=<real vendor id>]]

[[NAV:productDetail|productId=<real product id>]]

[[NAV:wishlist]]

[[NAV:cart]]

[[NAV:requestEquipment]]

[[NAV:buyerOrders]]

[[NAV:messages]]

[[NAV:messages|conversationId=<real conversation id>]]

[[NAV:settings]]

Vendor-only destinations, ONLY when YOUR STORE DATA is present:

[[NAV:vendorDashboard]]

[[NAV:vendorProducts]]

[[NAV:vendorOrders|status=all]]

[[NAV:vendorEditProfile]]

[[NAV:vendorRequests]]

Only use real IDs supplied in LIVE MARKETPLACE DATA or YOUR ACCOUNT/YOUR STORE DATA.

Never invent IDs.

If the user asks to see/open/go to a specific product, vendor, cart, wishlist, orders, messages, etc., navigate immediately when there is one clear destination.

If the user names a product and the live data identifies exactly one matching listing, navigate to that product.

The tag is invisible UI plumbing.

Never explain it, mention it, or put it in code formatting.
`;


const CART_PROMPT = `
CART ACTION RULES:

If the user asks to ADD a product to their cart, and LIVE MARKETPLACE DATA identifies the exact sale/buy listing, perform the action with:

[[ADDCART productId=<real product id> quantity=<number>]]

Use one tag per product.

Quantity defaults to 1.

If the user asks to REMOVE something from their cart, use only a product ID present in YOUR ACCOUNT's Current cart and perform it with:

[[REMOVECART productId=<real product id>]]

IMPORTANT:

ADDCART and REMOVECART are action tags, not navigation tags.

Do not combine either with NAV or DRAFTMSG in the same reply.

When either cart action is used, the app automatically opens the cart after the action succeeds.

Therefore say what you did normally, then put the action tag(s) as the literal final part of the reply.

Never claim you added/removed something unless the matching action tag is present.

Do not add rentals/services that require extra booking details; send the user to the product page instead.
`;


const DRAFT_PROMPT = `
MESSAGE DRAFT RULES:

If the user asks Levi to message a specific vendor, draft it instead of sending it:

[[DRAFTMSG vendorId=<real vendor id>]]message text[[/DRAFTMSG]]

Never claim a message was sent.

Never combine DRAFTMSG with NAV or cart action tags.

Levi cannot place, pay for, or cancel orders through chat.
`;


const SYSTEM_PROMPT = `
You are Levi, the Levromart Assistant inside a Nigerian multi-sector marketplace.

Be fast, useful, friendly and conversational.

Normally answer in 2–4 short sentences.

Do not sound robotic.

Use Nigerian/Naira context naturally when relevant.

You help with:

- buying
- renting
- products
- vendors
- carts
- wishlists
- orders
- messages
- requests
- vendor storefronts
- delivery
- ratings
- account settings
- how Levromart works

LIVE DATA RULE:

If real marketplace/account data is supplied below, use it.

Never invent a product, vendor, order, price, ID, rating, message, or account fact.

If live data is unavailable, say that you cannot verify the specific item rather than making it up.

PRIVACY RULE:

YOUR ACCOUNT and YOUR STORE DATA belong only to the currently authenticated user.

Never expose them as information about another person.

SAFETY:

You may perform only reversible, low-risk cart actions through the tags below.

Do not place orders, make payments, cancel orders, delete accounts, or perform other consequential actions through chat.

For healthcare equipment questions, you can explain marketplace/product information, but do not diagnose or give clinical treatment advice.

Recommend a licensed healthcare professional for clinical decisions.

${NAV_PROMPT}

${CART_PROMPT}

${DRAFT_PROMPT}
`;


function jsonHeaders(key) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}


function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;

  const dLat =
    (Number(lat2) - Number(lat1)) *
    Math.PI /
    180;

  const dLng =
    (Number(lng2) - Number(lng1)) *
    Math.PI /
    180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(Number(lat1) * Math.PI / 180) *
    Math.cos(Number(lat2) * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;

  return R *
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    );
}


function distanceLabel(vLat, vLng, bLat, bLng) {
  if (
    bLat == null ||
    bLng == null ||
    vLat == null ||
    vLng == null
  ) {
    return "";
  }

  const km = haversineKm(
    bLat,
    bLng,
    vLat,
    vLng
  );

  return km < 1
    ? ` — ${Math.round(km * 1000)} m away`
    : ` — ${km.toFixed(1)} km away`;
}


async function getJson(url, options = {}) {
  try {
    const response = await fetch(url, options);

    const data = await response
      .json()
      .catch(() => null);

    return {
      ok: response.ok,
      status: response.status,
      data,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      error,
    };
  }
}


async function buildMarketplaceContext(
  SUPABASE_URL,
  anonKey,
  latestMessage,
  buyerLat,
  buyerLng
) {
  const words = String(latestMessage || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3)
    .slice(0, 6);

  const headers = {
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
  };

  const vendorsUrl =
    `${SUPABASE_URL}/rest/v1/vendors` +
    `?verification_status=eq.verified` +
    `&is_active=eq.true` +
    `&select=id,business_name,city,avg_rating,review_count,lat,lng,sector:sectors(name)` +
    `&order=avg_rating.desc` +
    `&limit=15`;

  const vendorRes = await getJson(
    vendorsUrl,
    { headers }
  );

  let products = [];

  if (words.length) {
    const ors = words
      .flatMap((word) => [
        `name.ilike.*${encodeURIComponent(word)}*`,
        `description.ilike.*${encodeURIComponent(word)}*`,
      ])
      .join(",");

    const productUrl =
      `${SUPABASE_URL}/rest/v1/products` +
      `?status=eq.active` +
      `&or=(${ors})` +
      `&select=id,name,description,sale_price,rental_rate,rental_rate_unit,is_service,service_price_unit,category:categories(name),vendor:vendors!inner(id,business_name,avg_rating,city,lat,lng,verification_status,is_active)` +
      `&vendor.verification_status=eq.verified` +
      `&vendor.is_active=eq.true` +
      `&limit=15`;

    const productRes = await getJson(
      productUrl,
      { headers }
    );

    if (productRes.ok) {
      products = productRes.data || [];
    }
  }

  let vendors =
    vendorRes.ok
      ? vendorRes.data || []
      : [];

  if (
    buyerLat != null &&
    buyerLng != null
  ) {
    vendors.sort((a, b) => {
      const da =
        a.lat != null && a.lng != null
          ? haversineKm(
              buyerLat,
              buyerLng,
              a.lat,
              a.lng
            )
          : Infinity;

      const db =
        b.lat != null && b.lng != null
          ? haversineKm(
              buyerLat,
              buyerLng,
              b.lat,
              b.lng
            )
          : Infinity;

      return da - db;
    });

    products.sort((a, b) => {
      const da =
        a.vendor?.lat != null &&
        a.vendor?.lng != null
          ? haversineKm(
              buyerLat,
              buyerLng,
              a.vendor.lat,
              a.vendor.lng
            )
          : Infinity;

      const db =
        b.vendor?.lat != null &&
        b.vendor?.lng != null
          ? haversineKm(
              buyerLat,
              buyerLng,
              b.vendor.lat,
              b.vendor.lng
            )
          : Infinity;

      return da - db;
    });
  }

  const vendorLines =
    vendors.map((vendor) =>
      `- ${vendor.business_name} ` +
      `(vendor id: ${vendor.id}) — ` +
      `${vendor.sector?.name || "general"}, ` +
      `${vendor.city || "Lagos"}, ` +
      `rating ${Number(
        vendor.avg_rating || 0
      ).toFixed(1)} ` +
      `(${vendor.review_count || 0} reviews)` +
      distanceLabel(
        vendor.lat,
        vendor.lng,
        buyerLat,
        buyerLng
      )
    );

  const productLines =
    products.map((product) => {
      let price = "price on request";

      if (product.is_service) {
        price =
          `₦${product.sale_price ?? product.rental_rate ?? ""}` +
          (
            product.service_price_unit &&
            product.service_price_unit !== "flat"
              ? `/${product.service_price_unit}`
              : ""
          ) +
          " (service)";
      } else if (
        product.sale_price != null
      ) {
        price =
          `₦${product.sale_price} to buy`;
      } else if (
        product.rental_rate != null
      ) {
        price =
          `₦${product.rental_rate}/` +
          `${product.rental_rate_unit || "period"} to rent`;
      }

      return (
        `- ${product.name}` +
        (
          product.category?.name
            ? ` [${product.category.name}]`
            : ""
        ) +
        ` (product id: ${product.id}) — ` +
        `${price} — sold by ` +
        `${product.vendor?.business_name || "a vendor"} ` +
        `(vendor id: ${product.vendor?.id || "unknown"})` +
        distanceLabel(
          product.vendor?.lat,
          product.vendor?.lng,
          buyerLat,
          buyerLng
        )
      );
    });

  return (
    `LIVE MARKETPLACE DATA (current snapshot):\n` +
    `Verified vendors:\n` +
    `${vendorLines.join("\n") || "(none returned)"}` +
    `\n\n` +
    `Matching products/services:\n` +
    `${productLines.join("\n") || "(no direct product matches)"}`
  );
}


async function buildBuyerContext(
  SUPABASE_URL,
  serviceKey,
  userId
) {
  if (!serviceKey) {
    return "";
  }

  const headers =
    jsonHeaders(serviceKey);

  const [
    ordersRes,
    cartRes,
    convRes,
  ] = await Promise.all([
    getJson(
      `${SUPABASE_URL}/rest/v1/orders` +
      `?buyer_id=eq.${encodeURIComponent(userId)}` +
      `&select=id,status,order_type,total_amount,created_at,vendor:vendors(business_name),items:order_items(quantity,product:products(name))` +
      `&order=created_at.desc` +
      `&limit=30`,
      { headers }
    ),

    getJson(
      `${SUPABASE_URL}/rest/v1/cart_items` +
      `?buyer_id=eq.${encodeURIComponent(userId)}` +
      `&select=quantity,product:products(id,name)`,
      { headers }
    ),

    getJson(
      `${SUPABASE_URL}/rest/v1/conversations` +
      `?buyer_id=eq.${encodeURIComponent(userId)}` +
      `&select=id,vendor:vendors(id,business_name)`,
      { headers }
    ),
  ]);

  const orders =
    ordersRes.ok
      ? ordersRes.data || []
      : [];

  const cart =
    cartRes.ok
      ? cartRes.data || []
      : [];

  const conversations =
    convRes.ok
      ? convRes.data || []
      : [];

  const counts = {};

  orders.forEach((order) => {
    counts[order.status] =
      (counts[order.status] || 0) + 1;
  });

  const statusSummary =
    Object.entries(counts)
      .map(
        ([status, count]) =>
          `${count} ${status}`
      )
      .join(", ") ||
    "none";

  const orderLines =
    orders
      .slice(0, 10)
      .map((order) => {
        const items =
          (order.items || [])
            .map(
              (item) =>
                `${item.product?.name || "item"} x${item.quantity}`
            )
            .join(", ") ||
          order.order_type ||
          "order";

        return (
          `- ${items} — ` +
          `${order.vendor?.business_name || "vendor"} — ` +
          `${order.status} — ` +
          `₦${order.total_amount}`
        );
      });

  const cartLines =
    cart
      .filter((item) => item.product)
      .map(
        (item) =>
          `- ${item.product.name} x${item.quantity} ` +
          `(product id: ${item.product.id})`
      );

  let messageLines = [];

  if (conversations.length) {
    const ids =
      conversations.map(
        (conversation) => conversation.id
      );

    const inList =
      ids
        .map((id) => `"${id}"`)
        .join(",");

    const msgRes =
      await getJson(
        `${SUPABASE_URL}/rest/v1/messages` +
        `?conversation_id=in.(${inList})` +
        `&select=conversation_id,sender_id,body,created_at,read_at` +
        `&order=created_at.desc`,
        { headers }
      );

    if (msgRes.ok) {
      const byConversation = {};

      (msgRes.data || [])
        .forEach((message) => {
          (
            byConversation[
              message.conversation_id
            ] ||= []
          ).push(message);
        });

      messageLines =
        conversations
          .map((conversation) => {
            const messages =
              byConversation[
                conversation.id
              ] || [];

            if (!messages.length) {
              return null;
            }

            const unread =
              messages.filter(
                (message) =>
                  message.sender_id !== userId &&
                  !message.read_at
              ).length;

            const last =
              messages[0];

            return (
              `- ${conversation.vendor?.business_name || "vendor"} ` +
              `(vendor id: ${conversation.vendor?.id || "unknown"}, ` +
              `conversation id: ${conversation.id})` +
              (
                unread
                  ? ` — ${unread} unread`
                  : ""
              ) +
              `: "${String(
                last.body || ""
              ).slice(0, 120)}"`
            );
          })
          .filter(Boolean);
    }
  }

  return (
    `YOUR ACCOUNT (private current user's data):\n` +
    `- Orders: ${orders.length} total ` +
    `(${statusSummary})\n` +
    `${orderLines.join("\n") || "(no orders)"}\n` +
    `- Current cart:\n` +
    `${cartLines.join("\n") || "(empty)"}\n` +
    `- Vendor message threads:\n` +
    `${messageLines.join("\n") || "(no conversations)"}`
  );
}


async function buildVendorContext(
  SUPABASE_URL,
  serviceKey,
  userId
) {
  if (!serviceKey) {
    return "";
  }

  const headers =
    jsonHeaders(serviceKey);

  const vendorRes =
    await getJson(
      `${SUPABASE_URL}/rest/v1/vendors` +
      `?user_id=eq.${encodeURIComponent(userId)}` +
      `&deleted_at=is.null` +
      `&select=id,business_name,avg_rating,review_count,is_active,verification_status,commission_pct`,
      { headers }
    );

  if (
    !vendorRes.ok ||
    !vendorRes.data?.[0]
  ) {
    return "";
  }

  const vendor =
    vendorRes.data[0];

  const [
    ordersRes,
    productsRes,
  ] = await Promise.all([
    getJson(
      `${SUPABASE_URL}/rest/v1/orders` +
      `?vendor_id=eq.${encodeURIComponent(vendor.id)}` +
      `&select=status,total_amount`,
      { headers }
    ),

    getJson(
      `${SUPABASE_URL}/rest/v1/products` +
      `?vendor_id=eq.${encodeURIComponent(vendor.id)}` +
      `&select=id,status,view_count`,
      { headers }
    ),
  ]);

  const orders =
    ordersRes.ok
      ? ordersRes.data || []
      : [];

  const products =
    productsRes.ok
      ? productsRes.data || []
      : [];

  const completed =
    orders.filter(
      (order) =>
        order.status === "completed"
    );

  const pending =
    orders.filter(
      (order) =>
        [
          "pending",
          "confirmed",
        ].includes(order.status)
    ).length;

  const revenue =
    completed.reduce(
      (sum, order) =>
        sum +
        Number(
          order.total_amount || 0
        ),
      0
    );

  const active =
    products.filter(
      (product) =>
        product.status === "active"
    ).length;

  const views =
    products.reduce(
      (sum, product) =>
        sum +
        Number(
          product.view_count || 0
        ),
      0
    );

  return (
    `YOUR STORE DATA (private current vendor's data):\n` +
    `- Store: ${vendor.business_name}\n` +
    `- Verification: ${vendor.verification_status}\n` +
    `- Storefront: ${vendor.is_active ? "active" : "paused"}\n` +
    `- Rating: ${Number(
      vendor.avg_rating || 0
    ).toFixed(1)} from ${
      vendor.review_count || 0
    } reviews\n` +
    `- Listings: ${active} active / ${products.length} total\n` +
    `- Orders: ${orders.length} total; ` +
    `${pending} pending/confirmed; ` +
    `${completed.length} completed\n` +
    `- Completed-order revenue: ₦${revenue.toLocaleString("en-NG")}\n` +
    `- Product views: ${views}`
  );
}


function extractOpenAIText(data) {
  if (!data) {
    return "";
  }

  if (
    typeof data.output_text === "string"
  ) {
    return data.output_text.trim();
  }

  return (
    data.output || []
  )
    .flatMap(
      (item) =>
        item?.content || []
    )
    .filter(
      (part) =>
        part?.type === "output_text"
    )
    .map(
      (part) =>
        part.text || ""
    )
    .join("")
    .trim();
}


async function callOpenAI(
  apiKey,
  model,
  instructions,
  messages
) {
  const input =
    messages
      .slice(-20)
      .map((message) => ({
        role:
          message.role === "assistant"
            ? "assistant"
            : "user",

        content:
          String(
            message.content || ""
          ).slice(0, 5000),
      }));

  return getJson(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",

      headers: {
        Authorization:
          `Bearer ${apiKey}`,

        "Content-Type":
          "application/json",
      },

      body: JSON.stringify({
        model,

        instructions,

        input,

        store: false,

        max_output_tokens: 650,

        reasoning: {
          effort: "none",
        },

        text: {
          verbosity: "low",
        },
      }),
    }
  );
}


async function callGemini(
  apiKey,
  model,
  instructions,
  messages
) {
  const contents =
    messages
      .slice(-20)
      .map((message) => ({
        role:
          message.role === "assistant"
            ? "model"
            : "user",

        parts: [
          {
            text:
              String(
                message.content || ""
              ).slice(0, 5000),
          },
        ],
      }));

  return getJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",

      headers: {
        "x-goog-api-key":
          apiKey,

        "Content-Type":
          "application/json",
      },

      body: JSON.stringify({
        system_instruction: {
          parts: [
            {
              text: instructions,
            },
          ],
        },

        contents,

        generationConfig: {
          maxOutputTokens: 650,
        },
      }),
    }
  );
}


function extractGeminiText(data) {
  return (
    data
      ?.candidates?.[0]
      ?.content?.parts
      ?.map(
        (part) =>
          part.text || ""
      )
      .join("")
      .trim() || ""
  );
}


module.exports = async function handler(
  req,
  res
) {
  if (req.method !== "POST") {
    res
      .status(405)
      .json({
        error: "Method not allowed",
      });

    return;
  }

  try {
    const body =
      JSON.parse(
        await readBody(req)
      );

    const messages =
      Array.isArray(body.messages)
        ? body.messages
        : [];

    const accessToken =
      body.accessToken;

    if (!messages.length) {
      res
        .status(400)
        .json({
          error:
            "messages array required",
        });

      return;
    }

    if (!accessToken) {
      res
        .status(401)
        .json({
          error:
            "Please log in to use Levi.",
        });

      return;
    }

    const SUPABASE_URL =
      env("SUPABASE_URL");

    const SUPABASE_ANON_KEY =
      env("SUPABASE_ANON_KEY");

    const SERVICE_KEY =
      env(
        "SUPABASE_SERVICE_ROLE_KEY"
      );

    if (
      !SUPABASE_URL ||
      !SUPABASE_ANON_KEY
    ) {
      res
        .status(500)
        .json({
          error:
            "Levromart server configuration is incomplete.",
        });

      return;
    }

    // Verify the user's Supabase session.
    const userRes =
      await getJson(
        `${SUPABASE_URL}/auth/v1/user`,
        {
          headers: {
            apikey:
              SUPABASE_ANON_KEY,

            Authorization:
              `Bearer ${accessToken}`,
          },
        }
      );

    const user =
      userRes.data;

    if (
      !userRes.ok ||
      !user?.id
    ) {
      res
        .status(401)
        .json({
          error:
            "Your session expired — please log in again.",
        });

      return;
    }

    // Preserve the existing per-user chat limit.
    const usageRes =
      await getJson(
        `${SUPABASE_URL}/rest/v1/rpc/increment_chat_usage`,
        {
          method: "POST",

          headers: {
            ...jsonHeaders(
              SUPABASE_ANON_KEY
            ),

            Authorization:
              `Bearer ${accessToken}`,
          },

          body: JSON.stringify({
            p_user_id:
              user.id,

            p_limit:
              DAILY_MESSAGE_LIMIT,
          }),
        }
      );

    if (!usageRes.ok) {
      res
        .status(500)
        .json({
          error:
            "Could not check Levi chat usage.",
        });

      return;
    }

    if (
      usageRes.data !== true
    ) {
      res
        .status(429)
        .json({
          error:
            `You've reached today's Levi chat limit (${DAILY_MESSAGE_LIMIT}). Try again tomorrow.`,
        });

      return;
    }

    const latestMessage =
      [
        ...messages,
      ]
        .reverse()
        .find(
          (message) =>
            message.role !==
            "assistant"
        )
        ?.content || "";

    const buyerLat =
      typeof body.lat === "number"
        ? body.lat
        : null;

    const buyerLng =
      typeof body.lng === "number"
        ? body.lng
        : null;

    let marketplaceContext =
      "LIVE MARKETPLACE DATA: unavailable right now. Do not invent specific listings.";

    let buyerContext = "";

    let vendorContext = "";

    try {
      marketplaceContext =
        await buildMarketplaceContext(
          SUPABASE_URL,
          SUPABASE_ANON_KEY,
          latestMessage,
          buyerLat,
          buyerLng
        );
    } catch (_) {}

    try {
      buyerContext =
        await buildBuyerContext(
          SUPABASE_URL,
          SERVICE_KEY,
          user.id
        );
    } catch (_) {}

    try {
      vendorContext =
        await buildVendorContext(
          SUPABASE_URL,
          SERVICE_KEY,
          user.id
        );
    } catch (_) {}

    // Account suspension information.
    let accountStatusContext =
      "";

    if (SERVICE_KEY) {
      try {
        const statusRes =
          await getJson(
            `${SUPABASE_URL}/rest/v1/users` +
            `?id=eq.${encodeURIComponent(user.id)}` +
            `&select=suspended_at,suspended_reason`,
            {
              headers:
                jsonHeaders(
                  SERVICE_KEY
                ),
            }
          );

        const row =
          statusRes.data?.[0];

        if (row?.suspended_at) {
          accountStatusContext =
            `\nACCOUNT STATUS: This user's account is currently suspended. ` +
            `Reason: "${String(
              row.suspended_reason ||
              "No reason supplied"
            ).slice(0, 500)}". ` +
            `Explain this plainly if they ask and tell them to use the suspended-account appeal flow.`;
        }
      } catch (_) {}
    }

    // Tell Levi which logical app screen the user is currently on.
    let currentScreenContext =
      "";

    if (
      typeof body.currentView ===
        "string" &&
      body.currentView
    ) {
      currentScreenContext =
        `\nCURRENT SCREEN: ${body.currentView}` +
        (
          body.currentViewParams
            ? ` ${JSON.stringify(
                body.currentViewParams
              ).slice(0, 300)}`
            : ""
        ) +
        `. This is only the app's logical view name; do not pretend to see the user's pixels.`;
    }

    if (
      body.lastRenderError
    ) {
      currentScreenContext +=
        `\nRECENT APP ERROR: ${String(
          body.lastRenderError
        ).slice(0, 500)}`;
    }

    const instructions =
      `${SYSTEM_PROMPT}\n\n` +
      `${marketplaceContext}\n\n` +
      `${buyerContext}\n\n` +
      `${vendorContext}` +
      `${accountStatusContext}` +
      `${currentScreenContext}`;

    const openAiKey =
      env("OPENAI_API_KEY");

    const openAiModel =
      env("OPENAI_MODEL") ||
      OPENAI_DEFAULT_MODEL;

    const geminiKey =
      env("GEMINI_API_KEY");

    let reply = "";

    let providerError = "";

    // ============================================================
    // PRIMARY PROVIDER — OPENAI
    // ============================================================

    if (openAiKey) {
      let ai =
        await callOpenAI(
          openAiKey,
          openAiModel,
          instructions,
          messages
        );

      if (ai.ok) {
        reply =
          extractOpenAIText(
            ai.data
          );
      } else {
        providerError =
          ai.data?.error?.message ||
          "OpenAI request failed.";

        // If a custom model was configured and rejected,
        // retry with the known default model.
        if (
          openAiModel !==
          OPENAI_DEFAULT_MODEL
        ) {
          ai =
            await callOpenAI(
              openAiKey,
              OPENAI_DEFAULT_MODEL,
              instructions,
              messages
            );

          if (ai.ok) {
            reply =
              extractOpenAIText(
                ai.data
              );
          } else {
            providerError =
              ai.data?.error?.message ||
              providerError;
          }
        }
      }
    }

    // ============================================================
    // FALLBACK PROVIDER — GEMINI
    // ============================================================

    if (
      !reply &&
      geminiKey
    ) {
      let ai =
        await callGemini(
          geminiKey,
          GEMINI_MODEL,
          instructions,
          messages
        );

      if (!ai.ok) {
        ai =
          await callGemini(
            geminiKey,
            GEMINI_FALLBACK_MODEL,
            instructions,
            messages
          );
      }

      if (ai.ok) {
        reply =
          extractGeminiText(
            ai.data
          );
      } else {
        providerError =
          ai.data?.error?.message ||
          providerError ||
          "Gemini request failed.";
      }
    }

    // ============================================================
    // NO PROVIDER AVAILABLE
    // ============================================================

    if (!reply) {
      res
        .status(502)
        .json({
          error:
            providerError ||
            "No AI provider is configured. Add OPENAI_API_KEY in Vercel Environment Variables.",
        });

      return;
    }

    res
      .status(200)
      .json({
        reply,
      });

  } catch (error) {
    res
      .status(500)
      .json({
        error:
          error?.message ||
          "Server error",
      });
  }
};
