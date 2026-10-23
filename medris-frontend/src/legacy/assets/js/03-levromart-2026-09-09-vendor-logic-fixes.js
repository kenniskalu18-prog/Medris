/* ---- levromart-2026-09-09-vendor-logic-fixes ---- */
(function () {
  "use strict";

  /* ---------------------------------------------------------------
     CUSTOMER REQUEST ICON
     --------------------------------------------------------------- */
  function refreshCustomerRequestIcons() {
    const links = document.querySelectorAll("#profilePanel .profile-nav-link");
    links.forEach((link) => {
      const label = link.querySelector(".profile-nav-text")?.textContent?.trim().toLowerCase() || "";
      if (label === "customer requests" || label === "requests") {
        link.dataset.profileLabel = "Requests";
        const icon = link.querySelector(".profile-item-icon i");
        if (icon) icon.className = "fa-solid fa-hand";
      }
    });
  }
  window.refreshCustomerRequestIcons = refreshCustomerRequestIcons;
  setTimeout(refreshCustomerRequestIcons, 0);
  setTimeout(refreshCustomerRequestIcons, 250);

  /* ---------------------------------------------------------------
     VENDORS DIRECTORY
     All filtered vendors are shown freely. Sort can be alphabetical or closest.
     Grid/list/map are separate presentation modes.
     --------------------------------------------------------------- */
  let vendorDirectoryExpanded = false;
  let vendorDirectorySort = "shuffled";   // mixed order by default; A-Z / closest are one tap away
  let vendorDirectoryMode = "map";

  // A vendor's place in the mixed order depends on its id and the current 10-minute slot,
  // so the order is stable while you browse and reshuffles on its own every few minutes.
  function vendorShuffleRank(id) {
    const seed = `${id}:${Math.floor(Date.now() / 600000)}`;
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= h >>> 13; h = Math.imul(h, 1274126177); h ^= h >>> 16;
    return h >>> 0;
  }
  function vendorDirectorySortList(list) {
    const out = [...(list || [])];
    if (vendorDirectorySort === "shuffled") return out.sort((a, b) => vendorShuffleRank(a.id) - vendorShuffleRank(b.id));
    if (vendorDirectorySort === "closest" && typeof buyerLocation !== "undefined" && buyerLocation) {
      return out.sort((a, b) => {
        const da = a.lat != null && a.lng != null
          ? haversineKm(buyerLocation.lat, buyerLocation.lng, a.lat, a.lng)
          : Infinity;
        const db = b.lat != null && b.lng != null
          ? haversineKm(buyerLocation.lat, buyerLocation.lng, b.lat, b.lng)
          : Infinity;
        return da - db || String(a.business_name || "").localeCompare(String(b.business_name || ""));
      });
    }
    return out.sort((a, b) => String(a.business_name || "").localeCompare(String(b.business_name || ""), undefined, { sensitivity: "base" }));
  }

  function renderVendorDirectoryCards() {
    const grid = byId("vendorsGrid");
    if (!grid) return;
    const all = vendorDirectorySortList(window.__filteredVendors || []);

    // Map view is intentionally map-first: the only vendor cards shown there
    // are the horizontal, scrollable rail above the map. Never leave the full
    // static grid mounted underneath/above the map, even if a previous render
    // happened in list/grid mode.
    if (vendorDirectoryMode === "map") {
      grid.classList.add("hidden");
      grid.innerHTML = "";
    } else {
      const __vdKey = (window.__filteredVendors || []).length + "|" + vendorDirectoryMode;
      if (window.__vdKey !== __vdKey) { window.__vdKey = __vdKey; window.__vdShown = 12; }
      const visible = all.slice(0, window.__vdShown || 12);
      grid.classList.remove("hidden");
      grid.classList.toggle("vendors-list-mode", vendorDirectoryMode === "list");
      // window.__allVendors is only set once the initial fetch resolves. A
      // grid/list toggle tapped before that finishes used to see the same
      // empty array a real zero-result filter would, and wrongly claimed "no
      // vendors match" while the directory was simply still loading.
      grid.innerHTML = visible.length
        ? visible.map(vendorDirectoryMode === "list" ? vendorDirectoryCardHtml : vendorPageCardHtml).join("")
        : Array.isArray(window.__allVendors)
          ? vendorDirectoryEmptyHtml(true)
          : vendorDirectorySkeletonHtml();
      byId("vdSentinel")?.remove();
      if (all.length > visible.length) {
        const sentinel = document.createElement("div");
        sentinel.id = "vdSentinel"; sentinel.style.minHeight = "1px";
        grid.insertAdjacentElement("afterend", sentinel);
        const io = new IntersectionObserver((es) => {
          if (!es[0].isIntersecting) return;
          io.disconnect(); sentinel.remove();
          window.__vdShown = (window.__vdShown || 12) + 12;
          renderVendorDirectoryCards();
        }, { rootMargin: "700px" });
        io.observe(sentinel);
      }
    }

    const more = byId("vendorsDirectoryMoreBtn");
    if (more) {
      const hasMore = all.length > 6;
      more.classList.add("hidden");
      more.innerHTML = vendorDirectoryExpanded
        ? '<i class="fa-solid fa-chevron-up"></i> Show fewer vendors'
        : '<i class="fa-solid fa-chevron-down"></i> View more vendors (' + (all.length - Math.min(all.length, 6)) + ' more)';
    }

    const count = byId("vendorsDirectoryCount");
    if (count) count.textContent = "";

    byId("vendorsViewGridBtn")?.classList.toggle("active", vendorDirectoryMode === "grid");
    byId("vendorsViewListBtn")?.classList.toggle("active", vendorDirectoryMode === "list");
    byId("vendorsViewMapBtn")?.classList.toggle("active", vendorDirectoryMode === "map");
    if (typeof renderVendorCatChips === "function") renderVendorCatChips();

    if (vendorDirectoryMode === "map" && typeof renderVendorsMap === "function") {
      byId("vendorsMapWrap")?.classList.remove("hidden");
      setTimeout(() => renderVendorsMap(), 0);
    } else {
      byId("vendorsMapWrap")?.classList.add("hidden");
    }
  }

  window.switchVendorsView = function (mode) {
    vendorDirectoryMode = ["grid", "list", "map"].includes(mode) ? mode : "map";
    try { localStorage.setItem("levromart_vendors_view", vendorDirectoryMode); } catch (_) {}
    renderVendorDirectoryCards();
    if (vendorDirectoryMode === "map") {
      byId("vendorsMapWrap")?.classList.remove("hidden");
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (typeof renderVendorsMap === "function") renderVendorsMap();
        if (vendorsMap) vendorsMap.invalidateSize(true);
      }));
    }
  };

  window.toggleVendorsMore = function () {
    // “View more vendors” is an explicit directory expansion action.
    // Always land in the two-column grid so the additional vendors are
    // presented side-by-side, rather than inheriting the list/map mode.
    vendorDirectoryExpanded = true;
    vendorDirectoryMode = "grid";
    try { localStorage.setItem("levromart_vendors_view", "grid"); } catch (_) {}
    renderVendorDirectoryCards();
    requestAnimationFrame(() => {
      const grid = byId("vendorsGrid");
      if (grid) grid.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  window.setVendorDirectorySort = function (mode) {
    vendorDirectorySort = ["closest", "alphabetical", "shuffled"].includes(mode) ? mode : "shuffled";
    vendorDirectoryExpanded = true;
    renderVendorDirectoryCards();
  };

  window.renderVendorsDirectory = function () {
    vendorDirectoryExpanded = true;
    // Remember the view the person last picked (grid / list / map) across
    // refreshes and revisits instead of snapping back to the map.
    try {
      const savedView = localStorage.getItem("levromart_vendors_view");
      vendorDirectoryMode = ["grid", "list", "map"].includes(savedView) ? savedView : "map";
    } catch (_) { vendorDirectoryMode = "map"; }
    vendorDirectorySort = "shuffled";
    // The "Rent Items" quick action sets this to 'rent' before navigating
    // here -- but nothing ever reset it back, so it silently stayed 'rent'
    // (or 'buy'/'both') on every later visit to this tab, even a plain tap
    // from the bottom nav. The tab bar below always paints "All vendors" as
    // active regardless, so it looked like no filter was picked while one
    // quietly still was -- exactly what a page refresh (which resets this
    // variable along with everything else) happened to fix.
    vendorsListingFilter = "all";
    let html = `<div class="vd-page">${typeof lvPageHero === "function" ? lvPageHero("vendors") : ""}<div class="vd-head">
      <div class="vd-views" role="group" aria-label="View mode">
        <button type="button" class="vd-view" id="vendorsViewGridBtn" onclick="switchVendorsView('grid')" title="Grid view" aria-label="Grid view">Grid</button>
        <button type="button" class="vd-view" id="vendorsViewListBtn" onclick="switchVendorsView('list')" title="List view" aria-label="List view">List</button>
        <button type="button" class="vd-view" id="vendorsViewMapBtn" onclick="switchVendorsView('map')" title="Map view" aria-label="Map view">Map</button>
      </div>
    </div>
    <div class="vd-seg" id="vendorsListingTabs" role="tablist" aria-label="Vendor type">
      <button type="button" class="vd-tab active" role="tab" data-filter="all" title="All vendors" aria-label="All vendors" onclick="setVendorsListingFilter('all')">All vendors</button>
      <button type="button" class="vd-tab" role="tab" data-filter="buy" title="Buy" aria-label="Buy" onclick="setVendorsListingFilter('buy')">Buy</button>
      <button type="button" class="vd-tab" role="tab" data-filter="rent" title="Rent" aria-label="Rent" onclick="setVendorsListingFilter('rent')">Rent</button>
      <button type="button" class="vd-tab" role="tab" data-filter="both" title="Buy and rent" aria-label="Buy and rent" onclick="setVendorsListingFilter('both')">Both</button>
    </div>
    <div class="vd-tools">
      <label class="vd-search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input type="search" id="vendorSearchInput" placeholder="Search vendors…" oninput="filterVendorsDirectory()" autocomplete="off" enterkeyhint="search" aria-label="Search vendors or products" /></label>
      <button type="button" class="vd-filter-btn" id="vendorsFiltersToggle" aria-label="Filter" title="Filter" aria-expanded="false" onclick="toggleVendorsFilters()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg><span class="vd-filter-label">Filters</span></button>
    </div>
    <div class="vendors-filters-panel vd-panel hidden" id="vendorsFiltersPanel">
      <div class="lm-sheet-head"><strong>Filter vendors</strong><button type="button" class="lm-x" onclick="toggleVendorsFilters(false)" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>
      <div class="vendors-filter-grid">
        <label>Sector<select id="vendorSectorFilter" onchange="filterVendorsDirectory()"><option value="">All sectors</option></select></label>
        <label>City<select id="vendorCityFilter" onchange="filterVendorsDirectory()"><option value="">All cities</option></select></label>
        <label>Category<select id="vendorCategoryFilter" onchange="filterVendorsDirectory()"><option value="">Known for: anything</option></select></label>
        <label>Arrange<select id="vendorSortFilter" onchange="setVendorDirectorySort(this.value)">
          <option value="shuffled">Mixed (changes every few minutes)</option>
          <option value="alphabetical">A–Z</option>
          <option value="closest">Closest first</option>
        </select></label>
      </div>
    </div>
    <div class="vd-chips" id="vendorCatChips" role="group" aria-label="Vendor categories"></div>
    <div class="vd-grid" id="vendorsGrid">${vendorDirectorySkeletonHtml()}</div>

    <div id="vendorsMapWrap" class="hidden">
      <p class="muted" id="vendorsMapStatus" style="font-size:.82rem;margin:0 0 1rem;line-height:1.45;"></p>
      <div id="vendorsMap" style="height:min(60vh,420px);border-radius:.9rem;overflow:hidden;background:var(--border);position:relative;isolation:isolate;z-index:0;"></div>
    </div></div>`;
    setTimeout(async () => {
      try {
        await loadVendorsDirectory();
        if (buyerDistanceAutoEnabled) scheduleAutomaticLocationRefresh();
        else updateVendorsLocationUI();
      } catch (err) {
        console.warn("[Levromart] Vendor directory refresh failed:", err);
        const grid = byId("vendorsGrid");
        if (grid) {
          const cached = Array.isArray(window.__filteredVendors) ? window.__filteredVendors : [];
          grid.innerHTML = cached.length
            ? cached.map(vendorPageCardHtml).join("")
            : vendorDirectorySkeletonHtml();
        }
        updateVendorsLocationUI();
        setTimeout(() => {
          if (currentView === "vendors") loadVendorsDirectory().catch(e => console.warn("[Levromart] Vendor directory retry failed:", e));
        }, 1800);
      }
    }, 0);
    return html;
  };

  window.filterVendorsDirectory = function () {
    const search = (byId("vendorSearchInput")?.value || "").trim().toLowerCase();
    const sectorId = byId("vendorSectorFilter")?.value || "";
    const city = byId("vendorCityFilter")?.value || "";
    const category = byId("vendorCategoryFilter")?.value || "";
    let list = window.__allVendors || [];
    if (vendorsListingFilter === "buy") list = list.filter((v) => v.canBuy);
    if (vendorsListingFilter === "rent") list = list.filter((v) => v.canRent);
    if (vendorsListingFilter === "both") list = list.filter((v) => v.canBuy && v.canRent);
    if (search) list = list.filter((v) => (v.searchText || "").includes(search));
    if (sectorId) list = list.filter((v) => String(v.sector_id) === String(sectorId));
    if (city) list = list.filter((v) => v.city === city);
    if (category) list = list.filter((v) => (v.categories || []).includes(category));
    window.__filteredVendors = vendorDirectorySortList(list);
    document.querySelectorAll("#vendorsListingTabs [data-filter]").forEach((btn) => btn.classList.toggle("active", btn.dataset.filter === vendorsListingFilter));
    renderVendorDirectoryCards();
    if (vendorDirectoryMode === "map" && typeof renderVendorsMap === "function") renderVendorsMap();
  };

  /* Keep the existing loader's select population, but re-render our compact
     cards once it has finished. */
  const originalLoadVendorsDirectory = window.loadVendorsDirectory;
  if (typeof originalLoadVendorsDirectory === "function") {
    window.loadVendorsDirectory = async function () {
      const result = await originalLoadVendorsDirectory.apply(this, arguments);
      const sort = byId("vendorSortFilter");
      if (sort) sort.value = vendorDirectorySort;
      renderVendorDirectoryCards();
      return result;
    };
  }

  /* ---------------------------------------------------------------
     COMPACT VENDOR CARD
     --------------------------------------------------------------- */
  window.vendorCardHtml = function (v) {
    const logo = v.logo_url
      ? `<img src="${esc(v.logo_url)}" alt="" class="avatar-circle vendor-directory-logo" />`
      : avatarFallbackHtml(v.business_name || "Vendor", "3.1rem", "vendor-directory-logo", v.business_name || "Vendor");
    const distance = (typeof buyerLocation !== "undefined" && buyerLocation && v.lat != null && v.lng != null)
      ? `<span class="badge"><i class="fa-solid fa-location-dot"></i> ${formatDistanceKm(haversineKm(buyerLocation.lat, buyerLocation.lng, v.lat, v.lng))}</span>`
      : "";
    return `<div class="vendor-card" onclick="navigate('storefront',{vendorId:'${esc(v.id)}'})" role="button" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();navigate('storefront',{vendorId:'${esc(v.id)}'});}">
      ${logo}
      <div class="vendor-directory-card-main">
        <strong class="vendor-directory-name">${esc(v.business_name || "Vendor")}</strong>
        <p class="muted vendor-directory-city"><i class="fa-solid fa-location-dot"></i> ${esc(v.city || "Online")}</p>
        ${v.categories?.length ? `<p class="muted vendor-directory-categories"><i class="fa-solid fa-tags"></i> ${v.categories.slice(0,3).map(esc).join(", ")}</p>` : ""}
        <div class="vendor-card-footer">
          <span class="badge success"><i class="fa-solid fa-circle-check"></i> Verified</span>
          ${`<span class="badge ${ratingBadgeClass(Number(v.avg_rating ?? 0))}"><i class="fa-solid fa-star"></i> ${Number(v.avg_rating ?? 0).toFixed(1)} (${Number(v.review_count ?? 0)})</span>`}
          ${distance}
        </div>
      </div>
    </div>`;
  };

  /* ---------------------------------------------------------------
     STOREFRONT HEADER TEXT, blank when no custom cover exists.
     --------------------------------------------------------------- */
  const originalRenderStorefront = window.renderStorefront;
  if (typeof originalRenderStorefront === "function") {
    window.renderStorefront = async function () {
      const html = await originalRenderStorefront.apply(this, arguments);
      return String(html || "").replace(
        /<div class="storefront-cover-empty">\s*Set a custom storefront header in your business profile\.\s*<\/div>/gi,
        '<div class="storefront-cover-empty" aria-hidden="true"></div>'
      );
    };
  }

  function renderVendorApplyBankPicker(){const select=byId("vaBankCode"),label=byId("vaBankPickerLabel");if(!select||!label)return;label.textContent=select.options[select.selectedIndex]?.textContent?.trim()||"Select a bank";}
  function closeVendorApplyBankPicker(){byId("vendorApplyBankPickerModal")?.remove();byId("vaBankPickerBtn")?.setAttribute("aria-expanded","false");}
  function selectVendorApplyBank(code){const select=byId("vaBankCode"),option=select&&Array.from(select.options).find(o=>String(o.value)===String(code));if(!option)return;select.value=String(code);renderVendorApplyBankPicker();closeVendorApplyBankPicker();}
  function openVendorApplyBankPicker(){const select=byId("vaBankCode");if(!select)return;closeVendorApplyBankPicker();const banks=Array.from(select.options).map(o=>({code:o.value,name:o.textContent.trim()})).filter(b=>b.code&&b.name).sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:"base"}));const modal=document.createElement("div");modal.id="vendorApplyBankPickerModal";modal.className="modal vendor-bank-picker-modal";modal.onclick=e=>{if(e.target===modal)closeVendorApplyBankPicker()};modal.innerHTML=`<div class="vendor-bank-picker-content" role="dialog" aria-modal="true" aria-labelledby="vaBankPickerTitle"><div class="vendor-bank-picker-header"><div><h3 id="vaBankPickerTitle"><i class="fa-solid fa-building-columns"></i> Select payout bank</h3><p>${banks.length} supported banks and financial institutions</p></div><button type="button" class="vendor-bank-picker-close" onclick="closeVendorApplyBankPicker()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div><div class="vendor-bank-search-wrap"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input id="vaBankSearch" class="vendor-bank-search" type="search" placeholder="Search bank…" autocomplete="off" /></div><div id="vaBankPickerList" class="vendor-bank-picker-list"></div></div>`;document.body.appendChild(modal);const render=q=>{const query=String(q||"").trim().toLowerCase(),current=String(select.value||""),filtered=query?banks.filter(b=>b.name.toLowerCase().includes(query)||b.code.toLowerCase().includes(query)):banks;byId("vaBankPickerList").innerHTML=filtered.length?filtered.map(b=>"<button type=\"button\" class=\"vendor-bank-option "+(String(b.code)===current?"selected":"")+"\" onclick=\"selectVendorApplyBank('"+esc(b.code)+"')\"><span class=\"vendor-bank-option-icon\"><i class=\"fa-solid fa-building-columns\"></i></span><span class=\"vendor-bank-option-main\"><strong>"+esc(b.name)+"</strong><small>"+esc(b.code)+"</small></span><i class=\"fa-solid "+(String(b.code)===current?"fa-circle-check":"fa-chevron-right")+"\"></i></button>").join(""):"<div class=\"vendor-bank-picker-empty\">No banks match your search.</div>"};byId("vaBankSearch")?.addEventListener("input",e=>render(e.target.value));render("");byId("vaBankPickerBtn")?.setAttribute("aria-expanded","true");setTimeout(()=>byId("vaBankSearch")?.focus(),0);}

  /* ---------------------------------------------------------------
     VENDOR APPLICATION, explicit type=button + delegated click fallback,
     plus a busy guard so slow browsers cannot double-submit.
     --------------------------------------------------------------- */
  let vendorApplyBusy = false;
  window.renderVendorApply = async function () {
    if (!session) return '<div class="empty-state">Please log in to apply as a vendor.</div>';
    if (profile?.role === "admin") return '<div class="empty-state">Admin accounts can\'t own a vendor store on Levromart.</div>';
    const { data: existing } = await sb.from("vendors").select("id").eq("user_id", session.user.id).is("deleted_at", null).maybeSingle();
    if (existing) { navigate("vendorDashboard"); return '<p class="muted">Redirecting…</p>'; }
    if (!sectors.length) { const { data } = await levroData.catalogue.sectors("sort_order"); sectors = data || []; }
    return `<div class="card" style="max-width:480px;margin:0 auto;">
      <h2>Apply as a vendor</h2>
      <p class="muted">Tell us about your business. An admin will review this manually.</p>
      <div id="vendorApplyError" class="error-text hidden"></div>
      <label>Which sector is your business in? *</label>
      <select id="vaSector">${sectors.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("")}</select>
      <label>Business name *</label><input id="vaBusinessName" autocomplete="organization" />
      <label>Address (leave blank if you're an online-only business)</label><input id="vaAddress" autocomplete="street-address" />
      <label>City</label><input id="vaCity" value="Lagos" autocomplete="address-level2" />
      <label>Phone *</label><input id="vaPhone" type="tel" autocomplete="tel" />
      <label>WhatsApp number</label><input id="vaWhatsapp" type="tel" autocomplete="tel" />
      <div class="vendor-application-payout-section">
        <div class="vendor-application-payout-heading"><strong>Payout account</strong><span>These bank details will automatically become your Levromart payout account when you submit your application.</span></div>
        <label>Bank</label>
        <button type="button" id="vaBankPickerBtn" class="bank-picker-trigger" onclick="openVendorApplyBankPicker()" aria-haspopup="dialog" aria-expanded="false"><span id="vaBankPickerLabel">Select a bank</span><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></button>
        <select id="vaBankCode" class="hidden" aria-hidden="true" tabindex="-1"><option value="">Select a bank</option>${NIGERIAN_BANKS.map((b) => `<option value="${esc(b.code)}">${esc(b.name)}</option>`).join("")}</select>
        <label>Account name</label><input id="vaAccountName" autocomplete="name" placeholder="Name on the bank account" />
        <label>Account number</label><input id="vaAccountNumber" inputmode="numeric" maxlength="10" autocomplete="off" placeholder="10-digit account number" />
      </div>
      <label>CAC number</label><input id="vaCac" autocomplete="off" />
      <label>CAC document (optional upload)</label><input id="vaDoc" type="file" accept="application/pdf,image/*" />
      <label>About your business</label><textarea id="vaBio" rows="3" placeholder="If you're online-only, mention that here: how buyers reach you, delivery area, etc."></textarea>
      <button type="button" class="btn" id="vendorApplySubmitBtn" style="margin-top:.8rem;" onclick="submitVendorApply()"><i class="fa-solid fa-paper-plane"></i> Submit application</button>
    </div>`;
  };

  window.submitVendorApply = async function () {
    if (vendorApplyBusy) return;
    const errorEl = byId("vendorApplyError");
    const button = byId("vendorApplySubmitBtn");
    if (!errorEl || !button) return;
    errorEl.classList.add("hidden");
    errorEl.textContent = "";
    const business_name = String(byId("vaBusinessName")?.value || "").trim();
    const address = String(byId("vaAddress")?.value || "").trim();
    const phone = String(byId("vaPhone")?.value || "").trim();
    if (!business_name || !phone) {
      errorEl.textContent = "Business name and phone are required.";
      errorEl.classList.remove("hidden");
      return;
    }
    vendorApplyBusy = true;
    button.classList.add("is-busy");
    button.disabled = true;
    try {
      let verification_docs = [];
      const file = byId("vaDoc")?.files?.[0];
      if (file) {
        const ext = (file.name.split(".").pop() || "bin").replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
        const path = `${session.user.id}/${Date.now()}.${ext}`;
        const { error: upErr } = await sb.storage.from("vendor-docs").upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
        if (upErr) throw new Error(`Document upload failed: ${upErr.message}`);
        verification_docs = [path];
      }
      const bankCode = String(byId("vaBankCode")?.value || "").trim();
      const bankName = String(byId("vaBankPickerLabel")?.textContent || "").trim();
      const accountName = String(byId("vaAccountName")?.value || "").trim();
      const accountNumber = String(byId("vaAccountNumber")?.value || "").trim();
      if (bankCode || accountName || accountNumber) {
        if (!bankCode || !accountName || !/^\d{10}$/.test(accountNumber)) throw new Error("Please enter a bank, account name, and valid 10-digit account number, or leave the payout details blank.");
      }
      const { data: createdVendor, error } = await sb.from("vendors").insert({
        user_id: session.user.id,
        sector_id: byId("vaSector")?.value || null,
        business_name,
        address: address || null,
        city: String(byId("vaCity")?.value || "").trim() || null,
        phone,
        whatsapp_number: String(byId("vaWhatsapp")?.value || "").trim() || null,
        cac_number: String(byId("vaCac")?.value || "").trim() || null,
        bio: String(byId("vaBio")?.value || "").trim() || null,
        verification_docs,
        bank_code: bankCode || null,
        bank_name: bankCode ? bankName : null,
        account_name: accountName || null,
        account_number: accountNumber || null,
      }).select("id").single();
      if (error) throw new Error(error.message);
      if (bankCode && accountNumber) {
        const payoutRes = await fetch("/api/vendor-payments", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ action:"create-subaccount", accessToken:session.access_token, bankCode, accountNumber }) });
        const payoutJson = await payoutRes.json();
        if (!payoutRes.ok) throw new Error(payoutJson.error || "Your application was saved, but the payout account could not be verified. Please try again from your payout details.");
        const { error: payoutSaveError } = await sb.from("vendors").update({ bank_code:bankCode, bank_name:bankName, account_name:accountName || payoutJson.account_name || null, account_number:accountNumber, paystack_subaccount_code:payoutJson.subaccount_code || payoutJson.subaccount?.subaccount_code || null }).eq("id", createdVendor?.id).eq("user_id", session.user.id);
        if (payoutSaveError) throw new Error("Application submitted, but your payout account could not be finalized. Please check Payout details before accepting orders.");
      }
      showToast("Vendor application submitted successfully.", "success");
      await refreshAuthState();
      navigate("vendorDashboard");
    } catch (err) {
      console.error("[Levromart] Vendor application failed:", err);
      errorEl.textContent = /network|fetch|failed to fetch|timeout/i.test(String(err?.message || ""))
        ? "We couldn't reach Levromart. Check your connection and try again."
        : (err?.message || "We couldn't submit your application. Please try again.");
      errorEl.classList.remove("hidden");
    } finally {
      vendorApplyBusy = false;
      button.classList.remove("is-busy");
      button.disabled = false;
    }
  };

  /* Some mobile browsers are more reliable with one delegated listener than
     an inline handler after a dynamic page replacement. Keep the inline
     handler too; this is only a safety net and ignores duplicate clicks. */
  document.addEventListener("click", function (e) {
    const btn = e.target?.closest?.("#vendorApplySubmitBtn");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    window.submitVendorApply();
  }, true);

  /* ---------------------------------------------------------------
     LEVI, don't show the useless generic fallback for ordinary questions.
     The normal /api/chat answer remains the primary path. If it returns the
     old generic sentence, try one more request with a hard instruction that
     it MUST answer the actual question. If the second request still fails,
     use the deterministic app answer instead of the generic boilerplate.
     --------------------------------------------------------------- */
  const GENERIC_LEVI_PATTERNS = [
    /^i'?m levi\. i can help with levromart products, vendors, orders, your cart, wishlist/i,
    /^hi[, ]+[^.]*[.!] i'?m levi\. i can still help with basic levromart navigation/i,
    /^i'?m levi\. i can still help with basic levromart navigation/i,
    // Vague "there's a bunch of stuff, go look" phrasings that answer a
    // product/vendor question without ever naming an actual product or
    // vendor -- these used to slip through untouched because they don't
    // start with a canned opener, they just never get specific.
    /\b(?:feel free to|you can) browse (?:our|the)?\s*(?:marketplace|selection|categories|products)?\b/i,
    /\bwe have a (?:wide|great|large)? ?(?:range|variety|selection) of\b/i,
    /\bcheck out (?:our|the) (?:marketplace|categories|sectors|selection)\b/i,
    /\bexplore (?:our|the) (?:marketplace|categories|sectors)\b/i,
    /\bvarious options (?:are )?available\b/i,
    /\blots of (?:great )?options? (?:to choose from|available)\b/i,
    // The pipeline's own last-resort openers ("I'm on it. Tell me what you
    // want to open, find, or do...") were never in this list, so once
    // everything upstream (the API, the forced-specificity retry, the
    // hardcoded intent matcher) gave up, THIS exact sentence reached the
    // user un-flagged -- silently skipping the live marketplace search
    // fallback below that would otherwise have tried an actual product/
    // vendor lookup for a question like "which vendor sells phones?".
    /^i.?m on it\b.*\btell me what you want\b/i,
  ];
  function isGenericLeviReply(reply) {
    const text = String(reply || "").trim();
    if (!text) return true;
    if (GENERIC_LEVI_PATTERNS.some((re) => re.test(text))) return true;
    return /^(?:i couldn't get a useful answer|i can help with|try asking me|ask me what to buy|i'm levi)/i.test(text);
  }
  function leviSpecificFallback(text) {
    const q = leviNormaliseText(text);
    if (/\bwhat('?s| is) in my cart\b|\bshow my cart\b/.test(q)) {
      navigate("cart");
      return "I opened your cart so you can see what's currently in it.";
    }
    if (/\b(my )?orders?\b/.test(q) && /show|open|where|check|status/.test(q)) {
      navigate(vendor ? "vendorOrders" : "buyerOrders", vendor ? { status:"all", type:"all", payment:"all", dateFrom:"", dateTo:"", perspective:"sales" } : {});
      return "I opened your orders.";
    }
    if (/\bvendors?\b/.test(q) && /show|find|where|list|closest|near/.test(q)) {
      navigate("vendors");
      return "I opened the vendor directory. You can search, filter, sort A–Z, or use Closest first.";
    }
    if (/\bsettings?\b/.test(q) && /open|show|take me|go/.test(q)) {
      navigate("settings");
      return "I opened Settings.";
    }
    if (/\b(cart|basket)\b/.test(q) && /clear|empty|remove.*all|delete.*all|wipe/.test(q)) {
      if (typeof clearEntireCart === "function") {
        clearEntireCart();
        return "I've started clearing your cart.";
      }
    }
    return null;
  }

  const originalFetchLeviReply = window.fetchLeviReply;
  if (typeof originalFetchLeviReply === "function") {
    window.fetchLeviReply = async function (payload) {
      const first = await originalFetchLeviReply.apply(this, arguments);
      if (!isGenericLeviReply(first?.reply)) return first;

      const userMessages = Array.isArray(payload?.messages) ? payload.messages : [];
      const latestUser = [...userMessages].reverse().find((m) => m?.role === "user")?.content || "";
      const forced = {
        ...payload,
        messages: [
          {
            role: "system",
            content: "You are Levi, Levromart's smart in-app assistant. Answer the user's latest question directly and specifically. NEVER reply with an introduction such as 'I'm Levi, I can help...' when the user has asked a real question. Use the marketplace context supplied in the conversation. If the user asks for an action, explain what you can do and do it through the app's available controls when possible. Do not repeat generic capability lists."
          },
          ...userMessages,
          ...(latestUser ? [{ role: "user", content: `Answer this specific request directly. Do not introduce yourself or give a generic capability list: ${latestUser}` }] : [])
        ]
      };
      try {
        const second = await originalFetchLeviReply.call(this, forced);
        if (second?.reply && !isGenericLeviReply(second.reply)) return second;
      } catch (e) {
        console.warn("Levi second-pass answer failed:", e);
      }
      const deterministic = leviSpecificFallback(latestUser);
      if (deterministic) return { ...first, reply: deterministic };
      return { ...first, reply: "I’m on it. Tell me what you want to find, open, or do, and I’ll handle the next step for you." };
    };
  }

  /* ---------------------------------------------------------------
     APPEND A SMALL STATUS-BAR ICON FIX FOR WEB PUSH.
     The service worker uses /levromart-badge.svg as its monochrome Android
     notification badge instead of a full-colour PNG that can render as a
     white square in the status bar.
     --------------------------------------------------------------- */
  window.LEVROMART_PUSH_BADGE = "/levromart-badge.png";
})();
