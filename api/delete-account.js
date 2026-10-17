const fs = require("fs");
const path = require("path");
const { readBody, env } = require("./_util");
const sharp = require("sharp");

// The built web app (index.html, icons, fonts) is produced by `npm run build -w medris-frontend`
// into medris-frontend/dist; vercel.json `includeFiles` ships those files with this function.
// (Before the frontend/backend split they sat at the repository root.)
const STATIC_ROOT = path.join(process.cwd(), "medris-frontend", "dist");

// Vercel's Hobby plan caps deployments at 12 serverless functions, and this
// file is already the shared landing spot for a couple of rewritten routes
// (see vercel.json) -- so the vendor/product share-preview page rides along
// here too, on GET, rather than spending a 13th function slot on it.
//
// WhatsApp/Facebook/Twitter link-preview crawlers fetch the raw HTML of a
// shared URL and read its <meta> tags -- they never run this SPA's
// JavaScript, so the client-side updateStorefrontSocialMeta()/
// syncLevromartLinkPreviewMeta() calls in index.html (which only run in a
// real browser, after the page has already loaded) are invisible to them.
// A shared storefront or product link always showed the generic Levromart
// preview image instead of that vendor's/product's own photo. This serves
// the exact same index.html, with just the handful of default <meta> tag
// values swapped for the real vendor's/product's name, description and
// photo, so the crawler's very first (and only) fetch already has them.
function escAttr(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Share-preview cards (1200x630) for storefront / product / package links.
// Text is converted to vector paths with opentype.js so it renders on the server
// without any installed fonts. Storefront: vendor logo (or initials) in the ring,
// name on the left. Product/package: item photo in the ring, name + price on the
// left and the vendor's logo and name along the bottom.
// ---------------------------------------------------------------------------
let _ogFonts = null;
function ogFonts() {
  if (_ogFonts) return _ogFonts;
  const opentype = require("opentype.js");
  const load = (f) => { const b = fs.readFileSync(path.join(STATIC_ROOT, "fonts", f)); return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
  _ogFonts = { bold: load("Poppins-ExtraBold.ttf"), semi: load("Poppins-SemiBold.ttf"), med: load("Poppins-Medium.ttf") };
  return _ogFonts;
}
function ogWidth(font, text, size) { return font.getAdvanceWidth(text, size); }
function ogPathData(p) {
  // toPathData() can print exponents like 1e-7, which some SVG renderers reject mid-path; format every number plainly.
  const n = (v) => (Math.round(v * 100) / 100).toFixed(2);
  return p.commands.map((c) => c.type === "Z" ? "Z" : c.type === "M" || c.type === "L" ? `${c.type}${n(c.x)} ${n(c.y)}` : c.type === "Q" ? `Q${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}` : `C${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`).join("");
}
function ogText(font, text, x, y, size, fill) { return `<path d="${ogPathData(font.getPath(text, x, y, size))}" fill="${fill}"/>`; }
function ogFit(font, text, size, maxW) {
  let t = String(text || "").trim();
  if (ogWidth(font, t, size) <= maxW) return t;
  while (t.length > 1 && ogWidth(font, t + "...", size) > maxW) t = t.slice(0, -1);
  return t.trim() + "...";
}
function ogWrap(font, text, size, maxW, maxLines) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  const lines = []; let cur = "";
  for (let i = 0; i < words.length; i++) {
    const w = words[i], tryLine = cur ? cur + " " + w : w;
    if (ogWidth(font, tryLine, size) <= maxW) { cur = tryLine; continue; }
    if (cur) { lines.push(cur); cur = w; } else { lines.push(ogFit(font, w, size, maxW)); cur = ""; }
    if (lines.length === maxLines) { cur = ""; const rest = words.slice(i).join(" "); lines[maxLines - 1] = ogFit(font, lines[maxLines - 1] + " " + rest, size, maxW); return lines; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { const keep = lines.slice(0, maxLines); keep[maxLines - 1] = ogFit(font, lines.slice(maxLines - 1).join(" "), size, maxW); return keep; }
  return lines;
}
function ogInitials(name) {
  const w = String(name || "").replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (!w.length) return "L";
  return ((w[0][0] || "") + (w.length > 1 ? (w[1][0] || "") : (w[0][1] || ""))).toUpperCase();
}
function ogHue(name) { let h = 0; const n = String(name || "Levromart"); for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) % 360; return h; }
function ogNaira(f, x, y, size, fill) {
  const N = ogPathData(f.getPath("N", x, y, size)), w = ogWidth(f, "N", size);
  const bar = (dy) => `<rect x="${x - size * 0.07}" y="${y - dy}" width="${w + size * 0.14}" height="${size * 0.085}" fill="${fill}"/>`;
  return { svg: `<path d="${N}" fill="${fill}"/>${bar(size * 0.43)}${bar(size * 0.27)}`, width: w };
}
async function ogGrab(u) {
  if (!u) return null;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
  try { const r = await fetch(u, { signal: ctl.signal }); return r.ok ? Buffer.from(await r.arrayBuffer()) : null; } catch (_) { return null; } finally { clearTimeout(t); }
}
async function ogCircle(buf, D, bg) {
  const mask = Buffer.from(`<svg width="${D}" height="${D}"><circle cx="${D / 2}" cy="${D / 2}" r="${D / 2}" fill="#fff"/></svg>`);
  return sharp(buf, { failOn: "none" }).rotate().flatten({ background: bg || "#ffffff" }).resize(D, D, { fit: "cover" }).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
}
function ogMoney(n) { return Number(n).toLocaleString("en-NG", { maximumFractionDigits: 0 }); }

async function ogCard(req, res) {
  try {
    const storeId = String(req.query?.ogstore || "").trim();
    const productId = String(req.query?.ogprod || "").trim();
    const packageId = String(req.query?.ogpkg || "").trim();
    const root = STATIC_ROOT;
    const W = 1200, H = 630, CX = 880, CY = 315, D = 392;
    const SUPABASE_URL = env("SUPABASE_URL"), KEY = env("SUPABASE_SERVICE_ROLE_KEY");
    const hdr = { apikey: KEY, Authorization: `Bearer ${KEY}` };
    const get = async (p) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: hdr }); const j = await r.json(); return Array.isArray(j) ? j[0] : null; };
    const F = ogFonts();
    let kind = "store", name = "", photo = null, vendorName = "", vendorLogo = null, priceText = "";
    if (storeId) {
      const v = await get(`vendors?id=eq.${encodeURIComponent(storeId)}&verification_status=eq.verified&is_active=eq.true&select=business_name,logo_url`);
      name = v?.business_name || "Levromart storefront"; photo = v?.logo_url || null; vendorName = name;
    } else if (productId) {
      kind = "product";
      const p = await get(`products?id=eq.${encodeURIComponent(productId)}&select=name,sale_price,discount_price,rental_rate,photos,vendor:vendors(business_name,logo_url)`);
      name = p?.name || "Levromart listing"; photo = Array.isArray(p?.photos) && p.photos[0] ? p.photos[0] : null;
      vendorName = p?.vendor?.business_name || ""; vendorLogo = p?.vendor?.logo_url || null;
      const sale = Number(p?.sale_price), disc = Number(p?.discount_price);
      const price = disc > 0 && sale > 0 && disc < sale ? disc : (sale > 0 ? sale : Number(p?.rental_rate) || 0);
      if (price > 0) priceText = ogMoney(price);
    } else if (packageId) {
      kind = "package";
      const p = await get(`vendor_packages?id=eq.${encodeURIComponent(packageId)}&select=name,price,photos,vendor:vendors(business_name,logo_url)`);
      name = p?.name || "Levromart package"; photo = Array.isArray(p?.photos) && p.photos[0] ? p.photos[0] : null;
      vendorName = p?.vendor?.business_name || ""; vendorLogo = p?.vendor?.logo_url || null;
      if (Number(p?.price) > 0) priceText = ogMoney(p.price);
    }
    const [photoBuf, logoBuf] = await Promise.all([ogGrab(photo), kind === "store" ? Promise.resolve(null) : ogGrab(vendorLogo)]);
    const layers = [];
    // ---- ring content
    let centre = null;
    if (photoBuf) { try { centre = await ogCircle(photoBuf, D); } catch (_) { centre = null; } }
    if (!centre) {
      const h = ogHue(kind === "store" ? name : (vendorName || name)), ini = ogInitials(kind === "store" ? name : (vendorName || name));
      const size = 190, w = ogWidth(F.bold, ini, size);
      const svg = `<svg width="${D}" height="${D}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h},70%,90%)"/><stop offset="1" stop-color="hsl(${h},60%,78%)"/></linearGradient><clipPath id="c"><circle cx="${D / 2}" cy="${D / 2}" r="${D / 2}"/></clipPath></defs><g clip-path="url(#c)"><rect width="${D}" height="${D}" fill="url(#g)"/>${ogText(F.bold, ini, (D - w) / 2, D / 2 + size * 0.36, size, `hsl(${h},55%,28%)`)}</g></svg>`;
      centre = await sharp(Buffer.from(svg)).png().toBuffer();
    }
    layers.push({ input: centre, left: CX - D / 2, top: CY - D / 2 });
    // ---- Levromart badge on the ring
    const B = 124;
    const iconBase = await sharp(path.join(root, "icon-512.png")).resize(B - 16, B - 16).composite([{ input: Buffer.from(`<svg width="${B - 16}" height="${B - 16}"><rect width="${B - 16}" height="${B - 16}" rx="26" fill="#fff"/></svg>`), blend: "dest-in" }]).png().toBuffer();
    const badge = await sharp(Buffer.from(`<svg width="${B}" height="${B}"><rect width="${B}" height="${B}" rx="34" fill="#fff"/></svg>`)).composite([{ input: iconBase, left: 8, top: 8 }]).png().toBuffer();
    layers.push({ input: badge, left: CX + 118, top: CY + 112 });
    // ---- left-hand text
    let svg = "";
    const X = 70;
    if (kind === "store") {
      const size = 66, lines = ogWrap(F.bold, name, size, 540, 2);
      lines.forEach((l, i) => { svg += ogText(F.bold, l, X, 250 + i * 78, size, "#ffffff"); });
      svg += ogText(F.semi, "Verified vendor on LevroMart", X, 250 + lines.length * 78 + 20, 28, "#7dffbe");
    } else {
      let size = 58, lines = ogWrap(F.bold, name, size, 540, 2);
      for (const s of [58, 50, 44]) { size = s; lines = ogWrap(F.bold, name, s, 540, 2); if (lines.join(" ").replace(/\.\.\.$/, "") .length >= String(name).trim().length - 1 && !/\.\.\.$/.test(lines[lines.length - 1])) break; }
      const lh = Math.round(size * 1.17);
      lines.forEach((l, i) => { svg += ogText(F.bold, l, X, 230 + i * lh, size, "#ffffff"); });
      let y = 230 + lines.length * lh + 28;
      if (priceText) {
        const n = ogNaira(F.bold, X, y + 34, 54, "#5df0a5");
        svg += n.svg + ogText(F.bold, priceText, X + n.width + 14, y + 34, 54, "#5df0a5");
      }
      if (vendorName) {
        const R = 40, cy = 512;
        svg += ogText(F.med, "Sold by", X + 2 * R + 22, cy - 8, 22, "#a9d9c0");
        svg += ogText(F.semi, ogFit(F.semi, vendorName, 30, 470), X + 2 * R + 22, cy + 28, 30, "#ffffff");
        let face = null;
        if (logoBuf) { try { face = await ogCircle(logoBuf, 2 * R - 8); } catch (_) { face = null; } }
        const ring = Buffer.from(`<svg width="${2 * R}" height="${2 * R}"><circle cx="${R}" cy="${R}" r="${R}" fill="#fff"/></svg>`);
        layers.push({ input: ring, left: X, top: cy - R });
        if (face) layers.push({ input: face, left: X + 4, top: cy - R + 4 });
        else {
          const h = ogHue(vendorName), ini = ogInitials(vendorName), s2 = 34, w2 = ogWidth(F.bold, ini, s2);
          const t = Buffer.from(`<svg width="${2 * R - 8}" height="${2 * R - 8}"><defs><clipPath id="c"><circle cx="${R - 4}" cy="${R - 4}" r="${R - 4}"/></clipPath></defs><g clip-path="url(#c)"><rect width="${2 * R}" height="${2 * R}" fill="hsl(${h},60%,84%)"/>${ogText(F.bold, ini, (2 * R - 8 - w2) / 2, R - 4 + s2 * 0.36, s2, `hsl(${h},55%,28%)`)}</g></svg>`);
          layers.push({ input: await sharp(t).png().toBuffer(), left: X + 4, top: cy - R + 4 });
        }
      }
    }
    if (svg) layers.push({ input: Buffer.from(`<svg width="${W}" height="${H}">${svg}</svg>`), left: 0, top: 0 });
    const out = await sharp(path.join(root, "og-frame.png")).composite(layers).png({ compressionLevel: 8 }).toBuffer();
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800");
    res.status(200).send(out);
  } catch (err) {
    console.error("Levromart share card error:", err);
    res.statusCode = 302; res.setHeader("Location", "/og-levromart.png"); res.end();
  }
}

async function shareMetaPreview(req, res) {
  const serveAsIs = () => {
    const html = fs.readFileSync(path.join(STATIC_ROOT, "index.html"), "utf8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(html);
  };
  try {
    const vendorId = String(req.query?.storefront || "").trim();
    const productId = String(req.query?.product || "").trim();
    const packageId = String(req.query?.package || "").trim();
    if (!vendorId && !productId && !packageId) { serveAsIs(); return; }

    const SUPABASE_URL = env("SUPABASE_URL");
    const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
    const svcHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
    const origin = `https://${req.headers.host}`;

    let title = null, description = null, image = null, pageUrl = `${origin}/`;

    if (vendorId) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/vendors?id=eq.${encodeURIComponent(vendorId)}&verification_status=eq.verified&is_active=eq.true&select=id,business_name,bio,logo_url`, { headers: svcHeaders });
      const [v] = await r.json();
      if (v) {
        title = `${v.business_name || "Levromart storefront"} | Levromart`;
        description = v.bio || `Check out ${v.business_name || "this store"} on Levromart.`;
        image = `${origin}/api/delete-account?ogstore=${encodeURIComponent(v.id)}`;
        pageUrl = `${origin}/?storefront=${encodeURIComponent(v.id)}`;
      }
    } else if (packageId) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/vendor_packages?id=eq.${encodeURIComponent(packageId)}&select=id,name,description,vendor:vendors(business_name)`, { headers: svcHeaders });
      const [k] = await r.json();
      if (k) {
        title = `${k.name || "Levromart package"} | Levromart`;
        description = String(k.description || `${k.name || "This package"} on Levromart${k.vendor?.business_name ? ` from ${k.vendor.business_name}` : ""}.`).slice(0, 200);
        image = `${origin}/api/delete-account?ogpkg=${encodeURIComponent(k.id)}`;
        pageUrl = `${origin}/?package=${encodeURIComponent(k.id)}`;
      }
    } else {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/products?id=eq.${encodeURIComponent(productId)}&select=id,name,description,photos,vendor:vendors(business_name)`, { headers: svcHeaders });
      const [p] = await r.json();
      if (p) {
        title = `${p.name || "Levromart listing"} | Levromart`;
        description = String(p.description || `${p.name || "This listing"} on Levromart${p.vendor?.business_name ? ` from ${p.vendor.business_name}` : ""}.`).slice(0, 200);
        image = `${origin}/api/delete-account?ogprod=${encodeURIComponent(p.id)}`;
        pageUrl = `${origin}/?product=${encodeURIComponent(p.id)}`;
      }
    }

    let html = fs.readFileSync(path.join(STATIC_ROOT, "index.html"), "utf8");
    if (title) {
      const t = escAttr(title), d = escAttr(description || ""), u = escAttr(pageUrl);
      html = html.replace(/<title>[^<]*<\/title>/, `<title>${t}</title>`);
      html = html.replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${d}">`);
      html = html.replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${t}">`);
      html = html.replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${d}">`);
      html = html.replace(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${u}">`);
      html = html.replace(/<meta name="twitter:title" content="[^"]*">/, `<meta name="twitter:title" content="${t}">`);
      html = html.replace(/<meta name="twitter:description" content="[^"]*">/, `<meta name="twitter:description" content="${d}">`);
      if (image) {
        const img = escAttr(image);
        html = html.replace(/<meta property="og:image" content="[^"]*">/, `<meta property="og:image" content="${img}">`);
        html = html.replace(/<meta name="twitter:image" content="[^"]*">/, `<meta name="twitter:image" content="${img}">`);
      }
    }
    if (/^\/[spk]\//.test(String(req.url || "")) || vendorId || productId || packageId) {
      const q = vendorId ? `storefront=${encodeURIComponent(vendorId)}` : productId ? `product=${encodeURIComponent(productId)}` : `package=${encodeURIComponent(packageId)}`;
      html = html.replace("<head>", `<head><base href="/"><script>try{if(location.pathname!=="/"||!location.search)history.replaceState(null,"","/?${q}");}catch(e){}</script>`);
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(html);
  } catch (err) {
    console.error("Levromart share-preview error:", err);
    try { serveAsIs(); } catch (_) { res.status(500).end(); }
  }
}

function serviceHeaders(key) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json"
  };
}

function normalizePhone(phone) {
  let digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0") && digits.length === 11) digits = "234" + digits.slice(1);
  return digits;
}

function phoneAlias(phone) {
  const digits = normalizePhone(phone);
  return digits ? `p${digits}@accounts.levromart.app` : "";
}

async function readJson(response) {
  return response.json().catch(() => ({}));
}

async function listAuthUsers(supabaseUrl, key, wantedEmail) {
  const headers = serviceHeaders(key);
  const target = String(wantedEmail || "").trim().toLowerCase();
  if (!target) return null;

  for (let page = 1; page <= 20; page++) {
    const response = await fetch(
      `${supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=1000`,
      { headers }
    );
    if (!response.ok) return null;
    const data = await readJson(response);
    const users = Array.isArray(data) ? data : (data.users || []);
    const match = users.find(
      user => String(user?.email || "").trim().toLowerCase() === target
    );
    if (match) return match;
    if (users.length < 1000) break;
  }
  return null;
}

async function publicUserByEmail(supabaseUrl, key, email) {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/users?email=eq.${encodeURIComponent(email)}&select=id,email,phone`,
    { headers: serviceHeaders(key) }
  );
  if (!response.ok) return null;
  const rows = await readJson(response);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function publicUserByPhone(supabaseUrl, key, phone) {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/users?phone=eq.${encodeURIComponent(phone)}&select=id,email,phone`,
    { headers: serviceHeaders(key) }
  );
  if (!response.ok) return null;
  const rows = await readJson(response);
  return Array.isArray(rows) ? rows[0] || null : null;
}

/* ============================================================
   ACCOUNT EXISTS
   This stays inside the existing delete-account function so Vercel
   does not get another serverless function.
   ============================================================ */
async function accountExists(body, res) {
  const email = String(body?.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "A valid email address is required." });
  }

  const supabaseUrl = env("SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: "Supabase server configuration is incomplete." });
  }

  const profile = await publicUserByEmail(supabaseUrl, serviceKey, email);
  const authUser = await listAuthUsers(supabaseUrl, serviceKey, email);

  return res.status(200).json({
    exists: Boolean(profile || authUser),
    hasPublicProfile: Boolean(profile),
    hasAuthAccount: Boolean(authUser)
  });
}

/* ============================================================
   REGISTER ACCOUNT
   Email is optional. Phone is required.
   No confirmation email is sent.
   ============================================================ */
async function registerAccount(body, res) {
  const cleanEmail = String(body?.email || "").trim().toLowerCase();
  const cleanName = String(body?.name || "").trim();
  const cleanPhone = String(body?.phone || "").trim();
  const normalizedPhone = normalizePhone(cleanPhone);
  const role = body?.role;
  const password = String(body?.password || "");
  const city = String(body?.city || "").trim();
  const referralCode = String(body?.referral_code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);

  if (!cleanName) return res.status(400).json({ error: "Full name is required." });
  if (!normalizedPhone || normalizedPhone.length < 10) return res.status(400).json({ error: "A valid phone number is required." });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  if (role !== "buyer" && role !== "vendor") return res.status(400).json({ error: "Invalid account type." });
  if (cleanEmail && !cleanEmail.includes("@")) return res.status(400).json({ error: "Enter a valid email address or leave email blank." });

  // Choosing "vendor" at signup is only an application intent, never an
  // approved role — mirrors chooseAccountRole's authoritativeRole logic so
  // the stored users.role can never be 'vendor' before a vendor application
  // is actually reviewed and verified.
  const authoritativeRole = role === "vendor" ? "buyer" : role;

  const supabaseUrl = env("SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Supabase server configuration is incomplete." });

  const headers = serviceHeaders(serviceKey);

  // Phone is the required unique registration identifier.
  const existingPhone = await publicUserByPhone(supabaseUrl, serviceKey, cleanPhone);
  if (existingPhone) {
    return res.status(409).json({ error: "An account with that phone number already exists. Please log in instead." });
  }

  // If an email was supplied, check both the public profile and Auth.
  if (cleanEmail) {
    const existingProfile = await publicUserByEmail(supabaseUrl, serviceKey, cleanEmail);
    const existingAuth = await listAuthUsers(supabaseUrl, serviceKey, cleanEmail);
    if (existingProfile || existingAuth) {
      return res.status(409).json({ error: "A user with this email address has already been registered. Please log in instead." });
    }
  }

  // Supabase Auth needs an identifier. For phone-only accounts we use a
  // private synthetic email that never sends mail and is never displayed as
  // the user's real email address by the UI.
  const authEmail = cleanEmail || phoneAlias(cleanPhone);

  const createResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      email: authEmail,
      password,
      email_confirm: true,
      user_metadata: {
        name: cleanName,
        phone: cleanPhone,
        city,
        role: authoritativeRole,
        requested_role: role,
        email_optional: !cleanEmail,
        ...(referralCode ? { referral_code: referralCode } : {})
      }
    })
  });

  const created = await readJson(createResponse);
  if (!createResponse.ok || !created?.id) {
    return res.status(createResponse.status || 400).json({
      error: created?.msg || created?.message || created?.error_description || "Could not create the account."
    });
  }

  const profileResponse = await fetch(`${supabaseUrl}/rest/v1/users`, {
    method: "POST",
    headers: {
      ...headers,
      Prefer: "resolution=ignore-duplicates,return=minimal"
    },
    body: JSON.stringify({
      id: created.id,
      name: cleanName,
      email: cleanEmail || null,
      phone: cleanPhone,
      city,
      role: authoritativeRole,
      role_selected: true,
      has_password: true
    })
  });

  if (!profileResponse.ok && profileResponse.status !== 409) {
    await fetch(`${supabaseUrl}/auth/v1/admin/users/${created.id}`, {
      method: "DELETE",
      headers
    }).catch(() => {});

    const detail = await profileResponse.text().catch(() => "");
    return res.status(500).json({ error: detail || "Could not create the account profile." });
  }

  // A referral code typed at sign-up is applied right away (the database trigger normally does it already;
  // this is the safety net and is harmless to repeat). The vendor who owns the code is credited immediately.
  let referral = null;
  if (referralCode) {
    try {
      const rr = await fetch(`${supabaseUrl}/rest/v1/rpc/apply_referral_internal`, {
        method: "POST",
        headers,
        body: JSON.stringify({ p_uid: created.id, p_code: referralCode, p_skip_customer: role === "vendor" })
      });
      referral = await readJson(rr);
    } catch (_) {}
  }

  return res.status(201).json({
    created: true,
    userId: created.id,
    loginEmail: authEmail,
    referral
  });
}

/* ============================================================
   DELETE ACCOUNT
   ============================================================ */
async function deleteAccount(body, res) {
  const accessToken = body?.accessToken;
  if (!accessToken) return res.status(400).json({ error: "accessToken is required." });

  const supabaseUrl = env("SUPABASE_URL");
  const anonKey = env("SUPABASE_ANON_KEY");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) return res.status(500).json({ error: "Supabase server configuration is incomplete." });

  const svcHeaders = serviceHeaders(serviceKey);
  const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` }
  });
  const me = await readJson(userResponse);
  if (!userResponse.ok || !me?.id) return res.status(401).json({ error: "Invalid or expired session. Please log in again." });

  const uid = me.id;

  const vendorResponse = await fetch(
    `${supabaseUrl}/rest/v1/vendors?user_id=eq.${encodeURIComponent(uid)}&select=id`,
    { headers: svcHeaders }
  );
  const vendorRows = vendorResponse.ok ? await readJson(vendorResponse) : [];
  const vendorIds = (Array.isArray(vendorRows) ? vendorRows : []).map(row => row.id).filter(Boolean);

  if (vendorIds.length) {
    const ids = vendorIds.join(",");
    const ordersResponse = await fetch(
      `${supabaseUrl}/rest/v1/orders?vendor_id=in.(${ids})&status=not.in.(completed,cancelled)&select=id,status`,
      { headers: svcHeaders }
    );
    const activeOrders = ordersResponse.ok ? await readJson(ordersResponse) : [];
    if (Array.isArray(activeOrders) && activeOrders.length) {
      return res.status(400).json({
        error: `You cannot delete your vendor account while ${activeOrders.length} order(s) are still active. Complete or cancel every active order first.`
      });
    }

    const commissionResponse = await fetch(
      `${supabaseUrl}/rest/v1/commission_charges?vendor_id=in.(${ids})&status=eq.owed&select=amount`,
      { headers: svcHeaders }
    );
    if (commissionResponse.ok) {
      const charges = await readJson(commissionResponse);
      const owed = (Array.isArray(charges) ? charges : []).reduce((sum, row) => sum + Number(row?.amount || 0), 0);
      if (owed > 0) {
        return res.status(400).json({
          error: `You have ₦${owed.toLocaleString()} in unsettled commission. Clear it before deleting your vendor account.`
        });
      }
    }
  }

  // Capture conversations before the SQL wipe so their storage attachments
  // can also be removed.
  let conversationIds = [];
  const conversationFilter = vendorIds.length
    ? `or=(buyer_id.eq.${uid},vendor_id.in.(${vendorIds.join(",")}))`
    : `buyer_id=eq.${uid}`;
  const conversationResponse = await fetch(
    `${supabaseUrl}/rest/v1/conversations?${conversationFilter}&select=id`,
    { headers: svcHeaders }
  );
  if (conversationResponse.ok) {
    const rows = await readJson(conversationResponse);
    conversationIds = (Array.isArray(rows) ? rows : []).map(row => row.id).filter(Boolean);
  }

  // The SQL function performs the FK-safe public-table deletion. It MUST
  // delete chat_usage before users; otherwise PostgreSQL rejects the wipe.
  // Called with the user's own token: delete_my_account() only deletes the caller's own
  // account (auth.uid() must equal p_user_id, or the caller is an admin), so with the
  // service key - which has no user - it always refused with "Not authorized".
  const deleteResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/delete_my_account`, {
    method: "POST",
    headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_user_id: uid })
  });
  const deleteBody = await readJson(deleteResponse);
  if (!deleteResponse.ok) {
    return res.status(500).json({
      error: deleteBody?.message || deleteBody?.hint || deleteBody?.details || "Account data could not be fully deleted. Run the updated delete_my_account SQL function in Supabase first."
    });
  }

  async function listStorage(bucket, prefix) {
    if (!prefix) return [];
    const response = await fetch(`${supabaseUrl}/storage/v1/object/list/${encodeURIComponent(bucket)}`, {
      method: "POST",
      headers: svcHeaders,
      body: JSON.stringify({ prefix, limit: 1000, offset: 0, sortBy: { column: "name", order: "asc" } })
    });
    if (!response.ok) return [];
    const rows = await readJson(response);
    return (Array.isArray(rows) ? rows : []).filter(row => row?.name && !String(row.name).endsWith("/"));
  }

  async function removeStorage(bucket, names) {
    if (!names.length) return;
    const response = await fetch(`${supabaseUrl}/storage/v1/object/remove`, {
      method: "POST",
      headers: svcHeaders,
      body: JSON.stringify(names.map(name => ({ bucket_id: bucket, name })))
    });
    if (!response.ok) throw new Error(`Could not delete files from ${bucket}.`);
  }

  const storageTargets = [
    ["avatars", [uid]],
    ["vendor-docs", [uid]],
    ["vendor-logos", vendorIds],
    ["product-photos", vendorIds],
    ["chat-attachments", conversationIds.map(id => `conv/${id}`)]
  ];

  for (const [bucket, prefixes] of storageTargets) {
    for (const prefix of prefixes) {
      const objects = await listStorage(bucket, prefix);
      await removeStorage(bucket, objects.map(object => object.name));
    }
  }

  // Hard-delete the Auth identity. Supabase documents that a normal admin
  // delete removes the auth.users row and cascades its sessions/refresh
  // tokens. Existing access JWTs cannot be retroactively changed, so the
  // frontend also validates the current user before treating a session as
  // logged in.
  const authDeleteResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users/${uid}`, {
    method: "DELETE",
    headers: svcHeaders
  });

  if (!authDeleteResponse.ok) {
    const detail = await authDeleteResponse.text().catch(() => "");
    return res.status(500).json({
      error: detail || "Marketplace data was deleted, but the authentication account could not be removed."
    });
  }

  return res.status(200).json({ deleted: true });
}


// ---- TURN servers for voice calls (GET /api/turn, rewritten to ?turn=1 in vercel.json) ----
// Lives here so the project stays within Vercel Hobby's 12-function limit.
const TURN_OPEN_RELAY = [
  { urls: ["stun:openrelay.metered.ca:80"] },
  { urls: ["turn:openrelay.metered.ca:80", "turn:openrelay.metered.ca:443", "turns:openrelay.metered.ca:443?transport=tcp"], username: "openrelayproject", credential: "openrelayproject" },
];
async function turnServers(req, res) {
  res.setHeader("Cache-Control", "private, max-age=600");
  // 1) Cloudflare Realtime TURN (CF_TURN_KEY_ID + CF_TURN_API_TOKEN), 2) Metered (METERED_API_KEY + METERED_DOMAIN),
  // 3) the shared open relay, which is a last resort and often does not relay at all.
  const cfId = process.env.CF_TURN_KEY_ID, cfToken = process.env.CF_TURN_API_TOKEN;
  if (cfId && cfToken) {
    try {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(cfId)}/credentials/generate-ice-servers`, {
        method: "POST", headers: { Authorization: `Bearer ${cfToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ ttl: 86400 }),
      });
      if (r.ok) {
        const j = await r.json();
        let list = Array.isArray(j?.iceServers) ? j.iceServers : (j?.iceServers ? [j.iceServers] : []);
        // keep the relay entries, drop port 53 (browsers block it)
        list = list.map((s) => ({ ...s, urls: [].concat(s.urls || []).filter((u) => !/:53(\?|$)/.test(u)) })).filter((s) => s.urls.length);
        if (list.length) { res.status(200).json({ iceServers: list, source: "cloudflare" }); return; }
      }
    } catch (_) {}
  }
  const key = process.env.METERED_API_KEY, domain = process.env.METERED_DOMAIN;
  if (key && domain) {
    try {
      const r = await fetch(`https://${domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(key)}`);
      if (r.ok) { const list = await r.json(); if (Array.isArray(list) && list.length) { res.status(200).json({ iceServers: list, source: "metered" }); return; } }
    } catch (_) {}
  }
  res.status(200).json({ iceServers: TURN_OPEN_RELAY, source: "open-relay (shared, unreliable)" });
}

// Push-notification picture (256x256): the person's / shop's photo or initials, or an event icon,
// with the small Levromart mark at the bottom-right. Rides on this function (12-function cap).
const NICON_KINDS = new Set(["admin", "follow", "heart", "message", "order", "payment", "review"]);
async function notifIcon(req, res) {
  try {
    const root = STATIC_ROOT, S = 256, B = 100;
    const u = String(req.query?.u || ""), name = String(req.query?.n || "").slice(0, 60), k = String(req.query?.k || "");
    let host = ""; try { const pu = new URL(u); if (pu.protocol === "https:") host = pu.hostname; } catch (_) {}
    const safeHost = host && !/^(localhost|\d+\.\d+\.\d+\.\d+|\[.*\])$/i.test(host) && !/\.(local|internal)$/i.test(host);
    let base = null;
    const buf = safeHost ? await ogGrab(u) : null;
    if (buf) { try { base = await ogCircle(buf, S); } catch (_) { base = null; } }
    if (!base && NICON_KINDS.has(k)) base = await ogCircle(fs.readFileSync(path.join(root, "notif-icons", k + ".png")), S);
    if (!base && name) {
      const F = ogFonts(), h = ogHue(name), ini = ogInitials(name), size = 112, w = ogWidth(F.bold, ini, size);
      const svg = `<svg width="${S}" height="${S}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h},70%,90%)"/><stop offset="1" stop-color="hsl(${h},60%,78%)"/></linearGradient></defs><circle cx="${S / 2}" cy="${S / 2}" r="${S / 2}" fill="url(#g)"/>${ogText(F.bold, ini, (S - w) / 2, S / 2 + size * 0.36, size, `hsl(${h},55%,28%)`)}</svg>`;
      base = await sharp(Buffer.from(svg)).png().toBuffer();
    }
    let out;
    if (!base) {
      out = await sharp(path.join(root, "icon-512.png")).resize(S, S).png().toBuffer();
    } else {
      const ring = B + 12;
      const logo = await ogCircle(fs.readFileSync(path.join(root, "icon-512.png")), B);
      const disc = Buffer.from(`<svg width="${ring}" height="${ring}"><circle cx="${ring / 2}" cy="${ring / 2}" r="${ring / 2}" fill="#fff"/></svg>`);
      out = await sharp(base).composite([
        { input: disc, left: S - ring, top: S - ring },
        { input: logo, left: S - ring + 6, top: S - ring + 6 },
      ]).png().toBuffer();
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=604800, immutable");
    return res.status(200).send(out);
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.redirect(302, "/levromart-notification-icon.png");
  }
}

module.exports = async function handler(req, res) {
  if (req.method === "GET" && /(?:^|[?&])turn=1(?:&|$)/.test(String(req.url || ""))) return turnServers(req, res);
  if (req.method === "GET" && /(?:^|[?&])nicon=1(?:&|$)/.test(String(req.url || ""))) return notifIcon(req, res);
  if (req.method === "GET" && /(?:^|[?&])og(?:store|prod|pkg)=/.test(String(req.url || ""))) return ogCard(req, res);
  if (req.method === "GET") return shareMetaPreview(req, res);
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });

  try {
    const rawBody = await readBody(req);
    const body = typeof rawBody === "string" ? JSON.parse(rawBody || "{}") : (rawBody || {});
    const action = String(body.action || "").toLowerCase();

    if (action === "account-exists" || action === "check-email") return accountExists(body, res);
    if (action === "register") return registerAccount(body, res);
    return deleteAccount(body, res);
  } catch (error) {
    console.error("Levromart account API error:", error);
    return res.status(500).json({ error: error?.message || "Could not complete the account request." });
  }
};
