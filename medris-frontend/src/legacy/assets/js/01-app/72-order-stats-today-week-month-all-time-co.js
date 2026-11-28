// ---------- ORDER STATS (today/week/month/all-time counts by status) ----------
const ORDER_STATS_PERIODS = { today: "Today", week: "This week", month: "This month", all: "All time" };
const ORDER_STATS_STATUS_LABELS = { pending: "Pending", confirmed: "Confirmed", handed_over: "Handed over", returned: "Returned", completed: "Completed", cancelled: "Cancelled", disputed: "Disputed" };
let vendorOrderStatsPeriod = "today";
function computeOrderStatusCounts(orders, period) {
  const inPeriod = period === "all" ? orders : (orders || []).filter((o) => vendorEarningsInPeriod(o.created_at, period));
  const counts = { pending: 0, confirmed: 0, handed_over: 0, returned: 0, completed: 0, cancelled: 0, disputed: 0 };
  inPeriod.forEach((o) => { if (counts[o.status] != null) counts[o.status]++; });
  return { total: inPeriod.length, counts };
}
function orderStatsHtml(orders) {
  return `<div class="accordion-section" id="orderStatsAccordion" style="margin-bottom:1rem;">
    <button class="accordion-trigger" onclick="toggleAccordion(this)"><span><i class="fa-solid fa-chart-simple"></i> Order stats</span><i class="fa-solid fa-chevron-down accordion-chevron"></i></button>
    <div class="accordion-body">
      <div class="order-stats-tabs-wrap"><div class="segmented-tabs" id="orderStatsTabs">
        ${Object.entries(ORDER_STATS_PERIODS).map(([p, label]) => `<button class="${p === vendorOrderStatsPeriod ? "active" : ""}" data-stats-period="${p}" onclick="switchOrderStatsPeriod('${p}')">${label}</button>`).join("")}
      </div>
      </div>
      <table class="order-stats-table" id="orderStatsBody"></table>
    </div>
  </div>`;
}
function renderOrderStatsBody() {
  const el = byId("orderStatsBody");
  if (!el) return;
  const { total, counts } = computeOrderStatusCounts(window.__orderStatsOrders || [], vendorOrderStatsPeriod);
  const rows = [["Total orders", total, true], ...Object.entries(ORDER_STATS_STATUS_LABELS).map(([k, label]) => [label, counts[k], false])];
  el.innerHTML = rows.map(([label, n, strong]) => `<tr><td>${label}</td><td style="${strong ? "font-weight:800;" : ""}">${n}</td></tr>`).join("");
}
function switchOrderStatsPeriod(period) {
  vendorOrderStatsPeriod = period;
  document.querySelectorAll("#orderStatsTabs [data-stats-period]").forEach((btn) => btn.classList.toggle("active", btn.dataset.statsPeriod === period));
  renderOrderStatsBody();
}

function localDateKey(d = new Date()) {
  const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function orderDatePresetValue(dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return 'all';
  const today=localDateKey();
  if(dateFrom===today&&dateTo===today)return 'today';
  const a=dateFrom?new Date(`${dateFrom}T00:00:00`):null,b=dateTo?new Date(`${dateTo}T23:59:59`):null;
  const diff=a&&b?Math.round((b-a)/86400000)+1:null;
  if(dateTo===today&&diff===7)return '7';
  if(dateTo===today&&diff===30)return '30';
  if(dateTo===today&&diff>=89&&diff<=93)return '90';
  return 'custom';
}
function orderDateRangeParams(preset){
  if(!preset||preset==='all')return {dateFrom:'',dateTo:''};
  const now=new Date(),end=localDateKey(now);
  if(preset==='today')return {dateFrom:end,dateTo:end};
  if(['7','30','90'].includes(preset)){const d=new Date(now.getFullYear(),now.getMonth(),now.getDate());d.setDate(d.getDate()-Number(preset)+1);return {dateFrom:localDateKey(d),dateTo:end};}
  return null;
}

function applyOrderDatePreset(view,status,type,payment,preset,perspective=""){
  const range=orderDateRangeParams(preset);
  if(range) return navigate(view,{status,type,payment,...range,...(perspective ? {perspective} : {})});
  openCustomOrderDateDialog(view,status,type,payment,perspective);
}
function openCustomOrderDateDialog(view,status,type,payment,perspective=""){
  if(byId('orderDateDialog')) byId('orderDateDialog').remove();
  const now=new Date().toISOString().slice(0,10);
  const modal=document.createElement('div'); modal.id='orderDateDialog'; modal.className='modal';
  modal.innerHTML=`<div class="modal-content order-date-dialog-content"><div class="drawer-header"><h3 style="margin:0;"><i class="fa-regular fa-calendar"></i> Choose dates</h3><button type="button" class="drawer-close-btn" onclick="byId('orderDateDialog')?.remove()"><i class="fa-solid fa-xmark"></i></button></div><div class="order-date-custom-grid"><label>Start date<input id="customDateFrom" type="date" max="${now}" /></label><label>End date<input id="customDateTo" type="date" max="${now}" /></label></div><div class="flex" style="justify-content:flex-end;margin-top:.9rem;"><button class="btn btn-outline" type="button" onclick="byId('orderDateDialog')?.remove()">Cancel</button><button class="btn" type="button" onclick="submitCustomOrderDate('${view}','${status}','${type}','${payment}','${perspective}')">Apply</button></div></div>`;
  document.body.appendChild(modal);
}
function submitCustomOrderDate(view,status,type,payment,perspective=""){
  const from=byId('customDateFrom')?.value||'', to=byId('customDateTo')?.value||'';
  if(from&&to&&from>to){showToast('Start date must be before end date.','error');return;}
  byId('orderDateDialog')?.remove(); navigate(view,{status,type,payment,dateFrom:from,dateTo:to,...(perspective ? {perspective} : {})});
}
function clearOrderDateFilters(view,status,type,payment,perspective=""){ navigate(view,{status,type,payment,dateFrom:'',dateTo:'',...(perspective ? {perspective} : {})}); }

// Quick single-tap status filter, scrolling horizontally instead of wrapping
// onto extra rows (a prior wrapping layout was replaced with the compact
// dropdown filters above -- this rides alongside that dropdown rather than
// bringing that problem back).
const ORDER_BADGE_STATUSES = ["pending", "confirmed", "payment_unresolved"];
// A fully paid order (delivery: deposit + balance; pickup: the full payment) has nothing left for the vendor to do,
// so it never counts as "needing attention" for them. Only the buyer's confirmation (or the 48h auto-complete) remains.
function orderIsFullyPaid(o) {
  if (!o || !Array.isArray(o.payments)) return false;
  const feeType = o.order_type === "sale" ? "sale_price" : "rental_fee";
  const paid = (t) => o.payments.some((p) => String(p.payment_type || "").trim().toLowerCase() === t && p.status === "paid");
  return o.delivery_method === "delivery" ? paid("delivery_deposit_20") && paid(feeType) : paid(feeType);
}
async function vendorAttentionCount() {
  if (!vendor?.id) return { count: 0 };
  try {
    const { data, error } = await sb.from("orders").select("id,status,order_type,delivery_method,awaiting_confirmation_since,payments(payment_type,status)").eq("vendor_id", vendor.id).in("status", NON_TERMINAL_ORDER_STATUSES).limit(500);
    if (error || !Array.isArray(data)) throw error || new Error("none");
    return { count: data.filter((o) => !(o.status === "confirmed" && orderIsFullyPaid(o)) && !(o.awaiting_confirmation_since && ["confirmed", "handed_over"].includes(o.status) && o.order_type !== "rental" && orderIsFullyPaid(o))).length };
  } catch (_) {
    const { count } = await sb.from("orders").select("id", { count: "exact", head: true }).eq("vendor_id", vendor.id).in("status", NON_TERMINAL_ORDER_STATUSES);
    return { count: count || 0 };
  }
}
function orderStatusCountsFrom(rows) {
  const counts = { pending: 0, confirmed: 0, payment_unresolved: 0, all: 0 };
  (rows || []).forEach((o) => { const st = String(o?.status || ""); if (ORDER_BADGE_STATUSES.includes(st)) { if (st === "confirmed" && orderIsFullyPaid(o)) return; counts[st]++; counts.all++; } });
  return counts;
}
// Tapping an order-status pill used to re-download every order (2-3 s). Within 45 s of the
// last load the pill reuses the rows already fetched and just filters them on the device.
const __ordersTabCache = new Map();
function ordersTabCached(key, run) {
  const hit = __ordersTabCache.get(key);
  // A status-pill tap shows what was loaded a moment ago immediately; anything older than 45 s is refreshed quietly in
  // the background so the next tap is current, instead of making this tap wait.
  if (hit && Date.now() - hit.at < 600000 && Date.now() - (window.__ordersRailAt || 0) < 2500) {
    if (Date.now() - hit.at > 45000 && !hit.refreshing) {
      hit.refreshing = true;
      Promise.resolve(run()).then((value) => { if (!(value && value.error)) __ordersTabCache.set(key, { at: Date.now(), value }); else hit.refreshing = false; }).catch(() => { hit.refreshing = false; });
    }
    return Promise.resolve(hit.value);
  }
  return Promise.resolve(run()).then((value) => { if (value && value.error) return value; __ordersTabCache.set(key, { at: Date.now(), value }); if (__ordersTabCache.size > 12) __ordersTabCache.delete(__ordersTabCache.keys().next().value); return value; });
}
async function fetchBuyerOrderStatusCounts() {
  try {
    return await ordersTabCached("bcounts:" + session.user.id, async () => {
    const { data } = await withRouteTimeout(
      sb.from("orders").select("status").eq("buyer_id", session.user.id).in("status", ORDER_BADGE_STATUSES).limit(500),
      3000, { data: [] }
    );
    return orderStatusCountsFrom(data);
    });
  } catch (_) { return orderStatusCountsFrom([]); }
}
function orderStatusPillsHtml(view, status, type, payment, dateFrom, dateTo, perspective = "", counts = null) {
  // Handed over / Returned aren't separate filters any more (still reachable
  // from the dropdown); they only show here if one is the active filter.
  // Completed and Cancelled live in Order history now, so they are not tabs here (still shown if one is the active filter).
  const pillTabs = ORDER_TABS.filter((t) => !["handed_over", "returned", "completed", "cancelled"].includes(t) || t === status);
  const badge = (t) => { const n = Number(counts?.[t] || 0); return n > 0 ? `<span class="order-tab-badge" aria-label="${n} ${t.replace(/_/g, " ")}">${n > 99 ? "99+" : n}</span>` : ""; };
  return `<div class="order-status-pills-rail">${pillTabs.map((t) => `<button type="button" data-status="${t}" class="order-status-pill ${t === status ? "active" : ""}" onclick="window.__ordersRailPending=true;window.__ordersRailAt=Date.now();navigate('${view}',{status:'${t}',type:'${type}',payment:'${payment}',dateFrom:'${dateFrom}',dateTo:'${dateTo}',${perspective ? `perspective:'${perspective}'` : ""}})">${t === "all" ? "All" : esc(t.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()))}${badge(t)}</button>`).join("")}<button type="button" class="order-status-pill lvo-hist-tab" onclick="openOrderHistory()" aria-label="Order history"><i class="fa-solid fa-clock-rotate-left"></i> History</button></div>`;
}

// The tab switches the instant it is tapped (before the orders arrive), and the rows loaded a moment ago are reused.
window.lvOrdersTabFlip = function (b) {
  try { window.__ordersRailPending = true; window.__ordersRailAt = Date.now(); b.parentElement.querySelectorAll("button").forEach((x) => { x.classList.toggle("active", x === b); x.setAttribute("aria-selected", x === b ? "true" : "false"); }); } catch (_) {}
};
function vendorOrdersTabsHtml(active) {
  const salesBadge = Number(vendorPendingOrderCount || 0);
  const purchasesBadge = Number(buyerPendingOrderCount || 0);
  const badge = (n) => n > 0 ? `<span class="orders-perspective-badge">${n > 9 ? '9+' : n}</span>` : '';
  return `<div class="segmented-tabs vendor-orders-perspective-tabs" role="tablist" aria-label="Order perspective" style="max-width:520px;margin:.8rem auto 1rem;">
    <button type="button" class="${active === "sales" ? "active" : ""}" onclick="lvOrdersTabFlip(this);navigate('vendorOrders',{status:'all',type:'all',payment:'all',dateFrom:'',dateTo:'',perspective:'sales'})" role="tab" aria-selected="${active === "sales" ? "true" : "false"}"><i class="fa-solid fa-store"></i> Orders from customers ${badge(salesBadge)}</button>
    <button type="button" class="${active === "purchases" ? "active" : ""}" onclick="lvOrdersTabFlip(this);navigate('vendorOrders',{status:'all',type:'all',payment:'all',dateFrom:'',dateTo:'',perspective:'purchases'})" role="tab" aria-selected="${active === "purchases" ? "true" : "false"}"><i class="fa-solid fa-bag-shopping"></i> My purchases ${badge(purchasesBadge)}</button>
  </div>`;
}

// The orders search control is part of the page HTML itself (not injected afterwards), so
// switching tabs never makes the filter/search icons pop in, jump or blink.
function orderSearchWrapHtml() {
  return `<div class="order-search-wrap final-order-search-wrap"><button type="button" class="icon-btn order-search-toggle" aria-expanded="false" aria-label="Search orders" title="Search orders"><i class="fa-solid fa-magnifying-glass"></i></button><input id="orderHistorySearch" class="order-history-search" type="search" placeholder="Search orders…" autocomplete="off" /></div>`;
}
function orderFiltersDropdownHtml(route, status, type, payment, dateFrom, dateTo, perspective = "") {
  const statusLabel = status === "all" ? "All statuses" : String(status).replace(/_/g, " ").replace(/^./, c => c.toUpperCase());
  const typeLabel = ORDER_TYPE_TABS.find(t => t.value === type)?.label || "All types";
  const paymentLabel = payment === "all" ? "All payments" : payment === "paid" ? "Paid" : "Not paid yet";
  const preset = orderDatePresetValue(dateFrom, dateTo);
  const dateLabel = preset === "all" ? "All time" : ({today:"Today",7:"Last 7 days",30:"Last 30 days",90:"Last 3 months"}[preset] || "Custom range");
  const r = String(route || "buyerOrders").replace(/'/g, "\\'");
  const p = String(perspective || "").replace(/'/g, "\\'");
  return `<div class="order-filters-wrap">
    <button type="button" class="order-filters-trigger${(type !== "all" || payment !== "all" || dateFrom || dateTo) ? " has-filters" : ""}" aria-expanded="false" aria-label="Filters" title="Filters" onclick="toggleOrderFilters(this)">
      <span>${window.LV_FILTER_SVG}</span>
      <small>${esc([statusLabel,typeLabel,paymentLabel,dateLabel].join(" · "))}</small>
      <i class="fa-solid fa-chevron-down order-filters-chevron"></i>
    </button>
    <div class="order-filters-panel hidden"><div class="lm-sheet-head"><strong>Filter orders</strong><button type="button" class="lm-x" onclick="toggleOrderFilters(this.closest('.order-filters-wrap').querySelector('.order-filters-trigger'))" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>
      <div class="order-filters-grid">
        <label>Status<select onchange="navigate('${r}',{status:this.value,type:'${type}',payment:'${payment}',dateFrom:'${dateFrom}',dateTo:'${dateTo}',perspective:'${p}'})">${ORDER_TABS.map(t => `<option value="${t}" ${t===status?"selected":""}>${t==="all"?"All statuses":esc(t.replace(/_/g," ").replace(/^./,c=>c.toUpperCase()))}</option>`).join("")}</select></label>
        <label>Type<select onchange="navigate('${r}',{status:'${status}',type:this.value,payment:'${payment}',dateFrom:'${dateFrom}',dateTo:'${dateTo}',perspective:'${p}'})">${ORDER_TYPE_TABS.map(t => `<option value="${t.value}" ${t.value===type?"selected":""}>${t.value==="all"?"All types":esc(t.label)}</option>`).join("")}</select></label>
        <label>Payment<select onchange="navigate('${r}',{status:'${status}',type:'${type}',payment:this.value,dateFrom:'${dateFrom}',dateTo:'${dateTo}',perspective:'${p}'})">
          <option value="all" ${payment==="all"?"selected":""}>All payments</option><option value="paid" ${payment==="paid"?"selected":""}>Paid</option><option value="unpaid" ${payment==="unpaid"?"selected":""}>Not paid yet</option>
        </select></label>
        <label>Date<select onchange="applyOrderDatePreset('${r}','${status}','${type}','${payment}',this.value,'${p}')">
          <option value="all" ${preset==="all"?"selected":""}>All time</option><option value="today" ${preset==="today"?"selected":""}>Today</option><option value="7" ${preset==="7"?"selected":""}>Last 7 days</option><option value="30" ${preset==="30"?"selected":""}>Last 30 days</option><option value="90" ${preset==="90"?"selected":""}>Last 3 months</option>
        </select></label>
      </div>
      <div class="order-filters-actions">
        <button type="button" class="order-filter-clear-btn" onclick="clearOrderDateFilters('${r}','${status}','${type}','${payment}','${p}')"><i class="fa-solid fa-rotate-left"></i> Clear dates</button>
        <button type="button" class="order-filter-done-btn" onclick="toggleOrderFilters(this)">Done</button>
      </div>
    </div>
  </div>`;
}
function toggleOrderFilters(btn) {
  const wrap = btn?.closest?.('.order-filters-wrap');
  const panel = wrap?.querySelector('.order-filters-panel');
  const trigger = wrap?.querySelector('.order-filters-trigger');
  if (!panel || !trigger) return;
  const open = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !open);
  trigger.setAttribute('aria-expanded', String(open));
  trigger.classList.toggle('active', open);
}

async function renderVendorOrders(status, type, payment, dateFrom, dateTo, perspective = "sales") {
  perspective = perspective === "purchases" ? "purchases" : "sales";
  if (perspective === "purchases") {
    if (session) {
      // the badge numbers load in the background: the list must not wait for them
      Promise.all([
        vendor ? vendorAttentionCount() : Promise.resolve({ count: 0 }),
        sb.from("orders").select("id", { count: "exact", head: true }).eq("buyer_id", session.user.id).in("status", NON_TERMINAL_ORDER_STATUSES),
      ]).then(([{ count: salesCount }, { count: purchaseCount }]) => { vendorPendingOrderCount = salesCount || 0; buyerPendingOrderCount = purchaseCount || 0; }).catch(() => {});
    }
    return renderCustomerOrders(status, type, payment, dateFrom, dateTo, true);
  }
  if (!session || profile?.role === "admin" || (profile?.role !== "vendor" && !vendor)) return '<div class="empty-state">Access denied.</div>';
  if (!vendor) { const { data: v } = await sb.from("vendors").select("id").eq("user_id", session.user.id).is("deleted_at", null).maybeSingle(); vendor = v; }
  if (!vendor) { navigate("vendorApply"); return '<p class="muted">Redirecting…</p>'; }
  status = ORDER_TABS.includes(status) ? status : "all";
  type = ORDER_TYPE_TABS.some((t) => t.value === type) ? type : "all";
  payment = ["all", "paid", "unpaid"].includes(payment) ? payment : "all";
  dateFrom = dateFrom || "";
  dateTo = dateTo || "";
  vendorOrderStatsPeriod = "today";

  // Use order_items(*) rather than naming columns, so a schema change to
  // order_items can't make the entire Orders page look empty.
  let query = sb.from("orders").select("*, buyer:users(name), items:order_items(*,product:products(id,is_service,name,photos)), payments(payment_type,status)").eq("vendor_id", vendor.id);
  if (dateFrom) query = query.gte("created_at", `${dateFrom}T00:00:00`);
  if (dateTo) query = query.lte("created_at", `${dateTo}T23:59:59`);
  // Stats always reflect the vendor's full order history, not whatever
  // status/type/payment/date filters the list below happens to be set to
  // -- run both queries together instead of one after the other.
  // The badge counts are fetched at the same time as the orders, not after them.
  const __countsP = ordersTabCached(`vcnt:${vendor.id}:${session.user.id}`, async () => {
    const [{ count: salesCount }, { count: purchaseCount }] = await Promise.all([
      vendorAttentionCount(),
      sb.from("orders").select("id", { count: "exact", head: true }).eq("buyer_id", session.user.id).in("status", NON_TERMINAL_ORDER_STATUSES),
    ]);
    return { salesCount, purchaseCount };
  }).catch(() => null);
  const [{ data: __allOrdersRaw0, error: allOrdersError0 }, { data: statsOrders0, error: statsError }] = await Promise.all([
    ordersTabCached(`vo:${vendor.id}:${dateFrom}:${dateTo}`, () => withRouteTimeout(query.order("created_at", { ascending: false }), 14000, { data: null, error: new Error("order query timeout") })),
    ordersTabCached(`vs2:${vendor.id}`, () => withRouteTimeout(sb.from("orders").select("status, created_at, status_changed_at, completed_at, cancelled_at, order_type, delivery_method, awaiting_confirmation_since, payments(payment_type,status)").eq("vendor_id", vendor.id), 14000, { data: null, error: new Error("stats query timeout") })),
  ]);
  // Delivered and paid, just waiting out the buyer's 24-hour window: for the vendor it counts as Completed,
  // so it stops mixing with the orders still needing their attention. A dispute moves it to Disputed as usual.
  // A slow or failed load must never make orders vanish from a tab: keep the last complete list and use it until a good one arrives.
  window.__lastVendorOrders = window.__lastVendorOrders || {};
  const __lastKey = `${vendor.id}:${dateFrom}:${dateTo}`;
  let allOrdersRaw0 = __allOrdersRaw0;
  if (Array.isArray(allOrdersRaw0)) window.__lastVendorOrders[__lastKey] = allOrdersRaw0;
  else if (Array.isArray(window.__lastVendorOrders[__lastKey])) allOrdersRaw0 = window.__lastVendorOrders[__lastKey];
  const vendorEffectiveStatus = (o) => (o && o.awaiting_confirmation_since && ["confirmed", "handed_over"].includes(o.status) && o.order_type !== "rental" && orderIsFullyPaid(o)) ? { ...o, status: "completed", __ackPending: true } : o;
  const allOrdersError = Array.isArray(__allOrdersRaw0) ? allOrdersError0 : (Array.isArray(allOrdersRaw0) ? null : allOrdersError0);
  const allOrdersRaw = Array.isArray(allOrdersRaw0) ? allOrdersRaw0.map(vendorEffectiveStatus) : allOrdersRaw0;
  const statsOrders = Array.isArray(statsOrders0) ? statsOrders0.map(vendorEffectiveStatus) : statsOrders0;
  const allOrders = allOrdersRaw && status !== "all" ? allOrdersRaw.filter((o) => o.status === status) : allOrdersRaw;
  // If the timestamp migration has not been run yet, fall back to the base
  // order query instead of rendering an empty page.
  let safeAllOrders = allOrders;
  if (allOrdersError) {
    console.warn("Rich vendor order query failed; using compatibility query", allOrdersError);
    let fallback = sb.from("orders").select("*").eq("vendor_id", vendor.id);
    if (status !== "all") fallback = fallback.eq("status", status);
    if (dateFrom) fallback = fallback.gte("created_at", `${dateFrom}T00:00:00`);
    if (dateTo) fallback = fallback.lte("created_at", `${dateTo}T23:59:59`);
    const r = await withRouteTimeout(fallback.order("created_at", { ascending: false }), 14000, { data: null, error: new Error("order query timeout") });
    if (r.error || !Array.isArray(r.data)) {
      // Never show "no orders" just because the server was slow: keep what was loaded a moment ago, or say it could not load.
      const good = window.__lastGoodVendorOrders?.[vendor.id];
      if (good) safeAllOrders = status === "all" ? good : good.filter((o) => o.status === status);
      else return `<div class="empty-state orders-empty"><span class="orders-empty-icon"><i class="fa-solid fa-wifi"></i></span><strong>We couldn't load your orders</strong><span class="muted">Your orders are safe. Check your connection and try again.</span><button type="button" class="btn" style="margin-top:.8rem" onclick="navigate('vendorOrders',{status:'all',type:'all',payment:'all'})">Try again</button></div>`;
    } else safeAllOrders = r.data;
  } else if (safeAllOrders && !dateFrom && !dateTo && status === "all") {
    (window.__lastGoodVendorOrders ||= {})[vendor.id] = safeAllOrders;
  }
  // Item summaries and customer names are looked up together (they used to run one after the other).
  const __hydrateItems = (async () => {
  try {
    const orderIds = (safeAllOrders || []).filter(o => !Array.isArray(o.items) || !o.items.length).map(o => o.id).filter(Boolean);
    if (orderIds.length) {
      const { data: orderItems } = await withRouteTimeout(
        sb.from("order_items").select("order_id,product_id,quantity,unit_price,product:products(id,is_service,name,photos)").in("order_id", orderIds),
        2500, { data: [], error: null }
      );
      const byOrder = new Map();
      (orderItems || []).forEach(it => { if (!byOrder.has(it.order_id)) byOrder.set(it.order_id, []); byOrder.get(it.order_id).push(it); });
      (safeAllOrders || []).forEach(o => { if (!Array.isArray(o.items) || !o.items.length) o.items = byOrder.get(o.id) || []; });
    }
  } catch (_) {}
  })();

  let orders = type === "all" ? safeAllOrders : (safeAllOrders || []).filter((o) => orderCategory(o) === type);
  if (payment !== "all") orders = (orders || []).filter((o) => (payment === "paid" ? isOrderPaid(o) : !isOrderPaid(o)));

  // The orders relation can return the order while hiding the nested users row
  // under RLS. Resolve the customer's display name through the existing secure
  // buyer-contact RPC so every vendor card can identify the customer.
  const __hydrateNames = (async () => {
  try {
    // One RPC per order was fired on every render of the vendor list (including for
    // pending/cancelled orders whose customer is hidden anyway). Only look up the
    // name for accepted orders, and remember it for the session.
    window.__buyerNameCache = window.__buyerNameCache || new Map();
    const need = (safeAllOrders || []).filter((o) => o.id && !o.buyer?.name && !["pending", "cancelled"].includes(String(o.status || "")) && !window.__buyerNameCache.has(o.id)).map((o) => o.id);
    if (need.length) {
      const r = await withRouteTimeout(sb.rpc("get_orders_buyer_names", { p_order_ids: need }), 3000, { data: [] });
      (Array.isArray(r?.data) ? r.data : []).forEach((x) => { if (x?.name) window.__buyerNameCache.set(x.order_id, x.name); });
    }
    (safeAllOrders || []).forEach((o) => { if (!o.buyer?.name && window.__buyerNameCache.has(o.id)) o.buyer = { ...(o.buyer || {}), name: window.__buyerNameCache.get(o.id) }; });
  } catch (_) {}
  })();
  await Promise.all([__hydrateItems, __hydrateNames]);
  // Customers stay anonymous to the vendor until the order is accepted.
  (safeAllOrders || []).forEach((o) => { if (["pending", "cancelled"].includes(String(o.status || ""))) o.buyer = null; });

  let safeStatsOrders = statsOrders || [];
  if (statsError) {
    let fb = await sb.from("orders").select("status, created_at, order_type, delivery_method, awaiting_confirmation_since, payments(payment_type,status)").eq("vendor_id", vendor.id);
    if (fb.error) fb = await sb.from("orders").select("status, created_at").eq("vendor_id", vendor.id);
    safeStatsOrders = (fb.data || []).map(vendorEffectiveStatus);
  }
  window.__orderStatsOrders = safeStatsOrders;

  // Refresh both perspective counts while the Orders page is open so the
  // two perspective badges and the bottom-nav badge never depend on a stale
  // previous screen.
  try {
    const counts = (await __countsP) || {};
    vendorPendingOrderCount = counts.salesCount || 0;
    buyerPendingOrderCount = counts.purchaseCount || 0;
    renderBottomNav();
  } catch (_) {}
  // Three rows of tab pills used to wrap into an unreadable jumble on
  // narrow screens - compact dropdowns plus a date range say the same
  // thing in a fraction of the space.
  const sortedOrders = sortOrdersForList(orders);
  const { active: activeVendorOrders, history: historyVendorOrders } = splitActiveAndHistoryOrders(sortedOrders, status);
  // Finished sales open from a History button beside the title (same as the
  // customer page) instead of a long accordion under the list.
  rememberOrderHistory("sales", splitActiveAndHistoryOrders(sortOrdersForList(safeAllOrders || []), "all").history, false, "sales");
  window.__orderHistoryEmpty = !historyVendorOrders.length;
  const vendorFiltersRow = `<div class="orders-filter-search-row">${orderFiltersDropdownHtml("vendorOrders", status, type, payment, dateFrom, dateTo, "sales")}${orderSearchWrapHtml()}</div>`;
  const vendorHistoryBtn = `<button type="button" class="orders-icon-btn" onclick="openOrderHistory()" aria-label="Order history" title="Order history"><i class="fa-solid fa-clock-rotate-left"></i></button>`;
  let html = `<div class="orders-title-row"><h2>Orders</h2><div class="orders-top-actions">${vendorFiltersRow}${vendorHistoryBtn}</div></div>`;
  html += vendorOrdersTabsHtml("sales");
  html += orderStatsHtml(safeStatsOrders);
  html += orderStatusPillsHtml("vendorOrders", status, type, payment, dateFrom, dateTo, "sales", orderStatusCountsFrom(safeStatsOrders));
  orderListViewMode = "cards";
  orderListExpanded = false;
  window.__orderListOrders = activeVendorOrders;
  window.__orderListIsCustomer = false;
  window.__orderListSourcePerspective = "sales";
  html += orderListControlsHtml(activeVendorOrders.length);
  html += `<div id="orderListWrap">${orderListHtml(activeVendorOrders, false, "sales")}</div>`;
  setTimeout(() => { enhanceSelectsIn(byId("app")); renderOrderStatsBody(); }, 0);
  return html;
}

async function renderCustomerOrders(status, type, payment, dateFrom, dateTo, embeddedVendorOrders = false) {
  const ordersRoute = embeddedVendorOrders ? "vendorOrders" : "buyerOrders";
  const ordersPerspective = embeddedVendorOrders ? "purchases" : "";
  if (!session) return '<div class="empty-state">Please log in.</div>';
  status = ORDER_TABS.includes(status) ? status : "all";
  type = ORDER_TYPE_TABS.some((t) => t.value === type) ? type : "all";
  payment = ["all", "paid", "unpaid"].includes(payment) ? payment : "all";
  dateFrom = dateFrom || "";
  dateTo = dateTo || "";

  const __buyerCountsP = fetchBuyerOrderStatusCounts();   // fetched alongside the orders, not after them
  // order_items(*) is intentionally used here rather than naming columns,
  // so this stays resilient to schema changes on order_items.
  let query = sb.from("orders").select("*, vendor:vendors(business_name,city,logo_url), items:order_items(*,product:products(id,is_service,name,photos)), payments(payment_type,status)").eq("buyer_id", session.user.id);
  if (dateFrom) query = query.gte("created_at", `${dateFrom}T00:00:00`);
  if (dateTo) query = query.lte("created_at", `${dateTo}T23:59:59`);
  const { data: allOrdersRaw, error: allOrdersError } = await ordersTabCached(`bo:${session.user.id}:${dateFrom}:${dateTo}`, () => withRouteTimeout(query.order("created_at", { ascending: false }), 14000, { data: null, error: new Error("order query timeout") }));
  const allOrders = allOrdersRaw && status !== "all" ? allOrdersRaw.filter((o) => o.status === status) : allOrdersRaw;
  let safeAllOrders = allOrders;
  if (allOrdersError) {
    console.warn("Rich buyer order query failed; using compatibility query", allOrdersError);
    let fallback = sb.from("orders").select("*").eq("buyer_id", session.user.id);
    if (status !== "all") fallback = fallback.eq("status", status);
    if (dateFrom) fallback = fallback.gte("created_at", `${dateFrom}T00:00:00`);
    if (dateTo) fallback = fallback.lte("created_at", `${dateTo}T23:59:59`);
    const r = await withRouteTimeout(fallback.order("created_at", { ascending: false }), 14000, { data: null, error: new Error("order query timeout") });
    if (r.error || !Array.isArray(r.data)) {
      // Never show "no orders" just because the server was slow: keep what was loaded a moment ago, or say it could not load.
      const good = window.__lastGoodBuyerOrders?.[session.user.id];
      if (good) safeAllOrders = status === "all" ? good : good.filter((o) => o.status === status);
      else return `<div class="empty-state orders-empty"><span class="orders-empty-icon"><i class="fa-solid fa-wifi"></i></span><strong>We couldn't load your orders</strong><span class="muted">Your orders are safe. Check your connection and try again.</span><button type="button" class="btn" style="margin-top:.8rem" onclick="navigate('buyerOrders',{status:'all',type:'all',payment:'all'})">Try again</button></div>`;
    } else safeAllOrders = r.data;
  } else if (safeAllOrders && !dateFrom && !dateTo && status === "all") {
    (window.__lastGoodBuyerOrders ||= {})[session.user.id] = safeAllOrders;
  }

  // Fill in anything the rich query didn't return (items / vendor) in ONE
  // parallel round instead of sequential waits.
  try {
    const rows = safeAllOrders || [];
    const orderIds = rows.filter(o => !Array.isArray(o.items) || !o.items.length).map(o => o.id).filter(Boolean);
    const vendorIds = [...new Set(rows.filter(o => !o.vendor).map(o => o.vendor_id).filter(Boolean))];
    const [itemsRes, vendorsRes] = await Promise.all([
      orderIds.length
        ? withRouteTimeout(sb.from("order_items").select("order_id,product_id,quantity,unit_price,product:products(id,is_service,name,photos)").in("order_id", orderIds), 4000, { data: [], error: null })
        : Promise.resolve({ data: [] }),
      vendorIds.length
        ? withRouteTimeout(sb.from("vendors").select("id,business_name,city,logo_url").in("id", vendorIds), 4000, { data: [], error: null })
        : Promise.resolve({ data: [] }),
    ]);
    const byOrder = new Map();
    (itemsRes.data || []).forEach(it => { if (!byOrder.has(it.order_id)) byOrder.set(it.order_id, []); byOrder.get(it.order_id).push(it); });
    rows.forEach(o => { if (!Array.isArray(o.items) || !o.items.length) o.items = byOrder.get(o.id) || []; });
    const vById = new Map((vendorsRes.data || []).map(v => [String(v.id), v]));
    rows.forEach(o => { if (!o.vendor && vById.has(String(o.vendor_id))) o.vendor = vById.get(String(o.vendor_id)); });
  } catch (_) {}
  // Build the buyer's order list before applying the payment filter.
  // A previous precision patch accidentally referenced `orders` before it was
  // declared, which made the buyer My Orders renderer throw and the router
  // fall back to the bare "Order" shell.
  let orders = type === "all" ? (safeAllOrders || []) : (safeAllOrders || []).filter((o) => orderCategory(o) === type);
  if (payment !== "all") orders = orders.filter((o) => (payment === "paid" ? isOrderPaid(o) : !isOrderPaid(o)));

  const sortedOrders = sortOrdersForList(orders);
  const { active: activeCustomerOrders, history: historyCustomerOrders } = splitActiveAndHistoryOrders(sortedOrders, status);
  // History and "continue shopping" live as two small buttons beside the title
  // instead of an accordion and a button stuck under the list.
  rememberOrderHistory(embeddedVendorOrders ? "purchases" : "", splitActiveAndHistoryOrders(sortOrdersForList(safeAllOrders || []), "all").history, true, embeddedVendorOrders ? "purchases" : null);
  window.__orderHistoryEmpty = !historyCustomerOrders.length;
  const filtersRow = `<div class="orders-filter-search-row">${orderFiltersDropdownHtml(ordersRoute, status, type, payment, dateFrom, dateTo, ordersPerspective)}${orderSearchWrapHtml()}</div>`;
  const remindAllBtn = !embeddedVendorOrders && (activeCustomerOrders || []).some((o) => ["pending", "confirmed", "handed_over"].includes(o.status))
    ? `<button type="button" class="orders-icon-btn orders-remind-all-btn" onclick="remindAllVendors(this)" aria-label="Remind all vendors" title="Remind all vendors waiting on your orders"><i class="fa-solid fa-bell"></i></button>` : "";
  const moreMenu = remindAllBtn + `<button type="button" class="orders-icon-btn orders-history-btn" onclick="openOrderHistory()" aria-label="Order history" title="Order history"><i class="fa-solid fa-clock-rotate-left"></i></button>`;
  let html = `${embeddedVendorOrders || typeof lvPageHero !== "function" ? "" : lvPageHero("orders")}<div class="orders-title-row"><h2>${embeddedVendorOrders ? "Orders" : "My Orders"}</h2><div class="orders-top-actions">${filtersRow}${moreMenu}</div></div>`;
  if (embeddedVendorOrders) html += vendorOrdersTabsHtml("purchases");
  html += orderStatusPillsHtml(ordersRoute, status, type, payment, dateFrom, dateTo, ordersPerspective, await __buyerCountsP);
  orderListViewMode = "cards";
  orderListExpanded = false;
  window.__orderListOrders = activeCustomerOrders;
  window.__orderListIsCustomer = true;
  window.__orderListSourcePerspective = embeddedVendorOrders ? "purchases" : null;
  html += orderListControlsHtml(activeCustomerOrders.length);
  html += `<div id="orderListWrap">${orderListHtml(activeCustomerOrders, true, embeddedVendorOrders ? "purchases" : null)}</div>`;
  setTimeout(() => enhanceSelectsIn(byId("app")), 0);
  return html;
}

function orderStatusBadgeClass(status) {
  if (status === "cancelled") return "danger";
  if (status === "payment_unresolved") return "unresolved";
  if (status === "disputed") return "warning";
  if (status === "completed") return "success";
  if (status === "handed_over" || status === "returned") return "warning";
  if (status === "confirmed") return "info";
  if (status === "pending") return "pending";
  return "";
}

// Pending and confirmed orders need action right now, so they float to the
// top regardless of when they came in. Handed-over/returned (still in
// progress) sit next, then finished (completed) orders. Disputed sinks to
// the bottom with cancelled - a dispute needs an admin's attention, not
// day-to-day action from the vendor, so it doesn't need to compete for
// top-of-list space. Everything stays newest-first within its own group.
function orderActivityIso(order) {
  if (!order) return null;
  if (order.status === "completed" && order.completed_at) return order.completed_at;
  if (order.status === "cancelled" && order.cancelled_at) return order.cancelled_at;
  return order.status_changed_at || order.updated_at || order.created_at || null;
}
function orderActivityLabel(order) {
  const iso = orderActivityIso(order);
  if (!iso) return "";
  if (order.status === "completed") return `Completed ${orderDateTimeStr(iso)}`;
  if (order.status === "cancelled") return `Cancelled ${orderDateTimeStr(iso)}`;
  if (order.status !== "pending" && iso !== order.created_at) return `Updated ${orderDateTimeStr(iso)}`;
  return `Placed ${orderDateTimeStr(order.created_at || iso)}`;
}
// No artificial status ranking. Orders appear in the order their latest
// status activity happened. Completed does not permanently sit above
// cancelled, and cancelled does not permanently sit above completed.
function sortOrdersForList(orders) {
  return [...(orders || [])].sort((a, b) => new Date(orderActivityIso(b) || 0) - new Date(orderActivityIso(a) || 0));
}

// Generic search-any-table helper - hides <tr> rows (and, if a table ends
// up with none left visible, its own preceding date-group header) whose
// text doesn't match. Reused across every data table on the site instead
// of writing bespoke filter logic per table.
function filterTableRowsBySearch(inputEl, scopeSelector) {
  const q = inputEl.value.trim().toLowerCase();
  document.querySelectorAll(scopeSelector).forEach((wrap) => {
    let anyVisible = false;
    wrap.querySelectorAll("tbody tr, .fin-row").forEach((row) => {
      const match = !q || row.textContent.toLowerCase().includes(q);
      row.classList.toggle("hidden", !match);
      if (match) anyVisible = true;
    });
    wrap.classList.toggle("hidden", !anyVisible);
    const header = wrap.previousElementSibling;
    if (header && header.classList.contains("category-group-header")) header.classList.toggle("hidden", !anyVisible);
  });
}
function orderDateTimeStr(iso) {
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

let orderListViewMode = "cards"; // cards | table
let orderListExpanded = false;
const ORDER_LIST_PAGE_SIZE = 5;

// Finished orders (nothing left to do) move out of the main list into a
// collapsed, date-grouped "Order history" section -- only when no explicit
// status filter is picked, so choosing "Completed" from the dropdown still
// shows completed orders directly instead of hiding them behind a second
// collapse.
const ORDER_HISTORY_STATUSES = new Set(["completed", "cancelled", "returned"]);
function splitActiveAndHistoryOrders(orders, status) {
  if (status !== "all") return { active: orders, history: [] };
  return {
    active: orders.filter((o) => !ORDER_HISTORY_STATUSES.has(o.status)),
    history: orders.filter((o) => ORDER_HISTORY_STATUSES.has(o.status)),
  };
}
function orderHistoryActivityLabel(order) {
  const iso = orderActivityIso(order);
  return iso ? orderDateTimeStr(iso) : "";
}
function orderHistorySearchText(o, isCustomerView) {
  const itemNames = (o.items || []).map((it) => it.product?.name || "").join(" ");
  const party = isCustomerView ? (o.vendor?.business_name || "") : (o.buyer?.name || "");
  return [itemNames, party, o.order_type, o.status, String(o.status || "").replace(/_/g, " "), o.id, String(o.id || "").slice(0, 8), o.total_amount, orderActivityLabel(o)]
    .join(" ").toLowerCase();
}
// The picture of what was ordered (first item's first photo), never the shop's logo.
function orderHistoryThumbHtml(o) {
  const it = (o.items || []).find((x) => x?.product?.photos?.length) || (o.items || [])[0];
  const src = it?.product?.photos?.[0];
  return src ? `<img class="order-history-thumb" src="${esc(src)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'order-history-thumb order-history-thumb-empty'}))">` : `<span class="order-history-thumb order-history-thumb-empty"></span>`;
}
function orderHistoryInnerHtml(historyOrders, isCustomerView, sourcePerspective = null) {
  const byDate = new Map();
  historyOrders.forEach((o) => {
    const key = new Date(orderActivityIso(o) || o.created_at).toLocaleDateString("en-NG", { weekday: "short", year: "numeric", month: "short", day: "numeric" });
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(o);
  });
  let inner = "";
  byDate.forEach((dayOrders, dateKey) => {
    inner += `<div class="order-history-date"><i class="fa-regular fa-calendar"></i><span>${esc(dateKey)}</span></div>`;
    inner += `<div class="order-history-day">${dayOrders.map((o) => {
      const itemNames = (o.items || []).map((it) => `${it.product?.name || "Item"}${Number(it.quantity || 0) > 1 ? ` ×${it.quantity}` : ""}`).join(", ");
      const productIds = [...new Set((o.items || []).map((it) => it.product?.id || it.product_id).filter(Boolean))].join(", ");
      const partyName = isCustomerView ? (o.vendor?.business_name || "Vendor") : (o.buyer?.name || "Customer");
      return `<button type="button" class="order-history-card" onclick="navigate('orderDetail',{orderId:'${o.id}'${sourcePerspective ? `,source:'${sourcePerspective}'` : ''}})">${orderHistoryThumbHtml(o)}<span class="order-history-main"><strong>${isCustomerView ? esc(partyName) : `Customer: ${esc(partyName)}`}</strong><span class="order-history-meta"><span>Order: ${esc(o.order_type)}</span><span class="order-history-separator">·</span><span>${naira(o.total_amount)}</span></span>${itemNames ? `<span class="order-history-item">Item: ${esc(itemNames)}</span>` : ""}${!isCustomerView && productIds ? `<small class="order-history-product-id">Product ID: ${esc(productIds)}</small>` : ""}<small><i class="fa-regular fa-clock"></i> ${esc(orderActivityLabel(o))}</small></span><span class="badge ${lvOrderStageLabel(o) ? "order-status-badge-paid" : orderStatusBadgeClass(o.status)} order-history-status">${esc(lvOrderStageLabel(o)) || (o.status === "cancelled" ? "Cancelled" : o.status === "completed" ? "Completed" : esc(o.status.replace("_", " ")))}</span></button>`;
    }).join("")}</div>`;
  });
  return inner;
}
function orderHistoryAccordionHtml(historyOrders, isCustomerView, sourcePerspective = null) {
  if (!historyOrders || !historyOrders.length) return "";
  const inner = orderHistoryInnerHtml(historyOrders, isCustomerView, sourcePerspective);
  const historyTitle = isCustomerView ? (sourcePerspective === "purchases" ? "My purchase history" : "My order history") : "Customer order history";
  const historyId = sourcePerspective === "purchases" ? "vendorPurchaseHistoryAccordion" : sourcePerspective === "sales" ? "vendorSalesHistoryAccordion" : "buyerOrderHistoryAccordion";
  return `<div class="accordion-section" id="${historyId}" style="margin-top:1.2rem;">
    <button class="accordion-trigger" onclick="toggleAccordion(this)"><span><i class="fa-solid fa-clock-rotate-left"></i> ${historyTitle} (${historyOrders.length})</span><i class="fa-solid fa-chevron-down accordion-chevron"></i></button>
    <div class="accordion-body">${inner}</div>
  </div>`;
}



// One bell: remind every shop that still has an order of yours waiting (each shop at most once every 2 minutes).
window.remindAllVendors = async function (btn) {
  if (!session?.user?.id || window.__remindAllBusy) return;
  window.__remindAllBusy = true; if (btn) btn.disabled = true;
  try {
    const r = await sb.rpc("remind_all_orders");
    if (r.error) throw r.error;
    const n = Number(r.data?.reminded || 0), k = Number(r.data?.skipped || 0);
    try { unlockNotificationAudio(); if (audioCtx?.state === "running") playReminderChime(); } catch (_) {}
    showToast(n ? `Reminder sent to ${n} vendor${n === 1 ? "" : "s"}.` + (k ? ` ${k} reminded a moment ago.` : "") : "Everyone was reminded a moment ago. You can remind again in 2 minutes.", n ? "success" : "info");
  } catch (err) { showToast(err.message || "Could not send reminders. Please try again.", "error"); }
  finally { window.__remindAllBusy = false; if (btn) btn.disabled = false; }
};
