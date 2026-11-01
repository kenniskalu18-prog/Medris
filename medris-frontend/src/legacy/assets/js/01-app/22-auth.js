// ---------- AUTH ----------
async function refreshAuthState() {
  const { data } = await sb.auth.getSession();
  session = data.session;

  // getSession() restores a cached JWT; it does not prove that the Auth user
  // still exists. After a hard account deletion, an already-issued access
  // token can remain readable locally until it expires. Validate the current
  // user before treating that cached session as a real login.
  //
  // That verification call and the profile-repair/role-sync work further
  // down used to run strictly back to back -- four full network round trips
  // in a row on every single login and session restore, which is most of
  // why logging in could visibly sit there for several seconds on a slow
  // connection. Neither of them actually needs verification to finish
  // first: they already have everything they need from this same cached
  // JWT, and a genuinely invalid token gets rejected on its own at the
  // database layer regardless of call order. Start them together and only
  // decide what to keep once verification resolves.
  let ensureProfileAndRoleSync = Promise.resolve(null);
  if (session) {
    ensureProfileAndRoleSync = (async () => {
      // A deleted account can be recreated with a brand-new Auth UUID. Repair
      // the public.users anchor before any buyer_id/vendor_id FK reads or writes.
      await ensureCustomerProfile();
      // Resolve the account role from the authoritative database state on every
      // session restore. This prevents a stale local/profile role from leaving an
      // approved vendor looking like a buyer until they log out and back in.
      // Pending/rejected vendor applications resolve back to buyer by design.
      try {
        const { data: resolvedRole, error: roleSyncError } = await sb.rpc("sync_current_account_role");
        if (!roleSyncError && resolvedRole) return resolvedRole;
        if (roleSyncError) console.warn("[Levromart] Authoritative role sync failed; using profile row:", roleSyncError);
      } catch (roleSyncException) {
        console.warn("[Levromart] Authoritative role sync exception:", roleSyncException);
      }
      return null;
    })();
    // Runs in the background regardless of what verification below decides;
    // its own console.warn calls are the only reporting it needs, so a
    // rejection here must never surface as an unhandled promise rejection.
    ensureProfileAndRoleSync.catch(() => {});
  }

  // A login made a moment ago was just checked by the server itself: asking again would only add a wait before the app opens.
  const freshSignIn = window.__lvFreshSignIn && Date.now() - window.__lvFreshSignIn < 20000;
  if (session && !freshSignIn) {
    let verifiedUser = null, verifyError = null;
    try {
      const r = await sb.auth.getUser();
      verifiedUser = r.data; verifyError = r.error;
    } catch (networkErr) {
      verifyError = networkErr;
    }
    // Only a real rejection of the token (expired/invalid/user gone) means the
    // account is actually gone -- a transient network/server hiccup talking to
    // Supabase must not be treated the same way, or a flaky connection forces
    // a perfectly valid session to sign out.
    let status = verifyError?.status ?? verifyError?.originalError?.status;
    // A token that has just expired (or was renewed a moment ago by another tab) is rejected once. Renew the login and
    // check again before treating the account as gone, so a person is never signed out in the middle of an order.
    if (verifyError && (status === 401 || status === 403 || /jwt|invalid.*token/i.test(verifyError.message || ""))) {
      try {
        const renewed = await sb.auth.refreshSession();
        if (renewed?.data?.session) {
          session = renewed.data.session;
          const again = await sb.auth.getUser();
          if (!again.error && again.data?.user) { verifiedUser = again.data; verifyError = null; status = undefined; }
          else { verifyError = again.error || verifyError; status = verifyError?.status ?? verifyError?.originalError?.status; }
        }
      } catch (_) {}
    }
    const isAuthRejection = status === 401 || status === 403 || /user.?not.?found|session.?not.?found|invalid.*token|jwt/i.test(verifyError?.message || "");
    if (isAuthRejection || (!verifyError && !verifiedUser?.user)) {
      // People must never be signed out by a hiccup. Wait a moment (another tab or the installed app may be renewing the
      // login right now), look again, and only sign out when the login itself is confirmed dead: the renewal is refused
      // because its refresh token no longer exists, not because of the network, a slow server or a race.
      let stillBad = true;
      try {
        await new Promise((r) => setTimeout(r, 1500));
        const again = await sb.auth.getSession();
        if (again?.data?.session) {
          session = again.data.session;
          const check = await sb.auth.getUser();
          if (!check.error && check.data?.user) stillBad = false;
        }
      } catch (_) {}
      let tokenDead = false;
      if (stillBad) {
        try {
          const renew = await sb.auth.refreshSession();
          if (renew?.data?.session) { session = renew.data.session; stillBad = false; }
          else if (renew?.error && /refresh.?token.*(not.?found|invalid|already.?used|revoked)|invalid.?grant|session.?(not.?found|missing)/i.test(renew.error.message || renew.error.code || "")) tokenDead = true;
        } catch (_) {}
      }
      if (stillBad && tokenDead) {
        console.warn("[Levromart] Login is no longer valid; signing out:", { status, message: verifyError?.message });
        session = null;
        profile = null;
        vendor = null;
        favoriteIds = new Set();
        packageFavoriteIds = new Set();
        manualLogout = true;
        await sb.auth.signOut({ scope: "local" }).catch(() => {});
      } else if (stillBad) {
        console.warn("[Levromart] Could not confirm the login just now; keeping the person signed in:", { status, message: verifyError?.message });
      }
    }
  }

  profile = null;
  vendor = null;
  favoriteIds = new Set();
  packageFavoriteIds = new Set();
  if (session) {
    const userId = session.user.id;

    // Almost always already settled by now, since it's been running since
    // right before the getUser() round trip above.
    const loadAccount = () => Promise.all([
      sb.from("users").select("*").eq("id", userId).single(),
      sb.from("vendors").select("*").eq("user_id", userId).is("deleted_at", null).maybeSingle(),
      levroData.favorites.productIds(userId),
      levroData.favorites.packageIds(userId)
    ]);
    let resolvedRole, profileRes, vendorRes, favsRes, pkgFavsRes;
    if (freshSignIn) {
      // Just signed in: the account certainly exists, so its details are fetched at the same time as the role check
      // instead of after it (one waiting step fewer). The role from the check is applied to the profile below.
      let rest;
      [resolvedRole, rest] = await Promise.all([ensureProfileAndRoleSync, loadAccount()]);
      [profileRes, vendorRes, favsRes, pkgFavsRes] = rest;
    } else {
      resolvedRole = await ensureProfileAndRoleSync;
      [profileRes, vendorRes, favsRes, pkgFavsRes] = await loadAccount();
    }
    profile = profileRes.data;
    if (freshSignIn && resolvedRole && profile) { profile.role = resolvedRole; }
    vendor = profile?.role === "admin" ? null : vendorRes.data;
    // profile.role comes straight from the users row, which
    // sync_current_account_role() (above, SECURITY DEFINER, immune to RLS
    // and run first) already made authoritative. Re-deriving it here a
    // second time from this vendors fetch used to silently downgrade a real
    // vendor back to buyer whenever that fetch merely errored or lagged
    // (a transient network hiccup, RLS timing) -- the vendors row exists and
    // is fine, only this second, redundant read of it failed. Trust the
    // already-synced role instead; `vendor` below stays purely for display
    // (stats, storefront info), not for deciding the role.
    favoriteIds = new Set((favsRes.data || []).map((f) => f.product_id));
    packageFavoriteIds = new Set((pkgFavsRes.data || []).map((f) => f.package_id));
  }
  updateAuthUI();
  renderBottomNav();
  // Badge/count refresh is independent of rendering the current page; do not
  // hold the initial app screen hostage to those background reads.
  refreshNotifications(false).catch(() => {});
  subscribeNotifications();
  subscribeOrderUpdates();
  subscribeMarketplaceUpdates();
  window.__monthlyPendingCount=0;void refreshMonthlyPendingCount();
  window.__lockedVendorCount=0;void refreshLockedVendorCount();
  loadAiVoices();
  // Google sign-in creates the account straight away with no chance to
  // pick buyer vs vendor first (unlike the manual signup form, which asks
  // up front) -- this catches that gap and asks right after, before the
  // account is treated as fully set up. Everything else that might need
  // asking (setting a password, the periodic OTP re-check) waits behind
  // this one, see runPostAuthChecks.
  if (profile && profile.role_selected === false) byId("roleSelectModal")?.classList.remove("hidden");
  else await runPostAuthChecks();
}
function openRequiredBuyerPhoneModal() {
  const modal = byId("requiredBuyerPhoneModal");
  if (!modal) return;
  const input = byId("requiredBuyerPhoneInput");
  const error = byId("requiredBuyerPhoneError");
  if (input) input.value = String(profile?.phone || "").trim();
  error?.classList.add("hidden");
  modal.classList.remove("hidden");
  setTimeout(() => input?.focus(), 50);
}

async function saveRequiredBuyerPhone() {
  if (!session?.user?.id || !profile) return;
  const input = byId("requiredBuyerPhoneInput");
  const error = byId("requiredBuyerPhoneError");
  const btn = byId("requiredBuyerPhoneSaveBtn");
  const phone = String(input?.value || "").trim();
  const normalized = phone.replace(/[\s().-]/g, "");
  error?.classList.add("hidden");
  if (!phone) { if(error){error.textContent="Phone number is required.";error.classList.remove("hidden");} return; }
  if (!/^\+?[0-9]{7,15}$/.test(normalized)) {
    if(error){error.textContent="Enter a valid phone number (7–15 digits).";error.classList.remove("hidden");}
    return;
  }
  if (btn) { btn.disabled=true; btn.classList.add("is-busy"); }
  try {
    const { error: updateError } = await sb.from("users").update({ phone }).eq("id", session.user.id);
    if (updateError) throw updateError;
    profile.phone = phone;
    byId("requiredBuyerPhoneModal")?.classList.add("hidden");
    updateAuthUI();
    showToast("Phone number saved.", "success");
    await runPostAuthChecks();
  } catch (e) {
    if(error){error.textContent=e?.message || "Could not save your phone number.";error.classList.remove("hidden");}
  } finally {
    if (btn) { btn.disabled=false; btn.classList.remove("is-busy"); }
  }
}

async function chooseAccountRole(role) {
  // Selecting Vendor means "I want to apply", not "I am already an approved
  // vendor". The database becomes authoritative only after approval.
  const authoritativeRole = role === "vendor" ? "buyer" : role;
  const { error } = await sb.from("users").update({ role: authoritativeRole, role_selected: true }).eq("id", session.user.id);
  if (error) { showToast(error.message, "error"); return; }
  profile.role = authoritativeRole;
  profile.role_selected = true;
  byId("roleSelectModal")?.classList.add("hidden");
  updateAuthUI();
  renderBottomNav();
  if (role === "vendor") navigate("vendorApply");
  else showToast("You're all set.", "success");
  await runPostAuthChecks();
}

async function setAccountPassword() {
  const pw = byId("setPasswordInput").value;
  const confirm = byId("setPasswordConfirmInput").value;
  const errorEl = byId("setPasswordError");
  errorEl.classList.add("hidden");
  if (pw.length < 8) { errorEl.textContent = "Password must be at least 8 characters."; errorEl.classList.remove("hidden"); return; }
  if (pw !== confirm) { errorEl.textContent = "Passwords don't match."; errorEl.classList.remove("hidden"); return; }
  // Set via the server's admin API (api/auth-otp.js), not the client
  // auth.updateUser() call -- a Google-only account has no password to
  // compare against, and Supabase's own client-side "must differ from the
  // old password" check has a known rough edge that misfires in exactly
  // that case. The admin path sets it directly and skips that check.
  try {
    const res = await fetch("/api/auth-otp", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set-password", accessToken: session.access_token, password: pw }),
    });
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(json.error || "Could not set password.");
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove("hidden");
    return;
  }
  profile.has_password = true;
  byId("setPasswordModal").classList.add("hidden");
  byId("setPasswordInput").value = "";
  byId("setPasswordConfirmInput").value = "";
  showToast("Password set. You can now log in with it too.", "success");
  await runPostAuthChecks();
}

// Sequenced so at most one of these modals is ever open at a time: a
// Google account with no password set yet gets asked first (this is what
// lets password-based actions like deleting the account work uniformly
// for every account, Google or not); only once that's resolved does the
// periodic email-OTP re-check run. otpCheckDoneThisBoot keeps the OTP
// check from firing again on every token-refresh-triggered auth-state
// change within the same page load -- it only needs to run once per
// actual app open (a real reload naturally resets it).
let otpCheckDoneThisBoot = false;
async function runPostAuthChecks() {
  if (!profile || !session) return;
  // Every customer account must have a phone number. Manual registration already
  // collects it; this gate covers Google sign-in and older accounts that predate
  // the requirement. Do this before the password/OTP checks so the account cannot
  // proceed as a fully configured buyer until the contact number is supplied.
  if (profile.role !== "admin" && !String(profile.phone || "").trim()) {
    openRequiredBuyerPhoneModal();
    return;
  }
  if (profile.has_password === false) { byId("setPasswordModal")?.classList.remove("hidden"); return; }
  // A vendor (pending or approved) with no payout account can't actually be
  // paid for any sale. This isn't a hard block like the checks above --
  // "Remind me later" just closes it for this session -- but it comes back
  // on every fresh login until paystack_subaccount_code is actually set,
  // at which point this condition is simply false and it never shows again.
  if (vendor && !vendor.paystack_subaccount_code) { byId("vendorPayoutNudgeModal")?.classList.remove("hidden"); return; }
  // Admin sign-in no longer requires the extra 6-digit email code -- removed
  // per request. checkOtpRequirement()/the otpModal are left in place but
  // unused rather than deleted, in case this needs to come back.
}
function openVendorPayoutSetup() {
  byId("vendorPayoutNudgeModal")?.classList.add("hidden");
  navigate("vendorEditProfile");
}
function dismissVendorPayoutNudge() {
  byId("vendorPayoutNudgeModal")?.classList.add("hidden");
}
// One shared identity re-check for every path that can land someone in the
// app: password login, Google OAuth, and simply reopening the app after
// the 7-day window has lapsed on a still-valid session. The server (see
// api/auth-otp.js) is the one deciding whether it's actually due, based on
// users.otp_verified_at, not the client.
async function checkOtpRequirement(accessToken) {
  if (profile?.role !== "admin") return;
  let otpJson = {};
  try {
    const res = await fetch("/api/auth-otp", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "send", accessToken }),
    });
    otpJson = await res.json();
  } catch (e) {
    // A network hiccup on this check shouldn't lock someone out of an
    // already-valid session -- fail open, same as the account-status check.
    return;
  }
  if (!otpJson.otpRequired) return;
  pendingOtpAccessToken = accessToken;
  byId("otpInput").value = "";
  byId("otpError").classList.add("hidden");
  byId("otpModal").classList.remove("hidden");
  setTimeout(() => byId("otpInput")?.focus(), 50);
}

function updateAuthUI() {
  const avatarBtn = byId("avatarBtn");
  const loginBtn = byId("loginBtn");
  const panel = byId("profilePanel");

  if (session && profile) {
    loginBtn.classList.add("hidden");
    avatarBtn.classList.remove("hidden");
    avatarBtn.innerHTML = profile.avatar_url
      ? `<img src="${esc(profile.avatar_url)}" alt="${esc(profile.name || "Profile")}" draggable="false" />`
      : avatarFallbackHtml(profile.name || profile.email, "100%", "", profile.name || profile.email);

    // Admin keeps its existing full icon-styled link list (unrelated to
    // this profile redesign - admin tooling, not the vendor/buyer profile).
    const links = [];
    if (profile.role === "admin") {
      if (isSuperAdmin()) {
        links.push({ label: "Admin panel", action: "navigate('adminPanel')" });
        links.push({label:`Monthly Listing <span class="badge danger monthly-profile-badge ${Number(window.__monthlyPendingCount||0)?'':'hidden'}">${Number(window.__monthlyPendingCount||0)}</span>`,action:"navigate('adminMonthlyListings')"});
        links.push({ label: "Manage admins", action: "navigate('adminUsers')" });
      }
      links.push({ label: "Vendors &amp; transactions", action: "navigate('adminFinance')" });
      links.push({ label: `Disputes <span class="badge danger profile-disputes-badge ${Number(window.__adminDisputeCount || 0) > 0 ? "" : "hidden"}">${Number(window.__adminDisputeCount || 0) > 9 ? "9+" : Number(window.__adminDisputeCount || 0)}</span>`, action: "navigate('adminDisputes')", profileKey: "disputes" });
      links.push({ label: `Support requests`, action: "navigate('adminSupportRequests')" });
      links.push({ label: `Conversations`, action: "navigate('adminConversations')" });
      links.push({ label: `Suggestions${unreadSuggestionCount > 0 ? ` <span class="badge danger">${unreadSuggestionCount > 9 ? "9+" : unreadSuggestionCount}</span>` : ""}`, action: "navigate('adminFeedback')", profileKey: "suggestions" });
      links.push({ label: `Feedback`, action: "navigate('adminFeedback')" });
      links.push({ label: "Points manager", action: "navigate('adminPoints')" });
      links.push({ label: "Link Library", action: "navigate('adminLinkLibrary')" });
      links.push({ label: "Contact us", action: "navigate('contactUs')" });
      links.push({ label: "Settings &amp; Privacy", action: "navigate('settings')" });
    }

    // Admin "at a glance" stats: super admins see platform-wide totals
    // (buyers, vendors, revenue); added/sub-admins only see their own
    // activity (logins, disputes, support, feedback) -- never platform
    // financials or people counts, which are super-admin-only.
    const adminStats = profile.role === "admin"
      ? (isSuperAdmin()
        ? [
            { key: "totalUsers", label: "Total users", value: Number(window.__adminStatTotalUsers || 0), action: "window.__adminPeopleRole='buyer';navigate('adminPeople')" },
            { key: "buyers", label: "Buyers", value: Number(window.__adminStatBuyers || 0), action: "window.__adminPeopleRole='buyer';navigate('adminPeople')" },
            { key: "vendors", label: "Vendors", value: Number(window.__adminStatVendors || 0), action: "window.__adminPeopleRole='vendor';navigate('adminPeople')" },
            { key: "activeProducts", label: "Active products", value: Number(window.__adminStatActiveProducts || 0), action: "window.__adminInventoryStatus='active';navigate('adminInventory')" },
          ]
        : [
            { key: "loginsToday", label: "Logins today", value: Number(window.__adminStatLoginsToday || 0), action: "navigate('adminLog')" },
            { key: "loginLogs", label: "Login logs", value: Number(window.__adminStatLoginLogs || 0), action: "navigate('adminLog')" },
            { key: "disputes", label: "Disputes", value: Number(window.__adminDisputeCount || 0), action: "navigate('adminDisputes')" },
            { key: "supportRequests", label: "Support requests", value: Number(window.__adminStatSupportRequests || 0), action: "navigate('adminSupportRequests')" },
            { key: "feedback", label: "Feedback", value: Number(window.__adminStatFeedback || 0), action: "navigate('adminFeedback')" },
          ])
      : [];

    // Vendor/buyer profile panel: header -> a small "at a glance" strip ->
    // divider -> plain utility rows (no icons) -> divider -> Settings & Privacy.
    let miniStats = [];
    let plainLinks = [];
    if (vendor && profile.role !== "admin") {
      miniStats = [
        { label: "Pending orders", value: Number(vendorPendingOrderCount || 0), action: "navigate('vendorOrders',{status:'all',perspective:'sales'})" },
        { label: "Suggestions", value: Number(unreadSuggestionCount || 0), action: "navigate('vendorSuggestionsInbox')" },
        { label: "Number of listings", value: Number(vendorProductCount || 0), action: "navigate('vendorProducts')" },
        { label: "Views today", value: Number(vendorProfileViewsToday || 0), action: "navigate('vendorDashboard')" },
        { label: "Orders today", value: Number(vendorOrdersToday || 0), action: "navigate('vendorOrders',{status:'all',perspective:'sales'})" },
      ];
      const pend = Number(vendorPendingOrderCount || 0);
      plainLinks = [
        { icon: "fa-boxes-stacked", tone: "blue", label: "My listings", action: "navigate('vendorProducts')" },
        { icon: "fa-receipt", tone: "amber", label: "Orders", badge: pend, action: "navigate('vendorOrders',{status:'all',perspective:'sales'})" },
        { icon: "fa-trophy", tone: "amber", label: "Leaderboard", action: "navigate('leaderboard')" },
        { icon: "fa-gift", tone: "violet", label: "Refer &amp; earn", action: "navigate('leaderboard',{tab:'refer'})" },
        { icon: "fa-user-group", tone: "violet", label: "Followers", action: "navigate('vendorFollowers')" },
        { icon: "fa-comment-dots", tone: "blue", label: "Messages", action: "navigate('messages')" },
        { icon: "fa-hand", tone: "pink", label: "Requests", badge: Number(requestOfferBadgeCount || 0), action: "navigate('vendorRequests')" },
        { icon: "fa-lightbulb", tone: "amber", label: "Suggestions", badge: Number(unreadSuggestionCount || 0), action: "navigate('vendorSuggestionsInbox')" },
        { icon: "fa-compass", tone: "slate", label: "Take a tour", action: "closeAllPanels();showTour()" },
        { icon: "fa-headset", tone: "teal", label: "Support", action: "navigate('supportRequest')" },
        { icon: "fa-lightbulb", tone: "violet", label: "Suggest to Levromart", action: "showSuggestionModal('platform')" },
        { icon: "fa-comments", tone: "violet", label: "Suggestion replies", action: "navigate('suggestionReplies')" },
        { icon: "fa-phone", tone: "teal", label: "Contact us", action: "navigate('contactUs')" },
      ];
    } else if (profile.role !== "admin") {
      miniStats = [
        { label: "Total orders", value: Number(buyerTotalOrderCount || 0), action: "navigate('buyerOrders')" },
        { label: "Pending orders", value: Number(buyerPendingOrderCount || 0), action: "navigate('buyerOrders',{status:'pending'})" },
        { label: "Saved items", value: (favoriteIds?.size || 0) + (packageFavoriteIds?.size || 0), action: "navigate('wishlist')" },
        { label: "Vendors followed", value: Number(buyerFollowingCount || 0), action: "navigate('customerFollowing')" },
      ];
      plainLinks = [
        { icon: "fa-store", tone: "green", label: "Apply to be a vendor", action: "navigate('vendorApply')" },
        { icon: "fa-receipt", tone: "amber", label: "My orders", badge: Number(buyerPendingOrderCount || 0), action: "navigate('buyerOrders')" },
        { icon: "fa-heart", tone: "pink", label: "Wishlist", action: "navigate('wishlist')" },
        { icon: "fa-user-group", tone: "violet", label: "Vendors you follow", action: "navigate('customerFollowing')" },
        { icon: "fa-trophy", tone: "amber", label: "Vendor leaderboard", action: "navigate('leaderboard')" },
        { icon: "fa-comment-dots", tone: "blue", label: "Messages", action: "navigate('messages')" },
        { icon: "fa-bell", tone: "amber", label: "Notifications", action: "navigate('notifications')" },
        { icon: "fa-box-open", tone: "green", label: "Request an item", action: "navigate('requestEquipment')" },
        { icon: "fa-shop", tone: "blue", label: "Browse vendors", action: "navigate('vendors')" },
        { icon: "fa-compass", tone: "slate", label: "Take a tour", action: "closeAllPanels();showTour()" },
        { icon: "fa-headset", tone: "teal", label: "Support", action: "navigate('supportRequest')" },
        { icon: "fa-lightbulb", tone: "violet", label: "Suggest to Levromart", action: "showSuggestionModal('platform')" },
        { icon: "fa-comments", tone: "violet", label: "Suggestion replies", action: "navigate('suggestionReplies')" },
        { icon: "fa-phone", tone: "teal", label: "Contact us", action: "navigate('contactUs')" },
      ];
    }

    panel.innerHTML = `
      <div class="profile-panel-static">
        <div class="drawer-header"><h4>Profile</h4><button class="drawer-close-btn profile-settings-gear" onclick="closeAllPanels();navigate('settings')" aria-label="Settings" title="Settings">${window.LV_SETTINGS_SVG}</button></div>

        <div class="profile-panel-header ${vendor ? 'profile-own-storefront-header' : 'profile-customer-following-header'}" ${vendor ? `role="button" tabindex="0" aria-label="View your full profile" onclick="closeAllPanels();navigate('vendorDashboard')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();closeAllPanels();navigate('vendorDashboard')}"` : profile.role !== 'admin' ? `role="button" tabindex="0" aria-label="View your full profile" onclick="closeAllPanels();navigate('buyerProfile')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();closeAllPanels();navigate('buyerProfile')}"` : ''}>
          <div class="avatar-edit-wrap">
            ${profile.avatar_url
              ? `<button type="button" class="profile-avatar-lightbox-btn" onclick="openProfileImageLightbox('${esc(profile.avatar_url)}','${esc(profile.name || "Profile")}',event)" aria-label="View profile picture"><img src="${esc(profile.avatar_url)}" class="avatar-circle avatar-lg" style="object-fit:cover;" alt="${esc(profile.name || "Profile")}" draggable="false" /></button>`
              : avatarFallbackHtml(profile.name || profile.email, "3rem", "avatar-lg", profile.name || profile.email)}
            <button type="button" class="avatar-edit-badge" onclick="openAvatarActions(event)" title="Edit profile picture" aria-label="Edit profile picture"><i class="fa-solid fa-pen"></i></button>
            <input type="file" id="avatarFileInput" accept="image/*" class="hidden" onchange="uploadAvatar(event)" />
          </div>
          <div class="profile-account-copy">
            
            <strong class="profile-account-name">${esc(profile.name || "")}</strong>
            <span class="profile-account-email muted">${esc(profile.email)}</span>
            <span class="badge profile-role-badge ${profile.role === "admin" ? "" : "lv-hide"}">${profile.role === "admin" ? "admin" : vendor ? "vendor" : "customer"}</span>
            ${profile.role !== "admin" ? `<span class="profile-view-full-link">View full profile <i class="fa-solid fa-chevron-right"></i></span>` : ""}
          </div>
        </div>
      </div>
      <div class="profile-panel-scroll">
        ${profile.role === "admin" ? `<div class="lv-pp">
          <div class="lv-pp-stats admin-profile-stats">${adminStats.map(s => `<button type="button" class="lv-pp-stat" data-admin-stat="${esc(s.key)}" onclick="closeAllPanels();${s.action || ""}"><b>${s.value}</b> ${esc(String(s.label).toLowerCase())}</button>`).join("")}</div>
          <div class="lv-pp-group">${links.map((l) => `<button type="button" class="lv-pp-row"${l.profileKey ? ` data-profile-key="${esc(l.profileKey)}"` : ""} onclick="closeAllPanels();${l.action}">${l.label}</button>`).join("")}</div>
        </div>` : `
        <div class="lv-pp">
          <div class="lv-pp-stats${vendor ? "" : " lv-hide"}">${(vendor
            ? [{ n: Number(vendorProductCount || 0), t: Number(vendorProductCount || 0) === 1 ? "listing" : "listings", a: "navigate('vendorProducts')" }, { n: Number(vendorPendingOrderCount || 0), t: "pending orders", a: "navigate('vendorOrders',{status:'all',perspective:'sales'})" }]
            : [{ n: Number(buyerTotalOrderCount || 0), t: Number(buyerTotalOrderCount || 0) === 1 ? "order" : "orders", a: "navigate('buyerOrders')" }, { n: (favoriteIds?.size || 0) + (packageFavoriteIds?.size || 0), t: "saved items", a: "navigate('wishlist')" }]
          ).map(x => `<button type="button" class="lv-pp-stat" onclick="closeAllPanels();${x.a}"><b>${x.n}</b> ${x.t}</button>`).join("")}</div>
          ${(() => {
            const keepGroups = vendor
              ? [["My shop", "My listings", "Earnings"], ["Requests", "Suggestions", "Leaderboard"], ["Support", "Contact us", "Suggest to Levromart", "Take a tour"]]
              : [["Wishlist"], ["Vendor leaderboard", "Request an item", "Support", "Contact us", "Suggest to Levromart", "Suggestion replies", "Take a tour"]];
            const PP_ICONS = {"Suggestion replies":"<path d='M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'/>","My shop":"<path d='M15 21v-5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5'/> <path d='M17.774 10.31a1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.451 0 1.12 1.12 0 0 0-1.548 0 2.5 2.5 0 0 1-3.452 0 1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.77-3.248l2.889-4.184A2 2 0 0 1 7 2h10a2 2 0 0 1 1.653.873l2.895 4.192a2.5 2.5 0 0 1-3.774 3.244'/> <path d='M4 10.95V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8.05'/>","My listings":"<path d='M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z'/> <path d='M12 22V12'/> <polyline points='3.29 7 12 12 20.71 7'/> <path d='m7.5 4.27 9 5.15'/>","Orders":"<path d='M13 16H8'/> <path d='M14 8H8'/> <path d='M16 12H8'/> <path d='M4 3a1 1 0 0 1 1-1 1.3 1.3 0 0 1 .7.2l.933.6a1.3 1.3 0 0 0 1.4 0l.934-.6a1.3 1.3 0 0 1 1.4 0l.933.6a1.3 1.3 0 0 0 1.4 0l.933-.6a1.3 1.3 0 0 1 1.4 0l.934.6a1.3 1.3 0 0 0 1.4 0l.933-.6A1.3 1.3 0 0 1 19 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1 1.3 1.3 0 0 1-.7-.2l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.934.6a1.3 1.3 0 0 1-1.4 0l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-1.4 0l-.934-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-.7.2 1 1 0 0 1-1-1z'/>","My orders":"<path d='M13 16H8'/> <path d='M14 8H8'/> <path d='M16 12H8'/> <path d='M4 3a1 1 0 0 1 1-1 1.3 1.3 0 0 1 .7.2l.933.6a1.3 1.3 0 0 0 1.4 0l.934-.6a1.3 1.3 0 0 1 1.4 0l.933.6a1.3 1.3 0 0 0 1.4 0l.933-.6a1.3 1.3 0 0 1 1.4 0l.934.6a1.3 1.3 0 0 0 1.4 0l.933-.6A1.3 1.3 0 0 1 19 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1 1.3 1.3 0 0 1-.7-.2l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.934.6a1.3 1.3 0 0 1-1.4 0l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-1.4 0l-.934-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-.7.2 1 1 0 0 1-1-1z'/>","Earnings":"<path d='M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1'/> <path d='M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4'/>","Requests":"<path d='M12 22V12'/> <path d='M20.27 18.27 22 20'/> <path d='M21 10.498V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.729l7 4a2 2 0 0 0 2 .001l.98-.559'/> <path d='M3.29 7 12 12l8.71-5'/> <path d='m7.5 4.27 8.997 5.148'/> <circle cx='18.5' cy='16.5' r='2.5'/>","Suggestions":"<path d='M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5'/> <path d='M9 18h6'/> <path d='M10 22h4'/>","Leaderboard":"<path d='M10 14.66V17a1 1 0 0 1-1 1 2 2 0 0 0-2 2v2'/> <path d='M14 14.66V17a1 1 0 0 0 1 1 2 2 0 0 1 2 2v2'/> <path d='M17.916 10H19.5A2.5 2.5 0 0 0 22 7.5V5a1 1 0 0 0-1-1h-3'/> <path d='M4 22h16'/> <path d='M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z'/> <path d='M6.084 10H4.5A2.5 2.5 0 0 1 2 7.5V5a1 1 0 0 1 1-1h3'/>","Vendor leaderboard":"<path d='M10 14.66V17a1 1 0 0 1-1 1 2 2 0 0 0-2 2v2'/> <path d='M14 14.66V17a1 1 0 0 0 1 1 2 2 0 0 1 2 2v2'/> <path d='M17.916 10H19.5A2.5 2.5 0 0 0 22 7.5V5a1 1 0 0 0-1-1h-3'/> <path d='M4 22h16'/> <path d='M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z'/> <path d='M6.084 10H4.5A2.5 2.5 0 0 1 2 7.5V5a1 1 0 0 1 1-1h3'/>","Support":"<circle cx='12' cy='12' r='10'/><path d='M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3'/><path d='M12 17h.01'/>","Suggest to Levromart":"<path d='M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719'/>","Take a tour":"<circle cx='12' cy='12' r='10'/> <path d='m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z'/>","Contact us":"<path d='M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384'/>","Apply to be a vendor":"<path d='M15 21v-5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5'/> <path d='M17.774 10.31a1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.451 0 1.12 1.12 0 0 0-1.548 0 2.5 2.5 0 0 1-3.452 0 1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.77-3.248l2.889-4.184A2 2 0 0 1 7 2h10a2 2 0 0 1 1.653.873l2.895 4.192a2.5 2.5 0 0 1-3.774 3.244'/> <path d='M4 10.95V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8.05'/>","Wishlist":"<path d='M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5'/>","Request an item":"<path d='M12 22V12'/> <path d='M20.27 18.27 22 20'/> <path d='M21 10.498V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.729l7 4a2 2 0 0 0 2 .001l.98-.559'/> <path d='M3.29 7 12 12l8.71-5'/> <path d='m7.5 4.27 8.997 5.148'/> <circle cx='18.5' cy='16.5' r='2.5'/>"};
            const row = (l) => `<button type="button" class="lv-pp-row" onclick="closeAllPanels();${l.action}">${PP_ICONS[l.label] ? `<svg class="lv-pp-ico" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PP_ICONS[l.label]}</svg>` : ""}${l.label === "Settings &amp; Privacy" ? '<svg class="lm-gear" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>' : ""}<span>${l.label.replace("Vendor leaderboard", "Leaderboard")}</span>${l.badge > 0 ? `<em class="lv-pp-badge">${l.badge > 9 ? "9+" : l.badge}</em>` : ""}</button>`;
            const groups = keepGroups.map(names => names.map(n => plainLinks.find(l => l.label === n)).filter(Boolean));
            groups.push([{ label: "Settings &amp; Privacy", action: "navigate('settings')" }, { label: "Log out", action: "logout()" }]);
            const logoutRow = `<button type="button" class="lv-pp-row lv-pp-logout" onclick="closeAllPanels();logout()"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg><span>Log out</span></button>`;
            const becomeCard = vendor ? "" : `<button type="button" class="lv-pp-become" onclick="closeAllPanels();navigate('vendorApply')"><span class="lv-pp-become-ic"><i class="fa-solid fa-store"></i></span><span class="lv-pp-become-t"><b>Become a vendor</b><small>Open your shop in minutes</small></span><i class="fa-solid fa-arrow-right"></i></button>`;
            return becomeCard + groups.filter(g => g.length).map(g => `<div class="lv-pp-group">${g.map((l) => l.label === "Log out" ? logoutRow : row(l)).join("")}</div>`).join("");
          })()}
        </div></div>`}
      </div>
    `;
    byId("accountDangerSection")?.classList.remove("hidden");
    byId("changePasswordSection")?.classList.remove("hidden");
    if (profile.role === "admin") hydrateAdminProfileStats();
  } else {
    avatarBtn.classList.add("hidden");
    loginBtn.classList.remove("hidden");
    panel.innerHTML = "";
    byId("accountDangerSection")?.classList.add("hidden");
    byId("changePasswordSection")?.classList.add("hidden");
  }
}

// Admin "at a glance" stats shown in the profile drawer. Super admins get
// platform-wide people/revenue totals; added/sub-admins only get their own
// activity counts (never platform financials or people counts).
async function hydrateAdminProfileStats() {
  if (!session || profile?.role !== "admin" || typeof sb === "undefined") return;
  const patchStat = (key, value) => {
    document.querySelectorAll(`.admin-profile-stats [data-admin-stat="${key}"] strong, .admin-profile-stats [data-admin-stat="${key}"] b`).forEach((el) => { el.textContent = value; });
  };
  try {
    if (isSuperAdmin()) {
      const [{ count: totalUserCount }, { count: buyerCount }, { count: vendorCount }, { count: activeProductCount }] = await Promise.all([
        sb.from("users").select("id", { count: "exact", head: true }),
        sb.from("users").select("id", { count: "exact", head: true }).eq("role", "buyer"),
        sb.from("users").select("id", { count: "exact", head: true }).eq("role", "vendor"),
        sb.from("products").select("id", { count: "exact", head: true }).eq("status", "active"),
      ]);
      window.__adminStatTotalUsers = Number(totalUserCount || 0);
      window.__adminStatBuyers = Number(buyerCount || 0);
      window.__adminStatVendors = Number(vendorCount || 0);
      window.__adminStatActiveProducts = Number(activeProductCount || 0);
      patchStat("totalUsers", window.__adminStatTotalUsers);
      patchStat("buyers", window.__adminStatBuyers);
      patchStat("vendors", window.__adminStatVendors);
      patchStat("activeProducts", window.__adminStatActiveProducts);
    } else {
      const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
      const [{ count: loginsToday }, { count: loginLogs }, { count: supportCount }, { count: feedbackCount }, { count: disputeCount }] = await Promise.all([
        sb.from("auth_activity_logs").select("id", { count: "exact", head: true }).eq("event_type", "login").gte("occurred_at", startOfToday.toISOString()),
        sb.from("auth_activity_logs").select("id", { count: "exact", head: true }).eq("event_type", "login"),
        sb.from("support_requests").select("id", { count: "exact", head: true }).in("status", ["open", "in_progress"]),
        sb.from("suggestions").select("id", { count: "exact", head: true }).eq("status", "new"),
        sb.from("disputes").select("id", { count: "exact", head: true }).not("status", "in", "(resolved,closed)"),
      ]);
      window.__adminStatLoginsToday = Number(loginsToday || 0);
      window.__adminStatLoginLogs = Number(loginLogs || 0);
      window.__adminStatSupportRequests = Number(supportCount || 0);
      window.__adminStatFeedback = Number(feedbackCount || 0);
      window.__adminDisputeCount = Number(disputeCount || 0);
      patchStat("loginsToday", window.__adminStatLoginsToday);
      patchStat("loginLogs", window.__adminStatLoginLogs);
      patchStat("supportRequests", window.__adminStatSupportRequests);
      patchStat("feedback", window.__adminStatFeedback);
      patchStat("disputes", window.__adminDisputeCount);
    }
  } catch (err) {
    console.warn("[Levromart] Admin profile stats refresh failed:", err);
  }
}

let pendingAvatarFile = null;
let avatarCropState = null;

function closeMediaActionSheet(){ byId("mediaActionSheet")?.remove(); }
function openMediaActionSheet(title, items){
  closeMediaActionSheet();
  const modal=document.createElement("div");
  modal.id="mediaActionSheet"; modal.className="media-action-sheet";
  modal.innerHTML=`<div class="media-action-sheet-backdrop" onclick="closeMediaActionSheet()"></div><div class="media-action-sheet-card" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="media-action-sheet-head"><strong>${esc(title)}</strong><button type="button" class="drawer-close-btn" onclick="closeMediaActionSheet()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>${items.map(i=>`<button type="button" class="media-action-sheet-item ${i.danger?'danger':''}" ${i.disabled?'disabled':''} onclick="${i.action}"><i class="fa-solid ${i.icon}"></i><span><strong>${esc(i.label)}</strong>${i.note?`<small>${esc(i.note)}</small>`:''}</span><i class="fa-solid fa-chevron-right media-action-sheet-arrow"></i></button>`).join("")}</div>`;
  document.body.appendChild(modal);
}
function openAvatarActions(event){
  event?.stopPropagation?.();
  const has=!!profile?.avatar_url;
  openMediaActionSheet("Profile picture", [
    {label:"Edit",icon:"fa-crop-simple",note:has?"Crop or reposition your current picture.":"Choose a picture first.",disabled:!has,action:"editCurrentAvatar();"},
    {label:"Replace",icon:"fa-camera",note:"Choose a new picture and adjust it.",action:"closeMediaActionSheet();byId('avatarFileInput')?.click();"},
    {label:"Remove",icon:"fa-trash-can",note:"Remove your current picture.",danger:true,disabled:!has,action:"closeMediaActionSheet();removeProfileAvatar();"}
  ]);
}
async function editCurrentAvatar(){
  closeMediaActionSheet();
  if(!profile?.avatar_url)return;
  try{
    const res=await fetch(profile.avatar_url,{cache:"no-store"});
    if(!res.ok)throw new Error("Could not load the current profile picture.");
    const blob=await res.blob();
    pendingAvatarFile=new File([blob],"current-avatar.jpg",{type:blob.type||"image/jpeg"});
    openAvatarCropModal(pendingAvatarFile);
  }catch(e){showToast(e.message||"Could not edit the current profile picture.","error");}
}
function openVendorCoverActions(event){
  event?.stopPropagation?.();
  const has=!!vendor?.cover_url;
  openMediaActionSheet("Storefront header", [
    {label:"Edit",icon:"fa-crop-simple",note:has?"Crop or reposition your current header.":"Choose a header image first.",disabled:!has,action:"editCurrentVendorCover();"},
    {label:"Replace",icon:"fa-camera",note:"Choose a new header image and adjust it.",action:"closeMediaActionSheet();byId('vendorCoverInput')?.click();"},
    {label:"Remove",icon:"fa-trash-can",note:"Remove your current header image.",danger:true,disabled:!has,action:"closeMediaActionSheet();removeVendorCover();"}
  ]);
}
let pendingVendorCoverFile=null;
let vendorCoverCropState=null;
async function editCurrentVendorCover(){
  closeMediaActionSheet();
  if(!vendor?.cover_url)return;
  try{
    const res=await fetch(vendor.cover_url,{cache:"no-store"});
    if(!res.ok)throw new Error("Could not load the current storefront header.");
    const blob=await res.blob();
    pendingVendorCoverFile=new File([blob],"current-cover.jpg",{type:blob.type||"image/jpeg"});
    openVendorCoverCropModal(pendingVendorCoverFile);
  }catch(e){showToast(e.message||"Could not edit the current storefront header.","error");}
}
function openVendorCoverCropModal(file){
  const reader=new FileReader();
  reader.onload=()=>{
    byId("vendorCoverCropModal")?.remove();
    const modal=document.createElement("div"); modal.id="vendorCoverCropModal"; modal.className="modal";
    modal.innerHTML=`<div class="modal-content cover-crop-modal-content"><div class="drawer-header"><h3 style="margin:0;"><i class="fa-solid fa-crop-simple"></i> Adjust storefront header</h3><button type="button" class="drawer-close-btn" onclick="closeVendorCoverCropModal()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div><p class="muted" style="margin:.25rem 0 .8rem;">Move and zoom the image to choose exactly what appears across your storefront header.</p><div class="cover-crop-viewport" id="vendorCoverCropViewport"><img id="vendorCoverCropImage" src="${esc(reader.result)}" alt="Storefront header crop" draggable="false"></div><label class="avatar-crop-zoom"><span>Zoom</span><input id="vendorCoverCropZoom" type="range" min="1" max="3" step="0.01" value="1" oninput="updateVendorCoverCropTransform()"></label><div class="flex" style="justify-content:flex-end;margin-top:.9rem;"><button type="button" class="btn btn-outline" onclick="closeVendorCoverCropModal()">Cancel</button><button type="button" class="btn" onclick="saveVendorCoverCrop()"><i class="fa-solid fa-check"></i> Use header</button></div></div>`;
    document.body.appendChild(modal);
    const img=byId("vendorCoverCropImage");
    vendorCoverCropState={scale:1,x:0,y:0,ox:0,oy:0,dragging:false};
    img.onload=()=>updateVendorCoverCropTransform();
    const v=byId("vendorCoverCropViewport");
    const start=e=>{vendorCoverCropState.dragging=true;vendorCoverCropState.ox=e.clientX-vendorCoverCropState.x;vendorCoverCropState.oy=e.clientY-vendorCoverCropState.y;try{v.setPointerCapture(e.pointerId)}catch(_){} };
    const move=e=>{if(!vendorCoverCropState?.dragging)return;vendorCoverCropState.x=e.clientX-vendorCoverCropState.ox;vendorCoverCropState.y=e.clientY-vendorCoverCropState.oy;updateVendorCoverCropTransform();};
    const end=()=>{if(vendorCoverCropState)vendorCoverCropState.dragging=false;};
    v.addEventListener("pointerdown",start);v.addEventListener("pointermove",move);v.addEventListener("pointerup",end);v.addEventListener("pointercancel",end);
  };
  reader.readAsDataURL(file);
}
function updateVendorCoverCropTransform(){
  const img=byId("vendorCoverCropImage"),v=byId("vendorCoverCropViewport");if(!img||!v||!vendorCoverCropState)return;
  const scale=Number(byId("vendorCoverCropZoom")?.value||1);vendorCoverCropState.scale=scale;
  const base=Math.max(v.clientWidth/(img.naturalWidth||1),v.clientHeight/(img.naturalHeight||1));
  img.style.width=`${(img.naturalWidth||100)*base}px`;img.style.height=`${(img.naturalHeight||100)*base}px`;
  img.style.transform=`translate(calc(-50% + ${vendorCoverCropState.x}px),calc(-50% + ${vendorCoverCropState.y}px)) scale(${scale})`;
}
function closeVendorCoverCropModal(){byId("vendorCoverCropModal")?.remove();vendorCoverCropState=null;pendingVendorCoverFile=null;}
async function saveVendorCoverCrop(){
  if(!pendingVendorCoverFile||!vendorCoverCropState||!vendor)return;
  const v=byId("vendorCoverCropViewport"),img=byId("vendorCoverCropImage");if(!v||!img)return;
  const width=1600,height=600,canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;const ctx=canvas.getContext("2d");
  const base=Math.max(v.clientWidth/(img.naturalWidth||1),v.clientHeight/(img.naturalHeight||1));
  const displayW=(img.naturalWidth||1)*base*vendorCoverCropState.scale,displayH=(img.naturalHeight||1)*base*vendorCoverCropState.scale;
  const left=(v.clientWidth-displayW)/2+vendorCoverCropState.x,top=(v.clientHeight-displayH)/2+vendorCoverCropState.y;
  const sx=Math.max(0,-left)*(img.naturalWidth/displayW),sy=Math.max(0,-top)*(img.naturalHeight/displayH);
  const sw=Math.min(img.naturalWidth,v.clientWidth*img.naturalWidth/displayW),sh=Math.min(img.naturalHeight,v.clientHeight*img.naturalHeight/displayH);
  ctx.drawImage(img,sx,sy,sw,sh,0,0,width,height);
  const useBtn=document.querySelector("#vendorCoverCropModal .btn:not(.btn-outline), .cover-crop-modal-content .btn:not(.btn-outline)");
  const setBusy=(on)=>{ if(!useBtn) return; useBtn.disabled=on; if(on){ useBtn.dataset.h=useBtn.innerHTML; useBtn.innerHTML='<i class="fa-solid fa-spinner fa-spin"></i> Saving…'; } else if(useBtn.dataset.h){ useBtn.innerHTML=useBtn.dataset.h; } };
  setBusy(true);
  canvas.toBlob(async blob=>{
    if(!blob){setBusy(false);showToast("Could not prepare that header.","error");return;}
    try{
      const path=`vendor-logos/${vendor.id}/cover.jpg`;
      const url=`${await uploadToR2(blob,path,"image/jpeg")}?t=${Date.now()}`;
      const {error}=await sb.from("vendors").update({cover_url:url}).eq("id",vendor.id);if(error)throw error;
      vendor.cover_url=url;closeVendorCoverCropModal();showToast("Storefront header updated.","success");
      try{document.querySelectorAll("#app .storefront-cover").forEach(el=>{el.classList.add("has-custom-cover");el.style.backgroundImage=`url('${url}')`;el.style.backgroundSize="cover";el.style.backgroundPosition="center";el.querySelector(".storefront-cover-empty")?.remove();if(!el.querySelector(".storefront-cover-overlay"))el.insertAdjacentHTML("afterbegin",'<div class="storefront-cover-overlay"></div>');});}catch(_){}
    }catch(e){setBusy(false);showToast(e.message||"Could not update storefront header.","error");}
  },"image/jpeg",0.9);
}
function uploadAvatar(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file || !session) return;
  if (!String(file.type || '').startsWith('image/')) { showToast('Please choose an image.', 'error'); return; }
  lvPrepareImageFile(file, 1600).then((small) => { pendingAvatarFile = small; openAvatarCropModal(small); }).catch(() => showToast("Couldn't open that photo. Try another one.", "error"));
}
// Keep the account photo and public vendor avatar on one source of truth.
// Notifications snapshot users.avatar_url; storefronts and vendor cards read
// vendors.logo_url. Resolve the vendor by the authenticated owner instead of
// relying on the global vendor object being loaded on this screen.
async function syncOwnVendorAvatarToProfilePhoto(url) {
  if (!session?.user?.id) return false;
  const userId = session.user.id;
  const { data: ownVendor, error: lookupError } = await sb.from("vendors")
    .select("id").eq("user_id", userId).is("deleted_at", null).maybeSingle();
  if (lookupError) throw lookupError;
  if (!ownVendor?.id) return false;
  const { error } = await sb.from("vendors").update({ logo_url: url || null })
    .eq("id", ownVendor.id).eq("user_id", userId);
  if (error) throw error;
  if (vendor?.id === ownVendor.id) vendor.logo_url = url || null;
  return true;
}

async function removeProfileAvatar(event) {
  event?.stopPropagation?.();
  if (!session) return;
  const confirmed = await showConfirmDialog("Remove your profile picture?", { title: "Remove profile picture", okLabel: "Remove", danger: true });
  if (!confirmed) return;
  const { error } = await sb.from("users").update({ avatar_url: null }).eq("id", session.user.id);
  if (error) { showToast(error.message || "Could not remove your profile picture.", "error"); return; }
  profile.avatar_url = null;
  let vendorSyncError = null;
  try { await syncOwnVendorAvatarToProfilePhoto(null); }
  catch (syncError) {
    vendorSyncError = syncError;
    console.warn("Vendor profile-photo removal sync failed:", syncError);
  }
  await sb.storage.from("avatars").remove([`${session.user.id}/avatar.jpg`,`${session.user.id}/avatar.jpeg`,`${session.user.id}/avatar.png`,`${session.user.id}/avatar.webp`]).catch(()=>{});
  updateAuthUI();
  try { window.lvAvatarChanged?.(); } catch (_) {}
  showToast(vendorSyncError
    ? "Profile picture removed from your account, but the storefront photo could not be synced. Please retry."
    : "Profile picture removed.", vendorSyncError ? "warning" : "success");
}

function openAvatarCropModal(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const modal = document.createElement('div');
    modal.id = 'avatarCropModal';
    modal.className = 'modal';
    modal.innerHTML = `<div class="modal-content avatar-crop-modal-content">
      <div class="drawer-header"><h3 style="margin:0;"><i class="fa-solid fa-crop-simple"></i> Adjust profile photo</h3><button type="button" class="drawer-close-btn" onclick="closeAvatarCropModal()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>
      <p class="muted" style="margin:.25rem 0 .8rem;">Move and zoom the photo to choose exactly what people see.</p>
      <div class="avatar-crop-viewport" id="avatarCropViewport"><img id="avatarCropImage" src="${esc(reader.result)}" alt="Profile photo crop" draggable="false"></div>
      <label class="avatar-crop-zoom"><span>Zoom</span><input id="avatarCropZoom" type="range" min="1" max="3" step="0.01" value="1" oninput="updateAvatarCropTransform()"></label>
      <div class="flex" style="justify-content:flex-end;margin-top:.9rem;"><button type="button" class="btn btn-outline" onclick="closeAvatarCropModal()">Cancel</button><button type="button" class="btn" onclick="saveAvatarCrop()"><i class="fa-solid fa-check"></i> Use photo</button></div>
    </div>`;
    document.body.appendChild(modal);
    const img = byId('avatarCropImage');
    avatarCropState = { scale:1, x:0, y:0, sx:0, sy:0, ox:0, oy:0, dragging:false, imgNaturalW:0, imgNaturalH:0 };
    img.onload = () => { avatarCropState.imgNaturalW=img.naturalWidth; avatarCropState.imgNaturalH=img.naturalHeight; updateAvatarCropTransform(); };
    bindAvatarCropDrag();
  };
  reader.readAsDataURL(file);
}
function bindAvatarCropDrag() {
  const viewport = byId('avatarCropViewport');
  if (!viewport || viewport.dataset.bound) return;
  viewport.dataset.bound = '1';
  const start = (e) => { if (!avatarCropState) return; avatarCropState.dragging=true; avatarCropState.ox=e.clientX-avatarCropState.x; avatarCropState.oy=e.clientY-avatarCropState.y; try{viewport.setPointerCapture(e.pointerId);}catch(_){} };
  const move = (e) => { if (!avatarCropState?.dragging) return; avatarCropState.x=e.clientX-avatarCropState.ox; avatarCropState.y=e.clientY-avatarCropState.oy; updateAvatarCropTransform(); };
  const end = () => { if (avatarCropState) avatarCropState.dragging=false; };
  viewport.addEventListener('pointerdown',start); viewport.addEventListener('pointermove',move); viewport.addEventListener('pointerup',end); viewport.addEventListener('pointercancel',end);
}
function updateAvatarCropTransform() {
  const img=byId('avatarCropImage'); const v=byId('avatarCropViewport'); if(!img||!v||!avatarCropState)return;
  const scale=Number(byId('avatarCropZoom')?.value||1); avatarCropState.scale=scale;
  const base=Math.max(v.clientWidth/(img.naturalWidth||1), v.clientHeight/(img.naturalHeight||1));
  img.style.width=`${(img.naturalWidth||100)*base}px`; img.style.height=`${(img.naturalHeight||100)*base}px`;
  img.style.transform=`translate(calc(-50% + ${avatarCropState.x}px), calc(-50% + ${avatarCropState.y}px)) scale(${scale})`;
}
function closeAvatarCropModal(){ byId('avatarCropModal')?.remove(); avatarCropState=null; pendingAvatarFile=null; }
async function saveAvatarCrop(){
  if(!pendingAvatarFile||!avatarCropState)return;
  const v=byId('avatarCropViewport'), img=byId('avatarCropImage'); if(!v||!img)return;
  const size=800; const canvas=document.createElement('canvas'); canvas.width=size; canvas.height=size; const ctx=canvas.getContext('2d');
  const base=Math.max(v.clientWidth/(img.naturalWidth||1), v.clientHeight/(img.naturalHeight||1));
  const displayW=(img.naturalWidth||1)*base*avatarCropState.scale, displayH=(img.naturalHeight||1)*base*avatarCropState.scale;
  const left=(v.clientWidth-displayW)/2+avatarCropState.x, top=(v.clientHeight-displayH)/2+avatarCropState.y;
  const sx=Math.max(0,-left)*(img.naturalWidth/displayW), sy=Math.max(0,-top)*(img.naturalHeight/displayH);
  const sw=Math.min(img.naturalWidth, v.clientWidth*img.naturalWidth/displayW); const sh=Math.min(img.naturalHeight, v.clientHeight*img.naturalHeight/displayH);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, size, size);
  const aBtn=document.querySelector('#avatarCropModal .btn:not(.btn-outline)');
  const aBusy=(on)=>{ if(!aBtn) return; aBtn.disabled=on; if(on){ aBtn.dataset.h=aBtn.innerHTML; aBtn.innerHTML='<i class="fa-solid fa-spinner fa-spin"></i> Saving…'; } else if(aBtn.dataset.h){ aBtn.innerHTML=aBtn.dataset.h; } };
  aBusy(true);
  canvas.toBlob(async (blob)=>{
    if(!blob){aBusy(false);showToast('Could not prepare that photo.','error');return;}
    const path=`avatars/${session.user.id}/avatar.jpg`;
    let publicUrl;
    try{ publicUrl=await uploadToR2(blob,path,'image/jpeg'); }
    catch(upErr){ aBusy(false); showToast(upErr.message,'error'); return; }
    const url=`${publicUrl}?t=${Date.now()}`;
    const {error}=await sb.from('users').update({avatar_url:url}).eq('id',session.user.id);
    if(error){aBusy(false);showToast(error.message,'error');return;}
    profile.avatar_url=url;
    let vendorSyncError = null;
    try { await syncOwnVendorAvatarToProfilePhoto(url); }
    catch (syncError) {
      vendorSyncError = syncError;
      console.warn("Vendor profile-photo sync failed:", syncError);
    }
    updateAuthUI(); closeAvatarCropModal();
    showToast(vendorSyncError
      ? 'Profile photo updated, but the storefront photo could not be synced. Please retry.'
      : 'Profile photo updated.',
      vendorSyncError ? 'warning' : 'success');
    try{window.lvAvatarChanged?.();}catch(_){}
  },'image/jpeg',0.9);
}

