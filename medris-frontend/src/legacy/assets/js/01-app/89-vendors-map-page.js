// ---------- VENDORS MAP PAGE: a whole screen for the map (search, categories, grouped pins, vendor cards, map styles) ----------
let vmpMap = null, vmpTiles = null, vmpLayer = null, vmpMe = null;
let vmpAll = [], vmpQuery = "", vmpSector = "", vmpSelected = "", vmpStyle = "";
const VMP_ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/";
const VMP_STYLES = {
  streets: { label: "Default", icon: "fa-route", url: VMP_ESRI + "Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", ref: VMP_ESRI + "Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}", native: 16, attr: "Tiles © Esri, HERE, Garmin, © OpenStreetMap contributors", max: 19 },
  night: { label: "Night", icon: "fa-moon", url: VMP_ESRI + "Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", ref: VMP_ESRI + "Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", native: 16, attr: "Tiles © Esri, HERE, Garmin, © OpenStreetMap contributors", max: 19 },
};
// travel-time estimates (Lagos pace): the road distance comes from the route, the speeds are typical
const VMP_MODES = [
  { k: "car", icon: "fa-car-side", label: "Car", f: (km, drive) => Math.max(1, Math.round(drive * 1.5)) },
  { k: "moto", icon: "fa-motorcycle", label: "Bike taxi", f: (km, drive) => Math.max(1, Math.round(drive * 1.1)) },
  { k: "bike", icon: "fa-person-biking", label: "Cycle", f: (km) => Math.max(1, Math.round(km / 14 * 60)) },
  { k: "walk", icon: "fa-person-walking", label: "Walk", f: (km) => Math.max(1, Math.round(km / 4.8 * 60)) },
];
let vmpMode = "car", vmpRouteInfo = null, vmpRailBusy = 0, vmpRailTimer = null, vmpDetails = { names: false };
function vmpMins(m) { return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60 ? (m % 60) + " min" : ""}`.trim(); }
function vmpNorm(t) { return String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim(); }
function vmpDistKm(v) { return buyerLocation && v.lat != null ? haversineKm(buyerLocation.lat, buyerLocation.lng, v.lat, v.lng) : null; }
function vmpDistText(km) { return km == null ? "" : km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`; }
function vmpSectorOf(v) { return v?.sector_name || (Array.isArray(sectors) ? sectors.find((s) => String(s.id) === String(v?.sector_id))?.name : "") || ""; }
function vmpVisible() {
  const q = vmpNorm(vmpQuery);
  return vmpAll.filter((v) => (!vmpSector || vmpSectorOf(v) === vmpSector) && (!q || vmpNorm(`${v.business_name} ${vmpSectorOf(v)} ${v.city || ""}`).includes(q)));
}
function vmpTheme() { const t = document.documentElement.dataset.theme; return t === "dark" || t === "black" ? "night" : "streets"; }

function vmpOpenAccountProfile() {
  if (!session) { showLogin(); return; }
  navigate(profile?.role === "admin" ? "adminPanel" : vendor ? "vendorDashboard" : "buyerProfile");
}
function vmpOpenLocationSettings() {
  if (!session) { showLogin(); return; }
  navigate(vendor ? "vendorEditProfile" : "editProfile");
}
function vmpProfileAvatarHtml() {
  if (profile?.avatar_url) return '<img src="' + esc(profile.avatar_url) + '" alt="" draggable="false">';
  return avatarFallbackHtml(profile?.name || profile?.email || "Account", "100%", "", profile?.name || profile?.email || "Account");
}
function renderVendorsMapPage() {
  setTimeout(() => initVendorsMapPage(), 0);
  const locationLabel = vendor?.city || profile?.city || "Choose location";
  return `<div class="vmpage vmp-snap-map" id="vmPage">
    <div id="vmpMap" aria-label="Map of vendors"></div>
    <div class="vmp-top">
      <div class="vmp-social-head">
        <button type="button" class="vmp-profile-trigger" onclick="vmpOpenAccountProfile()" aria-label="Open account profile">${vmpProfileAvatarHtml()}</button>
        <button type="button" class="vmp-location-trigger" onclick="vmpOpenLocationSettings()" aria-label="Choose your location">
          <span class="vmp-location-label">Your location</span>
          <strong>${esc(locationLabel)}</strong>
          <i class="fa-solid fa-chevron-down"></i>
        </button>
      </div>
      <div class="vmp-bar">
        <i class="fa-solid fa-magnifying-glass vmp-bar-ic" aria-hidden="true"></i>
        <input id="vmpQ" type="search" autocomplete="off" placeholder="Search places and vendors" oninput="vmpSearch(this.value)" onfocus="vmpSearch(this.value)" onkeydown="if(event.key==='Enter')vmpPickFirst()" aria-label="Search places and vendors">
        <button type="button" class="vmp-clear hidden" id="vmpClear" aria-label="Clear search" onclick="vmpSearch('',true)"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="vmp-sugg hidden" id="vmpSugg"></div>
      <div class="vmp-chips" id="vmpChips"></div>
    </div>
    <div class="vmp-fabs">
      <button type="button" class="vmp-fab" aria-label="Map type" onclick="vmpToggleStyles()"><i class="fa-solid fa-layer-group"></i></button>
    </div>
    <div class="vmp-sheet-wrap hidden" id="vmpStyles"></div>
    <div class="vmp-bottom">
      <button type="button" class="vmp-fab vmp-locate" id="vmpLocate" aria-label="My location" onclick="vmpLocate()"><i class="fa-solid fa-location-crosshairs"></i></button>
      <div class="vmp-route hidden" id="vmpRouteCard"></div>
      <div class="vmp-rail" id="vmpRail"></div>
    </div>
  </div>`;
}

function vmpLayout() {
  const page = byId("vmPage"); if (!page) return;
  const nav = byId("bottomNav");
  const top = Math.max(0, page.getBoundingClientRect().top);
  let bottom = 0;
  if (nav && getComputedStyle(nav).display !== "none") {
    const r = nav.getBoundingClientRect();
    if (r.width >= window.innerWidth * 0.5) bottom = Math.max(0, window.innerHeight - r.top);
  }
  page.style.height = `${Math.max(320, window.innerHeight - top - bottom)}px`;
  vmpMap?.invalidateSize(true);
}

async function initVendorsMapPage(tries = 0) {
  const el = byId("vmpMap");
  if (!el) { if (tries < 30) setTimeout(() => initVendorsMapPage(tries + 1), 50); return; }
  if (el.__vmpInit) return; el.__vmpInit = true;
  vmpDestroy(true);
  vmpLayout();
  window.addEventListener("resize", vmpLayout);
  document.querySelectorAll("#bottomNav .bottom-nav-item").forEach((b) => b.classList.toggle("active", b.dataset.navView === "vendorsMap"));
  try { await loadLeaflet(); } catch (err) { el.innerHTML = `<p class="muted" style="padding:1rem;">${esc(err.message)}</p>`; return; }
  let vendors = [];
  // vendors already loaded this visit open the map at once; the full list is refreshed in the background
  const cached = Array.isArray(window.__allVendors) && window.__allVendors.length ? window.__allVendors : null;
  if (cached) { vendors = cached; loadVendorsDirectory().catch(() => {}); }
  else { try { vendors = (await loadVendorsDirectory()) || []; } catch (_) {} }
  vmpAll = vendors.filter((v) => v.lat != null && v.lng != null && (typeof lvVendorVisible !== "function" || lvVendorVisible(v.id)));
  if (!byId("vmpMap")) return;
  let center = [6.5244, 3.3792], zoom = 11;
  if (buyerLocation) { center = [buyerLocation.lat, buyerLocation.lng]; zoom = 13; }
  vmpMap = window.L.map("vmpMap", { zoomControl: false, tap: false, attributionControl: true, zoomSnap: 0.5, zoomDelta: 0.5, inertia: true, worldCopyJump: true }).setView(center, zoom);
  vmpMap.attributionControl.setPrefix(false);
  // The map follows the app's theme (Night in dark mode, Map in light mode); a style picked on the map itself lasts until the theme changes.
  vmpSetStyle(["dark", "black"].includes(document.documentElement.getAttribute("data-theme")) ? "night" : "streets", false);
  vmpLayer = window.L.layerGroup().addTo(vmpMap);
  // pins are grouped by zoom level only, so panning does not need a redraw (redrawing on every move made the map slow on big screens)
  let vmpPinZoom = null;
  vmpMap.on("zoomend", () => { const z = vmpMap.getZoom(); if (z === vmpPinZoom) return; vmpPinZoom = z; vmpDrawPins(); });
  vmpMap.on("dragstart", () => { vmpMap.__userDrag = true; });
  vmpMap.on("click", () => { vmpClearRoute(); vmpHideSugg(); byId("vmpStyles")?.classList.add("hidden"); });
  vmpDrawChips();
  vmpDrawMe();
  vmpLayout();
  vmpMap.invalidateSize(false);
  const first = () => {
    if (!vmpMap) return;
    vmpMap.invalidateSize(false);
    if (vmpMap.getSize().y > 0 && vmpAll.length > 1 && !buyerLocation) vmpFitAll(); else { vmpDrawPins(); vmpDrawRail(); }
  };
  first();
  // The page can be laid out a moment after the map is created (route transition): follow its size, and fit once it has one.
  let fitted = vmpMap.getSize().y > 0;
  if (window.ResizeObserver) new ResizeObserver(() => {
    if (!vmpMap) return;
    vmpMap.invalidateSize(false);
    if (!fitted && vmpMap.getSize().y > 0) { fitted = true; if (!buyerLocation && !vmpSelected && vmpAll.length > 1) vmpFitAll(); else { vmpDrawPins(); vmpDrawRail(); } }
  }).observe(el);
  const focus = window.__pendingVendorMapFocusId;
  if (focus) { window.__pendingVendorMapFocusId = null; setTimeout(() => vmpSelect(focus, true), 200); }
  if (!buyerLocation && buyerDistanceAutoEnabled && locationSharingEnabled) {
    requestCustomerLocation(true).then((loc) => { if (loc && vmpMap) { vmpDrawMe(); vmpDrawRail(); vmpMap.flyTo([loc.lat, loc.lng], 13, { duration: 0.8 }); } }).catch(() => {});
  }
}
function vmpDestroy(keepListener) {
  try { vmpMap?.remove(); } catch (_) {}
  try { vmpClearRoute(); } catch (_) {}
  vmpMap = null; vmpTiles = null; vmpLayer = null; vmpMe = null; vmpSelected = ""; vmpQuery = ""; vmpSector = "";
  if (!keepListener) window.removeEventListener("resize", vmpLayout);
}
function vmpSetStyle(key, remember = true) {
  const s = VMP_STYLES[key] || VMP_STYLES.streets; vmpStyle = key;
  if (remember) { try { localStorage.setItem("levromart-vmp-style-v3", key); } catch (_) {} }
  if (vmpTiles) vmpMap.removeLayer(vmpTiles);
  if (window.vmpRefTiles) { vmpMap.removeLayer(window.vmpRefTiles); window.vmpRefTiles = null; }
  vmpTiles = window.L.tileLayer(s.url, { attribution: s.attr, maxZoom: s.max, maxNativeZoom: s.native, updateWhenIdle: false, keepBuffer: window.innerWidth >= 1024 ? 1 : 4 }).addTo(vmpMap);
  if (s.ref) window.vmpRefTiles = window.L.tileLayer(s.ref, { maxZoom: s.max, maxNativeZoom: s.native, updateWhenIdle: false, keepBuffer: window.innerWidth >= 1024 ? 1 : 4 }).addTo(vmpMap);
  byId("vmPage")?.setAttribute("data-style", key);
  vmpDrawSheet();
}
function vmpDrawSheet() {
  const box = byId("vmpStyles"); if (!box) return;
  box.innerHTML = `<div class="vmp-sheet-back" onclick="vmpToggleStyles()"></div><div class="vmp-sheet" role="dialog" aria-label="Map type">
    <div class="vmp-sheet-head"><strong>Map</strong><button type="button" aria-label="Close" onclick="vmpToggleStyles()"><i class="fa-solid fa-xmark"></i></button></div>
    <div class="vmp-types">${Object.entries(VMP_STYLES).map(([k, v]) => `<button type="button" class="${k === vmpStyle ? "on" : ""}" onclick="vmpSetStyle('${k}')"><span class="vmp-type-pic vmp-type-${k}"><i class="fa-solid ${v.icon}"></i></span><small>${v.label}</small></button>`).join("")}<button type="button" class="${vmpDetails.names ? "on" : ""}" onclick="vmpDetails.names=!vmpDetails.names;vmpDrawSheet();vmpDrawPins()"><span class="vmp-type-pic vmp-type-names"><i class="fa-solid fa-tag"></i></span><small>Vendor names</small></button></div>
  </div>`;
}
function vmpToggleStyles() { byId("vmpStyles")?.classList.toggle("hidden"); }
function vmpDrawChips() {
  const box = byId("vmpChips"); if (!box) return;
  const names = [...new Set(vmpAll.map(vmpSectorOf).filter(Boolean))].slice(0, 12);
  const chip = (label, val) => `<button type="button" class="vmp-chip${vmpSector === val ? " on" : ""}" onclick="vmpSetSector(${JSON.stringify(val).replace(/"/g, "&quot;")})">${esc(label)}</button>`;
  box.innerHTML = chip("All vendors", "") + names.map((n) => chip(n, n)).join("");
}
function vmpSetSector(v) { vmpSector = v; vmpDrawChips(); vmpDrawPins(); vmpDrawRail(); const list = vmpVisible(); if (list.length > 1) vmpFit(list); }
function vmpFit(list) {
  if (!vmpMap || !list.length) return;
  const b = window.L.latLngBounds(list.map((v) => [v.lat, v.lng]));
  if (b.isValid()) vmpMap.fitBounds(b.pad(0.18), { animate: true, maxZoom: 15, paddingBottomRight: [0, 120] });
}
function vmpFitAll() { vmpFit(vmpAll); }
function vmpDrawMe() {
  if (!vmpMap || !buyerLocation) return;
  if (vmpMe) vmpMap.removeLayer(vmpMe);
  vmpMe = window.L.marker([buyerLocation.lat, buyerLocation.lng], { icon: window.L.divIcon({ className: "vmp-me", html: '<span class="vmp-me-pulse"></span><span class="vmp-me-dot"></span>', iconSize: [24, 24], iconAnchor: [12, 12] }), zIndexOffset: 800, interactive: false }).addTo(vmpMap);
}
function vmpDrawPins() {
  if (!vmpMap || !vmpLayer) return;
  vmpLayer.clearLayers();
  const list = vmpVisible(), z = vmpMap.getZoom(), cell = 62, grid = new Map();
  list.forEach((v) => {
    if (z >= 16 || v.id === vmpSelected) { grid.set("v" + v.id, [v]); return; }
    const p = vmpMap.project([v.lat, v.lng], z), k = `${Math.floor(p.x / cell)}:${Math.floor(p.y / cell)}`;
    (grid.get(k) || grid.set(k, []).get(k)).push(v);
  });
  grid.forEach((vs) => {
    if (vs.length === 1) {
      const v = vs[0];
      const m = window.L.marker([v.lat, v.lng], { icon: vendorDirectoryMapIcon(v), riseOnHover: true, zIndexOffset: v.id === vmpSelected ? 700 : 0 }).addTo(vmpLayer);
      m.on("click", (e) => { window.L.DomEvent.stopPropagation(e); vmpSelect(v.id, false, true); });
      if (v.id === vmpSelected) m.getElement()?.classList.add("vmp-sel");
      if (vmpDetails.names || v.id === vmpSelected) m.bindTooltip(esc(v.business_name || "Vendor"), { permanent: true, direction: "bottom", offset: [0, 4], className: "vmp-tip", interactive: false });
      return;
    }
    const lat = vs.reduce((n, v) => n + Number(v.lat), 0) / vs.length, lng = vs.reduce((n, v) => n + Number(v.lng), 0) / vs.length;
    const m = window.L.marker([lat, lng], { icon: window.L.divIcon({ className: "vmp-cl", html: `<div class="vmp-cl-b"><b>${vs.length}</b></div>`, iconSize: [46, 46], iconAnchor: [23, 23] }) }).addTo(vmpLayer);
    m.on("click", (e) => { window.L.DomEvent.stopPropagation(e); vmpMap.fitBounds(window.L.latLngBounds(vs.map((v) => [v.lat, v.lng])).pad(0.5), { maxZoom: 17, animate: true }); });
  });
  window.dispatchEvent(new Event("scroll"));
}
function vmpCardHtml(v) {
  const id = String(v.id), km = vmpDistKm(v), sector = vmpSectorOf(v);
  const media = v.logo_url ? `<img src="${esc(v.logo_url)}" alt="" loading="lazy" draggable="false" data-n="${esc(v.business_name || "")}" data-k="${esc(id)}" onerror="vdImgFail(this)">` : vdInitialsHtml(v.business_name || "Vendor", id);
  const est = km != null ? `${vmpDistText(km)} · ${vmpMins(VMP_MODES[0].f(km * 1.3, Math.max(1, km * 1.3 / 22 * 60)))} by car` : "";
  const meta = [sector, v.city, est].filter(Boolean).map(esc).join(" · ");
  const dir = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(v.lat + "," + v.lng)}`;
  return `<div class="vmp-card${id === vmpSelected ? " on" : ""}" data-vid="${esc(id)}" onclick="vmpSelect('${esc(id)}',true)">
    <div class="vmp-card-top"><div class="vmp-card-logo">${media}</div>
      <div class="vmp-card-copy"><strong class="vmp-card-name"><span class="vmp-nm">${esc(v.business_name || "Vendor")}</span><i data-vt="${esc(id)}" class="fa-solid fa-circle-check vendor-inline-verified" aria-label="Verified vendor"></i></strong><span>${meta}</span><em><i class="fa-solid fa-star"></i> ${Number(v.avg_rating || 0).toFixed(1)} <small>(${Number(v.review_count || 0)})</small></em></div></div>
    <div class="vmp-card-act"><button type="button" onclick="event.stopPropagation();navigate('storefront',{vendorId:'${esc(id)}'})"><i class="fa-solid fa-store"></i> View shop</button><a href="${dir}" target="_blank" rel="noopener" onclick="event.stopPropagation()"><i class="fa-solid fa-diamond-turn-right"></i> Directions</a></div>
  </div>`;
}
// The vendor cards: one endless row. Swiping it moves the map to the vendor in the middle; reaching the end carries on from the first.
function vmpRailList() {
  let list = vmpVisible().slice();
  list.sort((a, c) => (vmpDistKm(a) ?? 1e9) - (vmpDistKm(c) ?? 1e9) || String(a.business_name).localeCompare(String(c.business_name)));
  return list.slice(0, 40);
}
function vmpDrawRail(keepSel) {
  const box = byId("vmpRail"); if (!box || !vmpMap) return;
  const list = vmpRailList();
  if (!list.length) { box.innerHTML = '<div class="vmp-empty"><i class="fa-solid fa-map-pin"></i> No vendors match that. Try another search.</div>'; box.__n = 0; return; }
  const one = list.map(vmpCardHtml).join("");
  const loop = list.length > 1;
  box.innerHTML = loop ? one + one + one : one;
  box.__n = list.length; box.__loop = loop;
  box.classList.toggle("vmp-rail-loop", loop);
  const sel = keepSel && vmpSelected ? list.findIndex((v) => String(v.id) === String(vmpSelected)) : -1;
  requestAnimationFrame(() => vmpRailGo(loop ? list.length + Math.max(0, sel) : Math.max(0, sel), false));
  if (!box.__bound) {
    box.__bound = true;
    box.addEventListener("scroll", () => { if (vmpRailBusy) return; clearTimeout(vmpRailTimer); vmpRailTimer = setTimeout(vmpRailSettled, 130); }, { passive: true });
  }
}
function vmpRailCards() { return [...(byId("vmpRail")?.querySelectorAll(".vmp-card") || [])]; }
function vmpRailGo(idx, smooth) {
  const box = byId("vmpRail"), cards = vmpRailCards(), c = cards[idx]; if (!box || !c) return;
  vmpRailBusy++;
  const left = c.offsetLeft - (box.clientWidth - c.offsetWidth) / 2;
  box.style.scrollSnapType = "none";
  box.scrollTo({ left, behavior: smooth ? "smooth" : "auto" });
  setTimeout(() => { box.style.scrollSnapType = ""; vmpRailBusy = Math.max(0, vmpRailBusy - 1); }, smooth ? 420 : 40);
}
function vmpRailSettled() {
  const box = byId("vmpRail"); if (!box || !box.__n) return;
  const cards = vmpRailCards(); if (!cards.length) return;
  const mid = box.scrollLeft + box.clientWidth / 2;
  let best = 0, bd = 1e9;
  cards.forEach((c, i) => { const d = Math.abs(c.offsetLeft + c.offsetWidth / 2 - mid); if (d < bd) { bd = d; best = i; } });
  const n = box.__n;
  let idx = best;
  if (box.__loop) {
    // carry on endlessly: when the middle copy is left, jump (unseen) to the same card in the middle copy
    if (best < n || best >= 2 * n) { idx = n + (best % n); vmpRailGo(idx, false); }
  }
  const id = cards[idx]?.dataset.vid;
  if (id && String(id) !== String(vmpSelected)) vmpSelect(id, false, true);
}
/* Route from you to the picked vendor: a thick blue line with a white edge (like the big map apps), plus travel times */
let vmpRoute = null, vmpRouteTimer = null, vmpRouteSeq = 0;
const vmpRouteCache = new Map();
function vmpClearRoute() {
  clearTimeout(vmpRouteTimer); vmpRouteSeq++;
  if (vmpRoute && vmpMap) { try { [vmpRoute.edge, vmpRoute.core, vmpRoute.a, vmpRoute.b].forEach((l) => l && vmpMap.removeLayer(l)); } catch (_) {} }
  vmpRoute = null; vmpRouteInfo = null;
  byId("vmpRouteCard")?.classList.add("hidden");
}
function vmpRouteCardDraw(v) {
  const box = byId("vmpRouteCard"); if (!box) return;
  if (!v) { box.classList.add("hidden"); return; }
  const info = vmpRouteInfo, km = info ? info.km : (vmpDistKm(v) || 0) * 1.3, drive = info ? info.drive : Math.max(1, km / 22 * 60);
  const tabs = VMP_MODES.map((m) => `<button type="button" class="${m.k === vmpMode ? "on" : ""}" onclick="vmpSetMode('${m.k}')" aria-label="${m.label}"><i class="fa-solid ${m.icon}"></i><b>${vmpMins(m.f(km, drive))}</b></button>`).join("");
  box.innerHTML = `<div class="vmp-route-top"><strong>${esc(v.business_name || "Vendor")}</strong><span>${info ? "" : "~"}${km < 1 ? Math.round(km * 1000) + " m" : km.toFixed(1) + " km"} by road</span></div><div class="vmp-modes">${tabs}</div><small>Estimates for typical Lagos traffic.</small>`;
  box.classList.remove("hidden");
}
function vmpSetMode(k) { vmpMode = k; const v = vmpAll.find((x) => String(x.id) === String(vmpSelected)); vmpRouteCardDraw(v); }
async function vmpTrace(v) {
  vmpClearRoute();
  if (!vmpMap || !v || v.lat == null || v.lng == null || !buyerLocation) return;
  const seq = vmpRouteSeq;
  vmpRouteCardDraw(v);
  const key = `${v.id}:${buyerLocation.lat.toFixed(3)},${buyerLocation.lng.toFixed(3)}`;
  let coords = [[Number(buyerLocation.lat), Number(buyerLocation.lng)], [Number(v.lat), Number(v.lng)]], info = null;
  try {
    let hit = vmpRouteCache.get(key);
    if (!hit) {
      const url = `https://router.project-osrm.org/route/v1/driving/${buyerLocation.lng},${buyerLocation.lat};${v.lng},${v.lat}?overview=full&geometries=geojson`;
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 5500);
      const res = await fetch(url, { signal: ctl.signal }); clearTimeout(timer);
      const r = (await res.json())?.routes?.[0];
      if (r?.geometry?.coordinates?.length > 1) { hit = { coords: r.geometry.coordinates.map((c) => [Number(c[1]), Number(c[0])]), km: r.distance / 1000, drive: r.duration / 60 }; vmpRouteCache.set(key, hit); }
    }
    if (hit) { coords = hit.coords; info = { km: hit.km, drive: hit.drive }; }
  } catch (_) { /* straight line */ }
  if (seq !== vmpRouteSeq || !vmpMap) return;
  vmpRouteInfo = info || { km: (vmpDistKm(v) || 0) * 1.3, drive: Math.max(1, (vmpDistKm(v) || 0) * 1.3 / 22 * 60) };
  vmpRouteCardDraw(v);
  const L = window.L;
  const edge = L.polyline(coords, { color: "#ffffff", weight: 11, opacity: 1, lineCap: "round", lineJoin: "round", interactive: false }).addTo(vmpMap);
  const core = L.polyline(coords, { color: "#1a73e8", weight: 7, opacity: 1, lineCap: "round", lineJoin: "round", interactive: false }).addTo(vmpMap);
  const b = L.circleMarker(coords[coords.length - 1], { radius: 7, color: "#fff", weight: 3, fillColor: "#ea4335", fillOpacity: 1, interactive: false }).addTo(vmpMap);
  vmpRoute = { edge, core, a: null, b };
  try { vmpMap.fitBounds(L.latLngBounds(coords).pad(0.25), { animate: true, maxZoom: 16, paddingTopLeft: [0, 120], paddingBottomRight: [0, 230] }); } catch (_) {}
}
function vmpSelect(id, fly, fromRail) {
  const v = vmpAll.find((x) => String(x.id) === String(id)); if (!v || !vmpMap) return;
  const prev = vmpSelected; vmpSelected = v.id;
  vmpHideSugg();
  const target = vmpMap.getZoom() < 14 ? 14 : vmpMap.getZoom();
  if (buyerLocation) { vmpTrace(v); } else { vmpRouteCardDraw(v); if (fly) vmpMap.flyTo([v.lat, v.lng], target, { duration: 0.7 }); else vmpMap.panTo([v.lat, v.lng], { animate: true }); }
  vmpDrawPins();
  // highlight the card; when the pick came from the map or a search, carry the row to it (without bouncing it back)
  vmpRailCards().forEach((c) => c.classList.toggle("on", String(c.dataset.vid) === String(vmpSelected)));
  if (!fromRail) {
    const box = byId("vmpRail"), list = vmpRailList(), i = list.findIndex((x) => String(x.id) === String(v.id));
    if (i >= 0 && box) vmpRailGo((box.__loop ? list.length : 0) + i, true);
  }
}
function vmpHideSugg() { byId("vmpSugg")?.classList.add("hidden"); }
function vmpSearch(q, clear) {
  vmpQuery = q || "";
  const inp = byId("vmpQ"); if (clear && inp) { inp.value = ""; inp.focus(); }
  byId("vmpClear")?.classList.toggle("hidden", !vmpQuery);
  const box = byId("vmpSugg"); if (!box) return;
  vmpDrawPins(); vmpDrawRail();
  if (!vmpQuery.trim()) { box.classList.add("hidden"); return; }
  const hits = vmpVisible().slice(0, 6);
  box.innerHTML = hits.length ? hits.map((v) => `<button type="button" onclick="vmpSelect('${esc(String(v.id))}',true)"><span class="vmp-sg-logo">${v.logo_url ? `<img src="${esc(v.logo_url)}" alt="" onerror="this.remove()">` : vdInitialsHtml(v.business_name || "V", v.id)}</span><span class="vmp-sg-copy"><strong><span class="vmp-nm">${esc(v.business_name || "Vendor")}</span><i data-vt="${esc(String(v.id))}" class="fa-solid fa-circle-check vendor-inline-verified" aria-label="Verified vendor"></i></strong><small>${esc([vmpSectorOf(v), v.city].filter(Boolean).join(" · "))}</small></span><i class="fa-solid fa-location-arrow"></i></button>`).join("") : '<div class="vmp-sg-none">No vendor found</div>';
  box.classList.remove("hidden");
  if (hits.length > 1) vmpFit(hits);
}
function vmpPickFirst() { const v = vmpVisible()[0]; if (v) vmpSelect(v.id, true); }
let vmpHeadOn = false, vmpHeading = null;
function vmpHeadStart() {
  if (vmpHeadOn) return; vmpHeadOn = true;
  const on = (e) => {
    const a = typeof e.webkitCompassHeading === "number" ? e.webkitCompassHeading : (e.absolute || e.type === "deviceorientationabsolute") && e.alpha != null ? 360 - e.alpha : null;
    if (a == null) return; vmpHeading = a;
    const dot = document.querySelector(".vmp-me-dot"); if (dot) dot.style.setProperty("--vmp-head", `${a}deg`), dot.parentElement?.classList.add("has-head");
  };
  try {
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") DeviceOrientationEvent.requestPermission().then((r) => { if (r === "granted") window.addEventListener("deviceorientation", on, true); }).catch(() => {});
    else { window.addEventListener("deviceorientationabsolute", on, true); window.addEventListener("deviceorientation", on, true); }
  } catch (_) {}
}
// one button for two jobs: find me, and put me back in the middle (and turn the little arrow to the way I face)
async function vmpLocate() {
  const btn = byId("vmpLocate"); btn?.classList.add("is-loading");
  try {
    const loc = await requestCustomerLocation(true);
    if (loc) { vmpDrawMe(); vmpHeadStart(); vmpMap?.flyTo([loc.lat, loc.lng], Math.max(vmpMap.getZoom(), 15), { duration: 0.8 }); btn?.classList.add("on"); }
  } catch (err) { showToast(err?.message || "Unable to get your location.", "error"); }
  finally { btn?.classList.remove("is-loading"); }
}
