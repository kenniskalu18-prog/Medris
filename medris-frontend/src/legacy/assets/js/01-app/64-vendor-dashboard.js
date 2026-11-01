// ---------- VENDOR DASHBOARD ----------
// One clear card for the vendor: how much is owed, how long is left, and a bar
// showing how much of the 7-day window has gone. Turns amber near the end and
// red once overdue. (The countdown text itself is filled in by the shared
// ".levro-commission-deadline" ticker.)
function commissionCardHtml(owed, overdue, dueAt, copy) {
  const WINDOW = 7 * 86400000;
  const left = dueAt ? new Date(dueAt).getTime() - Date.now() : null;
  const used = left == null ? 0 : Math.max(0, Math.min(100, Math.round(100 * (1 - left / WINDOW))));
  const urgency = overdue ? "overdue" : (left != null && left <= 3 * 86400000 ? "soon" : "ok");
  return `<div class="commission-card commission-${urgency}" style="max-width:480px;margin:1rem auto 0;">
    <div class="commission-card-top"><span class="commission-card-label"><i class="fa-solid fa-hand-holding-dollar"></i> Commission you owe</span><button type="button" class="vendor-commission-info" title="About commission" aria-label="About commission" onclick="levroCommissionInfo()"><i class="fa-solid fa-info"></i></button></div>
    <div class="commission-card-amount">${naira(owed)}</div>
    <div class="commission-card-clock"><i class="fa-regular fa-clock"></i><strong class="levro-commission-deadline">Calculating…</strong></div>
    <div class="commission-card-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${used}"><span style="width:${used}%"></span></div>
    <p class="commission-card-copy">${copy}</p>
    <div id="commissionError" class="error-text hidden"></div>
    <button class="btn btn-sm" id="payCommissionBtn" onclick="toggleCommissionBreakdown()" aria-expanded="false"><i class="fa-solid fa-receipt"></i> Review commission breakdown</button>
    <div id="commissionBreakdown" class="vendor-commission-breakdown hidden" aria-live="polite"></div>
  </div>`;
}

async function renderVendorDashboard() {
  if (!session || profile?.role === "admin" || (profile?.role !== "vendor" && !vendor)) return '<div class="empty-state">Access denied.</div>';
  const { data: v } = await sb.from("vendors").select("*").eq("user_id", session.user.id).is("deleted_at", null).maybeSingle();
  if (!v) { navigate("vendorApply"); return '<p class="muted">Redirecting…</p>'; }
  vendor = v;

  // Backfill a previously uploaded account photo to the public vendor avatar.
  // This also repairs vendor rows whose earlier update was skipped because
  // the global vendor object had not been hydrated when the photo was saved.
  if (profile?.avatar_url && v.logo_url !== profile.avatar_url) {
    const { error: avatarSyncError } = await sb.from("vendors")
      .update({ logo_url: profile.avatar_url })
      .eq("id", v.id).eq("user_id", session.user.id);
    if (!avatarSyncError) {
      v.logo_url = profile.avatar_url;
      vendor.logo_url = profile.avatar_url;
    } else {
      console.warn("Vendor dashboard avatar backfill failed:", avatarSyncError);
    }
  }

  let statusBanner = "";
  if (v.verification_status === "pending") statusBanner = `<div class="banner banner-warning"><strong><i class='fa-solid fa-hourglass-half'></i> Verification pending.</strong> Your shop is under review. Once approved you can list products.</div>`;
  else if (v.verification_status === "rejected") statusBanner = `<div class="banner banner-danger"><strong>Application not approved.</strong> Contact support if this seems wrong.</div>`;
  else if (!v.is_active) statusBanner = `<div class="banner banner-muted"><strong><i class='fa-solid fa-pause'></i> Storefront paused.</strong> Customers can't see your shop or products right now.</div>`;
  const verifiedTick = v.verification_status === "verified"
    ? `<span data-vt="${v.id}" class="verified-tick" title="Verified vendor" onclick="navigate('storefront',{vendorId:'${v.id}'})"><i class="fa-solid fa-circle-check"></i></span>`
    : "";

  const [{ data: orders }, { data: products }, { data: owed }, { data: commissionDeadline }, { data: followerCounts }] = await Promise.all([
    sb.from("orders").select("status, total_amount, created_at").eq("vendor_id", v.id),
    sb.from("products").select("id, view_count, is_service, status").eq("vendor_id", v.id),
    sb.rpc("get_vendor_commission_owed", { p_vendor_id: v.id }),
    sb.rpc("get_vendor_commission_deadline", { p_vendor_id: v.id }),
    sb.rpc("get_vendor_follower_counts", { p_vendor_ids: [v.id] }),
  ]);
  const totalOrders = orders?.length ?? 0;
  const revenue = orders?.filter((o) => o.status === "completed").reduce((s, o) => s + o.total_amount, 0) ?? 0;
  const totalViews = (products || []).reduce((s, p) => s + (p.view_count || 0), 0);
  const liveProducts = (products || []).filter((p) => p.status !== "removed");
  const hubProducts = liveProducts.filter((p) => !p.is_service).length;
  const hubServices = liveProducts.filter((p) => p.is_service).length;
  const hubDiscarded = (products || []).length - liveProducts.length;
  let hubPackages = 0;
  try { const { count } = await sb.from("vendor_packages").select("id", { count: "exact", head: true }).eq("vendor_id", v.id); hubPackages = count || 0; } catch (_) {}
  const { data: favCounts } = (products || []).length
    ? await sb.rpc("get_favorite_counts", { p_product_ids: products.map((p) => p.id) })
    : { data: [] };
  const totalFavorites = (favCounts || []).reduce((s, r) => s + r.count, 0);
  const totalListings = (products || []).filter((p) => p.status !== "removed").length;
  const totalFollowers = Number(followerCounts?.[0]?.follower_count || 0);
  const commissionOwed = Number(owed || 0);
  const earliestCommissionDueAt = commissionDeadline?.[0]?.earliest_due_at || null;
  const commissionIsOverdue = !!earliestCommissionDueAt && new Date(earliestCommissionDueAt).getTime() <= Date.now();

  const monthlyPending = Number(window.__monthlyPendingCount || 0);

  // ---------- 1. Profile header ----------
  let html = `<div class="vendor-profile-header-card">
    <div class="storefront-cover vendor-profile-header-cover ${v.cover_url ? "has-custom-cover" : ""}" ${v.cover_url ? `style="background-image:url('${esc(v.cover_url)}');"` : ""}>
      ${v.cover_url ? "" : '<div class="storefront-cover-empty">No custom header image yet</div>'}
    </div>
    <div class="vendor-profile-header-body">
      <div class="vendor-profile-header-avatar-row">
        ${profile?.avatar_url ? `<img src="${esc(profile.avatar_url)}" class="avatar-circle vendor-profile-header-avatar" alt="${esc(profile.name || v.business_name || "Vendor")}" draggable="false" />` : avatarFallbackHtml(profile?.name || v.business_name || "Vendor", "4.4rem", "vendor-profile-header-avatar", profile?.name || v.business_name || "Vendor")}
        <span class="buyer-profile-row-actions"><button type="button" class="btn btn-sm btn-outline vendor-profile-edit-btn" onclick="navigate('vendorEditProfile')" title="Edit profile" aria-label="Edit profile"><i class="fa-solid fa-pen"></i></button><button type="button" class="buyer-profile-settings-btn" onclick="navigate('settings')" aria-label="Settings" title="Settings">${window.LV_SETTINGS_SVG}</button></span>
      </div>
      <h2 class="vendor-profile-header-name">${esc(v.business_name)} ${verifiedTick}</h2>
      ${profile?.name ? `<p class="vendor-profile-header-personal">${esc(profile.name)}</p>` : ""}
      ${v.city ? `<p class="vendor-profile-header-location"><i class="fa-solid fa-location-dot"></i> ${esc(v.city)}</p>` : ""}
      ${v.bio ? `<p class="vendor-profile-header-bio">${esc(v.bio)}</p>` : ""}
      <div class="storefront-stats">
        <span><strong>${totalListings}</strong> listing${totalListings === 1 ? "" : "s"}</span>
        <button type="button" class="storefront-stat-link" onclick="navigate('storefront',{vendorId:'${v.id}'});setTimeout(()=>scrollToVendorReviews(),300);"><strong>${v.review_count || 0}</strong> review${Number(v.review_count || 0) === 1 ? "" : "s"}</button>
        <button type="button" class="storefront-stat-link" onclick="navigate('storefront',{vendorId:'${v.id}'});setTimeout(()=>scrollToVendorReviews(),300);"><strong>★ ${Number(v.avg_rating ?? 0).toFixed(1)}</strong> rating</button>
        <button type="button" class="storefront-stat-link" onclick="navigate('vendorFollowers')"><strong>${totalFollowers.toLocaleString()}</strong> follower${totalFollowers === 1 ? "" : "s"}</button>
      </div>
      <div class="lv-profile-actions lv-vendor-profile-actions">
        <button type="button" class="lv-profile-action active" aria-current="page" onclick="navigate('vendorDashboard')"><i class="fa-solid fa-user-gear"></i> My account</button>
        <button type="button" class="lv-profile-action" onclick="navigate('storefront',{vendorId:'${v.id}'})"><i class="fa-solid fa-arrow-up-right-from-square"></i> Public profile</button>
      </div>
    </div>
  </div>`;

  // ---------- 2. Analytics ----------
  html += `<hr class="vendor-profile-divider" />
  <div class="vendor-profile-section">
    <h3 class="lv-group-title">Statistics</h3>
    <div class="lv-group lv-group-flush">
      ${lvLinkRow("fa-clipboard-list", "Total orders", `${totalOrders}`, "navigate('vendorOrders')")}
      ${lvLinkRow("fa-sack-dollar", "Revenue (completed)", naira(revenue), "navigate('vendorEarnings')")}
      ${lvLinkRow("fa-box", "Listings", `${totalListings}`, "navigate('vendorProducts')")}
      ${lvLinkRow("fa-user-group", "Followers", `${totalFollowers}`, "navigate('vendorFollowers')")}
      ${lvLinkRow("fa-eye", "Product views", `${totalViews}`, "")}
      ${lvLinkRow("fa-heart", "Wishlist saves", `${totalFavorites}`, "")}
    </div>
    <div id="vendorRevenueChartArea" style="margin-top:0.6rem;"></div>
    <button type="button" class="vendor-profile-see-more" onclick="navigate('vendorEarnings')">See full earnings <i class="fa-solid fa-chevron-right"></i></button>
  </div>`;

  const recentCompleted = (orders || []).filter((o) => o.status === "completed");
  setTimeout(() => {
    const area = byId("vendorRevenueChartArea");
    // A racy auth check can cause this whole render to run twice for one
    // navigation (see the protectedRouteViews retry below), and each run
    // schedules its own timeout that finds the same, only-ever-one node by
    // id -- appending without clearing first left two charts stacked in it.
    if (area) { area.innerHTML = ""; area.appendChild(buildRevenueChart(recentCompleted, "all", { field: "total_amount", label: "Revenue per day (last 14 days)" })); }
  }, 0);

  // ---------- 3. Commission (only when owed) ----------
  // Commission is taken from each payout by Levromart: a shop never pays it by hand, so no "you owe" card is shown.
  if (false && commissionOwed > 0) {
    html += commissionCardHtml(commissionOwed, commissionIsOverdue, commissionDeadline?.[0]?.earliest_due_at, commissionIsOverdue ? "Your 7-day payment window has elapsed and your storefront is paused until this balance is settled." : "Pay anytime before the deadline. Your storefront stays active until then, and we will remind you 5, 3, 2 and 1 days before.");
  }
  html += statusBanner;
  if (v.verification_status === "verified" && (v.lat == null || v.lng == null)) {
    html += `<div class="banner banner-warning" style="max-width:700px;margin:1rem auto 0;"><strong><i class="fa-solid fa-location-dot"></i> Add your shop location</strong><p style="margin:.35rem 0 .65rem;">Your storefront cannot appear on the vendor map until a shop location is saved.</p><button class="btn btn-sm" onclick="navigate('vendorEditProfile')"><i class="fa-solid fa-map-location-dot"></i> Set shop location</button></div>`;
  }

  // ---------- 4. Seller hub: listings overview, management tools, more options ----------
  const hubRow = (icon, title, sub, value, onclick) => `<button type="button" class="vh-row" onclick="${onclick}"><span class="vh-row-ico">${String(icon).charAt(0) === "<" ? icon : `<i class="fa-solid ${icon}" aria-hidden="true"></i>`}</span><span class="vh-row-copy"><strong>${title}</strong>${sub ? `<small>${sub}</small>` : ""}</span>${value ? `<span class="vh-row-val">${value}</span>` : ""}<i class="fa-solid fa-chevron-right vh-chev" aria-hidden="true"></i></button>`;
  const goTab = (tab) => `try{localStorage.setItem('levromart-vendor-listing-tab','${tab}')}catch(_){};navigate('vendorProducts')`;
  const hubStat = (icon, n, label, tab) => `<button type="button" class="vh-stat" onclick="${goTab(tab)}"><span class="vh-stat-ico"><i class="fa-solid ${icon}" aria-hidden="true"></i></span><span><b>${n}</b><small>${label}</small></span><i class="fa-solid fa-chevron-right vh-chev" aria-hidden="true"></i></button>`;
  html += `<hr class="vendor-profile-divider" />
  <div class="vh-hub">
    <span class="vl-eyebrow"><i class="fa-solid fa-store"></i> Seller dashboard</span>
    <h2 class="vh-title">My Listings</h2>
    <p class="vh-sub">Manage your products, services and packages in one place.</p>
    <button type="button" class="vl-add vl-add-wide" onclick="openAddProductModal()"><i class="fa-solid fa-plus"></i> Add New Listing</button>
    <div class="vh-stats">${hubStat("fa-box", hubProducts, "Products", "products")}${hubStat("fa-hand-holding-heart", hubServices, "Services", "services")}${hubStat("fa-box-open", hubPackages, "Packages", "packages")}</div>
    <div class="vh-section-head"><h3><i class="fa-solid fa-layer-group"></i> My listings</h3><button type="button" onclick="${goTab("all")}">Manage all <i class="fa-solid fa-chevron-right"></i></button></div>
    <div class="vh-tabs" role="tablist">
      <button type="button" role="tab" onclick="${goTab("products")}"><i class="fa-solid fa-box"></i> Products <em>${hubProducts}</em></button>
      <button type="button" role="tab" onclick="${goTab("services")}"><i class="fa-solid fa-hand-holding-heart"></i> Services <em>${hubServices}</em></button>
      <button type="button" role="tab" onclick="${goTab("packages")}"><i class="fa-solid fa-box-open"></i> Packages <em>${hubPackages}</em></button>
    </div>
    <div class="vl-discarded"><span class="vl-discarded-ico"><i class="fa-solid fa-trash-can"></i></span><div><strong>Discarded items${hubDiscarded ? ` (${hubDiscarded})` : ""}</strong><p>Products removed from your live catalogue stay here when order history prevents permanent deletion.</p></div><button type="button" onclick="navigate('vendorProducts').then(()=>setTimeout(()=>toggleVendorDiscarded(null,true),250))" aria-label="View discarded items">View <i class="fa-solid fa-chevron-right"></i></button></div>
    <h3 class="vh-group">Management tools</h3>
    <div class="vh-list">
      ${hubRow("fa-list-check", "Manage listings", "View, edit or delete your products, services and packages.", "", goTab("all"))}
      ${hubRow("fa-clock", "Working hours", "Set when your store is open.", v.opening_hours ? esc(v.opening_hours) : "Not set", "navigate('vendorEditProfile')")}
      ${hubRow("fa-star", "Reviews", "See what customers are saying about you.", `<span class="vh-star"><i class="fa-solid fa-star"></i> ${Number(v.avg_rating || 0).toFixed(1)} (${Number(v.review_count || 0)})</span>`, `navigate('storefront',{vendorId:'${v.id}'});setTimeout(()=>scrollToVendorReviews(),300)`)}
      ${hubRow("fa-calendar-days", "Monthly listing", "Track your listing activity and performance.", monthlyPending > 0 ? `${monthlyPending} pending` : "Up to date", "navigate('vendorProducts')")}
    </div>
    <h3 class="vh-group">More options</h3>
    <div class="vh-list">
      ${hubRow("fa-comments", "Requests", "View and respond to customer requests.", "", "navigate('vendorRequests')")}
      ${hubRow("fa-lightbulb", "Suggestions", "Tips to grow your business on Levromart.", unreadSuggestionCount > 0 ? `<span class="vh-badge">${unreadSuggestionCount > 9 ? "9+" : unreadSuggestionCount}</span>` : "", "navigate('vendorSuggestionsInbox')")}
      ${hubRow("fa-headset", "Support", "Get help or contact our support team.", "", "navigate('supportRequest')")}
    </div>
    <div class="vh-list vh-list-single">${hubRow(window.LV_SETTINGS_SVG, "Settings &amp; Privacy", "Manage your account, notifications and privacy.", "", "navigate('settings')")}</div>
  </div>`;

  return html;
}

async function toggleVendorActive(currentlyActive) {
  if (!vendor?.id) return;
  if (!currentlyActive) {
    const { data: deadline, error: deadlineError } = await sb.rpc("get_vendor_commission_deadline", { p_vendor_id: vendor.id });
    if (deadlineError) { showToast(deadlineError.message, "error"); return; }
    const dueAt = deadline?.[0]?.earliest_due_at;
    if (dueAt && vendor.commission_pause_reason !== 'admin_override' && new Date(dueAt).getTime() <= Date.now()) {
      const { data: owed, error: owedError } = await sb.rpc("get_vendor_commission_owed", { p_vendor_id: vendor.id });
      if (owedError) { showToast(owedError.message, "error"); return; }
      // Same ₦100 floor as the rest of the commission-pause logic -- Paystack
      // won't transfer under that anyway.
      if (Number(owed || 0) >= 100) {
        vendor.is_active = false; vendor.commission_paused = true; vendor.commission_pause_reason = "commission_overdue";
        showCommissionPaywall(Number(owed || 0));
        return;
      }
    }
  }
  const { error } = await sb.rpc("vendor_set_storefront_active", { p_active: !currentlyActive });
  if (error) { showToast(error.message, "error"); return; }
  vendor.is_active = !currentlyActive;
  if (!currentlyActive) { vendor.commission_paused = false; vendor.commission_pause_reason = null; }
  navigate("vendorDashboard");
}

