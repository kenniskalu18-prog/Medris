// Startup recovery: function declarations do not prove that a usable page rendered.
(function () {
  var began = Date.now();
  function release() {
    try { window.__levroSplashHidden = true; } catch (_) {}
    var splash = document.getElementById("levromartSplash");
    if (splash) { splash.classList.add("is-hidden"); splash.setAttribute("aria-hidden", "true"); }
  }
  // Any page that has drawn something counts (a product, a profile, notifications...), not only Home.
  function hasUsableHome(app) {
    return !!(app && (app.querySelector("#lv-startup-recovery") || (app.children.length && (app.textContent.trim().length || app.querySelector("img,svg,canvas,iframe")))));
  }
  function showRecovery(reason) {
    var app = document.getElementById("app");
    if (!app || app.querySelector("#lv-startup-recovery") || hasUsableHome(app)) return;
    console.warn("[Levromart startup] No usable marketplace first paint.", { elapsedMs: Date.now() - began, reason: reason || "timeout" });
    app.innerHTML = '<section id="lv-startup-recovery" role="status" style="min-height:45vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:2rem 1.25rem;gap:.75rem"><i class="fa-solid fa-shop" style="font-size:2rem;color:var(--primary,#159b70)"></i><strong>Marketplace temporarily unavailable</strong><span class="muted">The marketplace could not finish opening. Your account is safe. Check your connection and retry.</span><button type="button" class="btn" id="lv-startup-retry">Try again</button></section>';
    var retry = document.getElementById("lv-startup-retry");
    if (retry) retry.onclick = function () {
      if (typeof window.navigate === "function") {
        app.innerHTML = homeStartupShellHtml({ offline: navigator.onLine === false });
        Promise.resolve(window.navigate("home", {}, false)).catch(function (err) { console.warn("[Levromart startup] Retry failed.", err); });
      } else location.reload();
    };
  }
  // Only while the app is opening, and only when the page is still empty: first draw the page again quietly; the message
  // appears only if that also leaves it empty. Later errors (a failed request while browsing) never replace a page.
  var STARTUP_MS = 20000;
  var startup = function () { return Date.now() - began < STARTUP_MS; };
  setTimeout(function () {
    release();
    var app = document.getElementById("app");
    if (hasUsableHome(app)) return;
    try {
      if (typeof window.navigate === "function") Promise.resolve(window.navigate(typeof currentView === "string" && currentView ? currentView : "home", typeof currentViewParams === "object" && currentViewParams ? currentViewParams : {}, false)).catch(function () {});
    } catch (_) {}
    setTimeout(function () { if (!hasUsableHome(document.getElementById("app"))) showRecovery("first-paint-timeout"); }, 9000);
  }, 9000);
  function onStartupError(reason) {
    if (!startup() || Date.now() - began < 2500) return;
    var app = document.getElementById("app");
    if (hasUsableHome(app)) return;
    setTimeout(function () { if (startup() && !hasUsableHome(document.getElementById("app"))) { release(); showRecovery(reason); } }, 4000);
  }
  window.addEventListener("error", function (event) { onStartupError(event && event.message ? event.message : "script-error"); });
  window.addEventListener("unhandledrejection", function (event) { onStartupError(event && event.reason ? String(event.reason) : "unhandled-rejection"); });
})();
let currentView = "home";
let currentViewParams = {};
// So Levi can be told "the person is looking at page X" (and, if that page
// just crashed, what it crashed with) instead of only ever answering in
// the abstract -- cleared on every successful render, only ever reflects
// the CURRENT screen, never a stale one from earlier in the session.
let lastRenderError = null;
// A raw Postgres/Supabase/network error ("cannot add postgres_changes
// callbacks...", "Failed to fetch", etc.) means nothing to a customer or
// vendor and just reads as a code leak -- classify it into one plain,
// on-brand line with an icon instead. The real message still goes to the
// console for debugging, and lastRenderError above still carries it
// untouched for Levi's own diagnostic context.
function friendlyErrorText(err) {
  const raw = String(err?.message || err || "");
  console.error("Levromart error:", raw);
  const __f = window.__levroClassifyBackendError ? window.__levroClassifyBackendError(raw) : null;
  if (__f) return { icon: __f.icon, text: __f.text };
  if (/fetch|network|offline|websocket|realtime|socket|timeout|NetworkError/i.test(raw)) {
    return { icon: "fa-wifi", text: "Network trouble reaching Levromart. Check your connection and try again." };
  }
  return { icon: "fa-triangle-exclamation", text: "Something went wrong. Please try again in a moment." };
}
function errorStateHtml(err) {
  const { icon, text } = friendlyErrorText(err);
  const isNetwork = icon === "fa-wifi";
  const pic = typeof window.lv3dIcon === "function" ? window.lv3dIcon(isNetwork ? "tx-pending" : "out-of-stock", 96) : `<i class="fa-solid ${icon}" style="font-size:1.6rem;display:block;margin-bottom:0.6rem;"></i>`;
  return `<div class="empty-state lv-err-state ${isNetwork ? "levromart-network-error-state" : ""}">${pic}<strong>${isNetwork ? "Network trouble" : text}</strong></div>`;
}
function updateHeaderNavActive() {
  document.querySelectorAll(".header-nav-link").forEach((el) => el.classList.toggle("active", el.dataset.view === currentView));
}
let lastNonSettingsView = "home";
// Tokenize navigation so a slower request can never overwrite a newer tap.
let navigationGeneration = 0;
let messageChannelClosePromise = Promise.resolve();
// Keep the last successfully rendered screen in memory so returning to a
// page is instant. Fresh Supabase data still refreshes it in the background.
const routeHtmlCache = new Map();
const ORDER_ROUTE_SNAPSHOT_PREFIX = "levromart-order-route-v1:";
// Persist the last REAL rendered page, not a loading shell. This makes navigation
// cache-first across reloads so users see the page they asked for immediately
// while the live renderer silently reconciles fresh Supabase data underneath.
// The saved copy is tied to the release that made it. A copy saved by an older release has older markup; painted under
// the new styles it showed a jumbled page (stray icons under the name) until the real page arrived.
const LV_BUILD_TAG = (() => { try { const m = /[?&]v=(\d+)/.exec(document.querySelector('link[href*="01-base.css"]')?.getAttribute("href") || ""); return m ? m[1] : "0"; } catch (_) { return "0"; } })();
const ROUTE_HTML_SNAPSHOT_PREFIX = "levromart-route-html-v2-b" + LV_BUILD_TAG + ":";
(function dropOldRouteSnapshots() {
  try {
    [sessionStorage, localStorage].forEach((st) => {
      const old = [];
      for (let i = 0; i < st.length; i++) { const k = st.key(i); if (k && k.indexOf("levromart-route-html-v2") === 0 && k.indexOf(ROUTE_HTML_SNAPSHOT_PREFIX) !== 0) old.push(k); }
      old.forEach((k) => st.removeItem(k));
    });
  } catch (_) {}
})();
const ROUTE_HTML_SNAPSHOT_MAX = 500000;
function persistedRouteHtmlKey(view, params = {}) {
  return `${ROUTE_HTML_SNAPSHOT_PREFIX}${routeCacheKey(view, params)}`;
}
function isUsableRouteSnapshot(raw) {
  return !!(raw && raw.length > 100 && !/Your latest orders will refresh in the background\.|Refreshing in the background\.|Your latest shop data will refresh in the background\.|Opening…|Loading…|This shop is currently paused|Storefront not found|This (?:product|service|package) is not currently available|(?:Product|Package) not found|Couldn.t load this|Access denied|Please log in/i.test(raw));
}
function getPersistedRouteHtml(view, params = {}) {
  try {
    const key = persistedRouteHtmlKey(view, params);
    const raw = sessionStorage.getItem(key) || localStorage.getItem(key);
    return isUsableRouteSnapshot(raw) ? raw : null;
  } catch (_) { return null; }
}
function persistRouteHtml(view, params = {}, html) {
  if (!html || !isUsableRouteSnapshot(String(html))) return;
  const value = String(html);
  if (value.length > ROUTE_HTML_SNAPSHOT_MAX) return;
  try {
    const key = persistedRouteHtmlKey(view, params);
    sessionStorage.setItem(key, value);
    localStorage.setItem(key, value);
  } catch (_) {
    // Quota pressure should never block navigation. Keep the in-memory cache.
  }
}
function routeCacheKey(view, params = {}) {
  try { return `${view}:${JSON.stringify(params || {})}`; } catch (e) { return String(view); }
}
function navigationShellHtml(view) {
  const titleMap={vendorDashboard:"My Shop",vendorProducts:"My Listings",vendorPackages:"Packages",vendorEarnings:"Earnings",vendorOrders:"Orders",buyerOrders:"My Orders",orderDetail:"Order",adminPanel:"Admin",wishlist:"Wishlist",cart:"Cart",supportRequest:"Support request",vendors:"Vendors",notifications:"Notifications",buyerProfile:"My Profile",storefront:"Storefront",productDetail:"Product",packageDetail:"Package",contactUs:"Contact us",suggestionReplies:"Suggestion replies",leaderboard:"Leaderboard",adminPoints:"Points manager",search:"Search"};
  const iconMap={vendorDashboard:"fa-store",vendorProducts:"fa-box",vendorPackages:"fa-boxes-stacked",vendorEarnings:"fa-sack-dollar",vendorOrders:"fa-clipboard-list",buyerOrders:"fa-clipboard-list",orderDetail:"fa-file-invoice",adminPanel:"fa-shield-halved",wishlist:"fa-heart",cart:"fa-cart-shopping",supportRequest:"fa-headset",vendors:"fa-store",buyerProfile:"fa-user",storefront:"fa-store",productDetail:"fa-box",packageDetail:"fa-boxes-stacked",contactUs:"fa-address-book",suggestionReplies:"fa-comments",leaderboard:"fa-trophy",adminPoints:"fa-sliders",search:"fa-magnifying-glass"};
  const title=titleMap[view]||""; const icon=iconMap[view]||"fa-circle";
  if(!title)return "";
  if(view==="vendorProducts")return vlSkeletonHtml();
  // Never expose a background-refresh message as the page itself. If no real
  // snapshot exists yet, use a tiny neutral skeleton; the live renderer replaces
  // it as soon as its data arrives.
  return `<div class="instant-page-shell instant-route-opening" aria-hidden="true"><div class="instant-route-skeleton"><span></span><span></span><span></span></div></div>`;
}

function isOwnVendorId(vendorId) {
  return !!(session?.user?.id && vendor?.id && String(vendor.id) === String(vendorId));
}
function lvWorksForVendor(vendorId) {
  try { return !!vendorId && (window.lvMyTeams || []).some((t) => String(t.vendor_id) === String(vendorId)); } catch (_) { return false; }
}
function blockOwnVendorPurchase(vendorId, verb = "buy") {
  if (isOwnVendorId(vendorId)) { showToast(`You can't ${verb} from your own shop.`, "error"); return true; }
  if (lvWorksForVendor(vendorId)) { showToast(`You work for this shop, so you can't ${verb} from it.`, "error"); return true; }
  return false;
}
function withRouteTimeout(promise, ms = 7000, timeoutValue = null) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => { timer = setTimeout(() => resolve(timeoutValue), ms); })
  ]).finally(() => clearTimeout(timer));
}


function homeFallbackHtml(message = "The marketplace is taking a moment to load. Please try again.") {
  const safeMessage = typeof esc === "function" ? esc(message) : String(message).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c] || c));
  return `<div class="empty-state levro-home-fallback" role="status" aria-live="polite" style="min-height:48vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;">
    <div style="font-size:2rem;font-weight:850;letter-spacing:-.04em;color:var(--primary);margin-bottom:.55rem;">Levromart</div>
    <p class="muted" style="margin:0 auto .9rem;max-width:28rem;">${safeMessage}</p>
    <button type="button" class="btn" onclick="navigate('home',{},false)"><i class="fa-solid fa-rotate-right"></i> Try again</button>
  </div>`;
}

function fastNavigateHome(event) {
  try { event?.preventDefault?.(); event?.stopPropagation?.(); } catch (_) {}
  resetHomeFilters();
  const app = byId('app');
  // Paint the last known homepage immediately. The normal router then refreshes
  // Home in the background. This must never wait on Supabase before showing Home.
  try {
    if (app) {
      const cache = getOfflineHomeCache?.();
      if (cache) {
        const rendered = renderOfflineHomeFromCache(cache, { showOfflineNotice:false });
        if (rendered) { app.innerHTML = rendered; syncLeviFabVisibility(); updateHeaderNavActive(); }
      }
    }
  } catch (_) {}
  Promise.resolve(navigate('home', {}, false)).catch(() => {});
}

async function levroCommissionGate(view) {
  const restricted = new Set(["vendorDashboard","vendorEditProfile","vendorProducts","vendorPackages","vendorSuggestionsInbox","settings"]);
  if (!restricted.has(view) || !session || profile?.role !== "vendor" || !vendor?.id) return false;
  // The check is two network round trips: never make a tap wait for it. Check at most every 5 minutes, in the background; a
  // lock (rare now that commission comes off each payout) still shows its notice as soon as the answer arrives.
  if (Date.now() - (window.__lvGateAt || 0) < 300000) return false;
  window.__lvGateAt = Date.now();
  levroCommissionGateCheck();
  return false;
}
async function levroCommissionGateCheck() {
  return false;   // commission comes off each payout automatically; nothing is owed by hand, so nothing locks a shop
  try {
    // Repair any stale lock first, then evaluate the actual due_at timestamp.
    // A balance is allowed during its seven-day window. Only a charge whose
    // due_at has passed can automatically lock the storefront/tools.
    await sb.rpc("enforce_commission_deadlines", { p_vendor_id: vendor.id });
    const { data: deadline, error: deadlineError } = await sb.rpc("get_vendor_commission_deadline", { p_vendor_id: vendor.id });
    if (deadlineError || !deadline?.[0]?.earliest_due_at) return false;
    if (vendor.commission_pause_reason === 'admin_override') return false;
    if (new Date(deadline[0].earliest_due_at).getTime() > Date.now()) return false;
    const { data: owed, error } = await sb.rpc("get_vendor_commission_owed", { p_vendor_id: vendor.id });
    // Paystack won't transfer under ₦100, so gating a vendor's daily tools
    // over a smaller balance than that just locks them out for nothing
    // collectible yet -- let them keep working until it actually reaches ₦100.
    if (error || Number(owed || 0) < 100) return false;
    vendor.is_active = false;
    vendor.commission_paused = true;
    vendor.commission_pause_reason = "commission_overdue";
    showCommissionPaywall(Number(owed || 0));
    return true;
  } catch (_) { return false; }
}
function showCommissionPaywall(owedAmount) {
  document.getElementById("levroCommissionPaywall")?.remove();
  const modal = document.createElement("div");
  modal.id = "levroCommissionPaywall";
  modal.className = "modal open";
  modal.style.zIndex = "10000";
  modal.innerHTML = `<div class="modal-content" style="max-width:430px;text-align:center;">
    <div style="width:64px;height:64px;border-radius:50%;margin:0 auto .8rem;display:grid;place-items:center;background:#fff3cd;color:#b45309;font-size:1.5rem;"><i class="fa-solid fa-lock"></i></div>
    <h3 style="margin:.2rem 0 .5rem;">Pay commission to continue</h3>
    <p class="muted" style="margin:.4rem 0 .8rem;">Your storefront has been paused because you have an outstanding Levromart commission balance.</p>
    <div class="card" style="margin:.8rem 0;padding:.9rem;"><strong style="font-size:1.25rem;">${naira(Number(owedAmount || 0))}</strong><div class="muted" style="font-size:.8rem;margin-top:.2rem;">Commission outstanding</div></div>
    <p class="muted" style="font-size:.78rem;margin:.4rem 0 1rem;">Pay the outstanding balance to unlock your storefront and vendor tools.</p>
    <div style="display:flex;gap:.6rem;justify-content:center;flex-wrap:wrap;">
      <button type="button" class="btn" onclick="this.closest('.modal')?.remove(); payCommission();"><i class="fa-solid fa-credit-card"></i> Pay commission</button>
      <button type="button" class="btn btn-outline" onclick="this.closest('.modal')?.remove();">Close</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
}

async function navigate(view, params = {}, pushHistory = true) {
  if (await levroCommissionGate(view)) return;
  window.__lvNavPush = pushHistory;
  // A delivery place picked on the map only lasts for the cart / product / package page: leaving them puts back the real location.
  if (window.__deliveryPin && !["cart", "productDetail", "packageDetail"].includes(view)) { window.__deliveryPin = null; try { buyerLocation = window.__gpsLoc || null; } catch (_) {} window.__gpsLoc = null; }   // false = a refresh or a back move; the page-change animation reads this
  // every change of page slides: forwards (from the right) to go on, backwards (from the left) to go back; between the bottom
  // tabs it follows their order (Home, Vendors, Request, Notifications, Orders)
  const __TAB = { home: 0, vendors: 1, vendorsMap: 1, requestEquipment: 2, vendorRequests: 2, notifications: 3, buyerOrders: 4, vendorOrders: 4 };
  const __isSlideRoute = view !== currentView;
  const __previousIsSlideRoute = false;
  let __slidDone = false, __slideStart = 0;
  // One smooth glide per page change, run by the browser's animation engine (no leftover classes, no re-layout):
  // the page comes in from the side it belongs to and fades up. The same motion is used for every page, Home included.
  const __slideEnterNow = (appEl) => {
    if (!__isSlideRoute || !appEl || __slidDone) return; __slidDone = true; __slideStart = Date.now();
    try {
      if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const dx = __slideDir * 28;
      appEl.getAnimations?.().forEach((a) => a.cancel());
      appEl.animate([{ transform: `translate3d(${dx}px,0,0)`, opacity: 0.35 }, { transform: "translate3d(0,0,0)", opacity: 1 }], { duration: 240, easing: "cubic-bezier(.22,.75,.25,1)" });
    } catch (_) {}
  };
  const __slideDir = view in __TAB && currentView in __TAB ? (__TAB[view] >= __TAB[currentView] ? 1 : -1) : pushHistory === false ? -1 : 1;
  // Leaving the notification surface commits the unread items that were
  // visible during this visit. This covers Back, bottom-nav taps, links, and
  // any other route transition that does not pass through closeAllPanels().
  if (currentView === "notifications" && view !== "notifications") {
    try { Promise.resolve(commitPendingNotificationReads()).catch(() => {}); } catch (_) {}   // saved in the background: never hold the tap
  }
  try { window.closeLevromartTransientFilters?.(); } catch (_) {}
  // REACT-REGISTRY HOOK (1/4): release the React screen that is on display, if any, before
  // #app is replaced. No-op unless a screen has been switched on (see docs/REACT_MIGRATION.md).
  try { window.levroReact?.unmount(); } catch (_) {}
  const app = byId("app");
  // Re-rendering the whole page on every admin tab tap wipes the horizontal
  // scroll position of the admin tab rail itself, snapping it back to the
  // start instead of staying where the admin scrolled to find that tab.
  // Captured once up front since the page can go through more than one
  // app.innerHTML swap below (an instant shell, then the real content).
  const __adminTabsScrollLeft = app?.querySelector(".admin-dash-tabs-inner")?.scrollLeft || 0;
  const restoreAdminTabsScroll = () => {
    if (!__adminTabsScrollLeft) return;
    const rail = app?.querySelector(".admin-dash-tabs-inner");
    if (rail) rail.scrollLeft = __adminTabsScrollLeft;
  };
  // Accept both the historical boolean and the newer {replace:true} form so
  // every internal destination still uses one router without accidental
  // duplicate browser-history entries.
  const navOptions = pushHistory && typeof pushHistory === "object" ? pushHistory : null;
  const shouldPushHistory = navOptions ? navOptions.replace !== true : pushHistory !== false;
  // The vendors map owns DOM/native map resources. Destroy it before #app is
  // swapped to another route; doing this here keeps map cleanup in the
  // canonical router rather than in a second competing navigate wrapper.
  try {
    if (currentView === "vendors" && view !== "vendors" && typeof vendorsMap !== "undefined" && vendorsMap) {
      try { vendorsMap.remove(); } catch (_) {}
      vendorsMap = null;
      if (typeof vendorsMapMarkers !== "undefined") vendorsMapMarkers = [];
    }
  } catch (_) {}
  try { if (currentView === "vendorsMap" && view !== "vendorsMap" && typeof vmpDestroy === "function") vmpDestroy(); } catch (_) {}
  if (navOptions && navOptions.replace) pushHistory = false;
  else pushHistory = shouldPushHistory;
  // A suspended account is locked to this one screen no matter what it
  // tries to navigate to -- appealing (or logging out) is all that's left.
  if (profile?.suspended_at && view !== "suspended") view = "suspended";
  const navToken = ++navigationGeneration;
  const previousView = currentView;
  if (view === "vendorsMap" && previousView !== "vendorsMap") window.__vmpReturnRoute = { view: previousView || "home", params: currentViewParams || {} };
  const homeStartScroll = view === "home" ? window.scrollY : null;
  // Remember exactly where the user was scrolled to on Home before leaving
  // it (to view a product, open a vendor, etc.) so a Back navigation can
  // return them to that same spot instead of snapping back to the top.
  if (previousView === "home" && view !== "home") window.__levroHomeScrollY = window.scrollY;
  if (previousView !== view && (previousView === "buyerProfile" || previousView === "vendorDashboard")) (window.__levroProfScroll ||= {})[previousView] = window.scrollY;
  window.__levroProfCurrentY = window.scrollY;

  // Protected routes must never render their access guard while Supabase is
  // still restoring the cached session/profile in the background. This is the
  // common source of the brief "Access denied" flash/tap on routes such as
  // My Shop and Requests. Reuse the shared in-flight auth refresh when one
  // exists; otherwise kick off one bounded refresh before rendering.
  const protectedRouteViews = new Set([
    "cart","messages","vendorDashboard","vendorProducts","vendorPackages",
    "vendorEarnings","vendorWallet","walletHistory","vendorFollowers","vendorOrders","vendorEditProfile","vendorRequests",
    "settings","supportRequest","suggestionReplies","wishlist","buyerOrders","myEquipmentRequests","orderHistory","orderDetail","leaveReview",
    "adminPanel","adminCarousel","adminLinkLibrary","adminDisputes","adminPayments","adminWalletHistory",
    "adminSupportRequests","adminPasswordResets","adminInventory","adminOrders","adminPeople","adminFeedback","adminUsers",
    "adminFinance","adminCampuses","adminLog","adminMonthlyListings","adminConversations","vendorSuggestionsInbox","requestEquipment","notifications","customerFollowing","buyerProfile","adminR2Migration","adminR2Optimize"
  ]);
  if (protectedRouteViews.has(view) && (!session || !profile)) {
    try {
      // Navigation is never held hostage by profile hydration. A live session
      // is enough to start rendering; role/vendor hydration continues through
      // the existing auth listener and bounded renderer checks. Only a truly
      // missing session gets a short recovery window.
      if (!session) {
        await Promise.race([
          refreshAuthStateOnce(),
          new Promise(resolve => setTimeout(resolve, 1200))
        ]);
      }
    } catch (_) {}
  }
  // Sensitive admin areas are super-admin only. This is a route-level guard
  // as well as a hidden-tab rule, so a regular admin cannot reach them by a
  // direct URL/deep link or a manually constructed navigate() call.
  if (profile?.role === "admin" && !isSuperAdmin() && SUPER_ADMIN_ONLY_VIEWS.has(view)) {
    view = "adminDisputes";
    params = {};
  }

  if (view !== "settings" && previousView !== "settings") lastNonSettingsView = previousView || "home";
  // Closing a Realtime channel is a network operation. Never make a normal
  // navigation tap wait for it; queue the close in the background and only
  // make a new chat subscription wait for the queue.
  if (view !== "messages" && activeMsgChannel) {
    const channelToClose = activeMsgChannel;
    activeMsgChannel = null;
    activeConversationId = null;
    messageChannelClosePromise = Promise.resolve(sb.removeChannel(channelToClose)).catch(() => {});
  }
  currentView = view;
  document.body.classList.toggle("vendors-map-full-page", view === "vendorsMap");
  document.body.classList.toggle("vendors-map-hide-dock", view === "vendorsMap");
  if (view !== "vendors") document.getElementById("vmpReturnMapBtn")?.remove();
  currentViewParams = params || {};
  try { syncLevromartLinkPreviewMeta(view, currentViewParams); } catch (_) {}
  // A single open DM thread gets the dedicated, chrome-free full-page
  // treatment (see #dedicated-chat-page-fix); the conversation list and
  // the admin's read-only viewer keep the normal in-app layout.
  document.body.classList.toggle("chat-full-page", view === "messages" && !!(params && params.conversationId) && profile?.role !== "admin");
  // The dedicated search page has its own back-button + input bar, so the
  // persistent header's search pill above it is a redundant second search
  // box -- hide the header entirely while this view is open (see
  // #dedicated-search-page-fix).
  document.body.classList.toggle("search-full-page", view === "search");
  document.body.classList.toggle("product-detail-view", view === "productDetail" || view === "packageDetail");
  if (view !== "productDetail") window.__lastRenderedProductPreview = null;
  // Instant paint: if we already have this conversation's name/photo from
  // the inbox list, show the real header + a spinner right away instead of
  // leaving the old screen sitting there while the network calls below
  // (other-party lookup, conversation row, messages) are still in flight --
  // that wait was what made opening a DM feel like it "popped" the inbox
  // page first. The real render below still replaces this once it's ready.
  if (view === "messages" && params?.conversationId && profile?.role !== "admin") {
    window.__chatFastPaintDirty = false;
    const cachedConv = (window.__conversations || []).find((c) => c.conversation_id === params.conversationId) || { conversation_id: params.conversationId, other_name: "Chat", other_avatar: null, unread_count: 0 };
    const cachedMessages = lastSeenMessagesByConv.get(params.conversationId) || chatSnapRead(params.conversationId)?.messages;
    // Always paint the chat surface immediately, even for a deep link where
    // the inbox has not been hydrated yet. Network hydration replaces only
    // the stale content later; there is never a central loading spinner.
    app.innerHTML = chatSkeletonHtml(params.conversationId, cachedConv, cachedMessages);
    if (cachedMessages?.length) requestAnimationFrame(scrollChatToBottom);
  }
  updateAuthUI();
  renderBottomNav();
  updateHeaderNavActive();
  if (pushHistory) {
    const navUrl = view === "storefront" && params?.vendorId
      ? `${location.pathname}?storefront=${encodeURIComponent(params.vendorId)}`
      : view === "packageDetail" && params?.packageId
        ? `${location.pathname}?package=${encodeURIComponent(params.packageId)}`
        : view === "productDetail" && params?.productId
          ? `${location.pathname}?product=${encodeURIComponent(params.productId)}`
          : view === "notifications"
            ? `${location.pathname}?levro=notifications`
            : `${location.pathname}?appView=${encodeURIComponent(view)}&appParams=${encodeURIComponent(JSON.stringify(params || {}))}`;
    history.pushState({ view, params }, "", navUrl);
  }
  // Mobile browsers (and installed PWAs especially) routinely discard a
  // backgrounded tab's JS state and reload it fresh when you switch back -
  // that's not a bug we can prevent, but without this, every one of those
  // silent reloads dumped you back to Home. sessionStorage survives a
  // reload within the same tab/session, so init() below can resume here
  // instead.
  try { sessionStorage.setItem("medris_last_view", JSON.stringify({ view, params })); } catch (e) {}
  try { window.__levromartPersistedRoute?.(view, params); } catch (e) {}
  if (view !== "storefront") resetStorefrontSocialMeta();
  if (view !== "home") { resetHomeSearchScrollMotion(); if (homeCarouselTimer) { clearInterval(homeCarouselTimer); homeCarouselTimer = null; } }
  // Paint the destination immediately. Reuse a previously rendered screen
  // when available; otherwise show a lightweight page shell. Do not block a
  // tap on Supabase and do not show a generic "Loading..." page.
  const hasChatFastPath = view === "messages" && !!params?.conversationId && profile?.role !== "admin";
  const cacheKey = routeCacheKey(view, params);
  // REACT-REGISTRY HOOK (2/4): a screen that React draws (migrated AND switched on) never uses
  // a saved legacy HTML snapshot. With every switch off, reactView is null and nothing changes.
  const reactView = window.levroReact?.isOn(view) ? view : null;
  const cachedRouteHtml = reactView ? undefined : routeHtmlCache.get(cacheKey);
  const persistedRouteHtml = reactView ? "" : getPersistedRouteHtml(view, params);
  const instantRouteHtml = (cachedRouteHtml && isUsableRouteSnapshot(String(cachedRouteHtml))) ? cachedRouteHtml : persistedRouteHtml;
  // Switching between "Orders from customers" and "My purchases" is a different page: show the copy from the last visit at
  // once (then the fresh one), instead of waiting for both lists to load again. Status pills on one tab keep their own path.
  const ordersSide = view === "vendorOrders" ? (params?.perspective === "purchases" ? "purchases" : "sales") : null;
  const ordersSideChanged = !!ordersSide && previousView === view && window.__lvOrdersSide && window.__lvOrdersSide !== ordersSide;
  if (ordersSide) window.__lvOrdersSide = ordersSide;
  const sameOrdersTab = previousView === view && (view === "buyerOrders" || view === "vendorOrders") && !(ordersSideChanged && instantRouteHtml);
  if (app && (pushHistory || previousView !== view) && !hasChatFastPath && view !== "home" && !sameOrdersTab && !window.__lvSwipeNav && !window.__lvUseSnap) {
    // Storefront used to be excluded here, on the assumption its own
    // renderer was now fast enough not to need a shell. But the very first
    // visit to any given vendor in a session has no cached HTML yet, so
    // this left the screen showing nothing at all -- not even a spinner --
    // for the whole network round trip, which is exactly what read as a
    // multi-second "stall" after tapping a vendor card. Every other route
    // already gets an instant shell; storefront now does too.
    if (instantRouteHtml) {
      app.innerHTML = instantRouteHtml;
    } else {
      // Pages that render instantly never show a placeholder; slower ones show it on the very next tick so the tap responds at once.
      clearTimeout(window.__lvShellTimer);
      window.__lvShellTimer = setTimeout(() => {
        if (navToken !== navigationGeneration) return;
        app.innerHTML = navigationShellHtml(view);
        restoreAdminTabsScroll();
      }, 0);
    }
    restoreAdminTabsScroll();
    syncLeviFabVisibility();
    hideLevromartSplash();
    clearAutoScrollTimers();
  } else if (app && (pushHistory || previousView !== view) && !hasChatFastPath && view === "home" && cachedRouteHtml && !window.__levroCategorySwitch && !window.__lvUseSnap) {
    // Reuse a previously rendered real page while the original renderer refreshes it.
    app.innerHTML = cachedRouteHtml;
    __slideEnterNow(app);
    try { initHomepageCarousel(); } catch (_) {}
    restoreAdminTabsScroll();
    syncLeviFabVisibility();
    hideLevromartSplash();
    clearAutoScrollTimers();
  }
  // Home is cache-first: if this device has a previously rendered marketplace,
  // paint it immediately before any Supabase request begins. The live renderer
  // below still refreshes the data in the background and replaces this content
  // only when the fresh render is ready. This prevents the Home fallback/loading
  // state from ever becoming the visible result of a slow or transient request.
  if (view === "home" && app && !reactView && !routeHtmlCache.has(cacheKey) && !window.__levroCategorySwitch && !window.__lvUseSnap) {
    let painted = false;
    try { painted = paintHomeFromLocalCatalog(false); } catch (err) {
      console.warn("[Levromart startup] Cached homepage paint failed.", err);
    }
    if (painted) __slideEnterNow(app);
    if (!painted && !app.querySelector(".levro-home-startup")) {
      app.innerHTML = homeStartupShellHtml({ offline: browserLooksOffline() });
      try { syncLeviFabVisibility(); initHomepageCarousel(); } catch (_) {}
    }
    try { hideLevromartSplash(); } catch (_) {}
  }
  let html;
  let __levroRouteHadRenderError = false;
  try {
    // REACT-REGISTRY HOOK (3/4): React draws this screen into an empty placeholder (mounted
    // below, right after #app is filled); otherwise the legacy renderer runs as always.
    if (reactView) html = window.levroReact.placeholderHtml(view);
    else switch (view) {
      case "home": html = await renderHome(); break;
      case "productDetail": html = await renderProductDetail(params.productId); break;
      case "packageDetail": html = await renderPackageDetail(params.packageId); break;
      case "storefront": html = await renderStorefront(params.vendorId); break;
      case "vendors": html = renderVendorsDirectory(); break;
      case "vendorsMap": html = renderVendorsMapPage(); break;
      case "vendorApply": html = await renderVendorApply(); break;
      case "vendorDashboard": html = await renderVendorDashboard(); break;
      case "vendorEditProfile": html = await renderVendorEditProfile(); break;
      case "editProfile": html = renderEditProfile(); break;
      case "profileSetup": html = renderProfileSetup(); break;
      case "buyerProfile": html = await renderBuyerProfile(); break;
      case "settings": html = renderSettingsPage(); break;
      case "vendorProducts": html = await renderVendorProducts(); break;
      case "vendorPackages": html = await renderVendorPackages(); break;
      case "vendorEarnings": html = await renderVendorEarnings(); break;
      case "vendorFollowers": html = await renderVendorFollowersPage(); break;
      case "vendorFollowerNetwork": html = await renderVendorFollowerNetwork(params.vendorId); break;
      case "vendorOrders": html = await renderVendorOrders(params.status, params.type, params.payment, params.dateFrom, params.dateTo, params.perspective || "sales"); break;
      case "buyerOrders": html = await renderCustomerOrders(params.status, params.type, params.payment, params.dateFrom, params.dateTo); break;
      case "orderHistory": html = await renderOrderHistoryPage(params.perspective || ""); break;
      case "orderDetail": html = await renderOrderDetail(params.orderId, params.source); break;
      case "leaveReview": html = await renderLeaveReview(params.orderId); break;
      case "adminPanel": html = await renderAdminPanel(params.status); break;
      case "adminCarousel": html = await renderAdminCarousel(); break;
      case "adminR2Migration": html = renderAdminR2Migration(); break;
      case "adminR2Optimize": html = renderAdminR2Optimize(); break;
      case "adminLinkLibrary": html = renderAdminLinkLibrary(); break;
      case "adminDisputes": html = await renderAdminDisputes(); break;
      case "adminPayments": html = await renderAdminPayments(); break;
      case "adminWalletHistory": html = await renderAdminWalletHistory(); break;
      case "adminSupportRequests": html = await renderAdminSupportRequests(); break;
      case "adminPasswordResets": html = await renderAdminPasswordResets(); break;
      case "adminInventory": html = await renderAdminInventory(); break;
      case "adminOrders": html = await renderAdminOrders(); break;
      case "adminPeople": html = await renderAdminPeople(); break;
      case "adminFeedback": html = await renderAdminFeedback(); break;
      case "vendorSuggestionsInbox": html = await renderVendorSuggestionsInbox(); break;
      case "vendorWallet": html = await renderVendorWallet(); break;
      case "walletHistory": html = renderWalletHistoryPage(); break;
      case "adminUsers": html = await renderAdminUsers(); break;
      case "adminFinance": html = await renderAdminFinance(); break;
      case "adminCampuses": html = await window.renderAdminCampuses(); break;
      case "adminLog": html = await renderAdminLog(); break;
      case "adminAuthLogs": html = await renderAdminAuthLogs(); break;
      case "adminConversations": html = await renderAdminConversations(params.q || ""); break;
      case "adminMonthlyListings": html = await renderAdminMonthlyListings(); break;
      case "wishlist": html = await renderWishlist(); break;
            case "customerFollowing": html = await renderCustomerFollowing(); break;
      case "customerFollowing": html = await renderCustomerFollowing(); break;
      case "cart": html = await renderCart(); break;
      case "messages": html = await renderMessages(params.conversationId); break;
      case "notifications": html = renderNotificationsPage(); break;
      case "requestEquipment": html = await renderRequestEquipment(); break;
      case "myEquipmentRequests": html = await renderMyEquipmentRequests(); break;
      case "supportRequest": html = await renderSupportRequest(); break;
      case "contactUs": html = renderContactUs(); break;
      case "suggestionReplies": html = await renderSuggestionReplies(); break;
      case "leaderboard": html = renderLeaderboard(params); break;
      case "adminPoints": html = renderAdminPoints(); break;
      case "search": html = renderSearchPage(); break;
      case "vendorRequests": html = await renderVendorRequests(); break;
      case "terms": html = renderTerms(); break;
      case "privacy": html = renderPrivacy(); break;
      case "refundPolicy": html = renderRefundPolicy(); break;
      case "sharedAiChat": html = await renderSharedAiChat(params.token); break;
      case "suspended": html = await renderSuspendedScreen(); break;
      default: html = await renderHome();
    }
    lastRenderError = null;
    /* A restored Supabase session can briefly exist before the role/vendor row
       has finished resolving. If a protected renderer nevertheless returned
       its guard page, give auth one bounded retry before committing that HTML.
       This fixes the tap -> Access denied -> refresh behavior without changing
       any permissions or backend rules. */
    if (protectedRouteViews.has(view) && /Access denied\.?<\/div>/i.test(String(html || ""))) {
      try {
        await refreshAuthStateOnce();
        if (view !== "home") {
          switch (view) {
            case "vendorDashboard": html = await renderVendorDashboard(); break;
            case "vendorProducts": html = await renderVendorProducts(); break;
            case "vendorPackages": html = await renderVendorPackages(); break;
            case "vendorEarnings": html = await renderVendorEarnings(); break;
            case "vendorWallet": html = await renderVendorWallet(); break;
            case "walletHistory": html = renderWalletHistoryPage(); break;
            case "vendorFollowers": html = await renderVendorFollowersPage(); break;
            case "vendorFollowerNetwork": html = await renderVendorFollowerNetwork(params.vendorId); break;
            case "vendorOrders": html = await renderVendorOrders(params.status, params.type, params.payment, params.dateFrom, params.dateTo, params.perspective || "sales"); break;
            case "vendorEditProfile": html = await renderVendorEditProfile(); break;
            case "vendorRequests": html = await renderVendorRequests(); break;
            case "buyerProfile": html = await renderBuyerProfile(); break;
            case "messages": html = await renderMessages(params.conversationId); break;
            case "cart": html = await renderCart(); break;
            case "wishlist": html = await renderWishlist(); break;
            case "buyerOrders": html = await renderCustomerOrders(params.status, params.type, params.payment, params.dateFrom, params.dateTo); break;
            case "orderHistory": html = await renderOrderHistoryPage(params.perspective || ""); break;
            case "orderDetail": html = await renderOrderDetail(params.orderId, params.source); break;
            case "requestEquipment": html = await renderRequestEquipment(); break;
            default: break;
          }
        }
      } catch (retryErr) {
        console.warn("[Levromart] Protected route auth retry failed:", retryErr);
      }
      // Never commit an Access denied guard merely because auth/vendor state
      // is still settling. If a real session exists, keep the destination
      // shell visible and let the bounded background retry replace it with
      // the real page as soon as the authoritative role/vendor row arrives.
      if (/Access denied\.?<\/div>/i.test(String(html || "")) && session) {
        html = navigationShellHtml(view) || '<div class="page-loading-shell"><span class="page-loading-spinner"><i class="fa-solid fa-circle-notch fa-spin"></i></span><span>Opening…</span></div>';
        setTimeout(() => {
          if (navigationGeneration !== navToken || !session) return;
          refreshAuthStateOnce().then(() => {
            if (navigationGeneration !== navToken) return;
            return navigate(view, params, false);
          }).catch(() => {});
        }, 180);
      }
    }
  } catch (err) {
    __levroRouteHadRenderError = true;
    lastRenderError = err?.message || String(err || "");
    const cachedFallback = routeHtmlCache.get(cacheKey);
    if (cachedFallback) {
      html = cachedFallback;
      lastRenderError = null;
    } else if (view === "home") {
      const cachedHome = getOfflineHomeCache();
      // Home is cache-first. If a previous real marketplace is already painted,
      // leave it on screen and let the failed refresh disappear silently. Never
      // replace a usable Home surface with a generic loading/fallback page.
      const existingHome = app?.innerHTML?.trim() || "";
      const existingHomeIsReal = existingHome && !/Levromart is still loading|The marketplace is taking a moment to load|We could not load the marketplace right now/i.test(existingHome);
      if (existingHomeIsReal && existingHome.length > 300) {
        html = existingHome;
      } else if (cachedHome) {
        html = renderOfflineHomeFromCache(cachedHome, { showOfflineNotice:false });
      } else {
        // Last-resort first paint: keep a clean marketplace shell rather than
        // showing a failure message. The next successful refresh fills it.
        html = renderOfflineHomeFromCache({ categories:[], sectors:[], trending:[], browseProducts:[], topVendors:[], recentProducts:[], packages:[], carouselSlides:[] }, { showOfflineNotice:false }) || `<div class="empty-state" style="min-height:40vh;display:flex;align-items:center;justify-content:center;"><i class="fa-solid fa-shop" style="font-size:2rem;color:var(--primary);"></i></div>`;
      }
      lastRenderError = null;
    } else if (view === "storefront") {
      // A network blip inside renderStorefront (or its queries rejecting
      // outright, which supabase-js does for true connectivity failures)
      // used to leave this branch quietly re-painting whatever loading
      // shell was already on screen -- a permanent spinner with no error
      // and no way forward except a manual page reload. Give it the same
      // explicit retry affordance vendorApply already has below.
      html = `<div class="card" style="max-width:480px;margin:2rem auto;text-align:center;">
        <i class="fa-solid fa-triangle-exclamation" style="font-size:2rem;color:var(--primary);margin-bottom:.65rem;"></i>
        <h2 style="margin:.1rem 0 .45rem;">Couldn't load this storefront</h2>
        <p class="muted" style="margin:0 auto 1rem;">Check your connection and try again.</p>
        <div class="flex" style="justify-content:center;gap:.5rem;flex-wrap:wrap;">
          <button type="button" class="btn" onclick="navigate('storefront',${JSON.stringify(params || {})},false)"><i class="fa-solid fa-rotate-right"></i> Try again</button>
          <button type="button" class="btn btn-outline" onclick="navigate('home')">Go to marketplace</button>
        </div>
      </div>`;
    } else if (view === "home") {
      html = app?.innerHTML?.trim() ? app.innerHTML : '<div class="empty-state">Please try again.</div>';
    } else if (view === "vendorApply") {
      html = `<div class="card" style="max-width:480px;margin:0 auto;text-align:center;">
        <i class="fa-solid fa-store" style="font-size:2rem;color:var(--primary);margin-bottom:.65rem;"></i>
        <h2 style="margin:.1rem 0 .45rem;">Vendor application unavailable</h2>
        <p class="muted" style="margin:0 auto 1rem;">We couldn't open the existing vendor application form right now. Your account is still signed in.</p>
        <div class="flex" style="justify-content:center;gap:.5rem;flex-wrap:wrap;">
          <button type="button" class="btn" onclick="navigate('vendorApply')"><i class="fa-solid fa-rotate-right"></i> Try again</button>
          <button type="button" class="btn btn-outline" onclick="navigate('home')">Go to marketplace</button>
        </div>
      </div>`;
    } else {
      html = navigationShellHtml(view) || '<div class="empty-state">This page is temporarily unavailable. Please try again.</div>';
    }
  }
  clearTimeout(window.__lvShellTimer);
  // Ignore an older request if the user has already navigated somewhere else.
  if (navToken !== navigationGeneration) return;
  if (html && !lastRenderError && !reactView) {
    if (isUsableRouteSnapshot(String(html))) routeHtmlCache.set(cacheKey, html); else routeHtmlCache.delete(cacheKey);
    persistRouteHtml(view, params, html);
  }
  const preserveSameViewScroll = !pushHistory && previousView === view;
  const sameViewScrollY = preserveSameViewScroll ? window.scrollY : 0;
  // New route transitions are animated visually, but scroll is never animated.
  // Disable browser scroll anchoring during the render swap so image/font/content
  // hydration cannot repeatedly pull the viewport up and down.
  const routeScrollSnapshot = preserveSameViewScroll ? sameViewScrollY : 0;
  document.documentElement.classList.add("lv-route-transitioning");
  const preserveActiveFastChat = view === "messages" && !!currentViewParams?.conversationId && !!byId("chatInput") && window.__chatFastPaintDirty === true;
  if (preserveActiveFastChat) {
    // The user has already started typing into the instant-painted chat. Do
    // not replace their live DOM with the slower hydrated copy. The realtime
    // channel and background fetch will reconcile messages without losing the
    // text they are composing.
    return;
  }
  // Storefront follow button: this same cache-then-refresh swap can land
  // moments after the user taps Follow/Unfollow, fully replacing the page
  // (including that button) with a fresh render that always starts back at
  // its own disabled loading spinner until its own hydration resolves --
  // clobbering an already-confirmed tap and reading as the button
  // "twitching" back off. Carry the live wrap's content across the swap
  // when it's already a real, interactive button for this same vendor.
  let liveStorefrontFollowHtml = null;
  if (view === "storefront" && params?.vendorId) {
    const liveWrap = byId("storefrontFollowWrap");
    if (liveWrap && liveWrap.dataset.followVendorId === String(params.vendorId) && !liveWrap.querySelector(".follow-btn[disabled]")) {
      liveStorefrontFollowHtml = liveWrap.innerHTML;
    }
  }
  // if Home was already painted from the saved copy and is gliding in, the fresh copy waits for the glide to end so nothing jumps
  if (__slidDone && __slideStart && Date.now() - __slideStart < 260) await new Promise((r) => setTimeout(r, 260 - (Date.now() - __slideStart)));
  app.innerHTML = html;
  __slideEnterNow(app);
  // REACT-REGISTRY HOOK (4/4): draw the React screen into the placeholder. If React is late or
  // the screen fails, the registry switches that screen off for the session and the legacy
  // screen is rendered instead, so the page is never left blank.
  if (reactView) {
    window.levroReact.mount(view, params || {}).then((shown) => {
      if (!shown && navToken === navigationGeneration) navigate(view, params, false);
    });
  }
  try { setTimeout(() => window.maybePromptLevromartReview?.(), 900); } catch (_) {}
  try { if (vendor?.id && !window.__prodRefs) setTimeout(() => warmProductModalRefs(), 1200); } catch (_) {}
  try {
    if (session && !window.__dtTipChecked) {
      window.__dtTipChecked = true;
      if (localStorage.getItem("levro-dt-tip-v1") !== "1") setTimeout(() => {
        if (document.querySelector("#app .product-card-wrap")) { showToast("Tip: double-tap any product to save it to your wishlist.", "info"); localStorage.setItem("levro-dt-tip-v1", "1"); } else window.__dtTipChecked = false;
      }, 3500);
    }
  } catch (_) {}
  if (liveStorefrontFollowHtml) {
    const freshFollowWrap = byId("storefrontFollowWrap");
    if (freshFollowWrap) freshFollowWrap.innerHTML = liveStorefrontFollowHtml;
  }
  restoreAdminTabsScroll();
  // Now that this view's HTML is actually in the DOM, it's safe to apply the
  // storefront's stats/reviews/packages/follow-state hydration -- doing it
  // any earlier (back inside renderStorefrontInner) was a race that often
  // lost, leaving the follow button spinning forever. See the comment on
  // window.__storefrontExtrasPending.
  if (view === "storefront" && params?.vendorId && window.__storefrontExtrasPending?.vendorId === String(params.vendorId)) {
    const pending = window.__storefrontExtrasPending;
    window.__storefrontExtrasPending = null;
    void pending.apply().catch((e) => console.warn("[Levromart] Storefront extras hydration failed:", e));
  }
  if (!__levroRouteHadRenderError) hideLevromartSplash();
  if (view === "notifications") void renderNotifPanel();
  if (view === "leaderboard") void window.initLeaderboardPage?.();
  if (view === "adminPoints") void window.initAdminPoints?.();
  if (view === "orderDetail" || view === "adminDisputes") setTimeout(() => window.hydrateDisputeEvidence?.(), 60);
  if (view === "home") setTimeout(() => window.mountHomeLeaderboardCard?.(), 120);
  if (view === "home") setTimeout(() => { try { filterHomeProducts(); } catch (_) {} }, 0);
  syncLeviFabVisibility();
  hideLevromartSplash();
  clearAutoScrollTimers();
  applyHorizontalBrowsePreference();
  document.querySelectorAll("#app .cat-row, #app .hscroll, #app .storefront-product-strip").forEach((el) => {
    if (horizontalBrowseEnabled) setupAutoScroll(el);
  });
  // initHomeSearchScrollMotion() used to pin the hero search bar under the
  // header once you scrolled past it. Now that the header itself always
  // shows a search bar, pinning a second one there too would just stack
  // two search bars on top of each other while scrolling.
  initHomepageCarousel();
  if (window.__levroRailScroll) { const r = document.querySelector("#app .levro-home-cat-rail"); if (r) r.scrollLeft = window.__levroRailScroll; window.__levroRailScroll = 0; }
  initGallerySwipeSurfaces();
  initDeliveryFieldsOnPage();
  setTimeout(() => {
    try { hydrateProductCommentCountsInView(); } catch (_) {}
    if(view==="productDetail"&&params?.openComments){try{openSocialCommentSheet("product",params.productId,currentProductDetail?.name?`${currentProductDetail.name} · Comments`:"Comments")}catch(_){}}
    if(view==="productDetail"&&params?.scrollToReviews){setTimeout(()=>document.querySelector(".product-reviews-card")?.scrollIntoView({behavior:"smooth",block:"start"}),200);}
    if(view==="packageDetail"&&params?.openComments){try{openSocialCommentSheet("package",params.packageId,"Package · Comments")}catch(_){}}
  }, 0);
  if (view !== "productDetail") stopProductCommentRealtime();
  setTimeout(()=>{hydrateProductVariantIndicatorsInView();hydrateProductLikeCountsInView();hydratePackageCommentCountsInView();hydrateProductRatingsInView()},0);
  if (view === "settings") setTimeout(hydrateSettingsPage, 0);
  if (view === "search") { byId("searchPageInput")?.focus(); setTimeout(() => byId("searchPageInput")?.focus(), 60); renderSearchPageSuggestions(); bindSearchResultLongPress(byId("searchPageResults")); }
  // A same-view, non-history refresh (notably live order updates) must keep
  // the user's scroll position. Real navigation still starts at the top.
  if (preserveSameViewScroll) {
    requestAnimationFrame(() => window.scrollTo({ top: routeScrollSnapshot, behavior: "auto" }));
  } else if ((view === "buyerProfile" || view === "vendorDashboard") && previousView === view) {
    const y0 = window.__levroProfCurrentY ?? 0;
    requestAnimationFrame(() => window.scrollTo({ top: y0, behavior: "auto" }));
  } else if ((view === "buyerProfile" || view === "vendorDashboard") && previousView !== view && Number.isFinite(window.__levroProfScroll?.[view])) {
    const y = window.__levroProfScroll[view];
    requestAnimationFrame(() => window.scrollTo({ top: y, behavior: "auto" }));
  } else if (!pushHistory && view === "home" && previousView !== "home" && Number.isFinite(window.__levroHomeScrollY)) {
    // back to the exact spot: the list below may still be drawing, so keep returning to it until the page is tall enough (or the person scrolls)
    const y = window.__levroHomeScrollY;
    let moved = false; const stop = () => { moved = true; };
    window.addEventListener("touchstart", stop, { once: true, passive: true }); window.addEventListener("wheel", stop, { once: true, passive: true });
    const restore = (n) => { if (moved) return; window.scrollTo({ top: y, behavior: "auto" }); if (Math.abs(window.scrollY - y) > 4 && n > 0) setTimeout(() => restore(n - 1), 100); };
    requestAnimationFrame(() => restore(30));
  } else if (pushHistory || previousView !== view) {
    if (view !== "home" || window.scrollY === homeStartScroll) {
      window.scrollTo({ left: 0, top: 0, behavior: "auto" });
    }
  }
  if (!pushHistory && !preserveSameViewScroll) {
    try { window.__levromartRestoreScroll?.(view); } catch (err) { console.warn("Scroll restoration failed", err); }
  }
  requestAnimationFrame(() => document.documentElement.classList.remove("lv-route-transitioning"));
}

