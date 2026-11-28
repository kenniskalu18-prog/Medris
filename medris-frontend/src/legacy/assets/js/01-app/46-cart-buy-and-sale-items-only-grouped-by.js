// ---------- CART (buy-and-sale items only, grouped by vendor; add/remove actions stay on the current page) ----------
//
// vendor group checks out as its own order, same reasoning as the
// single-vendor-per-checkout recommendation: one Paystack charge per
// vendor keeps the existing per-order payment/payout machinery untouched
// instead of inventing a split-charge system) ----------
function cartItemRowHtml(it) {
  const p = it.product;
  const variant = it.variant || null;
  const effectivePrice = Number(variant?.discount_price ?? variant?.sale_price ?? p.discount_price ?? p.sale_price ?? 0);
  const img = variant?.photo_url || (p.photos && p.photos[0]);
  return `<div class="cart-item">
    ${img ? `<img class="cart-item-img" src="${esc(lvThumb(img, 120))}" alt="" loading="lazy" decoding="async" />` : `<span class="cart-item-img cart-item-img-empty"><i class="fa-solid fa-box"></i></span>`}
    <div class="cart-item-main">
      <strong class="cart-item-name">${esc(p.name)}</strong>
      ${variant ? `<span class="cart-item-variant">${esc(variant.name)}</span>` : ""}
      <span class="cart-item-price">${naira(effectivePrice)} <small>each</small></span>
      <div class="cart-item-controls">
        <div class="cart-qty" role="group" aria-label="Quantity">
          <button type="button" aria-label="Decrease quantity" onclick="updateCartQty('${it.id}',${it.quantity - 1})" ${it.quantity <= 1 ? "disabled" : ""}><i class="fa-solid fa-minus"></i></button>
          <span aria-live="polite">${it.quantity}</span>
          <button type="button" aria-label="Increase quantity" onclick="updateCartQty('${it.id}',${it.quantity + 1})"><i class="fa-solid fa-plus"></i></button>
        </div>
        <button type="button" class="cart-remove" title="Remove" aria-label="Remove ${esc(p.name)} from cart" onclick="removeFromCart('${it.id}')"><i class="fa-solid fa-trash"></i></button>
      </div>
    </div>
  </div>`;
}
async function renderCart() {
  if (!session) return '<div class="empty-state">Log in to see your cart.</div>';
  if (profile?.role === "admin") return '<div class="empty-state">Admin accounts can\'t make purchases on Levromart.</div>';

  const cartResult = await withRouteTimeout(
    levroData.cart.list(session.user.id),
    8000,
    { data: null, error: new Error("Your cart is taking too long to load. Please try again.") }
  );
  const { data: items, error } = cartResult || { data: null, error: new Error("Your cart could not be loaded.") };
  if (error) return `<h2 class="cart-page-title"><i class="fa-solid fa-cart-shopping"></i> Your Cart</h2>${errorStateHtml(error)}<button class="btn btn-outline" onclick="navigate('cart',{},false)"><i class="fa-solid fa-rotate-right"></i> Try again</button>`;

  const cartHead = (n) => `<div class="cart-head"><button type="button" class="cart-back" onclick="history.length>1?history.back():navigate('home')" aria-label="Back"><i class="fa-solid fa-arrow-left"></i></button><h2 class="cart-page-title"><i class="fa-solid fa-cart-shopping cart-title-ico"></i> My Cart${n ? ` <span class="cart-count">(${n})</span>` : ""}</h2>${n ? `<button type="button" class="cart-ico cart-checkall" onclick="openCheckoutAllSheet()" aria-label="Checkout all" title="Checkout all"><i class="fa-solid fa-bag-shopping"></i></button><button type="button" class="cart-ico cart-clear" onclick="openClearCartSheet()" aria-label="Clear cart" title="Clear cart"><i class="fa-solid fa-trash-can"></i></button>` : ""}</div>`;
  let html = "";
  if (!items || items.length === 0) {
    return `<div class="cart-page">${typeof lvPageHero === "function" ? lvPageHero("cart") : ""}${cartHead(0)}<div class="vd-empty"><span class="vd-empty-ico lv-empty-illus">${typeof lvIllus === "function" ? lvIllus("cart", 76) : '<i class="fa-solid fa-cart-shopping"></i>'}</span><strong>Your cart is empty</strong><p>Add items from any product page, or tell Levi what you want and it'll add them for you.</p><button type="button" class="vl-add" onclick="navigate('home')"><i class="fa-solid fa-bag-shopping"></i> Start shopping</button></div></div>`;
  }

  // The shop picture in each store header is the one on its storefront: the account picture, else the logo, else the initials.
  try {
    const vIds = [...new Set(items.map((it) => it.product?.vendor?.id).filter(Boolean))];
    if (vIds.length) {
      const [logos, owners] = await Promise.all([
        withRouteTimeout(sb.from("vendors").select("id,logo_url").in("id", vIds), 4000, { data: null }),
        withRouteTimeout(sb.rpc("get_vendor_owner_avatars", { p_vendor_ids: vIds }), 4000, { data: null })
      ]);
      const logoBy = new Map((logos?.data || []).map((r) => [String(r.id), r.logo_url]));
      const ownerBy = new Map((owners?.data || []).map((r) => [String(r.vendor_id || r.id), r.avatar_url]));
      items.forEach((it) => { const v = it.product?.vendor; if (v) { v.logo_url = v.logo_url || logoBy.get(String(v.id)) || null; v.profile_avatar_url = ownerBy.get(String(v.id)) || null; } });
    }
  } catch (_) {}
  const valid = items.filter((it) => it.product && it.product.status === "active" && it.product.vendor?.verification_status === "verified" && it.product.vendor?.is_active);
  const ownItems = valid.filter((it) => isOwnVendorId(it.product.vendor?.id));
  if (ownItems.length) {
    // Clean up any legacy/self-added cart rows created before the current
    // self-purchase guard. New self-items are blocked by both the UI and DB
    // trigger, so this only removes stale rows that should never have been
    // purchasable in the first place.
    await levroData.cart.removeMany(ownItems.map((it) => it.id));
  }
  const purchasable = valid.filter((it) => !ownItems.includes(it));
  const stale = items.filter((it) => !purchasable.includes(it));

  const byVendor = new Map();
  purchasable.forEach((it) => {
    const vId = String(it.product.vendor.id);
    if (!byVendor.has(vId)) byVendor.set(vId, { vendor: it.product.vendor, items: [] });
    byVendor.get(vId).items.push(it);
  });
  window.__cartByVendor = byVendor;

  [...byVendor.values()].forEach(({ vendor: v, items: vItems }) => {
    const subtotal = vItems.reduce((s, it) => s + Number(it.variant?.discount_price ?? it.variant?.sale_price ?? it.product.discount_price ?? it.product.sale_price ?? 0) * it.quantity, 0);
    const ownCartVendor = isOwnVendorId(v.id);
    // One delivery per shop: the server charges the highest of the items' delivery fees once (create_cart_order), so the cart does too.
    const feeLines = vItems.map((it) => ({ name: it.product.name, mode: String(it.product.delivery_fee_mode || "free").toLowerCase(), fee: Number(it.product.delivery_fee) || 0, perKm: Math.min(1000, Number(it.product.delivery_fee_per_km) || 0) }));
    const cartFlatFee = feeLines.reduce((n, l) => Math.max(n, l.mode === "flat" ? l.fee : 0), 0);
    const cartDistanceLine = feeLines.find((l) => l.mode === "distance" && l.perKm > 0);
    if (window.lvDrRegister) window.lvDrRegister(`cart-${v.id}`, vItems.map((it) => it.product), v);
    const deliveryHtml = deliveryFieldsHtml(`cart-${v.id}`, cartFlatFee, v.lat, v.lng, cartDistanceLine ? "distance" : "flat", cartDistanceLine ? cartDistanceLine.perKm : 0, "", subtotal)
      .replace(`id="cart-${v.id}DeliveryFields"`, `id="cart-${v.id}DeliveryFields" data-fee-lines="${JSON.stringify(feeLines).replace(/"/g, "&quot;")}"`);
    // The live item / delivery / total breakdown lives in its own Order summary card.
    const breakdownRe = new RegExp(`<div id="cart-${v.id}PriceBreakdown"[^>]*></div>`);
    const deliveryNoBreakdown = deliveryHtml.replace(breakdownRe, "");
    const itemCount = vItems.reduce((n, it) => n + it.quantity, 0);
    html += `<section class="cart-vendor-card ${ownCartVendor ? "own-cart-vendor" : ""}" data-cart-vendor="${esc(v.id)}">
      <a href="#" class="cart-vendor-head" onclick="navigate('storefront',{vendorId:'${v.id}'});return false;"><span class="cart-vh-ico cart-vh-pic">${(v.profile_avatar_url || v.logo_url) ? `<img src="${esc(v.profile_avatar_url || v.logo_url)}" alt="" data-lvimg onload="this.classList.add('lv-ld')" loading="eager" draggable="false" />` : avatarFallbackHtml(v.business_name || "Vendor", "100%", "", v.business_name || "Vendor", v.id)}</span><span class="cart-vh-txt"><b>${vendorNameWithFormerly(v)}</b><small>${vItems.length} item${vItems.length === 1 ? "" : "s"} from this store</small></span><span class="cart-vh-btn">View Store <i class="fa-solid fa-chevron-right"></i></span></a>
      ${ownCartVendor ? `<p class="error-text" style="margin:.5rem .9rem;"><i class="fa-solid fa-ban"></i> Your own products can't be purchased from your shop.</p>` : ""}
      <div class="cart-items">${vItems.map(cartItemRowHtml).join("")}</div>
    </section>
    <section class="cart-card cart-summary"><div class="cart-card-head"><h3><i class="fa-solid fa-receipt cart-ico-sum"></i> Order summary</h3><strong>${naira(subtotal)}</strong></div>
      <div class="cart-summary-row"><span>Subtotal (${itemCount} item${itemCount === 1 ? "" : "s"})</span><strong>${naira(subtotal)}</strong></div>
      <div id="cart-${v.id}PriceBreakdown" class="price-breakdown-table" aria-live="polite"></div></section>
    <section class="cart-card cart-delivery"><h3><i class="fa-solid fa-truck-fast cart-ico-del"></i> Delivery option</h3>${deliveryNoBreakdown}</section>
    <section class="cart-card cart-note"><label for="cartNote-${v.id}">Note for the vendor <span>(optional)</span></label>
      <textarea id="cartNote-${v.id}" rows="3" maxlength="200" placeholder="e.g. I'd like the blue one, or a size 42" oninput="this.nextElementSibling.textContent=this.value.length+'/200'"></textarea><small class="cart-note-count">0/200</small></section>
    ${ownCartVendor ? `<button class="btn btn-outline" style="width:100%;" disabled title="You can't purchase from your own shop"><i class="fa-solid fa-ban"></i> Checkout unavailable</button>` : `<button type="button" class="cart-checkout" onclick="checkoutCartVendor('${v.id}')"><i class="fa-solid fa-bag-shopping"></i><span class="cart-checkout-label">Checkout · ${esc(v.business_name)}</span><b id="cart-${v.id}CheckoutTotal">${naira(subtotal)}</b></button>`}
    <p id="cartError-${v.id}" class="error-text hidden"></p>`;
  });

  if (ownItems.length) {
    html += `<p class="muted" style="font-size:0.85rem;"><i class="fa-solid fa-ban"></i> ${ownItems.length} self-owned cart item${ownItems.length === 1 ? " was" : "s were"} removed because vendors can't purchase from their own shop.</p>`;
  }
  if (stale.length && stale.length !== ownItems.length) {
    window.__staleCartIds = stale.filter((it) => !ownItems.includes(it)).map((it) => it.id);
    html += `<p class="muted" style="font-size:0.85rem;"><i class="fa-solid fa-circle-info"></i> ${stale.length - ownItems.length} item${stale.length - ownItems.length === 1 ? "" : "s"} in your cart ${stale.length - ownItems.length === 1 ? "is" : "are"} no longer available and won't be included at checkout. <a href="#" onclick="clearStaleCartItems();return false;">Remove ${stale.length - ownItems.length === 1 ? "it" : "them"}</a>.</p>`;
  }
  return `<div class="cart-page">${cartHead([...byVendor.values()].reduce((n, g) => n + g.items.length, 0))}${html}</div>`;
}
function openClearCartSheet() {
  if (byId("clearCartSheet")) return;
  const wrap = document.createElement("div");
  wrap.id = "clearCartSheet";
  wrap.className = "cc-backdrop";
  wrap.innerHTML = `<div class="cc-sheet" role="dialog" aria-modal="true" aria-labelledby="ccTitle"><button type="button" class="cc-x" aria-label="Close" data-cc="close"><i class="fa-solid fa-xmark"></i></button>
    <span class="cc-ico"><i class="fa-solid fa-trash-can"></i></span><h3 id="ccTitle">Clear cart?</h3><p>This will remove all items from your cart. This action cannot be undone.</p>
    <div class="cc-actions"><button type="button" class="cc-cancel" data-cc="close">Cancel</button><button type="button" class="cc-confirm" data-cc="ok"><i class="fa-solid fa-trash-can"></i> Clear Cart</button></div></div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add("open"));
  const close = () => { wrap.classList.remove("open"); setTimeout(() => wrap.remove(), 180); };
  wrap.addEventListener("click", async (e) => {
    if (e.target === wrap || e.target.closest('[data-cc="close"]')) return close();
    const ok = e.target.closest('[data-cc="ok"]');
    if (!ok) return;
    ok.disabled = true;
    const { error } = await levroData.cart.clear(session.user.id);
    if (error) { ok.disabled = false; showToast(error.message || "Couldn't clear your cart.", "error"); return; }
    close();
    showToast("Cart cleared.", "success");
    // the red badge must drop to zero at once, not after the next refresh
    try { buyerCartCount = 0; window.__cartCountVal = 0; window.__cartCountAt = Date.now(); } catch (_) {}
    try { updateCartFab(); } catch (_) {}
    refreshNotifications();
    navigate("cart", {}, false);
  });
}
async function addToCart(productId, qty, variantId = null) {
  if (!session) { showLogin(); return; }
  if (blockOwnVendorPurchase(currentProductDetail?.vendor?.id, "buy")) return;
  const amount = Math.max(1, Number(qty) || 1);
  const chosenVariantId = variantId || byId("selectedProductVariantId")?.value || null;
  // Buyers are no longer blocked by a stock counter here -- see
  // create_sale_order's own comment for why. The vendor is better placed
  // than a raw number to say an order can't be fulfilled.
  const { error } = await levroData.cart.add(productId, amount, chosenVariantId);
  if (error) { showToast(error.message, "error"); return; }
  showToast("Added to cart.", "success");
  buyerCartCount += 1;
  updateCartFab();
  window.lmSyncCartCount && window.lmSyncCartCount();
  refreshNotifications();
  // Stay on the current page so customers can keep adding multiple items.
  updateCartFab();
}
// One-tap add straight from a product card's grid/rail listing, without
// opening the product page first -- same RPC as addToCart, just with a
// quick icon flip on the button itself as feedback instead of only a toast.
async function quickAddToCart(evt, productId, btn, vendorId = "") {
  evt.stopPropagation();
  if (evt.preventDefault) evt.preventDefault();
  if (!session) { showLogin(); return; }
  if (blockOwnVendorPurchase(vendorId, "buy")) return;
  if (btn.__lmBusy) return;
  btn.__lmBusy = true;
  try { btn.blur(); } catch (_) {}
  const original = btn.dataset.lmOrig || (btn.dataset.lmOrig = btn.innerHTML);
  // Optimistic: the tick and the header badge change on tap, not after the round trip.
  btn.innerHTML = `<i class="fa-solid fa-check"></i>`;
  btn.classList.add("added");
  buyerCartCount += 1;
  updateCartFab();
  const { error } = await levroData.cart.add(productId, 1, null);
  btn.__lmBusy = false;
  if (error) {
    buyerCartCount = Math.max(0, buyerCartCount - 1);
    updateCartFab();
    btn.innerHTML = original;
    btn.classList.remove("added");
    showToast(error.message, "error");
    return;
  }
  setTimeout(() => { btn.innerHTML = original; btn.classList.remove("added"); }, 900);
  window.lmSyncCartCount && window.lmSyncCartCount();
}
async function updateCartQty(cartItemId, newQty) {
  if (newQty < 1) return;
  const { error } = await levroData.cart.setQuantity(cartItemId, newQty);
  if (error) { showToast(error.message, "error"); return; }
  navigate("cart", {}, false);
  refreshNotifications();
}
async function removeFromCart(cartItemId) {
  const { error } = await levroData.cart.remove(cartItemId);
  if (error) { showToast(error.message, "error"); return; }
  navigate("cart", {}, false);
  refreshNotifications();
}
async function clearStaleCartItems() {
  const ids = window.__staleCartIds || [];
  if (!ids.length) return;
  await levroData.cart.removeMany(ids);
  navigate("cart", {}, false);
}
function openCheckoutAllSheet() {
  if (byId("checkoutAllSheet")) return;
  const n = (window.__cartByVendor && window.__cartByVendor.size) || 0;
  if (!n) { showToast("Your cart is empty.", "error"); return; }
  const wrap = document.createElement("div");
  wrap.id = "checkoutAllSheet";
  wrap.className = "cc-backdrop";
  wrap.innerHTML = `<div class="cc-sheet" role="dialog" aria-modal="true" aria-labelledby="coaTitle"><button type="button" class="cc-x" aria-label="Close" data-cc="close"><i class="fa-solid fa-xmark"></i></button>
    <span class="cc-ico coa-ico"><i class="fa-solid fa-bag-shopping"></i></span><h3 id="coaTitle">Checkout everything?</h3><p>This places ${n} order${n === 1 ? "" : "s"}, one per vendor in your cart. You'll see the full breakdown and total before anything is sent.</p>
    <div class="cc-actions"><button type="button" class="cc-cancel" data-cc="close">Cancel</button><button type="button" class="cc-confirm coa-ok" data-cc="ok"><i class="fa-solid fa-bag-shopping"></i> Checkout all</button></div></div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add("open"));
  const close = () => { wrap.classList.remove("open"); setTimeout(() => wrap.remove(), 180); };
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap || e.target.closest('[data-cc="close"]')) return close();
    if (e.target.closest('[data-cc="ok"]')) { close(); checkoutCartAll(); }
  });
}
async function checkoutCartAll() {
  const groups = [...(window.__cartByVendor || new Map()).entries()].filter(([id]) => !isOwnVendorId(id));
  if (!groups.length) { showToast("Your cart is empty.", "error"); return; }
  for (const [vid] of groups) { const closed = await lvShopClosedForOrders(vid); if (closed) { lvClosedOrderToast(closed); return; } }
  const plan = [];
  for (const [vendorId, group] of groups) {
    const errorEl = byId(`cartError-${vendorId}`);
    errorEl?.classList.add("hidden");
    const delivery = readDeliveryFields(`cart-${vendorId}`, errorEl);
    if (!delivery) {
      document.querySelector(`[data-cart-vendor="${vendorId}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      const msg = (errorEl?.textContent || "").trim();
      showToast(`${group.vendor.business_name}: ${msg || "Please complete your delivery details."}`, "error");
      return;
    }
    let itemsTotal = 0;
    const lines = group.items.map((it) => {
      const unit = Number(effectivePrice(it.variant && it.variant.sale_price != null ? it.variant : it.product) ?? 0);
      itemsTotal += unit * it.quantity;
      return `${it.quantity}× ${it.product.name}${it.variant?.name ? ` (${it.variant.name})` : ""} · ${naira(unit * it.quantity)}`;
    });
    const { fee, known } = computeDeliveryFeeForPrefix(`cart-${vendorId}`, delivery.method);
    plan.push({ vendorId, group, delivery, lines, itemsTotal, fee: known ? Number(fee) || 0 : 0, known });
  }
  const grand = plan.reduce((n, p) => n + p.itemsTotal + p.fee, 0);
  const anyUnknown = plan.some((p) => !p.known && p.delivery.method === "delivery");
  const confirmHtml = plan.map((p) => `<div style="margin:0 0 .7rem;"><strong>${esc(p.group.vendor.business_name)}</strong>` + orderSummaryConfirmHtml({ itemLines: p.lines, method: p.delivery.method, pickupLabel: "Pickup", deliveryFee: p.fee, feeKnown: p.known, itemTotal: p.itemsTotal }) + `</div>`).join("") +
    `<div style="display:flex;justify-content:space-between;font-weight:800;border-top:1px solid var(--border,#e5e7eb);padding-top:.6rem;"><span>Total (${plan.length} order${plan.length === 1 ? "" : "s"})</span><span>${naira(grand)}${anyUnknown ? "+" : ""}</span></div>`;
  if (!(await showConfirmDialog(confirmHtml, { title: "Confirm checkout of everything", okLabel: "Checkout all", html: true }))) return;
  let done = 0, lastId = null, failed = [];
  for (const p of plan) {
    try {
      const { data: orderId, error } = await sb.rpc("create_cart_order", {
        p_vendor_id: p.vendorId,
        p_items: p.group.items.map((it) => ({ product_id: it.product.id, quantity: it.quantity, variant_id: it.variant?.id || null })),
        p_delivery_method: p.delivery.method, p_delivery_address: p.delivery.address, p_delivery_phone: p.delivery.phone, ...(p.delivery.campusId ? { p_delivery_campus_id: p.delivery.campusId } : {}),
        p_buyer_note: byId(`cartNote-${p.vendorId}`)?.value.trim() || null,
        p_buyer_lat: buyerLocation?.lat ?? null, p_buyer_lng: buyerLocation?.lng ?? null,
      });
      if (error) throw error;
      await levroData.cart.removeMany(p.group.items.map((it) => it.id));
      await persistBuyerDeliveryLocation(orderId, p.delivery.method);
      done++; lastId = orderId;
    } catch (e) { failed.push(`${p.group.vendor.business_name}: ${e.message || "failed"}`); }
  }
  refreshNotifications();
  if (failed.length) showToast(`${done} placed. Couldn't place: ${failed.join("; ")}`, "error");
  if (done && !failed.length) { if (done > 1) showToast(`${done} orders placed`, "success"); lvGoToNewOrder(lastId); }
  else if (done) navigate("cart", {}, false);
}

async function checkoutCartVendor(vendorId) {
  vendorId = String(vendorId);
  if (blockOwnVendorPurchase(vendorId, "buy")) return;
  const group = window.__cartByVendor?.get(vendorId);
  const errorEl = byId(`cartError-${vendorId}`);
  if (!group) { showToast("Your cart has changed. Reopen the cart and try again.", "error"); return; }
  { const closed = await lvShopClosedForOrders(vendorId); if (closed) { lvClosedOrderToast(closed); return; } }
  try {
  errorEl?.classList.add("hidden");
  const delivery = readDeliveryFields(`cart-${vendorId}`, errorEl);
  if (!delivery) return;

  const items = group.items.map((it) => ({ product_id: it.product.id, quantity: it.quantity, variant_id: it.variant?.id || null }));
  // Same itemised breakdown the product page shows: each item, the delivery fee and the real total.
  let cartItemsTotal = 0;
  const cartLines = group.items.map((it) => {
    const unit = Number(effectivePrice(it.variant && it.variant.sale_price != null ? it.variant : it.product) ?? 0);
    cartItemsTotal += unit * it.quantity;
    return `${it.quantity}× ${it.product.name}${it.variant?.name ? ` (${it.variant.name})` : ""} · ${naira(unit * it.quantity)}`;
  });
  const { fee: cartFee, known: cartFeeKnown } = computeDeliveryFeeForPrefix(`cart-${vendorId}`, delivery.method);
  const confirmHtml = `<p style="margin:0 0 .6rem;">${esc(group.vendor.business_name)}</p>` + orderSummaryConfirmHtml({ itemLines: cartLines, method: delivery.method, pickupLabel: "Pickup", deliveryFee: cartFee, feeKnown: cartFeeKnown, itemTotal: cartItemsTotal });
  if (!(await showConfirmDialog(confirmHtml, { title: "Confirm checkout", okLabel: "Checkout", html: true }))) return;

  const { data: orderId, error } = await sb.rpc("create_cart_order", {
    p_vendor_id: vendorId,
    p_items: items,
    p_delivery_method: delivery.method,
    p_delivery_address: delivery.address,
    p_delivery_phone: delivery.phone,
    ...(delivery.campusId ? { p_delivery_campus_id: delivery.campusId } : {}),
    p_buyer_note: byId(`cartNote-${vendorId}`)?.value.trim() || null,
    p_buyer_lat: buyerLocation?.lat ?? null,
    p_buyer_lng: buyerLocation?.lng ?? null,
  });
  if (error) {
    if (errorEl) { errorEl.textContent = error.message; errorEl.classList.remove("hidden"); }
    return;
  }
  await levroData.cart.removeMany(group.items.map((it) => it.id));
  await persistBuyerDeliveryLocation(orderId, delivery.method);
  refreshNotifications();
  lvGoToNewOrder(orderId);
  } catch (err) {
    console.error("Cart checkout failed", err);
    if (errorEl) { errorEl.textContent = "Checkout couldn’t complete. Please try again."; errorEl.classList.remove("hidden"); }
    else showToast("Checkout couldn’t complete. Please try again.", "error");
  }
}

