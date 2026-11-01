// ---------- REQUEST EQUIPMENT (buyers post needs, vendors compete) ----------
// ---------- Colourful illustrated icons (flat, soft gradients) used on Home quick actions and empty states ----------
window.lvIllus = function (kind, px) {
  const g = (id, a, b) => `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`;
  const S = {
    bag: g("lia", "#ffb12e", "#ff5d73") + "</defs><path d='M17 17a7 7 0 0 1 14 0' fill='none' stroke='#b4234a' stroke-width='3' stroke-linecap='round'/><path d='M9 17h30l2.5 24a3 3 0 0 1-3 3.3H9.5a3 3 0 0 1-3-3.3z' fill='url(#lia)'/><path d='M9 17h30l.6 6H8.4z' fill='#fff' opacity='.25'/><path d='M18 30q6 6 12 0' fill='none' stroke='#fff' stroke-width='3' stroke-linecap='round'/><defs>",
    tools: g("lib", "#4f9bff", "#2f5fe0") + "</defs><path d='M10 38 30 18' stroke='#9aa7bd' stroke-width='6' stroke-linecap='round'/><path d='M33 8a8 8 0 0 0-8 10l-1 1 5 5 1-1a8 8 0 0 0 10-8l-5 3-4-4z' fill='url(#lib)'/><path d='M38 38 22 22' stroke='#ff8a3d' stroke-width='6' stroke-linecap='round'/><circle cx='38' cy='38' r='4' fill='#ffc83d'/><defs>",
    key: g("lic", "#ffe27a", "#ff9a3d") + "</defs><circle cx='17' cy='20' r='11' fill='url(#lic)'/><circle cx='14' cy='17' r='3.6' fill='#fff' opacity='.9'/><path d='M25 27 41 43M33 35l5-5M38 40l4-4' stroke='#e08a1e' stroke-width='5' stroke-linecap='round'/><defs>",
    store: g("lid", "#ff6aa8", "#c2379f") + "</defs><rect x='8' y='22' width='32' height='20' rx='3' fill='#fff'/><path d='M6 22 9 9h30l3 13z' fill='url(#lid)'/><path d='M14 9l-2 13M24 9v13M34 9l2 13' stroke='#fff' stroke-width='2.4' opacity='.7'/><rect x='19' y='29' width='10' height='13' rx='2' fill='#6a3df0'/><defs>",
    hand: g("lie", "#ffe27a", "#ffb12e") + "</defs><path d='M16 24V12a3 3 0 0 1 6 0v10m0-12a3 3 0 0 1 6 0v12m0-9a3 3 0 0 1 6 0v14c0 9-5 15-13 15-6 0-9-3-12-8l-4-7a3 3 0 0 1 5-3l4 5z' fill='url(#lie)' stroke='#e08a1e' stroke-width='1.6' stroke-linejoin='round'/><defs>",
    chat: g("lif", "#4f9bff", "#6a3df0") + "</defs><path d='M8 12a6 6 0 0 1 6-6h20a6 6 0 0 1 6 6v14a6 6 0 0 1-6 6H22l-9 8v-8h-1a6 6 0 0 1-4-6z' fill='url(#lif)'/><circle cx='16' cy='19' r='2.6' fill='#fff'/><circle cx='24' cy='19' r='2.6' fill='#fff'/><circle cx='32' cy='19' r='2.6' fill='#fff'/><defs>",
    box: g("lig", "#ffc58a", "#e08a3d") + "</defs><path d='M6 16 24 8l18 8v18L24 42 6 34z' fill='url(#lig)'/><path d='M6 16l18 8 18-8M24 24v18' fill='none' stroke='#fff' stroke-width='2.4' opacity='.7'/><path d='M24 24 42 16l-4-3-18 8z' fill='#fff' opacity='.25'/><path d='M36 4l1.2 3 3 1.2-3 1.2L36 12.4l-1.2-3-3-1.2 3-1.2z' fill='#ffd21f'/><defs>",
    cart: g("lih", "#19c486", "#0b6b47") + "</defs><path d='M4 7h6l5 24h22l4-17H13' fill='none' stroke='url(#lih)' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'/><circle cx='19' cy='39' r='3.6' fill='#ffc83d'/><circle cx='34' cy='39' r='3.6' fill='#ffc83d'/><defs>",
    search: g("lii", "#6a3df0", "#4f9bff") + "</defs><circle cx='21' cy='21' r='13' fill='#fff' stroke='url(#lii)' stroke-width='5'/><path d='M31 31l12 12' stroke='#ff9a3d' stroke-width='6' stroke-linecap='round'/><path d='M15 17q3-5 8-3' fill='none' stroke='#9fd0ff' stroke-width='2.4' stroke-linecap='round'/><defs>",
  };
  const body = S[kind] || S.box, size = px || 40;
  return `<svg viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true" class="lv-illus"><defs>${body}</defs></svg>`.replace("<defs></defs>", "");
};
// ---------- Friendly page header (Request an item, Vendors): brand card, one person, floating icons ----------
window.lvPageHero = function (kind) {
  const C = {
    request: { img: "/lb/person-a.webp", t: "Can't find it?", em: "Request it.", p: "Post what you need and nearby vendors send you offers.", icons: ["fa-hand", "fa-box-open", "fa-tag"] },
    orders: { img: "/lb/person-f.webp", t: "Your orders,", em: "all in one place.", p: "Track every order from payment to delivery.", icons: ["fa-receipt", "fa-truck-fast", "fa-bag-shopping"] },
    cart: { img: "/lb/person-c.webp", t: "Your cart is", em: "ready when you are.", p: "Add items and check out in a few taps.", icons: ["fa-cart-shopping", "fa-bag-shopping", "fa-tag"] },
    search: { img: "/lb/person-d.webp", t: "Find it", em: "fast.", p: "Products, services and vendors on your campus.", icons: ["fa-magnifying-glass", "fa-tag", "fa-store"] },
    vendors: { img: "/lb/person-e.webp", t: "Meet your", em: "campus vendors.", p: "Shops, services and rentals near you, all in one place.", icons: ["fa-store", "fa-bag-shopping", "fa-star"] },
  }[kind];
  if (!C) return "";
  setTimeout(() => lvFloatHero(), 350); setTimeout(() => lvFloatHero(), 1200);
  return `<section class="lv-hero2 lv-hero2-${kind}" aria-hidden="true">
    <div class="lv-hero2-copy"><b>${C.t}</b><b class="em">${C.em}</b><span>${C.p}</span></div>
    <i class="lv-fl lv-fl1 fa-solid ${C.icons[0]}"></i><i class="lv-fl lv-fl2 fa-solid ${C.icons[1]}"></i><i class="lv-fl lv-fl3 fa-solid ${C.icons[2]}"></i>
    <img class="lv-fl lv-hero2-img" src="${C.img}" alt="" width="96" height="96" decoding="async">
  </section>`;
};
// Second Home strip, between Trending and Featured Vendors: sell + rent
window.lvHomeBand2 = function () {
  return ""; // Open-your-shop / Rent-from-vendors strip removed: the action buttons cover both
  setTimeout(() => lvFloatHero(), 450); setTimeout(() => lvFloatHero(), 1400);
  return `<section class="lv-band lv-band2" aria-label="Sell or rent on Levromart">
    <button type="button" class="lv-band-card lv-band-d" onclick="navigate('vendorApply')"><span class="lv-band-t"><b>Open your shop</b></span><img class="lv-fl" src="/lb/person-c.webp" alt="" width="64" height="64" loading="lazy" decoding="async"><i class="lv-fl lv-bfl fa-solid fa-store"></i></button>
    <button type="button" class="lv-band-card lv-band-e" onclick="navigate('vendors')"><span class="lv-band-t"><b>Rent from vendors</b></span><img class="lv-fl" src="/lb/person-d.webp" alt="" width="64" height="64" loading="lazy" decoding="async"><i class="lv-fl lv-bfl fa-solid fa-key"></i></button>
  </section>`;
};
// Third Home strip, between Trending products and Trending services: a slow carousel of calls to action
window.lvHomeBand3 = function () {
  setTimeout(() => lvFloatHero(), 500); setTimeout(() => lvFloatHero(), 1500); setTimeout(() => lvBand3Start(), 300); setTimeout(() => lvBand3Winner(), 400);
  const req = session ? "navigate('requestEquipment')" : "requireLoginThen('requestEquipment')";
  const slide = (cls, onclick, title, sub, cta, icon) => `<div class="lv-b3-slide ${cls}" role="link" tabindex="0" onclick="${onclick}"><div class="lv-b3-copy"><b>${title}</b><span>${sub}</span><em>${cta} <i class="fa-solid fa-arrow-right"></i></em></div><i class="lv-fl lv-b3-bigic fa-solid ${icon}"></i></div>`;
  return `<section class="lv-band3" id="lvBand3" aria-roledescription="carousel" aria-label="More on Levromart"><div class="lv-b3-track">${
    slide("s1", "navigate('vendors')", "Shop from your campus", "Follow your favourite vendors and never miss a drop.", "See vendors", "fa-bag-shopping") +
    slide("s2", req, "Can't find it?", "Tell vendors what you need and let them come to you.", "Request it", "fa-hand") +
    slide("s3", "navigate('leaderboard')", "Who's winning?", "See the top vendors on campus right now.", "Vendor leaderboard", "fa-award").replace('<i class="lv-fl lv-b3-bigic fa-solid fa-award"></i>', '<span class="lv-fl lv-b3-bigic lv-b3-logo" id="lvB3Logo" aria-hidden="true"></span><i class="lv-fl lv-b3-bigic lv-b3-trophy fa-solid fa-award"></i>') +
    slide("s4", "navigate('leaderboard')", "Follow us", "Instagram and TikTok: @levromart. Tap to find us.", "Follow us", "fa-heart").replace("navigate('leaderboard')", "window.open('https://instagram.com/levromart','_blank','noopener')") +
    slide("s5", "window.open('https://chat.whatsapp.com/DVCSNKkZ6AIHtKYyMPWxHs','_blank','noopener')", "Join the family", "Our WhatsApp community: deals, tips and campus news.", "Join the group", "fa-whatsapp").replace("fa-solid fa-whatsapp", "fa-brands fa-whatsapp")
  }</div><div class="lv-b3-dots" aria-hidden="true"><i class="on"></i><i></i><i></i><i></i><i></i></div></section>`;
};
// The strip scrolls sideways by touch (scroll-snap) and also moves to the next slide every 4 seconds on its own.
// Touching it pauses the automatic movement for a while; it stops when the strip leaves the page.
window.lvBand3Start = function () {
  const el = document.getElementById("lvBand3");
  if (!el || el.dataset.run) return;
  el.dataset.run = "1";
  const track = el.querySelector(".lv-b3-track"), dots = el.querySelectorAll(".lv-b3-dots i");
  const slideW = () => track.clientWidth || 1;
  const current = () => Math.round(track.scrollLeft / slideW());
  const mark = () => { const i = current(); dots.forEach((d, k) => d.classList.toggle("on", k === i)); };
  track.addEventListener("scroll", () => { requestAnimationFrame(mark); }, { passive: true });
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  let pausedUntil = 0;
  const pause = () => { pausedUntil = Date.now() + 8000; };
  ["touchstart", "pointerdown", "wheel"].forEach((t) => track.addEventListener(t, pause, { passive: true }));
  const timer = setInterval(() => {
    if (!document.body.contains(el)) return clearInterval(timer);
    if (document.hidden || Date.now() < pausedUntil) return;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) return;
    const next = (current() + 1) % dots.length;
    track.scrollTo({ left: next * slideW(), behavior: "smooth" });
  }, 4000);
};
// "Who's winning?" slide: the winning vendor's logo (their initials without one), like the strip further down the page
window.lvBand3Winner = async function () {
  try {
    const slot = document.getElementById("lvB3Logo");
    if (!slot || typeof window.lvVendorSpot !== "function") return;
    const spot = await window.lvVendorSpot();
    const w = (spot && spot.leaders && spot.leaders[0]) || (spot && spot.winner);
    if (!w || !w.business_name) return;
    slot.innerHTML = profileAvatarHtml(w.logo_url, w.business_name, "100%", { extraClass: "lv-band-logo-img" });
    slot.classList.add("on");
    // fixed circle, whatever the stylesheet says: the logo must never grow over the whole slide
    [["width", "4.2rem"], ["height", "4.2rem"], ["max-width", "4.2rem"], ["border-radius", "50%"], ["overflow", "hidden"]].forEach(([k, v]) => slot.style.setProperty(k, v, "important"));
    slot.setAttribute("title", w.business_name);
    slot.parentNode.querySelector(".lv-b3-trophy")?.classList.add("hidden");
  } catch (_) {}
};
// Lively strip on Home between Featured Vendors and Browse everything: three tappable cards
window.lvHomeBand = function () {
  setTimeout(() => lvFloatHero(), 400); setTimeout(() => lvFloatHero(), 1300);
  setTimeout(() => lvBandWinner(), 200);
  const req = session ? "navigate('requestEquipment')" : "requireLoginThen('requestEquipment')";
  return `<section class="lv-band" aria-label="More on Levromart">
    <a class="lv-band-card lv-band-c" href="https://chat.whatsapp.com/DVCSNKkZ6AIHtKYyMPWxHs" target="_blank" rel="noopener"><span class="lv-band-t">Join the family<b>WhatsApp community</b></span><span class="lv-fl lv-band-wa-logo" aria-hidden="true"><img src="/icon-192.png" alt="" width="56" height="56" loading="lazy" decoding="async"><i class="fa-brands fa-whatsapp"></i></span></a>
    <button type="button" class="lv-band-card lv-band-b" data-lbw onclick="navigate('leaderboard')"><span class="lv-band-t">Who's winning?<b>Vendor leaderboard</b></span><span class="lv-fl lv-band-logo" aria-hidden="true"></span><i class="lv-fl lv-bfl fa-solid fa-award"></i></button>
  </section>`;
};
// The "Who's winning?" card shows the logo of the vendor who is winning right now (their initials when they have no logo).
window.lvBandWinner = async function () {
  try {
    const btn = document.querySelector(".lv-band-b[data-lbw]:not([data-lbw-done])");
    const slot = btn && btn.querySelector(".lv-band-logo");
    if (!slot || typeof window.lvVendorSpot !== "function") return;
    const spot = await window.lvVendorSpot();
    const w = (spot && spot.leaders && spot.leaders[0]) || (spot && spot.winner);
    if (!w || !w.business_name) return;
    btn.setAttribute("data-lbw-done", "1");
    slot.innerHTML = profileAvatarHtml(w.logo_url, w.business_name, "100%", { extraClass: "lv-band-logo-img" });
    slot.classList.add("on");
    slot.setAttribute("title", w.business_name);
  } catch (_) {}
};
window.lvFloatHero = function () {
  try {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    document.querySelectorAll(".lv-hero2 .lv-hero2-img:not([data-fl])").forEach((el, i) => {
      el.setAttribute("data-fl", "1");
      const dy = 4 + (i % 3) * 2, r = (i % 2 ? -1 : 1) * (2 + i);
      el.animate([{ transform: "translateY(0) rotate(0deg)" }, { transform: `translateY(-${dy}px) rotate(${r}deg)` }, { transform: "translateY(0) rotate(0deg)" }], { duration: 2600 + i * 380, delay: i * 250, iterations: Infinity, easing: "ease-in-out" });
    });
  } catch (_) {}
};
async function renderRequestEquipment() {
  if (!session) return '<div class="empty-state">Please log in to request an item.</div>';
  const [{ data: myRequests, error: myRequestsError }] = await Promise.all([
    withRouteTimeout(sb.from("equipment_requests").select("*, offers:request_offers(id, vendor_id, message, price, status, created_at, vendor:vendors(business_name, avg_rating, phone, whatsapp_number, delivery_fee))")
      .eq("buyer_id", session.user.id).order("created_at", { ascending: false }), 7000, { data: null, error: new Error("Your requests are taking too long to load.") }),
    (async () => { if (!sectors.length) { const { data } = await levroData.catalogue.sectors("sort_order"); sectors = data || []; } })(),
    (async () => { if (!window.__categories?.length) { const { data } = await levroData.catalogue.categories(); window.__categories = data || []; } })(),
  ]);

  window.__myEquipmentRequestCount = (myRequests || []).filter((r) => r.status !== "cancelled").length;
  let html = `${lvPageHero("request")}<div class="rq-head"><div class="rq-title"><span class="rq-ic"><svg viewBox='0 0 24 24' width='26' height='26' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'><path d='M12 22V12'/><path d='M20.27 18.27 22 20'/><path d='M21 10.498V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.729l7 4a2 2 0 0 0 2 .001l.98-.559'/><path d='M3.29 7 12 12l8.71-5'/><path d='m7.5 4.27 8.997 5.148'/><circle cx='18.5' cy='16.5' r='2.5'/></svg></span><div><h2>Request an item</h2><p>Tell vendors what you need. They come to you with offers.</p></div></div><button type="button" class="rq-mine" onclick="navigate('myEquipmentRequests')" aria-label="Your requests" title="Your requests">${(window.__myEquipmentRequestCount || 0) > 0 ? `<b class="rq-count">${window.__myEquipmentRequestCount > 9 ? "9+" : window.__myEquipmentRequestCount}</b>` : ""}<i class="fa-solid fa-list-check"></i></button></div>
    <div class="card request-equipment-page rq-form" style="max-width:520px;">
      <div id="reqError" class="error-text hidden"></div>
      <label>What do you need? *</label><input id="reqTitle" placeholder="e.g. Oxygen concentrator, jollof rice for 20…" />
      <label>I want to</label>
      <div class="flex">
        <label class="theme-option" style="flex:1;padding:0.7rem;border:1px solid var(--border);border-radius:0.5rem;margin:0.3rem 0;"><input type="radio" name="reqType" value="buy" checked onchange="updateRequestFormFields()" style="width:auto;margin:0 0.5rem 0 0;" />Buy</label>
        <label class="theme-option" style="flex:1;padding:0.7rem;border:1px solid var(--border);border-radius:0.5rem;margin:0.3rem 0;"><input type="radio" name="reqType" value="rent" onchange="updateRequestFormFields()" style="width:auto;margin:0 0.5rem 0 0;" />Rent</label>
      </div>
      <label>More details</label><textarea id="reqDesc" rows="2" placeholder="Duration, specs, delivery preferences…"></textarea>
      <label>Photos <span class="muted" style="font-weight:500">(optional)</span></label>
      <div id="reqPhotoBox" class="req-photos empty"><button type="button" class="req-drop" onclick="document.getElementById('reqPhotoInput').click()"><span class="rd-ico"><i class="fa-solid fa-cloud-arrow-up"></i></span><b>Add photos</b><small>Up to 4 · helps vendors send the right offer</small></button></div>
      <input id="reqPhotoInput" type="file" accept="image/*" multiple class="hidden" onchange="reqPhotosPicked(event)" />
      <div class="flex">
        <div style="flex:1;"><label>Sector</label><button type="button" class="req-sector-picker" id="reqSectorPicker" onclick="openRequestSectorPicker(event)" aria-haspopup="dialog" aria-expanded="false"><span id="reqSectorLabel">Any</span><i class="fa-solid fa-chevron-down"></i></button><input type="hidden" id="reqSector" value=""></div>
        <div style="flex:1;"><label>Category *</label><div class="req-category-picker-wrap"><button type="button" class="req-category-picker" id="reqCategoryPicker" onclick="openRequestCategoryPicker(event)" aria-haspopup="dialog" aria-expanded="false"><span id="reqCategoryLabel">Choose one…</span><i class="fa-solid fa-chevron-down"></i></button><input type="hidden" id="reqCategory" value=""></div></div>
      </div>
      <div class="flex">
        <div style="flex:1;"><label>City</label><input id="reqCity" value="Lagos" /></div>
      </div>
      <div id="reqDatesWrap">
        <label>Needed from</label><input type="date" id="reqFrom" style="width:100%;" />
        <label>Needed to</label><input type="date" id="reqTo" style="width:100%;" />
      </div>
      <button type="button" class="btn" id="postEquipmentRequestBtn" style="margin-top:0.6rem;" aria-label="Post request">Post request</button>
    </div>
  setTimeout(updateRequestFormFields, 0);
  window.__reqPhotos = [];
  window.__reqDraftPhotos = [];
  setTimeout(() => { reqPhotosPaint(); reqDraftRestore(); }, 0);
  return html;
}

  setTimeout(updateRequestFormFields, 0);
  window.__reqPhotos = [];
  window.__reqDraftPhotos = [];
  setTimeout(() => { reqPhotosPaint(); reqDraftRestore(); }, 0);
  return html;
}


async function renderMyEquipmentRequests() {
  if (!session) return '<div class="empty-state">Please log in to view your requests.</div>';
  const { data: myRequests, error: myRequestsError } = await withRouteTimeout(
    sb.from("equipment_requests").select("*, offers:request_offers(id, vendor_id, message, price, status, created_at, vendor:vendors(business_name, avg_rating, phone, whatsapp_number, delivery_fee))")
      .eq("buyer_id", session.user.id).order("created_at", { ascending: false }),
    7000, { data: null, error: new Error("Your requests are taking too long to load.") }
  );
  let html = `<div class="rq-head"><div class="rq-title"><div><h2>Your requests</h2><p>Track your requests and compare vendor offers.</p></div></div><button class="btn btn-sm btn-outline" onclick="navigate('requestEquipment')"><i class="fa-solid fa-plus"></i> Post request</button></div>`;
  if (myRequestsError) html += `<p class="muted">Your request history could not be loaded right now.</p>`;
  else if (!myRequests || myRequests.length === 0) html += `<div class="empty-state">You haven't posted any requests yet.</div>`;
  (myRequests || []).filter((r) => r.status !== "cancelled").forEach((r) => {
    // an offer a shop declined or withdrew disappears from this page
    const offers = (r.offers || []).filter((o) => !["declined", "rejected", "withdrawn"].includes(String(o.status)));
    html += `<div class="card">
      <div class="flex" style="justify-content:space-between;"><strong>${esc(r.title)}</strong><div class="flex"><span class="badge">${r.request_type === "buy" ? "Buy" : "Rent"}</span><span class="badge ${r.status === "fulfilled" ? "success" : r.status === "cancelled" ? "danger" : ""}">${esc(r.status)}</span></div></div>
      ${r.status === "open" ? `<button class="btn btn-sm btn-outline" style="margin-top:0.4rem;" onclick="cancelEquipmentRequest('${r.id}')"><i class="fa-solid fa-ban"></i> Cancel request</button>` : ""}
      ${r.description ? `<p class="muted" style="margin:0.3rem 0;">${esc(r.description)}</p>` : ""}
      ${reqPhotosHtml(r.photos)}
      <p class="muted" style="font-size:0.8rem;">${[r.city, r.request_type !== "buy" && r.needed_from ? r.needed_from + " → " + (r.needed_to || "") : ""].filter(Boolean).map(esc).join(" · ")}</p>
      ${offers.length ? `<div style="margin-top:0.6rem;"><strong style="font-size:0.85rem;">${offers.length} offer${offers.length === 1 ? "" : "s"}:</strong>
        ${offers.map((o) => {
          const delivery = Number(o.vendor?.delivery_fee) || 0;
          return `<div style="border-top:1px solid var(--border);padding:0.5rem 0;">
          <div class="flex" style="justify-content:space-between;">
            <div><strong>${esc(o.vendor?.business_name || "")}</strong>${o.vendor?.avg_rating != null ? ` · ★${Number(o.vendor.avg_rating).toFixed(1)}` : ""}<p class="muted" style="margin:0;">${esc(o.message || "")}</p></div>
            <div class="flex">
              ${o.price != null ? `<strong>${naira(o.price)}</strong>` : ""}
              <span class="badge ${o.status === "accepted" ? "success" : o.status === "declined" ? "danger" : ""}">${esc(o.status)}</span>
              ${r.status === "open" && o.status === "pending" ? `<button class="btn btn-sm" onclick="acceptOffer('${o.id}')">Accept</button><button class="btn btn-sm btn-danger" onclick="declineOffer('${o.id}')">Decline</button>` : ""}
            </div>
          </div>
          ${o.price != null ? `<p class="muted" style="font-size:0.78rem;margin:0.3rem 0 0;">Quoted total: ${naira(o.price)}${o.status === "accepted" ? " · Delivery details are handled from the listing/request." : ""}</p>` : ""}
        </div>`;
        }).join("")}
      </div>` : `<p class="muted" style="margin-top:0.5rem;">No offers yet.</p>`}
    </div>`;
  });

  return html;
}


async function renderVendorRequests() {
  // On a hard refresh Safari can restore the Supabase session slightly after
  // the route is resumed. Resolve auth/vendor state here before enforcing the
  // vendor guard, otherwise a valid vendor briefly gets an "Access denied" page.
  if (!session || !profile) {
    try { await refreshAuthState(); } catch (_) {}
  }
  if (!session || profile?.role === "admin" || (profile?.role !== "vendor" && !vendor)) return '<div class="empty-state">Access denied.</div>';
  if (!vendor?.id) {
    const { data: currentVendor } = await sb.from("vendors").select("*").eq("user_id", session.user.id).is("deleted_at", null).maybeSingle();
    if (currentVendor) vendor = currentVendor;
  }
  if (!vendor?.id) return '<div class="empty-state">Your vendor profile is not available yet.</div>';

  let [{ data: requests, error: requestsError }, { data: myProducts }, { data: myRequests }] = await Promise.all([
    sb.from("equipment_requests").select("*, offers:request_offers(id, vendor_id, status)").eq("status", "open").order("created_at", { ascending: false }),
    sb.from("products").select("id, name, category_id, sale_price, rental_rate, rental_rate_unit").eq("vendor_id", vendor.id).eq("status", "active"),
    sb.from("equipment_requests").select("*, offers:request_offers(id, vendor_id, message, price, status, created_at, vendor:vendors(business_name, avg_rating, phone, whatsapp_number, delivery_fee))").eq("buyer_id", session.user.id).order("created_at", { ascending: false }),
  ]);
  // Vendor's own choice of which customer requests to see: all / only their sector / none.
  let reqPref = vendor.request_pref || "all";
  let allowedRequests = requests || [];
  if (reqPref === "none") allowedRequests = [];
  else if (reqPref === "sector") {
    let cats = window.__categories;
    if (!cats?.length) { const { data } = await levroData.catalogue.categories(); cats = window.__categories = data || []; }
    const sectorOf = new Map(cats.map((c) => [String(c.id), String(c.sector_id || "")]));
    allowedRequests = allowedRequests.filter((r) => r.category_id && vendor.sector_id && sectorOf.get(String(r.category_id)) === String(vendor.sector_id));
  }
  const campusScope = vendor.request_campus_scope || "all";
  if (campusScope !== "all") {
    const okIds = [vendor.campus_id, ...(campusScope === "selected" ? (vendor.operating_campuses || []) : [])].filter(Boolean);
    allowedRequests = allowedRequests.filter((r) => r.campus_id && okIds.includes(r.campus_id));
  }
  requests = allowedRequests;
  window.__myProductsForOffers = myProducts || [];
  window.__vendorCustomerRequests = requests || [];
  window.__vendorMyRequests = myRequests || [];

  // A vendor can dismiss requests locally. Use the filtered list for both the
  // visible cards and the tab badge so the count always matches what is shown.
  const hiddenInterestKey = `levromart-vendor-hidden-requests-${vendor.id}`;
  let hidden = [];
  try { hidden = JSON.parse(localStorage.getItem(hiddenInterestKey) || "[]"); } catch (_) { hidden = []; }
  const visibleRequests = (requests || []).filter((r) => !hidden.includes(String(r.id)));

  const deliveryFee = Number(vendor.delivery_fee) || 0;
  let html = `<div class="vendor-requests-page">
    <div class="vendor-requests-heading-row vr-page-head">
      <div><h2><i class='fa-solid fa-hand'></i> Requests ${infoPopoverHtml("vendorRequestsInfo", "As a vendor, you can respond to customer requests. You can also request products or services yourself, vendors are customers too.")}</h2></div>
      <button class="btn btn-sm vr-cta" type="button" onclick="navigate('requestEquipment')"><i class="fa-solid fa-plus"></i> Post request</button>
    </div>
    <div class="vendor-request-tabs vr-tabs" role="tablist" aria-label="Requests">
      <button type="button" class="vendor-request-tab active" data-request-tab="customers" onclick="switchVendorRequestTab('customers')"><i class="fa-solid fa-users"></i> Customer requests${visibleRequests.length ? ` <span data-request-customer-count>${visibleRequests.length}</span>` : ""}</button>
      <button type="button" class="vendor-request-tab" data-request-tab="mine" onclick="switchVendorRequestTab('mine')"><i class="fa-solid fa-list-check"></i> My requests${myRequests?.length ? ` <span>${myRequests.length}</span>` : ""}</button>
    </div>
    <section id="vendorCustomerRequestsTab" class="vendor-request-tab-panel">
      <details class="vr-pref vr-pref2"><summary><span class="vr-pref-now"><i class="fa-solid fa-sliders"></i> ${reqPref === "all" ? "All requests" : reqPref === "sector" ? "My sector" : "Requests off"} · ${campusScope === "mine" ? "My campus" : campusScope === "selected" ? "Selected campuses" : "All campuses"}</span><span class="vr-pref-edit">Change</span></summary>
        <span class="vr-pref-label"><i class="fa-solid fa-sliders"></i> Requests I receive</span>
        <div class="vr-pref-seg">
          ${[["all", "All"], ["sector", "My sector"], ["none", "Off"]].map(([k, l]) => `<button type="button" class="${reqPref === k ? "on" : ""}" onclick="setVendorRequestPref('${k}')">${l}</button>`).join("")}
        </div>
        <span class="vr-pref-label"><i class="fa-solid fa-location-dot"></i> From which campuses</span>
        <div class="vr-pref-seg">
          ${[["mine", "My campus"], ["selected", "Selected"], ["all", "All campuses"]].map(([k, l]) => `<button type="button" class="${campusScope === k ? "on" : ""}" onclick="setVendorRequestCampus('${k}')">${l}</button>`).join("")}
        </div>
        <small class="muted">${reqPref === "all" ? "You'll see customer requests and get alerts for ones that match what you sell." : reqPref === "sector" ? "You'll only see and get alerts for requests in your own sector." : "Customer requests are hidden and you won't get alerts. You can still post your own."}</small>
      </details>`;
  if (requestsError) html += `<div class="banner banner-danger">Could not load customer requests right now. Please try again.</div>`;
  else if (reqPref === "none") html += `<div class="empty-state">You've turned customer requests off.<br><button type="button" class="btn btn-sm" style="margin-top:.7rem;" onclick="setVendorRequestPref('all')">Turn requests back on</button></div>`;
  else if (!visibleRequests.length) html += `<div class="empty-state">${reqPref === "sector" ? "No requests in your sector right now." : "No customer requests to show right now."}</div>`;

  const requestRender = (r) => {
    const mine = (r.offers || []).find((o) => o.vendor_id === vendor.id);
    const matches = (myProducts || []).filter((p) => !r.category_id || p.category_id === r.category_id);
    const interestKey = `levromart-vendor-interest-${vendor.id}-${r.id}`;
    let interest = "";
    try { interest = localStorage.getItem(interestKey) || ""; } catch (_) {}
    const offerComposer = (showCancel = true) => `<div class="vendor-offer-compose" id="vendorOfferCompose-${r.id}">
      <div class="vendor-offer-compose-title"><i class="fa-solid fa-paper-plane"></i><strong>Make an offer</strong><span class="muted">Enter your price and add an optional message to the customer.</span></div>
      ${matches.length ? `<select id="offerProduct-${r.id}" onchange="applyOfferProductPrice('${r.id}','${r.request_type}')">
        <option value="">Quote a custom price…</option>
        ${matches.map((p) => `<option value="${p.id}">Use my "${esc(p.name)}": ${p.sale_price != null ? naira(p.sale_price) : ""}${p.sale_price != null && p.rental_rate != null ? " / " : ""}${p.rental_rate != null ? naira(p.rental_rate) + "/" + p.rental_rate_unit : ""}</option>`).join("")}
      </select>` : ""}
      <div class="vendor-offer-fields">
        <input type="number" id="offerPrice-${r.id}" placeholder="Price (₦)" inputmode="decimal" min="0" step="0.01" />
        <textarea id="offerMsg-${r.id}" rows="3" placeholder="Message to the customer (e.g. availability, delivery time, or other details)…"></textarea>
      </div>
      <div class="vendor-offer-actions">
        <button class="btn vendor-send-offer-btn" type="button" onclick="sendOffer('${r.id}')"><i class="fa-solid fa-paper-plane"></i> Send offer</button>
        ${showCancel ? `<button class="btn btn-sm btn-outline" type="button" onclick="setVendorRequestInterest('${r.id}','cancel-interest')">Cancel</button>` : ""}
      </div>
      ${deliveryFee > 0 ? `<p class="muted vendor-offer-note"><i class="fa-solid fa-circle-info"></i> Your ${naira(deliveryFee)} delivery fee is shown to the customer automatically when delivery is needed.</p>` : ""}
    </div>`;

    const vrAgo = (d) => { const m = Math.max(0, (Date.now() - new Date(d).getTime()) / 60000); if (m < 1) return "just now"; if (m < 60) { const n = Math.floor(m); return `${n} minute${n === 1 ? "" : "s"} ago`; } if (m < 1440) { const n = Math.floor(m / 60); return `${n} hour${n === 1 ? "" : "s"} ago`; } const n = Math.floor(m / 1440); return `${n} day${n === 1 ? "" : "s"} ago`; };
    const vrAvatar = r.buyer_avatar_url ? `<img src="${esc(r.buyer_avatar_url)}" class="avatar-circle vr-avatar" alt="" />` : avatarFallbackHtml(r.buyer_name || "Customer", "2.9rem", "vr-avatar", r.buyer_name || "Customer");
    const vrOpen = interest === "interested" && !mine;
    html += `<article class="vr-item vendor-request-card-item ${vrOpen ? "vr-expanded" : ""}" id="vendorRequestCard-${r.id}">
      <button type="button" class="vr-head" aria-expanded="${vrOpen ? "true" : "false"}" onclick="toggleVendorRequestCard('${r.id}')">
        ${vrAvatar}
        <span class="vr-main">
          <strong class="vr-title">${esc(r.title)}</strong>
          ${r.description ? `<span class="vr-desc">${esc(r.description)}</span>` : ""}
          <span class="vr-meta"><span><i class="fa-regular fa-clock"></i> ${esc(vrAgo(r.created_at))}</span><span><i class="fa-solid fa-location-dot"></i> ${esc((r.campus_id && typeof window.lvCampusShort === "function" && window.lvCampusShort(r.campus_id)) || r.city || "Lagos")}</span></span>
        </span>
        <span class="vr-side"><span class="vr-status ${mine ? "vr-prog" : "vr-open"}">${mine ? "In progress" : "Open"}</span><i class="fa-solid fa-chevron-right vr-chev"></i></span>
      </button>
      <div class="vr-body">
        <div class="vr-body-meta"><span class="badge vendor-request-type-badge">${r.request_type === "buy" ? "Buy" : "Rent"}</span><span class="muted">Posted by ${esc(r.buyer_name || "a buyer")}</span></div>
        ${r.description ? `<p class="vr-full-desc">${esc(r.description)}</p>` : ""}
        ${reqPhotosHtml(r.photos)}
        ${mine
          ? `<div class="vendor-interest-row">
               <button type="button" class="btn btn-sm vendor-interest-btn" disabled><i class="fa-solid fa-heart"></i> Interested</button>
               <button type="button" class="btn btn-sm btn-outline vendor-not-interest-btn" onclick="setVendorRequestInterest('${r.id}','not-interested')"><i class="fa-solid fa-xmark"></i> Not interested</button>
             </div>
             <div class="vendor-offer-status"><i class="fa-solid fa-circle-check"></i> You already sent an offer · <strong>${esc(mine.status || "pending")}</strong></div>`
          : interest === "interested"
            ? offerComposer(true)
            : `<div class="vendor-interest-row">
                <button type="button" class="btn btn-sm vendor-interest-btn" onclick="setVendorRequestInterest('${r.id}','interested')"><i class="fa-solid fa-heart"></i> Interested</button>
                <button type="button" class="btn btn-sm btn-outline vendor-not-interest-btn" onclick="setVendorRequestInterest('${r.id}','not-interested')"><i class="fa-solid fa-xmark"></i> Not interested</button>
              </div>`}
      
      </div>
    </article>`;
  };

  // Keep the request area compact while making the request list explicitly
  // collapsible. It opens by default so the current request remains visible.
  if (visibleRequests.length) {
    html += `<div class="vr-list">`;
    visibleRequests.forEach(requestRender);
    html += `</div>`;
  }
  html += `</section><section id="vendorMyRequestsTab" class="vendor-request-tab-panel hidden">`;
  if (!myRequests?.length) html += `<div class="empty-state"><i class="fa-solid fa-list-check" style="font-size:1.5rem;display:block;margin-bottom:.5rem;"></i>You haven't posted any requests yet.<br><button type="button" class="btn btn-sm" style="margin-top:.7rem;" onclick="navigate('requestEquipment')">Post a request</button></div>`;
  (myRequests || []).forEach((r) => {
    const offers = r.offers || [];
    html += `<article class="card vendor-my-request-card">
      <div class="vendor-my-request-layout">
        <div class="vendor-my-request-identity">
          ${r.buyer_avatar_url ? `<img src="${esc(r.buyer_avatar_url)}" class="avatar-circle" style="width:3rem;height:3rem;object-fit:cover;flex:0 0 3rem;" alt="" />` : avatarFallbackHtml(r.buyer_name || profile?.name || "You", "3rem", "", r.buyer_name || profile?.name || "You")}
          <div class="vendor-my-request-title"><strong>${esc(r.title)}</strong><span class="muted">${esc(r.city || "No city")}</span></div>
        </div>
        <div class="vendor-my-request-details">
          <span class="badge">${r.request_type === "buy" ? "Buy" : "Rent"}</span>
          ${r.request_type === "rent" && r.needed_from ? `<span class="muted">${esc(r.needed_from)} → ${esc(r.needed_to || "")}</span>` : ""}
          <span class="muted">${offers.length} offer${offers.length === 1 ? "" : "s"}</span>
          ${r.description ? `<p class="muted">${esc(r.description)}</p>` : ""}
        </div>
        <div class="vendor-my-request-actions">
          <span class="vr-status ${r.status === "fulfilled" ? "vr-prog" : r.status === "cancelled" ? "vr-closed" : "vr-open"}">${esc(r.status === "fulfilled" ? "Fulfilled" : r.status === "cancelled" ? "Closed" : "Open")}</span>
          ${r.status === "open" ? `<button type="button" class="btn btn-sm btn-outline" onclick="cancelEquipmentRequest('${r.id}')"><i class="fa-solid fa-ban"></i> Cancel</button>` : ""}
        </div>
      </div>
      ${offers.length ? `<div class="vendor-my-offers"><strong>${offers.length} offer${offers.length === 1 ? "" : "s"}</strong>${offers.map((o) => `<div class="vendor-my-offer-row"><div><strong>${esc(o.vendor?.business_name || "Vendor")}</strong><p class="muted" style="margin:.15rem 0 0;">${esc(o.message || "No message")}</p></div><div style="text-align:right;">${o.price != null ? `<strong>${naira(o.price)}</strong>` : ""}<div><span class="badge ${o.status === "accepted" ? "success" : o.status === "declined" ? "danger" : ""}">${esc(o.status || "pending")}</span></div></div></div>`).join("")}</div>` : ""}
    </article>`;
  });
  html += `</section></div>`;
  return html;
}

function toggleVendorRequestCard(id) {
  const card = byId(`vendorRequestCard-${id}`);
  if (!card) return;
  const open = card.classList.toggle("vr-expanded");
  card.querySelector(".vr-head")?.setAttribute("aria-expanded", String(open));
}
function switchVendorRequestTab(tab) {
  const target = tab === "mine" ? "mine" : "customers";
  document.querySelectorAll("#app .vendor-request-tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.requestTab === target));
  byId("vendorCustomerRequestsTab")?.classList.toggle("hidden", target !== "customers");
  byId("vendorMyRequestsTab")?.classList.toggle("hidden", target !== "mine");
}

async function setVendorRequestInterest(requestId, state) {
  if (!vendor?.id || !requestId) return;
  const interestKey = `levromart-vendor-interest-${vendor.id}-${requestId}`;
  const hiddenKey = `levromart-vendor-hidden-requests-${vendor.id}`;
  const card = byId(`vendorRequestCard-${requestId}`);

  if (state === "cancel-interest") {
    try { localStorage.removeItem(interestKey); } catch (_) {}
    const compose = byId(`vendorOfferCompose-${requestId}`);
    if (compose) {
      compose.outerHTML = `<div class="vendor-interest-row">
        <button type="button" class="btn btn-sm vendor-interest-btn" onclick="setVendorRequestInterest('${requestId}','interested')"><i class="fa-solid fa-heart"></i> Interested</button>
        <button type="button" class="btn btn-sm btn-outline vendor-not-interest-btn" onclick="setVendorRequestInterest('${requestId}','not-interested')"><i class="fa-solid fa-xmark"></i> Not interested</button>
      </div>`;
    }
    return;
  }

  if (state === "not-interested") {
    const ok = await showConfirmDialog("Are you sure you are not interested in this request? It will be removed from your customer requests dashboard.", { title: "Not interested", okLabel: "Remove request", danger: true });
    if (!ok) return;
    let hidden = [];
    try { hidden = JSON.parse(localStorage.getItem(hiddenKey) || "[]"); } catch (_) { hidden = []; }
    if (!hidden.includes(String(requestId))) hidden.push(String(requestId));
    localStorage.setItem(hiddenKey, JSON.stringify(hidden));
    try { localStorage.removeItem(interestKey); } catch (_) {}
    card?.remove();
    const countEl = document.querySelector('[data-request-customer-count]');
    const remaining = document.querySelectorAll('#vendorCustomerRequestsTab .vr-list .vr-item').length;
    if (countEl) { countEl.textContent = remaining ? String(remaining) : ''; countEl.classList.toggle('hidden', remaining === 0); }
    const tabBtn = document.querySelector('#vendorCustomerRequestsTab')?.closest('.vendor-requests-page')?.querySelector('[data-request-tab="customers"]');
    if (tabBtn) {
      const m = tabBtn.querySelector('[data-request-customer-count]');
      if (remaining === 0) m?.remove();
      else if (m) m.textContent = String(remaining);
      else tabBtn.insertAdjacentHTML('beforeend', ` <span data-request-customer-count>${remaining}</span>`);
    }
    showToast("Request removed from your dashboard.", "success");
    return;
  }

  try { localStorage.setItem(interestKey, "interested"); } catch (_) {}
  const interestRow = card?.querySelector(".vendor-interest-row");
  const existingCompose = byId(`vendorOfferCompose-${requestId}`);
  if (interestRow && !existingCompose) {
    const composer = document.createElement("div");
    composer.className = "vendor-offer-compose";
    composer.id = `vendorOfferCompose-${requestId}`;
    const products = window.__myProductsForOffers || [];
    const req = (window.__vendorCustomerRequests || []).find((x) => String(x.id) === String(requestId));
    const html = `<div class="vendor-offer-compose-title"><i class="fa-solid fa-paper-plane"></i><strong>Make an offer</strong><span class="muted">Enter your price and add an optional message to the customer.</span></div>
      ${products.length ? `<select id="offerProduct-${requestId}" onchange="applyOfferProductPrice('${requestId}','${req?.request_type || 'buy'}')"><option value="">Quote a custom price…</option>${products.filter(p=>!req?.category_id || p.category_id===req.category_id).map(p=>`<option value="${p.id}">Use my "${esc(p.name)}": ${p.sale_price != null ? naira(p.sale_price) : ""}${p.sale_price != null && p.rental_rate != null ? " / " : ""}${p.rental_rate != null ? naira(p.rental_rate) + "/" + p.rental_rate_unit : ""}</option>`).join("")}</select>` : ""}
      <div class="vendor-offer-fields"><input type="number" id="offerPrice-${requestId}" placeholder="Price (₦)" inputmode="decimal" min="0" step="0.01" /><textarea id="offerMsg-${requestId}" rows="3" placeholder="Message to the customer (e.g. availability, delivery time, or other details)…"></textarea></div>
      <div class="vendor-offer-actions"><button class="btn vendor-send-offer-btn" type="button" onclick="sendOffer('${requestId}')"><i class="fa-solid fa-paper-plane"></i> Send offer</button><button class="btn btn-sm btn-outline" type="button" onclick="setVendorRequestInterest('${requestId}','cancel-interest')">Cancel</button></div>`;
    composer.innerHTML = html;
    interestRow.replaceWith(composer);
  }
  setTimeout(() => byId(`offerPrice-${requestId}`)?.focus(), 0);
  showToast("You're interested, add your price and message to send an offer.", "success");
}

function applyOfferProductPrice(requestId, requestType) {
  const productId = byId(`offerProduct-${requestId}`).value;
  const priceEl = byId(`offerPrice-${requestId}`);
  if (!productId) return;
  const product = (window.__myProductsForOffers || []).find((p) => p.id === productId);
  if (!product) return;
  const price = requestType === "buy" ? product.sale_price : product.rental_rate;
  if (price != null) priceEl.value = price;
}

async function sendOffer(requestId) {
  const priceEl = byId(`offerPrice-${requestId}`);
  const msgEl = byId(`offerMsg-${requestId}`);
  const { error } = await sb.from("request_offers").insert({
    request_id: requestId,
    vendor_id: vendor.id,
    message: msgEl.value.trim() || null,
    price: priceEl.value ? Number(priceEl.value) : null,
  });
  if (error) { showToast(error.message, "error"); return; }
  navigate("vendorRequests");
}

function scrollToVendorReviews() {
  const reviews = byId("vendorReviews");
  if (!reviews) return;
  reviews.scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => {
    const list = byId("reviewsList");
    if (list?.classList.contains("hidden")) toggleReviewsList();
  }, 180);
}

function toggleStorefrontPackages() {
  switchStorefrontCatalogTab("packages");
}

function toggleStorefrontPackageSearch(event) {
  event?.stopPropagation?.();
  const row = byId("storefrontPackageSearchRow");
  if (!row) return;
  row.classList.toggle("hidden");
  if (!row.classList.contains("hidden")) setTimeout(() => byId("storefrontPackageSearch")?.focus(), 0);
}

function clearStorefrontPackageSearch() {
  const input = byId("storefrontPackageSearch");
  if (input) input.value = "";
  filterStorefrontPackages();
  input?.focus();
}

function filterStorefrontPackages() {
  const q = (byId("storefrontPackageSearch")?.value || "").trim().toLowerCase();
  const all = window.__storefrontPackages || [];
  const grid = byId("storefrontPackagesGrid");
  if (!grid) return;
  const shown = q
    ? all.filter((pkg) => {
        const text = [pkg.name, pkg.description, ...(pkg.items || []).map((it) => it.product?.name || "")].join(" ").toLowerCase();
        return text.includes(q);
      })
    : all;
  grid.innerHTML = shown.length
    ? shown.map((pkg) => packageCardHtml(pkg, pkg.vendor?.delivery_fee, true)).join("")
    : `<div class="empty-state" style="grid-column:1/-1;">No packages match “${esc(q)}”.</div>`;
}

function switchStorefrontView(mode) {
  storefrontViewMode = mode;
  byId("storefrontViewGridBtn")?.classList.toggle("active", mode === "grid");
  byId("storefrontViewTableBtn")?.classList.toggle("active", mode === "table");
  byId("storefrontGrid")?.classList.toggle("hidden", mode !== "grid");
  byId("storefrontTable")?.classList.toggle("hidden", mode !== "table");
  filterStorefrontProducts();
}

function switchStorefrontCatalogTab(tab) {
  storefrontCatalogTab = ["products", "services", "packages"].includes(tab) ? tab : "products";
  ["products", "services", "packages"].forEach((name) => {
    const btn = byId(`storefront${name.charAt(0).toUpperCase() + name.slice(1)}Tab`);
    if (btn) {
      btn.classList.toggle("active", storefrontCatalogTab === name);
      btn.setAttribute("aria-selected", storefrontCatalogTab === name ? "true" : "false");
    }
  });
  window.__storefrontExpanded = false;
  storefrontCategoryFilter = "";
  const productsShell = byId("storefrontProductsShell");
  const packagesSection = byId("storefrontPackagesSection");
  if (productsShell) productsShell.classList.toggle("storefront-tab-panel-hidden", storefrontCatalogTab === "packages");
  if (packagesSection) packagesSection.classList.toggle("storefront-tab-panel-hidden", storefrontCatalogTab !== "packages");
  filterStorefrontProducts();
  if (storefrontCatalogTab === "packages") filterStorefrontPackages();
}

function setStorefrontCategoryFilter(name) {
  storefrontCategoryFilter = name || "";
  filterStorefrontProducts();
}
function filterStorefrontProducts() {
  const q = (byId("storefrontSearch")?.value || "").trim().toLowerCase();
  const all = window.__storefrontProducts || [];
  const products = all.filter(p => !p.is_service);
  const services = all.filter(p => !!p.is_service);
  const current = storefrontCatalogTab === "services" ? services : products;
  // The vendor's own real category names, in the order they first appear --
  // never a hardcoded list, so a shop with "Snacks/Drinks/Bundles" gets
  // exactly those chips and nothing else.
  const categoryNames = [...new Set(current.map((p) => p.category?.name).filter(Boolean))];
  if (storefrontCategoryFilter && !categoryNames.includes(storefrontCategoryFilter)) storefrontCategoryFilter = "";
  const chipsEl = byId("storefrontCategoryChips");
  if (chipsEl) {
    chipsEl.innerHTML = categoryNames.length ? `<button type="button" class="storefront-category-chip ${storefrontCategoryFilter === "" ? "active" : ""}" onclick="setStorefrontCategoryFilter('')">All</button>${categoryNames.map((name) => `<button type="button" class="storefront-category-chip ${storefrontCategoryFilter === name ? "active" : ""}" onclick="setStorefrontCategoryFilter('${esc(name).replace(/'/g, "&#39;")}')">${esc(name)}</button>`).join("")}` : "";
  }
  let filtered = storefrontCategoryFilter ? current.filter((p) => p.category?.name === storefrontCategoryFilter) : current;
  filtered = q ? filtered.filter((p) => `${p.name || ""} ${(p.category?.name || "")}`.toLowerCase().includes(q)) : filtered;
  const visible = filtered;
  const gridEl = byId("storefrontGrid");
  if (gridEl) gridEl.innerHTML = visible.length ? visible.map(productCardHtml).join("") : `<div class="empty-state">No ${storefrontCatalogTab} found${q ? ` for “${esc(q)}”` : ""}.</div>`;
  const pCount = byId("storefrontProductsCount"), sCount = byId("storefrontServicesCount");
  if (pCount) pCount.textContent = `(${products.length})`;
  if (sCount) sCount.textContent = `(${services.length})`;
  const wrap = byId("storefrontViewMoreWrap");
  if (wrap) wrap.innerHTML = "";
}

function toggleStorefrontProducts() {
  window.__storefrontExpanded = !window.__storefrontExpanded;
  filterStorefrontProducts();
  if (!window.__storefrontExpanded) byId("storefrontProductsShell")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function storefrontTableHtml(list) {
  return `<table class="storefront-data-table">
    <thead><tr>
      <th>${list.some(p => p.is_service) && list.every(p => p.is_service) ? "Service" : "Product"}</th>
      <th>Category</th>
      <th>Price</th>
      <th class="available-col">Available</th>
    </tr></thead>
    <tbody>${list.map((p) => `<tr style="cursor:pointer;" onclick="navigate('productDetail',{productId:'${p.id}'})">
      <td>${esc(p.name)}</td>
      <td>${esc(p.category?.name || "-")}</td>
      <td class="price-col">${p.is_service ? `${naira(p.sale_price)}${servicePriceSuffix(p)}` : [p.sale_price != null ? `Buy: ${naira(p.sale_price)}` : "", p.rental_rate != null ? `Rent: ${naira(p.rental_rate)}/${p.rental_rate_unit}` : ""].filter(Boolean).join(" · ")}</td>
      <td class="available-col">${p.is_service ? "-" : (p.track_quantity === false || Number(p.quantity_available) >= 100000 ? "Untracked" : p.quantity_available)}</td>
    </tr>`).join("")}</tbody>
  </table>`;
}

function packageCardHtml(pkg, vendorDeliveryFee, compact = false) {
  const photos = Array.isArray(pkg.photos) ? pkg.photos.filter(Boolean) : [];
  const galleryId = `pkgGallery-${pkg.id}-${Math.random().toString(36).slice(2,7)}`;
  const mainPhoto = photos[0] || "";
  const galleryHtml = mainPhoto
    ? `<div class="package-gallery" id="${galleryId}" onclick="event.stopPropagation();">
        <img class="package-photo-main" src="${esc(mainPhoto)}" alt="${esc(pkg.name)}" loading="lazy" decoding="async" onclick="openPackageImageLightbox('${esc(mainPhoto)}',event)">
      </div>`
    : `<div class="package-gallery-placeholder" onclick="event.stopPropagation();"><i class="fa-solid fa-box-open"></i>&nbsp; No package photo</div>`;
  const itemsText = (pkg.items || []).map((it) => `${it.quantity}× ${esc(it.product?.name || "")}`).join(", ") || "No items listed";
  const vendorName = pkg.vendor?.business_name || "Vendor";
  return `<div class="card package-listing-card" data-package-id="${esc(pkg.id)}" onclick="navigate('packageDetail',{packageId:'${pkg.id}'})" role="button" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();navigate('packageDetail',{packageId:'${pkg.id}'})}">
    ${galleryHtml}
    <div class="package-card-title-row"><strong>${esc(pkg.name)}</strong><span class="badge">${naira(pkg.price)}</span></div>
    ${pkg.description ? `<p class="package-card-description muted">${esc(pkg.description)}</p>` : ""}
    <p class="package-card-includes muted"><i class="fa-solid fa-box-open"></i> Includes: ${itemsText}</p>
    <div class="package-card-vendor"><i class="fa-solid fa-store"></i> ${esc(vendorName)}</div>
    ${pkg.vendor?.delivery_fee_mode === "distance" ? `<div class="package-card-delivery muted"><i class="fa-solid fa-truck"></i> Distance delivery · ${naira(pkg.vendor.delivery_fee_per_km || 0)}/km</div>` : Number(pkg.vendor?.delivery_fee || 0) > 0 ? `<div class="package-card-delivery muted"><i class="fa-solid fa-truck"></i> Delivery · ${naira(pkg.vendor.delivery_fee)}</div>` : `<div class="package-card-delivery muted"><i class="fa-solid fa-truck"></i> Free delivery</div>`}
    ${profile?.role === "admin" ? `<span class="badge package-card-owner-badge">Admin</span>` : isOwnVendorId(pkg.vendor?.id) ? `<span class="badge own-listing-badge package-card-owner-badge"><i class="fa-solid fa-store"></i> Your package</span>` : ""}
    <div class="package-card-comment-row"><span class="package-card-engagement-count muted"><i class="fa-regular fa-heart"></i> <span class="package-like-count">0</span></span><button type="button" class="package-card-comment-btn" data-package-id="${esc(pkg.id)}" onclick="event.stopPropagation();openPackageCommentsFromCard('${esc(pkg.id)}')" aria-label="Comments on ${esc(pkg.name)}"><i class="fa-regular fa-comment"></i> <span class="package-comment-count">0</span></button></div>
  </div>`;
}

function setPackageCardPhoto(galleryId, index, event) {
  event?.stopPropagation?.();
  const gallery = byId(galleryId);
  if (!gallery) return;
  const photos = [...gallery.querySelectorAll(".package-photo-thumb img")].map((img) => img.src);
  const main = gallery.querySelector(".package-photo-main");
  if (!main || !photos[index]) return;
  main.src = photos[index];
  main.onclick = (e) => openPackageImageLightbox(photos[index], e);
}

function openPackageImageLightbox(url, event) {
  event?.stopPropagation?.();
  const img = byId("productLightboxImage");
  if (img) img.src = url;
  byId("productImageLightbox")?.classList.remove("hidden");
}

function togglePackageBuy(packageId) {
  byId(`pkgBuyWrap-${packageId}`)?.classList.toggle("hidden");
}

async function buyPackage(packageId) {
  if (!session) { showLogin(); return; }
  if (blockOwnVendorPurchase(window.__packageDetailVendorId, "buy")) return;
  const prefix = "pkg" + packageId;
  const errorEl = byId(`pkgBuyError-${packageId}`);
  errorEl.classList.add("hidden");
  const delivery = readDeliveryFields(prefix, errorEl);
  if (!delivery) return;

  const { data: orderId, error } = await sb.rpc("create_package_order", {
    p_package_id: packageId,
    p_delivery_method: delivery.method,
    p_delivery_address: delivery.address,
    p_delivery_phone: delivery.phone,
  });
  if (error) { errorEl.textContent = error.message; errorEl.classList.remove("hidden"); return; }
  window.__reviewPromptDismissedOrderId=String(orderId);
  window.__closeLevromartReviewPrompt?.();
  navigate("orderDetail", { orderId });
}

// Swipe sideways on a storefront to move between Products, Services and Packages (not when the finger starts on a scrolling row or a field).
(function () {
  let sx = 0, sy = 0, ok = false;
  const skip = "input,textarea,select,.hscroll,.storefront-category-chips,.storefront-banner,[class*='carousel'],.modal,.drawer,[role=dialog]";
  document.addEventListener("touchstart", (e) => {
    ok = false;
    if (e.touches.length !== 1 || !document.querySelector("#app .storefront-catalog-tabs") || e.target.closest?.(skip)) return;
    if (!e.target.closest?.("#app")) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; ok = true;
  }, { passive: true });
  document.addEventListener("touchend", (e) => {
    if (!ok) return; ok = false;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) < 70 || Math.abs(dy) > 45 || Math.abs(dx) < Math.abs(dy) * 2) return;
    const order = ["products", "services", "packages"], i = order.indexOf(storefrontCatalogTab);
    const n = i + (dx < 0 ? 1 : -1);
    if (i < 0 || n < 0 || n >= order.length) return;
    switchStorefrontCatalogTab(order[n]);
  }, { passive: true });
})();

