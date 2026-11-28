// ---------- MAP (Leaflet + OpenStreetMap, loaded on demand) ----------
// Free, no API key or billing -- pulled in lazily from a CDN only the first
// time a map actually renders (vendor location picker or the vendors-near-me
// view), so pages that never touch a map pay nothing for it.
let leafletLoadPromise = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (leafletLoadPromise) return leafletLoadPromise;
  leafletLoadPromise = new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    document.head.appendChild(link);
    const script = document.createElement("script");
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    // The default marker icon is normally resolved relative to leaflet.js's
    // own path via a bundler -- loaded standalone from a CDN like this, that
    // resolution breaks and markers render as broken images unless the icon
    // URLs are pointed at the CDN explicitly.
    script.onload = () => {
      window.L.Icon.Default.mergeOptions({
        iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
        iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
        shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
      });
      resolve();
    };
    script.onerror = () => reject(new Error("Could not load the map. Check your connection and try again."));
    document.head.appendChild(script);
  });
  return leafletLoadPromise;
}
// OpenStreetMap raster tiles are used directly so the map never displays a
// provider API-key requirement. The product stays keyless; keep the standard
// OSM attribution visible as required by the tile service.
function mapTileConfig() {
  // Esri's keyless light grey map by day (clean, uncluttered) and its dark grey map plus labels at night; the map follows the app's theme.
  const dark = ["dark", "black"].includes(document.documentElement.getAttribute("data-theme"));
  const base = "https://server.arcgisonline.com/ArcGIS/rest/services/";
  return dark
    ? { url: base + "Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", ref: base + "Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", native: 16, attribution: "Tiles © Esri, HERE, Garmin, © OpenStreetMap contributors", maxZoom: 19 }
    : { url: base + "Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", ref: base + "Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}", native: 16, attribution: "Tiles © Esri, HERE, Garmin, © OpenStreetMap contributors", maxZoom: 19 };
}
function addBasemapTileLayer(map) {
  const cfg = mapTileConfig();
  const layer = window.L.tileLayer(cfg.url, { attribution: cfg.attribution, maxZoom: cfg.maxZoom, maxNativeZoom: cfg.native, updateWhenIdle: false, keepBuffer: 4 }).addTo(map);
  if (cfg.ref) window.L.tileLayer(cfg.ref, { maxZoom: cfg.maxZoom, maxNativeZoom: cfg.native, updateWhenIdle: false, keepBuffer: 4 }).addTo(map);
  return layer;
}
// Vendors page pins: the vendor's own round logo (or a shop icon) in a green ring with a little pointer.
function vendorDirectoryMapIcon(v) {
  // No logo: the vendor's initials on a light colour that is stable per vendor, so pins are easy to tell apart.
  const seed = String(v?.id || v?.business_name || "?");
  let h = 0; for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  const words = String(v?.business_name || "?").replace(/[^\p{L}\p{N} ]/gu, "").trim().split(/\s+/).filter(Boolean);
  const ini = ((words[0]?.[0] || "?") + (words.length > 1 ? words[words.length - 1][0] : words[0]?.[1] || "")).toUpperCase();
  const initials = `<span class="vmp-ini">${esc(ini)}</span>`;
  const inner = lvVendorPic(v) ? `<img src="${esc(lvVendorPic(v))}" alt="" draggable="false" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'vmp-ini',textContent:'${esc(ini)}'}))">` : initials;
  const tint = v?.logo_url ? "" : ` style="--vmp-bg:hsl(${h} 70% 88%);--vmp-fg:hsl(${h} 55% 28%)"`;
  const tick = v?.id ? `<i class="fa-solid fa-circle-check lv-svi vmp-tick" data-vt="${esc(v.id)}" aria-label="Verified vendor"></i>` : "";
  return window.L.divIcon({ className: "vmp", html: `<div class="vmp-pin${v?.logo_url ? "" : " vmp-pin-ini"}"${tint}>${inner}${tick}</div>`, iconSize: [44, 52], iconAnchor: [22, 50], popupAnchor: [0, -46] });
}
// A rounded teardrop pin in the site's own accent color with a shop icon,
// instead of Leaflet's default generic blue marker.
function customerMapIcon() {
  return window.L.divIcon({
    className: "customer-map-pin",
    html: `<div class="customer-map-pin-inner"><i class="fa-solid fa-user"></i></div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 32],
    popupAnchor: [0, -28],
  });
}
function vendorMapIcon() {
  return window.L.divIcon({
    className: "vendor-map-pin",
    html: `<div class="vendor-map-pin-inner"><i class="fa-solid fa-shop"></i></div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 32],
    popupAnchor: [0, -28],
  });
}
// Straight-line distance in km -- fine at city scale, no need for real
// routing/driving distance for "how far is this vendor" purposes.
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
// A distance-priced delivery is never free: the first kilometre is always charged, then rate x distance, to the nearest N50.
const MAX_DELIVERY_PER_KM = 1000; // no vendor can charge more than this per kilometre
function distanceDeliveryFee(perKm, km) { return Math.round((Math.min(MAX_DELIVERY_PER_KM, Number(perKm) || 0) * Math.max(1, Number(km) || 0)) / 50) * 50; }
function lvDistTier(km){ return km<5?0:km<=10?1:km<=30?2:km<=100?3:km<=300?4:5; }
function lvDistTitle(km){ return ["Very close (within 5 km)","Same area (5-10 km)","Same city (10-30 km)","Nearby town (30-100 km)","Different region (100-300 km)","Interstate / far (over 300 km)"][lvDistTier(km)]; }
function formatDistanceKm(km) {
  return km < 1 ? `${Math.round(km * 1000)} m away` : `${km.toFixed(1)} km away`;
}
// A rough delivery-time estimate from straight-line distance -- real
// routing (actual roads, traffic right now) isn't available, so this is
// deliberately conservative (city-traffic speed, not highway) and always
// shown as a wide range rather than a single falsely-precise number, to
// avoid setting an expectation Levromart can't actually promise.
function estimateDeliveryRange(distanceKm) {
  const prepMin = 20; // packing + dispatch buffer
  const speedKmh = 15; // conservative urban delivery speed
  const travelMin = (distanceKm / speedKmh) * 60;
  const low = Math.max(15, Math.round(((prepMin + travelMin * 0.7) / 5)) * 5);
  const high = Math.max(low + 10, Math.round(((prepMin + travelMin * 1.3) / 5)) * 5);
  const fmt = (m) => (m >= 60 ? `${(m / 60).toFixed(m % 60 === 0 ? 0 : 1)} hr` : `${m} min`);
  return `${fmt(low)} - ${fmt(high)}`;
}
// Fast location strategy: render from the last known position immediately,
// then quietly refresh from the browser. This avoids making the Vendors page
// wait for a GPS fix before showing distance chips.
const BUYER_LOCATION_CACHE_KEY = "levromart-buyer-location";
// Distances are city-scale, so a position up to 12 hours old is still fine to show instantly; a fresh reading replaces it quietly.
const BUYER_LOCATION_CACHE_MAX_AGE = 12 * 60 * 60 * 1000;

function readCachedCustomerLocation() {
  try {
    const raw = localStorage.getItem(BUYER_LOCATION_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (!Number.isFinite(Number(cached?.lat)) || !Number.isFinite(Number(cached?.lng))) return null;
    if (Date.now() - Number(cached.updatedAt || 0) > BUYER_LOCATION_CACHE_MAX_AGE) return null;
    return { lat: Number(cached.lat), lng: Number(cached.lng) };
  } catch (e) { return null; }
}

function writeCachedCustomerLocation(loc) {
  try {
    localStorage.setItem(BUYER_LOCATION_CACHE_KEY, JSON.stringify({
      lat: Number(loc.lat), lng: Number(loc.lng), updatedAt: Date.now()
    }));
  } catch (e) {}
}

function getCurrentPositionOnce() {
  if (!("geolocation" in navigator)) return Promise.reject(new Error("Location isn't available on this device/browser."));
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(new Error(err.code === 1 ? "Location permission denied." : "Could not get your location.")),
      // Accuracy is deliberately relaxed here. Distance is straight-line
      // city-scale distance, so waiting for a high-accuracy GPS lock only
      // makes the UI slower without materially improving the displayed value.
      { enableHighAccuracy: false, maximumAge: 60 * 1000, timeout: 8000 }
    );
  });
}

// The cached position is available synchronously, so vendor cards can show
// their distance on the first paint. A fresh browser position replaces it
// silently afterwards.
let buyerLocation = readCachedCustomerLocation(); // { lat, lng } | null
let buyerLocationRequest = null;
let buyerLocationLastUpdatedAt = 0;
let buyerLocationLastError = null;
let buyerDistanceAutoEnabled = false;

function getCustomerLocation(forceRefresh = false) {
  if (!forceRefresh && buyerLocation) return Promise.resolve(buyerLocation);
  if (buyerLocationRequest) return buyerLocationRequest;
  buyerLocationRequest = getCurrentPositionOnce()
    .then((loc) => {
      // While a delivery place is picked on the map, a fresh GPS reading must not move it.
      if (window.__deliveryPin) window.__gpsLoc = loc; else buyerLocation = loc;
      buyerLocationLastUpdatedAt = Date.now();
      buyerLocationLastError = null;
      writeCachedCustomerLocation(loc);
      // Update visible vendor cards as soon as the fresh position arrives.
      if (byId("vendorsGrid")) filterVendorsDirectory();
      return loc;
    })
    .catch((err) => {
      buyerLocationLastError = err;
      throw err;
    })
    .finally(() => { buyerLocationRequest = null; });
  return buyerLocationRequest;
}

function hasAutomaticDistancePreference() {
  try { return localStorage.getItem("medris-distance-auto") === "1"; } catch (e) { return false; }
}
function setAutomaticDistancePreference(enabled) {
  buyerDistanceAutoEnabled = !!enabled;
  try { localStorage.setItem("medris-distance-auto", enabled ? "1" : "0"); } catch (e) {}
}

// The browser owns the real location permission. This helper lets us tell the
// difference between an already-granted permission and a permission that has
// been blocked/revoked, without inventing a location.
async function getBrowserLocationPermission() {
  try {
    if (!navigator.permissions?.query) return "unknown";
    const status = await navigator.permissions.query({ name: "geolocation" });
    return status?.state || "unknown";
  } catch (e) { return "unknown"; }
}

function locationRecoveryText(permissionState) {
  if (permissionState === "denied") return "Location access is off for Levromart. Turn it back on in your browser/device location settings, then tap Try again.";
  if (!locationSharingEnabled) return "Location sharing is off in Levromart Settings. Turn it on, then try again.";
  return "Allow location access once and Levromart will remember your choice and show distances automatically from then on.";
}

// Best-effort jump to the operating-system settings. Browsers do not expose a
// universal web API for opening their exact permission screen, so we attempt
// the platform settings URI and keep a clear fallback in the modal if the
// browser refuses the hand-off.
function openLocationSettings() {
  const ua = navigator.userAgent || "";
  try {
    if (/iPad|iPhone|iPod/i.test(ua)) {
      window.location.href = "app-settings:";
      return;
    }
    if (/Android/i.test(ua)) {
      window.location.href = "intent:#Intent;action=android.settings.LOCATION_SOURCE_SETTINGS;end";
      return;
    }
  } catch (e) {}
  showToast("Open your browser/device Settings and allow Location for Levromart, then return here and tap Try again.", "info");
}

function showLocationPrompt(mode = "first-use", errorMessage = "") {
  const modal = byId("locationPromptModal");
  if (!modal) return;
  const title = byId("locationPromptTitle");
  const copy = byId("locationPromptCopy");
  const primary = byId("locationPromptPrimary");
  const secondary = byId("locationPromptSecondary");
  const badge = modal.querySelector(".install-modal-badge i");
  const denied = mode === "recovery";

  if (title) title.textContent = denied ? "Turn on location" : "Show distances automatically";
  if (copy) copy.textContent = errorMessage || (denied
    ? ""
    : "Allow Levromart to use your current location. You only need to make this choice once. After that, vendor distances will refresh automatically whenever you refresh or return to Vendors.");
  if (denied) {
    const stateText = byId("locationPromptState");
    if (stateText) stateText.textContent = locationRecoveryText("denied");
    if (primary) { primary.innerHTML = '<i class="fa-solid fa-location-crosshairs"></i> Try again'; primary.onclick = () => retryCustomerLocationFromPrompt(); }
    if (secondary) { secondary.textContent = "Open Settings"; secondary.onclick = openLocationSettings; secondary.classList.remove("hidden"); }
    if (badge) badge.className = "fa-solid fa-location-crosshairs";
  } else {
    const stateText = byId("locationPromptState");
    if (stateText) stateText.textContent = "Your location is used only to calculate nearby-vendor distances and delivery estimates. It is not stored on our servers.";
    if (primary) { primary.innerHTML = '<i class="fa-solid fa-location-crosshairs"></i> Enable distances'; primary.onclick = () => enableAutomaticDistances(); }
    if (secondary) { secondary.textContent = "Not now"; secondary.onclick = () => resolveLocationPrompt(false); secondary.classList.remove("hidden"); }
    if (badge) badge.className = "fa-solid fa-location-dot";
  }
  modal.classList.remove("hidden");
  trackModalOpened("locationPromptModal");
}

function resolveLocationPrompt(granted) {
  byId("locationPromptModal")?.classList.add("hidden");
  if (dismissibleModalId === "locationPromptModal") dismissibleModalId = null;
  if (granted) setAutomaticDistancePreference(true);
}

async function requestCustomerLocation(forceRefresh = buyerDistanceAutoEnabled) {
  if (!locationSharingEnabled) throw new Error("Location sharing is off. Turn it on in Levromart Settings to use distance features.");
  return getCustomerLocation(forceRefresh);
}

async function enableAutomaticDistances() {
  // Tapping the recovery/enable control is an explicit opt-in, so it may
  // re-enable Levromart's own location switch if the user had turned that
  // switch off. The browser/device permission remains authoritative.
  if (!locationSharingEnabled) {
    locationSharingEnabled = true;
    try { localStorage.setItem("medris-location-enabled", "1"); } catch (e) {}
    renderLocationToggle();
  }
  try {
    await requestCustomerLocation(true);
    setAutomaticDistancePreference(true);
    updateVendorsLocationUI();
    filterVendorsDirectory();
    byId("locationPromptModal")?.classList.add("hidden");
    showToast("Distances enabled. They'll refresh automatically from now on.", "success");
    return true;
  } catch (err) {
    const state = await getBrowserLocationPermission();
    if (state === "denied") {
      showLocationPrompt("recovery", locationRecoveryText("denied"));
    } else {
      // The browser may still be in its permission prompt or may not expose
      // permission state. Keep the recovery UI useful without claiming why it failed.
      showLocationPrompt("recovery", err?.message || "We couldn't get your location yet. Allow location access and try again.");
    }
    return false;
  }
}

async function retryCustomerLocationFromPrompt() {
  byId("locationPromptModal")?.classList.add("hidden");
  try {
    await requestCustomerLocation(true);
    setAutomaticDistancePreference(true);
    updateVendorsLocationUI();
    filterVendorsDirectory();
    showToast("Location is on. Distances will now refresh automatically.", "success");
  } catch (err) {
    const state = await getBrowserLocationPermission();
    showLocationPrompt("recovery", state === "denied" ? locationRecoveryText("denied") : (err?.message || "Location is still unavailable."));
  }
}

// Settings-level kill switch. Turning this off clears the live location but
// does not destroy the one-time automatic-distance preference, so turning it
// back on can resume the feature without another onboarding choice.
let locationSharingEnabled = true;
function initLocationSetting() {
  locationSharingEnabled = localStorage.getItem("medris-location-enabled") !== "0";
  buyerDistanceAutoEnabled = hasAutomaticDistancePreference();
  renderLocationToggle();
}
function toggleLocationSetting() {
  locationSharingEnabled = !locationSharingEnabled;
  localStorage.setItem("medris-location-enabled", locationSharingEnabled ? "1" : "0");
  if (!locationSharingEnabled) {
    buyerLocation = null;
    buyerLocationLastError = new Error("Location sharing is off.");
  } else if (buyerDistanceAutoEnabled) {
    refreshCustomerLocationAutomatically();
  }
  renderLocationToggle();
  showToast(locationSharingEnabled ? "Location sharing turned on. Distances will refresh automatically." : "Location sharing turned off.", "success");
  updateVendorsLocationUI();
}
function renderLocationToggle() {
  const el = byId("locationToggleOption");
  if (!el) return;
  el.innerHTML = `<i class='fa-solid ${locationSharingEnabled ? "fa-location-dot" : "fa-location-crosshairs"}'></i> Location sharing: ${locationSharingEnabled ? "On" : "Off"}`;
}

async function refreshCustomerLocationAutomatically() {
  if (!buyerDistanceAutoEnabled || !locationSharingEnabled || !navigator.geolocation) return null;
  try {
    const loc = await requestCustomerLocation(true);
    updateVendorsLocationUI();
    // Only redraw the directory if it is actually on screen. This prevents
    // background refreshes from disturbing another page or resetting scroll.
    if (byId("vendorsGrid")) filterVendorsDirectory();
    return loc;
  } catch (err) {
    // Never remove a usable cached distance just because the fresh browser
    // lookup is slow or unavailable. The next successful refresh will replace it.
    buyerLocationLastError = err;
    updateVendorsLocationUI();
    return buyerLocation;
  }
}

let lastAutomaticLocationRefreshAt = 0;
function scheduleAutomaticLocationRefresh() {
  if (!buyerDistanceAutoEnabled || !locationSharingEnabled || !navigator.geolocation) return;
  const now = Date.now();
  // Avoid duplicate refreshes caused by the initial render + visibility/focus
  // events firing together, while still getting a fresh position on reload.
  if (now - lastAutomaticLocationRefreshAt < 2500) return;
  lastAutomaticLocationRefreshAt = now;
  refreshCustomerLocationAutomatically().catch(() => {});
}

window.addEventListener("pageshow", () => setTimeout(scheduleAutomaticLocationRefresh, 80));
window.addEventListener("focus", () => setTimeout(scheduleAutomaticLocationRefresh, 80));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") setTimeout(scheduleAutomaticLocationRefresh, 80);
});

