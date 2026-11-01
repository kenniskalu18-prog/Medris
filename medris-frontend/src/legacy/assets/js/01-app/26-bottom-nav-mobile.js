// ---------- BOTTOM NAV (mobile) ----------
// Mouse users can't swipe: let them drag horizontal rails (and shift-wheel still works natively).
(function(){
  let rail=null,startX=0,startLeft=0,moved=false;
  document.addEventListener("mousedown",(e)=>{
    if(e.button!==0)return; const r=e.target.closest?.(".hscroll"); if(!r)return;
    rail=r;startX=e.pageX;startLeft=r.scrollLeft;moved=false;
  });
  document.addEventListener("mousemove",(e)=>{
    if(!rail)return; const dx=e.pageX-startX;
    if(!moved&&Math.abs(dx)>6){moved=true;rail.classList.add("is-dragging");}
    if(moved){rail.scrollLeft=startLeft-dx;e.preventDefault();}
  });
  const end=()=>{ if(rail&&moved){const r=rail;setTimeout(()=>r.classList.remove("is-dragging"),0);} rail=null; };
  document.addEventListener("mouseup",end); document.addEventListener("mouseleave",end);
  document.addEventListener("click",(e)=>{ if(moved){e.stopPropagation();e.preventDefault();moved=false;} },true);
})();
// Tapping a bottom-nav tab you are already on does nothing (no reload, no flash).
function lvTabSame(view) {
  if (!view || currentView !== view) return false;
  const p = currentViewParams || {};
  if (view === "vendorOrders") return (p.perspective || "sales") === "sales" && (!p.status || p.status === "all");
  if (view === "buyerOrders") return !p.status || p.status === "all";
  return true;
}
// Tapping Home while already on a clean Home does nothing (no reload, no flash). With a category/search active it resets them.
function lvHomeTap() {
  const filtered = !!(currentHomeCategoryId || currentSectorId || (byId("searchInput")?.value || "").trim());
  // already on Home: go back to the top (and close any open panel) instead of doing nothing
  if (currentView === "home" && !filtered) { try { window.lvCloseRail && window.lvCloseRail(); } catch (_) {} window.scrollTo({ top: 0, behavior: "smooth" }); return; }
  resetHomeFilters();
  navigate("home");
}
// Line icons for the bottom bar (one family: 1.9 stroke, rounded)
window.lvLineIcon = function (n) {
  const P = {
    home: "<path d='M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8'/> <path d='M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'/>",
    store: "<path d='M15 21v-5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5'/> <path d='M17.774 10.31a1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.451 0 1.12 1.12 0 0 0-1.548 0 2.5 2.5 0 0 1-3.452 0 1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.77-3.248l2.889-4.184A2 2 0 0 1 7 2h10a2 2 0 0 1 1.653.873l2.895 4.192a2.5 2.5 0 0 1-3.774 3.244'/> <path d='M4 10.95V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8.05'/>",
    request: "<path d='M12 22V12'/> <path d='M20.27 18.27 22 20'/> <path d='M21 10.498V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.729l7 4a2 2 0 0 0 2 .001l.98-.559'/> <path d='M3.29 7 12 12l8.71-5'/> <path d='m7.5 4.27 8.997 5.148'/> <circle cx='18.5' cy='16.5' r='2.5'/>",
    bell: "<path d='M10.268 21a2 2 0 0 0 3.464 0'/> <path d='M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326'/>",
    orders: "<path d='M13 16H8'/> <path d='M14 8H8'/> <path d='M16 12H8'/> <path d='M4 3a1 1 0 0 1 1-1 1.3 1.3 0 0 1 .7.2l.933.6a1.3 1.3 0 0 0 1.4 0l.934-.6a1.3 1.3 0 0 1 1.4 0l.933.6a1.3 1.3 0 0 0 1.4 0l.933-.6a1.3 1.3 0 0 1 1.4 0l.934.6a1.3 1.3 0 0 0 1.4 0l.933-.6A1.3 1.3 0 0 1 19 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1 1.3 1.3 0 0 1-.7-.2l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.934.6a1.3 1.3 0 0 1-1.4 0l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-1.4 0l-.934-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-.7.2 1 1 0 0 1-1-1z'/>",
    shield: "<path d='M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z'/> <path d='m9 12 2 2 4-4'/>",
    coins: "<circle cx='12' cy='12' r='9'/><path d='M9 16V8l6 8V8'/>",
    wallet: "<path d='M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1'/> <path d='M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4'/>",
    plus: "<path d='M5 12h14'/><path d='M12 5v14'/>",
    user: "<circle cx='12' cy='8' r='5'/> <path d='M20 21a8 8 0 0 0-16 0'/>",
    location: "<path d='M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z'/><circle cx='12' cy='10' r='2.5'/>",
    messages: "<path d='M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z'/>",
  };
  return `<svg class="lv-line-ic" viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] || P.home}</svg>`;
};
function renderBottomNav() {
  const nav = byId("bottomNav");
  if (!nav) return;
  const isVendorUser = !!(session && profile?.role === "vendor");
  const isAdmin = !!(session && profile?.role === "admin");
  const accountView = isAdmin ? "adminPanel" : isVendorUser ? "vendorDashboard" : "buyerProfile";
  const orderView = isAdmin ? "adminFinance" : isVendorUser ? "vendorOrders" : "buyerOrders";
  const orderAction = isAdmin ? "navigate('adminFinance')" : isVendorUser ? "navigate('vendorOrders',{status:'all',perspective:'sales'})" : session ? "navigate('buyerOrders')" : "requireLoginThen('buyerOrders')";
  const accountAction = session ? "navigate('" + accountView + "')" : "showLogin()";
  const items = [
    { icon: lvLineIcon("location"), label: "Map", action: "navigate('vendorsMap')", view: "vendorsMap" },
    { icon: lvLineIcon("messages"), label: "Messages", action: session ? "navigate('messages')" : "requireLoginThen('messages')", view: "messages" },
    { icon: lvLineIcon("plus"), label: isAdmin ? "Admin" : isVendorUser ? "Add" : "Request", action: isAdmin ? "navigate('adminPanel')" : isVendorUser ? "openAddChooser()" : session ? "navigate('requestEquipment')" : "requireLoginThen('requestEquipment')", view: isAdmin ? "adminPanel" : null, primary: true },
    { icon: lvLineIcon("orders"), label: "Orders", action: orderAction, view: orderView, badge: isVendorUser ? Number(vendorPendingOrderCount||0) + Number(buyerPendingOrderCount||0) : buyerPendingOrderCount },
    { icon: lvLineIcon("user"), label: "Account", action: accountAction, view: accountView }
  ];
  const itemHtml = (it) => {
    const active = it.view && (it.view === currentView || (it.view === "vendorsMap" && currentView === "vendors"));
    return '<button type="button" class="bottom-nav-item lv-snap-nav-item ' + (active ? "active" : "") + (it.primary ? " lv-snap-nav-primary" : "") + '" data-nav-view="' + (it.view || "") + '" onclick="' + it.action + '" ' + (active ? 'aria-current="page"' : "") + ' aria-label="' + it.label + '" title="' + it.label + '"><span class="bn-icon">' + it.icon + (it.badge ? '<span class="bn-badge">' + (it.badge > 9 ? "9+" : it.badge) + '</span>' : "") + '</span><span class="lv-snap-nav-label">' + it.label + '</span></button>';
  };
  nav.classList.remove("has-add", "buyer-no-add");
  nav.classList.add("lv-snap-nav");
  nav.innerHTML = items.map(itemHtml).join("");
}

const LEVRO_MOTION_KEY="levromart-motion-preference-v1";
function getLevromartMotionPreference(){try{return localStorage.getItem(LEVRO_MOTION_KEY)==="full"?"full":"calm";}catch(_){return "calm";}}
function applyLevromartMotionPreference(value){const pref=value==="full"?"full":"calm";document.documentElement.dataset.levroMotion=pref;try{localStorage.setItem(LEVRO_MOTION_KEY,pref);}catch(_){}return pref;}
function setLevromartMotionPreference(value){const pref=applyLevromartMotionPreference(value);try{hydrateSettingsPage?.();}catch(_){}showToast(pref==="calm"?"Calm mode enabled. Decorative motion is off.":"Full Motion enabled.","success");}
applyLevromartMotionPreference(getLevromartMotionPreference());

function initBottomNavScrollMotion(){
  const nav = byId("bottomNav");
  if (!nav || nav.dataset.scrollMotionReady === "1") return;
  nav.dataset.scrollMotionReady = "1";
  const getMetrics=()=>{
    const chat=document.body.classList.contains("chat-full-page") ? document.querySelector(".chat-messages") : null;
    if(chat) return {y:Math.max(0,chat.scrollTop||0),maxY:Math.max(0,chat.scrollHeight-chat.clientHeight)};
    return {y:Math.max(0,window.scrollY||document.documentElement.scrollTop||0),maxY:Math.max(0,document.documentElement.scrollHeight-window.innerHeight)};
  };
  let lastY=getMetrics().y;
  let raf=0, idleTimer=0;
  const reduced=()=>window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  const restore=()=>{nav.classList.remove("nav-scroll-hide","nav-scroll-shrink");nav.style.removeProperty("--bn-translate");};
  const hide=()=>{if(reduced())return restore();nav.classList.remove("nav-scroll-shrink");nav.classList.add("nav-scroll-hide");};
  const apply=()=>{
    raf=0;
    const {y,maxY}=getMetrics(), delta=y-lastY;
    const chatOpen=document.body.classList.contains("chat-full-page");
    if(chatOpen){ restore(); return; }
    const special=document.body.classList.contains("profile-reveal-open")||document.body.classList.contains("profile-reveal-dragging")||nav.classList.contains("nav-hidden")||document.body.classList.contains("search-input-active");
    if(special||reduced()){restore();lastY=y;return;}
    if(Math.abs(delta)<3)return;
    lastY=y;
    if(delta>0 && y>16 && y<maxY-8) hide(); else if(delta<0 || y<=16 || y>=maxY-8) restore();
    clearTimeout(idleTimer);
    idleTimer=setTimeout(()=>{if(delta<0||y<=16||y>=maxY-8)restore();},420);
  };
  const onScroll=()=>{if(!raf)raf=requestAnimationFrame(apply);};
  window.addEventListener("scroll",onScroll,{passive:true});
  // Only the page itself (or the chat list) matters here. Rows that auto-scroll sideways fire "scroll" constantly, and each one
  // used to force a full-page layout just to read the scroll position.
  document.addEventListener("scroll",(e)=>{ const t=e.target; if(t!==document && t!==document.documentElement && !(t&&t.classList&&t.classList.contains("chat-messages"))) return; onScroll(); },{passive:true,capture:true});
  window.addEventListener("resize",()=>{lastY=getMetrics().y;restore();},{passive:true});
  document.addEventListener("visibilitychange",()=>{if(!document.hidden){lastY=getMetrics().y;restore();}});
}

// A floating cart button, docked near Levi's FAB, is easier to notice
// than a nav-tab would be without adding a 6th cramped item to the
// already-full buyer bottom nav.
function initFloatingScrollVisibility(){
  if (window.__leviCartScrollReady) return;
  if (getLevromartMotionPreference()==="calm") return;
  window.__leviCartScrollReady = true;
  let lastY = Math.max(0, window.scrollY || document.documentElement.scrollTop || 0);
  let timer = 0;
  let raf = 0;
  const apply = () => {
    raf = 0;
    const y = Math.max(0, window.scrollY || document.documentElement.scrollTop || 0);
    const delta = y - lastY;
    if (Math.abs(delta) >= 2 && y > 20) {
      byId('aiChatFab')?.classList.add('scroll-faded');
      byId('cartFab')?.classList.add('scroll-faded');
      lastY = y;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      byId('aiChatFab')?.classList.remove('scroll-faded');
      byId('cartFab')?.classList.remove('scroll-faded');
      lastY = Math.max(0, window.scrollY || document.documentElement.scrollTop || 0);
    }, 260);
  };
  window.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(apply); }, {passive:true});
  ['aiChatFab','cartFab'].forEach(id => byId(id)?.addEventListener('click', () => byId(id)?.classList.remove('scroll-faded'), {passive:true}));
}

function updateCartFab() {
  // The cart lives in the header now (master UI/UX spec, Part 3: "the cart
  // must NOT float over the homepage"), permanently beside Messages, for
  // both buyers and vendors (a vendor is also a buyer). The floating
  // draggable FAB is kept out of the render path rather than deleted
  // outright, so its badge-count logic below stays the single source of
  // truth for both surfaces without duplicating it.
  const fab = byId("cartFab");
  if (fab) fab.classList.add("hidden");

  const showCart = !!session && profile?.role !== "admin";
  const headerWrap = byId("headerCartWrap");
  if (headerWrap) headerWrap.classList.toggle("hidden", !showCart);
  const headerBadge = byId("headerCartBadge");
  if (headerBadge) {
    headerBadge.textContent = buyerCartCount > 9 ? "9+" : buyerCartCount;
    headerBadge.classList.toggle("hidden", buyerCartCount === 0);
  }

  const badge = byId("cartFabBadge");
  if (badge) {
    badge.textContent = buyerCartCount > 9 ? "9+" : buyerCartCount;
    badge.classList.toggle("hidden", buyerCartCount === 0);
  }
}
function requireLoginThen(view) {
  if (!session) { showLogin(); return; }
  navigate(view);
}

function showLogin() { authMode = "login"; applyAuthMode(); byId("loginModal").classList.remove("hidden"); trackModalOpened("loginModal"); }
function hideLogin() {
  byId("loginModal").classList.add("hidden");
  byId("authError").classList.add("hidden");
  if (dismissibleModalId === "loginModal") dismissibleModalId = null;
}
function toggleAuthMode() { authMode = authMode === "login" ? "register" : "login"; applyAuthMode(); }
function setAuthMode(mode) { authMode = mode; applyAuthMode(); }
function applyAuthMode() {
  const isRegister = authMode === "register";
  const isForgot = authMode === "forgot";
  const signInTab = byId("authSignInTab");
  const createTab = byId("authCreateAccountTab");
  if (signInTab && createTab) {
    const signInActive = !isRegister;
    signInTab.classList.toggle("active", signInActive);
    createTab.classList.toggle("active", isRegister);
    signInTab.setAttribute("aria-selected", signInActive ? "true" : "false");
    createTab.setAttribute("aria-selected", isRegister ? "true" : "false");
  }
  byId("authModalTitle").innerHTML = isForgot
    ? "<i class='fa-solid fa-key'></i> Reset your password"
    : isRegister ? "<i class='fa-solid fa-user-plus'></i> Create your Levromart account" : "<i class='fa-solid fa-right-to-bracket'></i> Welcome back to Levromart";
  byId("signupExtraFields").classList.toggle("hidden", !isRegister);
  byId("googleAuthWrap").classList.toggle("hidden", isForgot);
  byId("loginPasswordWrap").classList.toggle("hidden", isForgot);
  byId("confirmPasswordWrap").classList.toggle("hidden", !isRegister);
  byId("forgotPasswordMsg").classList.toggle("hidden", !isForgot);
  byId("authAgreementMsg").classList.toggle("hidden", !isRegister);
  byId("forgotPasswordLinkWrap").classList.toggle("hidden", isRegister || isForgot);
  byId("authSubmitBtn").textContent = isForgot ? "Send reset link" : isRegister ? "Create account" : "Login";
  byId("authToggleLink").textContent = "Back to login";
  byId("authToggleLink").onclick = (e) => { e.preventDefault(); isForgot ? setAuthMode("login") : toggleAuthMode(); };
  byId("authToggleLink").parentElement?.classList.toggle("hidden", !isForgot);
  byId("authError").classList.add("hidden");
}

// Only one active login per account: right after a successful sign-in,
// revoke every other device/browser's session for this user (their end
// only actually logs out once it next tries to refresh its token - see
// the onAuthStateChange listener below for the "signed out elsewhere"
// message that fires when that happens).
let manualLogout = false;

// Redirects away to Google and back -- Supabase picks the returned session
// up automatically (detectSessionInUrl is on by default), which fires the
// same onAuthStateChange listener as any other login, so no separate
// "handle the OAuth callback" code is needed here. First-time Google
// sign-ins default to the customer role via the handle_new_user trigger,
// same as leaving "I am a…" on its default during a normal signup --
// anyone who actually wants to sell can still apply as a vendor
// afterward, same as always.
async function signInWithGoogle() {
  const { error } = await sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin + window.location.pathname },
  });
  if (error) showToast(error.message, "error");
}
function togglePasswordVisibility(inputId, button) {
  const input = byId(inputId);
  if (!input) return;
  const showing = input.type === "text";
  input.type = showing ? "password" : "text";
  button?.setAttribute("aria-label", showing ? "Show password" : "Hide password");
  button?.setAttribute("title", showing ? "Show password" : "Hide password");
  const icon = button?.querySelector("i");
  if (icon) icon.className = `fa-regular ${showing ? "fa-eye" : "fa-eye-slash"}`;
}

function friendlyAuthErrorMessage(err) {
  const raw = String(err?.message || "").toLowerCase();
  // The single biggest cause of a genuinely correct password still failing
  // here is an account that has no password at all -- it was created via
  // Google, which never sets one. The generic message left people typing
  // the same (nonexistent) password over and over with no way to know why.
  if (raw.includes("invalid login credentials")) return "Incorrect email/phone or password. If you signed up with Google, tap \"Continue with Google\" below instead, or use \"Forgot password?\" to set one for the first time.";
  if (raw.includes("email not confirmed")) return "This email hasn't been confirmed yet.";
  if (raw.includes("user already registered") || raw.includes("already registered")) return "An account with this email or phone already exists.";
  const __f = window.__levroClassifyBackendError ? window.__levroClassifyBackendError(err?.message) : null;
  if (__f) return __f.text;
  return err?.message || "Something went wrong. Please try again.";
}
async function submitAuth() {
  const email = byId("loginEmail").value.trim();
  const password = byId("loginPassword").value;
  const errorEl = byId("authError");
  errorEl.classList.add("hidden");

  if (authMode === "forgot") {
    if (!email) { errorEl.textContent = "Enter your email address."; errorEl.classList.remove("hidden"); return; }
    const btn = byId("authSubmitBtn");
    btn.disabled = true;
    try {
      // Resend is now wired in as Supabase Auth's SMTP provider, so the
      // native emailed-link flow (handled by the PASSWORD_RECOVERY listener
      // above) is reliable again -- no more routing this through an admin
      // for manual approval.
      const { error } = await sb.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + window.location.pathname,
      });
      if (error) throw error;
      hideLogin();
      showToast("If an account exists for that email, we've sent a link to reset your password.", "success");
    } catch (err) {
      errorEl.textContent = err.message || "Could not send the password reset email.";
      errorEl.classList.remove("hidden");
    } finally {
      btn.disabled = false;
    }
    return;
  }

  if (!password) { errorEl.textContent = "Password is required."; errorEl.classList.remove("hidden"); return; }
  if (authMode !== "register" && !email) { errorEl.textContent = "Enter your email address or phone number."; errorEl.classList.remove("hidden"); return; }

  const btn = byId("authSubmitBtn");
  btn.disabled = true;
  // show at once that something is happening (the steps behind can take a few seconds on a slow network)
  const __btnHtml = btn.innerHTML;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> ' + (authMode === "register" ? "Creating your account…" : "Signing you in…");

  try {
    if (authMode === "register") {
      const name = byId("loginName").value.trim();
      const role = byId("loginRole").value;
      const city = byId("loginCity").value.trim();
      const phone = byId("loginPhone").value.trim();

      if (!name) throw new Error("Full name is required.");
      if (!phone) throw new Error("Phone is required.");
      if (!window.__lvSignupCampus) throw new Error("Choose your campus (or pick \"Not on a campus\").");
      if (password.length < 8) throw new Error("Password must be at least 8 characters.");
      if (password !== byId("loginPasswordConfirm").value) throw new Error("Passwords don't match.");

      // Account creation is handled by the single existing Vercel function.
      // The server creates the Auth user with email_confirm:true, so there is
      // NO confirmation-email step: create the account and continue immediately.
      const registerRes = await fetch("/api/delete-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "register",
          email,
          password,
          name,
          phone,
          city,
          role,
          referral_code: String(byId("loginReferral")?.value || "").trim()
        })
      });

      const registerBody = await registerRes.json().catch(() => ({}));
      if (!registerRes.ok) {
        throw new Error(registerBody.error || "Could not create your account.");
      }

      // The account is already confirmed by the server, so sign in immediately.
      try {
        sessionStorage.setItem("levromart-just-registered", "1");
        if (String(role).toLowerCase() === "vendor") sessionStorage.setItem("levromart-new-vendor-applicant", "1");
      } catch (_) {}
      const loginEmail = email || authAliasFromPhone(phone);
      const { error: loginError } = await sb.auth.signInWithPassword({
        email: loginEmail,
        password
      });
      if (loginError) throw loginError;
      window.__lvFreshSignIn = Date.now();
      // the campus is saved in the background: the person does not wait for it
      try { const __cp = window.__lvSignupCampus; if (__cp) Promise.resolve(window.lvSaveCampus(__cp)).catch(() => {}); } catch (_) {}
      if (registerBody?.referral?.ok) {
        try { localStorage.removeItem("levro-ref-code"); } catch (_) {}
        setTimeout(() => showToast(`Referral applied. You joined with ${registerBody.referral.business_name}'s code.`, "success"), 1200);
      }

      await finishLoginSuccess(role === "vendor" ? "vendorApply" : "home");
    } else {
      let loginEmail = email;
      if (looksLikePhoneIdentifier(email)) {
        loginEmail = authAliasFromPhone(email);
      }
      const { error } = await sb.auth.signInWithPassword({ email: loginEmail, password });
      if (error) throw error;
      window.__lvFreshSignIn = Date.now();
      // The OTP check (and role-select / set-password, if either is still
      // pending on this account) all now run from inside finishLoginSuccess
      // -> refreshAuthStateOnce -> runPostAuthChecks, one shared sequence
      // for every sign-in path (password, Google, and a returning session
      // past its 7-day OTP window) instead of duplicating the check here.
      await finishLoginSuccess("home");
    }
  } catch (err) {
    // Every other validation branch in this function shows the inline
    // authError box with .remove("hidden") -- this one instead did
    // .add("hidden"), so a wrong password or bad email/phone silently hid
    // the error box instead of showing it, leaving only a toast (easy to
    // miss/auto-dismiss) as the sole feedback that login had failed.
    errorEl.textContent = friendlyAuthErrorMessage(err);
    errorEl.classList.remove("hidden");
    showToast(friendlyAuthErrorMessage(err), "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = __btnHtml;
  }
}

async function finishLoginSuccess(view) {
  await refreshAuthStateOnce();

  let justRegistered = false;
  try { justRegistered = sessionStorage.getItem("levromart-just-registered") === "1"; if (justRegistered) sessionStorage.removeItem("levromart-just-registered"); } catch (_) {}
  if (justRegistered) {
    // New accounts start with Levromart's own location setting enabled. The
    // browser/device still owns the real permission and will show its prompt
    // when the request is made. If permission is denied, use our recovery UI.
    locationSharingEnabled = true;
    try { localStorage.setItem("medris-location-enabled", "1"); } catch (_) {}
    setAutomaticDistancePreference(true);
    setTimeout(async () => {
      if (!session || !profile || !navigator.geolocation) return;
      try {
        await getCustomerLocation(true);
        updateVendorsLocationUI();
      } catch (err) {
        const state = await getBrowserLocationPermission();
        showLocationPrompt("recovery", state === "denied" ? locationRecoveryText("denied") : (err?.message || "Allow Levromart to access your location so nearby vendors can be shown automatically."));
      }
    }, 500);
  }

  // Only refresh buyer location automatically after the customer has explicitly
  // opted into the one-time automatic-distance preference. This prevents a
  // fresh login from unexpectedly triggering a browser location prompt.
  if (buyerDistanceAutoEnabled && locationSharingEnabled && navigator.geolocation) {
    scheduleAutomaticLocationRefresh();
  }
  hideLogin();
  // Vendor applicants go directly into the existing application route after
  // the authenticated account is established; the renderer itself checks for
  // an existing vendor/application row and redirects to the dashboard instead.
  let postSignupView = view;
  try {
    if (sessionStorage.getItem("levromart-new-vendor-applicant") === "1") {
      postSignupView = "vendorApply";
      sessionStorage.removeItem("levromart-new-vendor-applicant");
    }
  } catch (_) {}
  try {
    if (justRegistered && postSignupView === "home") postSignupView = "profileSetup";
    else if (postSignupView === "home" && vendor && profile?.role !== "admin" && !lvSetupSeen() && !vendor.cover_url && !profile?.avatar_url) postSignupView = "profileSetup";
  } catch (_) {}
  navigate(postSignupView);
  awaitingInstallPromptForLogin = true;
  setTimeout(maybeShowInstallPrompt, 800);
  setTimeout(maybeShowNotifPrompt, 1600);
}

// Admin-only email OTP, required after the password on every fresh login
// (not on ordinary page reloads). See api/send-login-otp.js /
// verify-login-otp.js - this account has real power (approve/delete
// vendors, finance access), so it gets the extra step; buyer/vendor
// accounts don't have anything worth adding that friction for.
let pendingOtpAccessToken = null;

async function submitLoginOtp() {
  const code = byId("otpInput").value.trim();
  const errorEl = byId("otpError");
  errorEl.classList.add("hidden");
  if (!code) { errorEl.textContent = "Enter the 6-digit code."; errorEl.classList.remove("hidden"); return; }
  const btn = byId("otpSubmitBtn");
  btn.disabled = true;
  try {
    const res = await fetch("/api/auth-otp", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "verify", accessToken: pendingOtpAccessToken, code }),
    });
    const json = await res.json();
    if (!json.ok) { errorEl.textContent = json.error || "That code didn't work."; errorEl.classList.remove("hidden"); return; }
    byId("otpModal").classList.add("hidden");
    pendingOtpAccessToken = null;
    // Fresh sign-in still has the login modal up (and nothing rendered
    // behind it worth keeping) -- send it to Home/adminPanel like any other
    // login. A standing session that just hit its 7-day OTP window is
    // already sitting on a real page, so just re-render exactly that page
    // instead of yanking them somewhere else.
    if (byId("loginModal") && !byId("loginModal").classList.contains("hidden")) {
      await finishLoginSuccess(profile?.role === "admin" ? "adminPanel" : "home");
    } else {
      await refreshAuthStateOnce();
      navigate(currentView || "home", currentViewParams || {}, false);
    }
  } catch (err) {
    errorEl.textContent = "Couldn't verify that code. Try again.";
    errorEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
  }
}

