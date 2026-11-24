/* ---- app-like motion: pages slide/fade in, and a re-render that changes nothing no longer wipes and redraws the screen ---- */
(function(){
  "use strict";
  var app=document.getElementById("app"); if(!app) return;
  var desc=Object.getOwnPropertyDescriptor(Element.prototype,"innerHTML"); if(!desc||!desc.set) return;
  var reduce=false; try{ reduce=window.matchMedia("(prefers-reduced-motion: reduce)").matches; }catch(_){}
  var TABS={home:1,vendors:1,search:1,notifications:1,vendorOrders:1,buyerOrders:1,buyerProfile:1,vendorDashboard:1,requestEquipment:1,vendorRequests:1,cart:1,wishlist:1,messages:1};
  var NAVPOS={home:0,vendors:1,vendorsMap:1,requestEquipment:2,vendorRequests:2,notifications:3,buyerOrders:4,vendorOrders:4};
  var last={html:null,gen:-1,view:null}, goingBack=false, animTimer=null;
  // Small pictures are shown at 50-170 px, but profile pictures and shop logos are stored as 800 px originals (about 40 million
  // pixels on Home alone, which is what makes scrolling and dragging heavy on a phone). Cards, rows and lists get right-sized copies;
  // the full photo is still used on the product page and the profile picture viewer. Every stored picture, small or full size,
  // comes through Cloudinary (scripts/004-levromart-thumbs.js).
  var FULLSIZE = { productDetail: 1, packageDetail: 1, orderDetail: 1, adminPanel: 1, adminPeople: 1 };
  window.lvSlimImgs = function (html, vw) {
    try {
      if (typeof lvThumb !== "function" || html.indexOf("<img") < 0) return html;
      return html.replace(/(<img\b[^>]*?\ssrc=")(https?:\/\/[^"]+)(")/g, function (m, a, u, z) {
        var raw = u.replace(/&amp;/g, "&");
        if (window.lvOriginalImg && window.lvOriginalImg(raw) !== raw) return m;
        var w = FULLSIZE[vw] ? 0 : u.indexOf("/avatars/") >= 0 ? 160 : u.indexOf("/vendor-logos/") >= 0 ? 240 : u.indexOf("/product-photos/") >= 0 ? 360 : 0;
        var t = lvThumb(raw, w);
        return t === u ? m : a + t.replace(/&/g, "&amp;") + z;
      });
    } catch (_) { return html; }
  };
  window.addEventListener("popstate",function(){ goingBack=true; });
  function gen(){ try{ return navigationGeneration; }catch(_){ return -1; } }
  function view(){ try{ return currentView; }catch(_){ return ""; } }
  function animate(el,frames,ms){
    var root=document.documentElement; root.classList.add("lv-anim"); clearTimeout(animTimer); animTimer=setTimeout(function(){root.classList.remove("lv-anim");},ms+60);
    try{ el.animate(frames,{duration:ms,easing:"cubic-bezier(.22,.8,.24,1)"}); }catch(_){}
  }
  // Parts of Home that are expensive to redraw (the banner carousel, the category row) are kept alive when the page is
  // swapped or revisited, as long as their content is unchanged. Redrawing them is what made them blink.
  function resumeCarousel(){
    try{
      var vp=document.getElementById("homePromotionalViewport"); if(!vp) return;
      if(homeCarouselTimer){ clearInterval(homeCarouselTimer); homeCarouselTimer=null; }
      if(vp.dataset.loop!=="1"||reduce) return;
      homeCarouselPause(HOME_CAROUSEL_INTERVAL_MS);
      homeCarouselTimer=setInterval(function(){
        if(!vp.isConnected){ clearInterval(homeCarouselTimer); homeCarouselTimer=null; return; }
        if(document.hidden||window.__lvDragging||Date.now()<homeCarouselResumeAt) return;
        var r=vp.getBoundingClientRect(); if(r.bottom<0||r.top>window.innerHeight) return;
        var step=homeCarouselStep(vp); if(!step) return;
        homeCarouselGoTo(vp,Math.round(vp.scrollLeft/step)+1);
      },HOME_CAROUSEL_INTERVAL_MS);
    }catch(_){}
  }
  window.lvResumeCarousel=resumeCarousel;
  var KEEP=[
    {sel:"#homePromotionalCarousel",
     sig:function(n){ return Array.prototype.map.call(n.querySelectorAll(".home-promotional-slide:not([data-clone]):not([data-wv])"),function(b){ var i=b.querySelector("img"); return (i?(i.getAttribute("src")||""):"")+"|"+(b.getAttribute("data-link-url")||"")+"|"+(b.getAttribute("aria-label")||""); }).join(";"); },
     scroll:function(n){ var v=n.querySelector("#homePromotionalViewport"); return v?v.scrollLeft:0; },
     after:function(n,sc){ var v=n.querySelector("#homePromotionalViewport"); requestAnimationFrame(function(){ if(v&&sc){ v.style.scrollSnapType="none"; v.scrollLeft=sc; requestAnimationFrame(function(){ v.style.scrollSnapType=""; }); } resumeCarousel(); }); }},
    {sel:".levro-home-cat-rail",
     sig:function(n){ return Array.prototype.map.call(n.children,function(c){ return (c.getAttribute("data-cat")||c.textContent.trim())+(c.classList.contains("active")?"*":""); }).join(","); },
     scroll:function(n){ return n.scrollLeft; },
     after:function(n,sc){ if(sc) requestAnimationFrame(function(){ n.scrollLeft=sc; }); }}
  ];
  var stash={};
  // Lists of cards (vendors, products) and chip rows are updated card by card: a card whose markup did not change keeps
  // its DOM node (so its image stays decoded and nothing blinks); only new or changed cards are swapped in.
  var inner=Object.getOwnPropertyDescriptor(Element.prototype,"innerHTML");
  function cardKey(c){
    if(!c||c.nodeType!==1) return "";
    var d=c.dataset||{}; if(d.vendorId) return "v:"+d.vendorId; if(d.productId) return "p:"+d.productId;
    var oc=c.getAttribute("onclick")||""; var m=/vendorId:\s*'([^']+)'/.exec(oc); if(m) return "v:"+m[1];
    return "";
  }
  function chipKey(c){ return c&&c.nodeType===1?(c.getAttribute("data-cat")||c.getAttribute("data-id")||c.getAttribute("data-value")||c.textContent.trim()):""; }
  var SMART=[{sel:"#vendorsGrid",key:cardKey},{sel:"#productGrid",key:cardKey},{sel:"#vendorCatChips",key:chipKey}];
  function installSmart(root){
    SMART.forEach(function(sm){
      var el=root.querySelector(sm.sel); if(!el||el.__lvSmart) return; el.__lvSmart=1;
      Array.prototype.forEach.call(el.children,function(c){ if(c.__lvRaw==null) c.__lvRaw=c.outerHTML; });
      Object.defineProperty(el,"innerHTML",{configurable:true,
        get:function(){ return inner.get.call(this); },
        set:function(v){
          var html=window.lvSlimImgs(String(v), view());
          if(el.__lvLast===html) return;
          el.__lvLast=html;
          var t=document.createElement("template"); t.innerHTML=html;
          var next=Array.prototype.slice.call(t.content.children), cur=Array.prototype.slice.call(el.children);
          var keyed=next.length&&cur.length&&next.every(function(n){return !!sm.key(n);})&&cur.every(function(c){return !!sm.key(c);});
          if(!keyed||t.content.childNodes.length!==next.length||el.childNodes.length!==cur.length){ inner.set.call(el,html); Array.prototype.forEach.call(el.children,function(c){ c.__lvRaw=c.outerHTML; }); return; }
          var byKey=new Map(); cur.forEach(function(c){ byKey.set(sm.key(c),c); });
          var out=next.map(function(n){
            var raw=n.outerHTML, old=byKey.get(sm.key(n));
            if(old&&old.__lvRaw===raw){ byKey.delete(sm.key(n)); return old; }
            n.__lvRaw=raw; return n;
          });
          // only touch the DOM where something actually differs
          var same=out.length===cur.length&&out.every(function(n,i){return n===cur[i];});
          if(!same){ el.replaceChildren.apply(el,out); }
        }
      });
    });
  }
  installSmart(document);
  Object.defineProperty(app,"innerHTML",{configurable:true,
    get:function(){ return desc.get.call(this); },
    set:function(v){
      var g=gen(), vw=view(), html=window.lvSlimImgs(String(v), vw); v=html;
      var sameNav=(g===last.gen&&vw===last.view);
      // the cached page and the freshly loaded page are identical: leave the screen exactly as it is. The same goes for a live refresh of the
      // page already open (new data arrived, or the live connection came back): nothing changed, so nothing moves.
      if((sameNav||(vw===last.view&&window.__lvNavPush===false&&!goingBack))&&html===last.html&&!window.__lvForceSlide) return;
      if(last.forced&&html===last.html&&vw==="search"){ last.forced=false; return; }
      var prevView=last.view, self=this;
      KEEP.forEach(function(k){ if(html.indexOf(k.sel.slice(1))<0) { delete stash[k.sel]; return; } var n=self.querySelector(k.sel); if(n) stash[k.sel]={node:n,sig:k.sig(n),scroll:k.scroll(n)}; });   // only read the old page (which forces it to be laid out) when the new one will reuse that part
      var liveBar=document.getElementById("lvCampusBar"); if(liveBar) window.__lvBarStash=liveBar;
      desc.set.call(this,v);
      KEEP.forEach(function(k){
        var st=stash[k.sel], nw=self.querySelector(k.sel);
        if(st&&nw&&nw!==st.node&&k.sig(nw)===st.sig){ nw.replaceWith(st.node); k.after(st.node,st.scroll); }
      });
      last={html:html,gen:g,view:vw};
      installSmart(this);
      if(reduce||!this.animate||window.__lvSwipeNav) return;
      if(window.__lvForceSlide){ window.__lvForceSlide=false; last.forced=true; animate(this,[{opacity:.2,transform:"translateX(32%)"},{opacity:1,transform:"none"}],230); goingBack=false; return; }
      // a refresh of the page already open (live data, same page, not a tap or a back move): the content just updates in place.
      // It used to fade or slide in again every time, which read as the page twitching and flying away and back.
      if(sameNav||(vw===prevView&&window.__lvNavPush===false&&!goingBack)) return;
      var chat=document.body&&document.body.classList.contains("chat-full-page");
      var tabSwitch=!!(TABS[prevView]&&TABS[vw]);
      if(chat) animate(this,[{opacity:0},{opacity:1}],180);
      else if(vw==="home"&&!goingBack&&tabSwitch) animate(this,[{opacity:.55},{opacity:1}],110);   // Home just appears: no slide, no wait
      else if(goingBack) animate(this,[{opacity:.2,transform:"translateX(-30%)"},{opacity:1,transform:"none"}],230);
      else if(tabSwitch&&NAVPOS[prevView]!=null&&NAVPOS[vw]!=null&&NAVPOS[prevView]!==NAVPOS[vw]){
        // the bottom bar: the page comes in from the side the tapped tab is on
        var dir=NAVPOS[vw]>NAVPOS[prevView]?1:-1;
        animate(this,[{opacity:.2,transform:"translateX("+(dir*30)+"%)"},{opacity:1,transform:"none"}],230);
      }
      else animate(this,[{opacity:.2,transform:"translateX(32%)"},{opacity:1,transform:"none"}],230);
      goingBack=false;
    }
  });
})();

/* Drag any bottom sheet down from anywhere on it (Levi, comments, share, pop-up cards), like WhatsApp and TikTok.
   The sheet follows the finger exactly (no jump when the drag starts), the page behind never scrolls, the dimmed backdrop
   fades as the sheet goes down, and on release it either glides away or settles back, depending on how far and how fast
   it was pulled. It only follows the finger when its own content is scrolled to the top, so normal scrolling is untouched. */
(function () {
  var SHEETS = [
    { sel: "#aiChatPanel:not(.hidden)", close: function () { try { toggleAiChat(); } catch (_) {} }, back: null,
      // Levi only follows a drag that starts on his top bar or on empty chat space: never on buttons, the chat list, the select toolbar or the box
      allow: function (t, sheet) {
        if (t.closest("button,a,input,textarea,select,label,.ai-chat-history-item,.ai-history-select-toolbar,.ai-chat-input-row,.levi-tools")) return false;
        // a row that scrolls sideways (Levi's product cards, shop lists) keeps the finger: the sheet never takes it
        for (var n = t; n && n !== sheet && n.nodeType === 1; n = n.parentNode) {
          if (n.scrollWidth > n.clientWidth + 4 && /(auto|scroll)/.test(getComputedStyle(n).overflowX)) return false;
        }
        if (sheet.classList.contains("history-mode") && !t.closest(".drawer-header")) return false;
        if (sheet.classList.contains("lv-full")) return false;
        if (document.querySelector(".lv-dlg,#confirmModal.open,.modal.open")) return false;
        return true;
      } },
    { sel: ".lv-cs-card", close: function (el) { var x = el.querySelector(".lv-cs-x"); if (x) x.click(); }, back: ".lv-cs-back", own: ".lv-cs-head" },
    { sel: ".lv-cm-card", close: function (el) { var b = el.parentNode && el.parentNode.querySelector(".lv-cm-back"); if (b) b.click(); }, back: ".lv-cm-back", own: ".lv-cm-card" },
    { sel: ".vendors-filters-panel:not(.hidden)", close: function () { try { toggleVendorsFilters(false); } catch (_) {} }, back: ".lv-sheet-back" },
    { sel: ".browse-filter-panel:not(.hidden)", close: function () { try { toggleBrowseFilters(false); } catch (_) {} }, back: ".lv-sheet-back" },
    { sel: "#messagesMoreMenu:not(.hidden)", close: function () { var m = document.getElementById("messagesMoreMenu"); if (m) m.classList.add("hidden"); }, back: ".lv-sheet-back" },
    { sel: ".order-filters-panel:not(.hidden)", close: function () { try { window.closeLevromartTransientFilters(); } catch (_) {} }, back: ".lv-sheet-back" },
    { sel: "#storefrontShareModal:not(.hidden) .storefront-share-sheet", close: function (el) { var m = el.closest("#storefrontShareModal"); if (m) m.dispatchEvent(new MouseEvent("click", { bubbles: false })); }, back: null }
  ];
  var START_SLOP = 8;          // px of movement before it counts as a drag
  var cur = null, raf = 0;
  function put(el, prop, val) { el.style.setProperty(prop, val, "important"); }   // beats the sheets' own !important transforms
  function clear(el) { el.style.removeProperty("transform"); el.style.removeProperty("transition"); el.style.removeProperty("will-change"); }
  function scrolledDown(target, sheet) {
    for (var n = target; n && n.nodeType === 1; n = n.parentNode) {
      if (n.scrollHeight > n.clientHeight + 2 && n.scrollTop > 0 && /(auto|scroll)/.test(getComputedStyle(n).overflowY)) return true;
      if (n === sheet) break;
    }
    return false;
  }
  function backdropOf(c) { return c.s.back ? (c.el.parentNode && c.el.parentNode.querySelector(c.s.back)) : null; }
  function paint() {
    raf = 0;
    if (!cur) return;
    put(cur.el, "transform", "translate3d(0," + cur.offset + "px,0)");
    if (cur.back) cur.back.style.opacity = String(Math.max(0, 1 - cur.offset / Math.max(1, cur.height)));
  }
  function velocity(c) {   // px per ms over the last ~100 ms
    var h = c.trail, last = h[h.length - 1], first = last;
    for (var i = h.length - 1; i >= 0 && last.t - h[i].t <= 100; i--) first = h[i];
    return last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0;
  }
  function settle(c, closing) {
    var el = c.el, back = c.back;
    var done = false;
    function finish() {
      if (done) return; done = true;
      if (closing) c.s.close(el);
      clear(el);
      if (back) back.style.removeProperty("opacity");
    }
    put(el, "transition", closing ? "transform .26s cubic-bezier(.3,.7,.4,1)" : "transform .34s cubic-bezier(.2,.9,.25,1.05)");
    put(el, "transform", closing ? "translate3d(0," + (c.height + 24) + "px,0)" : "translate3d(0,0,0)");
    if (back) { back.style.transition = "opacity .26s ease"; back.style.opacity = closing ? "0" : "1"; }
    el.addEventListener("transitionend", function te(e) { if (e.target !== el) return; el.removeEventListener("transitionend", te); finish(); });
    setTimeout(finish, 420);
  }
  function stopTheirs(e, c) { if (c && c.s.own && e.target.closest && e.target.closest(c.s.own)) e.stopPropagation(); }  // replaces the sheets' older, jumpier handlers

  document.addEventListener("touchstart", function (e) {
    cur = null;
    if (e.touches.length !== 1) return;
    var t = e.target;
    if (!t.closest) return;
    for (var i = 0; i < SHEETS.length; i++) {
      var sheet = t.closest(SHEETS[i].sel);
      if (!sheet) continue;
      if (SHEETS[i].allow && !SHEETS[i].allow(t, sheet)) return;
      var c = { s: SHEETS[i], el: sheet, y: e.touches[0].clientY, x: e.touches[0].clientX, on: false, offset: 0, height: sheet.getBoundingClientRect().height, trail: [], back: null };
      stopTheirs(e, c);
      if (t.closest("textarea,input,select,[contenteditable],.leaflet-container") || scrolledDown(t, sheet)) return;
      c.trail.push({ y: c.y, t: e.timeStamp });
      cur = c;
      return;
    }
  }, { passive: true, capture: true });

  document.addEventListener("touchmove", function (e) {
    if (!cur) return;
    stopTheirs(e, cur);
    var y = e.touches[0].clientY, dy = y - cur.y, dx = Math.abs(e.touches[0].clientX - cur.x);
    if (!cur.on) {
      if (dy > START_SLOP && dy > dx * 1.4) {
        cur.on = true;
        cur.back = backdropOf(cur);
        put(cur.el, "transition", "none");
        put(cur.el, "will-change", "transform");
        if (cur.back) cur.back.style.transition = "none";
      } else if (dy < -START_SLOP || dx > 14) { cur = null; return; }
      else return;
    }
    cur.offset = Math.max(0, dy - START_SLOP);     // the sheet starts moving from where the drag began, so there is no jump
    cur.trail.push({ y: y, t: e.timeStamp });
    if (cur.trail.length > 8) cur.trail.shift();
    if (e.cancelable) e.preventDefault();          // the page behind must not scroll while the sheet is being dragged
    if (!raf) raf = requestAnimationFrame(paint);
  }, { passive: false, capture: true });

  function end(e) {
    if (!cur) return;
    stopTheirs(e, cur);
    var c = cur; cur = null;
    if (!c.on) return;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    var v = velocity(c);
    settle(c, c.offset > c.height * 0.3 || (v > 0.55 && c.offset > 24));
  }
  document.addEventListener("touchend", end, { passive: true, capture: true });
  document.addEventListener("touchcancel", end, { passive: true, capture: true });
})();

/* ===== Pay now with Paystack (issue #96) =====
   Shown only when the backend says the Paystack switch is on; then Paystack is the only way to pay an order in the app.
   The amount always comes from the server; nothing is marked paid in the browser. */
(function () {
  "use strict";
  var origDirect = window.openVendorDirectPayment;
  var onCache = null, onAt = 0;
  function naira(n) { try { return "₦" + Number(n || 0).toLocaleString("en-NG", { maximumFractionDigits: 2 }); } catch (_) { return "₦" + n; } }
  function paystackOn() {
    if (onCache !== null && Date.now() - onAt < 60000) return Promise.resolve(onCache);
    if (!window.levroData || !window.levroData.payments) return Promise.resolve(false);
    return window.levroData.payments.config().then(function (r) { onCache = !!(r && r.data && r.data.paystackCheckout); onAt = Date.now(); window.__lvPaystackKnownOn = onCache; try { document.documentElement.setAttribute("data-lv-paystack", onCache ? "on" : "off"); } catch (_) {} return onCache; }, function () { return false; });
  }
  window.lvPaystackOn = paystackOn;
  function closeModal() { var m = document.getElementById("lvPayModal"); if (m) m.remove(); }
  function openModal(html, extra) {
    closeModal();
    var m = document.createElement("div");
    m.id = "lvPayModal"; m.className = "modal lv-pm open" + (extra ? " " + extra : "");
    m.innerHTML = '<div class="modal-content lv-pm-card" role="dialog" aria-modal="true" aria-labelledby="lvPmTitle">' + html + "</div>";
    m.addEventListener("click", function (e) { if (e.target === m) closeModal(); });
    document.body.appendChild(m);
    return m;
  }

  // "Pay" on an order: when Paystack checkout is on, it goes straight to the Paystack summary (no bank-transfer option).
  // When it is off, the original bank-transfer screen opens as before.
  window.openVendorDirectPayment = async function (orderId) {
    var args = arguments;
    if (!orderId || typeof session === "undefined" || !session) return origDirect.apply(this, args);
    // already known to be on (the app checks at start): open the choice at once, nothing is waited for
    var known = onCache !== null ? onCache : window.__lvPaystackKnownOn;
    var on = known === true ? true : await paystackOn();
    if (!on) return origDirect.apply(this, args);
    // pay with the Levromart wallet (no fee) or with Paystack
    if (window.lvW3ChoosePay) {
      // the order's total is looked up in the background; the sheet does not wait for it
      var totalP = Promise.resolve(sb.from("orders").select("total_amount").eq("id", orderId).maybeSingle()).catch(function () { return null; });
      return window.lvW3ChoosePay(orderId, null, function () { return startPaystack(orderId); }, totalP);
    }
    return startPaystack(orderId);
  };

  // Step 2: ask the server what to pay, show it, then continue to Paystack
  async function startPaystack(orderId) {
    openModal('<div class="lv-pm-head"><h3 id="lvPmTitle">Getting your payment ready…</h3></div><p class="muted" role="status" aria-live="polite">Please wait a moment.</p><p class="lv-safe-pill"><span class="lv-safe-ic">' + (window.lvShieldHtml ? window.lvShieldHtml(22) : "") + '</span> Secured by Paystack. Your money is safe.</p>');
    var r = await window.levroData.payments.initialize(orderId);
    if (r.error || !r.data) {
      openModal('<div class="lv-pm-head"><h3 id="lvPmTitle">We could not start the payment</h3></div><p class="lv-pm-err" role="alert">' + esc((r.error && r.error.message) || "Please try again.") + '</p>' + (r.error && (r.error.code || r.error.status) ? '<p class="muted" style="font-size:.72rem;margin:.25rem 0 0">Code: ' + esc([r.error.code, r.error.status].filter(Boolean).join(" ")) + '</p>' : '') + '<div class="lv-pm-actions"><button type="button" class="btn" onclick="document.getElementById(\'lvPayModal\')?.remove()">Close</button></div>');
      return;
    }
    var d = r.data;
    // what is being paid for: the shop, the items and the delivery, so the buyer sees exactly what the money covers
    var o = null;
    try { o = (await sb.from("orders").select("id,total_amount,delivery_fee,delivery_method,vendor:vendors(business_name,logo_url),items:order_items(quantity,unit_price,product:products(name,photos))").eq("id", orderId).maybeSingle()).data; } catch (_) {}
    var items = (o && o.items) || [], shop = (o && o.vendor) || {}, delivery = Number((o && o.delivery_fee) || 0);
    var itemsTotal = items.reduce(function (t, it) { return t + Number(it.unit_price || 0) * Number(it.quantity || 1); }, 0);
    var thumb = function (it) { var ph = it.product && Array.isArray(it.product.photos) ? it.product.photos[0] : ""; return ph ? '<img src="' + esc(typeof lvThumb === "function" ? lvThumb(ph, 120) : ph) + '" alt="">' : '<span class="lvp-ph"><i class="fa-solid fa-box"></i></span>'; };
    var shopPic = shop.logo_url ? '<img src="' + esc(typeof lvThumb === "function" ? lvThumb(shop.logo_url, 96) : shop.logo_url) + '" alt="">' : '<span>' + esc(String(shop.business_name || "S").trim().slice(0, 1).toUpperCase()) + "</span>";
    openModal(
      '<div class="lvp-grab" aria-hidden="true"></div>' +
      '<div class="lvp-top"><h3 class="lvp-title" id="lvPmTitle">Checkout</h3><button type="button" class="lvp-x" aria-label="Close" onclick="document.getElementById(\'lvPayModal\')?.remove()"><i class="fa-solid fa-xmark"></i></button></div>' +
      (shop.business_name ? '<div class="lvp-shop"><span class="lvp-shop-pic">' + shopPic + '</span><div><small>Paying</small><b>' + esc(shop.business_name) + '</b></div><span class="lvp-ref">#' + esc(String(orderId).slice(0, 8).toUpperCase()) + "</span></div>" : "") +
      (items.length ? '<ul class="lvp-items">' + items.slice(0, 4).map(function (it) { return "<li>" + thumb(it) + '<div><b>' + esc((it.product && it.product.name) || "Item") + "</b><small>Qty " + esc(String(it.quantity || 1)) + "</small></div><span>" + esc(naira(Number(it.unit_price || 0) * Number(it.quantity || 1))) + "</span></li>"; }).join("") + (items.length > 4 ? '<li class="lvp-more">+' + (items.length - 4) + " more</li>" : "") + "</ul>" : "") +
      '<ul class="lvp-rows">' +
        (items.length && Math.abs(itemsTotal + delivery - Number(d.orderAmountNaira)) < 0.01 ? "<li><span>Items</span><b>" + esc(naira(itemsTotal)) + "</b></li>" + (delivery ? "<li><span>Delivery</span><b>" + esc(naira(delivery)) + "</b></li>" : "") : "<li><span>Order amount</span><b>" + esc(naira(d.orderAmountNaira)) + "</b></li>") +
        "<li><span>Payment fee</span><b>" + esc(naira(d.feeNaira)) + "</b></li>" +
        '<li class="lvp-total"><span>Total</span><b>' + esc(naira(d.amountNaira)) + "</b></li>" +
      "</ul>" +
      '<p class="lvp-note"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i><span>Levromart holds your money safely. The shop is paid only after you confirm you have your order.</span></p>' +
      '<button type="button" class="lvp-pay" id="lvPmGo"><i class="fa-solid fa-lock" aria-hidden="true"></i> Pay ' + esc(naira(d.amountNaira)) + "</button>" +
      '<p class="lvp-foot">Secured by Paystack \u00b7 card, bank transfer or USSD</p>', "lvp"
    );
    var go = document.getElementById("lvPmGo");
    go.addEventListener("click", function () {
      if (go.disabled) return; go.disabled = true; go.textContent = "Opening secure checkout…";   // a second tap must not open a second payment
      openCheckout(orderId, d);
    });
  }

  function loadInline() {
    if (window.PaystackPop) return Promise.resolve(true);
    return new Promise(function (resolve) {
      var s = document.createElement("script");
      s.src = "https://js.paystack.co/v2/inline.js"; s.async = true;
      var t = setTimeout(function () { resolve(false); }, 4000);
      s.onload = function () { clearTimeout(t); resolve(!!window.PaystackPop); };
      s.onerror = function () { clearTimeout(t); resolve(false); };
      document.head.appendChild(s);
    });
  }
  async function openCheckout(orderId, d) {
    var popup = false;
    try {
      if (await loadInline()) {
        var pop = new window.PaystackPop();
        pop.resumeTransaction(d.accessCode, {
          onSuccess: function () { closeModal(); window.lvConfirmPaystack(d.reference, orderId); },
          onCancel: function () { closeModal(); showToast("Payment cancelled. Nothing was charged.", "info"); },
          onError: function () { closeModal(); showToast("Payment could not be completed. Please try again.", "error"); }
        });
        popup = true;
      }
    } catch (_) { popup = false; }
    if (!popup) { location.href = d.authorizationUrl; }   // popup blocked or unavailable: go to Paystack's page
  }

  // Ask the live server (the same one that settles commission payments) what Paystack says, and settle the order when it is paid.
  window.lvVerifyPayment = async function (reference) {
    try {
      var res = await fetch("/api/verify-payment?reference=" + encodeURIComponent(reference));
      var json = await res.json();
      window.__lvPayInfo = { status: json && json.status, settled: json && json.settled };
      return json && json.status;
    } catch (_) { return undefined; }
  };
  // Checks again and again (about two minutes): "paid", "failed", or "pending" when Paystack has not finished yet.
  window.lvWaitForPayment = async function (reference) {
    var waits = [0, 1200, 2000, 3000, 4000, 6000, 8000, 8000, 8000, 8000, 8000, 8000, 8000, 8000, 8000, 8000, 8000];
    for (var i = 0; i < waits.length; i++) {
      if (waits[i]) await new Promise(function (r) { setTimeout(r, waits[i]); });
      var st = await window.lvVerifyPayment(reference);
      if (st === "success") { try { window.levroData.payments.status(reference); } catch (_) {} return "paid"; }
      if (st === "failed") return "failed";
      try {   // second opinion from the newer backend (it may have settled it already through the webhook)
        var r = await window.levroData.payments.status(reference);
        if (r && r.data && window.levroData.payments.outcomeOf(r.data.status) === "paid") return "paid";
      } catch (_) {}
    }
    return "pending";
  };
  // After Paystack: "Confirming your payment…", then Paid or not completed. Used by the popup and the return link.
  window.lvConfirmPaystack = async function (reference, orderId) {
    openModal('<div class="lv-pm-head"><h3 id="lvPmTitle">Confirming your payment…</h3></div><p class="muted" role="status" aria-live="polite">This usually takes a few seconds. Please do not close the app.</p><div class="lv-pm-spin" aria-hidden="true"></div>');
    var outcome = await window.lvWaitForPayment(reference);
    closeModal();
    var info = window.__lvPayInfo || {};
    // "settled" = this check recorded it; "duplicate" = the webhook or the every-minute check had already recorded it
    if (outcome === "paid" && info.settled === "amount_mismatch") showToast("Paystack took a different amount from your order total, so our team is checking this payment. You do not need to pay again; we will update your order.", "info");
    else if (outcome === "paid" && info.settled && !/^(applied|already_paid|ok|settled|duplicate)/.test(String(info.settled))) showToast("Paystack confirmed your payment, but we could not update your order yet. Please screenshot this and send it to support. Code: " + String(info.settled).slice(0, 140), "error");
    else if (outcome === "paid") { showToast("Paid. Thank you!", "success"); try { window.__lvPaidPage = { kind: "order", title: "Payment successful", orderId: orderId, ref: reference, via: "Paystack (card, bank transfer or USSD)", amountKobo: Math.round(Number(info.amount_kobo || info.amount || 0)) || 0 }; } catch (_) {} }
    else if (outcome === "failed") showToast("Payment not completed. You were not charged. Please try again.", "error");
    else showToast("We could not confirm that payment yet" + (info.status ? " (Paystack says: " + String(info.status) + ")" : "") + ". It may still be processing; check your order in a minute.", "info");
    if (orderId) { try { await navigate("orderDetail", { orderId: orderId }); } catch (_) {} }
    if (window.__lvPaidPage) { var pg = window.__lvPaidPage; window.__lvPaidPage = null; try { window.lvTxPage(pg); } catch (_) {} }
  };

  // Order page: a short line saying the order was paid with Paystack (buyer and vendor wording)
  var origDetail = window.renderOrderDetail;
  if (typeof origDetail === "function") {
    window.renderOrderDetail = async function (orderId) {
      var html = await origDetail.apply(this, arguments);
      try {
        if (typeof html !== "string" || !orderId || typeof session === "undefined" || !session || !(await paystackOn())) return html;
        var q = await Promise.all([
          sb.from("payments").select("provider_reference,status").eq("order_id", orderId).eq("status", "paid").like("provider_reference", "lvm_ord_%").limit(1),
          sb.from("orders").select("buyer_id").eq("id", orderId).maybeSingle()
        ]);
        var paid = q[0] && q[0].data && q[0].data[0];
        if (!paid) {
          // A card or bank-transfer payment can reach Paystack a few minutes after the buyer left: when this order has a payment
          // waiting, ask the server to check it (the same check as the webhook) and reload the page once it is paid.
          try {
            var wait = await sb.from("payments").select("provider_reference").eq("order_id", orderId).eq("status", "pending").like("provider_reference", "lvm_ord_%").order("created_at", { ascending: false }).limit(1);
            var ref = wait && wait.data && wait.data[0] && wait.data[0].provider_reference;
            window.__lvPayChecked = window.__lvPayChecked || {};
            if (ref && Date.now() - (window.__lvPayChecked[ref] || 0) > 20000) {
              window.__lvPayChecked[ref] = Date.now();
              window.lvVerifyPayment(ref).then(function (st) {
                if (st === "success" && typeof currentView !== "undefined" && currentView === "orderDetail") {
                  showToast("Payment confirmed. Thank you!", "success");
                  navigate("orderDetail", { orderId: orderId }, false);
                }
              });
              window.levroData.payments.status(ref).then(function (r) {
                if (r && r.data && window.levroData.payments.outcomeOf(r.data.status) === "paid" && typeof currentView !== "undefined" && currentView === "orderDetail") {
                  showToast("Payment confirmed. Thank you!", "success");
                  navigate("orderDetail", { orderId: orderId }, false);
                }
              }, function () {});
            }
          } catch (_) {}
          if (ref) {
            var isBuyerNow = q[1] && q[1].data && String(q[1].data.buyer_id) === String(session.user.id);
            if (isBuyerNow) return '<div class="lv-pm-note" role="status"><i class="fa-solid fa-rotate"></i><span>Already paid with Paystack? </span><button type="button" class="btn btn-sm" onclick="lvConfirmPaystack(\'' + esc(ref) + '\', \'' + esc(orderId) + '\')">Check my payment</button></div>' + html;
          }
          return html;
        }
        var buyer = q[1] && q[1].data && String(q[1].data.buyer_id) === String(session.user.id);
        var line = buyer ? "Paid with Paystack. Levromart holds the money until you confirm delivery." : "Paid. The money is held by Levromart and sent to your bank after the buyer confirms.";
        return '<div class="lv-pm-note" role="status"><i class="fa-solid fa-shield-halved"></i><span>' + esc(line) + "</span></div>" + html;
      } catch (_) { return html; }
    };
  }
})();

/* ===== Verified payout account (issue #97) =====
   When Paystack checkout is on, the vendor sees the name on the bank account and confirms it is theirs before it is saved.
   The server looks the name up again and checks it matches; the full number is never sent back. */
(function () {
  "use strict";
  var origSave = window.saveVendorBankDetails;
  function fail(msg) { var e = document.getElementById("bankError"); if (e) { e.textContent = msg; e.classList.remove("hidden"); } }
  function confirmName(name, bank, last4) {
    return new Promise(function (resolve) {
      var m = document.createElement("div");
      m.id = "lvAcctModal"; m.className = "modal lv-pm open";
      m.innerHTML = '<div class="modal-content lv-pm-card" role="dialog" aria-modal="true" aria-labelledby="lvAcctTitle">' +
        '<div class="lv-pm-head"><h3 id="lvAcctTitle">Is this your account?</h3></div>' +
        '<p class="lv-pm-acct"><b>' + esc(name) + "</b><br><span class=\"muted\">" + esc(bank || "") + " · ···" + esc(last4 || "") + "</span></p>" +
        '<p class="muted">Your earnings will be sent here. Only confirm if this is your own account.</p>' +
        '<div class="lv-pm-actions"><button type="button" class="btn btn-outline" data-a="no">No, go back</button><button type="button" class="btn" data-a="yes">Yes, this is my account</button></div></div>';
      m.addEventListener("click", function (e) {
        var a = e.target && e.target.getAttribute && e.target.getAttribute("data-a");
        if (a || e.target === m) { m.remove(); resolve(a === "yes"); }
      });
      document.body.appendChild(m);
    });
  }
  window.saveVendorBankDetails = async function () {
    var on = window.lvPaystackOn ? await window.lvPaystackOn() : false;
    if (!on || !window.levroData || !window.levroData.payments.resolveAccount) return origSave.apply(this, arguments);
    var bankCode = String((document.getElementById("veBankCode") || {}).value || "").trim();
    var number = String((document.getElementById("veAccountNumber") || {}).value || "").trim();
    var err = document.getElementById("bankError"); if (err) err.classList.add("hidden");
    if (!/^\d{10}$/.test(number)) return fail("Enter a valid 10-digit account number.");
    if (!bankCode) return fail("Choose a bank.");
    var btn = document.getElementById("saveBankBtn");
    if (btn) { if (btn.disabled) return; btn.disabled = true; }
    try {
      var r = await window.levroData.payments.resolveAccount(bankCode, number);
      if (r.error || !r.data) return fail((r.error && r.error.message) || "We could not find that account. Check the bank and number.");
      if (!(await confirmName(r.data.accountName, r.data.bankName, r.data.accountLast4))) return;
      var s = await window.levroData.payments.savePayoutAccount(bankCode, number, r.data.accountName);
      if (s.error || !s.data) return fail((s.error && s.error.message) || "Could not save your account. Please try again.");
      if (typeof vendor !== "undefined" && vendor) {
        vendor.bank_code = bankCode;
        vendor.bank_name = r.data.bankName;
        vendor.account_number = number;
        vendor.account_name = r.data.accountName;
        vendor.payout_account_last4 = r.data.accountLast4;
        vendor.payout_verified_at = new Date().toISOString();
        vendor.transfer_recipient_code = vendor.transfer_recipient_code || "verified";
      }
      try {
        if (typeof session !== "undefined" && session?.user?.id) {
          sessionStorage.setItem("lv_payout_nudge_dismissed_" + session.user.id, "1");
        }
      } catch (_) {}
      window.__lvPayoutNudgeDismissed = true;
      document.getElementById("vendorPayoutNudgeModal")?.classList.add("hidden");
      showToast("Payout account verified: " + s.data.accountName, "success");
      await navigate("vendorEditProfile", {}, false);
    } catch (e) {
      fail("Something went wrong. Please try again.");
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  window.lvPayoutCardInit = async function () {
    try {
      if (!(window.lvPaystackOn && (await window.lvPaystackOn()))) return;
      var box = document.getElementById("payoutVerifiedBox");
      if (!box) return;
      var r = await window.levroData.payments.myPayoutAccount();
      var d = r && r.data;
      var legacy = document.getElementById("payoutLegacy"); if (legacy) legacy.classList.add("hidden");
      box.innerHTML = d && d.verified
        ? '<div class="ve-bank"><span class="ve-bank-ico" data-bank-code="' + esc((typeof vendor !== "undefined" && vendor && vendor.bank_code) || "") + '"><i class="fa-solid fa-building-columns"></i></span><div class="ve-bank-copy"><strong>' + esc(d.accountName || "") + '</strong><small>' + esc(d.bankName || "") + " ···" + esc(d.accountLast4 || "") + '</small></div><span class="ve-chip ok"><i class="fa-solid fa-circle-check"></i> Verified</span></div>'
        : '<div class="ve-bank ve-bank-empty"><span class="ve-bank-ico"><i class="fa-solid fa-triangle-exclamation"></i></span><div class="ve-bank-copy"><strong>Account not verified</strong><small>Add your bank below and confirm the name to be paid.</small></div></div>';
    } catch (_) {}
  };
})();

/* ===== Vendor payouts list on the Earnings page (issue #98) =====
   Each payout the vendor is owed, with where it is: waiting, on its way, sent, or on hold (and why). Shown only with Paystack on. */
(function () {
  "use strict";
  var orig = window.renderVendorEarnings;
  if (typeof orig !== "function") return;
  var LABEL = {
    pending: ["Waiting to be sent", "fa-clock", "pending"],
    processing: ["On its way to your bank", "fa-paper-plane", "info"],
    success: ["Sent to your bank", "fa-circle-check", "success"],
    on_hold: ["On hold", "fa-hand", "warning"],
    failed: ["Trying again", "fa-rotate", "warning"],
    reversed: ["Returned by the bank. We are sorting it out", "fa-rotate-left", "warning"],
    paid_manually: ["Paid to you by Levromart", "fa-circle-check", "success"]
  };
  function naira(n) { try { return "₦" + Number(n || 0).toLocaleString("en-NG", { maximumFractionDigits: 2 }); } catch (_) { return "₦" + n; } }
  window.renderVendorEarnings = async function () {
    var html = await orig.apply(this, arguments);
    if (typeof html !== "string" || html.indexOf("Access denied") >= 0) return html;
    setTimeout(window.lvLoadPayoutList, 0);
    return html + (window.lvSaleTiersHtml ? window.lvSaleTiersHtml() : "") + '<section class="lv-payouts" id="lvPayoutList" aria-live="polite"></section>';
  };
  window.lvLoadPayoutList = async function () {
    var box = document.getElementById("lvPayoutList");
    try {
      if (!box || !(window.lvPaystackOn && (await window.lvPaystackOn()))) return;
      var r = await window.levroData.payments.myPayouts();
      var rows = (r && r.data) || [];
      if (!rows.length) { box.innerHTML = ""; return; }
      box.innerHTML = '<h3 class="earn-h"><i class="fa-solid fa-money-bill-transfer"></i> Your payouts</h3>' + rows.map(function (p) {
        var l = LABEL[p.status] || [p.status, "fa-circle", "info"];
        var when = new Date(p.updatedAt || p.createdAt).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" });
        return '<button type="button" class="lv-payout-row" onclick="navigate(\'orderDetail\',{orderId:\'' + esc(p.orderId) + '\',source:\'sales\'})">' +
          '<span class="lv-payout-ico lv-payout-' + l[2] + '"><i class="fa-solid ' + l[1] + '"></i></span>' +
          '<span class="lv-payout-t"><b>' + naira(p.amount) + '</b><small>' + esc(l[0]) + (p.status === "on_hold" && p.holdReason ? " · " + esc(p.holdReason) : "") + '</small></span>' +
          '<span class="lv-payout-d">' + esc(when) + "</span></button>";
      }).join("");
    } catch (_) {}
  };
})();

/* ===== Commission "Pay now" through the Paystack ledger (issue #100) =====
   With Paystack on, the owed commission is paid through the new endpoint (same amount, same unlock afterwards).
   With it off, or if the new endpoint is not there, the old flow runs unchanged. */
(function () {
  "use strict";
  var orig = window.payCommission;
  if (typeof orig !== "function") return;
  window.payCommission = async function () {
    var on = window.lvPaystackOn ? await window.lvPaystackOn() : false;
    if (!on || !window.levroData || !window.levroData.payments.payCommission) return orig.apply(this, arguments);
    var errorEl = document.getElementById("commissionError");
    var buttons = Array.prototype.slice.call(document.querySelectorAll('[onclick*="payCommission()"]'));
    buttons.forEach(function (b) { b.disabled = true; });
    try {
      var r = await window.levroData.payments.payCommission();
      if (r.error || !r.data || !r.data.authorizationUrl) throw new Error((r.error && r.error.message) || "Could not start the commission payment.");
      window.location.assign(r.data.authorizationUrl);
    } catch (e) {
      if (errorEl) { errorEl.textContent = e.message; errorEl.classList.remove("hidden"); }
      else showToast(e.message || "Could not start the commission payment.", "error");
      buttons.forEach(function (b) { b.disabled = false; });
    }
  };
})();

/* ===== Admin: Payments area (issues #98, #99, #101) =====
   Money in and out, payouts (release / hold / paid by hand), refunds, and the daily Paystack check. Admin only: the server
   refuses everyone else, this screen is only the window onto it. */
(function () {
  "use strict";
  var tab = "payouts", range = "today", picked = false, reuse = false, shCache = null;
  function naira(n) { try { return "₦" + Number(n || 0).toLocaleString("en-NG", { maximumFractionDigits: 2 }); } catch (_) { return "₦" + n; } }
  function when(t) { try { return new Date(t).toLocaleString("en-NG", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch (_) { return ""; } }
  function api() { return window.levroData && window.levroData.adminPayments; }
  var STATUS = { pending: "Waiting", processing: "On its way", success: "Sent to shop", on_hold: "On hold", failed: "Failed", reversed: "Returned by bank", paid_manually: "Paid by hand", initialized: "Started", abandoned: "Abandoned", refunded: "Refunded", partially_refunded: "Part refunded", processed: "Done" };
  function pill(s) { var good = s === "success" || s === "processed" || s === "paid_manually"; var bad = s === "failed" || s === "reversed"; return '<span class="badge ' + (good ? "badge-success" : bad ? "badge-danger" : "badge-warning") + '">' + esc(STATUS[s] || s) + "</span>"; }

  function ask(title, label, withAmount, onOk) {
    var m = document.createElement("div");
    m.className = "modal lv-pm open lv-ap-sheet"; m.id = "lvAdminAsk";
    m.innerHTML = '<div class="modal-content lv-pm-card" role="dialog" aria-modal="true"><div class="lv-pm-head"><h3>' + esc(title) + "</h3></div>" +
      (withAmount ? '<label>Amount in naira (leave empty to refund everything left)</label><input id="lvAskAmount" inputmode="decimal" />' : "") +
      "<label>" + esc(label) + '</label><input id="lvAskText" maxlength="200" /><p class="lv-pay-err error-text hidden" id="lvAskErr"></p>' +
      '<div class="lv-pm-actions"><button type="button" class="btn btn-outline" data-a="no">Cancel</button><button type="button" class="btn" data-a="yes">Confirm</button></div></div>';
    m.addEventListener("click", async function (e) {
      var a = e.target && e.target.getAttribute && e.target.getAttribute("data-a");
      if (a === "no" || e.target === m) return m.remove();
      if (a !== "yes") return;
      var text = document.getElementById("lvAskText").value.trim();
      var amtEl = document.getElementById("lvAskAmount");
      var amount = amtEl && amtEl.value.trim() ? Number(amtEl.value) : undefined;
      if (text.length < 3) { var er = document.getElementById("lvAskErr"); er.textContent = "Please write a few words."; er.classList.remove("hidden"); return; }
      var res = await onOk(text, amount);
      if (res && res.error && /already been paid|done by hand/i.test(String(res.error.message || ""))) {
        if (m.__order) { noRefund[m.__order] = 1; try { localStorage.setItem("lv-no-refund", JSON.stringify(noRefund)); } catch (_) {} }
        m.remove(); showToast("This shop has already been paid for this order, so it cannot be refunded from here. Ask the shop to return the money.", "info"); reuse = true; navigate("adminPayments", {}, false); return;
      }
      if (res && res.error) { var er2 = document.getElementById("lvAskErr"); er2.textContent = res.error.message || "Something went wrong."; er2.classList.remove("hidden"); return; }
      m.remove(); showToast("Done.", "success"); navigate("adminPayments", {}, false);
    });
    document.body.appendChild(m);
  }
  var txByOrder = {}, refundedBy = {};   // what each order paid, and what has already been sent back
  // Refund: first see who is being refunded and what is left, then decide how much
  async function refundSheet(orderId) {
    var a = api(); if (!a) return;
    // opened from another page (the disputes page): look up what this order paid and what was already refunded
    if (!txByOrder[orderId]) {
      try {
        var look = await Promise.all([a.transactions({ limit: 200 }), a.refunds({ limit: 200 })]);
        ((look[0] && look[0].data) || []).forEach(function (x) { if (x.order_id) txByOrder[x.order_id] = x; });
        refundedBy = {}; ((look[1] && look[1].data) || []).forEach(function (r) { if (r.order_id && r.status !== "failed" && r.status !== "abandoned") refundedBy[r.order_id] = (refundedBy[r.order_id] || 0) + Number(r.amount || 0); });
      } catch (_) {}
    }
    var t = txByOrder[orderId] || {}, paid = Number(t.amount || 0), done = Number(refundedBy[orderId] || 0), left = Math.max(0, Math.round((paid - done) * 100) / 100), kept = 0;
    // the server knows exactly what was paid and what is left to give back (the shop's share: Levromart's 3% commission stays with Levromart)
    try {
      var inf = await sb.rpc("admin_order_refund_info", { p_order_id: orderId });
      if (inf && inf.data) { paid = Number(inf.data.paid_kobo) / 100; done = Number(inf.data.refunded_kobo) / 100; left = Number(inf.data.refundable_kobo) / 100; kept = Number(inf.data.commission_kobo) / 100; t = Object.assign({}, t, { paid_at: inf.data.paid_at || t.paid_at }); }
    } catch (_) {}
    var o = null, bu = null, ve = null;
    try {
      o = (await sb.from("orders").select("id,buyer_id,vendor_id,total_amount,status,created_at").eq("id", orderId).maybeSingle()).data;
      if (o && o.buyer_id) bu = (await sb.from("users").select("name,email,phone").eq("id", o.buyer_id).maybeSingle()).data;
      if (o && o.vendor_id) ve = (await sb.from("vendors").select("business_name").eq("id", o.vendor_id).maybeSingle()).data;
    } catch (_) {}
    var who = (bu && (bu.name || bu.email)) || "the buyer";
    var row = function (k, v) { return '<div class="rf-row"><span>' + k + "</span><b>" + v + "</b></div>"; };
    var m = document.createElement("div");
    m.className = "modal lv-pm open lv-ap-sheet"; m.id = "lvRefundSheet";
    m.innerHTML = '<div class="modal-content lv-pm-card" role="dialog" aria-modal="true"><div class="lv-pm-head"><h3>Refund this order</h3></div>' +
      '<div class="rf-card">' +
      row("Buyer", esc(who) + (bu && bu.name && (bu.email || bu.phone) ? "<small>" + esc([bu.email, bu.phone].filter(Boolean).join(" \u00b7 ")) + "</small>" : "")) +
      row("Shop", esc((ve && ve.business_name) || t.business_name || "Shop")) +
      row("Order", "#" + esc(String(orderId).slice(0, 8).toUpperCase()) + (o && o.status ? "<small>" + esc(String(o.status).replace(/_/g, " ")) + "</small>" : "")) +
      row("Paid", naira(paid) + "<small>" + esc(when(t.paid_at || t.created_at)) + "</small>") +
      (kept > 0 ? row("Levromart's commission", naira(kept) + "<small>not refunded</small>") : "") +
      (done > 0 ? row("Already refunded", naira(done)) : "") +
      row("You can refund up to", '<span class="rf-max">' + naira(left) + "</span>") +
      "</div>" +
      '<label>Amount to refund (\u20a6)</label><input id="lvRfAmount" inputmode="decimal" value="' + left + '" />' +
      '<label>Reason (the buyer will see this)</label><input id="lvRfReason" maxlength="200" placeholder="For example: item not delivered" />' +
      '<p class="rf-note"><i class="fa-solid fa-wallet"></i> If <b>' + esc(who) + "</b> has saved a refund bank account, the money goes into their Levromart refund wallet (Account &gt; Refunds wallet) and they withdraw it to that bank account. If not, it goes back to the card they paid with.</p>" +
      '<p class="lv-pay-err error-text hidden" id="lvRfErr"></p>' +
      '<div class="lv-pm-actions"><button type="button" class="btn btn-outline" data-a="no">Cancel</button><button type="button" class="btn" data-a="yes">Refund ' + naira(left) + "</button></div></div>";
    m.addEventListener("input", function (e) { if (e.target && e.target.id === "lvRfAmount") { var v = Number(e.target.value); var b = m.querySelector('[data-a="yes"]'); if (b) b.textContent = "Refund " + naira(v > 0 ? Math.min(v, left) : 0); } });
    m.addEventListener("click", async function (e) {
      var act = e.target && e.target.getAttribute && e.target.getAttribute("data-a");
      if (act === "no" || e.target === m) return m.remove();
      if (act !== "yes") return;
      var err = document.getElementById("lvRfErr"), show = function (t2) { err.textContent = t2; err.classList.remove("hidden"); };
      var amt = Number(String(document.getElementById("lvRfAmount").value).replace(/,/g, "")), why = document.getElementById("lvRfReason").value.trim();
      if (!(amt > 0)) return show("Enter the amount to refund.");
      if (amt > left + 0.001) return show("The most you can refund is " + naira(left) + ".");
      if (why.length < 3) return show("Please write a few words as the reason.");
      var btn = e.target; btn.disabled = true;
      var res = await a.refund(orderId, { amountNaira: amt >= left - 0.001 ? undefined : amt, reason: why });
      btn.disabled = false;
      if (res && res.error) {
        if (/already been paid|done by hand/i.test(String(res.error.message || ""))) { noRefund[orderId] = 1; try { localStorage.setItem("lv-no-refund", JSON.stringify(noRefund)); } catch (_) {} m.remove(); showToast("This shop has already been paid for this order, so it cannot be refunded from here. Ask the shop to return the money.", "info"); navigate("adminPayments", {}, false); return; }
        return show(res.error.message || "Something went wrong.");
      }
      m.remove(); showToast(naira(amt) + " refund sent for " + who + ". It shows in their refund wallet, or goes back to their card.", "success"); navigate(typeof currentView !== "undefined" && currentView === "adminDisputes" ? "adminDisputes" : "adminPayments", {}, false);
      try { window.lvTxPage({ kind: "refund", title: "Refund sent", amountKobo: Math.round(amt * 100), shop: who, note: why, orderId: orderId, status: "Refunded", via: "Taken from the shop's share" }); } catch (_) {}
    });
    document.body.appendChild(m);
  }
  window.lvPayAct = function (kind, id) {
    var a = api(); if (!a) return;
    if (kind === "release") {
      showConfirmDialog("Send this payout again now?", { title: "Release payout", okLabel: "Release" }).then(async function (yes) {
        if (!yes) return;
        var r = await a.release(id);
        if (r.error) return showToast(r.error.message, "error");
        showToast("Queued. It is sent within a minute.", "success"); navigate("adminPayments", {}, false);
      });
    } else if (kind === "hold") ask("Hold payout", "Why are you holding it?", false, function (t) { return a.hold(id, t); });
    else if (kind === "manual") ask("Mark as paid by hand", "How did you pay (reference)?", false, function (t) { return a.markManual(id, t); });
    else if (kind === "refund") refundSheet(id);
    else if (kind === "retryWaiting") {
      showConfirmDialog("Have you topped up the Paystack balance? The waiting payouts will be sent within a minute. If the balance is still too low, they wait again.", { title: "Send waiting payouts now", okLabel: "Send now" }).then(async function (yes) {
        if (!yes) return;
        var r = await a.retryWaiting();
        if (r.error) return showToast(r.error.message, "error");
        var n = (r.data && r.data.queued) || 0;
        showToast(n ? n + " payout" + (n === 1 ? " is" : "s are") + " being sent now." : "They are already being tried. Check again in a minute.", "success");
        setTimeout(function () { navigate("adminPayments", {}, false); }, 1500);
      });
    }
  };
  window.lvPayTab = function (t) { tab = t; picked = true; reuse = true; navigate("adminPayments", {}, false); };
  window.lvWithdrawDecide = function (id, how, hasDispute) {
    if (how === "reject") return ask("Reject withdrawal", "Reason (the shop will see this)", false, function (t) { return sb.rpc("admin_decide_withdrawal", { p_request_id: id, p_decision: "reject", p_reason: t }); });
    showConfirmDialog(hasDispute ? "This shop has a disputed order. Only the money of orders without a dispute will be sent. Approve?" : "Approve this withdrawal? The money is sent to the shop's bank within a minute.", { title: "Approve withdrawal", okLabel: "Approve" }).then(async function (yes) {
      if (!yes) return;
      var r = await sb.rpc("admin_decide_withdrawal", { p_request_id: id, p_decision: "approve" });
      if (r.error) return showToast(r.error.message, "error");
      showToast("Approved. It is sent within a minute.", "success"); navigate("adminPayments", {}, false);
    });
  };
  window.lvCancelDecide = function (id, how) {
    if (how === "reject") return ask("Reject cancellation", "Reason (the shop will see this)", false, function (t) { return sb.rpc("admin_decide_cancellation", { p_request_id: id, p_decision: "reject", p_reason: t }); });
    showConfirmDialog("Cancel this paid order and refund the buyer (the Paystack fee is not refunded)?", { title: "Approve cancellation", okLabel: "Cancel the order", cancelLabel: "Go back", danger: true }).then(async function (yes) {
      if (!yes) return;
      var r = await sb.rpc("admin_decide_cancellation", { p_request_id: id, p_decision: "approve" });
      if (r.error) return showToast(r.error.message, "error");
      showToast("Order cancelled. The refund is queued.", "success"); navigate("adminPayments", {}, false);
    });
  };
  function cancelRow(c) {
    var open = c.status === "requested";
    var acts = open ? '<button class="btn btn-sm btn-danger" onclick="lvCancelDecide(\'' + esc(c.id) + '\',\'approve\')">Cancel &amp; refund</button><button class="btn btn-sm btn-outline" onclick="lvCancelDecide(\'' + esc(c.id) + '\',\'reject\')">Reject</button>' : "";
    return '<div class="lv-ap-row"><div class="lv-ap-main"><b>' + naira(Number(c.total_amount || 0)) + "</b> " + '<span class="badge ' + (c.status === "approved" ? "badge-success" : c.status === "rejected" ? "badge-danger" : "badge-warning") + '">' + esc({ requested: "Waiting", approved: "Cancelled", rejected: "Rejected" }[c.status] || c.status) + "</span>" +
      "<small>" + esc(c.business_name || "") + " · " + when(c.created_at) + " · Reason: " + esc(c.reason || "") + (c.status === "rejected" && c.reject_reason ? " · Rejected: " + esc(c.reject_reason) : "") + '</small><a class="lv-ap-link" onclick="navigate(\'orderDetail\',{orderId:\'' + esc(c.order_id) + '\'})">Open order</a></div><div class="lv-ap-acts">' + acts + "</div></div>";
  }
  function withdrawalRow(w) {
    var open = w.status === "requested", rej = w.status === "rejected";
    var disp = Number(w.disputes) > 0;
    var chip = disp ? '<span class="badge badge-danger lv-ap-dispute" title="Open dispute on this shop"><i class="fa-solid fa-triangle-exclamation"></i> Disputed order' + (w.disputes > 1 ? " ×" + w.disputes : "") + "</span> " : "";
    var chg = w.account_changed_at ? '<span class="badge badge-warning lv-ap-acct" title="Bank account changed at ' + esc(when(w.account_changed_at)) + '"><i class="fa-solid fa-building-columns"></i> Account changed ' + esc(when(w.account_changed_at)) + " · check with the shop first</span> " : "";
    var links = disp ? (w.dispute_orders || []).map(function (o) { return '<a class="lv-ap-link" onclick="navigate(\'orderDetail\',{orderId:\'' + esc(o) + '\'})">Open disputed order</a>'; }).join(" ") : "";
    var acts = open ? '<button class="btn btn-sm" onclick="lvWithdrawDecide(\'' + esc(w.id) + '\',\'approve\',' + (disp ? "true" : "false") + ')">Approve</button><button class="btn btn-sm btn-outline" onclick="lvWithdrawDecide(\'' + esc(w.id) + '\',\'reject\')">Reject</button>' : "";
    var age = w.shop_since ? Math.max(1, Math.floor((Date.now() - new Date(w.shop_since).getTime()) / 86400000)) : null;
    (window.__lvPayReg = window.__lvPayReg || {})["wd:" + w.id] = w;
    return '<div class="lv-ap-row lv-tap" data-lvd="wd:' + esc(w.id) + '"><div class="lv-ap-main"><b>' + naira(Number(w.amount_kobo) / 100) + "</b> " + chip + '<span class="badge ' + (w.status === "approved" ? "badge-success" : rej ? "badge-danger" : "badge-warning") + '">' + esc({ requested: "Waiting", approved: w.kind === "instant" ? "Sent at once" : "Approved", rejected: "Rejected" }[w.status] || w.status) + "</span> " + chg +
      "<small>" + esc(w.business_name || "") + " · " + when(w.created_at) + (age ? " · shop " + age + " day" + (age === 1 ? "" : "s") + " old" : "") + (w.bank_name ? " · " + esc(w.bank_name) + (w.account_name ? " (" + esc(w.account_name) + ")" : "") : "") + (rej && w.reject_reason ? " · Reason: " + esc(w.reject_reason) : "") + (w.request_reason ? " · Shop says: " + esc(w.request_reason) : "") + "</small>" + links + '</div><div class="lv-ap-acts">' + acts + "</div></div>";
  }
  window.lvPayRange = function (r) { range = r; reuse = true; navigate("adminPayments", {}, false); };

  function payoutRow(p) {
    var acts = "";
    if (["on_hold", "failed", "reversed"].indexOf(p.status) >= 0) acts += '<button class="btn btn-sm" onclick="lvPayAct(\'release\',\'' + esc(p.id) + '\')">Release</button>';
    if (p.status === "pending" || p.status === "failed") acts += '<button class="btn btn-sm btn-outline" onclick="lvPayAct(\'hold\',\'' + esc(p.id) + '\')">Hold</button>';
    // payouts are sent by Paystack on their own; "paid by hand" is only for a payout that failed or came back
    if (["failed", "reversed"].indexOf(p.status) >= 0) acts += '<button class="btn btn-sm btn-outline" onclick="lvPayAct(\'manual\',\'' + esc(p.id) + '\')">Paid outside Levromart</button>';
    var onBalance = p.status === "pending" && p.last_error === "Paystack balance too low";
    var pst = p.status === "success" || p.status === "paid_manually" ? "in" : p.status === "failed" || p.status === "reversed" ? "bad" : "wait";
    var pic = pst === "in" ? "fa-arrow-up-right-from-square" : pst === "bad" ? "fa-triangle-exclamation" : p.status === "on_hold" ? "fa-pause" : "fa-hourglass-half";
    (window.__lvPayReg = window.__lvPayReg || {})["payout:" + p.id] = p;
    return '<div class="lv-ap-row ap2-row lv-tap" data-lvd="payout:' + esc(p.id) + '"><span class="ap2-ico ' + pst + '"><i class="fa-solid ' + pic + '"></i></span><div class="lv-ap-main"><b>' + naira(p.amount) + "</b> " + (onBalance ? '<span class="badge badge-danger">Waiting for Paystack balance</span>' : pill(p.status)) + "<small>" + esc(p.business_name || "") + " · " + when(p.created_at) + (p.hold_reason ? " · " + esc(p.hold_reason) : "") + (p.last_error && !onBalance ? " · " + esc(p.last_error) : "") + '</small><a class="lv-ap-link" onclick="navigate(\'orderDetail\',{orderId:\'' + esc(p.order_id) + '\'})">Open order</a></div><div class="lv-ap-acts">' + acts + "</div></div>";
  }
  var paidOut = {};   // orders whose shop has already been paid: they cannot be refunded from here
  function txRow(t) {
    var okStatus = t.status === "success" || t.status === "partially_refunded";
    var shopPaid = !!(t.order_id && (paidOut[t.order_id] || noRefund[t.order_id]));
    var back = Number(refundedBy[t.order_id] || 0), full = back > 0 && Number(t.amount || 0) - back <= 0.009;
    var can = t.order_id && okStatus && !shopPaid && !full;
    var what = String(t.purpose || "order payment").replace(/_/g, " ");
    var good = t.status === "success", bad = t.status === "failed";
    var ic = good ? "fa-arrow-down" : bad ? "fa-xmark" : t.status === "refunded" || t.status === "partially_refunded" ? "fa-rotate-left" : "fa-hourglass-half";
    var tail = can ? '<button class="btn btn-sm btn-outline" onclick="lvPayAct(\'refund\',\'' + esc(t.order_id) + '\')">Refund</button>' : (full ? '<span class="ap2-tag ap2-tag-ref"><i class="fa-solid fa-rotate-left"></i> Fully refunded</span>' : okStatus && shopPaid ? '<span class="ap2-tag"><i class="fa-solid fa-circle-check"></i> Shop paid</span>' : "");
    if (can && back > 0) tail = '<span class="ap2-tag ap2-tag-ref"><i class="fa-solid fa-rotate-left"></i> ' + naira(back) + ' back</span>' + tail;
    (window.__lvPayReg = window.__lvPayReg || {})["tx:" + t.id] = t;
    return '<div class="lv-ap-row ap2-row lv-tap" data-lvd="tx:' + esc(t.id) + '"><span class="ap2-ico ' + (good ? "in" : bad ? "bad" : "wait") + '"><i class="fa-solid ' + ic + '"></i></span><div class="lv-ap-main"><b>' + naira(t.amount) + "</b> " + payPill(t.status) + "<small>" + esc(what) + (t.business_name ? " \u00b7 " + esc(t.business_name) : "") + " \u00b7 " + when(t.paid_at || t.created_at) + '</small></div><div class="lv-ap-acts">' + tail + "</div></div>";
  }


  function refundRow(r) { (window.__lvPayReg = window.__lvPayReg || {})["refund:" + r.id] = r; return '<div class="lv-ap-row ap2-row lv-tap" data-lvd="refund:' + esc(r.id) + '"><span class="ap2-ico wait"><i class="fa-solid fa-rotate-left"></i></span><div class="lv-ap-main"><b>' + naira(r.amount) + "</b> " + pill(r.status) + "<small>Refund for order #" + esc(String(r.order_id || "").slice(0, 8).toUpperCase()) + " \u00b7 " + when(r.created_at) + (r.reason ? " \u00b7 " + esc(r.reason) : "") + (r.last_error ? " \u00b7 " + esc(r.last_error) : "") + '</small><a class="lv-ap-link" onclick="navigate(\'orderDetail\',{orderId:\'' + esc(r.order_id) + '\'})">Open order</a></div></div>'; }
  function reportRow(r) {
    var rep = r.report || {}; var list = (rep.problems || []).map(function (p) { return "<li>" + esc(p.detail) + "</li>"; }).join("");
    return '<div class="lv-ap-row lv-ap-col"><div class="lv-ap-main"><b>' + esc(String(r.window_start).slice(0, 10)) + "</b> " + (r.problems ? '<span class="badge badge-danger">' + r.problems + " to check</span>" : '<span class="badge badge-success">All matched</span>') + "<small>" + (rep.error ? esc(rep.error) : (rep.checked || 0) + " payments checked") + "</small></div>" + (list ? "<ul class=\"lv-ap-list\">" + list + "</ul>" : "") + "</div>";
  }

  // ===== The Payments page: four plain tabs, each with a sentence saying what it is for =====
  var TABS = [["todo", "Needs you"], ["payouts", "Shop payouts"], ["payments", "Buyer payments"], ["checks", "Daily check"]];
  var HELP = {
    todo: "Shops asking for something. Approve or reject each one; once you decide it leaves this list.",
    payouts: "Money Levromart sends to shops after a sale. It goes out by itself; you only step in when a payout is stuck.",
    payments: "Money buyers paid through Levromart, and refunds sent back to them.",
    checks: "Every day Levromart compares its own records with Paystack's. \u201cAll matched\u201d means there is nothing for you to do."
  };
  var chipOf = { payouts: "all", payments: "paid" }, noRefund = {};
  try { noRefund = JSON.parse(localStorage.getItem("lv-no-refund") || "{}") || {}; } catch (_) {}
  window.lvPayChip = function (c) { chipOf[tab] = c; reuse = true; navigate("adminPayments", {}, false); };
  function chipsHtml(list, cur) { return '<div class="ap2-chips">' + list.map(function (x) { return '<button type="button" class="' + (x[0] === cur ? "on" : "") + '" onclick="lvPayChip(\'' + x[0] + '\')">' + esc(x[1]) + (x[2] ? "<i>" + x[2] + "</i>" : "") + "</button>"; }).join("") + "</div>"; }
  var PAY_WORDS = { success: "Paid", initialized: "Started", abandoned: "Not completed", failed: "Failed", refunded: "Refunded", partially_refunded: "Part refunded", pending: "Waiting", processing: "On its way" };
  function payPill(s) { var good = s === "success"; var bad = s === "failed"; return '<span class="badge ' + (good ? "badge-success" : bad ? "badge-danger" : "badge-warning") + '">' + esc(PAY_WORDS[s] || s) + "</span>"; }
  function section(title, rows, empty) { return '<h4 class="ap2-h">' + esc(title) + "</h4>" + (rows.length ? rows.join("") : '<p class="ap2-empty">' + esc(empty) + "</p>"); }

  window.renderAdminPayments = async function () {
    var a = api();
    var nav = typeof adminNavHtml === "function" ? adminNavHtml("adminPayments") : "";
    if (!a) return nav + '<div class="empty-state">Payments are not available right now.</div>';
    // The four overview requests run together, and switching tab or range reuses them (for 30 seconds) so only the list itself is fetched
    var base = (reuse && shCache && Date.now() - shCache.at < 30000) ? shCache : null; reuse = false;
    if (!base) {
      var got = await Promise.all([a.summary(), sb.rpc("admin_list_withdrawals", { p_status: null }), sb.rpc("get_setup_status"), sb.rpc("admin_list_cancellations", { p_status: null })]);
      base = { at: Date.now(), sum: got[0], wd: got[1], su: got[2], cr: got[3] };
      if (!got[0].error) shCache = base;
    }
    var sum = base.sum, wd = base.wd, su = base.su, cr = base.cr;
    if (sum.error) return nav + '<div class="empty-state">' + esc(sum.error.message || "Only admins can see payments.") + "</div>";
    var s = sum.data, h = s.health, t = s[range];
    var wdRows = (wd && wd.data) || [], crRows = (cr && cr.data) || [];
    var wdOpen = wdRows.filter(function (x) { return x.status === "requested"; }), crOpen = crRows.filter(function (x) { return x.status === "requested"; });
    var pending = wdOpen.length + crOpen.length;
    var missing = (su && su.data && su.data.missing) || [];
    if (window.lvPayPaint) window.lvPayPaint(pending);
    if (["withdrawals", "cancellations"].indexOf(tab) >= 0) tab = "todo";
    if (["held", "failed"].indexOf(tab) >= 0) tab = "payouts";
    if (["refunds"].indexOf(tab) >= 0) tab = "payments";
    if (!picked && pending) tab = "todo";
    var body = "";
    if (tab === "todo") {
      var decided = wdRows.concat(crRows).filter(function (x) { return x.status !== "requested"; }).sort(function (x, y) { return String(y.created_at).localeCompare(String(x.created_at)); }).slice(0, 8);
      body = section("Withdrawal requests (" + wdOpen.length + ")", wdOpen.map(withdrawalRow), "No withdrawal is waiting for you.") +
        section("Cancel requests (" + crOpen.length + ")", crOpen.map(cancelRow), "No cancel request is waiting for you.") +
        (decided.length ? '<details class="ap2-more"><summary>Recently decided (' + decided.length + ")</summary>" + decided.map(function (x) { return x.reason !== undefined && x.total_amount !== undefined ? cancelRow(x) : withdrawalRow(x); }).join("") + "</details>" : "");
    } else if (tab === "payouts") {
      var c1 = chipOf.payouts || "all", prow = await a.payouts({ limit: 80 });
      var pl = ((prow && prow.data) || []).filter(function (p) { return Number(p.amount) > 0; });   // a payout of nothing is not worth a line
      var f1 = { all: pl, waiting: pl.filter(function (p) { return p.status === "pending" || p.status === "processing"; }), hold: pl.filter(function (p) { return p.status === "on_hold"; }), failed: pl.filter(function (p) { return p.status === "failed" || p.status === "reversed"; }), sent: pl.filter(function (p) { return p.status === "success" || p.status === "paid_manually"; }) };
      body = chipsHtml([["all", "All"], ["waiting", "Waiting", f1.waiting.length || ""], ["hold", "On hold", f1.hold.length || ""], ["failed", "Failed", f1.failed.length || ""], ["sent", "Sent"]], c1) +
        '<div class="lv-ap-list-wrap">' + (f1[c1].length ? f1[c1].map(payoutRow).join("") : '<p class="ap2-empty">Nothing here.</p>') + "</div>";
    } else if (tab === "payments") {
      var c2 = chipOf.payments || "paid";
      var rs = await Promise.all([a.transactions({ limit: 80 }), a.refunds({ limit: 100 }), a.payouts({ limit: 100, status: "success" }), a.payouts({ limit: 100, status: "processing" })]);
      refundedBy = {}; ((rs[1] && rs[1].data) || []).forEach(function (r) { if (r.order_id && r.status !== "failed" && r.status !== "abandoned") refundedBy[r.order_id] = (refundedBy[r.order_id] || 0) + Number(r.amount || 0); });
      paidOut = {}; [rs[2], rs[3]].forEach(function (r) { ((r && r.data) || []).forEach(function (p) { if (p.order_id) paidOut[p.order_id] = 1; }); });
      var tl = (rs[0] && rs[0].data) || [];
      var f2 = { paid: tl.filter(function (x) { return x.status === "success" || x.status === "partially_refunded" || x.status === "refunded"; }), open: tl.filter(function (x) { return x.status === "abandoned" || x.status === "initialized" || x.status === "failed"; }) };
      (rs[0] && rs[0].data || []).forEach(function (x) { if (x.order_id) txByOrder[x.order_id] = x; });
      var rowsHtml = c2 === "refunds" ? (((rs[1] && rs[1].data) || []).map(refundRow)) : (f2[c2] || []).map(txRow);
      body = chipsHtml([["paid", "Paid"], ["refunds", "Refunds sent"], ["open", "Not completed"]], c2) + '<div class="lv-ap-list-wrap">' + (rowsHtml.length ? rowsHtml.join("") : '<p class="ap2-empty">Nothing here.</p>') + "</div>";
    } else {
      var rr = await a.reports();
      body = '<div class="lv-ap-list-wrap">' + (((rr && rr.data) || []).map(reportRow).join("") || '<p class="ap2-empty">No daily check has run yet.</p>') + "</div>";
    }
    var tiles = [["Paid in by buyers", t.collected, "fa-arrow-down"], ["Refunded to buyers", t.refunded, "fa-rotate-left"], ["Paid out to shops", t.paidToVendors, "fa-arrow-up-right-from-square"], ["Levromart's commission", t.commission, "fa-percent"]];
    var stuckOnBalance = Number(h.waiting_on_balance || 0);
    var status = pending ? '<span class="ap-need"><b>' + pending + "</b> waiting for you</span>" : h.needsAttention ? '<span class="ap-need"><b>' + h.needsAttention + "</b> to check</span>" : '<span class="ap-ok"><i class="fa-solid fa-circle-check"></i> All clear</span>';
    var counts = { todo: pending, payouts: 0, payments: 0, checks: Number(h.needsAttention || 0) > stuckOnBalance ? 1 : 0 };
    return nav + '<div class="ap-head"><h2>Payments</h2>' + status + "</div>" +
      (stuckOnBalance ? '<div class="ap-note ap-warn ap-bal-warn" role="alert"><i class="fa-solid fa-triangle-exclamation"></i> <span><b>' + stuckOnBalance + " shop payout" + (stuckOnBalance === 1 ? "" : "s") + " (" + naira(h.waitingOnBalance) + ") cannot be sent yet:</b> the Paystack balance is too low. Top it up and tap Send waiting payouts.</span> " + '<button class="btn btn-sm" onclick="lvPayAct(\'retryWaiting\')">Send waiting payouts</button></div>' : (h.paystackBalance == null ? "" : '<p class="ap-bal"><i class="fa-solid fa-building-columns"></i> Paystack balance (what shop payouts are paid from): <b>' + naira(h.paystackBalance) + "</b></p>")) +
      (missing.length ? '<details class="ap-setup"><summary><i class="fa-solid fa-screwdriver-wrench"></i> ' + missing.length + ' feature' + (missing.length === 1 ? "" : "s") + ' not switched on yet</summary><p>Ask your engineer to apply these database changes:</p><ul>' + missing.map(function (m) { return "<li>" + esc(typeof m === "string" ? m : (m.label || m.name || JSON.stringify(m))) + "</li>"; }).join("") + "</ul></details>" : "") +
      '<div class="ap-card"><div class="ap2-title">Money moved</div><div class="ap-range">' + [["today", "Today"], ["week", "7 days"], ["month", "30 days"]].map(function (r) { return '<button class="' + (r[0] === range ? "active" : "") + '" onclick="lvPayRange(\'' + r[0] + '\')">' + r[1] + "</button>"; }).join("") + "</div>" +
      '<div class="ap-tiles">' + tiles.map(function (x) { return '<div class="ap-tile"><small>' + x[0] + "</small><b>" + naira(x[1]) + "</b></div>"; }).join("") + "</div></div>" +
      '<div class="ap2-tabs" role="tablist">' + TABS.map(function (x) { var n = counts[x[0]]; return '<button role="tab" class="' + (x[0] === tab ? "active" : "") + '" onclick="lvPayTab(\'' + x[0] + '\')">' + esc(x[1]) + (n ? '<i class="ap-n' + (x[0] === "todo" ? " red" : "") + '">' + (x[0] === "checks" ? "!" : n) + "</i>" : "") + "</button>"; }).join("") + "</div>" +
      '<p class="ap-help"><i class="fa-solid fa-circle-info"></i> ' + esc(HELP[tab]) + "</p>" + body;
  };
})();

/* ===== No numbers in a shop's "about" text =====
   Phone numbers, account numbers or any digits are not allowed in a business description (people were using it to take
   customers away from the app). Digits are removed as they are typed or pasted, and the save is refused if any are left.
   The database enforces the same rule (migration 0011). */
(function () {
  "use strict";
  var DIGITS = /[0-9\u0660-\u0669\u06F0-\u06F9\uFF10-\uFF19]/g;
  var SELECTOR = "#veBio,#vaBio";
  var lastToast = 0;
  function say() {
    if (Date.now() - lastToast < 4000) return;
    lastToast = Date.now();
    try { showToast("Numbers are not allowed in your business description.", "info"); } catch (_) {}
  }
  document.addEventListener("input", function (e) {
    var t = e.target;
    if (!t || !t.matches || !t.matches(SELECTOR)) return;
    if (!DIGITS.test(t.value)) { DIGITS.lastIndex = 0; return; }
    DIGITS.lastIndex = 0;
    var pos = t.selectionStart, before = t.value.slice(0, pos == null ? 0 : pos).replace(DIGITS, "").length;
    t.value = t.value.replace(DIGITS, "");
    try { t.setSelectionRange(before, before); } catch (_) {}
    say();
  }, true);
  // a "hint" under each field
  new MutationObserver(function () {
    document.querySelectorAll(SELECTOR).forEach(function (t) {
      if (t.dataset.noNum) return;
      t.dataset.noNum = "1";
      var h = document.createElement("small");
      h.className = "muted lv-no-num-hint";
      h.textContent = "No numbers, please (phone or account numbers are not allowed here).";
      t.insertAdjacentElement("afterend", h);
    });
  }).observe(document.body, { childList: true, subtree: true });
})();

/* ===== Filter drawers (vendors, browse, orders): a real backdrop, a handle, Clear / Show buttons =====
   The drawer used to fake its backdrop with a giant shadow, which could not fade or follow a drag. Now the backdrop is its
   own layer (tap it to close, it fades while the drawer is pulled down) and the drawer is in the sheet-drag list above.
   Whatever closes a drawer (the Done button, a tap outside, a drag), the backdrop goes with it. */
(function () {
  "use strict";
  var PANELS = [
    { sel: ".vendors-filters-panel", close: function () { try { toggleVendorsFilters(false); } catch (_) {} }, clear: "clearVendorsDirectoryFilters", label: "Show vendors" },
    { sel: ".browse-filter-panel", close: function () { try { toggleBrowseFilters(false); } catch (_) {} }, clear: "clearBrowseFilters", label: "Show results" },
    { sel: ".order-filters-panel", close: function () { try { window.closeLevromartTransientFilters(); } catch (_) {} }, clear: null, label: null },
    { sel: "#messagesMoreMenu", close: function () { var m = document.getElementById("messagesMoreMenu"); if (m) m.classList.add("hidden"); }, clear: null, label: null }
  ];
  function sync() {
    PANELS.forEach(function (p) {
      var el = document.querySelector(p.sel);
      if (!el || !el.parentNode) return;
      var open = !el.classList.contains("hidden");
      var back = el.parentNode.querySelector(":scope > .lv-sheet-back");
      if (open && !back) {
        back = document.createElement("div");
        back.className = "lv-sheet-back";
        back.addEventListener("click", p.close);
        el.parentNode.insertBefore(back, el);
      } else if (!open && back) back.remove();
      if (open && p.label && !el.querySelector(":scope > .lv-sheet-foot")) {
        var foot = document.createElement("div");
        foot.className = "lv-sheet-foot";
        foot.innerHTML = '<button type="button" class="btn btn-outline" data-a="clear">Clear all</button><button type="button" class="btn" data-a="done">' + p.label + "</button>";
        foot.addEventListener("click", function (e) {
          var a = e.target && e.target.getAttribute && e.target.getAttribute("data-a");
          if (a === "clear" && p.clear && typeof window[p.clear] === "function") window[p.clear]();
          if (a === "done") p.close();
        });
        el.appendChild(foot);
      }
    });
  }
  var raf = 0;
  new MutationObserver(function () { if (!raf) raf = requestAnimationFrame(function () { raf = 0; sync(); }); }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
})();

/* ===== Search keeps its place: coming back to the Search page (e.g. from a vendor or product you opened) shows the same
   search and results again, instead of an empty "no results" page. It remembers for 30 minutes. ===== */
(function () {
  "use strict";
  var KEY = "lv-search-state";
  function save(patch) {
    try {
      var cur = JSON.parse(sessionStorage.getItem(KEY) || "{}") || {};
      sessionStorage.setItem(KEY, JSON.stringify(Object.assign(cur, patch, { at: Date.now() })));
    } catch (_) {}
  }
  function load() {
    try {
      var s = JSON.parse(sessionStorage.getItem(KEY) || "null");
      return s && s.term && Date.now() - s.at < 30 * 60000 ? s : null;
    } catch (_) { return null; }
  }
  function wrap(name, after) {
    var orig = window[name];
    if (typeof orig !== "function") return;
    window[name] = function () { var r = orig.apply(this, arguments); try { after.apply(this, arguments); } catch (_) {} return r; };
  }
  wrap("runSearchPageQuery", function (term) { term = String(term || "").trim(); if (term) save({ term: term, filter: (typeof searchPageFilter !== "undefined" ? searchPageFilter : "all") }); });
  wrap("setSearchPageFilter", function (id) { save({ filter: id }); });
  wrap("clearSearchPageInput", function () { try { sessionStorage.removeItem(KEY); } catch (_) {} });
  var origRender = window.renderSearchPage;
  if (typeof origRender === "function") {
    window.renderSearchPage = function () {
      var html = origRender.apply(this, arguments);
      setTimeout(function () {
        var s = load(), input = document.getElementById("searchPageInput");
        if (!s || !input || input.value) return;
        input.value = s.term;
        var clear = document.getElementById("searchPageClearBtn"); if (clear) clear.classList.remove("hidden");
        if (s.filter && s.filter !== "all" && typeof setSearchPageFilter === "function") setSearchPageFilter(s.filter);
        else if (typeof runSearchPageQuery === "function") runSearchPageQuery(s.term, false);
      }, 60);
      return html;
    };
  }
})();

/* ===== The profile picture in the top bar never falls back to the generic icon while you are signed in =====
   The picture is remembered on this phone, shown at once when the app opens, and only replaced by the green login icon
   when there really is no login (signed out, or never signed in). */
(function () {
  "use strict";
  var KEY = "lv-avatar";
  function hasStoredLogin() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && /^sb-.*-auth-token$/.test(k) && localStorage.getItem(k)) return true;
      }
    } catch (_) {}
    return false;
  }
  function cached() { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch (_) { return null; } }
  function paintCached() {
    var c = cached(), btn = document.getElementById("avatarBtn"), login = document.getElementById("loginBtn");
    if (!c || !btn || !login || !hasStoredLogin()) return;
    btn.classList.remove("hidden"); login.classList.add("hidden");
    if (!btn.firstElementChild) {
      btn.innerHTML = c.url
        ? '<img src="' + String(c.url).replace(/"/g, "&quot;") + '" alt="" draggable="false" />'
        : (typeof avatarFallbackHtml === "function" ? avatarFallbackHtml(c.name || "", "100%", "", c.name || "") : "");
    }
  }
  var orig = window.updateAuthUI;
  if (typeof orig === "function") {
    window.updateAuthUI = function () {
      orig.apply(this, arguments);
      try {
        if (typeof session !== "undefined" && session && typeof profile !== "undefined" && profile) {
          localStorage.setItem(KEY, JSON.stringify({ id: session.user.id, url: profile.avatar_url || "", name: profile.name || profile.email || "" }));
        } else if (!hasStoredLogin()) {
          localStorage.removeItem(KEY);   // really signed out
        } else {
          paintCached();                  // still signed in, the profile is just not loaded yet: keep the picture
        }
      } catch (_) {}
    };
  }
  paintCached();
})();

/* ===== Back arrows take you back to where you were, not to Home =====
   The app counts how many screens deep you are (stored on each history entry). A back arrow goes one screen back when
   there is one, and only falls back to the given screen (Home) when this is the first screen of the visit. */
(function () {
  "use strict";
  function depth() { try { return (history.state && history.state.lvDepth) || 0; } catch (_) { return 0; } }
  var orig = window.navigate;
  // Where each screen was scrolled to, per history entry, so Back returns to the exact spot (not the top of the page).
  var scrolls = {};
  try { scrolls = JSON.parse(sessionStorage.getItem("lv-scrolls") || "{}") || {}; } catch (_) {}
  function keyOf(create) {
    try {
      var st = history.state;
      if (st && st.lvKey) return st.lvKey;
      if (create && st) { var k = "k" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); history.replaceState(Object.assign({}, st, { lvKey: k }), ""); return k; }
    } catch (_) {}
    return null;
  }
  var heights = {};
  try { heights = JSON.parse(sessionStorage.getItem("lv-heights") || "{}") || {}; } catch (_) {}
  function view0() { try { return currentView; } catch (_) { return ""; } }
  var pageSnaps = {}, snapAt = {};
  window.lvDropPageSnaps = function () { pageSnaps = {}; vendorsSnap = null; try { window.__lvHubDrop && window.__lvHubDrop(); } catch (_) {} };
  var vendorsSnap = null;   // the Vendors page as it looked when we left it (grid/list only), so Back can show it at once
  function remember() {
    try {
      var a = document.getElementById("app"), m = null; try { m = localStorage.getItem("levromart_vendors_view"); } catch (_) {}
      if (a && view0() === "vendors" && m !== "map" && a.querySelector("#vendorsGrid .vd-card, #vendorsGrid > *:not(.vd-skel)")) vendorsSnap = a.innerHTML;
      // Home and a shop's page are remembered the same way, so Back shows them at once instead of rebuilding them
      if (a && view0() === "home" && a.querySelector(".lv-act-grid")) { pageSnaps.home = a.innerHTML; snapAt.home = Date.now(); }
      else if (a && view0() === "storefront" && a.querySelector(".storefront-profile-name")) { var sp = history.state && history.state.params; if (sp && sp.vendorId) { pageSnaps["storefront|" + sp.vendorId] = a.innerHTML; snapAt["storefront|" + sp.vendorId] = Date.now(); } }
    } catch (_) {}
    var k = keyOf(true);
    if (!k) return;
    scrolls[k] = window.scrollY || document.documentElement.scrollTop || 0;
    heights[k] = document.documentElement.scrollHeight || 0;
    try { sessionStorage.setItem("lv-scrolls", JSON.stringify(scrolls)); sessionStorage.setItem("lv-heights", JSON.stringify(heights)); } catch (_) {}
  }
  // keep the spot while the page fills in; stop the moment the person scrolls or touches the screen
  function restore(y) {
    var cancelled = false, stop = function () { cancelled = true; };
    ["touchstart", "wheel", "keydown", "pointerdown"].forEach(function (t) { addEventListener(t, stop, { once: true, passive: true, capture: true }); });
    [0, 40, 120, 300, 700, 1400].forEach(function (ms) {
      setTimeout(function () { if (!cancelled && Math.abs((window.scrollY || 0) - y) > 2) window.scrollTo({ top: y, behavior: "instant" }); }, ms);
    });
  }
  // leaving a screen by any route (taps, links, the bottom bar) remembers where you were
  document.addEventListener("click", function (e) { if (e.target && e.target.closest && e.target.closest("a, button, [onclick], .card, .product-card-wrap")) { try { var pc = e.target.closest(".product-card-wrap[data-product-id]"); if (pc) window.__lvLastCard = pc.getAttribute("data-product-id"); } catch (_) {} remember(); } }, true);
  addEventListener("pagehide", remember);
  if (typeof orig === "function") {
    var flying = {};
    window.navigate = async function (view, params, pushHistory) {
      // a second tap on the same tab while it is still opening would draw the page all over again (and slow it): ignore it
      var fkey = view + "|" + (params ? JSON.stringify(params) : "");
      if ((view === "home" || view === "vendors") && flying[fkey] && Date.now() - flying[fkey] < 4000) return;
      if (view === "home" || view === "vendors") flying[fkey] = Date.now();
      try { return await navInner.apply(this, arguments); } finally { delete flying[fkey]; }
    };
    var navInner = async function (view, params, pushHistory) {
      var prev = depth(), pushes = pushHistory !== false && !(pushHistory && typeof pushHistory === "object" && pushHistory.replace === true);
      if (pushes) remember();
      // Going Back: keep the page as tall as it was, so the saved spot exists straight away (the list fills in afterwards)
      // and we do not first show the top and then scroll down.
      var heldBody = false;
      if (pushHistory === false) {
        try { var hk = keyOf(false), hh = hk != null ? heights[hk] : 0; if (hh > 0) { document.body.style.minHeight = hh + "px"; heldBody = true; } } catch (_) {}
        // go straight to the saved spot: the page is held at its old height, so there is nothing to wait for
        try { var k1 = keyOf(false), y1 = k1 != null ? scrolls[k1] : undefined; if (heldBody && Number.isFinite(y1) && y1 > 0) { document.documentElement.classList.add("lv-restoring"); window.scrollTo({ top: y1, behavior: "instant" }); setTimeout(function () { document.documentElement.classList.remove("lv-restoring"); }, 1800); } } catch (_) {}
      }
      if (pushHistory === false && view === "vendors" && vendorsSnap && view0() !== "vendors") {
        try { document.getElementById("app").innerHTML = vendorsSnap; } catch (_) {}
      }
      if (pushHistory === false && view === "vendorDashboard" && view0() !== view && window.__lvHubFresh && window.__lvHubFresh()) window.__lvUseSnap = { view: "vendorDashboard" };
      if (pushHistory === false && view0() !== view && (view === "home" || view === "storefront")) {
        try {
          var sk = view === "home" ? "home" : "storefront|" + (params && params.vendorId);
          if (pageSnaps[sk]) {
            // the page itself is then "drawn" from this same saved copy (no waiting for the network, no blank), so every normal
            // step after drawing a page still runs
            if (Date.now() - (snapAt[sk] || 0) < 600000) window.__lvUseSnap = { view: view, html: pageSnaps[sk], vendorId: params && params.vendorId };
            else document.getElementById("app").innerHTML = pageSnaps[sk];   // older copy: shown while the fresh page is built
          }
        } catch (_) {}
      }
      var r = await orig.apply(this, arguments);
      window.__lvUseSnap = null;
      if (heldBody) setTimeout(function () { document.body.style.minHeight = ""; }, 2200);
      try {
        var st = history.state;
        if (pushes && st && st.view === view && st.lvDepth == null) history.replaceState(Object.assign({}, st, { lvDepth: prev + 1 }), "");
        if (pushHistory === false) {            // Back / forward: return to where this screen was left
          var k = keyOf(false), y = k != null ? scrolls[k] : undefined;
          if (Number.isFinite(y)) { window.scrollTo({ top: y, behavior: "instant" }); restore(y); }
          // the product you opened is brought back into view (centred) if the saved spot left it off screen
          if (view === "home" && window.__lvLastCard) { var lc = window.__lvLastCard; [60, 400, 1200].forEach(function (ms) { setTimeout(function () { try { var el = document.querySelector('.product-card-wrap[data-product-id="' + lc + '"]'); if (!el) return; var r = el.getBoundingClientRect(); if (r.bottom < 60 || r.top > innerHeight - 60) el.scrollIntoView({ block: "center", behavior: "instant" }); } catch (_) {} }, ms); }); }
        }
      } catch (_) {}
      return r;
    };
  }
  (function () {
    var rh = window.renderHome, rs = window.renderStorefront;
    if (typeof rh === "function") window.renderHome = async function () {
      var u = window.__lvUseSnap; if (u && u.view === "home") { window.__lvUseSnap = null; return u.html; }
      return rh.apply(this, arguments);
    };
    // the shop hub (profile page): remember what it last drew; Back from one of its sub-pages draws that again at once
    var rv = window.renderVendorDashboard, hub = { html: "", at: 0 };
    if (typeof rv === "function") window.renderVendorDashboard = async function () {
      var u = window.__lvUseSnap; if (u && u.view === "vendorDashboard" && hub.html) { window.__lvUseSnap = null; return hub.html; }
      var out = await rv.apply(this, arguments);
      if (typeof out === "string" && out.length > 500) { hub.html = out; hub.at = Date.now(); }
      return out;
    };
    window.__lvHubFresh = function () { return hub.html && Date.now() - hub.at < 600000; };
    window.__lvHubDrop = function () { hub.at = 0; };
    if (typeof rs === "function") window.renderStorefront = async function (vid) {
      var u = window.__lvUseSnap; if (u && u.view === "storefront" && String(u.vendorId) === String(vid)) { window.__lvUseSnap = null; return u.html; }
      return rs.apply(this, arguments);
    };
  })();
  window.lvGoBack = function (fallback) {
    if (depth() > 0) history.back();
    else if (typeof navigate === "function") navigate(fallback || "home");
  };
})();

/* ===== A clean date picker (year, month, day) for the transaction history pages ===== */
(function () {
  "use strict";
  var MS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  // opts: { y, m, d (null = the whole month), minYear, marks: function (y, m) -> { day: true } }
  window.lvPickDate = function (opts) {
    return new Promise(function (resolve) {
      var now = new Date(), cy = now.getFullYear(), cm = now.getMonth(), cd = now.getDate();
      var y = opts.y, m = opts.m, d = opts.d || null, minY = Math.min(opts.minYear || cy, cy);
      var el = document.createElement("div"); el.className = "lvw-sheet-wrap lvdp-wrap";
      document.body.appendChild(el);
      function done(v) { el.remove(); resolve(v); }
      function paint() {
        var yopts = ""; for (var yy = cy; yy >= Math.min(minY, cy - 15); yy--) yopts += '<option value="' + yy + '"' + (yy === y ? " selected" : "") + ">" + yy + "</option>";
        var years = '<div class="lvdp-ystep"><button type="button" data-ystep="-1" aria-label="Previous year"' + (y <= Math.min(minY, cy - 15) ? " disabled" : "") + '><i class="fa-solid fa-chevron-left"></i></button><label class="lvdp-ysel"><select id="lvdpYear" aria-label="Year">' + yopts + '</select><i class="fa-solid fa-chevron-down"></i></label><button type="button" data-ystep="1" aria-label="Next year"' + (y >= cy ? " disabled" : "") + '><i class="fa-solid fa-chevron-right"></i></button></div>';
        var months = MS.map(function (n, i) { var off = y === cy && i > cm; return '<button type="button" class="' + (i === m ? "on" : "") + '"' + (off ? " disabled" : "") + ' data-m="' + i + '">' + n.slice(0, 3) + "</button>"; }).join("");
        var first = new Date(y, m, 1).getDay(), days = new Date(y, m + 1, 0).getDate(), marks = (opts.marks && opts.marks(y, m)) || {}, cells = "";
        for (var b = 0; b < first; b++) cells += "<i></i>";
        for (var k = 1; k <= days; k++) { var off2 = y === cy && m === cm && k > cd; cells += '<button type="button" class="' + (d === k ? "on " : "") + (marks[k] ? "mk" : "") + '"' + (off2 ? " disabled" : "") + ' data-d="' + k + '">' + k + "</button>"; }
        el.innerHTML = '<div class="lvw-sheet lvdp" role="dialog" aria-modal="true" aria-label="Pick a date"><div class="lvw-sheet-grab" aria-hidden="true"></div>' +
          '<div class="lvdp-head"><h3>Go to a date</h3><button type="button" class="lvdp-x" data-x aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>' +
          '<div class="lvdp-lab">Year</div>' + years +
          '<div class="lvdp-lab">Month</div><div class="lvdp-months">' + months + "</div>" +
          '<div class="lvdp-lab">Day <small>(dots = you have transactions)</small></div><div class="lvdp-dow"><span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span></div><div class="lvdp-days">' + cells + "</div>" +
          '<div class="lvdp-acts"><button type="button" class="lvdp-month" data-whole>Show all of ' + MS[m] + " " + y + "</button></div></div>";
      }
      el.addEventListener("change", function (e) { if (e.target && e.target.id === "lvdpYear") { y = +e.target.value; if (y === cy && m > cm) m = cm; d = null; paint(); } });
      el.addEventListener("click", function (e) {
        var t = e.target;
        if (t === el || (t.closest && t.closest("[data-x]"))) return done(null);
        var b = t.closest && t.closest("button"); if (!b || b.disabled) return;
        if (b.dataset.ystep) { y = Math.max(cy - 15, Math.min(cy, y + Number(b.dataset.ystep))); if (y === cy && m > cm) m = cm; d = null; paint(); }
        else if (b.dataset.m) { m = +b.dataset.m; d = null; paint(); }
        else if (b.dataset.d) { done({ y: y, m: m, d: +b.dataset.d }); }
        else if (b.hasAttribute("data-whole")) { done({ y: y, m: m, d: null }); }
      });
      paint();
    });
  };
})();

/* ===== The app never stays on an old version =====
   The installed app asks, every time it is opened or brought back, whether a newer version exists and switches to it by itself
   (at once, or the moment you stop typing). It never keeps running old screens, such as old payment flows. */
(function () {
  "use strict";
  function myVersion() { var s = document.querySelector('script[src*="01-app.js"]'); var m = s && /[?&]v=(\d+)/.exec(s.getAttribute("src") || ""); return m ? m[1] : null; }
  var mine = myVersion(), reloading = false;
  function typing() { var a = document.activeElement; return !!a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && String(a.value || "").length > 0; }
  function go(force) {
    if (reloading) return;
    var k = "lv-reloaded-for"; try { if (!force && sessionStorage.getItem(k) === String(Date.now() - (Date.now() % 60000))) return; sessionStorage.setItem(k, String(Date.now() - (Date.now() % 60000))); } catch (_) {}
    if (typing()) { var t = setInterval(function () { if (!typing()) { clearInterval(t); go(); } }, 2000); return; }
    reloading = true;
    try { navigator.serviceWorker.getRegistration().then(function (r) { r && r.update(); }).catch(function () {}); } catch (_) {}
    location.reload();
  }
  async function check() {
    if (!mine || document.hidden || !navigator.onLine) return;
    try {
      var r = await fetch("/?lvcheck=" + Date.now(), { cache: "no-store", headers: { "Cache-Control": "no-cache" } });
      var t = await r.text(), m = /01-app\.js\?v=(\d+)/.exec(t);
      if (m && m[1] !== mine && Number(m[1]) > Number(mine)) go();
    } catch (_) {}
  }
  try { navigator.serviceWorker && navigator.serviceWorker.addEventListener("message", function (e) { if (e.data && e.data.type === "LV_APP_UPDATED") go(); }); } catch (_) {}
  try { navigator.serviceWorker && navigator.serviceWorker.addEventListener("controllerchange", function () { setTimeout(check, 300); }); } catch (_) {}
  // coming back to the app: switch to the newest version at once, and after a longer break reload so no old screen is left behind
  var leftAt = 0;
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) { leftAt = Date.now(); return; }
    check();
    if (leftAt && Date.now() - leftAt > 60000 && !typing()) { leftAt = 0; go(true); }
  });
  window.addEventListener("online", check);
  window.addEventListener("pageshow", function (e) { if (e.persisted) go(true); });
  setTimeout(check, 1500);
  setInterval(check, 180000);
})();

/* ===== Maps follow the app theme: dark mode gives a dark map, light mode a light map (you can still pick another style on the map) ===== */
(function () {
  "use strict";
  var orig = window.setTheme;
  if (typeof orig !== "function") return;
  window.setTheme = function (theme) {
    var r = orig.apply(this, arguments);
    try {
      if (typeof vmpMap !== "undefined" && vmpMap && typeof vmpSetStyle === "function") vmpSetStyle(theme === "dark" || theme === "black" ? "night" : "streets", false);
    } catch (_) {}
    return r;
  };
})();

/* ===== Search: after you open a result, the search box is cleared (nothing left to wipe by hand) ===== */
(function () {
  "use strict";
  document.addEventListener("click", function (e) {
    var hit = e.target && e.target.closest && e.target.closest("#searchPageResults .search-result-row, #searchPageResults .lv-svr-item, #searchPageResults .sr-row, #searchPageResults [data-product-id], #searchPageResults [data-vendor-id]");
    if (!hit) return;
    try { sessionStorage.removeItem("lv-search-state"); } catch (_) {}
    setTimeout(function () {
      var input = document.getElementById("searchPageInput");
      if (input) input.value = "";
    }, 0);
  }, false);
})();

/* ===== The Messages "Chat actions" drawer stays open until you close it =====
   The inbox redraws itself every few seconds as new messages arrive; that used to wipe the open drawer (and bring the bottom
   bar back). The open state is now remembered and put back after every redraw. */
(function () {
  "use strict";
  var wantOpen = false;
  function menu() { return document.getElementById("messagesMoreMenu"); }
  new MutationObserver(function (list) {
    var m = menu();
    if (!m) return;
    var attr = list.some(function (r) { return r.type === "attributes" && r.target === m; });
    if (attr) { wantOpen = !m.classList.contains("hidden"); return; }          // the person opened or closed it
    if (wantOpen && m.classList.contains("hidden")) m.classList.remove("hidden"); // the page was redrawn: put it back
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
  // leaving the Messages page ends it
  var nav = window.navigate;
  if (typeof nav === "function") window.navigate = function () { wantOpen = false; return nav.apply(this, arguments); };
})();

/* ===== Vendor application: working hours use the app's own dropdown (not the phone's plain list) ===== */
(function () {
  "use strict";
  function dress() { var s = document.getElementById("vaHoursPreset"); if (s && typeof enhanceSelect === "function") { try { enhanceSelect(s); } catch (_) {} } }
  var host = document.getElementById("app") || document.body;
  new MutationObserver(dress).observe(host, { childList: true, subtree: true });
  dress();
})();

/* ===== Profile panel: draw attention to "Apply to be a vendor" with a gentle jiggle ===== */
(function () {
  "use strict";
  function mark() {
    var panel = document.getElementById("profilePanel"); if (!panel) return;
    panel.querySelectorAll(".vp-row, button, a").forEach(function (el) {
      if (el.classList.contains("vp-cta-jiggle")) return;
      var t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (/^Apply to be a vendor/i.test(t) && t.length < 60) el.classList.add("vp-cta-jiggle");
    });
  }
  new MutationObserver(mark).observe(document.body, { childList: true, subtree: true });
  mark();
})();

/* ===== Bank pickers: show each bank's own logo (small pictures kept with the app); a plain bank icon when there is none ===== */
(function () {
  "use strict";
  function dressBank() {
    document.querySelectorAll(".ve-bank-ico[data-bank-code]:not([data-lvlogo])").forEach(function (holder) {
      holder.setAttribute("data-lvlogo", "1");
      var code = String(holder.getAttribute("data-bank-code") || "").replace(/[^a-zA-Z0-9._-]/g, "");
      if (!code) return;
      var img = new Image(); img.alt = ""; img.decoding = "async";
      img.onload = function () { holder.innerHTML = ""; holder.classList.add("has-logo"); holder.appendChild(img); };
      img.src = "/bank-logos/" + code + ".webp";
    });
  }
  function dress() {
    dressBank();
    document.querySelectorAll(".vendor-bank-option:not([data-lvlogo])").forEach(function (btn) {
      btn.setAttribute("data-lvlogo", "1");
      var code = String(btn.getAttribute("data-bank-code") || "").replace(/[^a-zA-Z0-9._-]/g, "");
      var holder = btn.querySelector(".vendor-bank-option-icon");
      if (!code || !holder) return;
      var img = new Image();
      img.alt = ""; img.decoding = "async";
      img.onload = function () { holder.innerHTML = ""; holder.appendChild(img); };
      img.src = "/bank-logos/" + code + ".webp";
    });
  }
  new MutationObserver(dress).observe(document.body, { childList: true, subtree: true });
})();

/* ===== Settings: pick the pattern behind product cards ===== */
(function () {
  "use strict";
  var KEY = "lv-card-style";
  var STYLES = [["dots", "Dots", "lv-cs-dots"], ["lines", "Stripes", "lv-cs-lines"], ["grid", "Grid", "lv-cs-grid2"], ["glow", "Soft glow", "lv-cs-glow"], ["corners", "Corners", "lv-cs-corners"], ["plain", "Plain", ""]];
  function get() { try { return localStorage.getItem(KEY) || "dots"; } catch (_) { return "dots"; } }
  document.documentElement.setAttribute("data-card-style", get());
  function paint() {
    var cur = get();
    document.querySelectorAll("#lvCardStyleSection .lv-cs-tile").forEach(function (b) { var on = b.getAttribute("data-cs") === cur; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); });
  }
  function set(v) { try { localStorage.setItem(KEY, v); } catch (_) {} document.documentElement.setAttribute("data-card-style", v); paint(); }
  function mount() {
    var page = document.getElementById("settings-page");
    if (!page || document.getElementById("lvCardStyleSection")) return;
    var first = page.querySelector(".settings-page-section"); if (!first) return;
    var sec = document.createElement("section");
    sec.className = "settings-page-section"; sec.id = "lvCardStyleSection";
    sec.innerHTML = '<h3><i class="fa-solid fa-table-cells-large"></i> Product cards</h3><p class="settings-section-note">Dots is the default. You can change the pattern behind product cards here any time; it is saved on this device.</p><div class="lv-cs-grid">' +
      STYLES.map(function (s) { return '<button type="button" class="lv-cs-tile" data-cs="' + s[0] + '" aria-pressed="false"><span class="lv-cs-prev ' + s[2] + '"></span>' + s[1] + "</button>"; }).join("") + "</div>";
    first.insertAdjacentElement("afterend", sec);
    sec.addEventListener("click", function (e) { var b = e.target.closest("[data-cs]"); if (b) set(b.getAttribute("data-cs")); });
    paint();
  }
  new MutationObserver(mount).observe(document.body, { childList: true, subtree: true });
  mount();
})();

/* ===== Vendors page: coming Back shows the vendors we already have straight away (no grey placeholders first) ===== */
(function () {
  "use strict";
  var orig = window.renderVendorsDirectory;
  if (typeof orig !== "function" || window.__lvVendorsInstant) return;
  window.__lvVendorsInstant = true;
  window.renderVendorsDirectory = function () {
    var html = orig.apply(this, arguments);
    try {
      var all = window.__allVendors;
      if (!Array.isArray(all) || !all.length || typeof vendorDirectorySkeletonHtml !== "function") return html;
      var sk = vendorDirectorySkeletonHtml();
      var at = html.indexOf(sk);
      if (at < 0) return html;
      var shown = window.__filteredVendors;
      var mode = typeof vendorDirectoryMode === "string" ? vendorDirectoryMode : "grid", cards = "";
      if (mode !== "map") {
        if (!Array.isArray(shown) || shown.length !== all.length) return html;   // a filter was applied last time: wait for the fresh list
        var fn = typeof vendorPageCardHtml === "function" ? vendorPageCardHtml : null;
        if (!fn) return html;
        cards = shown.slice(0, 12).map(fn).join("");
      }
      return html.slice(0, at) + cards + html.slice(at + sk.length);
    } catch (_) { return html; }
  };
})();

/* ===== Home: three flyer banners for the vendor who is winning right now (storefront, products, follow) =====
   They are slipped in between the normal promotional banners, take their colours from the vendor's logo, and change on
   their own whenever a different vendor takes the lead. */
(function () {
  "use strict";
  var busy = false, prodCache = {}, colorCache = {};
  function esc2(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function hueOf(id) { var h = 2166136261; String(id).split("").forEach(function (ch) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }); return (h >>> 0) % 360; }
  // hand-picked pairs (no greens, no blues): the banners cycle through these, each one a step apart, and fade between them
  var PAL = [["#8438e8", "#6a22c9"], ["#6d28d9", "#be185d"], ["#e11d48", "#f97316"], ["#c2410c", "#9d174d"], ["#d946ef", "#7c3aed"], ["#be123c", "#6d28d9"], ["#f59e0b", "#ea580c"]];
  var palStep = 0, logoPal = null;
  function pickPal(offset) { var list = logoPal ? [logoPal].concat(PAL) : PAL; return list[(palStep + offset) % list.length]; }
  function palette(offset) { var c = pickPal(offset); return "--wv-a:" + c[0] + ";--wv-b:" + c[1] + ";--wv-ink:" + c[0]; }
  function rgbHex(h) { var a = (h % 360) / 60, x = 1 - Math.abs(a % 2 - 1), r = 0, g = 0, b = 0; if (a < 1) { r = 1; g = x; } else if (a < 2) { r = x; g = 1; } else if (a < 3) { g = 1; b = x; } else if (a < 4) { g = x; b = 1; } else if (a < 5) { r = x; b = 1; } else { r = 1; b = x; } var f = function (v) { return Math.round((0.18 + v * 0.55) * 255).toString(16).padStart(2, "0"); }; return "#" + f(r) + f(g) + f(b); }
  // the most colourful part of the logo, so the flyer matches it
  function logoHue(url) {
    if (!url) return Promise.resolve(null);
    if (colorCache[url] !== undefined) return Promise.resolve(colorCache[url]);
    return new Promise(function (res) {
      var im = new Image(); im.crossOrigin = "anonymous";
      var done = function (v) { colorCache[url] = v; res(v); };
      im.onload = function () {
        try {
          var c = document.createElement("canvas"); c.width = c.height = 32; var x = c.getContext("2d"); x.drawImage(im, 0, 0, 32, 32);
          var d = x.getImageData(0, 0, 32, 32).data, bins = new Array(24).fill(0);
          for (var i = 0; i < d.length; i += 4) {
            var r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, dl = mx - mn;
            if (d[i + 3] < 200 || dl < .18 || l < .15 || l > .9) continue;
            var h = mx === r ? ((g - b) / dl + 6) % 6 : mx === g ? (b - r) / dl + 2 : (r - g) / dl + 4;
            bins[Math.floor(h * 60 / 15) % 24] += dl;
          }
          var best = 0; bins.forEach(function (v, k) { if (v > bins[best]) best = k; });
          done(bins[best] > 0 ? best * 15 + 7 : null);
        } catch (_) { done(null); }
      };
      im.onerror = function () { done(null); };
      im.src = url;
    });
  }
  function products(vid) {
    var c = prodCache[vid]; if (c && Date.now() - c.at < 300000) return Promise.resolve(c.rows);
    return Promise.resolve(sb.from("products").select("id,name,photos,sale_price,discount_price,is_service").eq("vendor_id", vid).eq("status", "active").order("created_at", { ascending: false }).limit(40))
      .then(function (r) {
        var rows = ((r && r.data) || []).filter(function (p) { return p.photos && p.photos[0]; }).slice(0, 24);
        prodCache[vid] = { at: Date.now(), rows: rows }; preload(rows); return rows;   // the pictures are fetched up front, so a banner's products show the moment it slides in
      }).catch(function () { return []; });
  }
  function pick3(pool) { var a = pool.slice(), out = []; while (a.length && out.length < 3) out.push(a.splice(Math.floor(Math.random() * a.length), 1)[0]); return out; }
  function th(u) { try { return typeof lvThumb === "function" ? lvThumb(u, 300) : u; } catch (_) { return u; } }
  function preload(rows) { try { (rows || []).forEach(function (p) { var i = new Image(); i.decoding = "async"; i.src = th(p.photos[0]); }); } catch (_) {} }
  function thumbsHtml(rows) { return rows.map(function (p) { return '<img data-pid="' + esc2(p.id) + '" src="' + esc2(th(p.photos[0])) + '" alt="" decoding="async">'; }).join(""); }
  function tilesHtml(rows) { return rows.map(function (p) { return '<span class="lv-wv-tile" data-pid="' + esc2(p.id) + '"><img src="' + esc2(th(p.photos[0])) + '" alt="" decoding="async"><b>' + esc2(p.name) + "</b><i>" + esc2(naira(p)) + "</i></span>"; }).join(""); }
  function naira(p) { try { var v = typeof effectivePrice === "function" ? effectivePrice(p) : (p.discount_price || p.sale_price); v = Number(v); return v > 0 ? "₦" + v.toLocaleString("en-NG") : ""; } catch (_) { return ""; } }
  function logoHtml(w, cls) {
    var ini = esc2(String(w.business_name || "?").trim().slice(0, 2).toUpperCase());
    return '<span class="lv-wv-logo ' + (cls || "") + '">' + (w.logo_url ? '<img src="' + esc2(w.logo_url) + '" alt="" decoding="async" onerror="this.replaceWith(Object.assign(document.createElement(\'b\'),{textContent:\'' + ini + '\'}))">' : "<b>" + ini + "</b>") + "</span>";
  }
  // When the winner is the one for the chosen campus, that school's logo sits in front of the badge
  function scopeId() { try { return (window.__lb && window.__lb.spotFor) || ""; } catch (_) { return ""; } }
  function schoolChip() {
    var id = scopeId(); if (!id || typeof window.lvCampusLogoHtml !== "function") return "";
    var nm = ""; try { nm = window.lvCampusShort ? window.lvCampusShort(id) : ""; } catch (_) {}
    return '<span class="lv-wv-school" title="' + esc2(nm) + '"><span class="lv-wv-school-logo">' + window.lvCampusLogoHtml(id) + "</span></span>";
  }
  function slide(kind, w, rows, hue) {
    var id = esc2(w.vendor_id), nm = esc2(w.business_name);
    var open = ' class="home-promotional-slide lv-wv lv-wv-' + kind + '" data-wv="' + id + '" data-wv-kind="' + kind + '" style="' + palette({ a: 0, b: 1, c: 2, o: 0 }[kind]) + '" onclick="lvWvTap(event,\'' + kind + '\',\'' + id + '\')" aria-label="';
    if (kind === "o") {
      var pts = Number(w.points) ? " with " + Number(w.points).toLocaleString("en-NG") + " points" : "";
      var othumbs = thumbsHtml(rows);
      return '<button type="button" class="home-promotional-slide lv-wv lv-wv-o" data-wv="' + id + '" data-wv-kind="o" onclick="lvWvTap(event,\'o\',\'' + id + '\')" aria-label="Overall vendor of the week on every campus: ' + nm + '"><span class="lv-wv-in">' +
        '<span class="lv-wv-badge"><i class="fa-solid fa-crown"></i> Overall winner</span>' +
        logoHtml(w, "lv-wv-logo-big") +
        '<span class="lv-wv-name">' + nm + "</span>" +
        '<span class="lv-wv-sub">Last week\u2019s overall winner across all campuses' + pts + "</span>" +
        (othumbs ? '<span class="lv-wv-thumbs lv-wv-o-thumbs">' + othumbs + "</span>" : "") +
        '<span class="lv-wv-cta">Open storefront</span></span></button>';
    }
    var thumbs = thumbsHtml(rows);
    if (kind === "a") {
      return "<button type=\"button\"" + open + "Vendor of the week: " + nm + '"><span class="lv-wv-in">' +
        '<span class="lv-wv-badge">' + schoolChip() + '<i class="fa-solid fa-award"></i> Vendor of the week</span>' +
        logoHtml(w, "lv-wv-logo-big") +
        '<span class="lv-wv-name">' + nm + "</span>" +
        '<span class="lv-wv-sub">' + (Number(w.points) ? "Won last week with " + Number(w.points).toLocaleString("en-NG") + " points" : "Last week\u2019s winner") + "</span>" +
        (thumbs ? '<span class="lv-wv-thumbs">' + thumbs + "</span>" : "") +
        '<span class="lv-wv-cta">Open storefront</span></span></button>';
    }
    if (kind === "b") {
      var tiles = tilesHtml(rows);
      return "<button type=\"button\"" + open + "Shop " + nm + '"><span class="lv-wv-in">' +
        '<span class="lv-wv-badge">' + schoolChip() + '<i class="fa-solid fa-fire"></i> Fresh from the winner</span>' +
        logoHtml(w, "lv-wv-logo-sm") +
        '<span class="lv-wv-name lv-wv-name-sm">' + nm + "</span>" +
        '<span class="lv-wv-tiles">' + tiles + "</span>" +
        '<span class="lv-wv-more">Tap to shop all <i class="fa-solid fa-arrow-right"></i></span></span></button>';
    }
    return "<button type=\"button\"" + open + "Follow " + nm + '"><span class="lv-wv-in">' +
      '<span class="lv-wv-badge">' + schoolChip() + '<i class="fa-solid fa-heart"></i> Don\'t miss a drop</span>' +
      logoHtml(w, "lv-wv-logo-big") +
      '<span class="lv-wv-name">Follow ' + nm + "</span>" +
      '<span class="lv-wv-sub">Be first to see new products, deals and updates.</span>' +
      (thumbs ? '<span class="lv-wv-thumbs lv-wv-thumbs-r">' + thumbs + "</span>" : "") +
      '<span class="lv-wv-cta lv-wv-cta-follow">Follow</span></span></button>';
  }
  window.lvWvTap = function (e, kind, vid) {
    var s = e.currentTarget, vp = document.getElementById("homePromotionalViewport");
    try {
      if (vp && vp.dataset.loop === "1" && typeof homeCarouselStep === "function") {
        var step = homeCarouselStep(vp), dom = Array.prototype.indexOf.call(s.parentElement.children, s);
        if (step && Math.abs(vp.scrollLeft - dom * step) > step * .35) { e.preventDefault(); vp.scrollTo({ left: dom * step, behavior: "smooth" }); return; }
      }
      if (typeof homeCarouselJustDragged !== "undefined" && homeCarouselJustDragged) { e.preventDefault(); return; }
    } catch (_) {}
    if (kind.indexOf("fy:") === 0) {
      var act = kind.slice(3);
      if (act === "join") window.open("https://chat.whatsapp.com/DVCSNKkZ6AIHtKYyMPWxHs", "_blank", "noopener");
      else if (act === "links") window.open("/links", "_blank", "noopener");
      else if (act === "requestEquipment" && !session) requireLoginThen("requestEquipment");
      else navigate(act, {}, true);
      return;
    }
    var hit = e.target && e.target.closest && e.target.closest("[data-pid]");
    if (hit && kind !== "c") { navigate("productDetail", { productId: hit.getAttribute("data-pid") }); return; }
    if (kind !== "c") { navigate("storefront", { vendorId: vid }); return; }
    if (!session) { try { showLogin(); } catch (_) {} return; }
    try { window.__followRecentAction = { vendorId: String(vid), following: true, at: Date.now() }; window.rememberVendorFollow && window.rememberVendorFollow(vid, true); } catch (_) {}
    navigate("storefront", { vendorId: vid });
    Promise.resolve(levroData.follows.set(vid, true)).then(function (r) {
      if (r && r.error) throw r.error;
      try { showToast("You are now following this vendor.", "success"); } catch (_) {}
    }).catch(function () { try { window.__followRecentAction = null; showToast("Could not follow just now. Open the shop and tap follow.", "error"); } catch (_) {} });
  };
  // lays the banners out: winner flyers first, then alternating with the normal ones; adds the loop copies and the dots
  function compose(car, extra) {
    var track = car.querySelector("#homePromotionalTrack"), vp = car.querySelector("#homePromotionalViewport"); if (!track || !vp) return 0;
    var base = Array.prototype.filter.call(track.children, function (n) { return !n.hasAttribute("data-clone") && !n.hasAttribute("data-wv"); });
    if (!base.length) return 0;
    var tmp = document.createElement("div"); tmp.innerHTML = extra.join("");
    var wv = Array.prototype.slice.call(tmp.children), order = [], bi = 0;
    while (wv.length || bi < base.length) { if (wv.length) order.push(wv.shift()); if (bi < base.length) order.push(base[bi++]); }
    track.replaceChildren.apply(track, order);
    if (order.length > 1) {
      var lastC = order[order.length - 1].cloneNode(true), firstC = order[0].cloneNode(true);
      [lastC, firstC].forEach(function (c) { c.setAttribute("data-clone", "1"); c.setAttribute("tabindex", "-1"); c.setAttribute("aria-hidden", "true"); });
      track.insertBefore(lastC, track.firstChild); track.appendChild(firstC);
      vp.dataset.loop = "1";
    }
    var dots = car.querySelector("#homePromotionalDots");
    if (!dots && order.length > 1) { dots = document.createElement("div"); dots.className = "home-promotional-dots"; dots.id = "homePromotionalDots"; car.appendChild(dots); }
    if (dots) dots.innerHTML = order.map(function (_, i) { return '<button type="button" class="home-promotional-dot ' + (i === 0 ? "active" : "") + '" onclick="activateHomeCarouselSlide(' + i + ')" aria-label="Go to slide ' + (i + 1) + '"></button>'; }).join("");
    return order.length;
  }
  function rebuild(car, extra) {
    var vp = car.querySelector("#homePromotionalViewport"); if (!vp) return;
    var n = compose(car, extra); if (!n) return;
    // a fresh row: the old one still carries listeners that remember the old number of banners (they wrapped the loop too early)
    var fresh = vp.cloneNode(true); vp.replaceWith(fresh); vp = fresh;
    var order = { length: n };
    vp.dataset.carouselBound = ""; window.__levroCarouselDom = null;
    try { if (typeof homeCarouselTimer !== "undefined" && homeCarouselTimer) { clearInterval(homeCarouselTimer); homeCarouselTimer = null; } } catch (_) {}
    try { initHomepageCarousel(); } catch (_) {}
    var jump = function () { try { var st = homeCarouselStep(vp); if (st && order.length > 1) { vp.style.scrollSnapType = "none"; vp.scrollLeft = st; requestAnimationFrame(function () { vp.style.scrollSnapType = ""; }); } } catch (_) {} };
    requestAnimationFrame(jump); setTimeout(jump, 120); setTimeout(jump, 400);
  }
  // ---- the six launch banners, rebuilt in code from the original flyer pictures (same words, colours and photos, with moving icons) ----
  // A banner whose picture an admin uploaded or edited after this release (CUT) keeps its picture, so replacing one still works.
  var CUT = Date.parse("2026-10-26T00:00:00Z");
  var FY = [
    { k: "join", act: "join", link: "https://chat.whatsapp.com/DVCSNKkZ6AIHtKYyMPWxHs", label: "Join the community", h1: "Join the", h2: "community.", sub: "Be first to hear new vendors, offers and campus updates on WhatsApp.", cta: "Join the group", ph: "join", tiles: ["fa-cart-shopping", "fa-bag-shopping", "star"] },
    { k: "sell", act: "vendorApply", link: "?levro=vendorApply", label: "Sell to your whole campus", h1: "Sell to your", h2: "whole campus.", sub: "Open your shop in minutes. List products, get orders, grow.", cta: "Become a vendor", ph: "sell", tiles: ["fa-box", "star", "fa-tag", "fa-cart-shopping"] },
    { k: "store", act: "vendors", link: "?levro=vendors", label: "Your campus online store", h1: "Your campus", h2: "online store.", sub: "Shop products, book services and rent items from vendors on your campus.", cta: "Open the store", ph: "follow", tiles: ["fa-cart-shopping", "fa-box", "fa-bag-shopping", "fa-tag", "star"] },
    { k: "follow", act: "links", link: "/links", label: "Follow us everywhere", h1: "Follow us", h2: "everywhere.", sub: 'Same name on every platform: <b>@levromart</b>', cta: "Click to follow", ph: "store", tiles: ["star", "fa-bag-shopping", "fa-cart-shopping"], social: true },
    { k: "win", act: "leaderboard", link: "?levro=leaderboard", label: "Win a full week of promotion", h1: "Win a full week", h2: "of promotion.", sub: "Be seen by more customers. Be Vendor of the Week.", cta: "", ph: "win", tiles: ["fa-cart-shopping", "star", "fa-tag", "fa-bag-shopping"], soon: true },
    { k: "request", act: "requestEquipment", link: "?levro=requestEquipment", label: "Can't find it? Request it.", h1: "Can't find it?", h2: "Request it.", sub: "Tell vendors what you need. They come to you with offers.", cta: "Request an item", ph: "request", tiles: ["fa-cart-shopping", "fa-bag-shopping", "star", "fa-box"] }
  ];
  var SOC = [["fa-instagram", "#e1306c"], ["fa-tiktok", "#111"], ["fa-facebook-f", "#1877f2"], ["fa-x-twitter", "#000"], ["fa-linkedin-in", "#0a66c2"], ["substack", "#ff6719"], ["fa-whatsapp", "#25d366"]];
  // the icon font has no Substack logo, so it is drawn here
  var SUBSTACK = '<svg viewBox="0 0 24 24" width="55%" height="55%" fill="#fff" aria-hidden="true"><path d="M22.539 8.242H1.46V5.406h21.08v2.836zM1.46 10.812V24L12 18.11 22.54 24V10.812H1.46zM22.54 0H1.46v2.836h21.08V0z"/></svg>';
  function fyHtml(d) {
    var tiles = d.tiles.map(function (t, i) { return '<span class="lv-fy-t lv-fy-t' + (i + 1) + '">' + (t === "star" ? '<i class="fa-solid fa-star"></i>' : '<i class="fa-solid ' + t + '"></i>') + "</span>"; }).join("");
    var soc = d.social ? '<span class="lv-fy-soc">' + SOC.map(function (x) { return '<span style="background:' + x[1] + '">' + (x[0] === "substack" ? SUBSTACK : '<i class="fa-brands ' + x[0] + '"></i>') + "</span>"; }).join("") + "</span>" : "";
    return '<span class="lv-wv-in"><span class="lv-fy-brand"><img src="/icon-192.png" alt="" width="40" height="40"><b>levromart</b></span>' +
      (d.soon ? '<span class="lv-fy-soon">COMING SOON</span>' : "") +
      '<span class="lv-fy-h"><em>' + d.h1 + "</em><strong>" + d.h2 + "</strong></span>" +
      '<span class="lv-fy-sub">' + d.sub + "</span>" + soc +
      (d.cta ? '<span class="lv-fy-cta">' + d.cta + "" + "</span>" : "") +
      (d.foot ? '<span class="lv-fy-foot">' + d.foot + "</span>" : "") +
      '<span class="lv-fy-photo"><img src="/lb/flyer-' + d.ph + '.webp" alt="" decoding="async"></span>' + tiles + "</span>";
  }
  function flyerize(b, d) {
    b.classList.add("lv-wv", "lv-fy", "lv-fy-" + d.k); b.setAttribute("data-flyer", d.k);
    b.setAttribute("data-link-url", d.link); b.setAttribute("onclick", "lvWvTap(event,'fy:" + d.act + "','')"); b.setAttribute("aria-label", d.label); b.removeAttribute("style");
    b.innerHTML = fyHtml(d);
  }
  var origR = window.renderHomepageCarouselHtml;
  if (typeof origR === "function" && !window.__lvDesignedBanners) {
    window.__lvDesignedBanners = true;
    window.renderHomepageCarouselHtml = function () {
      var arguments0 = arguments[0], html = origR.apply(this, arguments);
      if (!html) return html;
      try {
        var box = document.createElement("div"); box.innerHTML = html;
        var list = (arguments0 && arguments0.filter ? arguments0 : []).filter(function (x) { return x && x.image_url; }).slice(0, 12), map = {}, n = 0;
        list.forEach(function (sl, i) { var t = Date.parse(sl.updated_at || sl.created_at || ""); if ((!t || t < CUT) && n < FY.length) map[i] = FY[n++]; });
        box.querySelectorAll(".home-promotional-slide").forEach(function (b) { var d = map[Number(b.getAttribute("data-carousel-index"))]; if (d) flyerize(b, d); });
        var car = box.querySelector("#homePromotionalCarousel"), c = null;
        try { c = JSON.parse(localStorage.getItem("lv-wv-cache") || "null"); } catch (_) {}
        if (car && c && c.w && c.w.vendor_id && Date.now() - c.at < 43200000 && !c.scope && (function () { try { return (window.lvViewCampus ? window.lvViewCampus() : "all") === "all"; } catch (_) { return true; } })()) {
          logoPal = c.pal || null; var pool = c.pool || []; window.__lvWvPool = pool;
          var rows = pick3(pool), extra = [slide("a", c.w, rows, 0)]; if (rows.length) extra.push(slide("b", c.w, rows, 0)); extra.push(slide("c", c.w, rows, 0));
          car.setAttribute("data-wv-key", c.w.vendor_id + "|" + (logoPal ? logoPal[0] : "") + "|" + (pool.length ? 1 : 0));
          compose(car, extra);
        }
        return box.innerHTML;
      } catch (_) { return html; }
    };
  }
  var again = false;
  async function inject() {
    if (busy || Date.now() - (window.__lvCarTouchedAt || 0) < 15000) return;
    var car = document.getElementById("homePromotionalCarousel"); if (!car || typeof window.lvVendorSpot !== "function") return;
    busy = true;
    try {
      var spot = await window.lvVendorSpot();
      var w = spot && spot.winner;   // the vendor who WON last week keeps the banners for this whole week (not whoever is leading right now)
      if (w && (!w.vendor_id || !w.business_name)) w = null;
      // the overall winner (all campuses) has a banner of its own that stays whichever campus view is chosen
      var ov = null; try { ov = typeof window.lvOverallSpot === "function" ? await window.lvOverallSpot() : null; } catch (_) {}
      var ow = ov && ov.winner && ov.winner.vendor_id && ov.winner.business_name ? ov.winner : null;
      car = document.getElementById("homePromotionalCarousel"); if (!car) return;
      if (!w && !ow) { try { localStorage.removeItem("lv-wv-cache"); } catch (_) {} car.querySelectorAll("[data-wv]").length && removeAll(car); return; }
      var extra = [], pool = [], rows = [], h = null;
      if (w) {
        pool = await products(w.vendor_id); rows = pick3(pool); window.__lvWvPool = pool;
        h = await logoHue(w.logo_url);
        logoPal = (h != null && (h < 70 || h > 170)) ? [rgbHex(h), rgbHex(h + 40)] : null;
      } else { logoPal = null; window.__lvWvPool = []; }
      car = document.getElementById("homePromotionalCarousel"); if (!car) return;
      var key = (w ? w.vendor_id + "|" + (logoPal ? logoPal[0] : "") + "|" + (pool.length ? 1 : 0) + "|" + scopeId() : "none") + "|ov:" + (ow ? ow.vendor_id : "");
      if (car.getAttribute("data-wv-key") === key) return;
      if (w) { extra.push(slide("a", w, rows, h)); if (rows.length) extra.push(slide("b", w, rows, h)); extra.push(slide("c", w, rows, h)); }
      // the overall winner's banner is the first one people see when the app opens
      if (ow) { var opool = await products(ow.vendor_id); window.__lvOvPool = opool; extra.unshift(slide("o", ow, pick3(opool), null)); } else window.__lvOvPool = [];
      car.setAttribute("data-wv-key", key);
      if (w) { try { localStorage.setItem("lv-wv-cache", JSON.stringify({ at: Date.now(), scope: scopeId(), w: { vendor_id: w.vendor_id, business_name: w.business_name, logo_url: w.logo_url, points: w.points }, pal: logoPal, pool: pool.map(function (p) { return { id: p.id, name: p.name, photos: [p.photos[0]], sale_price: p.sale_price, discount_price: p.discount_price, is_service: p.is_service }; }) })); } catch (_) {} }
      rebuild(car, extra);
    } catch (err) { console.warn("[Levromart] winner banners", err); } finally { busy = false; if (again) { again = false; setTimeout(inject, 0); } }
  }
  function removeAll(car) { car.removeAttribute("data-wv-key"); rebuild(car, []); }
  var t = 0;
  new MutationObserver(function () { if (t || busy) return; if (!document.getElementById("homePromotionalCarousel")) return; t = setTimeout(function () { t = 0; inject(); }, 120); }).observe(document.body, { childList: true, subtree: true });
  setInterval(function () { if (!document.hidden) inject(); }, 120000);
  document.addEventListener("lv-spot-changed", function () { window.__lvCarTouchedAt = 0; if (busy) { again = true; return; } setTimeout(inject, 0); });
  // every few seconds: new products on the flyers, new colours on the banners
  function swapProducts() {
    if (document.hidden) return;
    if (window.__lvDragging || document.documentElement.classList.contains("lv-fab-dragging")) return;   // never while a button is being carried
    var onScreen = function (box) { var r = box.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; };
    // each winner's banners draw from that winner's own products: the campus winner's, and (separately) the overall winner's
    [[window.__lvWvPool, ".lv-wv-thumbs:not(.lv-wv-o-thumbs), .lv-wv-tiles"], [window.__lvOvPool, ".lv-wv-o-thumbs"]].forEach(function (g) {
      var pool = g[0]; if (!pool || pool.length < 4) return;
      var rows = pick3(pool);
      // look first (only banners on screen), then change: no layout is forced in between
      var boxes = [].filter.call(document.querySelectorAll(g[1]), onScreen);
      if (!boxes.length) return;
      boxes.forEach(function (box) { box.classList.remove("lv-wv-swap"); });
      requestAnimationFrame(function () { requestAnimationFrame(function () {
        boxes.forEach(function (box) {
          box.innerHTML = box.classList.contains("lv-wv-tiles") ? tilesHtml(rows) : thumbsHtml(rows);
          box.classList.add("lv-wv-swap");
        });
      }); });
    });
  }
  function swapColours() {
    if (document.hidden || window.__lvDragging) return; palStep++;
    document.querySelectorAll(".lv-wv").forEach(function (sl) {
      var c = pickPal(sl.hasAttribute("data-pal") ? Number(sl.getAttribute("data-pal")) : ({ a: 0, b: 1, c: 2 }[sl.getAttribute("data-wv-kind")] || 0));
      sl.style.setProperty("--wv-a", c[0]); sl.style.setProperty("--wv-b", c[1]); sl.style.setProperty("--wv-ink", c[0]);
    });
  }
  setInterval(swapProducts, 7000);
  setInterval(swapColours, 11000);
  inject();
})();


/* ===== Home strips: the "Shop from your campus / Follow us / ..." banners fade through nicer colours and their icons wiggle now and then ===== */
(function () {
  "use strict";
  var P = [["#6d28d9", "#be185d"], ["#1d4ed8", "#7c3aed"], ["#e11d48", "#f97316"], ["#0e7490", "#1e3a8a"], ["#c2410c", "#9d174d"], ["#4338ca", "#0ea5e9"], ["#be123c", "#6d28d9"]];
  var step = 0;
  function paint() {
    document.querySelectorAll(".lv-b3-slide").forEach(function (sl, i) {
      if (sl.classList.contains("s5")) return;     // WhatsApp keeps its own green
      var c = P[(step + i * 2) % P.length];
      sl.style.setProperty("--b3-a", c[0]); sl.style.setProperty("--b3-b", c[1]);
    });
  }
  new MutationObserver(function () { if (document.querySelector(".lv-b3-slide:not([style*='--b3-a'])")) paint(); }).observe(document.body, { childList: true, subtree: true });
  setInterval(function () { if (!document.hidden && !window.__lvDragging) { step++; paint(); } }, 9000);
  paint();
})();

/* ===== Empty pages (saved items, following): same lively "what to do next" cards as the Orders page ===== */
(function () {
  "use strict";
  var SETS = [
    { re: /^Nothing saved yet/i, acts: [["fa-bag-shopping", "Browse products", "home"], ["fa-store", "Find vendors", "vendors"]], steps: [["fa-heart", "Save it", "Tap the heart on anything you like", "#e11d48"], ["fa-bell", "Stay tuned", "Come back when you are ready", "#6d28d9"], ["fa-bag-shopping", "Buy it", "Order straight from your saved list", "#0e7490"]] },
    { re: /not following/i, acts: [["fa-store", "Find vendors", "vendors"], ["fa-trophy", "See who is winning", "leaderboard"]], steps: [["fa-store", "Pick a vendor", "Open a storefront you like", "#6d28d9"], ["fa-user-plus", "Follow", "One tap on the follow button", "#e11d48"], ["fa-bell", "Get updates", "New drops and deals reach you first", "#0e7490"]] }
  ];
  function dress() {
    document.querySelectorAll("#app .empty-state:not([data-lv-live])").forEach(function (el) {
      var t = (el.textContent || "").replace(/\s+/g, " ").trim(), set = SETS.filter(function (x) { return x.re.test(t); })[0];
      if (!set) return;
      el.setAttribute("data-lv-live", "1"); el.classList.add("orders-empty-live");
      el.insertAdjacentHTML("beforeend",
        '<div class="oe-actions">' + set.acts.map(function (a, i) { return '<button type="button" class="btn' + (i ? " btn-outline" : "") + '" onclick="navigate(\'' + a[2] + '\')"><i class="fa-solid ' + a[0] + '"></i> ' + a[1] + "</button>"; }).join("") + "</div>" +
        '<div class="oe-steps">' + set.steps.map(function (x, i) { return '<div class="oe-step" style="--oe:' + x[3] + ";animation-delay:" + i * 90 + 'ms"><span class="oe-ico"><i class="fa-solid ' + x[0] + '"></i></span><b>' + x[1] + "</b><small>" + x[2] + "</small></div>"; }).join("") + "</div>");
    });
  }
  new MutationObserver(function () { dress(); }).observe(document.body, { childList: true, subtree: true });
  dress();
})();


/* ===== Levi: the X always closes him (and Esc), even if something else swallowed the tap ===== */
(function () {
  "use strict";
  function closeLevi() {
    var p = document.getElementById("aiChatPanel");
    if (!p || p.classList.contains("hidden")) return;
    p.classList.add("hidden"); p.classList.remove("lv-full", "lv-side-open"); document.documentElement.classList.remove("lv-levi-full"); p.style.removeProperty("transform"); p.style.removeProperty("transition");
    try { syncLeviFabVisibility(); } catch (_) {}
    try { updateCartFab(); } catch (_) {}
  }
  function isX(e) { return e.target && e.target.closest && e.target.closest("#aiChatPanel .drawer-close-btn"); }
  document.addEventListener("click", function (e) { if (!isX(e)) return; e.preventDefault(); e.stopPropagation(); closeLevi(); }, true);
  document.addEventListener("touchend", function (e) { if (!isX(e)) return; if (e.cancelable) e.preventDefault(); e.stopPropagation(); closeLevi(); }, { capture: true, passive: false });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeLevi(); });
})();

/* ===== Home banners: once someone touches the row, it stays where they leave it (no more self-scrolling back) ===== */
(function () {
  "use strict";
  window.__lvCarTouchedAt = 0;
  // a pause can only get longer: the row's own short 8-second pause must not cancel the long one set when someone touches it
  var pauseOrig = window.homeCarouselPause;
  if (typeof pauseOrig === "function" && !window.__lvPauseMax) {
    window.__lvPauseMax = true;
    window.homeCarouselPause = function (ms) {
      try { var until = Date.now() + ms; if (until > homeCarouselResumeAt) homeCarouselResumeAt = until; } catch (_) { pauseOrig(ms); }
    };
  }
  function mine(e) { return e.target && e.target.closest && e.target.closest("#homePromotionalViewport"); }
  ["touchstart", "pointerdown", "wheel", "mousedown"].forEach(function (t) {
    document.addEventListener(t, function (e) {
      if (!mine(e)) return;
      window.__lvCarTouchedAt = Date.now();
      try { homeCarouselPause(10000); } catch (_) {}
    }, { passive: true, capture: true });
  });
})();

/* ===== Home: Trending products / services drift one card to the right every 10 seconds (stops while someone is using the row) ===== */
(function () {
  "use strict";
  var reduce = false; try { reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) {}
  if (reduce) return;
  var touched = new WeakMap();
  ["touchstart", "pointerdown", "wheel", "mousedown"].forEach(function (t) {
    document.addEventListener(t, function (e) { var row = e.target && e.target.closest && e.target.closest(".trending-scroll"); if (row) touched.set(row, Date.now()); }, { passive: true, capture: true });
  });
  setInterval(function () {
    if (document.hidden) return;
    document.querySelectorAll("#app .trending-scroll").forEach(function (row) {
      if (row.scrollWidth <= row.clientWidth + 8) return;                       // everything already fits
      var r = row.getBoundingClientRect(); if (r.bottom < 0 || r.top > window.innerHeight) return;   // off screen
      if (window.__lvDragging || Date.now() - (touched.get(row) || 0) < 30000) return;
      var first = row.firstElementChild, gap = parseFloat(getComputedStyle(row).columnGap) || 12;
      var step = first ? first.getBoundingClientRect().width + gap : row.clientWidth * 0.8;
      var atEnd = row.scrollLeft + row.clientWidth >= row.scrollWidth - 6;
      if (atEnd) return;   // never jumps back to the first card: the row keeps filling with more products instead
      try { row.scrollTo({ left: row.scrollLeft + step, behavior: "smooth" }); } catch (_) {}
    });
  }, 10000);
})();

/* ===== Always run the newest version: whenever the app comes back to the front, check for a newer release and refresh once ===== */
(function () {
  "use strict";
  var link = document.querySelector('link[href*="01-base.css"]');
  var m = link && /[?&]v=(\d+)/.exec(link.getAttribute("href") || "");
  var running = m ? m[1] : null;
  if (!running) return;
  var hiddenAt = 0, lastCheck = 0;
  function busy() {
    var a = document.activeElement;
    return !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.value);
  }
  async function check(force) {
    if (Date.now() - lastCheck < (force ? 0 : 90000)) return;
    lastCheck = Date.now();
    try {
      var reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
      if (reg) reg.update().catch(function () {});
      var r = await fetch("/sw.js?lvv=" + Date.now(), { cache: "no-store" });
      var t = await r.text(), n = /shell-v(\d+)/.exec(t);
      if (!n || n[1] === running) return;
      var key = "lv-updated-to"; var done = ""; try { done = sessionStorage.getItem(key) || ""; } catch (_) {}
      if (done === n[1] || busy()) return;           // only once per release, never while someone is typing
      try { sessionStorage.setItem(key, n[1]); } catch (_) {}
      try { showToast("Updating Levromart…", "info"); } catch (_) {}
      setTimeout(function () { location.reload(); }, 600);
    } catch (_) {}
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > 15000) check(true);
  });
  window.addEventListener("pageshow", function (e) { if (e.persisted) check(true); });
  setTimeout(function () { check(true); }, 4000);          // shortly after opening
  setInterval(function () { if (!document.hidden) check(false); }, 300000);
})();

/* ---- Vendor-of-the-week banners: the products come up one after another when the banner slides into view ---- */
(function(){
  if(!("IntersectionObserver" in window)) return;
  var io=null, seen=new WeakSet();
  function mk(vp){
    io=new IntersectionObserver(function(es){ es.forEach(function(e){ e.target.classList.toggle("lv-wv-live",e.isIntersecting&&e.intersectionRatio>=0.55); }); },{root:vp||null,threshold:[0,0.55,0.8]});
  }
  function scan(){
    var vp=document.getElementById("homePromotionalViewport");
    var list=document.querySelectorAll(".lv-wv.lv-wv-a,.lv-wv.lv-wv-b,.lv-wv.lv-wv-c,.lv-wv.lv-wv-o"); if(!list.length) return;
    if(!io||io.__vp!==vp){ if(io) io.disconnect(); mk(vp); io.__vp=vp; seen=new WeakSet(); }
    document.documentElement.classList.add("lv-stag");
    list.forEach(function(s){ if(!seen.has(s)){ seen.add(s); io.observe(s); } });
  }
  var q=0; new MutationObserver(function(){ if(q) return; q=setTimeout(function(){ q=0; scan(); },80); }).observe(document.documentElement,{childList:true,subtree:true});
  scan();
})();

/* ---- Shop location: pick a point on the map once; it stays until the owner changes it ---- */
(function () {
  var esc2 = function (t) { return String(t == null ? "" : t).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  function campusName() {
    try { var id = window.lvMyCampusId && window.lvMyCampusId(); if (!id || id === "none") return ""; var r = window.lvCampusById && window.lvCampusById(id); return r ? r.name + (r.city ? ", " + r.city : "") : ""; } catch (_) { return ""; }
  }
  function geocode(q) {
    if (!q) return Promise.resolve(null);
    return fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ng&q=" + encodeURIComponent(q), { headers: { Accept: "application/json" } })
      .then(function (r) { return r.json(); }).then(function (a) { return a && a[0] ? { lat: Number(a[0].lat), lng: Number(a[0].lon), name: a[0].display_name } : null; }).catch(function () { return null; });
  }
  window.lvPickShopLocation = function (opts) {
    opts = opts || {};
    var old = document.getElementById("lvLocPick"); if (old) old.remove();
    var w = document.createElement("div"); w.id = "lvLocPick"; w.className = "lvlp";
    var school = opts.school || campusName();
    w.innerHTML = '<div class="lvlp-map" id="lvlpMap"></div><div class="lvlp-pin" aria-hidden="true"><i class="fa-solid fa-location-dot"></i></div>' +
      '<div class="lvlp-top"><button type="button" class="lvlp-x" aria-label="Close"><i class="fa-solid fa-xmark"></i></button><div class="lvlp-search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" id="lvlpQ" placeholder="Search your school or area" value="' + esc2(school) + '" autocomplete="off"></div></div>' +
      '<div class="lvlp-card"><strong>Set your shop location</strong><p>Drag the map so the pin sits exactly where your shop is. This stays your location until you change it yourself.</p>' +
      '<div class="lvlp-row"><button type="button" class="lvlp-alt" id="lvlpMe"><i class="fa-solid fa-location-crosshairs"></i> Use my location now</button>' + (school ? '<button type="button" class="lvlp-alt" id="lvlpSchool"><i class="fa-solid fa-graduation-cap"></i> My school</button>' : "") + '</div>' +
      '<button type="button" class="lvlp-save" id="lvlpSave"><i class="fa-solid fa-check"></i> Save this location</button></div>';
    document.body.appendChild(w); document.documentElement.style.overflow = "hidden";
    var map = null, close = function () { try { map && map.remove(); } catch (_) {} w.remove(); document.documentElement.style.overflow = ""; };
    w.querySelector(".lvlp-x").onclick = close;
    var go = function (lat, lng, z) { if (map) map.setView([lat, lng], z || 16, { animate: true }); };
    (typeof loadLeaflet === "function" ? loadLeaflet() : Promise.resolve()).then(function () {
      var start = opts.lat != null && opts.lng != null ? [Number(opts.lat), Number(opts.lng)] : [6.5244, 3.3792];
      map = window.L.map("lvlpMap", { zoomControl: false, attributionControl: true, tap: false }).setView(start, opts.lat != null ? 17 : 12);
      map.attributionControl.setPrefix(false);
      (typeof addBasemapTileLayer === "function" ? addBasemapTileLayer(map) : window.L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap contributors", maxZoom: 19 }).addTo(map));
      if (opts.lat == null && school) geocode(school).then(function (g) { if (g) go(g.lat, g.lng, 16); });
    });
    var q = w.querySelector("#lvlpQ"), t = null;
    var run = function () { geocode(q.value.trim()).then(function (g) { if (g) go(g.lat, g.lng, 16); else try { showToast("Couldn't find that place. Try a nearby landmark.", "info"); } catch (_) {} }); };
    q.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); run(); q.blur(); } });
    var sb2 = w.querySelector("#lvlpSchool"); if (sb2) sb2.onclick = function () { q.value = school; run(); };
    w.querySelector("#lvlpMe").onclick = function () {
      var b = this; b.disabled = true;
      (typeof getCurrentPositionOnce === "function" ? getCurrentPositionOnce() : Promise.reject(new Error("Location is not available on this device.")))
        .then(function (l) { go(l.lat, l.lng, 17); }).catch(function (e) { try { showToast((e && e.message) || "Couldn't get your location.", "error"); } catch (_) {} }).then(function () { b.disabled = false; });
    };
    w.querySelector("#lvlpSave").onclick = function () {
      if (!map) return; var c = map.getCenter(); var out = { lat: Number(c.lat.toFixed(6)), lng: Number(c.lng.toFixed(6)) };
      Promise.resolve(opts.onSave && opts.onSave(out)).then(function () { close(); }).catch(function (e) { try { showToast((e && e.message) || "Couldn't save.", "error"); } catch (_) {} });
    };
  };
  /* the application form gets a "Shop location" block under the address */
  var prev = window.renderVendorApply;
  if (typeof prev === "function") window.renderVendorApply = async function () {
    window.__vaLoc = null;
    var html = await prev.apply(this, arguments); html = String(html || "");
    if (html.indexOf('id="vaAddress"') < 0 || html.indexOf("vaLocBlock") >= 0) return html;
    var block = '<div class="va-loc" id="vaLocBlock"><div class="va-loc-ic"><i class="fa-solid fa-location-dot"></i></div><div class="va-loc-t"><strong>Shop location</strong><span id="vaLocText">Pick the point on the map where you are. Students: it starts at your school.</span></div><button type="button" class="va-loc-btn" onclick="vaPickLocation()">Set on map</button></div>';
    return html.replace(/(<input id="vaAddress"[^>]*\/?>)/i, "$1" + block);
  };
  window.vaPickLocation = function () {
    lvPickShopLocation({ lat: window.__vaLoc && window.__vaLoc.lat, lng: window.__vaLoc && window.__vaLoc.lng, onSave: function (l) {
      window.__vaLoc = l; var t = document.getElementById("vaLocText"); if (t) t.textContent = "Location saved. You can change it later in your business profile.";
      var b = document.querySelector("#vaLocBlock .va-loc-btn"); if (b) b.textContent = "Change";
      document.getElementById("vaLocBlock")?.classList.add("ok");
    } });
  };
})();

/* ---- Tabs react at once: the bottom bar lights the tapped tab inside the tap, and the vendors map strip is rebuilt after the page is on screen ---- */
(function(){
  document.addEventListener("click",function(e){
    var b=e.target&&e.target.closest&&e.target.closest("#bottomNav .bottom-nav-item"); if(!b) return;
    document.querySelectorAll("#bottomNav .bottom-nav-item").forEach(function(x){ x.classList.toggle("active",x===b); });
  },true);
  var rt=0;
  function wrapRail(){
    var r=window.renderVendorMapRail; if(typeof r!=="function"||r.__lvLazy) return;
    var w=function(){
      var wrap=document.getElementById("vendorsMapWrap"), self=this, args=arguments;
      if(wrap&&wrap.classList.contains("hidden")){ clearTimeout(rt); rt=setTimeout(function(){ r.apply(self,args); },900); return; }
      return r.apply(this,args);
    };
    w.__lvLazy=true; window.renderVendorMapRail=w;
  }
  wrapRail(); setTimeout(wrapRail,1500);
})();

/* ---- a thin line on top of the bottom bar slides to the tab you tap (and the page slides in the same direction) ---- */
(function(){
  var lastG=null;
  function geo(nav,it){ var n=nav.getBoundingClientRect(), r=it.getBoundingClientRect(), w=Math.max(0,r.width-8); return {x:r.left-n.left+4,w:w}; }
  function put(nav,animate){
    if(!nav) return;
    var it=nav.querySelector(".bottom-nav-item.active"), ind=nav.querySelector(".bn-ind");
    if(!ind){ ind=document.createElement("i"); ind.className="bn-ind"; ind.setAttribute("aria-hidden","true"); nav.appendChild(ind); }
    if(!it){ ind.style.opacity="0"; return; }
    var g=geo(nav,it); if(!g.w) return;
    ind.style.opacity="1";
    if(lastG&&animate!==false){ ind.style.transition="none"; ind.style.width=lastG.w+"px"; ind.style.transform="translateX("+lastG.x+"px)"; void ind.offsetWidth; }
    ind.style.transition="transform .24s cubic-bezier(.22,.9,.3,1),width .24s cubic-bezier(.22,.9,.3,1)";
    ind.style.width=g.w+"px"; ind.style.transform="translateX("+g.x+"px)";
    lastG=g;
  }
  function wrap(){
    var r=window.renderBottomNav; if(typeof r!=="function"||r.__lvInd) return;
    var w=function(){ var out=r.apply(this,arguments); try{ requestAnimationFrame(function(){ try{ put(document.getElementById("bottomNav"),true); }catch(_){} }); }catch(_){} return out; };
    w.__lvInd=true; window.renderBottomNav=w;
  }
  wrap(); setTimeout(wrap,800);
  document.addEventListener("click",function(e){
    var b=e.target&&e.target.closest&&e.target.closest("#bottomNav .bottom-nav-item"); if(!b) return;
    requestAnimationFrame(function(){ put(document.getElementById("bottomNav"),true); });
  },true);
  window.addEventListener("resize",function(){ lastG=null; put(document.getElementById("bottomNav"),false); });
  setTimeout(function(){ put(document.getElementById("bottomNav"),false); },1200);
})();

/* ===== Vendor wallet: what Levromart is holding, what is on its way to the bank, what has been paid out ===== */
(function () {
  "use strict";
  var HIDE = "lv-wallet-hide", TTL = 45000;
  var cache = null, loading = null, filter = "all", tab = "tx";
  // amounts are hidden every time the app is opened; showing them lasts only until the app is closed
  var revealed = false;
  function hidden() { return !revealed; }
  function setHidden(v) { revealed = !v; }
  function money(n) { return hidden() ? "₦ ••••" : "₦" + Number(n || 0).toLocaleString("en-NG", { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
  function when(d) { try { return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + ", " + new Date(d).toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit" }); } catch (_) { return ""; } }

  var FEE_TYPES = { sale_price: 1, rental_fee: 1, delivery_deposit_20: 1 };
  function storeKey() { return "lv-wallet-v1:" + ((typeof vendor !== "undefined" && vendor && vendor.id) || ""); }
  function readStored() {
    try { var r = JSON.parse(localStorage.getItem(storeKey()) || "null"); if (r && r.data) { cache = { at: 0, data: r.data }; } } catch (_) {}
  }
  function writeStored(data) {
    try { var d = Object.assign({}, data, { tx: data.tx.slice(0, 80), charges: data.charges.slice(0, 80) }); localStorage.setItem(storeKey(), JSON.stringify({ at: Date.now(), data: d })); } catch (_) {}
  }
  async function load(force) {
    if (!cache) readStored();
    if (!force && cache && Date.now() - cache.at < TTL) return cache.data;
    if (loading) return loading;
    loading = (async function () {
      var v = typeof vendor !== "undefined" ? vendor : null;
      if (!v || !v.id) return null;
      var res = await Promise.all([
        sb.from("orders").select("id,status,created_at,completed_at,items:order_items(quantity,product:products(name)),payments(payment_type,amount,status,method,provider_reference,paid_at)").eq("vendor_id", v.id).neq("status", "cancelled").order("created_at", { ascending: false }).limit(150),
        sb.from("vendor_payouts").select("order_id,amount_kobo,status,hold_reason,last_error,withdrawal_id,created_at,updated_at").eq("vendor_id", v.id),
        sb.from("commission_charges").select("order_id,amount,status,created_at,paid_at").eq("vendor_id", v.id).order("created_at", { ascending: false }).limit(300),
        sb.rpc("get_vendor_commission_owed", { p_vendor_id: v.id }),
        sb.rpc("get_vendor_commission_deadline", { p_vendor_id: v.id }),
        sb.from("withdrawal_requests").select("id,status,kind,amount_kobo,has_dispute,reject_reason,created_at,decided_at").eq("vendor_id", v.id).order("created_at", { ascending: false }).limit(30),
        // money given back to buyers comes off the shop's wallet (the shop's share, after commission)
        sb.from("paystack_refunds").select("order_id,amount_kobo,status").neq("status", "failed").limit(500)
      ]);
      var orders = (res[0] && res[0].data) || [], payouts = (res[1] && res[1].data) || [], charges = (res[2] && res[2].data) || [];
      var owed = Number((res[3] && res[3].data) || 0), dueAt = res[4] && res[4].data && res[4].data[0] ? res[4].data[0].earliest_due_at : null;
      var payoutBy = {}; payouts.forEach(function (p) { payoutBy[p.order_id] = p; });
      var commBy = {}; charges.forEach(function (c) { commBy[c.order_id] = (commBy[c.order_id] || 0) + Number(c.amount || 0); });
      var requests = (res[5] && res[5].data) || [];
      var refundBy = {}; ((res[6] && res[6].data) || []).forEach(function (r) { refundBy[r.order_id] = (refundBy[r.order_id] || 0) + Number(r.amount_kobo || 0) / 100; });
      var tx = [], pending = 0, onWay = 0, paidOut = 0, ready = 0, held = 0, asked = 0, heldReason = "", delayed = 0;
      orders.forEach(function (o) {
        var paid = (o.payments || []).filter(function (p) { return p.status === "paid" && FEE_TYPES[p.payment_type] && (p.method === "card" || /^(lvm_ord_|medris_)/.test(String(p.provider_reference || ""))); });
        if (!paid.length) return;
        var gross = paid.reduce(function (s, p) { return s + Number(p.amount || 0); }, 0);
        var legacyPay = paid.every(function (p) { return /^medris_/.test(String(p.provider_reference || "")); });
        // Levromart's 3% is taken the moment the order is paid, so the shop only ever sees its 97%
        var comm = commBy[o.id] != null ? commBy[o.id] : (legacyPay || o.commission_exempt ? 0 : Math.round(gross * 3) / 100), back = refundBy[o.id] || 0, net = Math.max(0, gross - comm - back);
        var at = paid.map(function (p) { return p.paid_at; }).filter(Boolean).sort().pop() || o.created_at;
        var legacy = paid.every(function (p) { return /^medris_/.test(String(p.provider_reference || "")); });
        var pay = payoutBy[o.id], state, amount = net, date = at;
        if (legacy) {   // the older checkout: Paystack pays the shop's bank directly, the next business day
          state = Date.now() - new Date(at).getTime() < 2 * 86400000 ? "onway" : "paid";
        } else if (pay) {
          if (pay.status === "success" || pay.status === "paid_manually") { state = "paid"; if (Number(pay.amount_kobo) > 0) amount = Number(pay.amount_kobo) / 100; date = pay.updated_at || pay.created_at; }
          else if (pay.status === "on_hold" && pay.hold_reason === "Waiting for the vendor to withdraw") state = o.status === "disputed" ? "held" : pay.withdrawal_id ? "asked" : "ready";
          else if (pay.status === "on_hold") { state = "held"; if (!heldReason) heldReason = pay.hold_reason || ""; }
          else { state = "onway"; if (pay.status === "pending" && pay.last_error === "Paystack balance too low") delayed += amount; }
        } else if (o.status === "disputed") state = "held";
        else if (o.status === "completed") state = "onway";
        else state = "pending";
        if (state === "pending") pending += amount; else if (state === "ready") ready += amount; else if (state === "held") held += amount; else if (state === "asked") asked += amount; else if (state === "onway") onWay += amount; else paidOut += amount;
        var names = (o.items || []).map(function (i) { return i && i.product && i.product.name; }).filter(Boolean);
        var title = names.length ? names[0] + (names.length > 1 ? " +" + (names.length - 1) + " more" : "") : "Order";
        tx.push({ id: o.id, state: state, amount: amount, gross: gross, comm: comm, refunded: back, date: date, title: title });
      });
      tx.sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
      var commissionTotal = charges.reduce(function (s, c) { return s + (c.status === "waived" ? 0 : Number(c.amount || 0)); }, 0);
      var hasPayout = typeof window.vendorHasPayoutAccount === "function" ? window.vendorHasPayoutAccount(v) : !!(v && (v.paystack_subaccount_code || v.transfer_recipient_code || v.payout_verified_at || (v.account_number && v.bank_code)));
      var data = { pending: pending, ready: ready, held: held, requests: requests, asked: asked, heldReason: heldReason, onWay: onWay, delayed: delayed, paidOut: paidOut, tx: tx, charges: charges, owed: owed, dueAt: dueAt, commissionTotal: commissionTotal, rate: Number(v.commission_pct ?? 3), hasPayout: hasPayout };
      cache = { at: Date.now(), data: data };
      writeStored(data);
      return data;
    })().catch(function () { return null; }).finally(function () { loading = null; });
    return loading;
  }

  var LABEL = { pending: "Pending", ready: "Ready to withdraw", asked: "Awaiting approval", held: "On hold (dispute)", onway: "On its way", paid: "Paid out" };
  function card(d, compact) {
    // the one Levromart wallet takes this place once the server has it (the older card stays until then)
    if (window.lvWalletCardHtml) { var h3 = window.lvWalletCardHtml("shop", d); if (h3) return h3; }
    var eye = hidden();
    var balance = d ? d.pending + d.onWay + (d.ready || 0) + (d.held || 0) + (d.asked || 0) : 0;
    var last = d && d.tx && d.tx[0];
    var notes = "";
    if (d && d.held > 0) notes += '<div class="lvw-note"><i class="fa-solid fa-scale-balanced"></i> <b>' + money(d.held) + '</b> on hold' + (d.heldReason ? ' · ' + esc(d.heldReason) : ' · dispute') + '</div>';
    if (d && d.asked > 0) notes += '<div class="lvw-note"><i class="fa-solid fa-hourglass-half"></i> <b>' + money(d.asked) + '</b> waiting for Levromart to approve</div>';
    if (d && d.delayed > 0) notes += '<div class="lvw-note"><i class="fa-solid fa-calendar-day"></i> <span><b>' + money(d.delayed) + '</b> arrives in your bank next business day.</span></div>';
    var ICO = { paid: "fa-arrow-down-long", onway: "fa-paper-plane", ready: "fa-wallet", asked: "fa-user-clock", held: "fa-scale-balanced", pending: "fa-hourglass-half" };
    return '<div class="lvw-card lvw2' + (compact ? " is-compact" : "") + '">' +
      '<div class="lvw-top"><span class="lvw-label"></span>' +
      '<button type="button" class="lvw-help" onclick="lvWalletHow()" aria-label="How your wallet works and wallet colour"><i class="fa-solid fa-circle-question"></i></button>' +
      '<span class="lvw-top-sp"></span>' +
      '<button type="button" class="lvw-eye" onclick="lvWalletToggle()" aria-label="' + (eye ? "Show amounts" : "Hide amounts") + '"><i class="fa-regular ' + (eye ? "fa-eye-slash" : "fa-eye") + '"></i></button></div>' +
      '<div class="lvw-bal-label">Not yet in your bank</div>' +
      '<div class="lvw-bal">' + (d ? money(balance) : '<span class="lvw-skel"></span>') + '</div>' +
      '<div class="lvw-mini">' +
        '<span><i class="lvw-dot pending"></i>Pending <b>' + (d ? money(d.pending) : "—") + '</b></span>' +
        '<span><i class="lvw-dot ready"></i>Ready <b>' + (d ? money(d.ready) : "—") + '</b></span>' +
        '<span><i class="lvw-dot onway"></i>On its way <b>' + (d ? money(d.onWay) : "—") + '</b></span>' +
      '</div>' + notes +
      '<div class="lvw-foot"><div class="lvw-foot-l"><small>Paid out so far</small><b>' + (d ? money(d.paidOut) : "—") + '</b></div>' +
      '<button type="button" class="lvw-btn lvw-btn-withdraw" onclick="lvWalletWithdraw()"><i class="fa-solid fa-building-columns"></i> Withdraw</button></div>' +
      // one slim strip, like Opay: "Transaction history", the latest one in short, and an arrow
      '<button type="button" class="lvw-strip" onclick="lvWalletOpen(\'tx\')"><i class="fa-solid fa-clock-rotate-left lvw-strip-ic"></i><span class="lvw-strip-t">Transaction history</span>' +
        (last ? '<span class="lvw-strip-last"><span class="lvw-strip-nm">' + esc(last.title) + '</span><b>' + money(last.amount) + '</b></span>' : "") +
        '<i class="fa-solid fa-chevron-right lvw-strip-go"></i></button>' +
      (d && !d.hasPayout ? '<button type="button" class="lvw-warn" onclick="lvGoToPayout()"><i class="fa-solid fa-triangle-exclamation"></i> Add your bank account so we can pay you <i class="fa-solid fa-chevron-right"></i></button>' : "") +
    '</div>';
  }
  window.lvWalletRepaint = function () { paint(); };
  window.lvWalletReload = function () { return load(true).then(paint); };
  function paint() {
    if (!cache) readStored();
    var d = cache && cache.data;
    document.querySelectorAll("[data-lv-wallet]").forEach(function (el) {
      var html = card(d, el.getAttribute("data-lv-wallet") === "compact");
      if (el.__lvwHtml !== html) { el.innerHTML = html; el.__lvwHtml = html; }   // only touch the page when something really changed: no blinking
    });
    var pg = document.getElementById("lvwPageBody");
    if (pg) { var ph = pageBody(); if (pg.__lvwHtml !== ph) { pg.innerHTML = ph; pg.__lvwHtml = ph; } }
  }
  async function refresh(force) {
    if (typeof vendor === "undefined" || !vendor) return;
    paint();
    startLive();
    await load(force);
    paint();
  }

  // ---- live: the wallet follows the database as it changes (a payment lands, an order completes, a payout is sent)
  var liveFor = null, liveChannel = null, liveTimer = 0, lastLive = 0;
  function liveRefresh() {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(function () {
      if (!document.querySelector("[data-lv-wallet]")) return;
      lastLive = Date.now();
      load(true).then(function () { paint(); flash(); });
    }, 500);
  }
  function flash() { document.querySelectorAll(".lvw-bal").forEach(function (e) { e.classList.remove("lvw-flash"); void e.offsetWidth; e.classList.add("lvw-flash"); }); }
  function startLive() {
    try {
      if (typeof vendor === "undefined" || !vendor || !vendor.id || typeof sb === "undefined" || !sb.channel) return;
      if (liveFor === vendor.id && liveChannel) return;
      if (liveChannel) { try { sb.removeChannel(liveChannel); } catch (_) {} }
      liveFor = vendor.id;
      var uid = session && session.user && session.user.id;
      var ch = sb.channel("wallet-" + vendor.id)
        .on("postgres_changes", { event: "*", schema: "public", table: "orders", filter: "vendor_id=eq." + vendor.id }, liveRefresh)
        .on("postgres_changes", { event: "*", schema: "public", table: "payments" }, liveRefresh)
        .on("postgres_changes", { event: "*", schema: "public", table: "vendor_payouts", filter: "vendor_id=eq." + vendor.id }, liveRefresh)
        .on("postgres_changes", { event: "*", schema: "public", table: "withdrawal_requests", filter: "vendor_id=eq." + vendor.id }, liveRefresh)
        .on("postgres_changes", { event: "*", schema: "public", table: "commission_charges", filter: "vendor_id=eq." + vendor.id }, liveRefresh);
      if (uid) ch = ch.on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: "user_id=eq." + uid }, liveRefresh);
      liveChannel = ch.subscribe();
    } catch (_) {}
  }
  // safety net: if a change is missed (a dropped connection, a table that does not broadcast), the wallet still catches up
  setInterval(function () { if (document.hidden) return; startLive(); if (document.querySelector("[data-lv-wallet]") && Date.now() - lastLive > 10000) liveRefresh(); }, 5000);   // also checks every few seconds, in case the live channel misses a change
  document.addEventListener("visibilitychange", function () { if (!document.hidden && document.querySelector("[data-lv-wallet]")) liveRefresh(); });
  window.addEventListener("online", liveRefresh);
  window.lvWalletToggle = function () { setHidden(!hidden()); paint(); };

  // ---- the wallet page: Transactions and Commission tabs
  function txList(d) {
    var chips = [["all", "All"], ["pending", "Pending"], ["ready", "Ready"], ["onway", "On its way"], ["paid", "Paid out"]];
    var rows = d.tx.filter(function (t) { return filter === "all" || t.state === filter; });
    return '<div class="lvw-chips lvw-fchips">' + chips.map(function (c) { return '<button type="button" class="lvw-chip' + (filter === c[0] ? " on" : "") + '" onclick="lvWalletFilter(\'' + c[0] + '\')">' + c[1] + '</button>'; }).join("") + '</div>' +
      (rows.length ? '<ul class="lvw-list">' + rows.map(function (t) {
        return '<li onclick="navigate(\'orderDetail\',{orderId:\'' + esc(t.id) + '\'})"><span class="lvw-ico lvw-ico3d ' + t.state + '">' + (window.lv3dIcon ? window.lv3dIcon({ paid: "tx-paid", onway: "tx-onway", ready: "tx-ready", asked: "tx-pending", held: "dispute", pending: "tx-pending" }[t.state] || "tx-pending", 34) : "") + '</span>' +
          '<div class="lvw-li"><strong>' + esc(t.title) + '</strong><small>#' + esc(String(t.id).slice(0, 8).toUpperCase()) + " · " + LABEL[t.state] + " · " + esc(when(t.date)) + '</small>' + ((t.comm || t.refunded) ? '<small>Sale ' + esc(money(t.gross)) + (t.comm ? ' − commission ' + esc(money(t.comm)) : "") + (t.refunded ? ' − refunded ' + esc(money(t.refunded)) : "") + '</small>' : "") + '</div>' +
          '<b class="lvw-amt ' + t.state + '">' + money(t.amount) + '</b></li>';
      }).join("") + '</ul>' : '<div class="lvw-empty"><i class="fa-regular fa-credit-card"></i><strong>Nothing here yet</strong><span>Payments made through Levromart appear here.</span></div>');
  }
  function commissionPane(d) {
    var rows = d.charges.slice(0, 60);
    return '<div class="lvw-comm"><div class="lvw-comm-top lvw-comm-two"><div><span>Commission rate</span><b>' + esc(String(d.rate)) + '%</b></div><div><span>Taken from</span><b>Each payout</b></div></div>' +
      '<h4 class="lvw-h4">Commission per order</h4>' +
      (rows.length ? '<ul class="lvw-list">' + rows.map(function (c) {
        return '<li' + (c.order_id ? ' onclick="navigate(\'orderDetail\',{orderId:\'' + esc(c.order_id) + '\'})"' : "") + '><span class="lvw-ico paid"><i class="fa-solid fa-percent"></i></span><div class="lvw-li"><strong>' + (c.order_id ? "Order #" + esc(String(c.order_id).slice(0, 8).toUpperCase()) : "Commission") + '</strong><small>' + esc(when(c.paid_at || c.created_at)) + '</small></div><b class="lvw-amt pending">' + money(c.amount) + '</b></li>';
      }).join("") + '</ul>' : '<div class="lvw-empty"><i class="fa-solid fa-percent"></i><strong>No commission yet</strong><span>Levromart takes ' + esc(String(d.rate)) + '% of each completed sale.</span></div>') + '</div>';
  }
  var W_LABEL = { requested: "Waiting for approval", approved: "Approved", rejected: "Not approved" };
  function withdrawalsPane(d) {
    var rows = d.requests || [];
    return rows.length ? '<ul class="lvw-list">' + rows.map(function (r) {
      var st = r.status === "approved" ? "paid" : r.status === "rejected" ? "held" : "asked";
      return '<li><span class="lvw-ico ' + st + '"><i class="fa-solid ' + (r.status === "approved" ? "fa-check" : r.status === "rejected" ? "fa-xmark" : "fa-user-clock") + '"></i></span><div class="lvw-li"><strong>' + (r.kind === "instant" ? "Sent to your bank" : "Withdrawal request") + '</strong><small>' + esc(W_LABEL[r.status] || r.status) + " · " + esc(when(r.created_at)) + '</small>' +
        (r.status === "rejected" && r.reject_reason ? '<small class="lvw-reject">Reason: ' + esc(r.reject_reason) + '</small>' : "") + '</div><b class="lvw-amt ' + st + '">' + money(Number(r.amount_kobo) / 100) + '</b></li>';
    }).join("") + '</ul>' : '<div class="lvw-empty"><i class="fa-solid fa-building-columns"></i><strong>No withdrawals yet</strong><span>Tap Withdraw on your wallet when money is ready.</span></div>';
  }
  function pageBody() {
    if (!cache) readStored();
    var d = cache && cache.data;
    if (!d) return '<p class="muted" style="text-align:center;padding:1.5rem 0">Loading…</p>';
    return '<div class="lvw-tabs"><button type="button" class="' + (tab === "tx" ? "on" : "") + '" onclick="lvWalletOpen(\'tx\')">Transactions</button><button type="button" class="' + (tab === "withdrawals" ? "on" : "") + '" onclick="lvWalletOpen(\'withdrawals\')">Withdrawals</button></div>' +
      (tab === "withdrawals" ? withdrawalsPane(d) : txList(d));
  }
  window.lvWalletFilter = function (f) { filter = f; paint(); };
  window.lvWalletOpen = function (t) { tab = t || "tx"; if (typeof currentView !== "undefined" && currentView === "vendorWallet") paint(); else { window.__lvWalletTab = tab; navigate("vendorWallet"); } };
  window.renderVendorWallet = async function () {
    if (typeof session === "undefined" || !session || typeof vendor === "undefined" || !vendor) return '<div class="empty-state">Access denied.</div>';
    if (window.__lvWalletTab) { tab = window.__lvWalletTab; window.__lvWalletTab = null; }
    setTimeout(function () { refresh(true); }, 30);
    return '<div class="lvw-page"><div class="lvw-page-head"><button type="button" class="lvw-back" onclick="navigate(\'vendorDashboard\')" aria-label="Back"><i class="fa-solid fa-arrow-left"></i></button><h2>Wallet</h2></div>' +
      '<div class="lvw" data-lv-wallet="page">' + card((cache || (readStored(), cache)) && cache.data, false) + '</div><div id="lvwPageBody">' + pageBody() + '</div></div>';
  };
  window.lvGoToPayout = function () {
    var go = function () {
      var sec = document.getElementById("payoutSection"); if (!sec) return false;
      var wrap = document.getElementById("bankFormWrap"); if (wrap) wrap.classList.remove("hidden");
      sec.scrollIntoView({ behavior: "smooth", block: "start" });
      setTimeout(function () { var i = document.getElementById("veAccountNumber"); if (i) { try { i.focus({ preventScroll: true }); } catch (_) {} } }, 500);
      return true;
    };
    if (typeof currentView !== "undefined" && currentView === "vendorEditProfile" && go()) return;
    Promise.resolve(navigate("vendorEditProfile")).then(function () { var n = 0; var t = setInterval(function () { if (go() || ++n > 30) clearInterval(t); }, 150); });
  };

  function openSheet(title, bodyHtml) {
    var old = document.getElementById("lvwSheet"); if (old) old.remove();
    var m = document.createElement("div");
    m.id = "lvwSheet"; m.className = "lvw-sheet-wrap";
    m.innerHTML = '<div class="lvw-sheet" role="dialog" aria-modal="true"><div class="lvw-sheet-grab" aria-hidden="true"></div><div class="lvw-sheet-head"><h3>' + esc(title) + '</h3><button type="button" class="lvw-eye lvw-eye-dark" onclick="document.getElementById(\'lvwSheet\').remove()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div><div class="lvw-sheet-body">' + bodyHtml + '</div></div>';
    m.addEventListener("click", function (e) { if (e.target === m) m.remove(); });
    document.body.appendChild(m);
  }
  var NOW = function (n) { return "₦" + Number(n / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 }); };
  window.lvWalletWithdraw = async function () {
    openSheet("Withdraw", '<p class="muted" style="text-align:center">Checking your wallet…</p>');
    var body = document.querySelector("#lvwSheet .lvw-sheet-body");
    var r = await sb.rpc("get_withdrawal_summary");
    if (!body) return;
    if (r.error || !r.data) { body.innerHTML = '<p class="lvw-sheet-msg">' + esc((r.error && r.error.message) || "Withdrawals are not available right now. Please try again shortly.") + "</p>"; return; }
    var s = r.data, inst = Number(s.instant_kobo), appr = Number(s.approval_kobo), held = Number(s.held_kobo), min = Number(s.min_kobo);
    var canInst = inst >= min, small = !canInst && inst > 0;
    var askAmt = appr + (canInst ? 0 : inst), canAsk = !s.open_request && askAmt > 0;
    if (!canInst) { appr = askAmt; inst = 0; }
    var h = '<div class="lvw-wd">';
    if (s.blocked) h += '<p class="lvw-sheet-msg lvw-sheet-warn"><i class="fa-solid fa-shield-halved"></i> ' + esc(s.blocked) + "</p>";
    h += '<div class="lvw-wd-row"><span>You can withdraw now</span><b>' + NOW(inst) + '</b></div><small>Money from product payments that reached your account more than 24 hours ago.</small>' +
      '<div class="lvw-wd-row"><span>Came in during the last 24 hours</span><b>' + NOW(appr) + '</b></div><small>Money from product payments that came in during the last 24 hours. It is released after 24 hours so a buyer who reports a scam can still be refunded. You can ask Levromart to release it sooner.</small>' +
      '<small>Paystack\'s charge for sending money to your bank is taken from each payout.</small>';
    if (held > 0) h += '<div class="lvw-wd-row lvw-wd-held"><span>On hold (disputed order)</span><b>' + NOW(held) + '</b></div><small>This stays held until the dispute is settled. The rest of your money is not affected.</small>';
    if (s.open_request) h += '<p class="lvw-sheet-msg"><i class="fa-solid fa-user-clock"></i> You already have a request of ' + NOW(Number(s.open_request.amount_kobo)) + ' waiting for approval.</p>';
    if (s.recent_bank_change != null && !s.blocked) h += '<p class="lvw-sheet-msg lvw-sheet-warn"><i class="fa-solid fa-shield-halved"></i> You changed your bank account recently, so Levromart checks every withdrawal first. It can still be approved.</p>';
    else if (small || (!canInst && appr > 0 && appr < min)) h += '<p class="lvw-sheet-msg">Amounts under ' + NOW(min) + ' are checked by Levromart before they are sent.</p>';
    if (!canInst && !canAsk && !s.blocked && !s.open_request) h += '<p class="lvw-sheet-msg">There is no money ready to withdraw yet.</p>';
    var total = (canInst ? inst : 0) + (canAsk ? appr : 0);
    h += '<button type="button" class="btn lvw-wd-go" id="lvwWdGo"' + (s.blocked || total <= 0 ? " disabled" : "") + '>' + (total > 0 ? "Withdraw " + NOW(total) : "Nothing to withdraw") + "</button></div>";
    body.innerHTML = h;
    var go = document.getElementById("lvwWdGo"); if (!go || go.disabled) return;
    go.onclick = async function () {
      if (s.has_dispute) {
        var ok = await showConfirmDialog("One of your orders has a dispute. The money for that order stays on hold until the dispute is settled. You can still withdraw the rest, and Levromart will see the dispute when it checks your request.", { title: "Disputed order", okLabel: "Continue" });
        if (!ok) return;
      }
      go.disabled = true; go.textContent = "Please wait…";
      var pin = await window.lvPinGate({ title: "Withdraw to your bank", rows: [["Sent to your bank now", NOW(total), 1]].concat(appr > 0 && canAsk ? [["Waiting for Levromart (paid in the last 24 hours)", NOW(appr)]] : []), cta: "Withdraw " + NOW(total) });
      if (!pin) { go.disabled = false; go.textContent = "Withdraw " + NOW(total); return; }
      if (!(await showConfirmDialog("Withdraw " + NOW(total) + " to your bank account? This is final.", { title: "Withdraw money", okLabel: "Yes, withdraw", cancelLabel: "No, go back" }))) { go.disabled = false; go.textContent = "Withdraw " + NOW(total); return; }
      go.disabled = true; go.textContent = "Please wait…";
      var q = await sb.rpc("request_withdrawal", { p_pin: pin });
      if (q.error) { go.disabled = false; go.textContent = "Try again"; return showToast(q.error.message || "Could not withdraw.", "error"); }
      var d = q.data || {};
      var el = document.getElementById("lvwSheet"); if (el) el.remove();
      showToast(Number(d.sent_kobo) > 0 && Number(d.requested_kobo) > 0 ? NOW(Number(d.sent_kobo)) + " is on its way; " + NOW(Number(d.requested_kobo)) + " is waiting for approval." : Number(d.sent_kobo) > 0 ? NOW(Number(d.sent_kobo)) + " is on its way to your bank." : "Request sent. We will message you when it is approved.", "success");
      load(true).then(paint);
    };
  };
  window.lvWalletHow = function () {
    openSheet("How your wallet works",
      '<ul class="lvw-how"><li><b>Pending.</b> The buyer has paid through Levromart. We hold the money until they confirm they received the order, or 24 hours pass with no problem raised.</li>' +
      '<li><b>Ready.</b> The order is complete. Tap <b>Withdraw</b> to send it to your bank. Earnings are released 24 hours after payment (this protects you and your buyers if a scam is reported). An order with a dispute is held until it is settled.</li>' +
      '<li><b>On its way.</b> Your money is being sent to your bank. Transfers usually arrive within minutes. Money from a very recent card payment goes out automatically the next business day.</li>' +
      '<li><b>Paid out.</b> The money has been sent to your bank account.</li>' +
      '<li><b>Refunds.</b> If a buyer is refunded for an order, that amount comes off your wallet automatically. A refund is paid out of your share of the sale (what is left after Levromart\'s commission); the commission is not refunded.</li>' +
      '</ul>' + (typeof window.lvWalletColoursHtml === "function" ? window.lvWalletColoursHtml() : ""));
  };

  function wrapRenderers() {
    function wrapFn(name, build) {
      var f = window[name]; if (typeof f !== "function" || f.__lvw) return;
      var w = async function () { var html = await f.apply(this, arguments); var out = build(String(html == null ? "" : html), arguments); if (out !== null) setTimeout(function () { refresh(false); }, 30); return out === null ? html : out; };
      w.__lvw = true; w.__lvrw = f.__lvrw; window[name] = w;   // keep the refunds wallet's mark too
    }
    // the shop's own full profile: the wallet takes the place of the top banner
    wrapFn("renderVendorDashboard", function (html) {
      if (typeof vendor === "undefined" || !vendor || html.indexOf("vendor-profile-header-card") < 0) return null;
      // the wallet sits under the profile (not above it)
      var wallet = '<div class="lvw" data-lv-wallet="full">' + card((cache || (readStored(), cache)) && cache.data, false) + "</div>";
      var cut = html.indexOf('<hr class="vendor-profile-divider"');
      return cut > 0 ? html.slice(0, cut) + wallet + html.slice(cut) : wallet + html;
    });
    // orders: the one wallet on top of both tabs (orders from customers and my purchases)
    wrapFn("renderVendorOrders", function (html, args) {
      if (typeof vendor === "undefined" || !vendor || html.indexOf("empty-state") === 0 && html.length < 200) return null;
      // "My purchases" shows the shop's card only once it is the one Levromart wallet; until then that tab keeps its own
      // single card, so a vendor never sees two wallets there
      if (args[5] === "purchases" && !(window.lvWalletCardHtml && window.lvWalletCardHtml("shop", {}))) return null;
      return '<div class="lvw" data-lv-wallet="compact">' + card((cache || (readStored(), cache)) && cache.data, true) + "</div>" + html;
    });
  }
  wrapRenderers(); setTimeout(wrapRenderers, 1200); setTimeout(wrapRenderers, 4000);
})();

/* ===== Suggestions: the red number on the profile panel is refreshed whenever the panel opens ===== */
(function () {
  "use strict";
  var busy = false;
  async function refresh() {
    if (busy || typeof session === "undefined" || !session) return;
    var isAdmin = typeof profile !== "undefined" && profile && profile.role === "admin";
    if (!isAdmin && !(typeof vendor !== "undefined" && vendor)) return;
    busy = true;
    try {
      var r = await sb.rpc(isAdmin ? "get_platform_suggestions" : "get_vendor_suggestions");
      if (r && !r.error && Array.isArray(r.data)) {
        var n = r.data.filter(function (x) { return !x.reply_message; }).length;
        if (n !== Number(unreadSuggestionCount || 0)) { unreadSuggestionCount = n; if (typeof updateAuthUI === "function") updateAuthUI(); }
      }
    } catch (_) {} finally { busy = false; }
  }
  window.lvRefreshSuggestionBadge = refresh;
  function wrap() {
    var t = window.toggleProfilePanel;
    if (typeof t !== "function" || t.__lvSg) return;
    var w = function () { var out = t.apply(this, arguments); setTimeout(refresh, 900); return out; };
    w.__lvSg = true; window.toggleProfilePanel = w;
  }
  wrap(); setTimeout(wrap, 1500);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
  setTimeout(refresh, 4000);
})();


/* ===== Home is ready before you tap it: a quiet copy is prepared while the app is idle, so the tab opens at once ===== */
(function () {
  "use strict";
  var busy = false;
  function warm() {
    if (busy || document.hidden) return;
    try {
      if (typeof renderHome !== "function" || typeof routeHtmlCache === "undefined") return;
      var key = routeCacheKey("home", {});
      if (routeHtmlCache.has(key) && Date.now() - (window.__lvHomeWarmAt || 0) < 300000) return;
      if (typeof currentView !== "undefined" && currentView === "home") return;   // the page on screen already fills it
      if (typeof currentHomeCategoryId !== "undefined" && (currentHomeCategoryId || (typeof currentSectorId !== "undefined" && currentSectorId))) return;
      busy = true;
      Promise.resolve(renderHome()).then(function (html) {
        var str = String(html || "");
        if (str && isUsableRouteSnapshot(str)) { routeHtmlCache.set(key, str); persistRouteHtml("home", {}, str); window.__lvHomeWarmAt = Date.now(); }
      }).catch(function () {}).finally(function () { busy = false; });
    } catch (_) { busy = false; }
  }
  function schedule() { var run = function () { warm(); }; if (window.requestIdleCallback) requestIdleCallback(run, { timeout: 4000 }); else setTimeout(run, 2500); }
  setTimeout(schedule, 5000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) setTimeout(schedule, 800); });
  setInterval(function () { if (!document.hidden) schedule(); }, 240000);
  setTimeout(function () { try { window.lvPaystackOn && window.lvPaystackOn(); } catch (_) {} }, 2500);
})();


/* ===== Pop-ups (confirm and "write a message"): clean card, an icon, quick answers, a clear "go back" ===== */
(function () {
  "use strict";
  function dress(modalId, opts, prompt) {
    var m = document.getElementById(modalId), c = m && m.querySelector(".modal-content"); if (!c) return;
    c.classList.add("lv-dlg");
    var old = c.querySelector(".lv-dlg-ico"); if (old) old.remove();
    var ico = document.createElement("div");
    ico.className = "lv-dlg-ico" + (opts.danger ? " danger" : "") + (opts.tone === "purple" ? " purple" : "");
    c.classList.toggle("lv-dlg-purple", opts.tone === "purple");
    var three = /log ?out|sign ?out/i.test(String(opts.okLabel || "") + " " + String(opts.title || "")) ? "logout" : opts.danger ? "order-cancelled" : /pay|wallet|paystack|transfer|withdraw|send/i.test(String(opts.okLabel || "") + " " + String(opts.title || "")) ? "tx-paid" : "tx-ready";
    ico.innerHTML = typeof window.lv3dIcon === "function" && !opts.icon ? window.lv3dIcon(opts.three || three, 84) : '<i class="fa-solid ' + (opts.icon || (opts.danger ? "fa-triangle-exclamation" : "fa-circle-question")) + '"></i>';
    ico.classList.toggle("lv-dlg-3d", !!(typeof window.lv3dIcon === "function" && !opts.icon));
    c.insertBefore(ico, c.firstChild);
    var cancel = document.getElementById(prompt ? "textPromptModalCancel" : "confirmModalCancel");
    if (cancel) cancel.textContent = opts.cancelLabel || (opts.danger ? "Go back" : "Cancel");
    if (prompt) {
      var chips = c.querySelector(".lv-dlg-chips"); if (chips) chips.remove();
      if (opts.chips && opts.chips.length) {
        chips = document.createElement("div"); chips.className = "lv-dlg-chips";
        var input = document.getElementById("textPromptModalInput");
        opts.chips.forEach(function (t) {
          var b = document.createElement("button"); b.type = "button"; b.textContent = t;
          b.onclick = function () { input.value = t; input.focus(); };
          chips.appendChild(b);
        });
        c.insertBefore(chips, input);
      }
    }
  }
  function wrap(name, modalId, prompt) {
    var f = window[name]; if (typeof f !== "function" || f.__lvDlg) return;
    var w = function () {
      var opts = (prompt ? arguments[2] : arguments[1]) || {};
      var p = f.apply(this, arguments);
      try { dress(modalId, opts, prompt); } catch (_) {}
      return p;
    };
    w.__lvDlg = true; window[name] = w;
  }
  wrap("showConfirmDialog", "confirmModal", false);
  wrap("showTextPromptDialog", "textPromptModal", true);
})();


/* ===== A shop cannot cancel an order the buyer has paid for: it asks Levromart (an admin decides, the buyer is refunded) ===== */
window.lvAskCancel = async function (orderId) {
  var ok = await showConfirmDialog("The buyer has already paid, so you cannot cancel this order yourself. Send a request to Levromart. If it is approved, the order is cancelled and the buyer is refunded.", { title: "Ask Levromart to cancel?", okLabel: "Write the reason", cancelLabel: "Go back", danger: true });
  if (!ok) return;
  var reason = await showTextPromptDialog("Why do you need to cancel?", "Levromart reads this before deciding.", { placeholder: "Write a short reason…", okLabel: "Send request", chips: ["Out of stock", "Cannot deliver to this area", "Price was wrong"], icon: "fa-paper-plane", danger: true });
  if (reason === null) return;
  var r = await sb.rpc("request_order_cancellation", { p_order_id: orderId, p_reason: reason });
  if (r.error) return showToast(r.error.message || "Could not send the request.", "error");
  showToast("Request sent. Levromart will review it.", "success");
};

/* ===== Refunds wallet for buyers: refunds land here (not on the card) and are withdrawn to a bank account ===== */
(function () {
  "use strict";
  var cache = null, loading = null, popupDone = false, failed = false, activating = false;
  var DISMISS = "lv-rw-dismissed";
  function signedIn() { return typeof session !== "undefined" && session && typeof profile !== "undefined" && profile && profile.role !== "admin"; }
  // An account that was checked but could not be saved on the server yet (the refunds wallet is still being switched on) is kept
  // safely on the person's own login and sent again automatically as soon as the server can take it.
  function pendingAcct() { try { return (session && session.user && session.user.user_metadata && session.user.user_metadata.lv_refund_pending) || null; } catch (_) { return null; } }
  async function setPending(v) {
    try {
      var r = await sb.auth.updateUser({ data: { lv_refund_pending: v } });
      if (r && r.error) return false;
      try { session.user.user_metadata = Object.assign({}, session.user.user_metadata || {}, { lv_refund_pending: v }); } catch (_) {}
      return true;
    } catch (_) { return false; }
  }
  // an account kept while the server was not ready is finished only when the person taps (it needs their password)
  async function activatePending(byTap) {
    var pa = pendingAcct(); if (!pa || activating) return false; if (!byTap) return false; activating = true;
    try {
      var pwd = await window.lvAskPassword(); if (!pwd) return false;
      var r = await sb.rpc("save_refund_account", { p_bank_code: pa.c, p_account_number: pa.n, p_confirmed_name: pa.name, p_password: pwd });
      if (r.error) { if (typeof showToast === "function") showToast(r.error.message || "Could not save the account.", "error"); return false; }
      await setPending(null); cache = null; refresh(true);
      if (typeof showToast === "function") showToast("Your account is saved.", "success");
      return true;
    } catch (_) { return false; } finally { activating = false; }
  }
  function money(kobo) { return "₦" + (Number(kobo || 0) / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 }); }
  function when(d) { try { return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + ", " + new Date(d).toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit" }); } catch (_) { return ""; } }
  async function load(force) {
    if (!signedIn()) return null;
    if (!force && cache && Date.now() - cache.at < 30000) return cache.data;
    if (loading) return loading;
    loading = (async function () {
      var r = await sb.rpc("get_refund_wallet");
      if (r.error || !r.data) { failed = true; return cache ? cache.data : null; }   // not set up on the server yet: the card says so instead of waiting forever
      failed = false;
      cache = { at: Date.now(), data: r.data };
      return r.data;
    })().catch(function () { return null; }).finally(function () { loading = null; });
    return loading;
  }
  var rHide = false; try { rHide = localStorage.getItem("lv-rw-hide") === "1"; } catch (_) {}
  function mR(k) { return rHide ? "\u20a6 \u2022\u2022\u2022\u2022" : money(k); }
  window.lvRefundEye = function () { rHide = !rHide; try { localStorage.setItem("lv-rw-hide", rHide ? "1" : "0"); } catch (_) {} paint(); };
  function card(d) {
    if (window.lvWalletCardHtml) { var h3 = window.lvWalletCardHtml("me", null); if (h3) return h3; }
    var pa = pendingAcct(), has = d && d.has_account, bal = d ? Number(d.available_kobo) : 0, pend = d ? Number(d.processing_kobo) : 0;
    return '<div class="lvw-card lvw2 is-compact lvrw-card"><div class="lvw-top"><span class="lvw-label"></span><button type="button" class="lvw-help" onclick="lvRefundHow()" aria-label="How refunds work and wallet colour"><i class="fa-solid fa-circle-question"></i></button><span class="lvw-top-sp"></span><button type="button" class="lvw-eye" onclick="lvRefundEye()" aria-label="' + (rHide ? "Show amounts" : "Hide amounts") + '"><i class="fa-regular ' + (rHide ? "fa-eye-slash" : "fa-eye") + '"></i></button></div>' +
      '<div class="lvw-bal-label">' + (has ? "Available to withdraw" : pa ? "Refund account saved" : "Refunds you are owed land here") + '</div>' +
      '<div class="lvw-bal">' + (d || failed ? mR(bal) : '<span class="lvw-skel"></span>') + '</div>' +
      (pend ? '<div class="lvw-note"><i class="fa-solid fa-paper-plane"></i> <b>' + mR(pend) + '</b> on its way to your bank</div>' : "") +
      '<div class="lvw-foot"><div class="lvw-foot-l">' + (has ? '<small>Refund account</small><b>' + esc(d.account.bank_name) + " ···" + esc(d.account.last4) + ' <button type="button" class="lvw-inline" onclick="lvRefundAccount()">Change</button></b>' : '<small>Refund account</small><b>Not added yet</b>') + '</div>' +
      (has ? '<button type="button" class="lvw-btn lvw-btn-withdraw" onclick="lvRefundWithdraw()"><i class="fa-solid fa-building-columns"></i> Withdraw</button>' : '<button type="button" class="lvw-btn lvw-btn-withdraw" onclick="lvRefundAccount()"><i class="fa-solid ' + (pa ? "fa-pen" : "fa-plus") + '"></i> ' + (pa ? "Change bank" : "Add bank") + '</button>') + '</div>' +
      '<button type="button" class="lvw-strip" onclick="lvRefundHistory()"><i class="fa-solid fa-clock-rotate-left lvw-strip-ic"></i><span class="lvw-strip-t">Transaction history</span><i class="fa-solid fa-chevron-right lvw-strip-go"></i></button>' +
    '</div>';
  }
  window.lvRefundRepaint = function () { paint(); };
  function paint() {
    // with the one Levromart wallet switched on, a page that already shows it does not show it twice
    var one = window.lvWalletCardHtml && document.querySelector("[data-lv-wallet]") && window.lvWalletCardHtml("me", null);
    document.querySelectorAll("[data-lv-rwallet]").forEach(function (el) { var h = one ? "" : card(cache && cache.data); if (el.__h !== h) { el.innerHTML = h; el.__h = h; el.hidden = !h; } el.style.display = one ? "none" : ""; });
  }
  async function refresh(force) { paint(); await load(force); paint(); }
  function sheet(title, body) {
    var old = document.getElementById("lvrwSheet"); if (old) old.remove();
    var m = document.createElement("div");
    m.id = "lvrwSheet"; m.className = "lvw-sheet-wrap";
    m.innerHTML = '<div class="lvw-sheet" role="dialog" aria-modal="true"><div class="lvw-sheet-grab" aria-hidden="true"></div><div class="lvw-sheet-head"><h3>' + esc(title) + '</h3><button type="button" class="lvw-eye lvw-eye-dark" onclick="document.getElementById(\'lvrwSheet\').remove()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div><div class="lvw-sheet-body">' + body + '</div></div>';
    m.addEventListener("click", function (e) { if (e.target === m) m.remove(); });
    document.body.appendChild(m);
    return m;
  }
  function say(el, msg, bad) { if (el) { el.textContent = msg; el.className = "lvw-sheet-msg" + (bad ? " lvw-sheet-warn" : ""); el.hidden = !msg; } }

  window.lvRefundHow = function () {
    sheet("Your refunds wallet",
      '<ul class="lvw-how"><li><b>Refunds land here.</b> If an order you paid for is cancelled, or a problem is settled in your favour, the money is put in this wallet.</li>' +
      '<li><b>Withdraw any time.</b> Tap <b>Withdraw</b> to send it to your refund bank account (from \u20a6100).</li>' +
      '<li><b>Where it comes from.</b> A refund is paid out of the shop\'s share of the sale. You get back what you paid for the order; Paystack\'s payment fee is not refunded.</li>' +
      '<li><b>Changed your bank account?</b> You can still withdraw. Levromart is told about the change and may check it.</li>' +
      '<li><b>No account yet?</b> Add one so refunds can reach you. It must be an account in your own name.</li></ul>' +
      (typeof window.lvWalletColoursHtml === "function" ? window.lvWalletColoursHtml() : ""));
  };
  window.lvRefundAccount = async function (fromPopup) {
    if (pendingAcct() && !(cache && cache.data && cache.data.has_account)) { if (await activatePending(true)) return; }
    var m = sheet(fromPopup ? "Where should your money go?" : "Your bank account",
      '<p class="lvrw-lead">Add the account you want your money to go to. It must be in your own name.</p><p class="lvrw-note"><i class="fa-solid fa-shield-halved"></i><span>You can withdraw 24 hours after adding it, and the first withdrawal is checked. Please check the details carefully.</span></p>' +
      '<label class="lvrw-l">Bank</label><button type="button" class="lvrw-bankbtn" id="lvrwBankBtn"><span class="ve-bank-ico" id="lvrwBankIco"><i class="fa-solid fa-building-columns"></i></span><span id="lvrwBankLabel" class="lvrw-bank-label">Choose your bank</span><i class="fa-solid fa-chevron-down"></i></button>' +
      '<label class="lvrw-l">Account number</label><input id="lvrwNum" class="lvrw-in" inputmode="numeric" maxlength="10" placeholder="10 digits" autocomplete="off">' +
      '<p id="lvrwMsg" class="lvw-sheet-msg" hidden></p><div id="lvrwName" class="lvrw-name" hidden></div>' +
      '<button type="button" class="btn lvw-wd-go" id="lvrwGo">Check account</button>' + (fromPopup ? '<button type="button" class="lvrw-later" onclick="lvRefundLater()">I\'ll do it later</button>' : ""));
    if (fromPopup) {   // no close button or tap-outside: "I'll do it later" is the way out, so the choice is a clear one
      var x0 = m.querySelector(".lvw-eye"); if (x0) x0.remove();
      m.classList.add("lvrw-locked");
      m.addEventListener("click", function (e) { if (e.target === m) e.stopImmediatePropagation(); }, true);
    }
    var num = m.querySelector("#lvrwNum"), msg = m.querySelector("#lvrwMsg"), nameBox = m.querySelector("#lvrwName"), go = m.querySelector("#lvrwGo");
    var sel = { value: "" }, list = [];
    try { var bk = await window.levroData.payments.banks(); list = (bk && Array.isArray(bk.data) && bk.data) || []; } catch (_) {}
    if (!list.length && typeof NIGERIAN_BANKS !== "undefined") list = NIGERIAN_BANKS;   // the full list kept in the app, so the form always works
    list = list.slice().sort(function (x, y) { return String(x.name).localeCompare(String(y.name)); });
    var found = null;
    function reset() { found = null; nameBox.hidden = true; go.textContent = "Check account"; say(msg, ""); }
    function choose(code, name) {
      sel.value = code; reset();
      m.querySelector("#lvrwBankLabel").textContent = name;
      var ico = m.querySelector("#lvrwBankIco");
      ico.className = "ve-bank-ico"; ico.removeAttribute("data-lvlogo"); ico.innerHTML = '<i class="fa-solid fa-building-columns"></i>'; ico.setAttribute("data-bank-code", code);
    }
    // the same bank picker as the shop's payout page: search, and each bank's own logo
    m.querySelector("#lvrwBankBtn").onclick = function () {
      var pk = document.createElement("div");
      pk.id = "vendorBankPickerModal"; pk.className = "modal vendor-bank-picker-modal open"; pk.style.zIndex = "2147483500";   // same id as the shop's picker: the same look, light and dark
      pk.innerHTML = '<div class="modal-content vendor-bank-picker-content"><div class="vendor-bank-picker-head"><div><div class="vendor-bank-picker-title"><i class="fa-solid fa-building-columns"></i><span>Select your bank</span></div><div class="muted" style="font-size:.76rem;margin-top:.2rem;">' + list.length + ' supported banks and financial institutions</div></div><button type="button" class="drawer-close-btn" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div><div class="vendor-bank-search-wrap"><i class="fa-solid fa-magnifying-glass"></i><input class="vendor-bank-search" type="search" autocomplete="off" placeholder="Search bank..." aria-label="Search banks"></div><div class="vendor-bank-picker-list"></div></div>';
      document.body.appendChild(pk);
      var box = pk.querySelector(".vendor-bank-picker-list"), q = pk.querySelector(".vendor-bank-search");
      function paintList() {
        var t = q.value.trim().toLowerCase();
        var rows = list.filter(function (x) { return !t || String(x.name).toLowerCase().indexOf(t) >= 0; });
        box.innerHTML = rows.length ? rows.map(function (x) { return '<button type="button" class="vendor-bank-option' + (x.code === sel.value ? " selected" : "") + '" data-bank-code="' + esc(x.code) + '" data-bank-name="' + esc(x.name) + '"><span class="vendor-bank-option-icon"><i class="fa-solid fa-building-columns"></i></span><span class="vendor-bank-option-main"><strong>' + esc(x.name) + '</strong></span>' + (x.code === sel.value ? '<i class="fa-solid fa-circle-check vendor-bank-option-check"></i>' : '<i class="fa-solid fa-chevron-right vendor-bank-option-arrow"></i>') + '</button>'; }).join("") : '<div class="empty-state" style="padding:2rem 1rem;">No bank matches your search.</div>';
      }
      q.addEventListener("input", paintList);
      pk.addEventListener("click", function (e) {
        var o = e.target.closest && e.target.closest(".vendor-bank-option");
        if (o) { choose(o.getAttribute("data-bank-code"), o.getAttribute("data-bank-name")); pk.remove(); return; }
        if (e.target === pk || (e.target.closest && e.target.closest(".drawer-close-btn"))) pk.remove();
      });
      paintList(); setTimeout(function () { try { q.focus(); } catch (_) {} }, 60);
    };
    num.addEventListener("input", reset);
    function friendly(e) {
      var t = String((e && e.message) || "");
      if (/not found|does not exist|unknown|404|failed to fetch|network/i.test(t) || !t) return "Refund accounts are being switched on. Please try again in a little while.";
      return t;
    }
    go.onclick = async function () {
      say(msg, "");
      if (!sel.value) return say(msg, "Choose your bank.", true);
      if (!/^\d{10}$/.test(num.value.trim())) return say(msg, "Enter your 10-digit account number.", true);
      go.disabled = true;
      try {
        if (!found) {
          var r = await window.levroData.payments.resolveAccount(sel.value, num.value.trim());
          if (r.error || !r.data) return say(msg, (r.error && r.error.message) || "We could not find that account. Check the bank and number.", true);
          found = r.data;
          nameBox.hidden = false; nameBox.innerHTML = '<b>' + esc(found.accountName) + '</b><span>' + esc(found.bankName || "") + " · ···" + esc(found.accountLast4 || "") + '</span><small>Is this your account?</small>';
          go.textContent = "Yes, this is my account";
          return;
        }
        var pwd = await window.lvAskPassword(); if (!pwd) return;
        var s = await sb.rpc("save_refund_account", { p_bank_code: sel.value, p_account_number: num.value.trim(), p_confirmed_name: found.accountName, p_password: pwd });
        if (s.error) {
          // the name was confirmed with the bank, so keep the account safe on the person's login and finish saving it later
          var bname = (list.find(function (x) { return x.code === sel.value; }) || {}).name || found.bankName || "";
          var kept = await setPending({ c: sel.value, n: num.value.trim(), name: found.accountName, b: bname, l: num.value.trim().slice(-4), at: Date.now() });
          if (!kept) { found = null; return say(msg, friendly(s.error), true); }
          var el0 = document.getElementById("lvrwSheet"); if (el0) el0.remove();
          showToast("Account saved. Refunds will use it as soon as the refunds wallet is switched on.", "success");
          paint(); return;
        }
        await setPending(null);
        var el = document.getElementById("lvrwSheet"); if (el) el.remove();
        showToast("Refund account saved.", "success");
        await refresh(true);
      } catch (e) { say(msg, friendly(e), true); }
      finally { go.disabled = false; }
    };
  };
  window.lvRefundLater = function () { try { localStorage.setItem(DISMISS, String(Date.now())); } catch (_) {} var el = document.getElementById("lvrwSheet"); if (el) el.remove(); };

  window.lvRefundWithdraw = async function () {
    var d = await load(true);
    if (!d) return showToast("Your wallet is not available right now.", "error");
    if (d.blocked) return showToast(d.blocked, "info");
    var bal = Number(d.available_kobo);
    if (bal < Number(d.min_kobo)) return showToast(bal > 0 ? "The smallest withdrawal is " + money(d.min_kobo) + "." : "You have no refund money to withdraw yet.", "info");
    var ok = await showConfirmDialog("Send " + money(bal) + " to " + d.account.bank_name + " ···" + d.account.last4 + "?", { title: "Withdraw refund", okLabel: "Withdraw", cancelLabel: "Go back" });
    if (!ok) return;
    var r = await sb.rpc("withdraw_refunds");
    if (r.error) return showToast(r.error.message || "Could not withdraw.", "error");
    showToast(r.data && r.data.status === "sent" ? money(bal) + " was sent to your bank." : money(bal) + " is on its way to your bank.", "success");
    refresh(true);
  };
  window.lvRefundHistory = async function () {
    var m = sheet("Refund history", '<p class="muted" style="text-align:center">Loading…</p>');
    var d = await load(true), body = m.querySelector(".lvw-sheet-body");
    if (!d) { body.innerHTML = '<p class="lvw-sheet-msg">Your wallet is not available right now.</p>'; return; }
    var rows = [];
    (d.credits || []).forEach(function (c) { rows.push({ at: c.created_at, t: "Refund added", s: c.status === "available" ? "In your wallet" : c.status === "processing" ? "Being sent" : "Sent to your bank", amt: c.amount_kobo, plus: true, order: c.order_id }); });
    (d.withdrawals || []).forEach(function (w) { rows.push({ at: w.created_at, t: "Withdrawal", s: w.status === "success" ? "Sent" : w.status === "processing" ? "On its way" : "Not sent, money returned to wallet", amt: w.amount_kobo, plus: false }); });
    rows.sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
    body.innerHTML = rows.length ? '<ul class="lvw-list">' + rows.map(function (r) { return '<li' + (r.order ? ' onclick="document.getElementById(\'lvrwSheet\').remove();navigate(\'orderDetail\',{orderId:\'' + esc(r.order) + '\'})"' : "") + '><span class="lvw-ico ' + (r.plus ? "ready" : "onway") + '"><i class="fa-solid ' + (r.plus ? "fa-rotate-left" : "fa-paper-plane") + '"></i></span><div class="lvw-li"><strong>' + esc(r.t) + '</strong><small>' + esc(r.s) + " · " + esc(when(r.at)) + '</small></div><b class="lvw-amt ' + (r.plus ? "ready" : "onway") + '">' + (r.plus ? "+" : "−") + money(r.amt) + '</b></li>'; }).join("") + "</ul>" : '<div class="lvw-empty"><i class="fa-solid fa-rotate-left"></i><strong>No refunds yet</strong><span>If an order is cancelled after you paid, the money appears here.</span></div>';
  };

  // the wallet sits on top of the buyer's profile and their orders
  function wrapFn(name) {
    var f = window[name]; if (typeof f !== "function" || f.__lvrw) return;
    var w = async function () {
      var html = await f.apply(this, arguments);
      var str = String(html == null ? "" : html);
      if (!signedIn() || str.length < 200 || str.indexOf("data-lv-rwallet") >= 0 || (name === "renderVendorOrders" && arguments[5] !== "purchases")) return html;   // one wallet only: the page may already carry it
      if (str.indexOf("data-lv-wallet") >= 0 && window.lvWalletCardHtml && window.lvWalletCardHtml("me", null)) return html;   // the one Levromart wallet is already on this page
      setTimeout(function () { refresh(false); }, 30);
      var rw = '<div class="lvw lvrw" data-lv-rwallet>' + card(cache && cache.data) + "</div>";
      // on the profile: the wallet sits just above "Activity" (My orders, Wishlist), so money and orders are together and
      // the shops you follow and the map stay right under the profile header
      var end = name === "renderBuyerProfile" ? str.indexOf('<div class="lv-group">') : -1;
      if (name === "renderBuyerProfile" && end < 0) { end = str.indexOf("</section>"); end = end > 0 ? end + 10 : -1; }
      return end > 0 ? str.slice(0, end) + rw + str.slice(end) : rw + str;
    };
    w.__lvrw = true; w.__lvw = f.__lvw; window[name] = w;   // keep the other wallet's mark so it is never wrapped again on top of this one
  }
  function wrapEdit() {
    var f = window.renderEditProfile; if (typeof f !== "function" || f.__lvrw) return;
    var w = function () {
      var out = f.apply(this, arguments);
      var add = function (html) { return String(html) + '<div class="lvrw-edit"><div><strong>Refund account</strong><small>Where refunds are sent when an order is cancelled or a problem is settled in your favour.</small></div><button type="button" class="btn btn-outline" onclick="lvRefundAccount()">Add or change</button></div>'; };
      return out && typeof out.then === "function" ? out.then(add) : add(out);
    };
    w.__lvrw = true; window.renderEditProfile = w;
  }
  function wrapAll() { wrapFn("renderBuyerProfile"); wrapFn("renderCustomerOrders"); wrapFn("renderVendorOrders"); wrapEdit(); }
  wrapAll(); setTimeout(wrapAll, 1200); setTimeout(wrapAll, 4000);

  // every customer is asked for a refund account until one is saved; "I'll do it later" puts the question off for 3 days
  var LATER_MS = 3 * 24 * 60 * 60 * 1000;
  function putOff() { try { return Date.now() - Number(localStorage.getItem(DISMISS) || 0) < LATER_MS; } catch (_) { return false; } }
  async function ask() {
    if (document.hidden || !signedIn()) return;
    if (pendingAcct() || putOff()) return;
    if (document.querySelector(".modal.open, #lvrwSheet, #lvCampus, #levromartSplash:not(.is-hidden), .onboarding-overlay, .lvw-sheet-wrap")) return;
    var d = await load(false);
    if (!d || d.has_account || pendingAcct()) return;
    window.lvRefundAccount(true);   // it comes back (3 days after "I'll do it later") until a refund account is saved
  }
  setInterval(ask, 20000); setTimeout(ask, 8000);
})();

/* ===== Admin: a red number on "Payments" while withdrawals or cancel requests wait for a decision ===== */
(function () {
  "use strict";
  var busy = false;
  function paint(n) {
    window.__lvPayPending = n;
    document.querySelectorAll(".lv-pay-badge").forEach(function (b) {
      b.textContent = n > 9 ? "9+" : String(n);
      b.classList.toggle("hidden", !n);
    });
    try { if (typeof renderBottomNav === "function") renderBottomNav(); } catch (_) {}
  }
  window.lvPayPaint = function (n) { if (n !== (window.__lvPayPending || 0)) paint(n); };
  window.lvPayPendingRefresh = async function () {
    if (busy || typeof sb === "undefined" || typeof session === "undefined" || !session || !profile || profile.role !== "admin") return;
    busy = true;
    try {
      var r = await Promise.all([sb.rpc("admin_list_withdrawals", { p_status: "requested" }), sb.rpc("admin_list_cancellations", { p_status: "requested" })]);
      var n = 0;
      r.forEach(function (x) { n += ((x && x.data) || []).filter(function (y) { return y.status === "requested"; }).length; });
      if (n !== (window.__lvPayPending || 0)) paint(n);
    } catch (_) {} finally { busy = false; }
  };
  setInterval(function () { if (!document.hidden) window.lvPayPendingRefresh(); }, 60000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) window.lvPayPendingRefresh(); });
  var w = window.renderBottomNav;
  if (typeof w === "function" && !w.__lvPay) {
    var inner = w;
    window.renderBottomNav = function () { var out = inner.apply(this, arguments); if (typeof profile !== "undefined" && profile && profile.role === "admin" && window.__lvPayPending == null) window.lvPayPendingRefresh(); return out; };
    window.renderBottomNav.__lvPay = true; Object.keys(inner).forEach(function (k) { window.renderBottomNav[k] = inner[k]; });
  }
})();

/* ===== Vendor application: the phone number already on the account is filled in ===== */
(function () {
  "use strict";
  function fill() {
    var el = document.getElementById("vaPhone");
    if (!el || el.value || el.dataset.lvFilled) return;
    var ph = (typeof profile !== "undefined" && profile && profile.phone) || (typeof vendor !== "undefined" && vendor && vendor.phone) || "";
    if (ph) { el.value = ph; el.dataset.lvFilled = "1"; }
  }
  var raf = 0;
  new MutationObserver(function () { if (!raf) raf = requestAnimationFrame(function () { raf = 0; fill(); }); }).observe(document.body, { childList: true, subtree: true });
})();

/* ===== A shop can change its own referral code (4 to 16 letters or numbers; capitals do not matter) ===== */
(function () {
  "use strict";
  function currentCode() {
    var el = document.querySelector(".lb-code-val");
    if (el && el.textContent.trim()) return el.textContent.trim();
    return (typeof vendor !== "undefined" && vendor && vendor.referral_code) || "";
  }
  window.lvShareReferral = function () {
    var old = document.getElementById("lvShareSheet"); if (old) old.remove();
    var code = currentCode(); if (!code) return;
    var link = (typeof referLink === "function") ? referLink(code) : (location.origin + "/?ref=" + encodeURIComponent(code));
    var m = document.createElement("div");
    m.id = "lvShareSheet"; m.className = "lvw-sheet-wrap";
    m.innerHTML = '<div class="lvw-sheet" role="dialog" aria-modal="true"><div class="lvw-sheet-grab" aria-hidden="true"></div><div class="lvw-sheet-head"><h3>Share your code</h3><button type="button" class="lvw-eye lvw-eye-dark" aria-label="Close" onclick="document.getElementById(\'lvShareSheet\').remove()"><i class="fa-solid fa-xmark"></i></button></div><div class="lvw-sheet-body lv-share-list">' +
      '<button type="button" data-a="copy"><i class="fa-regular fa-copy"></i> Copy link</button>' +
      '<button type="button" data-a="wa"><i class="fa-brands fa-whatsapp"></i> WhatsApp</button>' +
      '<button type="button" data-a="more"><i class="fa-solid fa-share-nodes"></i> More apps</button></div></div>';
    m.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-a]");
      if (!b) { if (e.target === m) m.remove(); return; }
      m.remove();
      try { if (b.dataset.a === "copy") lbCopy(link, "Referral link copied"); else if (b.dataset.a === "wa") lbShareCode(); else lbShareMore(); } catch (_) {}
    });
    document.body.appendChild(m);
  };
  window.lvChangeReferralCode = function () {
    var old = document.getElementById("lvRefSheet"); if (old) old.remove();
    var m = document.createElement("div");
    m.id = "lvRefSheet"; m.className = "lvw-sheet-wrap";
    m.innerHTML = '<div class="lvw-sheet" role="dialog" aria-modal="true"><div class="lvw-sheet-grab" aria-hidden="true"></div><div class="lvw-sheet-head"><h3>Your referral code</h3><button type="button" class="lvw-eye lvw-eye-dark" aria-label="Close" onclick="document.getElementById(\'lvRefSheet\').remove()"><i class="fa-solid fa-xmark"></i></button></div><div class="lvw-sheet-body">' +
      '<p class="muted" style="margin:0 0 .8rem;font-size:.88rem;line-height:1.45">Use your shop name or anything easy to say. 4 to 16 letters or numbers. Capital or small letters, it works the same.</p>' +
      '<input id="lvRefInput" class="lvrw-in" maxlength="24" autocapitalize="characters" autocomplete="off" placeholder="e.g. MYSHOP" value="' + String(currentCode()).replace(/"/g, "") + '">' +
      '<p id="lvRefMsg" class="lvw-sheet-msg" hidden></p><button type="button" class="btn lvw-wd-go" id="lvRefGo">Save code</button></div></div>';
    m.addEventListener("click", function (e) { if (e.target === m) m.remove(); });
    document.body.appendChild(m);
    var inp = m.querySelector("#lvRefInput"), msg = m.querySelector("#lvRefMsg"), go = m.querySelector("#lvRefGo");
    setTimeout(function () { try { inp.focus(); inp.select(); } catch (_) {} }, 80);
    go.onclick = async function () {
      if (go.disabled) return; go.disabled = true; go.textContent = "Saving…"; msg.hidden = true;
      var r = await sb.rpc("set_my_referral_code", { p_code: inp.value });
      var d = r && r.data;
      go.disabled = false; go.textContent = "Save code";
      if ((r && r.error) || !d || !d.ok) {
        msg.textContent = (d && d.message) || (r && r.error && /not.*(found|exist)|setting up|unavailable/i.test(r.error.message || "") ? "This is being set up. Try again later." : "Could not save the code. Try again.");
        msg.className = "lvw-sheet-msg lvw-sheet-warn"; msg.hidden = false; return;
      }
      try { if (typeof vendor !== "undefined" && vendor) vendor.referral_code = d.referral_code; } catch (_) {}
      m.remove();
      showToast("Your referral code is now " + d.referral_code + ".", "success");
      try { if (currentView === "leaderboard") navigate("leaderboard", currentViewParams || {}, false); } catch (_) {}
    };
  };
  function dress() {
    var v = document.querySelector(".lb-code:not([data-lv-chg])");
    if (v) {
      v.dataset.lvChg = "1";
      var val = v.querySelector(".lb-code-val");
      if (val && !v.querySelector(".lb-code-edit")) {
        var ed = document.createElement("button"); ed.type = "button"; ed.className = "lb-code-edit"; ed.setAttribute("aria-label", "Change my referral code"); ed.title = "Change code";
        ed.innerHTML = '<i class="fa-solid fa-pen"></i>'; ed.onclick = window.lvChangeReferralCode;
        val.parentNode.insertBefore(ed, val.nextSibling);
      }
      var acts = v.querySelector(".lb-code-actions");
      if (acts) { acts.innerHTML = '<button type="button" class="lb-share-one"><i class="fa-solid fa-share-nodes"></i> Share</button>'; acts.firstChild.onclick = window.lvShareReferral; }
    }
    var s = document.getElementById("settings-page");
    if (s && !s.querySelector("[data-lv-refrow]") && typeof vendor !== "undefined" && vendor && vendor.id) {
      var sec = document.createElement("section"); sec.className = "settings-page-section"; sec.dataset.lvRefrow = "1";
      sec.innerHTML = '<h3><i class="fa-solid fa-gift"></i> Referrals</h3><button class="settings-action-row" onclick="lvChangeReferralCode()"><i class="fa-solid fa-pen"></i><span><strong>Change my referral code</strong><small>Make it your shop name or anything easy to say</small></span></button>';
      var acct = [].find.call(s.querySelectorAll(".settings-page-section"), function (x) { return /Account/.test(x.querySelector("h3") ? x.querySelector("h3").textContent : ""); });
      if (acct) acct.parentNode.insertBefore(sec, acct); else s.appendChild(sec);
    }
  }
  var raf = 0;
  new MutationObserver(function () { if (!raf) raf = requestAnimationFrame(function () { raf = 0; dress(); }); }).observe(document.body, { childList: true, subtree: true });
})();

/* ===== Realistic 3D icons (Microsoft Fluent Emoji, MIT, in /icons3d) for categories, home headings and quick cards ===== */
(function () {
  "use strict";
  var RULES = [
    [/snack|popcorn|chips/, "1f37f"], [/bakery|bread|pastr|cake/, "1f35e"], [/beverage|drink|juice|water/, "1f9c3"], [/grocer/, "1f957"], [/food|restaurant|cater|kitchen|dining|shawarma/, "1f354"],
    [/shoe|footwear|sneaker/, "1f45f"], [/bag|handbag/, "1f45c"], [/watch/, "231a"], [/jewel|jewell|ring|accessor/, "1f48d"], [/fashion|cloth|tailor|fabric|wear|thrift|design/, "1f457"],
    [/skin|perfume|fragrance|scent|cosmetic/, "1f9f4"], [/salon|barb|braid/, "1f488"], [/beauty|hair|personal|wellness|care/, "1f484"],
    [/computer|laptop|software|web|digital/, "1f4bb"], [/phone|electronic|gadget|tech|tv|audio|telecom|game|gaming/, "1f4f1"],
    [/home|furniture|decor|interior|living|property|real estate|appliance/, "1f3e0"], [/health|pharmac|medical|health/, "1f48a"],
    [/book|station|educat|office|print/, "1f4da"], [/gift/, "1f381"], [/baby|kid|toy/, "1f9f8"], [/sport|fitness|gym/, "1f3cb-fe0f"], [/pet/, "1f43e"],
    [/auto|car|transport|logistic|travel|vehicle/, "1f697"], [/photo|video|media|camera/, "1f4f7"], [/art|craft|handmade|graphic|brand/, "1f3a8"],
    [/music|event|entertain/, "1f3b6"], [/clean|laundry/, "1f9f9"], [/repair|tool|construct|electrical|industr|hardware|solar|energy|manufactur|safety/, "1f6e0-fe0f"],
    [/agri|farm/, "1f33e"], [/financ|wholesale|retail|market/, "1f4b0"], [/service/, "2728"]
  ];
  function code(name) {
    var n = String(name || "").toLowerCase();
    for (var i = 0; i < RULES.length; i++) if (RULES[i][0].test(n)) return RULES[i][1];
    return "1f6cd-fe0f";
  }
  window.lv3d = function (c, cls) { return '<img class="lv3d ' + (cls || "") + '" src="/icons3d/' + c + '.webp" alt="" aria-hidden="true" decoding="async">'; };
  window.levroSectorArt = function (sector) { return "/icons3d/" + code(sector && (sector.name || sector.id)) + ".webp"; };
  window.lvCat3d = function (name, all) { return lv3d(all ? "1f6d2" : code(name), "lv3d-chip"); };   // a category's 3D icon (the cart for "All")
  var FA = { "fa-fire": "1f525", "fa-gem": "1f48e", "fa-hand-holding-heart": "1f6ce-fe0f", "fa-box-open": "1f4e6", "fa-table-cells-large": "1f6cd-fe0f", 
    "fa-bag-shopping": "1f6cd-fe0f", "fa-screwdriver-wrench": "1f6e0-fe0f", "fa-key": "1f511", "fa-store": "1f3ea", "fa-hand": "1f4dd", "fa-comment-dots": "1f4ac", "fa-graduation-cap": "1f393" };
  var SEL = "#app .section-title > i.fa-solid, #app .section-title > span > i.fa-solid, #lvCampusBar .lvcb-trophy > i.fa-solid, #lvCampusBar .ico > i.fa-solid";
  function dress() {
    document.querySelectorAll(SEL).forEach(function (i) {
      if (i.dataset.lv3) return;
      var c = null; for (var k in FA) if (i.classList.contains(k)) { c = FA[k]; break; }
      if (!c) return;
      i.dataset.lv3 = "1";
      var img = document.createElement("img"); img.className = "lv3d lv3d-ico"; img.src = "/icons3d/" + c + ".webp"; img.alt = ""; img.setAttribute("aria-hidden", "true");
      i.replaceWith(img);
    });
    // the "All campuses" badge
    var ico = document.querySelector("#lvCampusBar .lvcb-main .ico:not([data-lv3])");
    if (ico && !ico.querySelector("img")) { ico.dataset.lv3 = "1"; ico.innerHTML = '<img class="lv3d lv3d-ico" src="/icons3d/1f393.webp" alt="" aria-hidden="true">'; }
    // "All" chips
    document.querySelectorAll("#app .vd-chip-all img, #app .levro-home-cat-all img").forEach(function (im) { if (!im.dataset.lv3) { im.dataset.lv3 = "1"; im.src = "/icons3d/1f6d2.webp"; } });
    dressBrowse(); dressVendors();
  }
  // Browse everything: no search box or filter button any more; a rail of small round category pills sits on top instead
  function dressBrowse() {
    var grid = document.getElementById("productGrid"), sel = document.getElementById("filterCategory");
    if (!grid || !sel) return;
    var rail = document.getElementById("lvBrowsePills");
    var opts = [].filter.call(sel.options, function (o) { return o.value; });
    if (!opts.length) { if (rail) rail.remove(); return; }
    var key = opts.map(function (o) { return o.value; }).join(",") + "|" + sel.value;
    if (rail && rail.dataset.k === key) return;
    if (!rail) { rail = document.createElement("div"); rail.id = "lvBrowsePills"; rail.className = "lv-pills"; rail.setAttribute("role", "group"); rail.setAttribute("aria-label", "Categories"); grid.parentNode.insertBefore(rail, grid); }
    rail.dataset.k = key;
    rail.innerHTML = '<button type="button" class="lv-pill' + (sel.value ? "" : " on") + '" data-v="">' + lv3d("1f6d2") + '<span>All</span></button>' + opts.map(function (o) {
      return '<button type="button" class="lv-pill' + (sel.value === o.value ? " on" : "") + '" data-v="' + o.value + '">' + lv3d(code(o.textContent)) + "<span>" + o.textContent.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</span></button>";
    }).join("");
    rail.onclick = function (e) { var b = e.target.closest("button.lv-pill"); if (!b) return; try { chooseBrowseCategory(b.dataset.v, b.textContent.trim()); } catch (_) {} };
  }
  // Vendors page: no search box or filter button; the grid / list / map switch sits beside the tabs
  function dressVendors() {
    var tabs = document.getElementById("vendorsListingTabs"), views = document.querySelector("#app .vd-page .vd-views");
    if (!tabs || !views || tabs.parentNode.classList.contains("vd-toprow")) return;
    var t0 = tabs.querySelector("button[data-filter='all'], .vd-tab"); if (t0 && /^all vendors$/i.test(t0.textContent.trim())) t0.textContent = "All";
    var row = document.createElement("div"); row.className = "vd-toprow";
    tabs.parentNode.insertBefore(row, tabs); row.appendChild(tabs); row.appendChild(views);
  }
  var raf = 0;
  new MutationObserver(function () { if (!raf) raf = requestAnimationFrame(function () { raf = 0; dress(); }); }).observe(document.body, { childList: true, subtree: true });
  dress();
})();

/* ===== Profile photo: load the current picture through the proxy when the direct read is blocked, and a modern
   pinch / drag / scroll circular cropper (replaces the old slider dialog). Later definitions win. ===== */
(function () {
  function lvLoadImageBlob(url) {
    var direct = function () { return fetch(url, { cache: "no-store" }).then(function (r) { if (!r.ok) throw new Error("x"); return r.blob(); }); };
    var proxied = function () { return fetch("/api/delete-account?imgproxy=" + encodeURIComponent(url)).then(function (r) { if (!r.ok) throw new Error("x"); return r.blob(); }); };
    return direct().catch(proxied);
  }
  window.lvLoadImageBlob = lvLoadImageBlob;

  window.editCurrentAvatar = async function () {
    try { closeMediaActionSheet(); } catch (_) {}
    if (!profile || !profile.avatar_url) return;
    try {
      var blob = await lvLoadImageBlob(profile.avatar_url);
      pendingAvatarFile = new File([blob], "current-avatar.jpg", { type: blob.type || "image/jpeg" });
      openAvatarCropModal(pendingAvatarFile);
    } catch (e) {
      showToast("Couldn't open your current photo. Tap Replace to choose a new one.", "error");
    }
  };
  window.editCurrentVendorCover = async function () {
    try { closeMediaActionSheet(); } catch (_) {}
    if (!vendor || !vendor.cover_url) return;
    try {
      var blob = await lvLoadImageBlob(vendor.cover_url);
      pendingVendorCoverFile = new File([blob], "current-cover.jpg", { type: blob.type || "image/jpeg" });
      openVendorCoverCropModal(pendingVendorCoverFile);
    } catch (e) {
      showToast("Couldn't open your current header. Tap Replace to choose a new one.", "error");
    }
  };

  var st = null;
  function dia() { return Math.round(Math.min(window.innerWidth * 0.86, window.innerHeight * 0.56, 420)); }
  function clamp() {
    var D = st.D, bw = st.iw * st.base * st.s, bh = st.ih * st.base * st.s;
    var mx = Math.max(0, (bw - D) / 2), my = Math.max(0, (bh - D) / 2);
    st.x = Math.max(-mx, Math.min(mx, st.x)); st.y = Math.max(-my, Math.min(my, st.y));
  }
  function paint() {
    var img = document.getElementById("avatarCropImage"); if (!img || !st) return;
    clamp();
    img.style.width = (st.iw * st.base) + "px"; img.style.height = (st.ih * st.base) + "px";
    img.style.transform = "translate(calc(-50% + " + st.x + "px), calc(-50% + " + st.y + "px)) scale(" + st.s + ")";
  }
  function zoomBy(f) { st.s = Math.max(1, Math.min(6, st.s * f)); paint(); }
  window.lvCropZoom = function (f) { if (st) zoomBy(f); };

  window.updateAvatarCropTransform = paint;
  window.bindAvatarCropDrag = function () {};
  window.closeAvatarCropModal = function () {
    var m = document.getElementById("avatarCropModal"); if (m) m.remove();
    st = null; try { avatarCropState = null; pendingAvatarFile = null; } catch (_) {}
    document.documentElement.classList.remove("lvc-open");
  };
  window.openAvatarCropModal = function (file) {
    var reader = new FileReader();
    reader.onerror = reader.onabort = function () { try { showToast("Couldn't open that photo. Try another one.", "error"); } catch (_) {} };
    reader.onload = function () {
      var old = document.getElementById("avatarCropModal"); if (old) old.remove();
      var D = dia();
      var m = document.createElement("div");
      m.id = "avatarCropModal"; m.className = "lvc";
      m.innerHTML = '<div class="lvc-top"><button type="button" class="lvc-x" aria-label="Cancel" onclick="closeAvatarCropModal()"><i class="fa-solid fa-xmark"></i></button><span>Move and scale</span><i></i></div>' +
        '<div class="lvc-stage" id="avatarCropViewport"><img id="avatarCropImage" alt="" draggable="false" src="' + reader.result + '"><div class="lvc-mask" style="width:' + D + 'px;height:' + D + 'px"></div></div>' +
        '<div class="lvc-bar"><button type="button" class="lvc-btn lvc-ghost" onclick="closeAvatarCropModal()">Cancel</button><span class="lvc-zoom"><button type="button" aria-label="Zoom out" onclick="lvCropZoom(1/1.25)"><i class="fa-solid fa-minus"></i></button><button type="button" aria-label="Zoom in" onclick="lvCropZoom(1.25)"><i class="fa-solid fa-plus"></i></button></span><button type="button" class="lvc-btn lvc-go" id="avatarCropDone" onclick="saveAvatarCrop()">Done</button></div>';
      document.body.appendChild(m);
      document.documentElement.classList.add("lvc-open");
      st = { D: D, s: 1.25, x: 0, y: 0, iw: 1, ih: 1, base: 1 };
      var img = document.getElementById("avatarCropImage");
      img.onload = function () {
        st.iw = img.naturalWidth || 1; st.ih = img.naturalHeight || 1;
        st.base = Math.max(st.D / st.iw, st.D / st.ih); paint();
      };
      var stage = document.getElementById("avatarCropViewport");
      var ptrs = {}, last = 0, lx = 0, ly = 0;
      function pts() { return Object.keys(ptrs).map(function (k) { return ptrs[k]; }); }
      function dist(a) { return Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y); }
      stage.addEventListener("pointerdown", function (e) { ptrs[e.pointerId] = { x: e.clientX, y: e.clientY }; try { stage.setPointerCapture(e.pointerId); } catch (_) {} var a = pts(); last = a.length > 1 ? dist(a) : 0; lx = e.clientX; ly = e.clientY; });
      stage.addEventListener("pointermove", function (e) {
        if (!st || !ptrs[e.pointerId]) return;
        ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
        var a = pts();
        if (a.length > 1) { var d = dist(a); if (last) zoomBy(d / last); last = d; }
        else { st.x += e.clientX - lx; st.y += e.clientY - ly; lx = e.clientX; ly = e.clientY; paint(); }
      });
      function up(e) { delete ptrs[e.pointerId]; var a = pts(); last = a.length > 1 ? dist(a) : 0; if (a.length === 1) { lx = a[0].x; ly = a[0].y; } }
      var lastTap = 0;
      stage.addEventListener("pointerup", function (e) { if (Object.keys(ptrs).length === 1 && Math.hypot(e.clientX - lx, e.clientY - ly) < 6) { var now = Date.now(); if (now - lastTap < 320 && st) { st.s = st.s > 1.4 ? 1 : 2.2; st.x = 0; st.y = 0; paint(); lastTap = 0; } else lastTap = now; } });
      stage.addEventListener("pointerup", up); stage.addEventListener("pointercancel", up);
      stage.addEventListener("wheel", function (e) { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.08 : 1 / 1.08); }, { passive: false });
    };
    reader.readAsDataURL(file);
  };
  window.saveAvatarCrop = async function () {
    var img = document.getElementById("avatarCropImage");
    if (!st || !img || !session) return;
    var out = 800, canvas = document.createElement("canvas"); canvas.width = out; canvas.height = out;
    var k = 1 / (st.base * st.s), side = st.D * k;
    var cx = st.iw / 2 - st.x * k, cy = st.ih / 2 - st.y * k;
    canvas.getContext("2d").drawImage(img, cx - side / 2, cy - side / 2, side, side, 0, 0, out, out);
    var btn = document.getElementById("avatarCropDone");
    var busy = function (on) { if (btn) { btn.disabled = on; btn.textContent = on ? "Saving…" : "Done"; } };
    busy(true);
    canvas.toBlob(async function (blob) {
      if (!blob) { busy(false); showToast("Could not prepare that photo.", "error"); return; }
      // show the new picture straight away; the upload and save carry on behind it, and the old picture comes back only if they fail
      var oldAv = profile.avatar_url, oldLogo = vendor && vendor.logo_url, local = URL.createObjectURL(blob);
      profile.avatar_url = local; if (vendor && vendor.id) vendor.logo_url = local;
      updateAuthUI(); closeAvatarCropModal(); showToast("Profile photo updated.", "success");
      try { window.lvAvatarChanged && window.lvAvatarChanged(); } catch (_) {}
      try {
        var publicUrl = await uploadToR2(blob, "avatars/" + session.user.id + "/avatar.jpg", "image/jpeg");
        var url = publicUrl + "?t=" + Date.now();
        var r = await sb.from("users").update({ avatar_url: url }).eq("id", session.user.id);
        if (r.error) throw r.error;
        profile.avatar_url = url;
        if (vendor && vendor.id) {
          var v = await sb.from("vendors").update({ logo_url: url }).eq("id", vendor.id);
          if (!v.error) vendor.logo_url = url;
        }
        updateAuthUI();
        try { window.lvAvatarChanged && window.lvAvatarChanged(); } catch (_) {}
      } catch (err) {
        profile.avatar_url = oldAv; if (vendor && vendor.id) vendor.logo_url = oldLogo;
        updateAuthUI(); try { window.lvAvatarChanged && window.lvAvatarChanged(); } catch (_) {}
        showToast((err && err.message) || "Couldn't save the photo. Try again.", "error");
      }
    }, "image/jpeg", 0.9);
  };
})();

/* ===== Header search: a plain, steady hint (it no longer cycles through words) ===== */
(function () {
  var HINT = "Search products, vendors and services";
  function set() { var el = document.querySelector(".header-search-row > span"); if (el && el.textContent !== HINT) el.textContent = HINT; }
  setInterval(function () { if (!document.hidden) set(); }, 1200);
  setTimeout(set, 300);
})();

/* ===== New accounts: a skippable "Set up your profile" page (photo + name), like WhatsApp ===== */
(function () {
  var orig = window.runPostAuthChecks;
  if (typeof orig !== "function") return;
  function flagKey() { return "lv-setup-done:" + (session && session.user && session.user.id); }
  function done() { try { return !!localStorage.getItem(flagKey()); } catch (_) { return true; } }
  function markDone() { try { localStorage.setItem(flagKey(), "1"); } catch (_) {} }
  function isNew() {
    var t = profile && profile.created_at ? new Date(profile.created_at).getTime() : 0;
    return t && Date.now() - t < 3 * 86400000;
  }
  var timer = 0;
  function close() { clearInterval(timer); var e = document.getElementById("lvSetup"); if (e) e.remove(); document.documentElement.classList.remove("lvsu-open"); }
  function paintAvatar() {
    var box = document.getElementById("lvSetupAv"); if (!box) return;
    box.innerHTML = (typeof profileAvatarHtml === "function" ? profileAvatarHtml(profile.avatar_url, profile.name || "You", "100%") : "") + '<span class="lvsu-cam"><i class="fa-solid fa-camera"></i></span>';
  }
  function show() {
    if (document.getElementById("lvSetup")) return;
    var d = document.createElement("div"); d.id = "lvSetup"; d.className = "lvsu";
    var biz = !!(window.lvBiz && window.lvBiz.isBusiness);
    d.innerHTML = '<div class="lvsu-bg" aria-hidden="true"><i></i><i></i><i></i></div>' +
      '<div class="lvsu-card"><span class="lvsu-step"><i class="fa-solid fa-wand-magic-sparkles"></i> ' + (biz ? "Your new business" : "Welcome to Levromart") + '</span>' +
      '<h2>Set up your profile</h2><p class="lvsu-lead">Add a photo and check the name so people know it\'s you. You can skip this and do it later.</p>' +
      '<button type="button" class="lvsu-av" id="lvSetupAv" aria-label="Choose a profile photo"></button><span class="lvsu-hint">Tap the picture to add a photo</span>' +
      '<input type="file" id="lvSetupFile" accept="image/*" hidden onchange="uploadAvatar(event)">' +
      '<div class="lvsu-field"><label class="lvsu-l" for="lvSetupName">' + (biz ? "Business name" : "Your name") + '</label><input id="lvSetupName" class="lvsu-name" type="text" maxlength="60" autocomplete="name" value=""></div>' +
      '<div class="lvsu-actions"><button type="button" class="lvsu-go" id="lvSetupGo">Continue</button><button type="button" class="lvsu-skip" id="lvSetupSkip">Skip for now</button></div></div>';
    document.body.appendChild(d);
    document.documentElement.classList.add("lvsu-open");
    document.getElementById("lvSetupName").value = profile.name || "";
    paintAvatar();
    document.getElementById("lvSetupAv").onclick = function () { document.getElementById("lvSetupFile").click(); };
    var last = profile.avatar_url;
    timer = setInterval(function () { if (profile && profile.avatar_url !== last) { last = profile.avatar_url; paintAvatar(); } }, 500);
    document.getElementById("lvSetupSkip").onclick = function () { markDone(); close(); };
    document.getElementById("lvSetupGo").onclick = async function () {
      var btn = this, v = document.getElementById("lvSetupName").value.trim();
      if (v && v !== profile.name) {
        if (v.length < 2) { showToast("Please enter your name.", "error"); return; }
        btn.disabled = true; btn.textContent = "Saving…";
        var r = await sb.from("users").update({ name: v }).eq("id", session.user.id);
        if (r.error) { btn.disabled = false; btn.textContent = "Continue"; showToast(r.error.message || "Couldn't save your name. Try again.", "error"); return; }
        profile.name = v; try { updateAuthUI(); } catch (_) {}
      }
      markDone(); close();
    };
  }
  window.runPostAuthChecks = async function () {
    await orig.apply(this, arguments);
    try {
      if (!profile || !session || profile.role === "admin" || done() || !isNew()) return;
      if (!String(profile.phone || "").trim() || profile.has_password === false) return;
      var blocked = ["setPasswordModal", "vendorPayoutNudgeModal"].some(function (id) { var m = document.getElementById(id); return m && !m.classList.contains("hidden"); });
      if (!blocked) show();
    } catch (_) {}
  };
})();

/* ===== Comments: one-tap reactions, a sticker button beside the box, and the comment count badge kept up to date ===== */
(function () {
  var CHIPS = ["❤️❤️❤️", "🔥🔥🔥", "⭐⭐⭐", "👏👏👏", "😍😍😍"];
  var STK = ["1f525", "2764-fe0f", "1f60d", "1f602", "1f44f", "1f64f", "1f4af", "1f389", "1f60e", "1f929", "1f973", "1f62d", "1f60a", "1f44d", "1f4aa", "2b50", "1f496", "1f970", "1f64c", "1f618", "1f440", "1f48e", "1f381", "1f680", "1f91d", "1f6cd-fe0f", "1f62e", "1f914", "1f631", "1f921", "1f308", "1f31f", "1f340", "1f354", "1f355", "1f37b", "1f37f", "1f383", "1f388", "1f38a", "1f3af", "1f3b6", "1f3c6", "1f431", "1f44a", "1f44b", "1f44c", "1f451", "1f47b", "1f480", "1f483", "1f48b", "1f493", "1f499", "1f49a", "1f49c", "1f4a1", "1f4a5", "1f4a9", "1f4b8", "1f4e6", "1f604", "1f605", "1f606", "1f607", "1f608", "1f609", "1f60b", "1f61c", "1f621", "1f622", "1f624", "1f62a", "1f634", "1f642", "1f643", "1f69a", "1f6d2", "1f90c", "1f90d", "1f911", "1f913", "1f916", "1f917", "1f919", "1f91e", "1f923", "1f92c", "1f92f", "1f942", "1f972", "1f975", "1f976", "1f979", "1f97a", "1f981", "1f984", "1f98b", "1f9e1", "26a1", "270a", "2728"];
  // "3d/<code>" is the glossy 3D set (/stickers3d); the others are the flat and moving ones
  function stkSrc(id) { return id.indexOf("3d/") === 0 ? "/stickers3d/" + id.slice(3) + ".webp" : "/stickers/" + id + ".webp"; }
  window.lvStk = { list: STK, src: stkSrc };
  // a comment that is only a sticker is drawn as the picture straight away (no flash of the sticker's code first)
  (function () {
    var om = window.lvMentionHtml;
    window.lvMentionHtml = function (c) {
      var m = /^\s*::s:((?:still\/|3d\/)?[0-9a-f-]+)::\s*$/.exec(String(c == null ? "" : c));
      if (m) return '<img class="lv-stk" src="' + stkSrc(m[1]) + '" alt="sticker" width="96" height="96" decoding="async">';
      return om ? om.apply(this, arguments) : String(c == null ? "" : c).replace(/[&<>"]/g, function (x) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[x]; });
    };
  })();
  function showStickers() {
    document.querySelectorAll(".product-comment-body:not([data-stk])").forEach(function (b) {
      var m = /^::s:((?:still\/|3d\/)?[0-9a-f-]+)::$/.exec((b.textContent || "").trim());
      b.dataset.stk = "1";
      if (m) b.innerHTML = '<img class="lv-stk" src="' + stkSrc(m[1]) + '" alt="sticker" width="96" height="96" loading="lazy" decoding="async">';
    });
  }
  function syncCount() {
    var panel = document.getElementById("productCommentsPanel"); if (!panel) return;
    if (panel.querySelector(".comment-fetch-placeholder")) return;
    var n = panel.querySelectorAll("[data-comment-id]").length;
    if (!n && !panel.querySelector(".product-comments-empty")) return;
    document.querySelectorAll(".product-detail-card .lv-ccount, #productCommentsCount").forEach(function (b) { if (b.textContent !== String(n)) b.textContent = String(n); });
  }
  function dress() {
    showStickers(); syncCount();
    document.querySelectorAll(".product-comment-composer").forEach(function (c) {
      if (c.dataset.lvChips) return;
      var ta = c.querySelector("textarea"); var send = c.querySelector(".product-comment-compose-row button");
      if (!ta || !send || /package/i.test(ta.id)) return;
      c.dataset.lvChips = "1";
      var row = document.createElement("div"); row.className = "lv-cmt-chips";
      CHIPS.forEach(function (t) {
        var b = document.createElement("button"); b.type = "button"; b.textContent = t;
        b.onclick = function () {
          if (!session) { try { showLogin(); } catch (_) {} return; }
          ta.value = t; ta.dispatchEvent(new Event("input", { bubbles: true })); send.click();
        };
        row.appendChild(b);
      });
      var compose = c.querySelector(".product-comment-compose-row");
      // stickers: a button at the start of the row opens a grid; tapping a sticker posts it as the comment
      // two sets: still stickers and moving ones, switched with the tabs at the top of the panel
      var panel = document.createElement("div"); panel.className = "lv-stk-panel hidden";
      var tabs = document.createElement("div"); tabs.className = "lv-stk-tabs"; panel.appendChild(tabs);
      var grids = {};
      [["3d", "3D"], ["still", "Flat"], ["", "Moving"]].forEach(function (set, i) {
        var tb = document.createElement("button"); tb.type = "button"; tb.textContent = set[1]; tb.className = i === 0 ? "on" : "";
        var grid = document.createElement("div"); grid.className = "lv-stk-grid" + (i === 0 ? "" : " hidden"); grids[set[0]] = grid;
        tb.onclick = function () { tabs.querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === tb); }); Object.keys(grids).forEach(function (k) { grids[k].classList.toggle("hidden", k !== set[0]); }); };
        tabs.appendChild(tb);
        STK.forEach(function (code) {
          var id = (set[0] ? set[0] + "/" : "") + code;
          var sb2 = document.createElement("button"); sb2.type = "button"; sb2.setAttribute("aria-label", "Send sticker");
          sb2.innerHTML = '<img src="' + stkSrc(id) + '" alt="" width="48" height="48" loading="lazy" decoding="async">';
          sb2.onclick = function () { if (!session) { try { showLogin(); } catch (_) {} return; } panel.classList.add("hidden"); ta.value = "::s:" + id + "::"; ta.dispatchEvent(new Event("input", { bubbles: true })); send.click(); };
          grid.appendChild(sb2);
        });
        panel.appendChild(grid);
      });
      var tog = document.createElement("button"); tog.type = "button"; tog.className = "lv-stk-tog"; tog.setAttribute("aria-label", "Stickers"); tog.innerHTML = '<i class="fa-regular fa-face-smile"></i>';
      tog.onclick = function () { panel.classList.toggle("hidden"); };
      compose.insertBefore(tog, compose.firstChild);
      c.insertBefore(panel, compose); c.insertBefore(row, panel);
    });
  }
  var raf = 0;
  try { new MutationObserver(function () { if (!raf) raf = requestAnimationFrame(function () { raf = 0; dress(); }); }).observe(document.body, { childList: true, subtree: true }); } catch (_) {}
  dress();
})();

/* ===== Laptop / desktop: the side menu hides behind a menu button, and side-scrolling rows get arrows ===== */
(function () {
  var mq = window.matchMedia("(min-width: 1024px)");
  var root = document.documentElement;
  function close() { root.classList.remove("lv-rail-open"); var b = document.getElementById("lvRailBtn"); if (b) b.setAttribute("aria-expanded", "false"); }
  function toggle() { var open = !root.classList.contains("lv-rail-open"); root.classList.toggle("lv-rail-open", open); var b = document.getElementById("lvRailBtn"); if (b) b.setAttribute("aria-expanded", String(open)); }
  window.lvCloseRail = close;
  function ensure() {
    var row = document.querySelector("header .header-top-row");
    if (row && !document.getElementById("lvRailBtn")) {
      var b = document.createElement("button");
      b.type = "button"; b.id = "lvRailBtn"; b.className = "lv-rail-btn"; b.setAttribute("aria-label", "Menu"); b.setAttribute("aria-expanded", "false"); b.setAttribute("aria-controls", "bottomNav");
      b.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';
      b.onclick = function (e) { e.stopPropagation(); toggle(); };
      row.insertBefore(b, row.firstChild);
    }
    if (!document.getElementById("lvRailScrim")) {
      var s = document.createElement("div"); s.id = "lvRailScrim"; s.onclick = close; document.body.appendChild(s);
    }
  }
  // choosing anything in the menu closes it
  document.addEventListener("click", function (e) { if (root.classList.contains("lv-rail-open") && e.target.closest && e.target.closest("#bottomNav .bottom-nav-item, #bottomNav .bottom-nav-add")) setTimeout(close, 60); }, true);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
  if (mq.addEventListener) mq.addEventListener("change", function () { if (!mq.matches) close(); });
  ensure(); document.addEventListener("DOMContentLoaded", ensure); setTimeout(ensure, 1500);

  // arrows for rows that scroll sideways (a mouse cannot swipe them)
  var prev, next, cur = null, hideT = 0;
  function btn(dir) {
    var b = document.createElement("button"); b.type = "button"; b.className = "lv-row-arrow lv-row-" + dir; b.setAttribute("aria-label", dir === "prev" ? "Scroll left" : "Scroll right");
    b.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="' + (dir === "prev" ? "M15 18l-6-6 6-6" : "M9 18l6-6-6-6") + '"/></svg>';
    b.onclick = function () { if (cur) cur.scrollBy({ left: (dir === "prev" ? -1 : 1) * Math.max(240, cur.clientWidth * 0.8), behavior: "smooth" }); setTimeout(place, 420); };
    b.onmouseenter = function () { clearTimeout(hideT); };
    document.body.appendChild(b); return b;
  }
  function scroller(el) {
    while (el && el !== document.body) {
      if (el.scrollWidth > el.clientWidth + 8) { var ox = getComputedStyle(el).overflowX; if (ox === "auto" || ox === "scroll") return el; }
      el = el.parentElement;
    }
    return null;
  }
  function place() {
    if (!cur || !mq.matches) { if (prev) { prev.classList.remove("on"); next.classList.remove("on"); } return; }
    var r = cur.getBoundingClientRect(), y = r.top + r.height / 2 - 20;
    if (r.bottom < 0 || r.top > innerHeight) { prev.classList.remove("on"); next.classList.remove("on"); return; }
    prev.style.top = next.style.top = y + "px"; prev.style.left = (r.left + 8) + "px"; next.style.left = (r.right - 48) + "px";
    prev.classList.toggle("on", cur.scrollLeft > 4); next.classList.toggle("on", cur.scrollLeft + cur.clientWidth < cur.scrollWidth - 4);
  }
  document.addEventListener("mouseover", function (e) {
    if (!mq.matches || !e.target.closest || e.target.closest(".lv-row-arrow")) return;
    var s = scroller(e.target);
    if (!s || s.closest("#bottomNav, .leaflet-container, .vmpage")) { clearTimeout(hideT); hideT = setTimeout(function () { cur = null; place(); }, 250); return; }
    clearTimeout(hideT);
    if (!prev) { prev = btn("prev"); next = btn("next"); }
    cur = s; place();
  }, { passive: true });
  addEventListener("scroll", function () { if (cur) place(); }, { passive: true, capture: true });
})();

/* ===== Wallet colours: a small palette button next to the "Wallet" label; the choice is remembered on this phone ===== */
(function () {
  "use strict";
  var THEMES = ["", "violet", "ocean", "sunset", "rose", "midnight"];
  var KEY = "lv-wallet-theme";
  function read() {
    try { var v = localStorage.getItem(KEY); if (v !== null) return v; } catch (_) {}
    try { var m = /(?:^|; )lv-wallet-theme=([^;]*)/.exec(document.cookie); return m ? decodeURIComponent(m[1]) : ""; } catch (_) { return ""; }
  }
  function save(t) {
    try { localStorage.setItem(KEY, t); } catch (_) {}
    try { document.cookie = KEY + "=" + encodeURIComponent(t) + "; max-age=31536000; path=/; samesite=lax"; } catch (_) {}
  }
  function apply(t) { if (t) document.documentElement.setAttribute("data-lvw-theme", t); else document.documentElement.removeAttribute("data-lvw-theme"); }
  apply(read());
  // an installed app can be woken from the background: put the saved colour back whenever it comes forward
  document.addEventListener("visibilitychange", function () { if (!document.hidden) apply(read()); });
  window.addEventListener("pageshow", function () { apply(read()); });
  // the colour choice lives in the wallet's help sheet (the "?" beside the wallet's name)
  var NAMES = { "": "Green", violet: "Violet", ocean: "Ocean", sunset: "Sunset", rose: "Rose", midnight: "Midnight" };
  window.lvWalletColoursHtml = function () {
    var cur = document.documentElement.getAttribute("data-lvw-theme") || "";
    return '<div class="lvw-colours"><div class="lvw-colours-h">Wallet colour</div><div class="lvw-swatches" role="radiogroup" aria-label="Wallet colour">' +
      THEMES.map(function (t) { return '<button type="button" role="radio" aria-checked="' + (t === cur) + '" class="lvw-sw lvw-sw-' + (t || "green") + (t === cur ? " on" : "") + '" onclick="lvWalletSetTheme(\'' + t + '\')"><span class="lvw-sw-dot">' + (t === cur ? '<i class="fa-solid fa-check"></i>' : "") + '</span><small>' + NAMES[t] + '</small></button>'; }).join("") +
      '</div></div>';
  };
  window.lvWalletSetTheme = function (t) {
    if (THEMES.indexOf(t) < 0) t = "";
    apply(t); save(t);
    document.querySelectorAll(".lvw-colours").forEach(function (box) { var tmp = document.createElement("div"); tmp.innerHTML = window.lvWalletColoursHtml(); box.replaceWith(tmp.firstChild); });
  };
  window.lvWalletTheme = function (e) {
    if (e) { e.stopPropagation(); e.preventDefault(); }
    var cur = document.documentElement.getAttribute("data-lvw-theme") || "";
    var next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
    apply(next); save(next);
  };
  function addButtons() {
    document.querySelectorAll(".lvw-card:not(.lvw2) .lvw-top").forEach(function (top) {
      if (top.querySelector(".lvw-theme-btn")) return;
      var b = document.createElement("button");
      b.type = "button"; b.className = "lvw-theme-btn"; b.title = "Change wallet colour"; b.setAttribute("aria-label", "Change wallet colour");
      b.innerHTML = '<i class="fa-solid fa-palette" aria-hidden="true"></i>';
      b.onclick = window.lvWalletTheme;
      var label = top.querySelector(".lvw-label");
      if (label && label.nextSibling) top.insertBefore(b, label.nextSibling); else top.appendChild(b);   // beside the label, the eye stays at the far right
    });
    apply(read());
  }
  var raf = 0;
  new MutationObserver(function () { if (!raf) raf = requestAnimationFrame(function () { raf = 0; addButtons(); }); }).observe(document.body, { childList: true, subtree: true });
  addButtons();
})();

/* ===== Bottom bar: each icon has its own little motion when tapped (home hops, the pin drops, Request twirls, the bell rings, the receipt slides) ===== */
(function () {
  "use strict";
  var MAP = { home: "hop", vendors: "drop", request: "twirl", add: "twirl", notifications: "ring", orders: "slide" };
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("#bottomNav .bottom-nav-item, #bottomNav .bottom-nav-add");
    if (!b) return;
    var label = (b.textContent || "").trim().toLowerCase().replace(/\s+/g, " ");
    var kind = MAP[label]; if (!kind) return;
    var ic = b.querySelector(".bn-icon"); if (!ic) return;
    ic.classList.remove("bn-m-hop", "bn-m-drop", "bn-m-twirl", "bn-m-ring", "bn-m-slide");
    void ic.offsetWidth;   // restart the motion even on a quick second tap
    ic.classList.add("bn-m-" + kind);
    setTimeout(function () { ic.classList.remove("bn-m-" + kind); }, 700);
  }, true);
})();

/* ===== Vendors page: Levi morphs into a floating map pin (draggable, sparkling); tapping it opens the map ===== */
(function () {
  "use strict";
  var POS = "lv-mapfab-pos", fab = null, busy = 0;
  var PIN = '<svg class="mf-pin" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>';
  function levi() { return document.getElementById("aiChatFab"); }
  // Levi turns into a pin on the Vendors page and into a magnifying glass (still carrying the Levromart mark) on the Search page
  var LENS = '<svg viewBox="0 0 48 48" width="44" height="44" fill="none" aria-hidden="true"><defs><linearGradient id="lvLensA" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#19c486"/><stop offset="1" stop-color="#7c3aed"/></linearGradient><linearGradient id="lvLensB" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c3aed"/><stop offset="1" stop-color="#19c486"/></linearGradient></defs><g class="mf-lens-ring"><path d="M13.7 31.9A13.5 13.5 0 0 1 13.7 8.1" stroke="url(#lvLensA)" stroke-width="4.6" stroke-linecap="round"/><path d="M26.3 8.1A13.5 13.5 0 0 1 26.3 31.9" stroke="url(#lvLensA)" stroke-width="4.6" stroke-linecap="round"/><circle cx="20" cy="20" r="3.6" fill="url(#lvLensB)"/></g><path d="M34.5 34.5 42 42" stroke="url(#lvLensB)" stroke-width="6" stroke-linecap="round"/></svg>';
  function modeNow() { try { var v = typeof currentView !== "undefined" ? currentView : ""; return v === "vendors" ? "vendors" : v === "search" ? "search" : ""; } catch (_) { return ""; } }
  // the 3D magnifier (Search) and the 3D map pin (Vendors), floating on their own: no tile behind them
  function core(mode) { return '<span class="mf-core mf-3dcore"><img class="mf-3d" src="/icons3d/lv/' + (mode === "search" ? "search" : "map-pin") + '.webp" alt="" width="64" height="64" draggable="false" decoding="async"></span>'; }
  function tap(mode) { if (mode === "search") { try { if (typeof toggleAiChat === "function") { var pnl = document.getElementById("aiChatPanel"); if (!pnl || pnl.classList.contains("hidden")) toggleAiChat(); } } catch (_) {} } else { try { navigate("vendorsMap"); } catch (_) {} } }
  function clampPos(x, y) {
    var w = innerWidth, h = innerHeight;
    return { x: Math.min(Math.max(x, 8), w - 68), y: Math.min(Math.max(y, 70), h - 150) };
  }
  function build(x, y, mode) {
    var b = document.createElement("button");
    b.type = "button"; b.id = "lvMapFab"; b.className = "lv-mapfab"; b.setAttribute("aria-label", mode === "search" ? "Ask Levi" : "Open the vendors map"); b.title = mode === "search" ? "Search" : "Vendors map";
    b.innerHTML = core(mode); b.__mode = mode; b.setAttribute("data-mode", mode);
    b.style.left = x + "px"; b.style.top = y + "px";
    attachDrag(b);
    return b;
  }
  function attachDrag(b) {
    var sx = 0, sy = 0, bl = 0, bt = 0, moved = false, id = null, raf = 0, lx = 0, ly = 0;
    b.addEventListener("pointerdown", function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      id = e.pointerId; moved = false; sx = e.clientX; sy = e.clientY;
      var r = b.getBoundingClientRect(); bl = r.left; bt = r.top; lx = bl; ly = bt;
      try { b.setPointerCapture(id); } catch (_) {}
    }, { passive: true });
    b.addEventListener("pointermove", function (e) {
      if (id === null || e.pointerId !== id) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.hypot(dx, dy) > 6) { moved = true; window.__lvDragging = true; b.classList.add("mf-drag"); document.documentElement.classList.add("lv-fab-dragging"); }
      if (!moved) return;
      var p = clampPos(bl + dx, bt + dy); lx = p.x; ly = p.y;
      if (!raf) raf = requestAnimationFrame(function () { raf = 0; b.style.transform = "translate3d(" + (lx - bl) + "px," + (ly - bt) + "px,0)"; });
    }, { passive: true });
    function end(e) {
      if (id === null || (e && e.pointerId !== id)) return;
      id = null; if (raf) { cancelAnimationFrame(raf); raf = 0; }
      window.__lvDragging = false; b.classList.remove("mf-drag"); document.documentElement.classList.remove("lv-fab-dragging");
      if (moved) {
        b.style.left = lx + "px"; b.style.top = ly + "px"; b.style.transform = ""; b.style.translate = "";
        try { localStorage.setItem(POS, JSON.stringify({ x: lx, y: ly })); } catch (_) {}
      } else { tap(b.__mode); }
    }
    b.addEventListener("pointerup", end, { passive: true });
    b.addEventListener("pointercancel", end, { passive: true });
  }
  function show() {
    if (fab || busy) return;
    var l = levi(), r = l && l.offsetWidth ? l.getBoundingClientRect() : null;
    var saved = null; try { saved = JSON.parse(localStorage.getItem(POS) || "null"); } catch (_) {}
    // it appears exactly where Levi is right now (the saved spot is only used when Levi cannot be found)
    var start = r ? { x: r.left + r.width / 2 - 30, y: r.top + r.height / 2 - 30 } : saved && Number.isFinite(saved.x) ? { x: saved.x, y: saved.y } : { x: innerWidth - 78, y: innerHeight - 190 };
    start = clampPos(start.x, start.y);
    fab = build(start.x, start.y, modeNow());
    document.body.appendChild(fab);
    requestAnimationFrame(function () { fab.classList.add("mf-in"); });
    if (l) l.classList.add("lv-levi-away");   // Levi shrinks and turns away while the pin grows in his place
  }
  function hide() {
    if (!fab) return;
    var f = fab; fab = null; busy++;
    f.classList.remove("mf-in"); f.classList.add("mf-out");
    var l = levi(); if (l) l.classList.remove("lv-levi-away");   // Levi comes back
    setTimeout(function () { try { f.remove(); } catch (_) {} busy = Math.max(0, busy - 1); check(); }, 420);
  }
  function check() {
    var m = modeNow();
    if (!m) { hide(); return; }
    if (!fab) { show(); return; }
    if (fab.__mode !== m && fab.classList.contains("mf-in")) {   // Vendors <-> Search: the icon warps into the other one in place
      var f = fab; f.classList.remove("mf-in"); f.classList.add("mf-swap");
      setTimeout(function () { if (!f.isConnected) return; f.innerHTML = core(m); f.__mode = m; f.setAttribute("data-mode", m); f.setAttribute("aria-label", m === "search" ? "Search" : "Open the vendors map"); f.title = m === "search" ? "Search" : "Vendors map"; f.classList.remove("mf-swap"); f.classList.add("mf-in"); }, 220);
    }
  }
  var nav = window.navigate;
  if (typeof nav === "function") {
    window.navigate = function () { var r = nav.apply(this, arguments); setTimeout(check, 0); try { Promise.resolve(r).then(check, check); } catch (_) {} return r; };
  }
  setInterval(check, 600);
  window.addEventListener("popstate", function () { setTimeout(check, 50); });
  setTimeout(check, 800);
})();

/* ===== Trending rails: every product in the app, once each, then the row simply ends (no looping) =====
   Near the end of a sideways row, the next products are added in one fixed (shuffled once) order. A product already on the row
   is never added again, and when all of them have been shown nothing more is added. ===== */
(function () {
  "use strict";
  var BATCH = 12;
  function shuffle(a) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  window.__lvTrendOrder = window.__lvTrendOrder || {};
  function attach(rail) {
    if (rail.__lvEndless) return; rail.__lvEndless = true;
    var isSvc = rail.classList.contains("service-trending-scroll"), key = isSvc ? "svc" : "prod";
    var busy = false;
    function order() {
      var cur = window.__lvTrendOrder[key];
      if (cur && cur.length) return cur;
      var idx = window.__homeBrowseIndex;
      if (!Array.isArray(idx)) return [];
      cur = shuffle(idx.filter(function (x) { return !!x.is_service === isSvc; }).map(function (x) { return String(x.id); }));
      window.__lvTrendOrder[key] = cur; return cur;
    }
    async function more() {
      if (busy || typeof fetchProductsByIds !== "function" || typeof productCardHtml !== "function") return;
      busy = true;
      try {
        var ids = order(); if (!ids.length) return;
        var onRail = new Set([].map.call(rail.querySelectorAll("[data-product-id]"), function (e) { return e.getAttribute("data-product-id"); }));
        var take = ids.filter(function (id) { return !onRail.has(id); }).slice(0, BATCH);
        if (!take.length) return;                       // everything has been shown: the row ends here
        var rows = await fetchProductsByIds(take);
        if (!rail.isConnected || !rows || !rows.length) return;
        var have = new Set([].map.call(rail.querySelectorAll("[data-product-id]"), function (e) { return e.getAttribute("data-product-id"); }));
        var fresh = rows.filter(function (r) { return r && !have.has(String(r.id)); });
        if (fresh.length) rail.insertAdjacentHTML("beforeend", fresh.map(productCardHtml).join(""));
      } catch (_) {} finally { busy = false; }
    }
    rail.addEventListener("scroll", function () { if (rail.scrollWidth - rail.scrollLeft - rail.clientWidth < 900) more(); }, { passive: true });
    setTimeout(function () { if (rail.isConnected && rail.scrollWidth - rail.clientWidth < 900) more(); }, 1500);
  }
  var raf = 0;
  new MutationObserver(function () { if (!raf) raf = requestAnimationFrame(function () { raf = 0; document.querySelectorAll("#app .hscroll.trending-scroll").forEach(attach); }); }).observe(document.body, { childList: true, subtree: true });
})();

/* ===== Profile picture: choosing a photo never leaves the page, and a new picture shows everywhere at once ===== */
(function () {
  "use strict";
  // The hidden file picker sits inside clickable areas (like the panel header that opens "my profile"). Opening it from code sends a
  // click that bubbled up to them and took the person away from the page before the photo was even chosen.
  document.addEventListener("click", function (e) {
    var t = e.target;
    if (t && t.matches && t.matches('input[type="file"]')) e.stopPropagation();
  }, true);

  function rawOf(src) {
    if (!src) return "";
    return window.lvOriginalImg ? window.lvOriginalImg(src) : src;
  }
  // every small picture of this account (top right, side panel, My account, vendor cards) is swapped for the new one in place
  function refreshEverywhere() {
    try {
      var uid = session && session.user && session.user.id, url = profile && profile.avatar_url;
      if (!uid) return;
      var key = "/avatars/" + uid + "/";
      var imgs = document.querySelectorAll("img");
      for (var i = 0; i < imgs.length; i++) {
        var im = imgs[i], raw = rawOf(im.getAttribute("src") || "");
        if (raw.indexOf(key) < 0) continue;
        if (!url) { im.style.visibility = "hidden"; continue; }
        var w = im.getBoundingClientRect().width || 120;
        im.src = (typeof lvThumb === "function" ? lvThumb(url, Math.max(160, Math.min(400, Math.round(w)))) : url) || url;
        im.style.visibility = "";
      }
      if (window.lvDropPageSnaps) window.lvDropPageSnaps();   // the saved copies of Home and shop pages (for a quick Back) still show the old one
    } catch (_) {}
  }
  var prev = window.lvAvatarChanged;
  window.lvAvatarChanged = function () {
    try { if (typeof prev === "function") prev.apply(this, arguments); } catch (_) {}
    refreshEverywhere();
    [150, 700].forEach(function (ms) { setTimeout(refreshEverywhere, ms); });   // after the header and panel have redrawn
  };
})();

/* ===== The first time someone opens a product, a small hint shows that they can swipe sideways to the next product ===== */
(function () {
  "use strict";
  var KEY = "lv-swipe-hint-v1", shownFor = null;
  function seen() { try { return localStorage.getItem(KEY) === "1"; } catch (_) { return false; } }
  function show() {
    if (seen() || document.getElementById("lvSwipeHint")) return;
    var d = document.createElement("div");
    d.id = "lvSwipeHint"; d.setAttribute("aria-hidden", "true");
    // Levi's flat mark "drags" the page a little to the left and lets go, twice: a teaser, the page is not really swiped
    d.innerHTML = '<span class="lvsh-levi">' + (window.lvMascotSvg || "") + '</span><b>Swipe for the next product</b>';
    var page = document.getElementById("app"), lv = d.querySelector(".lvsh-levi");
    try {
      if (lv && lv.animate) {
        var move = [{ transform: "translateX(0)" }, { transform: "translateX(-46px)", offset: .5 }, { transform: "translateX(0)" }];
        lv.animate(move, { duration: 1300, iterations: 2, easing: "ease-in-out" });
        if (page && page.animate) page.animate([{ transform: "translateX(0)" }, { transform: "translateX(-26px)", offset: .5 }, { transform: "translateX(0)" }], { duration: 1300, iterations: 2, easing: "ease-in-out" });
      }
    } catch (_) {}
    document.body.appendChild(d);
    try { localStorage.setItem(KEY, "1"); } catch (_) {}
    var gone = false;
    function kill() { if (gone) return; gone = true; d.classList.add("out"); setTimeout(function () { d.remove(); }, 300); }
    setTimeout(kill, 5200);
    ["touchstart", "pointerdown"].forEach(function (t) { document.addEventListener(t, kill, { once: true, passive: true, capture: true }); });
  }
  var raf = 0;
  new MutationObserver(function () {
    if (raf) return;
    raf = requestAnimationFrame(function () {
      raf = 0;
      try {
        if (typeof currentView === "undefined" || currentView !== "productDetail") { shownFor = null; var h = document.getElementById("lvSwipeHint"); if (h) h.remove(); return; }
        if (!seen() && document.querySelector("#app .product-detail-title") && shownFor !== location.href) { shownFor = location.href; setTimeout(show, 900); }
      } catch (_) {}
    });
  }).observe(document.body, { childList: true, subtree: true });
})();

/* ---- occasional welcome pop-up (lv-promo) ----
   Now and then, when someone opens the app on the home screen, a short card about one Levromart feature pops up,
   with a round X underneath to close it. It never shows on the first visit, before onboarding is finished, more
   than once every two days, or over another open sheet. The cards take turns; the artwork is the onboarding art. */
(function () {
  "use strict";
  var KEY = "lv_promo_v1", WAIT_MS = 2500;
  // kept in local storage AND a cookie: some phones lose one of them when the app is closed, which made the same card
  // come back every time; whichever copy has seen more app opens wins
  function fromCookie() { try { var m = /(?:^|; )lv_promo_v1=([^;]*)/.exec(document.cookie); return m ? JSON.parse(decodeURIComponent(m[1])) || {} : {}; } catch (_) { return {}; } }
  function load() {
    var a = {}; try { a = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (_) {}
    var b = fromCookie();
    return Number(b.opens || 0) > Number(a.opens || 0) || Number(b.at || 0) > Number(a.at || 0) ? b : a;
  }
  function gapFor(st) { return 4 + (Number(st.n || 0) % 3); }   // only now and then: every 4th, 5th or 6th open
  function save(s) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (_) {}
    try { document.cookie = "lv_promo_v1=" + encodeURIComponent(JSON.stringify({ opens: s.opens, at: s.at, n: s.n, last: s.last, seen: s.seen })) + "; max-age=31536000; path=/; samesite=lax"; } catch (_) {}
  }
  var arts = [].slice.call(document.querySelectorAll("#lvOnb img.lv-hero")).map(function (i) { return i.getAttribute("src") || ""; });
  function isVendor() { try { return typeof profile !== "undefined" && profile && profile.role === "vendor"; } catch (_) { return false; } }
  function closeAi() { try { var p = document.getElementById("aiChatPanel"); return !p || p.classList.contains("hidden"); } catch (_) { return true; } }
  var CARDS = [
    { key: "safe", tone: "green", art: 1, kicker: "Shop with peace of mind", t1: "Pay safe.", t2: "Shop happy.",
      sub: "Your money stays with Levromart until you confirm you got your order.", cta: "Start shopping", icon: "fa-shield-halved",
      go: function () { if (typeof navigate === "function") navigate("home"); setTimeout(function () { var b = document.getElementById("browseSection"); if (b) b.scrollIntoView({ behavior: "smooth", block: "start" }); }, 250); } },
    { key: "levi", tone: "purple", art: 0, kicker: "Meet Levi", t1: "Just ask.", t2: "Levi finds it.",
      sub: "A gown, the closest vendor, the best price. Ask Levi and get real products in seconds.", cta: "Ask Levi", icon: "fa-wand-magic-sparkles",
      go: function () { if (typeof toggleAiChat === "function" && closeAi()) toggleAiChat(); } },
    { key: "near", tone: "blue", art: 1, kicker: "Around you", t1: "Vendors", t2: "near you.",
      sub: "See who sells close to you, what they sell and how far they are.", cta: "Find vendors", icon: "fa-location-dot",
      go: function () { if (typeof navigate === "function") navigate("vendors"); } },
    { key: "sell", tone: "amber", art: 2, kicker: "Got something to sell?", t1: "Open your", t2: "own shop.",
      sub: "Sell to shoppers around you and get paid safely through Levromart.", cta: "Start selling", icon: "fa-store", forVendors: false,
      go: function () { if (typeof session === "undefined" || !session) { if (typeof showLogin === "function") showLogin(); return; } if (typeof navigate === "function") navigate("vendorApply"); } }
  ];
  function pick(s) {
    var list = CARDS.filter(function (c) { return !(c.forVendors === false && isVendor()); });
    if (!list.length) return null;
    var n = Number(s.n || 0);
    return list[n % list.length];
  }
  function close(m, done) {
    if (!m || m.__closing) return; m.__closing = true;
    m.classList.add("lv-promo-out");
    document.removeEventListener("keydown", m.__key);
    setTimeout(function () { m.remove(); if (done) done(); }, 220);
  }
  function show(card) {
    if (!card || document.getElementById("lvPromo")) return;
    var art = arts[card.art] || arts[0] || "";
    var m = document.createElement("div");
    m.id = "lvPromo"; m.className = "lv-promo lv-promo-" + card.tone;
    m.innerHTML =
      '<div class="lv-promo-wrap" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="lvPromoTitle" aria-describedby="lvPromoSub">' +
        '<div class="lv-promo-card">' +
          '<span class="lv-promo-glow" aria-hidden="true"></span>' +
          '<span class="lv-promo-coin c1" aria-hidden="true">₦</span><span class="lv-promo-coin c2" aria-hidden="true">₦</span>' +
          '<span class="lv-promo-spark s1" aria-hidden="true"></span><span class="lv-promo-spark s2" aria-hidden="true"></span><span class="lv-promo-spark s3" aria-hidden="true"></span>' +
          (art ? '<img class="lv-promo-art" src="' + art + '" alt="" decoding="async" />' : '') +
          '<div class="lv-promo-body">' +
            '<span class="lv-promo-kicker"><i class="fa-solid ' + card.icon + '" aria-hidden="true"></i>' + card.kicker + '</span>' +
            '<h2 id="lvPromoTitle" class="lv-promo-title"><span>' + card.t1 + '</span><span class="lv-promo-hl">' + card.t2 + '</span></h2>' +
            '<p id="lvPromoSub" class="lv-promo-sub">' + card.sub + '</p>' +
            '<button type="button" class="lv-promo-cta">' + card.cta + '<i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>' +
          '</div>' +
        '</div>' +
        '<button type="button" class="lv-promo-x" aria-label="Close"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>' +
      '</div>';
    m.addEventListener("click", function (e) {
      if (e.target.closest(".lv-promo-cta")) { close(m, function () { try { card.go(); } catch (_) {} }); return; }
      if (e.target.closest(".lv-promo-x") || e.target === m) close(m);
    });
    m.__key = function (e) { if (e.key === "Escape") close(m); };
    document.addEventListener("keydown", m.__key);
    document.body.appendChild(m);
    try { m.querySelector(".lv-promo-wrap").focus({ preventScroll: true }); } catch (_) {}
  }
  function busy() {
    if (document.querySelector(".modal.open, #lvPayModal, #lvRefundSheet, .lv-ap-sheet")) return true;
    var mods = document.querySelectorAll(".modal:not(.hidden)");
    for (var i = 0; i < mods.length; i++) if (mods[i].offsetParent !== null || getComputedStyle(mods[i]).position === "fixed" && getComputedStyle(mods[i]).display !== "none" && getComputedStyle(mods[i]).visibility !== "hidden") return true;
    var onb = document.getElementById("lvOnb");
    if (onb && onb.offsetParent !== null && getComputedStyle(onb).display !== "none" && getComputedStyle(onb).visibility !== "hidden") return true;
    return !closeAi();
  }
  function onboarded() {
    try { if (localStorage.getItem("levromart_onboarding_completed") === "true" || sessionStorage.getItem("levromart_onboarding_completed") === "true") return true; } catch (_) {}
    try { return typeof session !== "undefined" && !!session; } catch (_) { return false; }
  }
  // counts app opens (a fresh start, or coming back to the app after 30 minutes away); never on the very first one
  var s = load(); s.opens = Number(s.opens || 0) + 1; save(s);
  var hiddenAt = 0;
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > 30 * 60 * 1000) { var st = load(); st.opens = Number(st.opens || 0) + 1; save(st); tries = 0; setTimeout(maybe, WAIT_MS); }
  });
  var tries = 0;
  function maybe() {
    var st = load();
    if (/[?&]nopromo\b/.test(location.search)) return;
    if (st.opens < 2 || !onboarded()) return;
    if (Number(st.seen || 0) === st.opens) return;                      // already shown on this open
    if (st.last != null && st.opens - Number(st.last) < gapFor(st)) return;
    if (Number(st.at || 0) && Date.now() - Number(st.at) < 20 * 3600 * 1000) return;   // and never twice in the same day
    // not on the home screen yet, or something else is open: look again a little later (for about half a minute)
    var later = function () { if (++tries < 8) setTimeout(maybe, 4000); };
    if (typeof currentView !== "undefined" && currentView !== "home") return later();
    if (document.visibilityState === "hidden" || busy()) return later();
    var card = pick(st); if (!card) return;
    st.at = Date.now(); st.n = Number(st.n || 0) + 1; st.last = st.opens; st.seen = st.opens; save(st);
    show(card);
  }
  setTimeout(maybe, WAIT_MS);
  // for checking a card on a preview: lvShowPromo("safe" | "levi" | "near" | "sell")
  window.lvShowPromo = function (key) { show(CARDS.filter(function (c) { return c.key === key; })[0] || CARDS[0]); };
})();

/* ---- Orders page, tidied (lvo-): a title row with Stats and History, no "Payment unresolved" tab (Paystack confirms
   payments itself now), short clean order cards and a small empty state. Shared by the shop's and the buyer's pages. ---- */
(function () {
  "use strict";
  // the status tabs: "Payment unresolved" only appears while it is the chosen filter (still in the Filter list for old orders)
  var origPills = window.orderStatusPillsHtml;
  if (typeof origPills === "function") {
    window.orderStatusPillsHtml = function (view, status) {
      var html = origPills.apply(this, arguments);
      if (status === "payment_unresolved") return html;
      return String(html).replace(/<button type="button" data-status="payment_unresolved"[\s\S]*?<\/button>/, "");
    };
  }
  window.lvToggleOrderStats = function (btn) {
    var sec = document.getElementById("orderStatsAccordion"); if (!sec) return;
    var open = !sec.classList.contains("open");
    sec.classList.toggle("open", open);
    if (btn) { btn.classList.toggle("on", open); btn.setAttribute("aria-expanded", String(open)); }
    if (open && typeof renderOrderStatsBody === "function") renderOrderStatsBody();
  };
  var HIST = 'aria-label="Order history" title="Order history"><i class="fa-solid fa-clock-rotate-left"></i></button>';
  function tidy(html, isVendor) {
    html = String(html == null ? "" : html);
    if (html.indexOf("orders-title-row") < 0 || html.indexOf("lvo-ready") >= 0) return html;
    var stats = isVendor && html.indexOf("orderStatsAccordion") >= 0 ? '<button type="button" class="orders-icon-btn lvo-pill" onclick="lvToggleOrderStats(this)" aria-expanded="false" aria-label="Order stats"><i class="fa-solid fa-chart-simple"></i><span>Stats</span></button>' : "";
    var i = html.indexOf(HIST);
    if (i >= 0) {
      var b = html.lastIndexOf("<button", i);
      html = html.slice(0, b) + stats + html.slice(b, i).replace('class="orders-icon-btn', 'class="orders-icon-btn lvo-pill') + 'aria-label="Order history" title="Order history"><i class="fa-solid fa-clock-rotate-left"></i><span>History</span></button>' + html.slice(i + HIST.length);
    }
    return html.replace('class="orders-title-row"', 'class="orders-title-row lvo-ready"');
  }
  function wrap(name, isVendor) {
    var f = window[name]; if (typeof f !== "function" || f.__lvo) return;
    var w = async function () { return tidy(await f.apply(this, arguments), isVendor && arguments[5] !== "purchases"); };
    w.__lvo = true; w.__lvw = f.__lvw; w.__lvrw = f.__lvrw; window[name] = w;
  }
  function wrapAll() { wrap("renderVendorOrders", true); wrap("renderCustomerOrders", false); }
  wrapAll(); setTimeout(wrapAll, 1300); setTimeout(wrapAll, 4200);

  // order cards
  var origList = window.orderListHtml;
  var STATUS = { pending: "Pending", confirmed: "Confirmed", handed_over: "Handed over", returned: "Returned", payment_unresolved: "Payment check", disputed: "Disputed", completed: "Completed", cancelled: "Cancelled" };
  function shortDate(iso) { try { var d = new Date(iso), t = new Date(); var same = d.toDateString() === t.toDateString(); return same ? "Today, " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + ", " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }); } catch (_) { return ""; } }
  window.orderListHtml = function (orders, isCustomerView, sourcePerspective) {
    if (typeof orderListViewMode !== "undefined" && orderListViewMode === "table" && origList) return origList.apply(this, arguments);
    var src = sourcePerspective ? ",source:'" + sourcePerspective + "'" : "";
    if (!orders || !orders.length) {
      var onlyHistory = window.__orderHistoryEmpty === false;
      var acts = isCustomerView
        ? '<button type="button" class="btn lvo-btn" onclick="navigate(\'home\')"><i class="fa-solid fa-bag-shopping"></i> Start shopping</button>'
        : (typeof vendor !== "undefined" && vendor && vendor.id ? '<button type="button" class="btn lvo-btn" onclick="navigate(\'storefront\',{vendorId:\'' + esc(vendor.id) + '\'})"><i class="fa-solid fa-share-nodes"></i> View and share your shop</button>' : "");
      return '<div class="lvo-empty"><span class="lvo-empty-ico">' + (typeof lvIllus === "function" ? lvIllus("box", 64) : '<i class="fa-solid fa-box-open"></i>') + '</span>' +
        '<strong>' + (onlyHistory ? "No active orders" : "No orders yet") + '</strong>' +
        '<span>' + (onlyHistory ? "Finished orders are in History." : isCustomerView ? "Orders you place will show up here." : "When a customer orders from you, it shows up here and you get a notification.") + '</span>' + acts + '</div>';
    }
    var expanded = typeof orderListExpanded !== "undefined" && orderListExpanded;
    var size = typeof ORDER_LIST_PAGE_SIZE !== "undefined" ? ORDER_LIST_PAGE_SIZE : 5;
    var shown = expanded ? orders : orders.slice(0, size);
    var more = orders.length > size ? '<button type="button" class="lvo-more" onclick="toggleOrderListExpanded()">' + (expanded ? 'Show less <i class="fa-solid fa-chevron-up"></i>' : 'Show all ' + orders.length + ' orders <i class="fa-solid fa-chevron-down"></i>') + '</button>' : "";
    return '<div class="lvo-list">' + shown.map(function (o) {
      var items = o.items || [], first = items[0], prod = first && first.product;
      var title = prod && prod.name ? prod.name + (items.length > 1 ? " +" + (items.length - 1) + " more" : "") : "Order";
      var qty = first && Number(first.quantity) > 1 && items.length === 1 ? " ×" + first.quantity : "";
      var photo = (prod && prod.photos && prod.photos[0]) || (isCustomerView && o.vendor && o.vendor.logo_url) || "";
      var party = isCustomerView ? (o.vendor && o.vendor.business_name) || "Vendor" : (o.buyer && o.buyer.name) || (o.status === "pending" ? "New customer" : "Customer");
      var stage = typeof lvOrderStageLabel === "function" ? lvOrderStageLabel(o) : "";
      var label = stage || STATUS[o.status] || String(o.status || "").replace(/_/g, " ");
      var cls = stage ? "paid" : (o.status || "");
      var iso = typeof orderActivityIso === "function" ? orderActivityIso(o) : o.created_at;
      return '<button type="button" class="order-list-card lvo-card" onclick="navigate(\'orderDetail\',{orderId:\'' + esc(o.id) + "'" + src + '})">' +
        '<span class="lvo-media">' + (photo ? '<img src="' + esc(photo) + '" alt="" loading="lazy" decoding="async" draggable="false">' : '<i class="fa-solid ' + (prod && prod.is_service ? "fa-hand-holding-heart" : "fa-box") + '"></i>') + '</span>' +
        '<span class="lvo-main">' +
          '<span class="lvo-l1"><strong>' + esc(title) + esc(qty) + '</strong><b>' + (typeof naira === "function" ? naira(o.total_amount) : "₦" + o.total_amount) + '</b></span>' +
          '<span class="lvo-l2"><i class="fa-solid ' + (isCustomerView ? "fa-store" : "fa-user") + '"></i> ' + esc(party) + '</span>' +
          '<span class="lvo-l3"><small>#' + esc(String(o.id || "").slice(0, 8).toUpperCase()) + (iso ? " · " + esc(shortDate(iso)) : "") + '</small><span class="lvo-st lvo-st-' + esc(cls) + '">' + esc(label) + '</span></span>' +
        '</span></button>';
    }).join("") + '</div>' + more;
  };
})();

/* ---- vendors map, tidied (lvm-): opens on a vendor (nearest first) with its card showing, a Google-Maps-style
   "my location" button, and a neat map-type sheet (picture previews + a switch for vendor names). ---- */
(function () {
  "use strict";
  var LOC_SVG = '<svg class="lvm-loc" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7.2" fill="none" stroke="currentColor" stroke-width="2"/><circle class="lvm-loc-dot" cx="12" cy="12" r="3.4" fill="currentColor"/><path d="M12 1.8v3M12 19.2v3M1.8 12h3M19.2 12h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  var LAYER_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.5 8.2 12 13.4l9.5-5.2L12 3Z" fill="currentColor" opacity=".9"/><path d="m4.3 11.6-1.8 1L12 17.8l9.5-5.2-1.8-1L12 15.8l-7.7-4.2Z" fill="currentColor" opacity=".6"/><path d="m4.3 15.4-1.8 1L12 21.6l9.5-5.2-1.8-1L12 19.6l-7.7-4.2Z" fill="currentColor" opacity=".4"/></svg>';
  function swapIcons() {
    var loc = document.getElementById("vmpLocate");
    if (loc && !loc.querySelector(".lv-loc-logo")) loc.innerHTML = '<span class="lv-loc-logo" aria-hidden="true"></span>';
    var lay = document.querySelector(".vmpage .vmp-fabs .vmp-fab");
    if (lay && !lay.querySelector("svg")) { lay.innerHTML = LAYER_SVG; lay.classList.add("lvm-layers"); }
    try { if (loc) loc.classList.toggle("on", !!(typeof buyerLocation !== "undefined" && buyerLocation)); } catch (_) {}
  }
  window.vmpDrawSheet = function () {
    var box = document.getElementById("vmpStyles"); if (!box) return;
    var styles = typeof VMP_STYLES !== "undefined" ? VMP_STYLES : {};
    var cur = typeof vmpStyle !== "undefined" ? vmpStyle : "streets";
    var names = typeof vmpDetails !== "undefined" && vmpDetails && vmpDetails.names;
    box.innerHTML = '<div class="vmp-sheet-back" onclick="vmpToggleStyles()"></div><div class="vmp-sheet lvm-sheet" role="dialog" aria-label="Map type">' +
      '<div class="lvm-grab" aria-hidden="true"></div>' +
      '<div class="vmp-sheet-head"><strong>Map type</strong><button type="button" aria-label="Close" onclick="vmpToggleStyles()"><i class="fa-solid fa-xmark"></i></button></div>' +
      '<div class="lvm-types">' + Object.keys(styles).map(function (k) {
        return '<button type="button" class="lvm-type' + (k === cur ? " on" : "") + '" onclick="vmpSetStyle(\'' + k + '\')" aria-pressed="' + (k === cur) + '"><span class="lvm-prev lvm-prev-' + k + '"><i class="lvm-road r1"></i><i class="lvm-road r2"></i><i class="lvm-road r3"></i><i class="lvm-pin"></i>' + (k === cur ? '<span class="lvm-check"><i class="fa-solid fa-check"></i></span>' : "") + '</span><small>' + esc(styles[k].label) + '</small></button>';
      }).join("") + '</div>' +
      '<div class="lvm-sec">Map details</div>' +
      '<button type="button" class="lvm-row" role="switch" aria-checked="' + !!names + '" onclick="vmpDetails.names=!vmpDetails.names;vmpDrawSheet();vmpDrawPins()"><span class="lvm-row-ico"><i class="fa-solid fa-tag"></i></span><span class="lvm-row-t"><strong>Vendor names</strong><small>Show every shop\'s name under its pin</small></span><span class="lvm-switch' + (names ? " on" : "") + '"><i></i></span></button>' +
    '</div>';
  };
  // open on a vendor: once the pins are drawn and nothing is picked yet, pick the nearest (or the first) and show its card
  function lockOn(tries) {
    try {
      if (typeof vmpMap === "undefined" || !vmpMap || !document.getElementById("vmpRail")) { if (tries < 40) setTimeout(function () { lockOn(tries + 1); }, 150); return; }
      if (vmpSelected) return;
      var list = typeof vmpRailList === "function" ? vmpRailList() : [];
      if (!list.length) { if (tries < 40) setTimeout(function () { lockOn(tries + 1); }, 150); return; }
      var asked = vmpAskedLoc; vmpAskedLoc = true;   // opening the map must not pop up a location request by itself
      vmpSelect(list[0].id, true, false, true);
      vmpAskedLoc = asked;
    } catch (_) {}
  }
  var origInit = window.initVendorsMapPage;
  if (typeof origInit === "function" && !origInit.__lvm) {
    var w = async function () {
      var out = await origInit.apply(this, arguments);
      swapIcons();
      if (!window.__lvmLocked) { window.__lvmLocked = true; setTimeout(function () { window.__lvmLocked = false; lockOn(0); }, 450); }
      return out;
    };
    w.__lvm = true; window.initVendorsMapPage = w;
  }
  // switching the Vendors page to its map also drops the nearest shop's card (View shop / Follow) by itself
  var origSwitch = window.switchVendorsView;
  if (typeof origSwitch === "function" && !origSwitch.__lvm) {
    var sw = function (mode) { var r = origSwitch.apply(this, arguments); if (mode === "map") { setTimeout(function () { lockOn(0); }, 500); setTimeout(function () { lockOn(20); }, 1500); } return r; };
    sw.__lvm = true; window.switchVendorsView = sw;
    try { switchVendorsView = sw; } catch (_) {}
  }
  // without the person's location there is no real distance: show the shop and a button to turn location on (not "~0 m")
  var origRouteCard = window.vmpRouteCardDraw;
  if (typeof origRouteCard === "function") window.vmpRouteCardDraw = function (v) {
    var hasLoc = false; try { hasLoc = !!(typeof buyerLocation !== "undefined" && buyerLocation) || !!vmpRouteInfo; } catch (_) {}
    if (!v || hasLoc) return origRouteCard.apply(this, arguments);
    var box = document.getElementById("vmpRouteCard"); if (!box) return;
    box.innerHTML = vmpCardHtml(v) + '<button type="button" class="lvm-dist" onclick="vmpLocate()"><span class="lvm-dist-ico">' + LOC_SVG + '</span><span><strong>See how far this shop is</strong><small>Turn on your location for distance and travel times</small></span><i class="fa-solid fa-chevron-right"></i></button>';
    box.classList.add("vmp-route-merged"); box.classList.remove("hidden");
    var ex = document.getElementById("vmpExpandedCard"); if (ex) ex.classList.add("hidden");
  };
  var origLocate = window.vmpLocate;
  if (typeof origLocate === "function") window.vmpLocate = async function () { var r = await origLocate.apply(this, arguments); swapIcons(); return r; };
  var lvmRaf = 0;
  new MutationObserver(function () { if (lvmRaf) return; lvmRaf = requestAnimationFrame(function () { lvmRaf = 0; if (document.getElementById("vmPage")) swapIcons(); }); }).observe(document.getElementById("app") || document.body, { childList: true, subtree: true });
})();

/* ===== Admin: Disputes page, tidied (adp-) =====
   Two tabs that matter (Open, Resolved) and a third only when there are payment checks. One clean card per dispute: who, why,
   the shop's reply, the money (paid / refunded, with a Refund button), and the outcome in one place. Choosing an outcome never
   undoes a refund that was already made. */
(function () {
  "use strict";
  function money(n) { try { return "₦" + Number(n || 0).toLocaleString("en-NG", { maximumFractionDigits: 2 }); } catch (_) { return "₦" + n; } }
  function ref(id) { return "#" + String(id || "").slice(0, 8).toUpperCase(); }
  function nice(s) { return String(s || "").replace(/_/g, " ").replace(/^./, function (c) { return c.toUpperCase(); }); }
  function when(t) { try { return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + ", " + new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }); } catch (_) { return ""; } }
  function paidOnline(o) {
    return (o.payments || []).filter(function (p) { return p.status === "paid" && /^lvm_ord_/.test(String(p.provider_reference || "")); }).reduce(function (s, p) { return s + Number(p.amount || 0); }, 0);
  }
  var claimOf = function (o) { return (o.payments || []).find(function (p) { return p.status === "pending" && ["buyer_report", "service_offer_report"].indexOf(String(p.provider_reference || "").toLowerCase()) >= 0; }); };
  window.lvAdpTab = function (t) {
    window.__adpTab = t;
    document.querySelectorAll(".adp-tab").forEach(function (b) { b.classList.toggle("on", b.dataset.t === t); b.setAttribute("aria-selected", String(b.dataset.t === t)); });
    document.querySelectorAll(".adp-panel").forEach(function (p) { p.classList.toggle("hidden", p.dataset.t !== t); });
  };
  // which resolved cards are open is remembered, so a live refresh of the page does not fold them again
  window.__adpOpen = window.__adpOpen || {};
  window.lvAdpFold = function (e, card) { if (e.target.closest("button,a,textarea,input")) return; card.classList.toggle("open"); var id = card.getAttribute("data-id"); if (id) { if (card.classList.contains("open")) window.__adpOpen[id] = 1; else delete window.__adpOpen[id]; } };
  window.lvAdpOutcome = function (id, v, btn) {
    var inp = document.getElementById("newstatus-" + id); if (inp) inp.value = v;
    var wrap = btn && btn.parentElement; if (wrap) wrap.querySelectorAll("button").forEach(function (b) { b.classList.toggle("on", b === btn); b.setAttribute("aria-checked", String(b === btn)); });
  };
  function card(d, refunded) {
    var o = d.order || {}, paid = paidOnline(o), back = refunded[o.id] || 0, claim = claimOf(o);
    var buyer = d.__buyer ? esc(d.__buyer) : "Buyer";
    var vResp = d.vendor_response ? '<p>' + esc(d.vendor_response) + '</p>' : '<p class="adp-muted">The shop has not replied yet.</p>';
    var ev = typeof disputeEvidenceHtml === "function" ? disputeEvidenceHtml(d.attachments) : "";
    return '<article class="adp-card">' +
      '<header class="adp-top"><div class="adp-who"><strong>' + esc((o.vendor && o.vendor.business_name) || "Shop") + '</strong><small>' + esc(nice(o.order_type || "order")) + ' · ' + esc(ref(o.id)) + (o.total_amount != null ? ' · ' + money(o.total_amount) : "") + '</small></div>' +
      '<span class="adp-pill">Raised by ' + esc(String(d.raised_by || "unknown")) + '</span></header>' +
      '<div class="adp-meta"><span><i class="fa-regular fa-user"></i> ' + buyer + '</span><span><i class="fa-regular fa-clock"></i> ' + esc(when(d.created_at)) + '</span></div>' +
      '<div class="adp-block"><label>Reason</label><p>' + esc(d.reason || "") + '</p>' + ev + '</div>' +
      '<div class="adp-block"><label>Shop\'s reply</label>' + vResp + '</div>' +
      (claim ? '<div class="adp-claim"><div><strong>Payment claim: ' + money(claim.amount) + '</strong><small>The buyer reported a direct transfer that is not verified yet.</small></div><div class="adp-row"><button class="btn btn-sm" onclick="adminConfirmReportedPayment(\'' + esc(o.id) + '\')">Verify</button><button class="btn btn-sm btn-danger" onclick="adminRejectReportedPayment(\'' + esc(o.id) + '\')">Reject</button></div></div>' : "") +
      (paid > 0 ? '<div class="adp-money"><div><small>Paid by buyer</small><b>' + money(paid) + '</b></div><div><small>Refunded</small><b class="' + (back ? "adp-red" : "") + '">' + money(back) + '</b></div>' + (back ? '<div class="adp-conf"><i class="fa-solid fa-circle-check"></i> ' + money(back) + ' of ' + money(paid) + ' refunded</div>' : "") + '<button type="button" class="btn btn-sm btn-outline" onclick="lvPayAct(\'refund\',\'' + esc(o.id) + '\')"><i class="fa-solid fa-rotate-left"></i> Refund</button></div>' : "") +
      '<div class="adp-links">' + (o.buyer_id && o.vendor_id ? '<button type="button" onclick="openDisputeChat(\'' + esc(o.buyer_id) + '\',\'' + esc(o.vendor_id) + '\')"><i class="fa-solid fa-comment-dots"></i> View chat</button>' : "") +
        '<button type="button" onclick="navigate(\'orderDetail\',{orderId:\'' + esc(o.id) + '\'})"><i class="fa-solid fa-arrow-up-right-from-square"></i> Open order</button></div>' +
      '<div class="adp-resolve"><label for="notes-' + esc(d.id) + '">Resolution notes</label><textarea id="notes-' + esc(d.id) + '" rows="2" placeholder="What did you decide, and why?"></textarea>' +
        '<label>Order outcome</label><input type="hidden" id="newstatus-' + esc(d.id) + '" value="">' +
        '<div class="adp-outcomes" role="radiogroup" aria-label="Order outcome"><button type="button" role="radio" aria-checked="false" onclick="lvAdpOutcome(\'' + esc(d.id) + '\',\'completed\',this)"><i class="fa-solid fa-circle-check"></i> Completed</button><button type="button" role="radio" aria-checked="false" onclick="lvAdpOutcome(\'' + esc(d.id) + '\',\'cancelled\',this)"><i class="fa-solid fa-ban"></i> Cancelled</button></div>' +
        '<small class="adp-hint"><i class="fa-solid fa-circle-info"></i> A refund you already made stays, whichever outcome you pick. Refund separately with the button above.</small>' +
        '<button type="button" class="btn adp-go" onclick="resolveDispute(\'' + esc(d.id) + '\',\'' + esc(o.id) + '\',\'' + esc(o.payout_status) + '\')">Mark resolved</button></div>' +
    '</article>';
  }
  function doneCard(d, refunded) {
    var o = d.order || {}, back = refunded[o.id] || 0, st = String(o.status || "");
    return '<article class="adp-card adp-done' + (window.__adpOpen && window.__adpOpen[d.id] ? " open" : "") + '" data-id="' + esc(d.id) + '" onclick="lvAdpFold(event,this)"><header class="adp-top"><div class="adp-who"><strong>' + esc((o.vendor && o.vendor.business_name) || "Shop") + '</strong><small>' + esc(nice(o.order_type || "order")) + ' · ' + esc(ref(o.id)) + (o.total_amount != null ? ' · ' + money(o.total_amount) : "") + '</small></div>' +
      '<span class="adp-pill adp-st-' + esc(st) + '">' + esc(nice(st)) + '</span></header>' +
      '<div class="adp-block"><label>Reason</label><p>' + esc(d.reason || "") + '</p></div>' +
      (d.admin_notes ? '<div class="adp-block"><label>Your notes</label><p>' + esc(d.admin_notes) + '</p></div>' : "") +
      (back ? '<div class="adp-note"><i class="fa-solid fa-rotate-left"></i> ' + money(back) + ' was refunded to the buyer. This stays whatever the order status is.</div>' : "") +
      '<div class="adp-row adp-row-end"><button class="btn btn-sm btn-outline" onclick="adminReopenDispute(\'' + esc(d.id) + '\')"><i class="fa-solid fa-rotate-left"></i> Reopen</button>' +
      (st !== "completed" ? '<button class="btn btn-sm btn-outline" onclick="adminRemarkDispute(\'' + esc(d.id) + '\',\'' + esc(o.id || "") + '\',\'completed\',\'' + esc(o.payout_status || "") + '\')">Set completed</button>' : "") +
      (st !== "cancelled" ? '<button class="btn btn-sm btn-outline" onclick="adminRemarkDispute(\'' + esc(d.id) + '\',\'' + esc(o.id || "") + '\',\'cancelled\',\'' + esc(o.payout_status || "") + '\')">Set cancelled</button>' : "") + '</div></article>';
  }
  function checkCard(o, kind) {
    var claim = claimOf(o);
    return '<article class="adp-card"><header class="adp-top"><div class="adp-who"><strong>' + esc((o.vendor && o.vendor.business_name) || "Shop") + '</strong><small>' + esc(nice(o.order_type || "order")) + ' · ' + esc(ref(o.id)) + (o.total_amount != null ? ' · ' + money(o.total_amount) : "") + '</small></div><span class="adp-pill">' + (kind === "unresolved" ? "Payment unresolved" : "Confirmed, unpaid") + '</span></header>' +
      (claim ? '<div class="adp-block"><label>Reported payment</label><p>' + money(claim.amount) + ' — the buyer reported a direct transfer; the shop has not confirmed it.</p></div>' : '<p class="adp-muted">No pending payment claim is visible.</p>') +
      '<div class="adp-row">' + (kind === "unresolved" ? '<button class="btn btn-sm" ' + (claim ? "" : "disabled") + ' onclick="adminConfirmReportedPayment(\'' + esc(o.id) + '\')">Verify payment</button><button class="btn btn-sm btn-danger" ' + (claim ? "" : "disabled") + ' onclick="adminRejectReportedPayment(\'' + esc(o.id) + '\')">Reject claim</button>' : '<button class="btn btn-sm btn-danger" onclick="adminCancelConfirmedOverdue(\'' + esc(o.id) + '\')">Cancel order</button>') +
      '<button class="btn btn-sm btn-outline" onclick="navigate(\'orderDetail\',{orderId:\'' + esc(o.id) + '\'})">Open order</button></div></article>';
  }
  window.renderAdminDisputes = async function () {
    if (!session || profile?.role !== "admin") return '<div class="empty-state">Access denied.</div>';
    var pay = "id,payment_type,amount,status,provider_reference,created_at,paid_at";
    var res = await Promise.all([
      sb.from("disputes").select("*, order:orders(id, order_type, buyer_id, vendor_id, payout_status, status, payment_unresolved_at, payment_escalated_at, total_amount, status_changed_at, vendor:vendors(business_name), payments(" + pay + "))").eq("status", "open").order("created_at", { ascending: true }),
      sb.from("orders").select("id,order_type,buyer_id,vendor_id,status,payment_unresolved_at,payment_escalated_at,total_amount,vendor:vendors(business_name),payments(" + pay + ")").eq("status", "payment_unresolved").not("payment_escalated_at", "is", null).order("payment_escalated_at", { ascending: true }),
      sb.from("orders").select("id,order_type,buyer_id,vendor_id,status,total_amount,status_changed_at,payment_escalated_at,vendor:vendors(business_name),payments(" + pay + ")").eq("status", "confirmed").not("payment_escalated_at", "is", null).order("payment_escalated_at", { ascending: true }),
      sb.from("disputes").select("id,reason,admin_notes,created_at,order:orders(id,order_type,status,total_amount,payout_status,vendor:vendors(business_name))").eq("status", "resolved").order("created_at", { ascending: false }).limit(60)
    ]);
    var head = '<h2 class="adp-h"><i class="fa-solid fa-scale-balanced"></i> Disputes</h2>' + adminNavHtml("adminDisputes");
    if (res[0].error && res[1].error && res[2].error) return head + errorStateHtml(res[0].error);
    var open = res[0].data || [], resolved = res[3].data || [];
    window.__adminDisputeCount = open.length; try { head = '<h2 class="adp-h"><i class="fa-solid fa-scale-balanced"></i> Disputes</h2>' + adminNavHtml("adminDisputes"); } catch (_) {}
    var unresolved = (res[1].data || []).filter(function (o) { return !open.some(function (d) { return String((d.order && d.order.id) || d.order_id || "") === String(o.id); }); });
    var confirmed = (res[2].data || []).filter(function (o) { var fee = o.order_type === "rental" ? "rental_fee" : "sale_price"; return !(o.payments || []).some(function (p) { return String(p.payment_type || "").toLowerCase() === fee && p.status === "paid"; }); });
    var checks = unresolved.length + confirmed.length;
    // refunds made so far, and the buyers' names
    var ids = open.map(function (d) { return d.order && d.order.id; }).concat(resolved.map(function (d) { return d.order && d.order.id; })).filter(Boolean);
    var refunded = {};
    try { var rr = await sb.from("paystack_refunds").select("order_id,amount_kobo,status").in("order_id", ids).neq("status", "failed"); ((rr && rr.data) || []).forEach(function (r) { refunded[r.order_id] = (refunded[r.order_id] || 0) + Number(r.amount_kobo || 0) / 100; }); } catch (_) {}
    try {
      var bids = open.map(function (d) { return d.order && d.order.buyer_id; }).filter(Boolean);
      if (bids.length) { var ur = await sb.from("users").select("id,name").in("id", bids); var nm = {}; ((ur && ur.data) || []).forEach(function (u) { nm[u.id] = u.name; }); open.forEach(function (d) { d.__buyer = d.order && nm[d.order.buyer_id]; }); }
    } catch (_) {}
    var tab = "open";
    // the tab the admin was on is drawn as the open one straight away (switching after drawing made the page twitch on every refresh)
    var want = window.__adpTab || "open"; if ((want === "checks" && !checks) || ["open", "resolved", "checks"].indexOf(want) < 0) want = "open";
    var tOn = function (t) { return t === want ? ' on" aria-selected="true"' : '" aria-selected="false"'; }, pHide = function (t) { return t === want ? "" : " hidden"; };
    var tabs = '<div class="adp-tabs" role="tablist"><button role="tab" data-t="open" class="adp-tab' + tOn("open") + ' onclick="lvAdpTab(\'open\')">Open' + (open.length ? '<i>' + open.length + '</i>' : "") + '</button><button role="tab" data-t="resolved" class="adp-tab' + tOn("resolved") + ' onclick="lvAdpTab(\'resolved\')"><span class="fa-solid fa-clock-rotate-left"></span> History' + (resolved.length ? '<i class="ok">' + resolved.length + '</i>' : "") + '</button>' + (checks ? '<button role="tab" data-t="checks" class="adp-tab' + tOn("checks") + ' onclick="lvAdpTab(\'checks\')">Payment checks<i>' + checks + '</i></button>' : "") + '</div>';
    var empty = function (t, ic) { return '<div class="adp-empty"><i class="fa-solid ' + ic + '"></i><strong>' + t + '</strong></div>'; };
    return head + '<div class="adp">' + tabs +
      '<section class="adp-panel' + pHide("open") + '" data-t="open">' + (open.length ? open.map(function (d) { return card(d, refunded); }).join("") : empty("No open disputes", "fa-circle-check")) + '</section>' +
      '<section class="adp-panel' + pHide("resolved") + '" data-t="resolved">' + (resolved.length ? resolved.map(function (d) { return doneCard(d, refunded); }).join("") : empty("No resolved disputes yet", "fa-box-archive")) + '</section>' +
      (checks ? '<section class="adp-panel' + pHide("checks") + '" data-t="checks">' + unresolved.map(function (o) { return checkCard(o, "unresolved"); }).concat(confirmed.map(function (o) { return checkCard(o, "confirmed"); })).join("") + '</section>' : "") + '</div>';
  };
  // an outcome never undoes a refund: cancelling a paid order no longer refuses; the admin is reminded that a refund is its own step
  async function setOutcome(disputeId, orderId, status, notes, paidNote) {
    if (paidNote && status === "cancelled") {
      var ok = await showConfirmDialog("This order was paid online. Cancelling it does not refund the buyer by itself: use Refund on the dispute card for that. Any refund already made stays. Mark the order as cancelled?", { title: "Cancel the order", okLabel: "Mark cancelled", cancelLabel: "Go back", danger: true });
      if (!ok) return false;
    }
    var r = await sb.rpc("resolve_dispute", { p_dispute_id: disputeId, p_admin_notes: notes, p_new_order_status: status });
    if (r.error) { showToast(r.error.message || "Could not save the outcome.", "error"); return false; }
    return true;
  }
  window.resolveDispute = async function (id, orderId, payoutStatus) {
    var notes = (document.getElementById("notes-" + id).value || "").trim() || "Resolved.";
    var status = (document.getElementById("newstatus-" + id) || {}).value || "";
    if (!status) { showToast("Choose an outcome (Completed or Cancelled) before resolving.", "error"); return; }
    if (status === "completed" && payoutStatus === "held") {
      var res = await fetch("/api/order-payout-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "release", orderId: orderId, accessToken: session.access_token }) });
      var json = await res.json().catch(function () { return {}; });
      if (!res.ok) { showToast(json.error || "Could not release payment.", "error"); return; }
      var e2 = await sb.rpc("resolve_dispute", { p_dispute_id: id, p_admin_notes: notes });
      if (e2.error) { showToast(e2.error.message, "error"); return; }
      showToast("Dispute resolved.", "success"); navigate("adminDisputes", {}, false); return;
    }
    if (await setOutcome(id, orderId, status, notes, payoutStatus === "held" || payoutStatus === "released")) { showToast("Dispute resolved.", "success"); navigate("adminDisputes", {}, false); }
  };
  window.adminRemarkDispute = async function (id, orderId, status, payoutStatus) {
    if (!(await showConfirmDialog("Set this order to " + status + "? A refund that was already made stays.", { title: "Change outcome", okLabel: "Yes, set " + status, cancelLabel: "Go back" }))) return;
    var r = await sb.rpc("resolve_dispute", { p_dispute_id: id, p_admin_notes: "Outcome changed by admin to " + status + ".", p_new_order_status: status });
    if (r.error) { showToast(r.error.message || "Could not change the outcome.", "error"); return; }
    showToast("Done.", "success"); navigate("adminDisputes", {}, false);
  };
})();

/* ===== My listings: the listing details pop-up, tidied (vld-) =====
   Name, status chips, three stat tiles (views, saved, sales), the facts as clean rows, then the actions. */
(function () {
  "use strict";
  function chip(t, cls) { return '<span class="vld-chip' + (cls ? " " + cls : "") + '">' + esc(t) + "</span>"; }
  function row(ic, k, v) { return '<div class="vld-row"><span class="vld-ic"><i class="fa-solid ' + ic + '"></i></span><span class="vld-k">' + k + '</span><b>' + v + "</b></div>"; }
  // Levi's subject for one of the shop's own listings: what he is told, his opening line and the questions offered
  function listingMode(productId, d) {
    var p = d.p || {}, name = p.name || "this listing";
    var price = function () {
      var out = [];
      if (p.sale_price != null) out.push("sale price " + naira(p.sale_price) + (p.discount_price != null && Number(p.discount_price) < Number(p.sale_price) ? " (discounted to " + naira(p.discount_price) + ")" : ""));
      if (p.rental_rate != null) out.push("rent " + naira(p.rental_rate) + (p.rental_rate_unit ? " per " + p.rental_rate_unit : ""));
      if (p.service_price != null) out.push("service price " + naira(p.service_price));
      return out.join("; ");
    };
    return {
      id: "listing:" + productId,
      placeholder: "Ask about this listing…",
      icon: "fa-tag",
      label: "Listing · " + name,
      topic: function () { return 'my listing "' + name + '"'; },
      intro: function () {
        var pr = price();
        return "Let's work on your listing **" + name + "**" + (pr ? " (" + pr + ")" : "") + ". I can improve the description, check the price against similar items on Levromart, spot missing details and suggest how to make it more attractive to buyers. What would you like to do?";
      },
      chips: [["Improve my description", "Rewrite my listing's description so it sells better."], ["Is my price right?", "Is my price right for this listing? Compare it with similar items on Levromart."], ["What's missing?", "What information is missing from this listing?"], ["Make it more attractive", "How can I make this listing more attractive to buyers?"]],
      context: function () {
        var photos = Array.isArray(p.photos) ? p.photos.length : 0, vr = Array.isArray(p.variants) ? p.variants : [];
        return ["The user is the shop owner and opened Levi from this listing in My Listings. Help them improve this listing. You can call get_product with productId " + productId + " for its public page, and search_products to compare prices of similar items. Do not invent facts about the item; ask when something is unknown.",
          "Listing id: " + productId,
          "Name: " + name,
          "Type: " + (p.is_service ? "service" : (p.listing_type || "sale")) + (p.category && p.category.name ? "; category: " + p.category.name : ""),
          "Status: " + (p.status || "unknown"),
          price() ? "Price: " + price() : "Price: not set",
          p.is_service ? "" : p.track_quantity === false ? "Stock: always available" : (p.quantity_available != null ? "Stock: " + p.quantity_available + (p.quantity_total != null ? " of " + p.quantity_total : "") + " available" : ""),
          "Description: " + (p.description ? String(p.description).slice(0, 900) : "(none)"),
          "Photos: " + photos,
          vr.length ? "Varieties: " + vr.slice(0, 8).map(function (v) { return v.name + (v.price != null ? " " + naira(v.price) : ""); }).join(", ") : "",
          "Views: " + Number(p.view_count || 0) + "; saved by " + Number(d.favCount || 0) + " people; sales so far " + naira(d.revenue || 0),
          d.topRegion ? "Sells best in: " + d.topRegion.city : "",
          p.created_at ? "Listed on: " + String(p.created_at).slice(0, 10) : ""].filter(Boolean).join("\n");
      }
    };
  }
  window.showVendorProductDetails = function (productId) {
    var d = (window.__vlDetailsRaw || {})[productId], old = (window.__vendorProductCardDetails || {})[productId];
    if (!d && !old) return;
    var modal = document.getElementById("vendorProductDetailsModal"); if (!modal) return;
    var p = d ? d.p : {}, body = document.getElementById("vendorProductDetailsBody");
    document.getElementById("vendorProductDetailsTitle").textContent = (d ? p.name : old.name) || "Listing";
    if (d) {
      var st = String(p.status || ""), kind = p.is_service ? "Service" : (String(p.listing_type || "sale").replace(/^./, function (c) { return c.toUpperCase(); }));
      var avail = p.is_service ? "" : (p.track_quantity === false ? "Always available" : (p.quantity_available + " of " + p.quantity_total + " available"));
      var chips = chip(kind) + (avail ? chip(avail) : "") + chip(st.replace(/^./, function (c) { return c.toUpperCase(); }), st === "active" ? "ok" : st === "paused" ? "warn" : "");
      var vr = Array.isArray(p.variants) && p.variants.length ? p.variants : null;
      var expiry = p.billing_model === "monthly" && p.billing_paid_until && typeof listingExpiryMarkup === "function" ? '<div class="vld-note">' + listingExpiryMarkup(p) + "</div>" : "";
      body.innerHTML = '<div class="vld">' +
        '<div class="vld-chips">' + chips + "</div>" +
        '<div class="vld-tiles"><div><i class="fa-solid fa-eye"></i><b>' + Number(p.view_count || 0).toLocaleString("en-NG") + '</b><small>Views</small></div><div><i class="fa-solid fa-heart"></i><b>' + Number(d.favCount || 0).toLocaleString("en-NG") + '</b><small>Saved</small></div><div><i class="fa-solid fa-sack-dollar"></i><b>' + naira(d.revenue || 0) + '</b><small>Sales</small></div></div>' +
        (vr ? row("fa-layer-group", "Varieties", vr.length + " · " + esc(vr.slice(0, 3).map(function (v) { return v.name; }).join(", ")) + (vr.length > 3 ? "…" : "")) : "") +
        (d.topRegion ? row("fa-map-location-dot", "Sells best in", '<a href="#" onclick="event.stopPropagation();showProductRegions(\'' + esc(p.id) + '\',\'' + esc(p.name).replace(/'/g, "\\'") + '\');return false;">' + esc(d.topRegion.city) + " (" + d.topRegion.order_count + ")</a>") : "") +
        expiry +
        (d.hasPendingOrder ? '<div class="vld-warn"><i class="fa-solid fa-circle-exclamation"></i> This listing has a pending order. It cannot be removed until that is cleared.</div>' : "") +
      "</div>";
    } else body.innerHTML = old.html;
    var viewBtn = document.getElementById("vendorProductDetailsViewBtn");
    if (viewBtn) viewBtn.onclick = function () { modal.classList.add("hidden"); navigate("productDetail", { productId: productId }); };
    // "Ask Levi about my listing": Levi opens on this listing, with its details, to help with the description, price and photos
    var askBtn = document.getElementById("vendorProductDetailsLeviBtn");
    if (!askBtn && viewBtn && viewBtn.parentNode) {
      askBtn = document.createElement("button"); askBtn.type = "button"; askBtn.id = "vendorProductDetailsLeviBtn"; askBtn.className = "btn btn-sm vld-levi";
      askBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> Ask Levi about my listing';
      viewBtn.parentNode.insertBefore(askBtn, viewBtn);
    }
    if (askBtn) askBtn.onclick = function () {
      modal.classList.add("hidden");
      if (window.lvAskLevi) window.lvAskLevi(listingMode(productId, d ? d : { p: { id: productId, name: old && old.name } }));
    };
    modal.classList.add("vld-modal");
    modal.classList.remove("hidden");
  };
})();

/* ===== Every "Cancel" button is red =====
   Any button whose label starts with "Cancel" (Cancel, Cancel order, Cancel & refund…) gets the red look, so a person can tell at a
   glance which button backs out or cancels. "Cancelled" (a status) is not a button to press, so it is left alone. */
(function () {
  "use strict";
  var RE = /^cancel(?!led)\b/i;
  function label(b) { return String(b.textContent || "").replace(/\s+/g, " ").trim(); }
  function tag(root) {
    var list = (root.nodeType === 1 && root.matches && root.matches("button,.btn")) ? [root] : [];
    if (root.querySelectorAll) list = list.concat([].slice.call(root.querySelectorAll("button,.btn")));
    list.forEach(function (b) {
      if (b.__lvc === label(b)) return;
      b.__lvc = label(b);
      var on = RE.test(b.__lvc) && !b.closest(".order-status-pills-rail,.adp-outcomes,.segmented-tabs");
      b.classList.toggle("lv-cancel", on);
    });
  }
  var raf = 0, queue = [];
  new MutationObserver(function (muts) {
    muts.forEach(function (m) {
      m.addedNodes.forEach(function (n) { if (n.nodeType === 1) queue.push(n); });
      if (m.type === "characterData" && m.target.parentElement) queue.push(m.target.parentElement);
    });
    if (!raf) raf = requestAnimationFrame(function () { raf = 0; var q = queue; queue = []; q.forEach(tag); });
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  tag(document.body);
})();

/* ===== Admin: tap any payment, refund, payout or withdrawal to see everything about it (lvpd-) =====
   Who paid whom, how (card / bank transfer / USSD), the Paystack reference, and the money breakdown: what the buyer paid, the
   Paystack fee, Levromart's commission, the shop's share, refunds, and what was sent to the shop. Read-only. */
(function () {
  "use strict";
  function naira(n) { try { return "₦" + Number(n || 0).toLocaleString("en-NG", { maximumFractionDigits: 2 }); } catch (_) { return "₦" + n; } }
  function k(x) { return Number(x || 0) / 100; }
  function when(t) { try { return t ? new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) + ", " + new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "—"; } catch (_) { return "—"; } }
  function nice(s) { return String(s || "").replace(/_/g, " ").replace(/^./, function (c) { return c.toUpperCase(); }); }
  function ref(id) { return id ? "#" + String(id).slice(0, 8).toUpperCase() : "—"; }
  var CHANNEL = { card: "Card", bank: "Bank", bank_transfer: "Bank transfer", ussd: "USSD", mobile_money: "Mobile money", qr: "QR", eft: "EFT", apple_pay: "Apple Pay" };
  function kv(a, b, cls) { return '<div class="lvpd-kv' + (cls ? " " + cls : "") + '"><span>' + a + '</span><b>' + b + "</b></div>"; }
  function sec(t, body) { return body ? '<section class="lvpd-sec"><h4>' + t + "</h4>" + body + "</section>" : ""; }
  function person(role, name, extra) { return '<div class="lvpd-p"><span class="lvpd-pr">' + role + '</span><b>' + esc(name || "—") + "</b>" + (extra ? "<small>" + extra + "</small>" : "") + "</div>"; }
  function statusChip(s) { var st = String(s || ""); var good = /success|processed|paid|approved|sent/.test(st), bad = /fail|reject|reverse|abandon/.test(st); return '<span class="lvpd-chip ' + (good ? "ok" : bad ? "bad" : "wait") + '">' + esc(nice(st || "unknown")) + "</span>"; }
  async function ctx(orderId, vendorId) {
    var out = { order: null, buyer: null, shop: null, owner: null, pays: [], comm: [], payout: null, refunds: [], wd: null };
    var safe = function (p) { return Promise.resolve(p).then(function (r) { return r && r.data; }, function () { return null; }); };
    if (orderId) {
      var rs = await Promise.all([
        safe(sb.from("orders").select("id,status,order_type,total_amount,delivery_fee,created_at,completed_at,buyer_id,vendor_id,delivery_method").eq("id", orderId).maybeSingle()),
        safe(sb.from("payments").select("payment_type,amount,status,method,provider_reference,paid_at").eq("order_id", orderId)),
        safe(sb.from("commission_charges").select("amount,status,paid_at,created_at").eq("order_id", orderId)),
        safe(sb.from("vendor_payouts").select("id,amount_kobo,commission_kobo,status,hold_reason,last_error,withdrawal_id,paystack_transfer_code,updated_at,created_at").eq("order_id", orderId).maybeSingle()),
        safe(sb.from("paystack_refunds").select("id,amount_kobo,status,reason,created_at,transaction_reference").eq("order_id", orderId).order("created_at", { ascending: true }))
      ]);
      out.order = rs[0]; out.pays = rs[1] || []; out.comm = rs[2] || []; out.payout = rs[3]; out.refunds = rs[4] || [];
      if (out.order) { vendorId = vendorId || out.order.vendor_id; }
      if (out.order && out.order.buyer_id) out.buyer = await safe(sb.from("users").select("name,email,phone").eq("id", out.order.buyer_id).maybeSingle());
      if (out.payout && out.payout.withdrawal_id) out.wd = await safe(sb.from("withdrawal_requests").select("id,status,kind,amount_kobo,created_at,decided_at").eq("id", out.payout.withdrawal_id).maybeSingle());
    }
    if (vendorId) out.shop = await safe(sb.from("vendors").select("business_name,bank_name,account_name,user_id").eq("id", vendorId).maybeSingle());
    if (out.shop && out.shop.user_id) out.owner = await safe(sb.from("users").select("name,email,phone").eq("id", out.shop.user_id).maybeSingle());
    return out;
  }
  // the money, step by step, for one order: buyer paid → fee → commission → shop share → refunds → paid to the shop
  function breakdown(c, t) {
    var paidNet = c.pays.filter(function (p) { return p.status === "paid" && /^lvm_ord_/.test(String(p.provider_reference || "")); }).reduce(function (s, p) { return s + Number(p.amount || 0); }, 0);
    var gross = t && t.amount != null ? Number(t.amount) : paidNet, fee = Math.max(0, gross - paidNet);
    var comm = c.comm.filter(function (x) { return x.status !== "waived"; }).reduce(function (s, x) { return s + Number(x.amount || 0); }, 0);
    var rate = paidNet > 0 ? Math.round(comm / paidNet * 1000) / 10 : 0;
    var back = c.refunds.filter(function (r) { return r.status !== "failed" && r.status !== "abandoned"; }).reduce(function (s, r) { return s + k(r.amount_kobo); }, 0);
    var share = Math.max(0, paidNet - comm), net = Math.max(0, share - back);
    var h = kv("Buyer paid in total", naira(gross)) + (fee ? kv("Paystack fee (paid by the buyer)", naira(fee), "lvpd-dim") : "") + kv("Paid for the order", naira(paidNet)) +
      kv("Levromart commission" + (rate ? " (" + rate + "%)" : ""), "− " + naira(comm)) + kv("Shop's share", naira(share));
    if (back) h += kv("Refunded to the buyer", "− " + naira(back), "lvpd-red") + kv("Shop's share after refunds", naira(net), "lvpd-strong");
    else h += kv("Shop's share after refunds", naira(net), "lvpd-strong");
    var po = c.payout;
    if (po) {
      var sent = po.status === "success" || po.status === "paid_manually";
      h += kv("Sent to the shop", sent ? naira(k(po.amount_kobo)) : "Not yet (" + esc(nice(po.status === "on_hold" ? (po.hold_reason ? "waiting for withdrawal" : "on hold") : po.status)) + ")");
    }
    return h;
  }
  function timeline(c, t) {
    var ev = [];
    c.pays.filter(function (p) { return p.status === "paid"; }).forEach(function (p) { ev.push([p.paid_at, "Buyer paid " + naira(p.amount), "fa-arrow-down"]); });
    c.refunds.forEach(function (r) { ev.push([r.created_at, "Refund " + naira(k(r.amount_kobo)) + " · " + nice(r.status) + (r.reason ? " · " + esc(r.reason) : ""), "fa-rotate-left"]); });
    if (c.wd) ev.push([c.wd.created_at, "Shop asked to withdraw", "fa-hand-holding-dollar"]);
    if (c.payout && (c.payout.status === "success" || c.payout.status === "paid_manually")) ev.push([c.payout.updated_at, "Sent to the shop " + naira(k(c.payout.amount_kobo)), "fa-paper-plane"]);
    ev = ev.filter(function (x) { return x[0]; }).sort(function (a, b) { return new Date(a[0]) - new Date(b[0]); });
    return ev.length ? '<ul class="lvpd-tl">' + ev.map(function (x) { return '<li><i class="fa-solid ' + x[2] + '"></i><div><b>' + x[1] + "</b><small>" + esc(when(x[0])) + "</small></div></li>"; }).join("") + "</ul>" : "";
  }
  function open(title, sub, bodyHtml) {
    var old = document.getElementById("lvpdSheet"); if (old) old.remove();
    var m = document.createElement("div"); m.id = "lvpdSheet"; m.className = "lvw-sheet-wrap lvpd-wrap";
    m.innerHTML = '<div class="lvw-sheet lvpd" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><div class="lvw-sheet-grab" aria-hidden="true"></div>' +
      '<div class="lvpd-head"><div><small>' + esc(sub || "") + '</small><h3>' + title + '</h3></div><button type="button" class="lvw-eye lvw-eye-dark" aria-label="Close" onclick="document.getElementById(\'lvpdSheet\').remove()"><i class="fa-solid fa-xmark"></i></button></div>' +
      '<div class="lvw-sheet-body lvpd-body">' + bodyHtml + "</div></div>";
    m.addEventListener("click", function (e) { if (e.target === m) m.remove(); });
    document.body.appendChild(m);
    return m;
  }
  var LOADING = '<p class="muted" style="text-align:center;padding:1.2rem 0"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</p>';
  var PURPOSE = { order_payment: "Order payment", order_balance: "Order balance payment", listing_fee: "Listing fee", commission: "Commission payment", monthly_fee: "Monthly listing fee" };
  async function showTx(t) {
    var title = naira(t.amount), what = PURPOSE[t.purpose] || nice(t.purpose || "payment");
    var m = open(title, what, LOADING);
    var c = await ctx(t.order_id, t.vendor_id), body = m.querySelector(".lvpd-body"); if (!body) return;
    var shopName = (c.shop && c.shop.business_name) || t.business_name || "Shop";
    var from = c.buyer ? person("From (buyer)", c.buyer.name || c.buyer.email, esc([c.buyer.email, c.buyer.phone].filter(Boolean).join(" · "))) : person("From", t.order_id ? "Buyer" : shopName);
    var to = person("To (shop)", shopName, c.owner ? esc([c.owner.name, c.owner.phone].filter(Boolean).join(" · ")) : "");
    var isOrder = /^order/.test(String(t.purpose || "")) && c.order;
    body.innerHTML = '<div class="lvpd-top">' + statusChip(t.status) + '<span class="lvpd-meth"><i class="fa-solid fa-credit-card"></i> ' + esc(CHANNEL[String(t.channel || "").toLowerCase()] || nice(t.channel || "Not recorded")) + "</span></div>" +
      '<div class="lvpd-who">' + from + '<i class="fa-solid fa-arrow-right"></i>' + to + "</div>" +
      sec("Money breakdown", isOrder ? breakdown(c, t) : kv("Amount", naira(t.amount))) +
      sec("Payment", kv("Method", esc(CHANNEL[String(t.channel || "").toLowerCase()] || nice(t.channel || "Not recorded"))) + kv("Paid at", esc(when(t.paid_at || t.created_at))) + kv("Paystack reference", '<code>' + esc(t.reference || "—") + "</code>") + (t.order_id ? kv("Order", esc(ref(t.order_id)) + (c.order ? " · " + esc(nice(c.order.status)) : "")) : "")) +
      sec("What happened", timeline(c, t)) +
      (t.order_id ? '<button type="button" class="btn btn-outline lvpd-open" onclick="document.getElementById(\'lvpdSheet\').remove();navigate(\'orderDetail\',{orderId:\'' + esc(t.order_id) + '\'})">Open the order</button>' : "");
  }
  async function showRefund(r) {
    var m = open(naira(r.amount), "Refund", LOADING);
    var c = await ctx(r.order_id, null), body = m.querySelector(".lvpd-body"); if (!body) return;
    var credit = null; try { credit = (await sb.from("refund_credits").select("status,amount_kobo,created_at").eq("refund_id", r.id).maybeSingle()).data; } catch (_) {}
    var shopName = (c.shop && c.shop.business_name) || "Shop";
    var dest = credit ? "Buyer's Levromart refunds wallet" + (credit.status === "available" ? " (waiting to be withdrawn)" : credit.status === "processing" ? " (being sent to their bank)" : " (withdrawn to their bank)") : /processed|processing|success/.test(r.status) ? "Back to the buyer's card (through Paystack)" : "Not sent yet";
    body.innerHTML = '<div class="lvpd-top">' + statusChip(r.status) + '<span class="lvpd-meth"><i class="fa-solid fa-rotate-left"></i> Refund</span></div>' +
      '<div class="lvpd-who">' + person("From", shopName + "'s share", "Taken off the shop's wallet") + '<i class="fa-solid fa-arrow-right"></i>' + (c.buyer ? person("To (buyer)", c.buyer.name || c.buyer.email, esc([c.buyer.email, c.buyer.phone].filter(Boolean).join(" · "))) : person("To", "Buyer")) + "</div>" +
      sec("Refund", kv("Amount", naira(r.amount)) + kv("Went to", esc(dest)) + kv("Reason", esc(r.reason || "—")) + kv("Asked by", esc(nice(r.source || "admin"))) + kv("Date", esc(when(r.created_at))) + (r.last_error ? kv("Note", esc(r.last_error), "lvpd-red") : "") + kv("Original payment", "<code>" + esc(r.transaction_reference || "—") + "</code>")) +
      (c.order ? sec("The order's money", breakdown(c, null)) : "") +
      '<button type="button" class="btn btn-outline lvpd-open" onclick="document.getElementById(\'lvpdSheet\').remove();navigate(\'orderDetail\',{orderId:\'' + esc(r.order_id) + '\'})">Open the order</button>';
  }
  async function showPayout(p) {
    var m = open(naira(p.amount), "Payout to a shop", LOADING);
    var c = await ctx(p.order_id, p.vendor_id), body = m.querySelector(".lvpd-body"); if (!body) return;
    body.innerHTML = '<div class="lvpd-top">' + statusChip(p.status) + '<span class="lvpd-meth"><i class="fa-solid fa-building-columns"></i> Bank transfer</span></div>' +
      '<div class="lvpd-who">' + person("From", "Levromart", "Paystack balance") + '<i class="fa-solid fa-arrow-right"></i>' + person("To (shop)", (c.shop && c.shop.business_name) || p.business_name, c.shop ? esc([c.shop.account_name, c.shop.bank_name].filter(Boolean).join(" · ")) : "") + "</div>" +
      sec("Payout", kv("Amount sent", naira(p.amount)) + kv("Commission taken", naira(p.commission)) + kv("Status", esc(nice(p.status))) + (p.hold_reason ? kv("Why on hold", esc(p.hold_reason)) : "") + (p.last_error ? kv("Last problem", esc(p.last_error), "lvpd-red") : "") + kv("Updated", esc(when(p.updated_at)))) +
      (c.order ? sec("The order's money", breakdown(c, null)) : "") + sec("What happened", timeline(c, null)) +
      '<button type="button" class="btn btn-outline lvpd-open" onclick="document.getElementById(\'lvpdSheet\').remove();navigate(\'orderDetail\',{orderId:\'' + esc(p.order_id) + '\'})">Open the order</button>';
  }
  async function showWd(w) {
    var m = open(naira(Number(w.amount_kobo) / 100), "Withdrawal request", LOADING);
    var c = await ctx(null, w.vendor_id), body = m.querySelector(".lvpd-body"); if (!body) return;
    body.innerHTML = '<div class="lvpd-top">' + statusChip(w.status) + '<span class="lvpd-meth"><i class="fa-solid fa-hand-holding-dollar"></i> ' + (w.kind === "instant" ? "Sent at once" : "Needed approval") + "</span></div>" +
      '<div class="lvpd-who">' + person("From", "Levromart", "Paystack balance") + '<i class="fa-solid fa-arrow-right"></i>' + person("To (shop)", w.business_name || (c.shop && c.shop.business_name), esc([w.account_name, w.bank_name].filter(Boolean).join(" · "))) + "</div>" +
      sec("Request", kv("Amount", naira(Number(w.amount_kobo) / 100)) + kv("Orders covered", String((w.order_ids || []).length)) + kv("Asked", esc(when(w.created_at))) + (w.decided_at ? kv("Decided", esc(when(w.decided_at))) : "") + (w.request_reason ? kv("Shop's reason", esc(w.request_reason)) : "") + (w.reject_reason ? kv("Reason given", esc(w.reject_reason)) : "") + (w.has_dispute ? kv("Dispute", "Has a disputed order", "lvpd-red") : "") + (w.account_changed_at ? kv("Bank account", "Changed " + esc(when(w.account_changed_at)), "lvpd-red") : ""));
  }
  var BUILD = { tx: showTx, refund: showRefund, payout: showPayout, wd: showWd };
  window.lvPayDetail = function (key) { var kind = String(key).split(":")[0], row = (window.__lvPayReg || {})[key]; if (row && BUILD[kind]) BUILD[kind](row); };
  document.addEventListener("click", function (e) {
    var row = e.target.closest && e.target.closest(".lv-tap[data-lvd]"); if (!row) return;
    if (e.target.closest("button,a,.btn,select,input,textarea,label")) return;
    window.lvPayDetail(row.getAttribute("data-lvd"));
  });
})();

/* ===== The Levromart wallet (one wallet for everyone; migration 0033) =====
   Balance top left, Add money top right, Transfer and Withdraw underneath, a slim history line at the bottom. Shops also see
   their earnings and move them in. Until the server has the wallet switched on, the older wallet cards keep showing. */
(function () {
  "use strict";
  var W = { data: null, at: 0, loading: null, off: false, hide: false };
  try { W.hide = localStorage.getItem("lv-w3-hide") === "1"; } catch (_) {}
  function k2n(k) { return Number(k || 0) / 100; }
  function money(k, plain) { if (W.hide && !plain) return "₦ ••••"; try { return "₦" + k2n(k).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); } catch (_) { return "₦" + k2n(k); } }
  function short(k) { try { return "₦" + k2n(k).toLocaleString("en-NG", { maximumFractionDigits: 2 }); } catch (_) { return "₦" + k2n(k); } }
  function signedIn() { return typeof session !== "undefined" && session && typeof profile !== "undefined" && profile && profile.role !== "admin"; }
  function key() { try { return crypto.randomUUID(); } catch (_) { return String(Date.now()) + Math.random().toString(16).slice(2); } }
  // A balance answer is only used if it was asked for AFTER the last time money moved (our own action, or the wallet's
  // notification arriving) and is newer than the last answer used. An older answer that comes back late is dropped and asked
  // again, so the figure goes straight to the right amount and never jumps back to an old one.
  var seq = 0, usedSeq = 0, dirtyAt = 0;
  function markDirty() { dirtyAt = Date.now(); }
  async function load(force) {
    if (!signedIn()) return null;
    if (W.off && Date.now() - (W.offAt || 0) < 60000) return W.data;   // switched off only for a minute, never for the whole visit
    W.off = false;
    if (!force && W.data && Date.now() - W.at < 20000) return W.data;
    if (W.loading) return force ? W.loading.then(function () { return load(true); }) : W.loading;
    W.loading = (async function () {
      try {
        for (var attempt = 0; attempt < 3; attempt++) {
          var mine = ++seq, startedAt = Date.now();
          var r = await sb.rpc("get_levro_wallet");
          if (r.error || !r.data) { if (r.error && /being set up|not ready/i.test(String(r.error.message || r.error.code || ""))) { W.off = true; W.offAt = Date.now(); } return W.data; }
          if (mine < usedSeq) return W.data;                                   // a newer answer was already used
          if (startedAt < dirtyAt && attempt < 2) { await new Promise(function (ok) { setTimeout(ok, 200); }); continue; }   // asked before the money moved: ask again
          usedSeq = mine; W.data = r.data; W.at = Date.now();
          try { localStorage.setItem("lv-w3-cache:" + session.user.id, JSON.stringify(r.data)); } catch (_) {}
          try { if (W.data.pin) window.__lvHasPin = !!W.data.pin.has_pin; if (W.data.pin && !W.data.pin.has_pin && typeof window.lvPinNudge === "function") window.lvPinNudge(false); } catch (_) {}
          return W.data;
        }
        return W.data;
      } catch (_) { return W.data; }
    })().finally(function () { W.loading = null; });
    return W.loading;
  }
  // the balance moves the moment money moves; the server's figure then replaces it
  function bumpBal(deltaKobo) { try { if (W.data && W.data.balance_kobo != null) { W.data.balance_kobo = String(Math.max(0, Number(W.data.balance_kobo) + deltaKobo)); W.at = Date.now(); markDirty(); try { localStorage.setItem("lv-w3-cache:" + session.user.id, JSON.stringify(W.data)); } catch (_) {} } } catch (_) {} }
  function repaint() { try { if (window.lvWalletRepaint) window.lvWalletRepaint(); } catch (_) {} try { if (window.lvRefundRepaint) window.lvRefundRepaint(); } catch (_) {} }
  window.lvW3Refresh = function () { return load(true).then(repaint); };
  // the wallet follows what happens to it (a rejected withdrawal, money received) without a page refresh
  // ...and at once when its notification arrives ("₦200 added to your wallet"), with a quick check every 5 seconds while it is on screen
  var liveFor = null;
  function listen() {
    try {
      if (!signedIn() || liveFor === session.user.id || typeof sb.channel !== "function") return;
      liveFor = session.user.id; var uid = liveFor;
      sb.channel("lv-wallet-live-" + uid + "-" + Date.now()).on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: "user_id=eq." + uid }, function (p) {
        var t = String(p && p.new && p.new.type || ""); if (/^(wallet|refund|payout|withdraw|order_refunded|payment|order_paid|order_payment)/i.test(t)) { markDirty(); load(true).then(repaint); }
      }).subscribe(function (status) { if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") liveFor = null; });   // a dropped connection is set up again
    } catch (_) {}
  }
  setInterval(listen, 4000);
  setInterval(function () { if (!document.hidden && signedIn() && W.data && document.querySelector(".lvw-card, .lw-card") && Date.now() - (W.at || 0) > 2500) load(true).then(repaint); }, 3000);   // a wallet check at most every ~12 s: the notification already refreshes it at once
  document.addEventListener("visibilitychange", function () { if (!document.hidden && signedIn() && W.data) load(true).then(repaint); });
  window.lvW3Eye = function () { W.hide = !W.hide; try { localStorage.setItem("lv-w3-hide", W.hide ? "1" : "0"); } catch (_) {} repaint(); };

  var KIND = {
    topup: ["Money added", "fa-plus", "in"], transfer_in: ["Received", "fa-arrow-down", "in"], transfer_out: ["Sent", "fa-arrow-up", "out"],
    order_payment: ["Order payment", "fa-bag-shopping", "pay"], refund_in: ["Refund", "fa-rotate-left", "in"], refund_out: ["Refunded to a buyer", "fa-rotate-right", "out"],
    earnings_in: ["Shop earnings", "fa-store", "in"], withdrawal: ["Withdrawal", "fa-building-columns", "bank"], withdrawal_return: ["Returned to wallet", "fa-reply", "in"], points_in: ["Points converted", "fa-star", "in"]
  };
  function entryTitle(e) {
    var k = KIND[e.kind] || ["Wallet", "fa-wallet", "in"];
    if (e.kind === "transfer_in") return "From " + (e.counterparty_handle ? "@" + e.counterparty_handle : e.counterparty_name || "someone");
    if (e.kind === "transfer_out") return "To " + (e.counterparty_handle ? "@" + e.counterparty_handle : e.counterparty_name || "someone");
    if (e.kind === "order_payment" && e.note) return e.note;
    return k[0];
  }

  // the card; `kind` is "shop" (shop orders / dashboard) or "me" (everywhere else). `shop` is the shop's earnings (older card data).
  window.lvCancelWdReq = async function (id) {
    if (!(await showConfirmDialog("Take this request back? The money goes back to your waiting earnings, and you can ask again any time.", { title: "Cancel the request", okLabel: "Yes, cancel it", cancelLabel: "Keep it" }))) return;
    var r = await sb.rpc("cancel_withdrawal_request", { p_request_id: id });
    if (r.error) return showToast(r.error.message || "Could not cancel.", "error");
    showToast("Request cancelled.", "success"); try { if (window.lvWalletReload) window.lvWalletReload(); } catch (_) {}
    load(true).then(repaint);
  };
  window.lvWalletCardHtml = function (kind, shop) {
    var d = W.data;
    // the last wallet this phone saw is shown at once, so reopening the app never flashes the older wallet card
    if (!d) { try { var sv = localStorage.getItem("lv-w3-cache:" + session.user.id); if (sv) { d = W.data = JSON.parse(sv); W.at = 0; } } catch (_) {} }
    if (!d || W.off) {
      load(false).then(function (x) { if (x) repaint(); });
      if (!W.off && signedIn()) return '<div class="lvw-card lvw2 lvw3 lvw-skel"><div class="lw-top"><div class="lw-col"><div class="lw-label">Available balance</div><div class="lw-balrow"><div class="lw-bal"><span class="lvw-skel-bar" style="width:8.5rem;height:1.7rem"></span></div></div></div></div><div class="lw-acts lw-acts2"><span class="lvw-skel-bar" style="height:2.6rem"></span><span class="lvw-skel-bar" style="height:2.6rem"></span></div></div>';
      return null;
    }
    var last = (d.entries || []).filter(function (e) { return e.kind !== "fee" && e.kind !== "fee_return"; })[0];
    var pendingWd = (d.withdrawals || []).filter(function (w) { return w.status === "requested"; });
    var earn = kind === "shop" && shop ? Number(shop.ready || 0) * 100 : 0, earnPending = kind === "shop" && shop ? Number(shop.pending || 0) * 100 : 0;
    var notes = "";
    if (d.frozen) notes += '<div class="lvw-note"><i class="fa-solid fa-lock"></i> <span>Your wallet is on hold' + (d.frozen_reason ? ": " + esc(d.frozen_reason) : "") + '. Contact support.</span></div>';
    if (pendingWd.length) notes += '<div class="lvw-note"><i class="fa-solid fa-hourglass-half"></i> <span><b>' + money(pendingWd.reduce(function (s, w) { return s + Number(w.amount_kobo); }, 0)) + '</b> withdrawal waiting for Levromart\'s check</span></div>';
    // money the shop asked to move or withdraw that is still waiting for Levromart (it can be taken back)
    if (kind === "shop" && shop && Array.isArray(shop.requests)) shop.requests.filter(function (q) { return q.status === "requested"; }).forEach(function (q) {
      notes += '<div class="lvw-note"><i class="fa-solid fa-hourglass-half"></i> <span>Waiting for Levromart to confirm <b>' + money(q.amount_kobo) + '</b></span><button type="button" class="lvw-inline lvw-cancel-req" onclick="lvCancelWdReq(\'' + esc(q.id) + '\')">Cancel</button></div>';
    });
    if (kind === "shop" && shop && shop.delayed > 0) notes += '<div class="lvw-note"><i class="fa-solid fa-calendar-day"></i> <span><b>' + money(shop.delayed * 100) + '</b> arrives in your bank next business day.</span></div>';
    return '<div class="lvw-card lvw2 lvw3">' +
      '<div class="lw-top"><div class="lw-col">' +
        '<div class="lw-label">Available balance <button type="button" class="lw-ic" onclick="lvW3Eye()" aria-label="' + (W.hide ? "Show balance" : "Hide balance") + '"><i class="fa-regular ' + (W.hide ? "fa-eye-slash" : "fa-eye") + '"></i></button><button type="button" class="lw-ic" onclick="lvW3Help()" aria-label="How your wallet works"><i class="fa-solid fa-circle-question"></i></button></div>' +
        '<div class="lw-balrow"><div class="lw-bal">' + money(d.balance_kobo) + '</div>' +
        '<button type="button" class="lw-tag" onclick="lvW3CopyTag()" aria-label="Copy your @tag">@' + esc(d.handle) + ' <i class="fa-regular fa-copy"></i></button></div>' +
      '</div><button type="button" class="lw-add" onclick="lvW3Add()"><i class="fa-solid fa-plus"></i> Add money</button></div>' +
      (kind === "shop" && shop ? '<div class="lw-earn"><div><b><small>Shop earnings</small> ' + money(earn) + ' ready</b>' + (earnPending ? '<small>' + money(earnPending) + ' waiting for buyers to confirm</small>' : "") + '</div><button type="button" onclick="lvW3MoveEarnings()"' + (earn > 0 ? "" : " disabled") + '>Move to wallet</button></div>' : "") +
      notes +
      '<div class="lw-acts lw-acts2"><button type="button" onclick="lvW3Send()"><i class="fa-solid fa-paper-plane"></i>Transfer</button><button type="button" onclick="lvW3Withdraw()"><i class="fa-solid fa-building-columns"></i>Withdraw</button></div>' +
      '<button type="button" class="lvw-strip" onclick="lvW3History()"><i class="fa-solid fa-clock-rotate-left lvw-strip-ic"></i><span class="lvw-strip-t">Transaction history</span>' +
        (last ? '<span class="lvw-strip-last"><span class="lvw-strip-nm">' + esc(entryTitle(last)) + '</span><b>' + (Number(last.amount_kobo) > 0 ? "+" : "−") + short(Math.abs(Number(last.amount_kobo))) + '</b></span>' : "") +
        '<i class="fa-solid fa-chevron-right lvw-strip-go"></i></button>' +
    '</div>';
  };

  /* ---------------------------------------------------------------- sheets */
  function sheet(title, body, cls) {
    var old = document.getElementById("lvW3Sheet"); if (old) old.remove();
    var m = document.createElement("div");
    m.id = "lvW3Sheet"; m.className = "lvw-sheet-wrap lw-wrap" + (cls ? " " + cls : "");
    m.innerHTML = '<div class="lvw-sheet lw-sheet" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><div class="lvw-sheet-grab" aria-hidden="true"></div><div class="lvw-sheet-head"><h3>' + esc(title) + '</h3><button type="button" class="lvw-eye lvw-eye-dark" onclick="document.getElementById(\'lvW3Sheet\').remove()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div><div class="lvw-sheet-body">' + body + "</div></div>";
    m.addEventListener("click", function (e) { if (e.target === m) m.remove(); });
    document.body.appendChild(m);
    return m;
  }
  function closeSheet() { var m = document.getElementById("lvW3Sheet"); if (m) m.remove(); }
  function amountField(id, val) { return '<div class="lw-amt"><span>₦</span><input id="' + id + '" inputmode="decimal" autocomplete="off" placeholder="0.00" value="' + (val || "") + '"></div>'; }
  function readAmount(id) { var v = Number(String((document.getElementById(id) || {}).value || "").replace(/[,\s₦]/g, "")); return v > 0 ? Math.round(v * 100) : 0; }
  function err(m, text) { var e = m.querySelector(".lw-err"); if (e) { e.textContent = text || ""; e.hidden = !text; } }

  // change the @tag (allowed once every 30 days; the server checks the rules and that the name is free)
  window.lvW3ChangeTag = async function () {
    var d = await load(false); if (!d) return;
    var m = sheet("Change your @tag", '<p class="lw-hint">People send you money using your @tag. 3 to 24 small letters, numbers or _ (no spaces). <b>You can change it up to 3 times every 30 days</b>, so a mistake can be fixed.</p>' +
      '<div class="lw-card-box"><label class="lw-l" for="lwNewTag">New @tag</label><div class="lw-to"><span>@</span><input id="lwNewTag" type="text" maxlength="24" autocomplete="off" autocapitalize="none" value="' + esc(d.handle || "") + '"></div></div>' +
      '<p class="lw-err" hidden></p><button type="button" class="btn lw-go" id="lwTagSave">Save @tag</button>');
    var inp = m.querySelector("#lwNewTag"), b = m.querySelector("#lwTagSave");
    inp.oninput = function () { inp.value = inp.value.toLowerCase().replace(/[^a-z0-9_]/g, ""); };
    b.onclick = async function () {
      var v = inp.value.trim(); if (v.length < 3) return err(m, "Your @tag needs at least 3 characters.");
      b.disabled = true; var r = await sb.rpc("set_wallet_handle", { p_handle: v });
      if (r.error) { b.disabled = false; return err(m, r.error.message || "Could not change your @tag."); }
      closeSheet(); await load(true); repaint(); showToast("Your @tag is now @" + v + ".", "success");
    };
  };
  window.lvW3CopyTag = function () {
    var t = W.data ? "@" + W.data.handle : ""; if (!t) return;
    try { navigator.clipboard.writeText(t).then(function () { showToast("Copied " + t + ". People send you money with it.", "success"); }); } catch (_) { showToast(t, "info"); }
  };

  window.lvW3Add = async function () {
    var d = await load(false); if (!d) return showToast("Your wallet is not available right now.", "error");
    var m = sheet("Add money", '<p class="lw-hint">Add money with your card, bank transfer or USSD through Paystack.</p>' + amountField("lwAddAmt") +
      '<div class="lw-chips">' + [100, 200, 500, 1000, 2000, 5000].map(function (n) { return '<button type="button" data-n="' + n + '">₦' + n.toLocaleString("en-NG") + "</button>"; }).join("") + "</div>" +
      '<p class="lw-err" hidden></p><button type="button" class="btn lw-go" id="lwAddGo">Continue</button>');
    m.addEventListener("click", function (e) { var c = e.target.closest("[data-n]"); if (c) { document.getElementById("lwAddAmt").value = c.dataset.n; } });
    m.querySelector("#lwAddGo").onclick = async function () {
      var amt = readAmount("lwAddAmt"), b = this;
      if (amt < 10000) return err(m, "The smallest amount is ₦100.");
      var pin = await window.lvPinGate({ title: "Add money", rows: [["Amount into your wallet", short(amt), 1]], cta: "Continue to Paystack" });
      if (!pin) return;
      b.disabled = true; b.textContent = "Opening Paystack…";
      var r = await sb.rpc("wallet_topup", { p_amount_kobo: amt, p_pin: pin });
      if (r.error || !r.data) { b.disabled = false; b.textContent = "Continue"; return err(m, (r.error && r.error.message) || "Could not start. Please try again."); }
      var info = r.data;
      closeSheet();
      try {
        if (window.PaystackPop || (await new Promise(function (res) { var s = document.createElement("script"); s.src = "https://js.paystack.co/v2/inline.js"; s.onload = function () { res(true); }; s.onerror = function () { res(false); }; document.head.appendChild(s); }))) {
          new window.PaystackPop().resumeTransaction(info.accessCode, {
            onSuccess: function () { confirmTopup(info.reference); },
            onCancel: function () { showToast("Cancelled. Nothing was charged.", "info"); },
            onError: function () { showToast("The payment could not be completed. Please try again.", "error"); }
          });
          return;
        }
      } catch (_) {}
      location.href = info.authorizationUrl;
    };
  };
  async function confirmTopup(reference) {
    showToast("Confirming your top-up…", "info");
    for (var i = 0; i < 12; i++) {
      try { var r = await window.levroData.payments.status(reference); if (r && r.data && r.data.status === "success") break; } catch (_) {}
      await new Promise(function (res) { setTimeout(res, i < 3 ? 1500 : 4000); });
    }
    await load(true); repaint();
    showToast("Your wallet balance is updated.", "success");
    try { var last = ((W.data && W.data.entries) || []).filter(function (e) { return e.kind === "topup"; })[0]; if (last) window.lvTxPage({ kind: "topup", title: "Money added", amountKobo: Math.abs(Number(last.amount_kobo)), ref: reference, when: last.created_at }); } catch (_) {}
  }
  // coming back from Paystack's page after a top-up
  try {
    var qs = new URLSearchParams(location.search);
    if (qs.get("wallet") === "1" && qs.get("reference")) { var ref0 = qs.get("reference"); history.replaceState(null, "", location.pathname); setTimeout(function () { confirmTopup(ref0); }, 1500); }
  } catch (_) {}

  window.lvW3Send = async function (prefill) {
    var d = await load(true); if (!d) return showToast("Your wallet is not available right now.", "error");
    var pick = null, myKey = key(), timer = 0;
    // the recipient: a label, then the @tag field. Once someone is chosen, their picture, name and @tag take the field's place (with Change).
    var m = sheet("Transfer to Levromart user", (window.lvPayCarousel ? window.lvPayCarousel("send") : "") +
      '<div class="lw-card-box"><label class="lw-l" for="lwTo">Recipient @tag</label><div class="lw-locked" id="lwLocked" hidden></div><div class="lw-to"><span>@</span><input id="lwTo" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" placeholder="their tag" value="' + esc(prefill || "") + '"></div><div class="lw-sugg" id="lwSugg"></div>' +
      '</div><div class="lw-card-box"><label class="lw-l">Amount</label>' + amountField("lwSendAmt") + '<p class="lw-hint">Balance ' + money(d.balance_kobo, true) + "</p>" +
      '<label class="lw-l">Note (optional)</label><input id="lwNote" class="lw-in" maxlength="140" placeholder="What is it for?">' +
      '</div><p class="lw-err" hidden></p><button type="button" class="btn lw-go" id="lwSendGo">Continue</button>', "lw-full");
    var to = m.querySelector("#lwTo"), sugg = m.querySelector("#lwSugg");
    // people sent to before, newest first, one per @tag; favourites (the heart on a receipt) are kept on this phone
    var people = function (entries) { var seen = {}, out = []; (entries || []).forEach(function (e) { if (e.kind === "transfer_out" && e.counterparty_handle && !seen[e.counterparty_handle]) { seen[e.counterparty_handle] = 1; out.push({ handle: e.counterparty_handle, name: e.counterparty_name || "", avatar_url: e.counterparty_avatar || "" }); } }); return out; };
    var recent = people(d.entries), favs = [];
    try { favs = (window.lvFavPeople ? window.lvFavPeople() : []).filter(function (f) { return f && f.handle; }).map(function (f) { return { handle: f.handle, name: f.name || "", avatar_url: f.avatar_url || "" }; }); } catch (_) {}
    var avatar = function (p) { return '<span class="lw-pp-av">' + (p.avatar_url ? '<img src="' + esc(p.avatar_url) + '" alt="" loading="lazy">' : esc(String(p.name || p.handle).trim().slice(0, 1).toUpperCase())) + "</span>"; };
    var personRow = function (p, i, cls) { return '<button type="button" class="' + cls + '" data-i="' + i + '">' + avatar(p) + '<span class="lw-pp-txt"><b>' + esc(p.name || "@" + p.handle) + '</b><small>@' + esc(p.handle) + '</small></span><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>'; };

    // the chosen person is locked in: picture, name and @tag, with Change
    function paintPick() {
      var box = m.querySelector("#lwLocked"), field = m.querySelector(".lw-to"), pp = m.querySelector(".lw-pp");
      if (!pick) { box.hidden = true; box.innerHTML = ""; field.hidden = false; if (pp) pp.hidden = false; return; }
      box.innerHTML = avatar(pick) + '<span class="lw-pp-txt"><b>' + esc(pick.name || ("@" + pick.handle)) + ' <i class="fa-solid fa-circle-check" aria-hidden="true"></i></b><small>@' + esc(pick.handle) + '</small></span><button type="button" id="lwFavBtn" class="lw-fav' + (window.lvIsFav && window.lvIsFav(pick.handle) ? ' on' : '') + '" aria-label="Favourite"><i class="fa-' + (window.lvIsFav && window.lvIsFav(pick.handle) ? 'solid' : 'regular') + ' fa-heart"></i></button><button type="button" id="lwChange">Change</button>';
      box.hidden = false; field.hidden = true; sugg.innerHTML = ""; sugg.__list = null; if (pp) pp.hidden = true;
      box.querySelector("#lwChange").onclick = function () { pick = null; to.value = ""; paintPick(); to.focus(); showRecentSuggestions(); };
      box.querySelector("#lwFavBtn").onclick = function () {
        var on = window.lvFavToggle ? window.lvFavToggle(pick) : false;
        this.classList.toggle("on", on); this.innerHTML = '<i class="fa-' + (on ? "solid" : "regular") + ' fa-heart"></i>';
        showToast(on ? "Added to your favourites." : "Removed from favourites.", "success");
      };
      try { m.querySelector("#lwSendAmt").focus({ preventScroll: true }); } catch (_) {}
    }
    // someone chosen from a list we already have (Recents, Favourites, the suggestions): lock them in at once, then check the
    // @tag still belongs to a wallet and take the latest name and picture
    async function choose(p) {
      if (!p || !p.handle) return;
      pick = { handle: p.handle, name: p.name || "", avatar_url: p.avatar_url || "" }; to.value = p.handle; paintPick();
      try {
        var r = await sb.rpc("find_wallet_people", { p_query: p.handle });
        var hit = ((r && r.data) || []).find(function (x) { return x.handle === p.handle; });
        if (pick && pick.handle === p.handle) {
          if (hit) { pick = hit; paintPick(); }
          else if (r && !r.error) { pick = null; to.value = p.handle; paintPick(); sugg.innerHTML = '<p class="lw-hint">Nobody has that @tag any more.</p>'; }
        }
      } catch (_) {}
    }
    function suggestions(list, caption) {
      sugg.__list = list;
      sugg.innerHTML = (caption ? '<p class="lw-sugg-cap">' + esc(caption) + "</p>" : "") + list.map(function (p, i) { return personRow(p, i, "lw-person"); }).join("");
    }
    // tapping the empty field shows the people sent to most recently (favourites first)
    function showRecentSuggestions() {
      if (pick || to.value.trim()) return;
      var seen = {}, list = favs.concat(recent).filter(function (p) { if (seen[p.handle]) return false; seen[p.handle] = 1; return true; }).slice(0, 5);
      if (list.length) suggestions(list, "Recent"); else sugg.innerHTML = "";
    }

    // Recents / Favourites under the form
    if (!prefill) {
      var pp = document.createElement("section"); pp.className = "lw-pp"; pp.setAttribute("aria-label", "People you send to");
      var listHtml = function (list, empty) {
        return list.length ? list.slice(0, 8).map(function (p, i) { return personRow(p, i, "lw-pp-row"); }).join("") :
          '<div class="lw-pp-empty"><span class="lw-pp-empty-ic"><i class="fa-solid ' + empty[0] + '" aria-hidden="true"></i></span><b>' + empty[1] + '</b><small>' + empty[2] + "</small></div>";
      };
      pp.innerHTML = '<div class="lw-pp-head"><div class="lw-pp-tabs" role="tablist"><button type="button" role="tab" data-tab="r" aria-selected="true" class="on">Recents</button><button type="button" role="tab" data-tab="f" aria-selected="false">Favourites</button></div>' +
        '<button type="button" class="lw-pp-all" data-all aria-label="Search everyone you have sent to"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i></button></div>' +
        '<div class="lw-pp-list" data-p="r" role="tabpanel">' + listHtml(recent, ["fa-clock-rotate-left", "No recent transfers", "People you send money to will show here."]) + "</div>" +
        '<div class="lw-pp-list" data-p="f" role="tabpanel" hidden>' + listHtml(favs, ["fa-heart", "No favourites yet", "Tap the heart on a receipt to keep someone here."]) + "</div>";
      pp.addEventListener("click", async function (ev) {
        var t = ev.target.closest("[data-tab]");
        if (t) {
          pp.querySelectorAll("[data-tab]").forEach(function (x) { var on = x === t; x.classList.toggle("on", on); x.setAttribute("aria-selected", on ? "true" : "false"); });
          pp.querySelectorAll(".lw-pp-list").forEach(function (l) { l.hidden = l.dataset.p !== t.dataset.tab; });
          return;
        }
        var row = ev.target.closest(".lw-pp-row");
        if (row) { var src = row.closest(".lw-pp-list").dataset.p === "f" ? favs : recent; return choose(src[+row.dataset.i]); }
        if (!ev.target.closest("[data-all]")) return;
        // everyone ever sent to, with a search box
        var all = d.entries || [];
        try { var more = await sb.rpc("get_levro_wallet_history", { p_before: (all[all.length - 1] || {}).created_at || null }); all = all.concat((more && more.data) || []); } catch (_) {}
        var full = people(all), sh = document.createElement("div"); sh.className = "lvw-sheet-wrap";
        sh.innerHTML = '<div class="lvw-sheet" role="dialog" aria-modal="true" aria-label="Beneficiaries"><div class="lvw-sheet-grab"></div><div class="lvw-sheet-head"><h3>Beneficiaries</h3><button type="button" class="lvw-eye lvw-eye-dark" data-x aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div><div class="lvw-sheet-body"><input class="lwh-search" type="search" placeholder="Search name or @tag" autocomplete="off"><div class="lw-pp-all-list">' +
          (full.length ? full.map(function (p, i) { return personRow(p, i, "lw-pp-row").replace("<button ", '<button data-s="' + esc(((p.name || "") + " " + p.handle).toLowerCase()) + '" '); }).join("") : '<div class="lw-pp-empty"><span class="lw-pp-empty-ic"><i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i></span><b>No transfers yet</b><small>People you send money to will show here.</small></div>') + "</div></div></div>";
        document.body.appendChild(sh);
        sh.querySelector(".lwh-search").oninput = function () { var q = this.value.trim().toLowerCase(); sh.querySelectorAll(".lw-pp-row").forEach(function (r) { r.hidden = !!q && r.dataset.s.indexOf(q) < 0; }); };
        sh.onclick = function (e2) { if (e2.target === sh || e2.target.closest("[data-x]")) return sh.remove(); var r = e2.target.closest(".lw-pp-row"); if (r) { sh.remove(); choose(full[+r.dataset.i]); } };
      });
      m.querySelector(".lvw-sheet-body").appendChild(pp);
    }

    var seq = 0;
    async function search() {
      var q = to.value.trim().replace(/^@/, "").toLowerCase().replace(/\s+/g, " "); pick = null;
      if (!q) { showRecentSuggestions(); return; }
      if (q.length < 2) { sugg.innerHTML = ""; sugg.__list = null; return; }
      var my = ++seq;
      var r = await sb.rpc("find_wallet_people", { p_query: q });
      if (my !== seq) return;   // a newer search is already on its way
      var list = (r && r.data) || [];
      var exact = list.find(function (p) { return p.handle === q; }); if (exact && list.length === 1) { pick = exact; paintPick(); return; }
      if (list.length) suggestions(list, ""); else { sugg.__list = null; sugg.innerHTML = '<p class="lw-hint">Nobody has that @tag yet.</p>'; }
    }
    to.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(search, 60); });
    to.addEventListener("focus", showRecentSuggestions);
    sugg.addEventListener("click", function (e) { var b = e.target.closest("[data-i]"); if (!b || !sugg.__list) return; choose(sugg.__list[+b.dataset.i]); });
    if (prefill) search();
    m.querySelector("#lwSendGo").onclick = async function () {
      var goBtn = this; if (goBtn.__busy) return; goBtn.__busy = true;   // a second tap while this one is working does nothing
      try { await sendGo.call(goBtn); } finally { goBtn.__busy = false; }
    };
    async function sendGo() {
      var amt = readAmount("lwSendAmt"), note = m.querySelector("#lwNote").value.trim();
      if (!pick) return err(m, "Choose who to send to from the list.");
      if (amt < 10000) return err(m, "The smallest amount is ₦100.");
      if (amt > Number(d.balance_kobo)) return err(m, "This amount exceeds what can be transferred after transfer charges. Please enter a lower amount.");
      err(m, "");
      var fee = window.lvWalletFee(amt);
      if (amt + fee > Number(d.balance_kobo)) return err(m, "This amount exceeds what can be transferred after transfer charges. Please enter a lower amount.");
      var pin = await window.lvPinGate({ title: "Confirm transfer", person: pick, rows: [["To", (pick.name || "") + " (@" + pick.handle + ")"], ["Amount", short(amt), 1]].concat(fee > 0 ? [["Transfer fee", short(fee) + " · charged separately after sending"]] : []).concat(note ? [["Note", note]] : []), cta: "Send " + short(amt), note: "Transfers cannot be undone. Check the name first." });
      if (!pin) return;
      if (!(await window.lvRepeatCheck("send:" + pick.handle + ":" + amt, { title: "Repeat transaction detected", text: "You sent " + short(amt) + " to " + (pick.name || "@" + pick.handle) + " a moment ago. Do you want to send it again?", okLabel: "Send again", cancelLabel: "No, cancel" }))) return;
      if (!(await showConfirmDialog("Send " + short(amt) + " to " + (pick.name || "@" + pick.handle) + " (@" + pick.handle + ")? You cannot get it back once it is sent.", { title: "Send money", okLabel: "Yes, send it", cancelLabel: "No, go back" }))) return;
      var b = this; b.disabled = true; b.textContent = "Sending…";
      var r = await sb.rpc("wallet_send", { p_to: pick.handle, p_amount_kobo: amt, p_note: note || null, p_key: myKey, p_pin: pin });
      if (r.error) { b.disabled = false; b.textContent = "Continue"; return err(m, r.error.message || "Could not send."); }
      window.lvRepeatMark("send:" + pick.handle + ":" + amt);
      bumpBal(-(amt + fee)); repaint(); closeSheet(); load(true).then(repaint);
      try { window.lvTxPage({ kind: "sent", title: "Transfer successful", amountKobo: amt, feeKobo: fee, person: pick, note: note, ref: r.data && (r.data.id || r.data.reference) }); } catch (_) { showToast(short(amt) + " sent.", "success"); }
    }
  };

  // the bank's code from its name (the account only carries the name), so its own logo can be shown
  function bankCodeOf(name) {
    try {
      var n = String(name || "").toLowerCase().replace(/[^a-z0-9]/g, ""), list = (typeof NIGERIAN_BANKS !== "undefined" && NIGERIAN_BANKS) || [];
      for (var i = 0; i < list.length; i++) { var b = String(list[i].name || "").toLowerCase().replace(/[^a-z0-9]/g, ""); if (b && (n === b || n.indexOf(b) > -1 || b.indexOf(n) > -1)) return list[i].code; }
      if (/opay|paycom/.test(n)) return "999992";
    } catch (_) {}
    return "";
  }
  window.lvW3Withdraw = async function () {
    var d = await load(true); if (!d) return showToast("Your wallet is not available right now.", "error");
    if (!d.account) {
      var add = await showConfirmDialog("Add the bank account your money should go to. It must be in your own name.", { title: "Add your bank account", okLabel: "Add bank account", cancelLabel: "Not now" });
      if (add) { if (typeof vendor !== "undefined" && vendor && window.lvGoToPayout) window.lvGoToPayout(); else if (window.lvRefundAccount) window.lvRefundAccount(); }
      return;
    }
    var a = d.account, most = Number(d.withdrawable_now_kobo || 0);
    var m = sheet("Withdraw", (window.lvPayCarousel ? window.lvPayCarousel("withdraw") : "") + '<div class="lw-bank"><span class="ve-bank-ico lw-bank-logo" data-bank-code="' + esc(a.bank_code || bankCodeOf(a.bank_name)) + '"><i class="fa-solid fa-building-columns"></i></span><div><b>' + esc(a.bank_name || "Your bank") + ' ···' + esc(a.last4 || "") + '</b><small>' + esc(a.account_name || "") + "</small></div></div>" +
      '<label class="lw-l">Amount</label>' + amountField("lwWdAmt", "") + '<p class="lw-hint">Balance ' + money(d.balance_kobo, true) + '</p>' +
      '<p class="lw-err" hidden></p><button type="button" class="btn lw-go" id="lwWdGo">Continue</button>');
    m.querySelector("#lwWdGo").onclick = async function () {
      var goBtn = this; if (goBtn.__busy) return; goBtn.__busy = true;
      try { await wdGo.call(goBtn); } finally { goBtn.__busy = false; }
    };
    async function wdGo() {
      var amt = readAmount("lwWdAmt");
      if (amt < 10000) return err(m, "The smallest withdrawal is ₦100.");
      var fee = window.lvWalletFee(amt);
      // like a bank app: never say "the most you can take is…"; explain that the transfer has a small fee and invite a slightly smaller amount
      if (amt + fee > Number(d.balance_kobo) || amt > most) return err(m, "This amount exceeds what can be transferred after transfer charges. Please enter a lower amount.");
      var pin = await window.lvPinGate({ title: "Confirm withdrawal", rows: [["To", (a.bank_name || "Your bank") + " ···" + (a.last4 || "")], ["Account name", a.account_name || ""], ["Amount to your bank", short(amt), 1]].concat(fee > 0 ? [["Withdrawal fee", short(fee) + " · charged separately after sending"]] : []), cta: "Withdraw " + short(amt) });
      if (!pin) return;
      if (!(await window.lvRepeatCheck("wd:" + amt, { title: "Repeat transaction detected", text: "You withdrew " + short(amt) + " a moment ago. Do you want to withdraw the same amount again?", okLabel: "Withdraw again", cancelLabel: "No, cancel" }))) return;
      if (!(await showConfirmDialog("Withdraw " + short(amt) + " to " + (a.bank_name || "your bank") + " ···" + (a.last4 || "") + (a.account_name ? " (" + a.account_name + ")" : "") + "? This is final.", { title: "Withdraw money", okLabel: "Yes, withdraw", cancelLabel: "No, go back" }))) return;
      var b = this; b.disabled = true; b.textContent = "Please wait…";
      var r = await sb.rpc("wallet_withdraw", { p_amount_kobo: amt, p_pin: pin });
      if (r.error) { b.disabled = false; b.textContent = "Continue"; return err(m, r.error.message || "Could not withdraw."); }
      window.lvRepeatMark("wd:" + amt);
      bumpBal(-(amt + fee)); closeSheet(); repaint(); load(true).then(repaint);
      try { window.lvTxPage({ kind: "withdraw", title: "Withdrawal on its way", amountKobo: amt, feeKobo: fee, bank: a, ref: r.data && (r.data.id || r.data.reference) }); } catch (_) { showToast(short(amt) + " is on its way to your bank.", "success"); }
    }
  };

  function shieldSvg(sz) {
    return '<svg class="lv-shield" width="' + (sz || 56) + '" height="' + (sz || 56) + '" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="lvShG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#34d399"/><stop offset=".6" stop-color="#0f9d6a"/><stop offset="1" stop-color="#065f46"/></linearGradient></defs><path d="M32 3 57 12v18c0 16-10 27-25 32C17 57 7 46 7 30V12z" fill="url(#lvShG)"/><path d="M32 3 57 12v18c0 16-10 27-25 32z" fill="#fff" opacity=".12"/><path d="M32 3 7 12v18c0 16 10 27 25 32z" fill="#000" opacity=".06"/><path d="M20 32l9 9 16-19" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  window.lvShieldHtml = shieldSvg;
  // when nothing can move yet: say why, and that the money is safe (never just "none")
  function nothingToMove() {
    sheet("Your earnings are safe", '<div class="lv-safe-hero">' + shieldSvg(72) + '</div><p class="lv-safe-p"><b>There is nothing to move right now.</b> Money from a sale shows here once the buyer confirms they received the order, or 24 hours after delivery if they do nothing.</p><p class="lv-safe-p">Just made a sale and do not see it yet? It can take a little longer than usual. It will appear here by itself, usually within 24 hours, and you will get a notification. Nothing is lost.</p><p class="lv-safe-pill"><i class="fa-solid fa-lock"></i> All payments are secured by Paystack. Levromart holds the money safely until it is yours.</p><button type="button" class="btn lw-go" onclick="document.getElementById(\'lvW3Sheet\').remove()">Got it</button>');
  }
  // the older way (the server has not been updated yet): all that is ready, or an approval request for the rest
  async function legacyMove(s) {
    var now = Number(s.to_wallet_now_kobo || 0), later = Number(s.to_wallet_approval_kobo || 0);
    if (!now && !later) return nothingToMove();
    var why = "";
    if (later) { why = await showTextPromptDialog("Why do you need it now?", "Part of this money is less than 24 hours old, so Levromart checks it first. Tell us why you need it now. An admin reads this before deciding.", { okLabel: "Continue", required: true }); if (!why) return; }
    var ok = await showConfirmDialog((now ? short(now) + " moves into your wallet now." : "") + (later ? (now ? " " : "") + short(later) + " is released 24 hours after it was paid. Your money stays safe in the meantime." : ""), { title: "Move earnings to your wallet", okLabel: "Move", cancelLabel: "Go back" });
    if (!ok) return;
    var pin = await window.lvPinGate({ title: "Move earnings to your wallet", rows: [["Moves now", short(now), 1]].concat(later ? [["Checked by Levromart first", short(later)]] : []), cta: "Move" });
    if (!pin) return;
    var r = await sb.rpc("request_withdrawal", { p_destination: "wallet", p_pin: pin, p_reason: why || null });
    if (r.error) return showToast(r.error.message || "We could not move your earnings just now. Your money is safe; please try again in a little while.", "error");
    showToast(Number(r.data.sent_kobo) > 0 ? short(r.data.sent_kobo) + " is now in your wallet." : "Request sent. Your money is safe; we will message you when it is approved.", "success");
    await load(true); repaint(); try { if (window.lvWalletReload) window.lvWalletReload(); } catch (_) {}
  }
  window.lvW3MoveEarnings = async function () {
    var r0 = await sb.rpc("get_withdrawal_summary"); var s = (r0 && r0.data) || {};
    if (!Array.isArray(s.earnings)) return legacyMove(s);   // the server has not been updated yet: keep the old all-or-nothing way
    var list = s.earnings.slice().filter(function (e) { return e.state !== "held"; });
    // the order the money moves in: money that is ready first (oldest first), then newer money (oldest first)
    list.sort(function (a, b) { var ra = a.state === "ready" ? 0 : 1, rb = b.state === "ready" ? 0 : 1; return ra - rb || new Date(a.paid_at) - new Date(b.paid_at); });
    var ready = 0, recent = 0; list.forEach(function (e) { if (e.state === "ready") ready += e.net_kobo; else recent += e.net_kobo; });
    var total = ready + recent, reqs = (s.recent || []).filter(function (w) { return w.destination === "wallet"; });
    var waiting = reqs.filter(function (w) { return w.status === "requested"; }).length;
    if (!list.length && !reqs.length) return nothingToMove();
    function pick(amt) {   // whole sales only, up to the amount typed
      var ids = [], now = 0, later = 0, sum = 0;
      for (var k = 0; k < list.length; k++) { var e = list[k]; if (sum + e.net_kobo > amt) continue; sum += e.net_kobo; ids.push(e.order_id); if (e.state === "ready") now += e.net_kobo; else later += e.net_kobo; }
      return { ids: ids, now: now, later: later, total: sum };
    }
    var smallest = list.reduce(function (m, e) { return m ? Math.min(m, e.net_kobo) : e.net_kobo; }, 0);
    var m = sheet("Move to wallet", '<div class="lw-mv-stats"><div><small>Ready now</small><b>' + short(ready) + '</b></div><div><small>Within 24 hours</small><b>' + short(recent) + '</b></div></div>' +
      (list.length ? '<label class="lw-l">How much do you want to move?</label>' + amountField("lwMvAmt", "") + '<button type="button" class="lw-mv-all" id="lwMvAll">Move all ' + short(total) + '</button><p class="lw-mv-info" id="lwMvInfo"></p>' +
        '<div id="lwMvWhy" hidden><label class="lw-l">Why do you need it now?</label><textarea id="lwMvReason" class="lw-in" rows="2" maxlength="300" placeholder="For example: I need to restock today"></textarea></div>' +
        '<p class="lw-err" hidden></p><button type="button" class="btn lw-go" id="lwMvGo">Move to wallet</button>' : '<p class="lv-safe-p">Nothing is ready to move right now. Your earnings are safe and will show here.</p>') +
      '<div class="lw-mv-links"><button type="button" id="lwMvReqs">My requests' + (waiting ? " (" + waiting + " waiting)" : "") + ' <i class="fa-solid fa-chevron-right"></i></button><button type="button" id="lwMvList">Earnings breakdown <i class="fa-solid fa-chevron-right"></i></button></div>');
    function ago(iso) { var h = (Date.now() - new Date(iso).getTime()) / 36e5; if (!(h >= 0)) return "just now"; if (h < 1) return Math.max(1, Math.round(h * 60)) + " min ago"; if (h < 48) return Math.floor(h) + " h ago"; return Math.floor(h / 24) + " days ago"; }
    function ic3(name, sz) { return window.lv3dIcon && window.LV3D && window.LV3D[name] ? window.lv3dIcon(name, sz || 44) : ""; }
    // a full page (not a drawer), with Back: My requests and Earnings breakdown
    function page(title, html) {
      closeSheet();
      var old = document.getElementById("lvMvPage"); if (old) old.remove();
      var pg = document.createElement("div"); pg.id = "lvMvPage"; pg.className = "lv-mvp";
      pg.innerHTML = '<div class="lv-mvp-top"><button type="button" class="lv-tx-x" data-back aria-label="Back"><i class="fa-solid fa-arrow-left"></i></button><b>' + esc(title) + '</b><span></span></div><div class="lv-mvp-body">' + html + '</div>';
      document.body.appendChild(pg);
      pg.addEventListener("click", function (ev) { if (ev.target.closest("[data-back]")) { pg.remove(); window.lvW3MoveEarnings(); } });
      return pg;
    }
    m.querySelector("#lwMvList").onclick = function () {
      var tot = { ready: 0, wait: 0, held: 0 };
      s.earnings.forEach(function (e) { if (e.state === "held") tot.held += e.net_kobo; else if (e.state === "ready") tot.ready += e.net_kobo; else tot.wait += e.net_kobo; });
      page("Earnings breakdown", '<div class="lv-mvp-sum"><div><small>Ready</small><b>' + short(tot.ready) + '</b></div><div><small>Within 24 h</small><b>' + short(tot.wait) + '</b></div><div><small>On hold</small><b>' + short(tot.held) + '</b></div></div>' +
        (s.earnings.length ? '<div class="lv-mvp-list">' + s.earnings.map(function (e) {
          var st = e.state === "held" ? ["Held: open dispute", "dispute", "bad"] : e.state === "ready" ? ["Ready to move", "tx-ready", "ok"] : ["Ready in " + Math.max(1, Math.ceil(24 - (Date.now() - new Date(e.paid_at).getTime()) / 36e5)) + " h", "tx-pending", "wait"];
          return '<div class="lv-mvp-row"><span class="lv-mvp-ic">' + ic3(st[1]) + '</span><div><b>Order ' + esc(String(e.order_id).slice(0, 8).toUpperCase()) + '</b><small>Earned ' + ago(e.paid_at) + '</small></div><div class="lv-mvp-r"><b>' + short(e.net_kobo) + '</b><em class="' + st[2] + '">' + esc(st[0]) + '</em></div></div>';
        }).join("") + '</div>' : '<div class="lv-mvp-empty">' + ic3("empty-bank", 96) + '<p>No earnings yet.</p></div>'));
    };
    m.querySelector("#lwMvReqs").onclick = function () {
      var pg = page("My requests", reqs.length ? '<div class="lv-mvp-list">' + reqs.slice(0, 30).map(function (w) {
        var cancelled = w.status === "rejected" && w.reject_reason === "Cancelled by the shop";
        var st = cancelled ? ["Cancelled", "order-cancelled", "bad"] : { requested: ["Waiting for Levromart", "tx-pending", "wait"], approved: ["Approved", "withdrawal-approved", "ok"], rejected: ["Not approved", "withdrawal-rejected", "bad"] }[w.status] || [w.status, "general", "wait"];
        return '<div class="lv-mvp-row lv-mvp-req"><span class="lv-mvp-ic">' + ic3(st[1]) + '</span><div><b>' + short(w.amount_kobo) + '</b><small>' + ago(w.created_at) + '</small>' +
          (w.request_reason ? '<p>Your reason: ' + esc(w.request_reason) + '</p>' : "") + (w.status === "rejected" && w.reject_reason && !cancelled ? '<p class="bad">Levromart: ' + esc(w.reject_reason) + '</p>' : "") +
          '</div><div class="lv-mvp-r"><em class="' + st[2] + '">' + esc(st[0]) + '</em>' + (w.status === "requested" ? '<button type="button" data-cancel="' + esc(w.id) + '">Cancel</button>' : "") + '</div></div>';
      }).join("") + '</div>' : '<div class="lv-mvp-empty">' + ic3("requests", 96) + '<p>You have not made a request yet.</p></div>');
      pg.addEventListener("click", function (ev) { var b = ev.target.closest("[data-cancel]"); if (b) { pg.remove(); window.lvCancelWdReq(b.dataset.cancel); } });
    };
    if (!list.length) return;
    var amtEl = m.querySelector("#lwMvAmt"), info = m.querySelector("#lwMvInfo");
    function refresh() {
      var amt = readAmount("lwMvAmt"), p = pick(amt);
      m.__pick = p;
      m.querySelector("#lwMvWhy").hidden = !p.later;
      if (!amt) info.textContent = "Enter an amount, or tap Move all.";
      else if (amt > total) info.textContent = "You only have " + short(total) + " to move.";
      else if (!p.total) info.textContent = "Earnings move one sale at a time. The smallest is " + short(smallest) + ".";
      else info.textContent = (p.now ? short(p.now) + " moves now" : "") + (p.now && p.later ? " · " : "") + (p.later ? short(p.later) + " goes to Levromart for approval" : "") + (p.total < amt ? " (rounded down to whole sales: " + short(p.total) + ")" : "");
    }
    amtEl.addEventListener("input", refresh); refresh();
    m.querySelector("#lwMvAll").onclick = function () { amtEl.value = String(total / 100); refresh(); };
    m.querySelector("#lwMvGo").onclick = async function () {
      var p = m.__pick || pick(readAmount("lwMvAmt")), why = (m.querySelector("#lwMvReason").value || "").trim(), b = this;
      if (!p.total) return err(m, readAmount("lwMvAmt") ? "Please enter an amount that covers at least one sale (" + short(smallest) + ")." : "Enter how much you want to move.");
      if (p.later && why.length < 3) return err(m, "Please tell us why you need the newer money. An admin reads it.");
      err(m, "");
      var pin = await window.lvPinGate({ title: "Move to wallet", rows: [["Amount", short(p.total), 1]].concat(p.later ? [["Waits for approval", short(p.later)]] : []), cta: "Move " + short(p.total) });
      if (!pin) return;
      b.disabled = true; b.textContent = "Please wait…";
      var r = await sb.rpc("request_withdrawal", { p_destination: "wallet", p_pin: pin, p_order_ids: p.ids, p_reason: why || null });
      if (r.error) { b.disabled = false; b.textContent = "Move to wallet"; return err(m, r.error.message || "Could not move your earnings."); }
      closeSheet();
      showToast(Number(r.data.sent_kobo) > 0 ? short(r.data.sent_kobo) + " is now in your wallet." + (Number(r.data.requested_kobo) > 0 ? " The rest is waiting for approval." : "") : "Request sent. We will message you when it is approved.", "success");
      await load(true); repaint(); try { if (window.lvWalletReload) window.lvWalletReload(); } catch (_) {}
    };
  };

  window.lvW3Help = function () {
    var shop = typeof vendor !== "undefined" && vendor;
    sheet("How your wallet works", '<div class="lv-safe-hero">' + shieldSvg(72) + '<b>Your money is safe</b><small>All payments are secured by Paystack, and your wallet is protected by your PIN. Nothing leaves your wallet unless you approve it.</small></div><ul class="lvw-how">' +
      '<li><b>One wallet.</b> Money you add, money people send you, refunds' + (shop ? " and your shop earnings" : "") + ' all land here. Your @tag is how people send you money.</li>' +
      '<li><b>Add money.</b> With your card, bank transfer or USSD through Paystack.</li>' +
      '<li><b>Pay for orders.</b> Choose "Levromart wallet" when you pay: no Paystack screens, quick and easy to track. The shop gets its share the usual way.</li>' +
      '<li><b>Transfer.</b> Send money to anyone by their @tag. Check the name before you send: transfers cannot be undone.</li>' +
      (shop ? '<li><b>Shop earnings.</b> When a buyer confirms an order, your share (the sale minus Levromart\'s 3% commission) is ready. Earnings are released 24 hours after the payment. This protects you and your buyers: if a buyer reports a scam in that time, the money can still be refunded. A refund comes out of your share.</li>' : '<li><b>Refunds.</b> If an order is cancelled or a problem is settled in your favour, the refund comes into your wallet. It is paid out of the shop\'s share.</li>') +
      '<li><b>Your PIN.</b> A 6-digit PIN protects every payment, transfer and withdrawal, like a bank app. Keep it to yourself: Levromart will never ask for it.</li>' +
      '<li><b>Withdraw.</b> To your own bank account, at any time, with your PIN. You can change your bank account whenever you like. Only a shop\'s earnings paid in the last 24 hours wait for a check by Levromart.</li>' +
      '</ul><div style="display:flex;justify-content:flex-end"><button type="button" class="lw-link lw-tag-change" onclick="lvW3ChangeTag()"><i class="fa-solid fa-pen"></i> Change my @tag</button></div>' + (typeof window.lvWalletColoursHtml === "function" ? window.lvWalletColoursHtml() : ""));
  };

  // the full history: grouped by day, a new-bank header when withdrawals start going to a different account
  // the history is a page of its own (not a drawer): the strip on the wallet card opens it
  window.renderWalletHistoryPage = function () {
    // wait until the page is on screen (a fixed 30 ms wait could run too early and leave it loading)
    var tries = 0; (function wait() { var t = document.getElementById("lvwhPage"); if (t) { window.lvW3History(t); return; } if (++tries < 60) setTimeout(wait, 50); })();
    return '<div class="lvw-page"><div class="lvw-page-head"><button type="button" class="lvw-back" onclick="history.back()" aria-label="Back"><i class="fa-solid fa-arrow-left"></i></button><h2>Transaction history</h2></div><div id="lvwhPage" class="lvwh-page"><p class="muted" style="text-align:center;padding:1.5rem 0">Loading…</p></div></div>';
  };
  window.lvW3History = async function (target) {
    if (!(target && target.nodeType === 1)) return navigate("walletHistory");
    var body = target;
    var r = await sb.rpc("get_levro_wallet_history", {});
    // a failed request is shown as a failure (never as "No transactions yet"), with a way to try again
    if (r && r.error && !(Array.isArray(r.data) && r.data.length)) { body.innerHTML = '<div class="lvw-empty"><i class="fa-solid fa-triangle-exclamation"></i><strong>Couldn\'t load your transactions</strong><span>' + esc(r.error.message || "Please try again.") + '</span><button type="button" class="btn btn-outline" style="margin-top:.8rem" onclick="lvW3History(document.getElementById(\'lvwhPage\'))">Try again</button></div>'; return; }
    var isFee = function (e) { return e.kind === "fee" || e.kind === "fee_return"; };   // charges are never listed
    var all = ((r && r.data) || []).filter(function (e) { return !isFee(e); }), rawCount = ((r && r.data) || []).length, filter = "all", term = "";
    var now0 = new Date(), cur = { y: now0.getFullYear(), m: now0.getMonth() }, month = { y: cur.y, m: cur.m }, day = null;
    if (!all.length) { body.innerHTML = '<div class="lvw-empty"><i class="fa-solid fa-receipt"></i><strong>No transactions yet</strong><span>Money you add, send, receive or spend shows here.</span></div>'; return; }
    // every transaction is loaded up front, so each month is complete (no "load more")
    var oldest = (r && r.data) || [];
    for (var pg = 0; pg < 40 && oldest.length >= 50 * (pg + 1) && oldest.length; pg++) {
      var q = await sb.rpc("get_levro_wallet_history", { p_before: oldest[oldest.length - 1].created_at });
      var have = {}; oldest.forEach(function (e) { have[e.id] = 1; });
      var next = ((q && q.data) || []).filter(function (e) { return !have[e.id]; });
      if (!next.length) break; oldest = oldest.concat(next); all = all.concat(next.filter(function (e) { return !isFee(e); }));
    }
    var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    var TYPES = [["all", "All types"], ["in", "Money in"], ["out", "Money out"], ["transfer", "Transfers"], ["order_payment", "Order payments"], ["withdrawal", "Withdrawals"], ["topup", "Money added"], ["refund", "Refunds"], ["earnings_in", "Shop earnings"]];
    var STATUS = [["all", "All status"], ["ok", "Successful"], ["wait", "Pending"], ["bad", "Failed"]], status = "all";
    body.innerHTML = '<div class="lwh-filters"><label class="lwh-sel"><select id="lwhType">' + TYPES.map(function (t) { return '<option value="' + t[0] + '">' + t[1] + '</option>'; }).join("") + '</select><i class="fa-solid fa-caret-down"></i></label><label class="lwh-sel"><select id="lwhStatus">' + STATUS.map(function (t) { return '<option value="' + t[0] + '">' + t[1] + '</option>'; }).join("") + '</select><i class="fa-solid fa-caret-down"></i></label><button type="button" class="lwh-sbtn" id="lwhSearchBtn" aria-label="Search"><i class="fa-solid fa-magnifying-glass"></i></button></div>' +
      '<input class="lwh-search" type="search" placeholder="Search name, @tag or note" autocomplete="off" hidden>' +
      (window.lvPayCarousel ? window.lvPayCarousel("history") : "") +
      '<div class="lwh-card"><div class="lwh-head"><div><button type="button" class="lwh-pick" id="lwhMonth" aria-label="Pick a month"></button><div class="lwh-io" id="lwhSum"></div></div><button type="button" class="lwh-an" id="lwhAnalysis">Analysis</button></div>' +
      '<span hidden><button type="button" id="lwhPrev"></button><button type="button" id="lwhNext"></button><div class="lwh-chips"></div></span><div id="lwhList"></div></div>';
    function inPeriod(e) { var d = new Date(e.created_at); return d.getFullYear() === month.y && d.getMonth() === month.m && (!day || d.getDate() === day); }
    function paint() {
      var inP = all.filter(inPeriod), tin = 0, tout = 0;
      inP.forEach(function (e) { var a = Number(e.amount_kobo); if (a > 0) tin += a; else tout += -a; });
      body.querySelector("#lwhMonth").innerHTML = (day ? day + " " : "") + MONTHS[month.m].slice(0, 3) + (month.y !== cur.y ? " " + month.y : "") + ' <i class="fa-solid fa-caret-down"></i>';
      body.querySelector("#lwhNext").disabled = month.y === cur.y && month.m === cur.m;
      var sum = body.querySelector("#lwhSum");
      sum.innerHTML = '<span>In ' + esc(short(tin)) + '</span><span>Out ' + esc(short(tout)) + '</span>';
      var rows = inP.filter(function (e) {
        var amt = Number(e.amount_kobo);
        if (filter === "in" && amt <= 0) return false; if (filter === "out" && amt >= 0) return false;
        if (filter === "transfer" && !/^transfer_/.test(e.kind)) return false; if (filter === "refund" && !/^refund_/.test(e.kind)) return false;
        if (["order_payment", "withdrawal", "topup", "earnings_in"].indexOf(filter) > -1 && e.kind !== filter) return false;
        if (status !== "all") { var ws = e.kind === "withdrawal" ? String(e.withdrawal_status || "success") : "success"; var g = /requested|processing|pending/.test(ws) ? "wait" : /failed|reversed|rejected/.test(ws) ? "bad" : "ok"; if (g !== status) return false; }
        if (!term) return true;
        return (entryTitle(e) + " " + (e.note || "") + " " + (e.counterparty_name || "") + " " + (e.bank_name || "")).toLowerCase().indexOf(term) > -1;
      });
      var host = body.querySelector("#lwhList");
      host.innerHTML = rows.length ? render(rows) : '<div class="lvw-empty"><i class="fa-solid fa-receipt"></i><strong>' + (term || filter !== "all" ? "Nothing found" : "No transactions this month") + '</strong></div>';
    }
    function render(rows) {
      var banks = rows.filter(function (e) { return e.kind === "withdrawal" && e.bank_name; }).slice().reverse(), firstBank = banks.length ? banks[0].bank_name + banks[0].account_last4 : null;
    var h = "", day = "", seenBank = firstBank;
    rows.slice().reverse().forEach(function (e) { if (e.kind === "withdrawal" && e.bank_name) { var b = e.bank_name + e.account_last4; if (b !== seenBank) { e.__newBank = true; seenBank = b; } } });
    rows.forEach(function (e) {
      var dt = new Date(e.created_at), label = dt.toDateString() === new Date().toDateString() ? "Today" : dt.toDateString() === new Date(Date.now() - 864e5).toDateString() ? "Yesterday" : dt.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
      if (label !== day) { h += (day ? "</ul>" : "") + '<div class="lw-day">' + label + '</div><ul class="lw-list">'; day = label; }
      if (e.__newBank) h += '<li class="lw-bankhead"><i class="fa-solid fa-building-columns"></i> New payout bank: <b>' + esc(e.bank_name) + " ···" + esc(e.account_last4 || "") + "</b></li>";
      var k = KIND[e.kind] || ["Wallet", "fa-wallet", "in"], amt = Number(e.amount_kobo), st = e.kind === "withdrawal" ? e.withdrawal_status : "";
      var cls = st === "requested" || st === "processing" ? "wait" : k[2];
      (window.__lvHist = window.__lvHist || {})[e.id] = e;
      h += '<li data-eid="' + esc(e.id) + '" tabindex="0" style="cursor:pointer"><span class="lw-ico ' + cls + '"><i class="fa-solid ' + k[1] + '"></i></span><div class="lw-li"><strong>' + esc(entryTitle(e)) + '</strong><small>' + dt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) +
        (e.kind === "withdrawal" && e.bank_name ? " · " + esc(e.bank_name) + " ···" + esc(e.account_last4 || "") : "") + (st ? " · " + ({ requested: "Waiting for Levromart's check", processing: "On its way", success: "Sent", failed: "Not sent", reversed: "Returned", rejected: "Not approved" }[st] || st) : "") +
        (e.note && e.kind !== "order_payment" && e.kind !== "withdrawal" ? " · " + esc(e.note) : "") + '</small></div><b class="lw-amt ' + (amt > 0 ? "in" : cls === "wait" ? "wait" : "out") + '">' + (amt > 0 ? "+" : "−") + short(Math.abs(amt)) + "</b></li>";
    });
      return '<div class="lw-hist">' + h + "</ul></div>";
    }
    body.querySelector("#lwhType").onchange = function () { filter = this.value; paint(); };
    body.querySelector("#lwhStatus").onchange = function () { status = this.value; paint(); };
    body.querySelector("#lwhSearchBtn").onclick = function () { var f = body.querySelector(".lwh-search"); f.hidden = !f.hidden; if (!f.hidden) f.focus(); };
    body.querySelector("#lwhAnalysis").onclick = function () { if (window.lvWalletAnalysis) window.lvWalletAnalysis(all, month); };
    body.querySelector(".lwh-chips").onclick = function (e) { var b = e.target.closest("[data-f]"); if (!b) return; filter = b.dataset.f; body.querySelectorAll(".lwh-chips button").forEach(function (x) { x.classList.toggle("on", x === b); }); paint(); };
    body.querySelector("#lwhPrev").onclick = function () { day = null; month = month.m === 0 ? { y: month.y - 1, m: 11 } : { y: month.y, m: month.m - 1 }; paint(); };
    body.querySelector("#lwhNext").onclick = function () { if (month.y === cur.y && month.m === cur.m) return; day = null; month = month.m === 11 ? { y: month.y + 1, m: 0 } : { y: month.y, m: month.m + 1 }; paint(); };
    body.querySelector("#lwhMonth").onclick = async function () {
      var minY = all.reduce(function (a, e) { return Math.min(a, new Date(e.created_at).getFullYear()); }, cur.y);
      var pick = await window.lvPickDate({ y: month.y, m: month.m, d: day, minYear: minY, marks: function (yy, mm) { var o = {}; all.forEach(function (e) { var t = new Date(e.created_at); if (t.getFullYear() === yy && t.getMonth() === mm) o[t.getDate()] = true; }); return o; } });
      if (pick) { month = { y: pick.y, m: pick.m }; day = pick.d; paint(); }
    };
    body.querySelector(".lwh-search").oninput = function () { term = this.value.trim().toLowerCase(); paint(); };
    body.addEventListener("click", function (ev) { var li = ev.target.closest("li[data-eid]"); if (!li) return; var e = (window.__lvHist || {})[li.getAttribute("data-eid")]; if (e && window.lvTxPage) window.lvTxPage({ entry: e, detail: true }); });
    paint();
  };

  // paying for an order: choose the wallet (no fee) or Paystack
  window.lvW3ChoosePay = async function (orderId, total, paystackGo, totalP) {
    var d = W.data;   // open at once from the last known wallet; the server re-checks the balance when paying
    if (!d) {
      // nothing known yet: show the choice straight away (Paystack works now), and add the wallet when its balance arrives
      var q = sheet("How do you want to pay?", '<p class="lw-hint" id="lwQuickHint">Checking your wallet…</p><button type="button" class="lw-pay" id="lwPayCard"><span class="lw-pay-ic p"><i class="fa-solid fa-credit-card"></i></span><div><b>Card, bank transfer or USSD</b><small>Through Paystack</small></div><i class="fa-solid fa-chevron-right"></i></button>');
      q.querySelector("#lwPayCard").onclick = function () { closeSheet(); paystackGo(); };
      d = await load(false);
      if (!document.getElementById("lvW3Sheet")) return;   // closed meanwhile
      if (!d || d.frozen) { var h = q.querySelector("#lwQuickHint"); if (h) h.remove(); return; }
    } else if (W.data) load(true).catch(function () {});
    var bal = Number(d.balance_kobo), need = Math.round(Number(total || 0) * 100), enough = need > 0 ? bal >= need : bal > 0;
    var m = sheet("How do you want to pay?", '<button type="button" class="lw-pay" id="lwPayWallet"' + (enough ? "" : " disabled") + '><span class="lw-pay-ic w"><i class="fa-solid fa-wallet"></i></span><div><b>Levromart wallet</b><small>Balance ' + money(bal, true) + (enough ? "" : " · not enough") + (typeof d.free_order_payments_left === "number" && d.free_order_payments_left > 0 ? " · " + d.free_order_payments_left + " free payment" + (d.free_order_payments_left === 1 ? "" : "s") + " left" : "") + '</small></div><i class="fa-solid fa-chevron-right"></i></button>' +
      (enough ? "" : '<button type="button" class="lw-link" onclick="lvW3Add()"><i class="fa-solid fa-plus"></i> Add money to your wallet</button>') +
      '<button type="button" class="lw-pay" id="lwPayCard"><span class="lw-pay-ic p"><i class="fa-solid fa-credit-card"></i></span><div><b>Card, bank transfer or USSD</b><small>Through Paystack</small></div><i class="fa-solid fa-chevron-right"></i></button>' +
      '<p class="lw-err" hidden></p><p class="lv-safe-pill"><span class="lv-safe-ic">' + shieldSvg(22) + '</span> All payments are secured by Paystack.</p>');
    m.querySelector("#lwPayCard").onclick = function () { closeSheet(); paystackGo(); };
    var wb = m.querySelector("#lwPayWallet");
    if (totalP && !need) totalP.then(function (r) {
      var t = r && r.data && r.data.total_amount; if (t == null) return;
      need = Math.round(Number(t) * 100); if (bal < need && wb) { wb.disabled = true; var sm = wb.querySelector("small"); if (sm && sm.textContent.indexOf("not enough") < 0) sm.textContent += " · not enough"; }
    });
    wb.onclick = async function () {
      if (wb.disabled) return;
      var fee = (typeof d.free_order_payments_left === "number" && d.free_order_payments_left > 0) ? 0 : (need ? window.lvWalletFee(need) : 0);   // the first 3 orders paid from the wallet are free
      if (need && need + fee > bal) return err(m, "Your wallet balance does not cover this order and its transfer charges. Please add money or pay another way.");
      var pin = await window.lvPinGate({ title: "Pay with wallet", rows: [["Order", short(need), 1]].concat(fee > 0 ? [["Transfer fee", short(fee) + " · charged separately after paying"]] : []), cta: "Pay " + short(need) });
      if (!pin) return;
      if (!(await showConfirmDialog("Pay " + short(need) + " for this order from your Levromart wallet?", { title: "Pay for this order", okLabel: "Yes, pay", cancelLabel: "No, go back" }))) return;
      wb.disabled = true;
      var r = await sb.rpc("wallet_pay_order", { p_order_id: orderId, p_pin: pin });
      if (r.error) { wb.disabled = false; return err(m, r.error.message || "Could not pay."); }
      bumpBal(-(need + fee)); closeSheet(); repaint(); load(true).then(repaint);
      try { navigate("orderDetail", { orderId: orderId }); } catch (_) {}
      try { window.lvTxPage({ kind: "order", title: "Payment successful", amountKobo: need, feeKobo: fee, orderId: orderId, via: "Levromart wallet" }); } catch (_) { showToast("Paid from your wallet. Thank you!", "success"); }
    };
  };

  // notifications can point at the wallet
  var nav0 = window.navigate;
  if (typeof nav0 === "function" && !nav0.__lw) {
    var nav1 = function (view) {
      if (view === "levroWallet") { var to = typeof vendor !== "undefined" && vendor ? "vendorOrders" : "buyerProfile"; return nav0.call(this, "walletHistory"); }
      return nav0.apply(this, arguments);
    };
    nav1.__lw = true; window.navigate = nav1;
  }
  setInterval(function () { if (!document.hidden && document.querySelector(".lvw3")) load(true).then(repaint); }, 30000);
})();

/* ===== Admin: wallets and commission (on the Payments page) =====
   Wallet withdrawals waiting for a check (approve / reject with a reason), the money held in all wallets, any wallet found by
   @tag or name (put on hold / release), and Levromart's commission by period. */
(function () {
  "use strict";
  function naira(k) { try { return "₦" + (Number(k || 0) / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 }); } catch (_) { return "₦" + k; } }
  function when(t) { try { return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + ", " + new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }); } catch (_) { return ""; } }
  var q = "", range = "30";
  async function commissionHtml() {
    var days = { today: 1, "7": 7, "30": 30, all: 3650 }[range] || 30;
    var since = new Date(Date.now() - days * 864e5); if (range === "today") { since = new Date(); since.setHours(0, 0, 0, 0); }
    var r = await sb.from("commission_charges").select("amount,status,paid_at,payment_id,created_at").neq("status", "waived").gte("created_at", since.toISOString()).limit(5000);
    var rows = (r && r.data) || [];
    var held = rows.filter(function (c) { return c.status === "paid" && c.payment_id; }).reduce(function (s, c) { return s + Number(c.amount || 0); }, 0);
    var owed = rows.filter(function (c) { return c.status === "owed"; }).reduce(function (s, c) { return s + Number(c.amount || 0); }, 0);
    var byDay = {}; rows.forEach(function (c) { if (c.status === "paid" && c.payment_id) { var d = new Date(c.paid_at || c.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" }); byDay[d] = (byDay[d] || 0) + Number(c.amount || 0); } });
    var days7 = Object.keys(byDay).slice(-7);
    return '<div class="aw-card"><div class="aw-h"><b><i class="fa-solid fa-percent"></i> Levromart commission</b><div class="aw-range">' + [["today", "Today"], ["7", "7 days"], ["30", "30 days"], ["all", "All"]].map(function (x) { return '<button type="button" class="' + (x[0] === range ? "on" : "") + '" onclick="lvAwRange(\'' + x[0] + '\')">' + x[1] + "</button>"; }).join("") + "</div></div>" +
      '<div class="aw-tiles"><div><small>Earned and held in Paystack</small><b>' + naira(held * 100) + '</b><span>Yours to withdraw from the Paystack balance</span></div><div><small>Still owed by shops</small><b>' + naira(owed * 100) + "</b><span>Sales not paid through Levromart</span></div></div>" +
      (days7.length ? '<div class="aw-days">' + days7.map(function (d) { return '<div><small>' + d + "</small><b>" + naira(byDay[d] * 100) + "</b></div>"; }).join("") + "</div>" : "") + "</div>";
  }
  var AWD = null;
  async function loadWallets() { var r = await sb.rpc("admin_wallets", { p_query: q || null }); AWD = (r.error || !r.data) ? null : r.data; return AWD; }
  function waitingHtml() {
    var d = AWD; if (!d) return "";
    var waiting = (d.withdrawals || []).filter(function (x) { return x.status === "requested"; });
    return '<div class="aw-card"><div class="aw-h"><b><i class="fa-solid fa-user-clock"></i> Wallet withdrawals to check (' + waiting.length + ')</b></div>' +
      (waiting.length ? waiting.map(function (x) {
        return '<div class="aw-row"><div><b>' + naira(x.amount_kobo) + ' · @' + esc(x.handle || "") + '</b><small>' + esc(x.name || "") + " · " + esc(when(x.created_at)) + '</small><small class="aw-why"><i class="fa-solid fa-shield-halved"></i> ' + esc(x.review_reason || "Needs a check") + '</small></div>' +
          '<div class="aw-acts"><button class="btn btn-sm" onclick="lvAwDecide(\'' + esc(x.id) + '\',\'approve\')">Approve</button><button class="btn btn-sm btn-danger" onclick="lvAwDecide(\'' + esc(x.id) + '\',\'reject\')">Reject</button></div></div>';
      }).join("") : '<p class="aw-note"><i class="fa-solid fa-circle-check"></i> No wallet withdrawal is waiting.</p>') + "</div>";
  }
  function walletsHtml() {
    var d = AWD;
    if (!d) return '<div class="aw-card aw-off"><b><i class="fa-solid fa-wallet"></i> Wallets</b><p>Not switched on yet. Your engineer needs to apply migration 0033 and redeploy the backend.</p></div>';
    return '<div class="aw-card"><div class="aw-h"><b><i class="fa-solid fa-wallet"></i> People\'s wallets</b><span class="aw-held">Held for people: <b>' + naira(d.held_kobo) + "</b></span></div>" +
      '<p class="aw-note">This money belongs to people\'s wallets and must always stay in the Paystack balance.</p>' +
      '<input class="aw-search" placeholder="Find a wallet: @tag or name" value="' + esc(q) + '" onkeydown="if(event.key===\'Enter\')lvAwSearch(this.value)">' +
      '<p class="aw-note aw-count">' + (q ? "Wallets matching “" + esc(q) + "”" : "Wallets with money, biggest first") + " · " + (d.wallets || []).length + "</p>" +
      (d.wallets && d.wallets.length ? "" : '<p class="aw-note">' + (q ? "No wallet matches." : "No wallet holds money right now.") + "</p>") +
      (d.wallets || []).slice(0, 60).map(function (x) {
        var h = 0, nm = String(x.name || x.handle || "?"); for (var k = 0; k < nm.length; k++) h = (h * 31 + nm.charCodeAt(k)) % 360;
        var ini = nm.trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0] || ""; }).join("").toUpperCase();
        return '<div class="aw-row aw-wrow"><span class="aw-av" style="background:linear-gradient(135deg,hsl(' + h + ',62%,52%),hsl(' + ((h + 38) % 360) + ',64%,36%))">' + esc(ini) + '</span><div class="aw-wm"><b>' + esc(x.name || "@" + x.handle) + '</b><small>@' + esc(x.handle) + " · " + esc(x.role || "") + (x.frozen ? ' · <span class="aw-hold">On hold' + (x.frozen_reason ? ": " + esc(x.frozen_reason) : "") + "</span>" : "") + '</small></div><div class="aw-wb"><b>' + naira(x.balance_kobo) + '</b><div class="aw-acts">' + (x.frozen ? '<button class="btn btn-sm" onclick="lvAwFreeze(\'' + esc(x.user_id) + '\',false)">Release</button>' : '<button class="btn btn-sm btn-danger" onclick="lvAwFreeze(\'' + esc(x.user_id) + '\',true)">Hold</button>') + "</div></div></div>";
      }).join("") + "</div>";
  }
  /* ---- Levromart's own wallet: the commission, withdrawn to Levromart's bank with the super admin's password (migration 0035) */
  var LW = null;
  function dayKey(t) { var d = new Date(t); return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate(); }
  function dayLabel(t) {
    var d = new Date(t), now = new Date(), y = new Date(); y.setDate(now.getDate() - 1);
    if (dayKey(d) === dayKey(now)) return "Today"; if (dayKey(d) === dayKey(y)) return "Yesterday";
    return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
  }
  function hm(t) { try { return new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }); } catch (_) { return ""; } }
  function entryRow(e) {
    var k = Number(e.amount_kobo), plus = k > 0, ic, cls, title, sub = hm(e.created_at);
    if (e.kind === "commission") { ic = "fa-percent"; cls = "in"; title = e.shop_name ? "Commission · " + e.shop_name : (e.note || "Commission"); if (e.order_id) sub += " · Order #" + String(e.order_id).slice(0, 8).toUpperCase(); }
    else if (e.kind === "commission_reversed") { ic = "fa-rotate-left"; cls = "back"; title = "Commission taken back" + (e.shop_name ? " · " + e.shop_name : ""); }
    else if (e.kind === "transaction_fee" || e.kind === "transaction_fee_return") { ic = "fa-receipt"; cls = e.kind === "transaction_fee" ? "in" : "back"; title = e.kind === "transaction_fee" ? (e.note || "Transaction fee") : "Fee given back"; sub += " · wallet payments, transfers and withdrawals"; }
    else if (e.kind === "listing_fee") { ic = "fa-calendar-check"; cls = "in"; title = "Monthly listing fee" + (e.shop_name ? " · " + e.shop_name : ""); sub += " · after Paystack's fee"; }
    else if (e.kind === "withdrawal") { ic = "fa-building-columns"; cls = e.withdrawal_status === "success" ? "out" : e.withdrawal_status === "failed" || e.withdrawal_status === "reversed" ? "fail" : "wait"; title = "Withdrawal"; sub += " · " + (e.bank_name || "Bank") + " ···" + (e.account_last4 || "") + " · " + ({ success: "Sent", processing: "On its way", failed: "Not sent", reversed: "Returned" }[e.withdrawal_status] || ""); }
    else { ic = "fa-arrow-rotate-left"; cls = "back"; title = "Withdrawal returned"; }
    var three = { commission: "chart", commission_reversed: "order-cancelled", transaction_fee: "bars", transaction_fee_return: "moved-up", listing_fee: "monthly-listing", withdrawal: cls === "fail" ? "withdrawal-rejected" : cls === "wait" ? "tx-pending" : "payout-sent", withdrawal_return: "withdrawal-rejected" }[e.kind] || "tx-all";
    return '<div class="lwa-row" role="button" tabindex="0" data-eid="' + esc(e.id) + '" data-e3d="' + three + '" aria-label="' + esc(title) + ', details"><span class="lwa-ic lwa-ic3d ' + cls + '">' + (window.lv3dIcon ? window.lv3dIcon(three, 30) : '<i class="fa-solid ' + ic + '"></i>') + '</span><div class="lwa-mid"><b>' + esc(title) + '</b><small>' + esc(sub) + '</small></div><span class="lwa-amt ' + cls + '">' + (plus ? "+" : "−") + naira(Math.abs(k)) + "</span></div>";
  }
  var lwAll = false, lwTab = "all";
  var LW_KINDS = { commission: ["commission", "commission_reversed"], listing: ["listing_fee"], fees: ["transaction_fee", "transaction_fee_return"], withdrawals: ["withdrawal", "withdrawal_return"] };
  window.lvLwMore = function () { lwAll = true; paint(); };
  window.lvLwTab = function (t) { lwTab = t; lwAll = false; paint(); };
  function historyHtml(full) {
    if (lwTab !== "all") full = full.filter(function (e) { return LW_KINDS[lwTab].indexOf(e.kind) >= 0; });
    var out = "", day = "", lastBank = null, list = lwAll ? full : full.slice(0, 10);
    // the bank of each withdrawal, oldest first, to mark where a new payout bank starts
    var newBankAt = {};
    full.slice().reverse().forEach(function (e) { if (e.kind === "withdrawal" && e.recipient_code) { if (lastBank && lastBank !== e.recipient_code) newBankAt[e.id] = true; lastBank = e.recipient_code; } });
    list.forEach(function (e) {
      var k = dayKey(e.created_at);
      if (k !== day) { day = k; out += '<div class="lwa-day">' + esc(dayLabel(e.created_at)) + "</div>"; }
      if (newBankAt[e.id]) out += '<div class="lwa-bank"><i class="fa-solid fa-building-columns"></i> New payout bank: ' + esc(e.bank_name || "") + " ···" + esc(e.account_last4 || "") + "</div>";
      out += entryRow(e);
    });
    if (!lwAll && full.length > list.length) out += '<button type="button" class="lwa-more" onclick="lvLwMore()">Show all ' + full.length + " lines</button>";
    return out || '<p class="aw-note">Nothing here yet.</p>';
  }
  async function levromartWalletHtml() {
    var r = await sb.rpc("get_levromart_wallet");
    if (r.error || !r.data) return null;
    var d = LW = r.data, a = d.account, c = d.commission || {}, lf = d.listing_fees || null;
    var wait = a && a.wait_hours > 0;
    return '<div class="aw-card lwa"><div class="lwa-card">' +
      '<div class="lwa-top"><div><small>' + (lf ? "Levromart's money · available" : "Levromart commission · available") + '</small><b class="lwa-bal">' + naira(d.balance_kobo) + '</b></div>' +
        (d.can_manage ? '<button type="button" class="lwa-wd" onclick="lvLwWithdraw()"><i class="fa-solid fa-building-columns"></i> Withdraw</button>' : "") + "</div>" +
      '<div class="lwa-bankrow"><i class="fa-solid fa-building-columns"></i><span>' + (a ? esc(a.bank_name || "") + " ···" + esc(a.last4) + " · " + esc(a.account_name) : "No payout account yet") + "</span>" +
        (d.can_manage ? '<button type="button" onclick="lvLwAccount()">' + (a ? "Change" : "Add") + "</button>" : "") + "</div>" +
      (wait ? '<div class="lwa-wait"><i class="fa-solid fa-shield-halved"></i> New payout account: withdrawals open in ' + a.wait_hours + " hour" + (a.wait_hours === 1 ? "" : "s") + ".</div>" : "") +
      '<div class="lwa-src">' +
        '<div role="button" tabindex="0" onclick="lvAwOpen(\'commission\')"><small>3% commission <i class="fa-solid fa-chevron-right"></i></small><b>' + naira(c.all_kobo) + '</b><em>Today ' + naira(c.today_kobo) + '</em></div>' +
        (lf ? '<div role="button" tabindex="0" onclick="lvAwOpen(\'listing\')"><small>Monthly listing fees <i class="fa-solid fa-chevron-right"></i></small><b>' + naira(lf.all_kobo) + '</b><em>Today ' + naira(lf.today_kobo) + '</em></div>' : "") +
        (d.transaction_fees ? '<div role="button" tabindex="0" onclick="lvAwOpen(\'fees\')"><small>Transaction fees <i class="fa-solid fa-chevron-right"></i></small><b>' + naira(d.transaction_fees.all_kobo) + '</b><em>Today ' + naira(d.transaction_fees.today_kobo) + '</em></div>' : "") +
      '</div>' +
      '<button type="button" class="lwa-strip" onclick="navigate(\'adminWalletHistory\')"><span class="lwa-strip-ic">' + (window.lv3dIcon ? window.lv3dIcon("tx-all", 22) : '<i class="fa-solid fa-clock-rotate-left"></i>') + '</span><span class="lwa-strip-t">Transaction history</span>' +
        ((d.entries || [])[0] ? '<span class="lwa-strip-last">' + esc(String(((d.entries || [])[0].kind || "").replace(/_/g, " "))) + ' <b>' + (Number((d.entries || [])[0].amount_kobo) > 0 ? "+" : "−") + naira(Math.abs(Number((d.entries || [])[0].amount_kobo))) + '</b></span>' : "") + '<i class="fa-solid fa-chevron-right"></i></button>' +
      "</div>" +
      (d.can_manage ? "" : '<p class="aw-note"><i class="fa-solid fa-lock"></i> Only the super admin can withdraw or change the payout account.</p>') + '</div>';
  }
  function pwSheet(title, text, okLabel) {
    return new Promise(function (resolve) {
      var m = document.createElement("div");
      m.className = "lvw-sheet-wrap lw-wrap"; m.id = "lvLwPw";
      m.innerHTML = '<div class="lvw-sheet lw-sheet" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><div class="lvw-sheet-grab" aria-hidden="true"></div><div class="lvw-sheet-head"><h3>' + esc(title) + '</h3><button type="button" class="lvw-eye lvw-eye-dark" data-x aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div><div class="lvw-sheet-body">' +
        '<p class="lw-hint">' + esc(text) + '</p><label class="lwa-pwlabel" for="lvLwPwIn">Your password</label><input id="lvLwPwIn" class="lwa-pw" type="password" autocomplete="current-password" placeholder="Enter your password">' +
        '<p class="lw-err" hidden></p><button type="button" class="btn lw-go" data-ok>' + esc(okLabel) + "</button></div></div>";
      document.body.appendChild(m);
      var input = m.querySelector("#lvLwPwIn");
      function done(v) { m.remove(); resolve(v); }
      m.addEventListener("click", function (e) { if (e.target === m || (e.target.closest && e.target.closest("[data-x]"))) done(null); });
      m.querySelector("[data-ok]").onclick = function () { if (!input.value) { var er = m.querySelector(".lw-err"); er.textContent = "Enter your password."; er.hidden = false; return; } done(input.value); };
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") m.querySelector("[data-ok]").click(); });
      setTimeout(function () { try { input.focus(); } catch (_) {} }, 60);
    });
  }
  window.lvLwWithdraw = async function () {
    var d = LW;
    if (!d) return;
    if (!d.account) return showToast("Add Levromart's bank account first (tap Add next to the bank line).", "info");
    if (Number(d.balance_kobo) < Number(d.min_withdrawal_kobo || 0)) return showToast("Levromart's wallet has " + naira(d.balance_kobo) + ". The bank cannot send less than " + naira(d.min_withdrawal_kobo) + " at a time.", "info");
    var raw = await showTextPromptDialog("Withdraw commission", "How much? Levromart's wallet has " + naira(d.balance_kobo) + ". It goes to " + (d.account.bank_name || "") + " ···" + d.account.last4 + ".", { okLabel: "Next", placeholder: "Amount in naira, up to " + (Number(d.balance_kobo) / 100).toLocaleString("en-NG") });
    if (!raw) return;
    var kobo = Math.round(Number(String(raw).replace(/[,\s₦]/g, "")) * 100);
    if (!(kobo > 0)) return showToast("Enter an amount.", "error");
    var pw = await pwSheet("Confirm it's you", "Type your password to send " + naira(kobo) + " to " + (d.account.bank_name || "") + " ···" + d.account.last4 + ".", "Withdraw " + naira(kobo));
    if (!pw) return;
    var r = await sb.rpc("withdraw_levromart_commission", { p_amount_kobo: kobo, p_password: pw });
    if (r.error) return showToast(r.error.message || "Could not withdraw.", "error");
    showToast(r.data && r.data.status === "sent" ? "Sent to the bank." : "On its way to the bank.", "success"); paint();
  };
  window.lvLwAccount = async function () {
    var list = [];
    try { var bk = await window.levroData.payments.banks(); list = (bk && Array.isArray(bk.data) && bk.data) || []; } catch (_) {}
    if (!list.length && typeof NIGERIAN_BANKS !== "undefined") list = NIGERIAN_BANKS;
    list = list.slice().sort(function (x, y) { return String(x.name).localeCompare(String(y.name)); });
    var m = document.createElement("div");
    m.className = "lvw-sheet-wrap lw-wrap"; m.id = "lvLwAcct";
    m.innerHTML = '<div class="lvw-sheet lw-sheet" role="dialog" aria-modal="true" aria-label="Levromart payout account"><div class="lvw-sheet-grab" aria-hidden="true"></div><div class="lvw-sheet-head"><h3>Levromart payout account</h3><button type="button" class="lvw-eye lvw-eye-dark" data-x aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div><div class="lvw-sheet-body">' +
      '<p class="lw-hint">Levromart\'s commission is withdrawn to this account. Every admin is told when it changes. Each withdrawal needs your password.</p>' +
      '<select class="lwa-pw" id="lvLwBank"><option value="">Choose the bank</option>' + list.map(function (b) { return '<option value="' + esc(b.code) + '">' + esc(b.name) + "</option>"; }).join("") + "</select>" +
      '<input class="lwa-pw" id="lvLwNum" inputmode="numeric" maxlength="10" placeholder="10-digit account number">' +
      '<div class="lwa-found" hidden></div><p class="lw-err" hidden></p><button type="button" class="btn lw-go" data-ok>Check account</button></div></div>';
    document.body.appendChild(m);
    var found = null, er = m.querySelector(".lw-err"), go = m.querySelector("[data-ok]"), box = m.querySelector(".lwa-found");
    function say(t) { er.textContent = t || ""; er.hidden = !t; }
    function reset() { found = null; box.hidden = true; go.textContent = "Check account"; say(""); }
    m.querySelector("#lvLwBank").onchange = reset; m.querySelector("#lvLwNum").oninput = reset;
    m.addEventListener("click", function (e) { if (e.target === m || (e.target.closest && e.target.closest("[data-x]"))) m.remove(); });
    go.onclick = async function () {
      var code = m.querySelector("#lvLwBank").value, num = m.querySelector("#lvLwNum").value.trim();
      if (!code) return say("Choose the bank.");
      if (!/^\d{10}$/.test(num)) return say("Enter the 10-digit account number.");
      say(""); go.disabled = true;
      try {
        if (!found) {
          var r = await window.levroData.payments.resolveAccount(code, num);
          if (r.error || !r.data) return say((r.error && r.error.message) || "We could not find that account.");
          found = r.data; box.hidden = false;
          box.innerHTML = "<b>" + esc(found.accountName) + "</b><span>" + esc(found.bankName || "") + " · ···" + esc(found.accountLast4 || num.slice(-4)) + "</span>";
          go.textContent = "Yes, save this account"; return;
        }
        var pw = await pwSheet("Confirm it's you", "Type your password to make this Levromart's payout account.", "Save account");
        if (!pw) return;
        var s = await sb.rpc("set_levromart_payout_account", { p_bank_code: code, p_account_number: num, p_confirmed_name: found.accountName, p_password: pw });
        if (s.error) return say(s.error.message || "Could not save.");
        m.remove(); showToast("Saved.", "success"); paint();
      } finally { go.disabled = false; }
    };
  };

  // The last good wallet card is kept and shown at once, so the page never blanks while it reloads, and a failed
  // reload (slow server, one bad answer) keeps showing it instead of making the wallet disappear.
  var LAST_OWN = "", LAST_WL = "", LAST_WT = "", retryT = 0;
  async function paint(tries) {
    var box = document.getElementById("lvAwBox");
    if (!box) { if ((tries || 0) < 60) setTimeout(function () { paint((tries || 0) + 1); }, 50); return; }   // wait for the page to be on screen
    var res = await Promise.all([levromartWalletHtml().catch(function () { return null; }), loadWallets().catch(function () { return null; })]);
    var own = res[0];
    var earn = document.getElementById("lvAwBox"), wl = document.getElementById("lvAwWallets"), wt = document.getElementById("lvAwWaiting");
    if (own) LAST_OWN = own;
    if (earn) earn.innerHTML = own || LAST_OWN || "";
    if (earn && !own && !LAST_OWN) commissionHtml().then(function (h) { var e = document.getElementById("lvAwBox"); if (e && !LAST_OWN) e.innerHTML = h; }).catch(function () {});
    if (!own) { clearTimeout(retryT); retryT = setTimeout(function () { if (document.getElementById("lvAwBox")) paint(); }, 4000); }
    if (res[1] !== null || !LAST_WL) { LAST_WL = walletsHtml(); LAST_WT = waitingHtml(); }
    if (wl) wl.innerHTML = LAST_WL;
    if (wt) wt.innerHTML = LAST_WT;
    var n = AWD ? (AWD.withdrawals || []).filter(function (x) { return x.status === "requested"; }).length : 0;
    var nMain = n + Number(window.__lvPayPending || 0), nHold = AWD ? (AWD.wallets || []).filter(function (x) { return x.frozen; }).length : 0;
    var b1 = document.getElementById("lvApxBadgeMain"); if (b1) { b1.textContent = nMain > 9 ? "9+" : String(nMain); b1.hidden = !nMain; }
    var b2 = document.getElementById("lvApxBadgeWallets"); if (b2) { b2.textContent = nHold > 9 ? "9+" : String(nHold); b2.hidden = !nHold; b2.className = "apx-badge apx-badge-amber"; }
  }
  var apxTab = "main";
  window.lvApxTab = function (t) {
    apxTab = t;
    document.querySelectorAll("#lvApxTabs button").forEach(function (b) { b.classList.toggle("on", b.dataset.t === t); });
    document.querySelectorAll(".apx-panel").forEach(function (p) { p.hidden = p.dataset.p !== t; });
  };
  // Levromart's transaction history: a page of its own, by month, with a tab for each kind of money
  window.renderAdminWalletHistory = async function () {
    var nav = typeof adminNavHtml === "function" ? adminNavHtml("adminPayments") : "";
    // wait until the page is really on screen before filling it (a fixed 30 ms wait sometimes ran too early and left "Loading…" forever)
    var tries = 0; (function wait() { if (document.getElementById("lvAwHist")) { loadHistoryPage(); return; } if (++tries < 60) setTimeout(wait, 50); })();
    return nav + '<div class="lvw-page"><div class="lvw-page-head"><button type="button" class="lvw-back" onclick="navigate(\'adminPayments\')" aria-label="Back"><i class="fa-solid fa-arrow-left"></i></button><h2>Transaction history</h2></div><div id="lvAwHist"><p class="muted" style="text-align:center;padding:1.5rem 0">Loading…</p></div></div>';
  };
  async function loadHistoryPage() {
    var host = document.getElementById("lvAwHist"); if (!host) return;
    try { await loadHistoryPageInner(host); }
    catch (err) { host.innerHTML = '<p class="aw-note" style="text-align:center;padding:1.2rem 0">Could not load the transaction history.<br><small style="opacity:.7">' + esc(String((err && err.message) || err || "").slice(0, 160)) + '</small><br><button type="button" class="btn btn-sm" style="margin-top:.7rem" onclick="navigate(\'adminWalletHistory\')">Try again</button></p>'; try { console.error("wallet history", err); } catch (_) {} }
  }
  async function loadHistoryPageInner(host) {
    var r = await sb.rpc("get_levromart_wallet");
    if (r.error || !r.data) { host.innerHTML = '<p class="aw-note">Levromart\'s wallet is not switched on yet.</p>'; return; }
    var all = (r.data.entries || []).slice(), lastBatch = all.length;
    // the server answers {entries:[...]} (older versions answered a bare list): accept both
    var asList = function (d) { return Array.isArray(d) ? d : ((d && Array.isArray(d.entries)) ? d.entries : []); };
    for (var pg = 0; pg < 40 && lastBatch >= 50; pg++) {
      var more = await sb.rpc("get_levromart_wallet_history", { p_before: all[all.length - 1].created_at });
      if (more && more.error) break;   // show what we have rather than nothing
      var have = {}; all.forEach(function (e) { have[e.id] = 1; });
      var next = asList(more && more.data).filter(function (e) { return !have[e.id]; });
      lastBatch = next.length;
      if (!next.length) break; all = all.concat(next);
    }
    var now = new Date(), cur = { y: now.getFullYear(), m: now.getMonth() }, month = { y: cur.y, m: cur.m }, kind = (window.__lvAwKind && LW_KINDS[window.__lvAwKind]) ? window.__lvAwKind : "all", day = null; window.__lvAwKind = null;
    var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    host.innerHTML = '<div class="lwh-monthbar"><button type="button" id="lvAhPrev" aria-label="Previous month"><i class="fa-solid fa-chevron-left"></i></button><button type="button" class="lwh-pick" id="lvAhMonth" aria-label="Pick a date"></button><button type="button" id="lvAhNext" aria-label="Next month"><i class="fa-solid fa-chevron-right"></i></button></div><div class="lwh-sum" id="lvAhSum"></div><div class="lwa-tabs">' + [["all", "All"], ["commission", "Commission"], ["listing", "Listing fees"], ["fees", "Transaction fees"], ["withdrawals", "Withdrawals"]].map(function (t) { return '<button type="button" data-k="' + t[0] + '" class="' + (t[0] === "all" ? "on" : "") + '">' + t[1] + "</button>"; }).join("") + '</div><div class="lwa-hist" id="lvAhList"></div>';
    function paintH() {
      var inM = all.filter(function (e) { var d = new Date(e.created_at); return d.getFullYear() === month.y && d.getMonth() === month.m && (!day || d.getDate() === day); });
      var tin = 0, tout = 0; inM.forEach(function (e) { var a = Number(e.amount_kobo); if (e.kind === "withdrawal" && (e.withdrawal_status === "failed" || e.withdrawal_status === "reversed")) return; if (a > 0) tin += a; else tout += -a; });
      host.querySelector("#lvAhMonth").innerHTML = (day ? day + " " : "") + MONTHS[month.m] + " " + month.y + ' <i class="fa-solid fa-chevron-down"></i>';
      host.querySelector("#lvAhNext").disabled = month.y === cur.y && month.m === cur.m;
      host.querySelector("#lvAhSum").innerHTML = '<div class="lwh-sum-c in"><small>Money in</small><b>' + naira(tin) + '</b></div><div class="lwh-sum-c out"><small>Money out</small><b>' + naira(tout) + "</b></div>";
      var rows = kind === "all" ? inM : inM.filter(function (e) { return LW_KINDS[kind].indexOf(e.kind) >= 0; });
      // how much was made: the chosen day, the month and the year (money that came in, for the kind chosen above)
      var kindRows = function (f) { return all.filter(function (e) { var d = new Date(e.created_at); return f(d) && Number(e.amount_kobo) > 0 && (kind === "all" || LW_KINDS[kind].indexOf(e.kind) >= 0); }); };
      var sumOf = function (list) { return list.reduce(function (a, e) { return a + Number(e.amount_kobo); }, 0); };
      var brk = host.querySelector("#lvAhBreak"); if (!brk) { brk = document.createElement("div"); brk.id = "lvAhBreak"; brk.className = "lwh-brk"; host.querySelector("#lvAhSum").insertAdjacentElement("afterend", brk); }
      var mRows = kindRows(function (d) { return d.getFullYear() === month.y && d.getMonth() === month.m; });
      brk.innerHTML = '<div class="lwh-brk-t">' + (kind === "all" ? "All income" : { commission: "3% commission", listing: "Monthly listing fees", fees: "Transaction fees" }[kind] || "Income") + ' made</div><div class="lwh-brk-g">' +
        (day ? '<div><small>' + day + " " + MONTHS[month.m].slice(0, 3) + '</small><b>' + naira(sumOf(kindRows(function (d) { return d.getFullYear() === month.y && d.getMonth() === month.m && d.getDate() === day; }))) + '</b></div>' : "") +
        '<div><small>' + MONTHS[month.m] + '</small><b>' + naira(sumOf(mRows)) + '</b></div><div><small>Year ' + month.y + '</small><b>' + naira(sumOf(kindRows(function (d) { return d.getFullYear() === month.y; }))) + '</b></div><div><small>All time</small><b>' + naira(sumOf(kindRows(function () { return true; }))) + '</b></div></div>';
      lwAll = true; var saveTab = lwTab; lwTab = "all";
      host.querySelector("#lvAhList").innerHTML = rows.length ? historyHtml(rows) : '<p class="aw-note" style="text-align:center;padding:1rem 0">Nothing this month.</p>';
      lwTab = saveTab;
    }
    host.querySelector("#lvAhPrev").onclick = function () { day = null; month = month.m === 0 ? { y: month.y - 1, m: 11 } : { y: month.y, m: month.m - 1 }; paintH(); };
    host.querySelector("#lvAhNext").onclick = function () { if (month.y === cur.y && month.m === cur.m) return; day = null; month = month.m === 11 ? { y: month.y + 1, m: 0 } : { y: month.y, m: month.m + 1 }; paintH(); };
    host.querySelector("#lvAhMonth").onclick = async function () {
      var minY = all.reduce(function (a, e) { return Math.min(a, new Date(e.created_at).getFullYear()); }, cur.y);
      var pick = await window.lvPickDate({ y: month.y, m: month.m, d: day, minYear: minY, marks: function (yy, mm) { var o = {}; all.forEach(function (e) { var t = new Date(e.created_at); if (t.getFullYear() === yy && t.getMonth() === mm) o[t.getDate()] = true; }); return o; } });
      if (pick) { month = { y: pick.y, m: pick.m }; day = pick.d; paintH(); }
    };
    host.querySelectorAll(".lwa-tabs button").forEach(function (x) { x.classList.toggle("on", x.dataset.k === kind); });
    host.querySelector(".lwa-tabs").onclick = function (e) { var b = e.target.closest("[data-k]"); if (!b) return; kind = b.dataset.k; host.querySelectorAll(".lwa-tabs button").forEach(function (x) { x.classList.toggle("on", x === b); }); paintH(); };
    paintH();
  }
  window.lvAwOpen = function (k) { window.__lvAwKind = k; navigate("adminWalletHistory"); };
  window.lvAwRange = function (r) { range = r; paint(); };
  window.lvAwSearch = function (v) { q = String(v || "").trim(); paint(); };
  window.lvAwDecide = async function (id, how) {
    var reason = null;
    if (how === "reject") { reason = await showTextPromptDialog("Reject withdrawal", "Why? The person will see this, and the money goes back into their wallet.", { okLabel: "Reject", required: true }); if (!reason) return; }
    else if (!(await showConfirmDialog("Send this money to their bank now?", { title: "Approve withdrawal", okLabel: "Approve", cancelLabel: "Go back" }))) return;
    var r = await sb.rpc("admin_decide_wallet_withdrawal", { p_id: id, p_decision: how, p_reason: reason });
    if (r.error) return showToast(r.error.message || "Could not save.", "error");
    showToast(how === "approve" ? "Approved. The money is being sent." : "Rejected. The money is back in their wallet.", "success"); paint();
  };
  window.lvAwFreeze = async function (userId, on) {
    var reason = null;
    if (on) { reason = await showTextPromptDialog("Put wallet on hold", "Why? Sending, withdrawing and adding money stop until you release it.", { okLabel: "Put on hold" }); if (!reason) return; }
    var r = await sb.rpc("admin_set_wallet_frozen", { p_user_id: userId, p_frozen: !!on, p_reason: reason });
    if (r.error) return showToast(r.error.message || "Could not save.", "error");
    showToast(on ? "Wallet put on hold." : "Wallet released.", "success"); paint();
  };
  var orig = window.renderAdminPayments;
  if (typeof orig === "function" && !orig.__aw) {
    // Levromart's own wallet comes first, then the payment lists
    var w = async function () {
      var html = String(await orig.apply(this, arguments)); setTimeout(function () { paint(); window.lvApxTab(apxTab); }, 0);
      var nav = typeof adminNavHtml === "function" ? adminNavHtml("adminPayments") : "";
      var rest = nav && html.indexOf(nav) === 0 ? html.slice(nav.length) : html;
      var tabs = '<div class="apx-tabs" id="lvApxTabs"><button type="button" data-t="main" class="on" onclick="lvApxTab(\'main\')">Levromart <i class="apx-badge" id="lvApxBadgeMain" hidden></i></button><button type="button" data-t="wallets" onclick="lvApxTab(\'wallets\')">People\'s wallets <i class="apx-badge" id="lvApxBadgeWallets" hidden></i></button></div>';
      var panels = '<div class="apx-panel" data-p="main"><div id="lvAwBox" class="aw-box">' + LAST_OWN + '</div><div id="lvAwWaiting" class="aw-box">' + LAST_WT + '</div>' + rest + '</div>' +
        '<div class="apx-panel" data-p="wallets" hidden><div id="lvAwWallets" class="aw-box">' + LAST_WL + '</div></div>';
      return nav + tabs + panels;
    };
    w.__aw = true; window.renderAdminPayments = w;
  }
})();

/* ===== Confirm pop-ups: a dangerous action (log out, delete, cancel an order…) is red and the way out ("Go back") is green;
   for an ordinary action the way out labelled "Cancel" stays red, as everywhere else. ===== */
(function () {
  "use strict";
  var orig = window.showConfirmDialog;
  if (typeof orig !== "function" || orig.__lvc) return;
  var w = function (message, opts) {
    var p = orig.apply(this, arguments);
    try {
      var o = opts || {}, cancel = document.getElementById("confirmModalCancel");
      if (cancel) {
        var danger = !!o.danger || /log ?out|delete|remove|cancel|reject|block|suspend|disable|discard/i.test(String(o.okLabel || ""));
        var ok = document.getElementById("confirmModalOk");
        if (ok && danger) ok.className = "btn btn-danger";
        cancel.classList.toggle("lv-safe", danger);
        if (danger) cancel.classList.remove("lv-cancel");
        if (!o.cancelLabel && danger) cancel.textContent = "Go back";
      }
    } catch (_) {}
    return p;
  };
  w.__lvc = true; window.showConfirmDialog = w;
})();

/* ===== Search: steady results =====
   The same words searched again within a few seconds (a second trigger of the same search) are not redrawn, so the list does
   not blink; pictures in the results fade in once instead of popping. */
(function () {
  "use strict";
  var last = { key: "", at: 0 };
  function wrap() {
    var q = window.runSearchPageQuery;
    if (typeof q !== "function" || q.__lvSteady) return;
    var w = async function (term) {
      var k = String(term || "").trim().toLowerCase() + "|" + (typeof searchPageFilter !== "undefined" ? searchPageFilter : "");
      var has = document.querySelector("#searchPageResults .search-page-section, #searchPageResults .search-page-empty");
      if (k === last.key && Date.now() - last.at < 4000 && has) return;
      last = { key: k, at: Date.now() };
      return q.apply(this, arguments);
    };
    w.__lvSteady = true; w.__lvDual = q.__lvDual; window.runSearchPageQuery = w;
  }
  wrap(); setTimeout(wrap, 1500); setTimeout(wrap, 5000);
})();

/* Comment box grows with the text, up to about six lines */
(function(){
  function grow(t){try{t.style.height="auto";t.style.height=Math.min(t.scrollHeight+2,160)+"px";}catch(_){}}
  document.addEventListener("input",function(e){var t=e.target;if(t&&t.tagName==="TEXTAREA"&&t.closest&&t.closest(".product-comment-compose-row"))grow(t);},true);
  document.addEventListener("focusin",function(e){var t=e.target;if(t&&t.tagName==="TEXTAREA"&&t.closest&&t.closest(".product-comment-compose-row"))grow(t);},true);
})();

/* ===== Comments: a reply notification opens the reply and lights it up; replies hang from their comment on a line
   (like LinkedIn), and the shop's own comments say "Seller", the person who started the thread "Author". ===== */
(function () {
  "use strict";
  var owner = { key: "", uid: null };
  function rowsIn(root) { return Array.prototype.slice.call((root || document).querySelectorAll(".product-comment-row[data-comment-id]")); }
  function tag(row, text, cls) {
    if (row.querySelector(".lv-cr-tag")) return;
    var name = row.querySelector(".lv-cr-name") || row.querySelector(".product-comment-head strong"); if (!name) return;
    var t = document.createElement("span"); t.className = "lv-cr-tag " + cls; t.textContent = text;
    name.insertAdjacentElement("afterend", t);
  }
  function decorate() {
    rowsIn(document).forEach(function (row) {
      if (row.__lvTagged) return;
      var uid = row.getAttribute("data-uid") || "";
      if (!uid) return;
      if (owner.uid && uid === String(owner.uid)) { tag(row, "Seller", "seller"); row.__lvTagged = true; return; }
      var box = row.closest(".comment-replies-dropdown");
      if (box) {
        var rootId = (box.id || "").replace(/^levro-replies-(product|package)-/, "");
        var root = rootId && document.querySelector('.product-comment-row[data-comment-id="' + CSS.escape(rootId) + '"]');
        if (root && root.getAttribute("data-uid") === uid) tag(row, "Author", "author");
      }
      row.__lvTagged = true;
    });
  }
  async function loadOwner(kind, id) {
    var key = kind + ":" + id; if (owner.key === key) return; owner.key = key; owner.uid = null;
    try {
      var r = kind === "package"
        ? await sb.from("vendor_packages").select("vendor:vendors(user_id)").eq("id", id).maybeSingle()
        : await sb.from("products").select("vendor:vendors(user_id)").eq("id", id).maybeSingle();
      if (owner.key === key) { owner.uid = r && r.data && r.data.vendor && r.data.vendor.user_id || null; rowsIn(document).forEach(function (x) { x.__lvTagged = false; }); decorate(); }
    } catch (_) {}
  }
  var open0 = window.openSocialCommentSheet;
  if (typeof open0 === "function" && !open0.__lvTag) {
    var open1 = function (kind, id) { try { loadOwner(kind === "package" ? "package" : "product", id); } catch (_) {} return open0.apply(this, arguments); };
    open1.__lvTag = true; window.openSocialCommentSheet = open1;
  }
  var t = null;
  new MutationObserver(function () { clearTimeout(t); t = setTimeout(function () { decorate(); focusTick(); }, 60); }).observe(document.body, { childList: true, subtree: true });

  /* ---- jump to the comment a notification is about */
  var focus = null;
  function openBox(row) {
    var box = row.closest(".comment-replies-dropdown");
    if (box && box.classList.contains("hidden")) {
      var rootId = (box.id || "").replace(/^levro-replies-(product|package)-/, ""), kind = /package/.test(box.id) ? "package" : "product";
      try { if (window.toggleInlineCommentReplies) window.toggleInlineCommentReplies(rootId, kind); else box.classList.remove("hidden"); } catch (_) { box.classList.remove("hidden"); }
      if (box.classList.contains("hidden")) box.classList.remove("hidden");
    }
  }
  function flash(row) {
    openBox(row);
    try { row.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (_) {}
    row.classList.remove("lv-cr-flash"); void row.offsetWidth; row.classList.add("lv-cr-flash");
    setTimeout(function () { row.classList.remove("lv-cr-flash"); }, 2600);
  }
  function focusTick() {
    if (!focus) return;
    if (Date.now() - focus.at > 12000) { focus = null; return; }
    var ids = [focus.reply, focus.parent].filter(Boolean);
    for (var i = 0; i < ids.length; i++) {
      var row = document.querySelector('.product-comment-row[data-comment-id="' + CSS.escape(String(ids[i])) + '"]');
      if (row) {
        // the parent is only the fallback while the reply itself has not arrived yet (give it a moment)
        if (i === 1 && focus.reply && Date.now() - focus.at < 4000) { openBox(row); var dd = document.getElementById("levro-replies-product-" + ids[i]) || document.getElementById("levro-replies-package-" + ids[i]); if (dd) dd.classList.remove("hidden"); return; }
        var f = focus; focus = null; setTimeout(function () { flash(row); }, 250); void f; return;
      }
    }
  }
  var hn0 = window.handleNotifItemClick;
  if (typeof hn0 === "function" && !hn0.__lvFocus) {
    var hn1 = function (event, id) {
      try {
        var item = (event && event.currentTarget) || document.querySelector('.notif-item[data-id="' + CSS.escape(String(id)) + '"]');
        var p = {}; try { p = JSON.parse((item && item.dataset.params) || "{}"); } catch (_) {}
        if (p && p.commentId) {
          focus = { parent: String(p.commentId), reply: null, at: Date.now() };
          // the reply's own id is in the notification's details
          sb.from("notifications").select("metadata").eq("id", id).maybeSingle().then(function (r) {
            var m = r && r.data && r.data.metadata; if (focus && m && m.comment_id) { focus.reply = String(m.comment_id); focusTick(); }
          }, function () {});
        }
      } catch (_) {}
      return hn0.apply(this, arguments);
    };
    hn1.__lvFocus = true; window.handleNotifItemClick = hn1;
  }
  // a push notification that opens the app with a comment in its link
  window.lvFocusComment = function (parent, reply) { focus = { parent: parent ? String(parent) : null, reply: reply ? String(reply) : null, at: Date.now() }; focusTick(); };
})();

/* ===== Followers page, livelier: a summary strip, ringed avatars (gradient for shops), "New" for the last 7 days,
   pill tabs, and a "View shop" button on shops ===== */
(function () {
  "use strict";
  var page0 = window.renderVendorFollowersPage;
  if (typeof page0 === "function" && !page0.__fp2) {
    var page1 = async function () {
      var html = String(await page0.apply(this, arguments));
      return html.replace('<div class="fp-page">', '<div class="fp-page fp2">').replace('<div class="fp-tabs"', '<div class="fp2-hero" id="fp2Hero"></div><div class="fp-tabs"');
    };
    page1.__fp2 = true; window.renderVendorFollowersPage = page1;
  }
  var DAY = 864e5;
  window.fpRender = function () {
    var st = window.__fp || { rows: [] }, rows = st.rows || [], tab = st.tab, q = st.q;
    var vend = rows.filter(function (r) { return r.is_vendor; }), cust = rows.filter(function (r) { return !r.is_vendor; });
    var fresh = rows.filter(function (r) { return r.followed_at && Date.now() - new Date(r.followed_at) < 7 * DAY; }).length;
    var hero = document.getElementById("fp2Hero");
    if (hero) hero.innerHTML = [[rows.length, "Followers", "fa-user-group", "g"], [fresh, "New this week", "fa-bolt", "o"], [vend.length, "Shops", "fa-store", "p"], [cust.length, "Customers", "fa-user", "b"]]
      .map(function (x) { return '<div class="fp2-stat ' + x[3] + '"><i class="fa-solid ' + x[2] + '"></i><b>' + x[0] + "</b><small>" + x[1] + "</small></div>"; }).join("");
    var tabs = document.getElementById("fpTabs");
    if (tabs) tabs.innerHTML = [["all", "All", rows.length], ["vendors", "Shops", vend.length], ["customers", "Customers", cust.length]]
      .map(function (x) { return '<button type="button" role="tab" class="fp-tab' + (tab === x[0] ? " active" : "") + '" aria-selected="' + (tab === x[0]) + '" onclick="fpTab(\'' + x[0] + '\')">' + x[1] + " <b>" + x[2] + "</b></button>"; }).join("");
    var c = document.getElementById("fpCount"); if (c) c.textContent = "";
    var list = tab === "vendors" ? vend : tab === "customers" ? cust : rows;
    if (q) list = list.filter(function (r) { return ((r.name || "") + " " + (r.business_name || "") + " " + (r.city || "") + " " + (r.sector_name || "")).toLowerCase().indexOf(q) >= 0; });
    var box = document.getElementById("fpList"); if (!box) return;
    if (!list.length) {
      box.innerHTML = '<div class="fp2-empty"><span><i class="fa-solid fa-user-group"></i></span><strong>' + (q ? "No one matches “" + esc(q) + "”" : tab === "vendors" ? "No shops follow you yet" : tab === "customers" ? "No customers follow you yet" : "No followers yet") + "</strong><small>" + (q ? "Try another name." : "Share your shop's QR code so people can follow you.") + "</small></div>";
      return;
    }
    box.innerHTML = list.map(function (r) {
      var name = r.name || "Levromart user";
      var isNew = r.followed_at && Date.now() - new Date(r.followed_at) < 7 * DAY;
      var when = r.followed_at ? new Date(r.followed_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
      var sub = r.is_vendor ? [r.sector_name, r.city].filter(Boolean).join(" · ") || "Shop" : "Customer";
      var go = r.is_vendor && r.vendor_id ? "navigate('storefront',{vendorId:'" + esc(r.vendor_id) + "'})" : "";
      var tagHtml = typeof fpTag === "function" ? fpTag(r) : "";
      return '<div class="fp2-row"' + (go ? ' role="link" tabindex="0" onclick="' + go + '"' : "") + ">" +
        '<span class="fp2-ring ' + (r.is_vendor ? "shop" : isNew ? "new" : "") + '">' + profileAvatarHtml(r.avatar_url, name, "3.1rem") + "</span>" +
        '<div class="fp2-copy"><strong>' + esc(name) + (isNew ? ' <em class="fp2-new">New</em>' : "") + "</strong>" +
        '<span class="fp2-sub">' + (r.is_vendor ? '<i class="fa-solid fa-store"></i> ' : "") + esc(sub) + (when ? " · since " + esc(when) : "") + "</span>" + tagHtml + "</div>" +
        (go ? '<button type="button" class="fp2-btn" onclick="event.stopPropagation();' + go + '">View shop</button>' : "") + "</div>";
    }).join("");
  };
})();

/* ===== Shop location: the locate button is the Levromart logo and spins while it finds you; tapping the map or its
   buttons never throws the page back to the top (iPhone scrolls to a focused map) ===== */
(function () {
  "use strict";
  function dress() {
    var b = document.querySelector("#veLocationMap .vendor-map-locate-control");
    if (b && !b.__lv) { b.__lv = true; b.innerHTML = '<span class="lv-loc-logo" aria-hidden="true"></span>'; }
  }
  new MutationObserver(function () { dress(); }).observe(document.body, { childList: true, subtree: true });
  var loc0 = window.locateVendorMapOnly;
  if (typeof loc0 === "function" && !loc0.__lv) {
    var loc1 = async function () {
      var b = document.querySelector("#veLocationMap .vendor-map-locate-control");
      if (b) b.classList.add("is-locating");
      try { return await loc0.apply(this, arguments); } finally { if (b) b.classList.remove("is-locating"); }
    };
    loc1.__lv = true; window.locateVendorMapOnly = loc1;
  }
  // keep the page where it was for a moment after a tap on the location map or its buttons
  var keep = null;
  function hold(e) {
    var t = e.target;
    if (!t || !t.closest || !t.closest("#veLocationMap, #veUseLocationBtn, .saved-location-select")) return;
    keep = { y: window.scrollY, until: Date.now() + 3500 };
    document.documentElement.style.overflowAnchor = "none";
  }
  document.addEventListener("pointerdown", hold, true);
  document.addEventListener("touchstart", hold, { capture: true, passive: true });
  // the person moving the page (finger, wheel, keys) is never undone: that fought them and bounced the page up and down
  var mine = function () { keep = null; };
  document.addEventListener("touchmove", function (e) { if (!(e.target && e.target.closest && e.target.closest("#veLocationMap"))) keep = null; }, { capture: true, passive: true });
  document.addEventListener("wheel", mine, { capture: true, passive: true });
  document.addEventListener("keydown", mine, true);
  // the page is never pulled back by script any more (that fought the finger and made it tumble up and down);
  // instead the map stops grabbing focus and keyboard handling, and touching it moves the map, not the page
  setInterval(function () { try { if (typeof veMap !== "undefined" && veMap && veMap.keyboard && veMap.keyboard.enabled && veMap.keyboard.enabled()) veMap.keyboard.disable(); } catch (_) {} }, 1500);
  // the map itself should not grab focus (that is what makes iPhone scroll)
  document.addEventListener("focusin", function (e) {
    var m = e.target && e.target.closest && e.target.closest("#veLocationMap");
    if (m && e.target === m) { try { e.target.blur(); } catch (_) {} }
  }, true);
})();

/* ===== Levi, clearer: answers show their formatting (bold, numbered lists, bullets), a spinning Levromart mark with what
   Levi is doing while it works, and product cards two per row (up to 12). ===== */
(function () {
  "use strict";
  function inline(t) {
    return t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,!?]|$)/g, "$1<em>$2</em>");
  }
  // escape first, then the few markdown pieces Levi uses
  window.lvLeviMarkdown = function (text) {
    var e = (typeof esc === "function" ? esc : function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); })(String(text || ""));
    var lines = e.split(/\n/), out = [], list = null;
    function close() { if (list) { out.push("</" + list + ">"); list = null; } }
    lines.forEach(function (raw) {
      var ln = raw.replace(/\s+$/, "");
      var num = /^\s*(\d+)[.)]\s+(.*)$/.exec(ln), bul = /^\s*[-•*]\s+(.*)$/.exec(ln), head = /^\s*#{1,4}\s+(.*)$/.exec(ln);
      if (num) { if (list !== "ol") { close(); out.push('<ol class="lvmd-ol" start="' + num[1] + '">'); list = "ol"; } out.push("<li>" + inline(num[2]) + "</li>"); return; }
      if (bul) { if (list !== "ul") { close(); out.push('<ul class="lvmd-ul">'); list = "ul"; } out.push("<li>" + inline(bul[1]) + "</li>"); return; }
      if (list && /^\s{2,}\S/.test(raw) && out.length) { out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, '<span class="lvmd-sub">' + inline(ln.trim()) + "</span></li>"); return; }
      close();
      if (head) { out.push('<p class="lvmd-h">' + inline(head[1]) + "</p>"); return; }
      if (!ln.trim()) { out.push('<div class="lvmd-gap"></div>'); return; }
      out.push("<p>" + inline(ln) + "</p>");
    });
    close();
    return out.join("").replace(/(<div class="lvmd-gap"><\/div>){2,}/g, '<div class="lvmd-gap"></div>');
  };
  var STEPS = ["Checking the shops…", "Comparing prices…", "Working out distances…", "Picking the best matches…", "Almost there…"];
  function spinnerHtml() { return '<span class="lvthink"><span class="lvthink-mark" aria-hidden="true"></span><span class="lvthink-t">Thinking…</span></span>'; }
  var app0 = window.appendAiChatMessage;
  if (typeof app0 === "function" && !app0.__lvmd) {
    var app1 = function (role, content) {
      var r = app0.apply(this, arguments);
      try {
        var wrap = document.getElementById("aiChatMessages"); if (!wrap) return r;
        if (role === "typing") {
          var ty = document.getElementById("aiChatTyping");
          if (ty) {
            ty.classList.add("lvthink-row"); ty.innerHTML = spinnerHtml();
            var i = 0, t0 = Date.now();
            var tick = setInterval(function () {
              var el = document.getElementById("aiChatTyping"); if (!el || el !== ty) { clearInterval(tick); return; }
              var s = Date.now() - t0, lab = el.querySelector(".lvthink-t"); if (!lab) return;
              if (s > 1400) { lab.textContent = STEPS[Math.min(STEPS.length - 1, i++)]; }
            }, 1700);
          }
          return r;
        }
        if (role === "assistant") {
          var msgs = wrap.querySelectorAll(".ai-chat-msg.assistant"), el2 = msgs[msgs.length - 1];
          if (el2 && !el2.__lvmd) {
            el2.__lvmd = true;
            var node = el2.firstChild;
            // the reply as Levi wrote it (with its line breaks), minus the app's own [[...]] instructions
            var src = String(content || "").replace(/\[\[DRAFTMSG[\s\S]*?\[\[\/DRAFTMSG\]\]/g, "").replace(/\[\[[^\]]*\]\]/g, "").replace(/[ \t]+\n/g, "\n").trim();
            if (node && node.nodeType === 3 && node.nodeValue.trim()) {
              var div = document.createElement("div"); div.className = "lvmd"; div.innerHTML = window.lvLeviMarkdown(src || node.nodeValue);
              el2.replaceChild(div, node);
            }
          }
        }
      } catch (_) {}
      return r;
    };
    app1.__lvmd = true; window.appendAiChatMessage = app1;
  }
  // up to 12 product cards under an answer (they show two per row)
  window.parseAiProductTags = function (content) {
    var str = String(content || ""), m = /\[\[PRODUCTS:([a-zA-Z0-9,-]+)\]\]/.exec(str);
    if (!m) return { text: str, ids: [] };
    return { text: (str.slice(0, m.index) + str.slice(m.index + m[0].length)).replace(/[ \t]{2,}/g, " ").trim(), ids: m[1].split(",").filter(Boolean).slice(0, 12) };
  };
})();

/* ===== A tap is never lost: when the page redraws itself between the finger going down and coming up (fresh data arriving),
   the tapped button no longer exists and the phone drops the tap. The same button in the new page is pressed instead. ===== */
(function () {
  "use strict";
  var down = null;
  function key(el) {
    var b = el && el.closest && el.closest("button,a,[onclick],[role=button],[role=link]");
    if (!b) return null;
    return { el: b, onclick: b.getAttribute("onclick"), id: b.id, txt: (b.textContent || "").trim().slice(0, 60), x: 0, y: 0 };
  }
  document.addEventListener("pointerdown", function (e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    var k = key(e.target); if (!k || !k.el.closest("#app")) { down = null; return; }
    k.x = e.clientX; k.y = e.clientY; k.t = Date.now(); down = k;
  }, true);
  document.addEventListener("pointermove", function (e) { if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10) down = null; }, { capture: true, passive: true });
  document.addEventListener("pointerup", function (e) {
    var k = down; down = null;
    if (!k || Date.now() - k.t > 700 || document.contains(k.el)) return;   // nothing lost: the normal click happens
    var twin = null;
    if (k.id) twin = document.getElementById(k.id);
    if (!twin && k.onclick) twin = Array.prototype.find.call(document.querySelectorAll("#app [onclick]"), function (n) { return n.getAttribute("onclick") === k.onclick; });
    if (!twin) { var at = document.elementFromPoint(e.clientX, e.clientY); var c = at && at.closest && at.closest("button,a,[onclick],[role=button],[role=link]"); if (c && (c.textContent || "").trim().slice(0, 60) === k.txt) twin = c; }
    if (twin && document.contains(twin)) setTimeout(function () { try { twin.click(); } catch (_) {} }, 0);
  }, true);
})();

/* ===== Levromart 3D icon set (public/icons3d/lv): one registry, used by notifications, empty states, the seller dashboard's
   statistics and tools, and the wallet / transaction lists. The pictures stand on the page itself (no coloured boxes). ===== */
(function () {
  "use strict";
  var NAMES = ["order-cancelled", "order-confirmed", "order-reminder", "new-order", "new-listing", "points", "vendor-of-week", "order-completed", "handed-over", "dispute",
    "withdrawal-approved", "withdrawal-rejected", "payout-sent", "moved-up", "general", "empty-orders", "empty-vendors", "empty-cart", "empty-bank", "empty-messages", "empty-notifications",
    "manage-listings", "monthly-listing", "reviews", "working-hours", "requests", "suggestions", "support", "settings", "tx-all", "tx-pending", "tx-ready", "tx-onway", "tx-paid",
    "stat-orders", "stat-followers", "stat-views", "stat-wishlist",
    "out-of-stock", "cash", "diamond", "chart", "new-arrival", "store", "gift", "bars", "cart-list", "search", "map-pin", "admin", "logout"];
  window.LV3D = {}; NAMES.forEach(function (n) { window.LV3D[n] = "/icons3d/lv/" + n + ".webp"; });
  window.lv3dIcon = function (name, size, alt) {
    var src = window.LV3D[name]; if (!src) return "";
    var s = size || 48;
    return '<img class="lv3di" src="' + src + '" width="' + s + '" height="' + s + '" alt="' + (alt ? esc(alt) : "") + '"' + (alt ? "" : ' aria-hidden="true"') + ' decoding="async">';
  };
  // empty states drawn by lvIllus (orders, cart, messages)
  var illus0 = window.lvIllus;
  window.lvIllus = function (kind, px) {
    var map = { box: "empty-orders", cart: "empty-cart", chat: "empty-messages" };
    if (map[kind]) return window.lv3dIcon(map[kind], Math.max(96, Math.round((px || 64) * 1.6)));
    return typeof illus0 === "function" ? illus0.apply(this, arguments) : "";
  };
  // the seller dashboard's statistic tiles (lv3d by emoji code)
  var STAT = { "1f6d2": "stat-orders", "1f48e": "monthly-listing", "1f4e6": "new-listing", "1f465": "stat-followers", "1f4c8": "stat-views", "1f381": "stat-wishlist" };
  var lv3d0 = window.lv3d;
  if (typeof lv3d0 === "function") window.lv3d = function (c, cls) { return STAT[c] ? '<img class="lv3d ' + (cls || "") + '" src="' + window.LV3D[STAT[c]] + '" alt="" aria-hidden="true" decoding="async">' : lv3d0.apply(this, arguments); };
  // notifications: the picture that matches what happened (anything else keeps its old icon)
  function pick(n) {
    var T = String(n && n.type || ""), t = String(n && n.title || "") + " " + String(n && n.body || "");
    if (/cancel/.test(T) || (T === "order_status_changed" && /cancel/i.test(t))) return "order-cancelled";
    if (T === "order_status_changed") return /complet/i.test(t) ? "order-completed" : /confirm/i.test(t) ? "order-confirmed" : /hand|deliver/i.test(t) ? "handed-over" : /dispute/i.test(t) ? "dispute" : null;
    var M = { order_reminder: "order-reminder", new_order: "new-order", order_placed: "new-order", payment_confirmed: "order-confirmed", payment_received: "tx-paid",
      new_dispute: "dispute", dispute_reopened: "dispute", dispute_resolved: "order-completed", points: "points", points_winner: "vendor-of-week", vendor_of_the_week: "vendor-of-week",
      vendor_follow: "stat-followers", suggestion_reply: "suggestions", chat_request: "requests", vendor_follow_update: "new-listing", stock_alert: "new-listing", new_listing: "new-listing", new_review: "reviews", new_message: "requests",
      withdrawal_approved: "withdrawal-approved", withdrawal_rejected: "withdrawal-rejected", payout_failed: "withdrawal-rejected", payout_sent: "payout-sent", refund_sent: "payout-sent",
      wallet_topup: "cash", wallet_hold: "tx-pending", wallet_withdrawal_sent: "payout-sent", wallet_withdrawal_rejected: "withdrawal-rejected", wallet_withdrawal_failed: "withdrawal-rejected", wallet_received: "tx-paid",
      payout_on_hold: "tx-pending", payment_unresolved_24h: "tx-pending", product_wishlisted: "stat-wishlist", leaderboard_up: "moved-up", rank_up: "moved-up" };
    if (M[T]) return M[T];
    if (/(now|are|you're|you are) (first|#1|number one|top)\b|first this week|#1 this week|this week'?s? winner/i.test(t)) return "vendor-of-week";
    if (/leaderboard|moved up|rank/i.test(t) && /point|leader|rank/i.test(T + t)) return "moved-up";
    if (/^withdraw/.test(T)) return /reject|not approved|declin/i.test(t) ? "withdrawal-rejected" : "withdrawal-approved";
    if (/^payout|^refund/.test(T)) return "payout-sent";
    return null;
  }
  var ni0 = window.notificationSystemIconHtml;
  if (typeof ni0 === "function" && !ni0.__lv3d) {
    var ni1 = function (n) { var k = pick(n); return k ? '<span class="notification-system-icon notif-type-icon lv3d-n">' + window.lv3dIcon(k, 44) + "</span>" : ni0.apply(this, arguments); };
    ni1.__lv3d = true; window.notificationSystemIconHtml = ni1;
    try { notificationSystemIconHtml = ni1; } catch (_) {}
  }
})();

/* ===== Black theme = Dark theme, everywhere: every style written for Dark is copied for Black (Deep black) when the page
   loads, unless Black already has its own style for that exact element. Page backgrounds and colour variables are left
   alone, so Black stays truly black; cards, rows and text get the same dark treatment as in Dark. ===== */
(function () {
  "use strict";
  var DARK = /\[data-theme=["']?dark["']?\]/g, seen = typeof WeakSet === "function" ? new WeakSet() : null, mirror = null;
  function parts(sel) { var out = [], depth = 0, cur = ""; for (var i = 0; i < sel.length; i++) { var c = sel[i]; if (c === "(") depth++; if (c === ")") depth--; if (c === "," && !depth) { out.push(cur.trim()); cur = ""; } else cur += c; } if (cur.trim()) out.push(cur.trim()); return out; }
  function norm(s) { return s.replace(/\s+/g, " ").replace(/["']/g, "").trim(); }
  function walk(list, fn, wrap) {
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (r.type === 1) fn(r, wrap);
      else if ((r.type === 4 || r.type === 12) && r.cssRules) walk(r.cssRules, fn, (r.type === 4 ? "@media " + r.conditionText : "@supports " + r.conditionText));
    }
  }
  function sheets() { var out = []; for (var i = 0; i < document.styleSheets.length; i++) { var sh = document.styleSheets[i]; if (sh.ownerNode && sh.ownerNode.id === "lvBlackMirror") continue; try { if (sh.cssRules) out.push(sh); } catch (_) {} } return out; }
  function run() {
    var have = {}, add = [];
    var all = sheets();
    all.forEach(function (sh) { walk(sh.cssRules, function (r) { parts(r.selectorText || "").forEach(function (p) { if (/data-theme=["']?black/.test(p)) have[norm(p)] = 1; }); }); });
    all.forEach(function (sh) {
      walk(sh.cssRules, function (r, wrap) {
        if (seen && seen.has(r)) return; if (seen) seen.add(r);
        var sel = r.selectorText || ""; if (sel.indexOf("data-theme") < 0) return;
        var outSel = parts(sel).filter(function (p) {
          if (!/data-theme=["']?dark/.test(p) || /black/.test(p)) return false;
          DARK.lastIndex = 0;
          var rest = p.split(DARK).pop();
          return !/^\s*(body)?\s*$/.test(rest);   // the page itself (html / body) keeps Black's own background
        }).map(function (p) { DARK.lastIndex = 0; return p.replace(DARK, '[data-theme="black"]'); }).filter(function (p) { return !have[norm(p)]; });
        if (!outSel.length) return;
        var decl = [];
        for (var k = 0; k < r.style.length; k++) { var prop = r.style[k]; if (prop.indexOf("--") === 0) continue; decl.push(prop + ":" + r.style.getPropertyValue(prop) + (r.style.getPropertyPriority(prop) ? " !important" : "")); }
        if (!decl.length) return;
        var txt = outSel.join(",") + "{" + decl.join(";") + "}";
        add.push(wrap ? wrap + "{" + txt + "}" : txt);
      });
    });
    if (!add.length) return;
    if (!mirror) { mirror = document.createElement("style"); mirror.id = "lvBlackMirror"; }
    mirror.appendChild(document.createTextNode(add.join("\n") + "\n"));
    document.head.appendChild(mirror);   // stays last
  }
  function soon() { try { run(); } catch (e) { console.warn("[Levromart] black theme", e); } }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", soon); else setTimeout(soon, 0);
  setTimeout(soon, 2500); setTimeout(soon, 9000);
  try { new MutationObserver(function () { if (document.documentElement.getAttribute("data-theme") === "black") soon(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] }); } catch (_) {}
})();

/* ===== Order history shows each order like the order list: the product's picture, name, price, the other person and the
   status (dates stay as headings). ===== */
(function () {
  "use strict";
  var orig = window.orderHistoryInnerHtml;
  if (typeof orig !== "function" || orig.__lvo) return;
  var f = function (historyOrders, isCustomerView, sourcePerspective) {
    if (typeof window.orderListHtml !== "function") return orig.apply(this, arguments);
    var byDate = new Map();
    (historyOrders || []).forEach(function (o) {
      var iso = (typeof orderActivityIso === "function" ? orderActivityIso(o) : null) || o.created_at;
      var key = new Date(iso).toLocaleDateString("en-NG", { weekday: "short", year: "numeric", month: "short", day: "numeric" });
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key).push(o);
    });
    var inner = "";
    byDate.forEach(function (dayOrders, dateKey) {
      inner += '<div class="order-history-date"><i class="fa-regular fa-calendar"></i><span>' + esc(dateKey) + "</span></div>";
      inner += '<div class="order-history-day lvo-list lvo-hist-day">' + dayOrders.map(function (o) {
        return String(window.orderListHtml([o], isCustomerView, sourcePerspective)).replace(/^<div class="lvo-list">/, "").replace(/<\/div>$/, "");
      }).join("") + "</div>";
    });
    return inner;
  };
  f.__lvo = true; window.orderHistoryInnerHtml = f;
  try { orderHistoryInnerHtml = f; } catch (_) {}
})();

/* ===== Admin: approving, rejecting or deleting a vendor never hangs on "Approving…": after 25 seconds the button comes back
   with a clear message (the step itself is safe to try again). ===== */
(function () {
  "use strict";
  var NAMES = { admin_set_vendor_status: 1, admin_delete_vendor: 1 };
  function wrap() {
    if (typeof sb === "undefined" || !sb || typeof sb.rpc !== "function" || sb.rpc.__lvTimeout) return;
    var rpc0 = sb.rpc;
    var rpc1 = function (name) {
      var call = rpc0.apply(this, arguments);
      if (!NAMES[name]) return call;
      var timer;
      var late = new Promise(function (res) { timer = setTimeout(function () { res({ data: null, error: { message: "This is taking too long. Check your connection and try again." } }); }, 25000); });
      return Promise.race([Promise.resolve(call).then(function (r) { clearTimeout(timer); return r; }), late]);
    };
    rpc1.__lvTimeout = true; sb.rpc = rpc1;
  }
  wrap(); setTimeout(wrap, 1500); setTimeout(wrap, 5000);
})();

/* ===== Settings: the font size and Levi size scales only change when they are dragged on purpose. Scrolling the page with a
   finger that lands on a scale used to change it by itself. ===== */
(function () {
  "use strict";
  var IDS = { levroFontScaleRange: "setLevromartFontScale", leviSizeRange: "setLeviFabSize" };
  var g = null;
  function apply(el, v) { el.value = v; var fn = window[IDS[el.id]]; if (typeof fn === "function") { try { fn(v); } catch (_) {} } }
  document.addEventListener("touchstart", function (e) {
    var el = e.target && e.target.closest && e.target.closest("input[type=range]");
    if (!el || !IDS[el.id]) { g = null; return; }
    var t = e.touches[0];
    g = { el: el, v0: el.value, x: t.clientX, y: t.clientY, ok: false, no: false };
  }, { capture: true, passive: true });
  document.addEventListener("touchmove", function (e) {
    if (!g || g.ok || g.no) return;
    var t = e.touches[0], dx = Math.abs(t.clientX - g.x), dy = Math.abs(t.clientY - g.y);
    if (dy > 6 && dy > dx) { g.no = true; apply(g.el, g.v0); }     // a scroll: leave the setting as it was
    else if (dx > 8 && dx > dy) g.ok = true;                      // a real sideways drag
  }, { capture: true, passive: true });
  document.addEventListener("input", function (e) {
    if (!g || e.target !== g.el) return;
    if (g.no || !g.ok) { e.stopImmediatePropagation(); g.el.value = g.v0; }
  }, true);
  document.addEventListener("touchend", function () {
    if (g && !g.ok && g.el.value !== g.v0) apply(g.el, g.v0);
    g = null;
  }, { capture: true, passive: true });
})();

/* ===== Vendor requests page, refurbished like the customer's: a friendly header, the request box picture instead of the hand,
   two clean tabs and neat empty states with a 3D picture. ===== */
(function () {
  "use strict";
  var BOX = "<svg viewBox='0 0 24 24' width='26' height='26' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'><path d='M12 22V12'/><path d='M20.27 18.27 22 20'/><path d='M21 10.498V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.729l7 4a2 2 0 0 0 2 .001l.98-.559'/><path d='M3.29 7 12 12l8.71-5'/><path d='m7.5 4.27 8.997 5.148'/><circle cx='18.5' cy='16.5' r='2.5'/></svg>";
  function empty(icon, title, text, btn) {
    return '<div class="lv3d-empty vrq-empty">' + (typeof lv3dIcon === "function" ? lv3dIcon(icon, 112) : "") + "<strong>" + title + "</strong><span>" + text + "</span>" + (btn || "") + "</div>";
  }
  function tidy(html) {
    html = String(html == null ? "" : html);
    if (html.indexOf("vendor-requests-page") < 0 || html.indexOf("vrq-ready") >= 0) return html;
    html = html.replace('<div class="vendor-requests-page">', '<div class="vendor-requests-page vrq-ready">' + (typeof lvPageHero === "function" ? lvPageHero("request") : ""));
    html = html.replace(/<h2><i class=['"]fa-solid fa-hand['"]><\/i> Requests /, '<h2 class="vrq-title"><span class="rq-ic vrq-ic">' + BOX + '</span><span class="vrq-tt"><b>Requests</b><small>What customers need, and what you asked for.</small></span> ');
    html = html.replace('<i class="fa-solid fa-users"></i> Customer requests', "Customer requests").replace('<i class="fa-solid fa-list-check"></i> My requests', "My requests");
    html = html.replace('<div class="empty-state">No customer requests to show right now.</div>', empty("requests", "No requests right now", "When a customer asks for something you sell, it shows up here and you get a notification."));
    html = html.replace('<div class="empty-state">No requests in your sector right now.</div>', empty("requests", "Nothing in your sector yet", "Requests in your sector show up here. You can switch to all requests above."));
    html = html.replace(/<div class="empty-state"><i class="fa-solid fa-list-check"[^>]*><\/i>You haven't posted any requests yet\.<br><button type="button" class="btn btn-sm" style="margin-top:\.7rem;" onclick="navigate\('requestEquipment'\)">Post a request<\/button><\/div>/,
      empty("manage-listings", "You haven't asked for anything yet", "Vendors are customers too. Post what you need and other shops send you offers.", '<button type="button" class="btn lvo-btn" onclick="navigate(\'requestEquipment\')"><i class="fa-solid fa-plus"></i> Post a request</button>'));
    return html;
  }
  function wrap() {
    var f = window.renderVendorRequests; if (typeof f !== "function" || f.__vrq) return;
    var w = async function () { return tidy(await f.apply(this, arguments)); };
    w.__vrq = true; w.__lvw = f.__lvw; w.__lvrw = f.__lvrw; window.renderVendorRequests = w;
    try { renderVendorRequests = w; } catch (_) {}
  }
  wrap(); setTimeout(wrap, 1300); setTimeout(wrap, 4200);
})();

/* ===== Revenue chart: a small palette button next to its title lets the shop pick the chart's colour (kept on this phone) ===== */
(function () {
  "use strict";
  var KEY = "lv-chart-colour", COLS = ["#16a06a", "#2563eb", "#7c3aed", "#db2777", "#ea580c", "#0891b2", "#ca8a04", "#475569"];
  function saved() { try { return localStorage.getItem(KEY) || ""; } catch (_) { return ""; } }
  function paint(wrap, c) { if (c) wrap.style.setProperty("--primary", c); else wrap.style.removeProperty("--primary"); }
  var orig = window.buildRevenueChart;
  return;   // the chart colour palette was removed on request
  if (typeof orig !== "function" || orig.__lvpal) return;
  var f = function () {
    var wrap = orig.apply(this, arguments);
    try {
      paint(wrap, saved());
      var label = wrap.querySelector(".modern-chart-card > .flex > p");
      if (label) {
        var b = document.createElement("button");
        b.type = "button"; b.className = "lvc-pal-btn"; b.setAttribute("aria-label", "Chart colour"); b.title = "Chart colour";
        b.innerHTML = '<i class="fa-solid fa-palette"></i>';
        var row = document.createElement("div"); row.className = "lvc-pal hidden"; row.setAttribute("role", "radiogroup"); row.setAttribute("aria-label", "Chart colour");
        row.innerHTML = COLS.map(function (c) { return '<button type="button" role="radio" aria-label="Colour" data-c="' + c + '" style="--c:' + c + '"' + (saved() === c ? ' aria-checked="true"' : "") + "></button>"; }).join("");
        label.appendChild(b);
        wrap.querySelector(".modern-chart-card").insertBefore(row, wrap.querySelector(".modern-chart-svg"));
        b.addEventListener("click", function (e) { e.stopPropagation(); row.classList.toggle("hidden"); });
        row.addEventListener("click", function (e) {
          var s = e.target.closest("[data-c]"); if (!s) return;
          var c = s.getAttribute("data-c");
          try { localStorage.setItem(KEY, c); } catch (_) {}
          document.querySelectorAll(".revenue-chart-wrap").forEach(function (w) { paint(w, c); });
          row.querySelectorAll("[data-c]").forEach(function (x) { x.setAttribute("aria-checked", String(x === s)); });
          row.classList.add("hidden");
        });
      }
    } catch (_) {}
    return wrap;
  };
  f.__lvpal = true; window.buildRevenueChart = f;
  try { buildRevenueChart = f; } catch (_) {}
})();

/* ===== Share cards: a light watermark behind the QR card, made of the real Levromart mark, the shop's own picture (or its
   initials) and a few of its products. Drawn on screen and in the saved picture. ===== */
(function () {
  "use strict";
  function load(src) { return new Promise(function (res) { if (!src) return res(null); var i = new Image(); i.crossOrigin = "anonymous"; i.onload = function () { res(i); }; i.onerror = function () { res(null); }; i.src = src; }); }
  function pinPath(x, cx, cy, r) { x.beginPath(); x.arc(cx, cy - r * 0.2, r * 0.78, Math.PI * 0.84, Math.PI * 2.16); x.lineTo(cx, cy + r); x.closePath(); }
  function round(x, X, Y, W, H, R) { x.beginPath(); x.moveTo(X + R, Y); x.arcTo(X + W, Y, X + W, Y + H, R); x.arcTo(X + W, Y + H, X, Y + H, R); x.arcTo(X, Y + H, X, Y, R); x.arcTo(X, Y, X + W, Y, R); x.closePath(); }
  // a pencil tracing of a picture: only its outlines, in light grey (no colour, no photo)
  function trace(img, size) {
    var c = document.createElement("canvas"); c.width = c.height = size; var x = c.getContext("2d", { willReadFrequently: true });
    var sc = Math.max(size / img.width, size / img.height); x.drawImage(img, (size - img.width * sc) / 2, (size - img.height * sc) / 2, img.width * sc, img.height * sc);
    var d = x.getImageData(0, 0, size, size), p = d.data, g = new Float32Array(size * size), i, X, Y;
    for (i = 0; i < g.length; i++) g[i] = p[i * 4] * 0.3 + p[i * 4 + 1] * 0.59 + p[i * 4 + 2] * 0.11;
    var out = x.createImageData(size, size), o = out.data;
    for (Y = 1; Y < size - 1; Y++) for (X = 1; X < size - 1; X++) {
      var k = Y * size + X, gx = g[k + 1] - g[k - 1] + (g[k - size + 1] - g[k - size - 1]) * 0.5 + (g[k + size + 1] - g[k + size - 1]) * 0.5, gy = g[k + size] - g[k - size] + (g[k + size - 1] - g[k - size - 1]) * 0.5 + (g[k + size + 1] - g[k - size + 1]) * 0.5;
      var m = Math.sqrt(gx * gx + gy * gy), a = m > 38 ? Math.min(255, (m - 38) * 3.2) : 0;
      o[k * 4] = o[k * 4 + 1] = o[k * 4 + 2] = 120; o[k * 4 + 3] = a;
    }
    x.putImageData(out, 0, 0);
    return c;
  }
  // one repeating tile: very few light-grey tracings. A shop or product card: tracings of its own products. A map card: pin outlines.
  window.lvQrWatermarkTile = async function (wm) {
    var T = document.createElement("canvas"); T.width = 520; T.height = 460; var x = T.getContext("2d");
    function place(cv, cx, cy, d, r) { x.save(); x.translate(cx, cy); x.rotate(r * Math.PI / 180); x.drawImage(cv, -d / 2, -d / 2, d, d); x.restore(); }
    if (wm.kind === "map") {
      x.strokeStyle = "rgba(120,120,120,1)"; x.lineWidth = 3; x.lineJoin = "round";
      [[150, 120, 70, -8], [390, 330, 62, 10]].forEach(function (p) { x.save(); x.translate(p[0], p[1]); x.rotate(p[3] * Math.PI / 180); x.beginPath(); pinPath(x, 0, 0, p[2] / 2); x.stroke(); x.beginPath(); x.arc(0, -p[2] * 0.1, p[2] * 0.12, 0, Math.PI * 2); x.stroke(); x.restore(); });
      return T;
    }
    var imgs = await Promise.all((wm.products || []).slice(0, 3).map(function (u) { return load(typeof lvThumb === "function" ? lvThumb(u, 220) : u); }));
    var traced = imgs.filter(Boolean).map(function (im) { return trace(im, 160); });
    if (!traced.length) return T;
    var spots = [[150, 120, 120, -7], [390, 330, 110, 8], [380, 90, 90, 5]];
    traced.forEach(function (cv, k) { var s = spots[k]; place(cv, s[0], s[1], s[2], s[3]); });
    return T;
  };
  // the saved picture: tiles the pattern lightly over the white card
  window.lvQrWatermark = async function () { return; };   // the QR card has no watermark (removed on request)
  window.lvQrWatermarkOld = async function (x, kind, X, Y, W, H, R, col) {
    var wm = window.__lvQrWm; if (!wm) return;
    try {
      var T = await window.lvQrWatermarkTile(wm, col);
      x.save(); round(x, X, Y, W, H, R); x.clip(); x.globalAlpha = 0.22;
      x.fillStyle = x.createPattern(T, "repeat"); x.translate(X, Y); x.fillRect(0, 0, W, H); x.restore();
    } catch (_) {}
  };
  // on screen
  var busy = false;
  new MutationObserver(function () {
    return;   // no watermark on the QR card
    var card = document.querySelector("#lvqrSheet .lvqr-card"); if (!card || busy) return;
    var body = card.querySelector(".lvqr-body"), wm = window.__lvQrWm; if (!body || !wm) return;
    var col = "#0f9d6b";
    try { var cs = getComputedStyle(card); col = (cs.getPropertyValue("--g2") || cs.getPropertyValue("--g1") || col).trim() || col; } catch (_) {}
    var key = wm.kind + (wm.products || []).join("|");
    if (body.__wm === key) return; body.__wm = key; busy = true;
    window.lvQrWatermarkTile(wm, col).then(function (T) { body.style.setProperty("--lvqr-wm", 'url("' + T.toDataURL("image/png") + '")'); body.classList.add("lvqr-wm"); }).catch(function () {}).then(function () { busy = false; });
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
})();

/* ===== Levi for vendors =====
   1. "Add a product" walks the shop through the listing step by step with tap-to-choose answers (type, name, a suggested
      description, sector, category, condition, sale/rent, price, commission or monthly, delivery, stock). At the photos step
      it opens the add form already filled in and points at "Add photos".
   2. "What's selling?" / "How is my shop doing?": answers from Levromart's own data.
   3. Vendors see these as ready-made suggestions in Levi, and in the box's placeholder. ===== */
(function () {
  "use strict";
  var W = null;   // the walk-through in progress
  function isVendor() { try { return typeof vendor !== "undefined" && !!vendor && !!vendor.id; } catch (_) { return false; } }
  function say(text) { try { appendAiChatMessage("assistant", text); persistAiMessage("assistant", text); } catch (_) {} }
  function lastBubble() { var box = document.getElementById("aiChatMessages"); if (!box) return null; var all = box.querySelectorAll(".ai-msg-assistant, .ai-chat-msg.assistant, [data-role='assistant']"); return all.length ? all[all.length - 1] : box.lastElementChild; }
  function chips(list, onPick, opts) {
    setTimeout(function () {
      var host = lastBubble(); if (!host) return;
      var row = document.createElement("div"); row.className = "lvw-chips" + (opts && opts.cls ? " " + opts.cls : "");
      list.forEach(function (c) {
        var b = document.createElement("button"); b.type = "button"; b.className = "lvw-chip"; b.innerHTML = c.html || esc(c.label);
        // an earlier answer can be chosen again (the walk-through carries on from there); only a finished walk-through is closed
        b.onclick = function () { if (row.__used && !W) return; row.__used = true; row.classList.add("used"); row.querySelectorAll(".lvw-chip").forEach(function (x) { x.classList.remove("on"); }); b.classList.add("on"); try { appendAiChatMessage("user", c.label); persistAiMessage("user", c.label); } catch (_) {} onPick(c.value, c.label); };
        row.appendChild(b);
      });
      host.appendChild(row);
      try { var box = document.getElementById("aiChatMessages"); box.scrollTop = box.scrollHeight; } catch (_) {}
    }, 60);
  }
  function hint(placeholder) { var i = document.getElementById("aiChatInput"); if (i) { i.placeholder = placeholder; try { i.focus({ preventScroll: true }); } catch (_) {} } }
  function resetHint() { var i = document.getElementById("aiChatInput"); if (i) i.placeholder = isVendor() ? "Add a product, add to cart, ask what's selling…" : "Ask Levi, or say \"add to cart\"…"; }
  function money(t) { var m = String(t).replace(/[,\s]/g, "").match(/(\d+(?:\.\d+)?)(k)?/i); if (!m) return null; var n = Number(m[1]) * (m[2] ? 1000 : 1); return n > 0 ? n : null; }
  function sectorsList() { try { return (typeof sectors !== "undefined" && sectors) || []; } catch (_) { return []; } }
  function catsFor(sectorId) { return (window.__categories || []).filter(function (c) { return !sectorId || String(c.sector_id) === String(sectorId); }); }
  function describe(name, d) {
    var n = String(name).trim(), cond = d.condition === "new" ? "Brand new" : d.condition === "used-good" ? "Used and in good condition" : d.condition === "used-fair" ? "Used, fair condition" : "";
    if (d.service) return n + " by a trusted local vendor. Clear pricing, friendly service and quick replies. Message me to book a time that suits you.";
    return n + (cond ? " – " + cond.toLowerCase() : "") + ". Good quality and ready to go. Message me for more pictures, sizes or colours, and I'll answer quickly.";
  }
  // ---- the walk-through, one question at a time ----
  var STEPS = {
    type: function () {
      say("Let's add a listing together. **What are you adding?** (You can tap a different answer on any step to change it.)");
      chips([{ label: "Product", value: "product" }, { label: "Service", value: "service" }, { label: "Package (bundle)", value: "package" }], function (v) {
        if (v === "package") { W = null; resetHint(); say("Packages are built from products you already have. I'm opening the package form for you."); setTimeout(function () { closeLevi(); if (typeof openAddPackageModal === "function") openAddPackageModal(); }, 500); return; }
        W.d.service = v === "service"; go("name");
      });
    },
    name: function () { W.want = "name"; say("What's it called? Type the name (for example *" + (W.d.service ? "Hair braiding" : "Nike Air Force 1, size 43") + "*)."); hint("Type the name…"); },
    desc: function () {
      var sug = describe(W.d.name, W.d);
      W.d.descSuggestion = sug;
      say("Here is a description you can use:\n\n" + sug);
      chips([{ label: "Use this", value: "use" }, { label: "I'll write my own", value: "own" }, { label: "Skip for now", value: "skip" }], function (v) {
        if (v === "use") { W.d.desc = sug; go("sector"); } else if (v === "own") { W.want = "desc"; say("Okay, type your description."); hint("Type your description…"); } else go("sector");
      });
    },
    sector: function () {
      var list = sectorsList();
      if (!list.length) return go(W.d.service ? "service_unit" : "condition");
      say("Which **sector** is it in?");
      chips(list.slice(0, 14).map(function (s) { return { label: s.name, value: s.id }; }), function (v) { W.d.sector = v; go("category"); });
    },
    category: function () {
      var list = catsFor(W.d.sector);
      if (!list.length) return go(W.d.service ? "service_unit" : "condition");
      say("And the **category**?");
      chips(list.slice(0, 18).map(function (c) { return { label: c.name, value: c.id }; }), function (v) { W.d.category = v; go(W.d.service ? "service_unit" : "condition"); });
    },
    condition: function () {
      say("What **condition** is it in?");
      chips([{ label: "New", value: "new" }, { label: "Used - good", value: "used-good" }, { label: "Used - fair", value: "used-fair" }], function (v) { W.d.condition = v; go("listing"); });
    },
    listing: function () {
      say("Are you **selling** it, **renting** it out, or both?");
      chips([{ label: "Sale only", value: "sale" }, { label: "Rent only", value: "rent" }, { label: "Rent & sale", value: "both" }], function (v) { W.d.listing = v; go(v === "rent" ? "rent" : "price"); });
    },
    service_unit: function () {
      say("How do you **charge** for it?");
      chips([{ label: "One-time (flat)", value: "flat" }, { label: "Per hour", value: "hour" }, { label: "Per day", value: "day" }, { label: "Per week", value: "week" }], function (v) { W.d.unit = v; go("price"); });
    },
    price: function () { W.want = "price"; say("What's the **price** in naira? (for example *15000*)"); hint("Price in ₦…"); },
    rent: function () {
      W.want = "rent"; say("What's the **rent** in naira, and per day or per week? (for example *3000 a day*)"); hint("Rent, e.g. 3000 a day…");
    },
    billing: function () {
      say("How would you like to pay Levromart for this listing?\n\n- **Commission:** 3% of each completed sale, nothing up front.\n- **Monthly:** ₦999 a month for this listing, no commission (paid through Paystack).");
      chips([{ label: "Commission (3%)", value: "commission" }, { label: "Monthly (₦999)", value: "monthly" }], function (v) { W.d.billing = v; go(W.d.service ? "photos" : "delivery"); });
    },
    delivery: function () {
      say("How does **delivery** work?");
      chips([{ label: "Free delivery", value: "free" }, { label: "Flat fee", value: "flat" }, { label: "By distance (per km)", value: "distance" }], function (v) {
        W.d.delivery = v;
        if (v === "flat") { W.want = "fee"; say("How much is the delivery fee? (₦)"); hint("Delivery fee in ₦…"); }
        else if (v === "distance") { W.want = "perkm"; say("How much per kilometre? (₦, at most 1,000)"); hint("₦ per km…"); }
        else go("stock");
      });
    },
    stock: function () {
      say("How many do you have in **stock**?");
      chips([{ label: "Just 1", value: 1 }, { label: "2-5 (I'll type it)", value: "type" }, { label: "Don't track stock", value: 0 }], function (v) {
        if (v === "type") { W.want = "stock"; hint("How many?"); say("Type the number."); return; }
        W.d.stock = v; go("photos");
      });
    },
    photos: function () {
      say("Great, that's everything except the **photos**. I'm opening your listing with all of this filled in. Tap **Add photos** (I've highlighted it), check the details, then save.");
      var d = W.d; W = null; resetHint();
      setTimeout(function () { fillForm(d); }, 700);
    }
  };
  function go(step) { if (!W) return; W.step = step; W.want = null; resetHint(); STEPS[step](); }
  function start() { W = { d: {}, step: "type", want: null }; STEPS.type(); }
  function closeLevi() { try { var p = document.getElementById("aiChatPanel"); if (p && !p.classList.contains("hidden") && typeof toggleAiChat === "function") toggleAiChat(); } catch (_) {} }
  async function fillForm(d) {
    closeLevi();
    try { if (typeof navigate === "function" && typeof currentView !== "undefined" && currentView !== "vendorProducts") await navigate("vendorProducts"); } catch (_) {}
    window.__lfWant = d.service ? "service" : "product";
    try { await window.openAddProductModal(); } catch (_) { return; }
    var set = function (id, v, fire) { var el = document.getElementById(id); if (!el || v == null) return; if (el.type === "checkbox") el.checked = !!v; else el.value = v; if (fire) { try { el.dispatchEvent(new Event(fire, { bubbles: true })); } catch (_) {} } };
    setTimeout(function () {
      try {
        set("prodIsService", d.service, "change");
        set("prodName", d.name, "input");
        if (d.desc) set("prodDesc", d.desc, "input");
        if (d.sector) { set("prodSector", d.sector); try { loadProdCategoriesForSector(d.category || ""); } catch (_) {} }
        if (d.category) set("prodCategory", d.category, "change");
        if (!d.service && d.condition) set("prodCondition", d.condition, "change");
        if (!d.service && d.listing) set("prodListingType", d.listing, "change");
        if (d.service && d.unit) set("prodServiceUnit", d.unit, "change");
        if (d.price) set("prodSalePrice", d.price, "input");
        if (d.rent) { set("prodRentalRate", d.rent, "input"); set("prodRateUnit", d.rentUnit || "day", "change"); }
        if (d.billing) set("prodBillingModel", d.billing, "change");
        if (d.delivery) { set("prodDeliveryMode", d.delivery, "change"); if (d.fee) set("prodDeliveryFee", d.fee, "input"); if (d.perkm) set("prodDeliveryPerKm", d.perkm, "input"); }
        if (d.stock > 0) { set("prodTrackQuantity", true, "change"); set("prodQtyTotal", d.stock, "input"); }
        try { updateProductFormFields(); } catch (_) {}
        try { updateProductSaveButtonLabel(); } catch (_) {}
      } catch (_) {}
      var drop = document.getElementById("photoDropzone");
      if (drop) {
        try { drop.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (_) {}
        drop.classList.add("lvw-glow"); setTimeout(function () { drop.classList.remove("lvw-glow"); }, 6000);
      }
    }, 450);
  }
  // answers typed while the walk-through waits for one
  function typed(text) {
    var t = String(text).trim(), d = W.d;
    if (/^(cancel|stop|never ?mind|quit)$/i.test(t)) { W = null; resetHint(); return "Okay, I've stopped. Nothing was saved."; }
    switch (W.want) {
      case "name": if (t.length < 2) return "Please type the name."; d.name = t.slice(0, 120); setTimeout(function () { go("desc"); }, 50); return "**" + d.name + "**, nice.";
      case "desc": d.desc = t.slice(0, 2000); setTimeout(function () { go("sector"); }, 50); return "Got it.";
      case "price": { var p = money(t); if (!p) return "Please type the price as a number, for example *15000*."; d.price = p; setTimeout(function () { go(d.listing === "both" ? "rent" : "billing"); }, 50); return "₦" + p.toLocaleString("en-NG") + ", noted."; }
      case "rent": { var r = money(t); if (!r) return "Please type the rent as a number, for example *3000 a day*."; d.rent = r; d.rentUnit = /week/i.test(t) ? "week" : "day"; setTimeout(function () { go("billing"); }, 50); return "₦" + r.toLocaleString("en-NG") + " a " + d.rentUnit + ", noted."; }
      case "fee": { var f = money(t); if (f == null) return "Please type the fee as a number."; d.fee = f; setTimeout(function () { go("stock"); }, 50); return "Delivery ₦" + f.toLocaleString("en-NG") + "."; }
      case "perkm": { var k = money(t); if (!k) return "Please type a number, for example *200*."; d.perkm = Math.min(1000, k); setTimeout(function () { go("stock"); }, 50); return "₦" + d.perkm + " per km."; }
      case "stock": { var s = parseInt(t.replace(/\D/g, ""), 10); if (!s) return "Please type a number."; d.stock = s; setTimeout(function () { go("photos"); }, 50); return s + " in stock."; }
    }
    return null;
  }
  // ---- what's selling, and how the shop is doing ----
  async function insights(mine) {
    if (mine && isVendor()) {
      try {
        var since = new Date(Date.now() - 30 * 864e5).toISOString();
        var r = await sb.from("orders").select("total_amount,status,created_at").eq("vendor_id", vendor.id).gte("created_at", since).limit(500);
        var rows = (r && r.data) || [], done = rows.filter(function (o) { return o.status === "completed"; });
        var total = done.reduce(function (a, o) { return a + Number(o.total_amount || 0); }, 0);
        var week = done.filter(function (o) { return Date.parse(o.created_at) > Date.now() - 7 * 864e5; }).reduce(function (a, o) { return a + Number(o.total_amount || 0); }, 0);
        return "**Your shop, last 30 days**\n\n- Orders: **" + rows.length + "** (" + done.length + " completed)\n- Sales completed: **" + (typeof naira === "function" ? naira(total) : "₦" + total) + "**\n- This week: **" + (typeof naira === "function" ? naira(week) : "₦" + week) + "**\n\nTip: shops with 3 or more clear photos and a short description get more orders. Ask me *what's selling on Levromart* to see what shoppers want right now.";
      } catch (_) { return "I couldn't read your orders just now. Please try again in a moment."; }
    }
    var cache = null; try { cache = typeof readOfflineHomeCache === "function" ? readOfflineHomeCache() : null; } catch (_) {}
    var trend = (cache && cache.trending) || [];
    if (!trend.length) { var live = await latestProducts(30); trend = live; }
    if (!trend.length) return "I could not load Levromart's listings just now. Please try again in a moment.";
    var cats = {}, catName = {};
    ((cache && cache.categories) || window.__categories || []).forEach(function (c) { catName[c.id] = c.name; });
    trend.forEach(function (p) { var k = p.category_id; if (!k) return; cats[k] = (cats[k] || 0) + 1; });
    var topCats = Object.keys(cats).sort(function (a, b) { return cats[b] - cats[a]; }).slice(0, 4).map(function (k) { return catName[k] || "Other"; });
    var topItems = trend.slice(0, 5).map(function (p) { return "- " + p.name + (p.sale_price != null ? " · " + (typeof naira === "function" ? naira(p.sale_price) : "₦" + p.sale_price) : ""); });
    return "**What's selling on Levromart right now**\n\n" + (topCats.length ? "Most popular categories: **" + topCats.join(", ") + "**.\n\n" : "") + "Trending items:\n" + topItems.join("\n") + "\n\nWant to add something in one of these? Say *add a product* and I'll walk you through it.";
  }
  // the newest active listings, read straight from the catalogue (no need to have opened the Home page)
  async function latestProducts(n) {
    try {
      var r = await sb.from("products").select("id,name,sale_price,category_id,photos").eq("status", "active").order("created_at", { ascending: false }).limit(n || 30);
      return (r && r.data) || [];
    } catch (_) { return []; }
  }
  // ---- a shop's own reviews, and what buyers want: answered from Levromart's data, never with product suggestions ----
  function nf(n) { return Number(n || 0).toLocaleString("en-NG"); }
  async function myReviews() {
    if (!isVendor()) return "Only shops have reviews. Open your shop first and I'll show you what customers say.";
    try {
      var r = await sb.from("reviews").select("rating,comment,created_at,buyer_name").eq("vendor_id", vendor.id).order("created_at", { ascending: false }).limit(200);
      var rows = (r && r.data) || [];
      if (!rows.length) return "**No reviews yet** ⭐\n\nCustomers can review your shop after an order is completed. Deliver quickly, keep them updated in chat, and ask happy buyers to leave a review: it helps you rank higher and win Vendor of the week.";
      var avg = rows.reduce(function (a, x) { return a + Number(x.rating || 0); }, 0) / rows.length, dist = [0, 0, 0, 0, 0, 0];
      rows.forEach(function (x) { dist[Math.max(1, Math.min(5, Number(x.rating) || 0))]++; });
      var recent = rows.filter(function (x) { return x.comment && String(x.comment).trim(); }).slice(0, 4).map(function (x) {
        return "- " + "★".repeat(Number(x.rating) || 0) + " \"" + String(x.comment).trim().slice(0, 180) + "\" (" + String(x.buyer_name || "A buyer").split(/\s+/)[0] + ")"; });
      var low = rows.filter(function (x) { return Number(x.rating) <= 2; }).length;
      return ["**What customers say about your shop** ⭐", "",
        "- Average rating: **" + avg.toFixed(1) + " / 5** from **" + rows.length + "** review" + (rows.length === 1 ? "" : "s"),
        "- 5★ " + dist[5] + " · 4★ " + dist[4] + " · 3★ " + dist[3] + " · 2★ " + dist[2] + " · 1★ " + dist[1],
        "", recent.length ? "**Latest comments**\n" + recent.join("\n") : "Nobody has written a comment yet, only star ratings.",
        "", low ? "Tip: " + low + " low rating" + (low === 1 ? "" : "s") + ". Reply to unhappy buyers quickly in chat and fix the problem; good service turns ratings around." : "Great work. Keep it up! 🎉"].join("\n");
    } catch (_) { return "I couldn't read your reviews just now. Please try again in a moment."; }
  }
  async function buyerDemand() {
    try {
      var since = new Date(Date.now() - 30 * 864e5).toISOString();
      var rq = await sb.from("equipment_requests").select("title,created_at,status").gte("created_at", since).order("created_at", { ascending: false }).limit(60);
      var reqs = ((rq && rq.data) || []).map(function (x) { return String(x.title || "").trim(); }).filter(Boolean);
      var pv = await sb.from("products").select("name,view_count").eq("status", "active").order("view_count", { ascending: false }).limit(8);
      var top = ((pv && pv.data) || []).filter(function (x) { return Number(x.view_count) > 0; });
      var mine = [];
      if (isVendor()) {
        var mv = await sb.from("products").select("name,view_count").eq("vendor_id", vendor.id).neq("status", "deleted").order("view_count", { ascending: false }).limit(3);
        mine = ((mv && mv.data) || []).filter(function (x) { return Number(x.view_count) > 0; });
      }
      var out = ["**What buyers are looking for** 🔎", ""];
      if (reqs.length) { var seen = {}, uniq = reqs.filter(function (t) { var k = t.toLowerCase(); if (seen[k]) return false; seen[k] = 1; return true; }); out.push("**Asked for in Requests (last 30 days)**"); uniq.slice(0, 8).forEach(function (t) { out.push("- " + t); }); out.push(""); }
      if (top.length) { out.push("**Most viewed on Levromart**"); top.forEach(function (x) { out.push("- " + x.name + " · " + nf(x.view_count) + " views"); }); out.push(""); }
      if (mine.length) { out.push("**Your most viewed listings**"); mine.forEach(function (x) { out.push("- " + x.name + " · " + nf(x.view_count) + " views"); }); out.push(""); }
      if (!reqs.length && !top.length) return "Not enough buyer activity yet to show what people are looking for. Check back in a few days.";
      out.push(isVendor() ? "If you have any of the requested items, list them or reply to the request on the **Requests** page; buyers there are ready to buy." : "Can't find something? Post a request and shops will come to you.");
      return out.join("\n");
    } catch (_) { return "I couldn't read that just now. Please try again in a moment."; }
  }
  // ---- how Levromart works: short, accurate answers to the common questions ----
  window.lvLeviFaq = function (raw) {
    var q = String(raw || "").toLowerCase();
    var ask = /\b(how|why|when|what|where|can i|do i|will i|is there|explain|tell me)\b|\?\s*$/.test(q);
    if (!ask) return null;
    if (/\b(get paid|getting paid|receive (my )?(money|payment)|payout|my earnings|withdraw (my )?(earnings|money|sales)|when (do|will) i get (my )?money|paid for (my )?orders?)\b/.test(q)) return [
      "**How you get paid on Levromart** 💰", "",
      "1. **The buyer pays Levromart first**, in full, when they order (card, bank transfer or their Levromart wallet). You'll see the order as paid.",
      "2. **You deliver or hand it over**, then mark the order as handed over.",
      "3. **The money becomes yours** when the buyer taps *I have received it*, or automatically **24 hours** after delivery if they do nothing. Levromart keeps **3%** commission; the rest is yours.",
      "4. **Move it to your wallet** from your Wallet. Money that is more than 24 hours old moves at once; newer money is checked by Levromart first.",
      "5. **Withdraw to your bank** from the wallet (minimum ₦100). You need your 6-digit wallet PIN, and the small transfer charge is shown before you confirm.", "",
      "Add your bank account in the Wallet first. Changing it needs your password, to keep your money safe."].join("\n");
    if (/\b(refunds?|money back|cancel (my|an|the) order|return (an|my|the) (item|order))\b/.test(q)) return [
      "**Refunds** 🔄", "",
      "- Ask for a refund **within 24 hours** of placing the order, from the order page.",
      "- The shop accepts or declines (and must say why). An accepted refund goes back to your **Levromart wallet** (or your card).",
      "- After 24 hours a refund can't be requested, but you can still **raise a dispute** if what arrived is wrong, and Levromart will look into it."].join("\n");
    if (/\b(commission|levromart('s)? (fee|cut|share)|(how much )?(does )?levromart (take|charge)s?|listing fees?|monthly fee)\b/.test(q)) return [
      "**What Levromart charges** 🧾", "",
      "- **Commission:** 3% of each sale, taken when the buyer pays. You receive the other 97%.",
      "- **Or monthly:** ₦999 per listing a month instead of commission, for listings you choose.",
      "- Wallet transfers and bank withdrawals have Paystack's small fee, always shown before you confirm."].join("\n");
    if (/\b(set (up )?(my )?delivery|delivery (settings|options|fee)|charge (for )?delivery|free delivery)\b/.test(q) && /\b(how|where|can i|set|change)\b/.test(q)) return [
      "**Setting your delivery** 🚚", "",
      "- Open **Seller hub → Delivery settings** (or the Delivery part of any listing).",
      "- Choose **Free**, a **Flat fee**, or a **fee per km**, and which campuses each one is for: your campus, chosen campuses, or all the others.",
      "- Buyers choose their campus at checkout and see the right fee. Pickup is always available."].join("\n");
    if (/\b(wallet|send money|transfer money|add money|top ?up|my pin|wallet pin)\b/.test(q) && !/\b(balance|how much (is|do i have|money))\b/.test(q)) return [
      "**Your Levromart wallet** 👛", "",
      "- **Add money** with Paystack, **send** to anyone by their @tag, **pay** for orders, and **withdraw** to your bank.",
      "- Every movement of money needs your **6-digit wallet PIN**. Levromart will never ask you for it.",
      "- Any fee (Paystack's) is shown before you confirm."].join("\n");
    if (/\b(vendor of the week|points|leaderboard)\b/.test(q)) return [
      "**Vendor of the week** 🏆", "",
      "Shops earn points for completed sales and good reviews. The shop with the most points on each campus becomes **Vendor of the week** and is shown on Home."].join("\n");
    return null;
  };
  // ---- "add X and Y to my cart": find each item by name and put it in the cart, then say exactly what happened ----
  var cartWanted = 0;   // set when Levi has just asked "what would you like to add?"
  async function addNamed(text) {
    var parts = String(text || "").replace(/\b(to|in|into)\s+(my\s+|the\s+)?(cart|basket)\b/ig, "").replace(/^\s*(please\s+)?(can you\s+)?(add|put|get me|buy)\s+/i, "")
      .split(/\s*(?:,|&|\+|\band\b|\balso\b)\s*/i).map(function (x) { return x.replace(/^(the|a|an|some|one)\s+/i, "").replace(/[.!?]+$/, "").trim(); }).filter(function (x) { return x.length > 1; }).slice(0, 8);
    if (!parts.length) return "Tell me the name of what you want, for example *Stanley cup and power bank*.";
    var added = [], missed = [], own = [];
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i], qty = 1, m = part.match(/^(\d{1,2})\s*x?\s+(.+)$/i);
      if (m) { qty = Math.max(1, Math.min(20, parseInt(m[1], 10))); part = m[2]; }
      var safe = part.replace(/[%_,()]/g, " ").trim(), rows = [];
      try {
        var r = await sb.from("products").select("id,name,sale_price,discount_price,vendor_id,is_service,listing_type").eq("status", "active").ilike("name", "%" + safe + "%").limit(8);
        rows = (r && r.data) || [];
        if (!rows.length) {   // every word must be in the name, in any order
          var words = safe.split(/\s+/).filter(function (w) { return w.length > 2; }).map(function (w) { return w.length > 3 ? w.replace(/(es|s)$/i, "") : w; });   // "cups" finds "Cup"
          if (words.length) {
            var q = sb.from("products").select("id,name,sale_price,discount_price,vendor_id,is_service,listing_type").eq("status", "active");
            words.forEach(function (w) { q = q.ilike("name", "%" + w + "%"); });
            var r2 = await q.limit(8); rows = (r2 && r2.data) || [];
          }
        }
      } catch (_) {}
      rows = rows.filter(function (p) { return !p.is_service && p.sale_price != null && p.listing_type !== "rent"; });
      if (!rows.length) { missed.push(part); continue; }
      var low = safe.toLowerCase();
      rows.sort(function (a, b) { var ea = String(a.name).toLowerCase() === low ? 0 : 1, eb = String(b.name).toLowerCase() === low ? 0 : 1; return ea - eb || String(a.name).length - String(b.name).length; });
      var p = rows[0];
      try { if (typeof isOwnVendorId === "function" && isOwnVendorId(p.vendor_id)) { own.push(p.name); continue; } } catch (_) {}
      var res = null;
      try { res = window.levroData && levroData.cart ? await levroData.cart.add(p.id, qty, null) : null; } catch (e) { res = { error: e }; }
      if (res && res.error) { missed.push(part); continue; }
      if (!res) { try { await addToCart(p.id, qty); } catch (_) { missed.push(part); continue; } }
      added.push((qty > 1 ? qty + " × " : "") + "**" + p.name + "** · " + (typeof naira === "function" ? naira(p.discount_price != null ? p.discount_price : p.sale_price) : "₦" + p.sale_price));
    }
    if (added.length) {
      try { if (typeof buyerCartCount !== "undefined") buyerCartCount += added.length; } catch (_) {}
      try { if (typeof updateCartFab === "function") updateCartFab(); if (window.lmSyncCartCount) window.lmSyncCartCount(); } catch (_) {}
    }
    var out = [];
    if (added.length) out.push("Added to your cart ✅\n\n" + added.map(function (x) { return "- " + x; }).join("\n"));
    if (own.length) out.push("You can't buy from your own shop, so I left out: " + own.map(function (x) { return "**" + x + "**"; }).join(", ") + ".");
    if (missed.length) out.push("I couldn't find " + missed.map(function (x) { return "**" + x + "**"; }).join(", ") + " on Levromart. Check the spelling, or tell me a bit more about it.");
    if (added.length) out.push("Say *open my cart* when you're ready to check out.");
    return out.join("\n\n");
  }
  // "add to my cart" on its own: ask what, and suggest things to pick from
  async function askWhatToAdd() {
    cartWanted = Date.now();
    try { hint("What should I add? Type the name…"); } catch (_) {}
    var list = (await latestProducts(12)).slice(0, 6);
    setTimeout(function () {
      if (!list.length) return;
      var host = lastBubble(); if (!host) return;
      var wrap = document.createElement("div"); wrap.className = "lvw-pcards";
      list.forEach(function (p) {
        var img = Array.isArray(p.photos) && p.photos[0] ? p.photos[0] : "";
        var price = p.sale_price != null ? (typeof naira === "function" ? naira(p.sale_price) : "₦" + p.sale_price) : "";
        var c = document.createElement("div"); c.className = "lvw-pcard";
        c.innerHTML = '<div class="lvw-pimg">' + (img ? '<img src="' + esc(img) + '" alt="" loading="lazy" draggable="false">' : "") + '</div><div class="lvw-pname">' + esc(String(p.name || "")) + '</div><div class="lvw-pprice">' + esc(price) + '</div><button type="button" class="lvw-padd">Add to cart</button>';
        var b = c.querySelector(".lvw-padd");
        b.onclick = async function () {
          if (b.disabled) return; b.disabled = true; b.textContent = "Adding…";
          try { await addToCart(p.id, 1); b.textContent = "Added ✓"; b.classList.add("done"); }
          catch (_) { b.disabled = false; b.textContent = "Add to cart"; }
        };
        wrap.appendChild(c);
      });
      host.appendChild(wrap);
      try { var box = document.getElementById("aiChatMessages"); box.scrollTop = box.scrollHeight; } catch (_) {}
    }, 350);
  }
  // "how far is <shop> from me" / "how long would delivery from <shop> take"
  async function distanceAnswer(text) {
    var q = String(text || "");
    var m = q.match(/\b(?:from|to|is|at|for)\s+([A-Za-z0-9&'’.\- ]{3,50}?)\s*(?:\?|\.|!|$|from me|to me|away|take|long|far)/i);
    var guess = m && m[1] ? m[1].replace(/\b(the|shop|store|vendor|my|me|delivery|distance)\b/gi, "").trim() : "";
    var ctx = window.__lvLastVendorName || "";
    var name = guess.length >= 3 ? guess : ctx;
    if (!name) return "Which shop do you mean? Tell me its name, for example *How far is Dayo Stores from me?*";
    var r = await sb.from("vendors").select("id,business_name,lat,lng,city").ilike("business_name", "%" + name.replace(/[%_]/g, "") + "%").limit(1);
    var v = r && r.data && r.data[0];
    if (!v) return "I could not find a shop called **" + name + "**. Check the spelling, or search for it on the Vendors page.";
    window.__lvLastVendorName = v.business_name;
    var loc = null; try { loc = typeof buyerLocation !== "undefined" ? buyerLocation : null; } catch (_) {}
    if (v.lat == null || v.lng == null) return "**" + v.business_name + "** has not pinned its location yet" + (v.city ? " (it is in " + v.city + ")" : "") + ", so I cannot work out the distance.";
    if (!loc || loc.lat == null) return "Switch on your location (Settings → Location) and I will tell you how far **" + v.business_name + "** is" + (v.city ? ". It is in " + v.city : "") + ".";
    var km = haversineKm(loc.lat, loc.lng, v.lat, v.lng), road = km * 1.3;
    var mins = function (speed, extra) { return Math.max(5, Math.round(road / speed * 60 + (extra || 0))); };
    var dist = typeof formatDistanceKm === "function" ? formatDistanceKm(km) : km.toFixed(1) + " km";
    return "**" + v.business_name + "** is about **" + dist + "** from you in a straight line, roughly " + road.toFixed(1) + " km by road.\n\n- Delivery by bike or car: about **" + mins(22, 10) + " minutes** once the shop hands it over\n- Walking: about **" + mins(5) + " minutes**\n\nThese are estimates; traffic and how soon the shop has the order ready change the real time.";
  }
  // ---- plugging into Levi ----
  var orig = window.resolveLeviLocalAction;
  if (typeof orig === "function" && !orig.__lvVendor) {
    var f = async function (text) {
      var q = String(text || "").toLowerCase();
      if (W && W.want) { var ans = typed(text); if (ans) return { handled: true, reply: ans }; }
      // questions about how Levromart works are answered right away, never turned into a product search
      if (/\bmy reviews?\b|\b(customers?|buyers?|people)\b[\s\S]{0,30}\b(say(ing)?|think|feel)\b[\s\S]{0,30}\b(my (shop|store|business|products?)|about me)\b/.test(q)) return { handled: true, reply: await myReviews() };
      if (/\b(buyers?|customers?|people|students?)\b[\s\S]{0,25}\b(search(ing)?|looking for|asking for|want(ing)?|requesting)\b|\bwhat('s| is) in demand\b/.test(q)) return { handled: true, reply: await buyerDemand() };
      var faq = window.lvLeviFaq ? window.lvLeviFaq(q) : null;
      if (faq) { cartWanted = 0; return { handled: true, reply: faq }; }
      // the answer to "what would you like to add to your cart?" is the thing to add, not a new search
      if (cartWanted && Date.now() - cartWanted < 10 * 60000 && !/\?\s*$/.test(q) && !/\b(what|which|how|why|where|who|when|show|find|search|cheap|best)\b/.test(q)) {
        cartWanted = 0; return { handled: true, reply: await addNamed(text) };
      }
      cartWanted = 0;
      // "add <things> to my cart" in one go
      var am = q.match(/^\s*(?:please\s+)?(?:can you\s+)?(?:add|put)\s+(.{2,200}?)\s+(?:to|in|into)\s+(?:my\s+|the\s+)?(?:cart|basket)\s*[.!?]*\s*$/i);
      if (am && !/^(something|an item|items?|a product|products|it|them|this|that|these|those|all of them|both)$/i.test(am[1].trim())) return { handled: true, reply: await addNamed(am[1]) };
      if (/^\s*(please\s+)?(can you\s+)?add\s+(something|an item|items?|a product|products)?\s*(to|in|into)\s+(my\s+|the\s+)?(cart|basket)\s*[.!?]*\s*$/i.test(q)) {
        return { handled: true, reply: "What would you like to add to your cart? Tell me the name, or tap one of these:", afterReply: askWhatToAdd };
      }
      if (isVendor() && /\b(add|create|list|upload|post|sell)\b[\s\S]{0,30}\b(product|item|listing|service|something|this)\b|\bnew (product|listing)\b/.test(q) && !/\bcart\b/.test(q)) {
        return { handled: true, reply: "Sure, I'll help you list it.", afterReply: start };
      }
      if (/\b(how far|distance|how long|how many (minutes|km|kilomet)|delivery time|how soon|far from me|close to me)\b/.test(q) && /\b(shop|store|vendor|deliver|delivery|from me|away|far|distance|take|long)\b/.test(q)) return { handled: true, reply: await distanceAnswer(text) };
      if (/\b(what('s| is| are)?|which)\b[\s\S]{0,20}\b(selling|sells|trending|popular|in demand|hot)\b|\bbest[- ]?sell/.test(q)) return { handled: true, reply: await insights(false) };
      if (isVendor() && /\bhow('s| is)\b[\s\S]{0,20}\bmy (shop|store|sales|business|market)\b|\bmy (sales|stats|performance)\b/.test(q)) return { handled: true, reply: await insights(true) };
      return orig.apply(this, arguments);
    };
    f.__lvVendor = true; window.resolveLeviLocalAction = f;
    try { resolveLeviLocalAction = f; } catch (_) {}
  }
  // vendors: ready-made suggestions when Levi opens with an empty chat, and a helpful placeholder
  function offer() {
    resetHint();
    var box = document.getElementById("aiChatMessages"); if (!box || box.querySelector(".lvw-vsug")) return;
    var row = document.createElement("div"); row.className = "lvw-chips lvw-vsug";
    (isVendor() ? [["Add to cart", "Add to cart"], ["Add a listing for me", "Add a listing"], ["What's selling on Levromart?", "What's selling on Levromart?"], ["How is my shop doing?", "How is my shop doing?"]] : [["Add to cart", "Add to cart"], ["What's selling on Levromart?", "What's selling on Levromart?"]]).forEach(function (s) {
      var b = document.createElement("button"); b.type = "button"; b.className = "lvw-chip"; b.textContent = s[0];
      b.onclick = function () { var i = document.getElementById("aiChatInput"); if (!i) return; i.value = s[1]; row.remove(); try { sendAiChatMessage(); } catch (_) {} };
      row.appendChild(b);
    });
    box.appendChild(row);
  }
  document.addEventListener("click", function (e) { if (e.target && e.target.closest && e.target.closest("#aiChatFab")) setTimeout(offer, 450); }, true);
  setTimeout(resetHint, 3000);
})();

/* ===== Levi's photo touch-up: in the add / edit listing form, "Enhance with Levi" brightens and balances the colours of
   the new photos, sharpens them a little and frames wide or tall ones neatly on a square. "Undo" brings the originals back. ===== */
(function () {
  "use strict";
  function load(file) { return new Promise(function (res, rej) { var u = URL.createObjectURL(file), i = new Image(); i.onload = function () { res({ img: i, url: u }); }; i.onerror = rej; i.src = u; }); }
  function pct(hist, total, p) { var s = 0, t = total * p; for (var i = 0; i < 256; i++) { s += hist[i]; if (s >= t) return i; } return 255; }
  async function enhance(file) {
    var L = await load(file), img = L.img;
    var max = 1600, sc = Math.min(1, max / Math.max(img.width, img.height));
    var w = Math.round(img.width * sc), h = Math.round(img.height * sc);
    var c = document.createElement("canvas"); c.width = w; c.height = h;
    var x = c.getContext("2d"); x.drawImage(img, 0, 0, w, h);
    var data = x.getImageData(0, 0, w, h), p = data.data, n = w * h;
    // 1) levels: stretch the brightness range (0.5% / 99.5%) and balance the colours a little (grey world, half strength)
    var hist = new Uint32Array(256), sr = 0, sg = 0, sb2 = 0;
    for (var i = 0; i < p.length; i += 4) { var lum = (p[i] * 299 + p[i + 1] * 587 + p[i + 2] * 114) / 1000 | 0; hist[lum]++; sr += p[i]; sg += p[i + 1]; sb2 += p[i + 2]; }
    var lo = pct(hist, n, 0.005), hi = pct(hist, n, 0.995); if (hi - lo < 40) { lo = Math.max(0, lo - 10); hi = Math.min(255, hi + 10); }
    var avg = (sr + sg + sb2) / 3 / n, kr = 1 + ((avg / (sr / n)) - 1) * 0.5, kg = 1 + ((avg / (sg / n)) - 1) * 0.5, kb = 1 + ((avg / (sb2 / n)) - 1) * 0.5;
    var span = 255 / Math.max(1, hi - lo);
    var lut = new Uint8ClampedArray(256);
    for (var v = 0; v < 256; v++) { var y = (v - lo) * span / 255; y = Math.min(1, Math.max(0, y)); y = y + 0.08 * Math.sin(Math.PI * y) * (y - 0.5) * -1 + 0.04 * Math.sin(Math.PI * y); lut[v] = y * 255; }
    for (var j = 0; j < p.length; j += 4) {
      var r = lut[Math.min(255, p[j] * kr | 0)], g = lut[Math.min(255, p[j + 1] * kg | 0)], b = lut[Math.min(255, p[j + 2] * kb | 0)];
      // 2) a touch more colour (vibrance: muted colours more than bright ones)
      var m = (r + g + b) / 3, mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx ? (mx - mn) / mx : 0, k = 0.18 * (1 - sat);
      p[j] = r + (r - m) * k; p[j + 1] = g + (g - m) * k; p[j + 2] = b + (b - m) * k;
    }
    x.putImageData(data, 0, 0);
    // 3) a little sharper (unsharp mask from a softened copy)
    var soft = document.createElement("canvas"); soft.width = w; soft.height = h;
    var sx = soft.getContext("2d"); sx.filter = "blur(1.2px)"; sx.drawImage(c, 0, 0);
    var a = x.getImageData(0, 0, w, h), bl = sx.getImageData(0, 0, w, h).data, q = a.data;
    for (var z = 0; z < q.length; z += 4) { q[z] += (q[z] - bl[z]) * 0.45; q[z + 1] += (q[z + 1] - bl[z + 1]) * 0.45; q[z + 2] += (q[z + 2] - bl[z + 2]) * 0.45; }
    x.putImageData(a, 0, 0);
    // 4) framing: a wide or tall photo sits in the middle of a square on a soft, blurred copy of itself
    var out = c, ratio = w / h;
    if (false) {   // framing on a blurred square was removed: the photo keeps its own shape and edges
      var S = Math.max(w, h), o = document.createElement("canvas"); o.width = o.height = S;
      var ox = o.getContext("2d");
      ox.filter = "blur(28px) brightness(1.08) saturate(1.1)"; ox.drawImage(c, -S * 0.1, -S * 0.1, S * 1.2, S * 1.2); ox.filter = "none";
      ox.fillStyle = "rgba(255,255,255,.18)"; ox.fillRect(0, 0, S, S);
      ox.shadowColor = "rgba(0,0,0,.22)"; ox.shadowBlur = S * 0.03; ox.shadowOffsetY = S * 0.012;
      ox.drawImage(c, (S - w) / 2, (S - h) / 2);
      out = o;
    }
    URL.revokeObjectURL(L.url);
    var blob = await new Promise(function (res) { out.toBlob(res, "image/jpeg", 0.9); });
    var name = String(file.name || "photo").replace(/\.[^.]+$/, "") + "-enhanced.jpg";
    return new File([blob], name, { type: "image/jpeg", lastModified: Date.now() });
  }
  var originals = null, enhancedList = null;
  function redraw() {
    try { syncNewProductPhotoInput(); } catch (_) {}
    var wrap = document.getElementById("prodNewPhotoPreviews"); if (wrap) wrap.innerHTML = "";
    try { renderNewProductPhotos(); } catch (_) {}
    try { renderProductDisplayPicture(); } catch (_) {}
    try { renderProductVariantPricing(); } catch (_) {}
  }
  function bar() {
    var grid = document.getElementById("prodNewPhotoPreviews"); if (!grid) return;
    var files = window.__newProductPhotoFiles || [];
    var el = document.getElementById("lvEnhanceBar");
    if (!files.length) { if (el) el.remove(); originals = null; return; }
    if (originals && files !== enhancedList) originals = null;   // photos were added or removed since: a fresh start
    if (!el) {
      el = document.createElement("div"); el.id = "lvEnhanceBar"; el.className = "lv-enh";
      grid.parentNode.insertBefore(el, grid.nextSibling);
      el.addEventListener("click", async function (e) {
        var b = e.target.closest("button"); if (!b || b.disabled) return;
        if (b.dataset.act === "undo") { if (originals) { window.__newProductPhotoFiles = originals; originals = null; redraw(); } paint(); return; }
        b.disabled = true; b.innerHTML = '<span class="lvthink-mark lv-enh-spin" aria-hidden="true"></span> Enhancing…';
        try {
          var src = (window.__newProductPhotoFiles || []).slice(), out = [];
          for (var i = 0; i < src.length; i++) out.push(/-enhanced\.jpg$/.test(src[i].name) ? src[i] : await enhance(src[i]));
          originals = src; window.__newProductPhotoFiles = enhancedList = out; redraw();
          if (typeof showToast === "function") showToast("Photos enhanced. Tap Undo to get the originals back.", "success");
        } catch (err) { if (typeof showToast === "function") showToast("Levi could not enhance these photos.", "error"); }
        paint();
      });
    }
    paint();
    function paint() {
      var state = originals ? "undo" : "go";
      if (el.__state === state && !el.querySelector("button[disabled]")) return;   // nothing changed: do not redraw (no loop)
      el.__state = state;
      el.innerHTML = originals
        ? '<span class="lv-enh-t"><i class="fa-solid fa-wand-magic-sparkles"></i> Enhanced by Levi</span><button type="button" data-act="undo" class="lv-enh-undo"><i class="fa-solid fa-rotate-left"></i> Undo</button>'
        : '<span class="lv-enh-t"><i class="fa-solid fa-wand-magic-sparkles"></i> Make your photos look their best</span><button type="button" data-act="go" class="lv-enh-go"><i class="fa-solid fa-wand-magic-sparkles"></i> Enhance with Levi</button>';
    }
  }
  var t = 0;
  new MutationObserver(function () { if (t) return; t = setTimeout(function () { t = 0; bar(); }, 120); }).observe(document.body, { childList: true, subtree: true });
  window.lvEnhancePhoto = enhance;   // for checking on a preview
})();

/* ===== Pictures never open the browser's image menu ("Copy image / Download image / Share image / Open in Chrome") when they
   are long-pressed or right-clicked, and cannot be dragged out. Everything else (message long-press, text selection, buttons)
   keeps working: the event is only cancelled for pictures, never stopped. ===== */
(function () {
  "use strict";
  var PIC = "img, picture, canvas, video, svg image";
  function isPic(t) { try { return !!(t && t.closest && t.closest(PIC)); } catch (_) { return false; } }
  document.addEventListener("contextmenu", function (e) { if (isPic(e.target)) e.preventDefault(); }, true);
  document.addEventListener("dragstart", function (e) { if (isPic(e.target)) e.preventDefault(); }, true);
  // pictures added later: no drag, and no "hold to save" on iPhone either
  function mark(root) { (root.querySelectorAll ? root.querySelectorAll("img:not([data-nodrag])") : []).forEach(function (i) { i.setAttribute("draggable", "false"); i.setAttribute("data-nodrag", "1"); }); }
  mark(document);
  new MutationObserver(function (list) { list.forEach(function (m) { m.addedNodes.forEach(function (n) { if (n.nodeType === 1) { if (n.tagName === "IMG" && !n.dataset.nodrag) { n.setAttribute("draggable", "false"); n.dataset.nodrag = "1"; } else mark(n); } }); }); }).observe(document.documentElement, { childList: true, subtree: true });
})();


/* ===== Small things: "Ask Levi" always opens Levi; the admin picture; suggestions above Levi's message bar ===== */
window.lvOpenLevi = function () {
  try {
    if (typeof session !== "undefined" && !session) { if (typeof showLogin === "function") showLogin(); return; }
    var p = document.getElementById("aiChatPanel");
    if (p && p.classList.contains("hidden") && typeof toggleAiChat === "function") toggleAiChat();
    else if (!p && typeof toggleAiChat === "function") toggleAiChat();
    setTimeout(function () { var q = document.getElementById("aiChatPanel"); if (q && q.classList.contains("hidden") && typeof toggleAiChat === "function") toggleAiChat(); }, 60);
  } catch (_) {}
};
window.lvAdminIconHtml = function (px) { return '<img class="lv3di lv-admin-ico" src="/icons3d/lv/admin.webp" width="' + (px || 34) + '" height="' + (px || 34) + '" alt="Levromart team" decoding="async">'; };
(function () {
  "use strict";
  // a text ending in a space is put in the box for the person to finish; "!" runs an action instead of asking
  var VENDOR = [["How is my shop doing?", "How is my shop doing?"], ["My reviews", "What are customers saying about my shop?"], ["What are buyers searching for?", "What are buyers searching for on Levromart?"], ["Set up delivery", "!delivery"], ["Add a listing", "Add a listing"], ["Add to my cart", "Add to my cart"], ["How do I get paid?", "How do I get paid for my orders?"]];
  var SHOPPER = [["Add to my cart", "Add to my cart"], ["Best-rated shops for…", "Which shops have the best reviews for "], ["Closest vendor", "Which vendor is closest to me?"], ["Delivery to my campus", "How much is delivery to my campus for "], ["Where is my order?", "Where is my latest order?"], ["What's selling?", "What's selling on Levromart?"], ["How do refunds work?", "How do refunds work on Levromart?"]];
  var HINTS = { v: ["Ask Levi anything…", "Add something to my cart…", "Add a product or add to cart…", "How is my shop doing this week?", "What are customers saying about my shop?", "What should I list next?"], s: ["Ask Levi anything…", "Add something to my cart…", "Add a product to cart…", "Best-rated shops for sneakers?", "Who delivers free to my campus?", "Closest shop selling phone cases?", "Where is my order?"] };
  var hintI = 0;
  setInterval(function () {
    var input = document.getElementById("aiChatInput"), panel = document.getElementById("aiChatPanel");
    if (!input || !panel || panel.classList.contains("hidden") || input.value || document.activeElement === input) return;
    var md = window.lvLeviMode ? window.lvLeviMode() : null;
    if (md) { input.placeholder = md.placeholder || "Ask Levi about this…"; return; }
    var list = HINTS[isVendor() ? "v" : "s"]; hintI = (hintI + 1) % list.length; input.placeholder = list[hintI];
  }, 3500);
  function isVendor() { try { return typeof vendor !== "undefined" && !!vendor && !!vendor.id; } catch (_) { return false; } }
  function strip() {
    var panel = document.getElementById("aiChatPanel"); if (!panel || panel.classList.contains("hidden")) return;
    var input = document.getElementById("aiChatInput"); if (!input) return;
    var row = input.closest(".ai-chat-input-row, .ai-chat-form, form, div") || input.parentNode;
    var host = row.parentNode; if (!host) return;
    var el = document.getElementById("lvLeviSuggest");
    var md = window.lvLeviMode ? window.lvLeviMode() : null;   // Analysis mode / a listing: that subject's questions
    var list = md && md.chips ? md.chips : isVendor() ? VENDOR : SHOPPER;
    var key = md ? "m:" + md.id : isVendor() ? "v" : "s";
    if (el && el.dataset.k === key) return;
    if (el) el.remove();
    el = document.createElement("div"); el.id = "lvLeviSuggest"; el.className = "lvw-ph"; el.dataset.k = key;
    list.forEach(function (s) {
      var b = document.createElement("button"); b.type = "button"; b.textContent = s[0];
      b.onclick = function () {
        if (s[1] === "!delivery") { if (window.lvDrOpenPage) window.lvDrOpenPage(); return; }
        input.value = s[1]; input.focus();
        if (!/ $/.test(s[1])) { try { sendAiChatMessage(); } catch (_) {} }
      };
      el.appendChild(b);
    });
    host.insertBefore(el, row);
  }
  new MutationObserver(function () { strip(); }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  setTimeout(strip, 1500);
})();


/* ===== The wallet PIN (migration 0037): six digits, asked for before every movement of wallet money. A sheet shows exactly
   what will happen (the breakdown, with the fee) and a keypad for the PIN. The native keyboard is never used, so the PIN is
   never suggested, remembered or seen by autofill. Levromart will never ask for it. ===== */
(function () {
  "use strict";
  var LEN = 6;
  // Paystack's local fee on an amount (kobo): 1.5%, plus 100 naira from 2,500 naira, at most 2,000 naira. The server decides the
  // real fee; this only shows it. The same numbers live in medris-backend/src/integrations/paystack/fees.ts.
  window.lvWalletFee = function (kobo) { kobo = Math.round(Number(kobo) || 0); if (kobo <= 0) return 0; return Math.min(Math.floor(kobo * 0.05), 200000, Math.ceil(kobo * 0.015) + (kobo >= 250000 ? 10000 : 0)); };   // Paystack's rate, never more than 5%
  function naira(k) { try { return "₦" + (Number(k) / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 }); } catch (_) { return "₦" + k; } }
  function close() { var m = document.getElementById("lvPinSheet"); if (m) m.remove(); }
  function frame(title, inner) {
    close();
    var m = document.createElement("div");
    m.id = "lvPinSheet"; m.className = "lvpin-wrap";
    m.innerHTML = '<div class="lvpin" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><div class="lvpin-grab" aria-hidden="true"></div>' + inner + "</div>";
    document.body.appendChild(m);
    return m;
  }
  function pad(host, onFull, onChange) {
    var val = "";
    host.innerHTML = '<div class="lvpin-dots" aria-live="polite">' + new Array(LEN + 1).join('<i></i>') + '</div>' +
      '<div class="lvpin-keys">' + [1, 2, 3, 4, 5, 6, 7, 8, 9, "", 0, "⌫"].map(function (k) { return k === "" ? "<span></span>" : '<button type="button" data-k="' + k + '" aria-label="' + (k === "⌫" ? "Delete" : k) + '">' + k + "</button>"; }).join("") + "</div>";
    var dots = host.querySelectorAll(".lvpin-dots i");
    function paint() { dots.forEach(function (d, i) { d.classList.toggle("on", i < val.length); }); if (onChange) onChange(val); }
    host.addEventListener("click", function (e) {
      var b = e.target.closest("[data-k]"); if (!b) return;
      var k = b.getAttribute("data-k");
      if (k === "⌫") val = val.slice(0, -1); else if (val.length < LEN) val += k;
      paint(); if (val.length === LEN && onFull) onFull(val);
    });
    return { get: function () { return val; }, clear: function () { val = ""; paint(); }, shake: function () { host.classList.remove("lvpin-shake"); void host.offsetWidth; host.classList.add("lvpin-shake"); } };
  }
  async function status() {
    try { var r = await sb.rpc("get_wallet_pin_status"); if (r && r.data) { window.__lvHasPin = !!r.data.has_pin; return r.data; } } catch (_) {}
    return { has_pin: !!window.__lvHasPin };
  }
  function rows(list) {
    return '<div class="lvpin-rows">' + (list || []).map(function (r) { return '<div class="lvpin-row' + (r[2] ? " strong" : "") + '"><span>' + esc(r[0]) + "</span><b>" + esc(r[1]) + "</b></div>"; }).join("") + "</div>";
  }
  var dismissedNudge = false;

  /* Creating the PIN: enter it, then enter it again. Resolves true when it is saved. `required` hides "Do it later". */
  window.lvPinSetup = function (o) {
    o = o || {};
    return new Promise(function (resolve) {
      var first = null;
      var m = frame("Create your wallet PIN", '<div class="lvpin-ico">' + (window.lv3dIcon ? window.lv3dIcon("tx-ready", 64) : "") + '</div><h3 class="lvpin-t" id="lvpT">Create your wallet PIN</h3>' +
        '<p class="lvpin-s" id="lvpS">Six digits. You enter it for every payment, transfer and withdrawal. Keep it to yourself: Levromart will never ask for your PIN.</p>' +
        '<div id="lvpPad"></div><p class="lvpin-err" id="lvpE" hidden></p>' + (o.required ? "" : '<button type="button" class="lvpin-link" id="lvpLater">Do it later</button>'));
      var P = pad(m.querySelector("#lvpPad"), async function (v) {
        var err = m.querySelector("#lvpE"); err.hidden = true;
        if (first === null) { first = v; P.clear(); m.querySelector("#lvpT").textContent = "Enter it again"; m.querySelector("#lvpS").textContent = "Type the same six digits to confirm."; return; }
        if (v !== first) { first = null; P.shake(); P.clear(); m.querySelector("#lvpT").textContent = "Create your wallet PIN"; m.querySelector("#lvpS").textContent = "The two PINs did not match. Start again."; return; }
        var r = await sb.rpc("set_wallet_pin", { p_pin: first, p_pin_confirm: v });
        if (r.error) { first = null; P.shake(); P.clear(); m.querySelector("#lvpT").textContent = "Create your wallet PIN"; err.textContent = /not valid|not found|being set up/i.test(String(r.error.message || "")) ? "The wallet PIN is not switched on yet. Please try again a little later." : (r.error.message || "Could not save your PIN."); err.hidden = false; return; }
        window.__lvHasPin = true; close(); if (typeof showToast === "function") showToast("Your wallet PIN is set. Keep it safe.", "success"); resolve(true);
      });
      var later = m.querySelector("#lvpLater"); if (later) later.onclick = function () { close(); resolve(false); };
      // the sheet can always be put away (tap outside, or the cross); a compulsory PIN simply asks again next time
      m.addEventListener("click", function (e) { if (e.target === m) { close(); resolve(false); } });
      var x = document.createElement("button"); x.type = "button"; x.className = "lvpin-x"; x.setAttribute("aria-label", "Close"); x.innerHTML = '<i class="fa-solid fa-xmark"></i>'; x.onclick = function () { close(); resolve(false); }; m.querySelector(".lvpin").appendChild(x);
    });
  };
  /* A gentle reminder (once per visit) for people who have not made a PIN yet; after a bank account is saved it is compulsory. */
  window.lvPinNudge = function (required) {
    if (window.__lvHasPin) return;
    if (!required && dismissedNudge) return;
    if (document.getElementById("lvPinSheet")) return;
    setTimeout(async function () {
      var st = await status(); if (st.has_pin || document.getElementById("lvPinSheet")) return;
      var ok = await window.lvPinSetup({ required: !!required });
      if (!ok && !required) dismissedNudge = true;
    }, 400);
  };

  /* Before money moves: the breakdown and the PIN. Resolves the PIN, or null when the person goes back. */
  window.lvPinGate = async function (o) {
    o = o || {};
    var st = await status();
    if (!st.has_pin) { var made = await window.lvPinSetup({ required: true }); if (!made) return null; }
    else if (st.locked_minutes > 0) { if (typeof showToast === "function") showToast("Too many wrong PINs. Try again in " + st.locked_minutes + " minute" + (st.locked_minutes === 1 ? "" : "s") + ".", "error"); return null; }
    return new Promise(function (resolve) {
      var person = o.person && (o.person.avatar_url ? '<img class="lvpin-av" src="' + esc(o.person.avatar_url) + '" alt="">' : '<span class="lvpin-av">' + esc(String(o.person.name || o.person.handle || "?").slice(0, 1).toUpperCase()) + "</span>");
      // the headline figure (the row marked strong) is shown big, like a bank app; the other rows are a plain list under it
      var strong = (o.rows || []).filter(function (r) { return r[2]; })[0], rest = (o.rows || []).filter(function (r) { return r !== strong; });
      var heroHtml = strong ? '<div class="lvpin-hero"><span>' + esc(strong[0]) + "</span><b>" + esc(strong[1]) + "</b></div>" : "";
      var m = frame(o.title || "Confirm", '<h3 class="lvpin-t">' + esc(o.title || "Confirm") + "</h3>" + (person ? '<div class="lvpin-person">' + person + "</div>" : "") + heroHtml + (rest.length ? rows(rest) : "") +
        (o.note ? '<p class="lvpin-note">' + esc(o.note) + "</p>" : "") + '<p class="lvpin-s"><i class="fa-solid fa-lock" aria-hidden="true"></i> Enter your 6-digit PIN</p><div id="lvpPad"></div>' +
        '<button type="button" class="lvpin-go" id="lvpGo" disabled>' + esc(o.cta || "Confirm") + '</button><button type="button" class="lvpin-back" id="lvpBack">Go back</button>');
      var go = m.querySelector("#lvpGo"), pin = "";
      var P = pad(m.querySelector("#lvpPad"), null, function (v) { pin = v; go.disabled = v.length !== LEN; });
      go.onclick = function () { if (pin.length === LEN) { close(); resolve(pin); } };
      m.querySelector("#lvpBack").onclick = function () { close(); resolve(null); };
      m.addEventListener("click", function (e) { if (e.target === m) { close(); resolve(null); } });
    });
  };

  /* Changing the PIN (Settings): the account password first, then the new PIN twice. */
  window.lvPinChange = async function () {
    var st = await status();
    if (!st.has_pin) return window.lvPinSetup({ required: false });
    var pw = await new Promise(function (res) {
      var m = frame("Change your PIN", '<div class="lvpin-ico">' + (window.lv3dIcon ? window.lv3dIcon("settings", 64) : "") + '</div><h3 class="lvpin-t">Change your PIN</h3><p class="lvpin-s">Enter your account password first.</p>' +
        '<input id="lvpPw" class="lvpin-in" type="password" autocomplete="current-password" placeholder="Your password"><p class="lvpin-err" id="lvpE" hidden></p>' +
        '<button type="button" class="lvpin-go" id="lvpGo">Continue</button><button type="button" class="lvpin-back" id="lvpBack">Go back</button>');
      m.querySelector("#lvpGo").onclick = function () { var v = m.querySelector("#lvpPw").value; if (!v) { var e = m.querySelector("#lvpE"); e.textContent = "Enter your password."; e.hidden = false; return; } close(); res(v); };
      m.querySelector("#lvpBack").onclick = function () { close(); res(null); };
      setTimeout(function () { try { m.querySelector("#lvpPw").focus(); } catch (_) {} }, 80);
    });
    if (!pw) return false;
    return new Promise(function (resolve) {
      var first = null;
      var m = frame("New PIN", '<h3 class="lvpin-t" id="lvpT">Choose a new PIN</h3><p class="lvpin-s" id="lvpS">Six digits. Not 123456 or the same digit six times.</p><div id="lvpPad"></div><p class="lvpin-err" id="lvpE" hidden></p><button type="button" class="lvpin-back" id="lvpBack">Cancel</button>');
      var P = pad(m.querySelector("#lvpPad"), async function (v) {
        var err = m.querySelector("#lvpE"); err.hidden = true;
        if (first === null) { first = v; P.clear(); m.querySelector("#lvpT").textContent = "Enter it again"; m.querySelector("#lvpS").textContent = "Type the new PIN once more."; return; }
        if (v !== first) { first = null; P.shake(); P.clear(); m.querySelector("#lvpT").textContent = "Choose a new PIN"; err.textContent = "The two PINs did not match. Start again."; err.hidden = false; return; }
        var r = await sb.rpc("change_wallet_pin", { p_password: pw, p_pin: first, p_pin_confirm: v });
        if (r.error) { first = null; P.shake(); P.clear(); m.querySelector("#lvpT").textContent = "Choose a new PIN"; err.textContent = /not valid|not found|being set up/i.test(String(r.error.message || "")) ? "The wallet PIN is not switched on yet. Please try again a little later." : (r.error.message || "Could not change your PIN."); err.hidden = false; return; }
        close(); if (typeof showToast === "function") showToast("Your PIN was changed.", "success"); resolve(true);
      });
      m.querySelector("#lvpBack").onclick = function () { close(); resolve(false); };
      m.addEventListener("click", function (e) { if (e.target === m) { close(); resolve(false); } });
    });
  };
})();

/* a bank account saved: the wallet PIN becomes compulsory right away */
(function () {
  "use strict";
  function wrap() {
    if (typeof sb === "undefined" || !sb || typeof sb.rpc !== "function" || sb.rpc.__lvPin) return;
    var rpc0 = sb.rpc;
    var rpc1 = function (name) {
      var call = rpc0.apply(this, arguments);
      if (name === "save_refund_account") Promise.resolve(call).then(function (r) { if (r && !r.error && typeof window.lvPinNudge === "function") window.lvPinNudge(true); }).catch(function () {});
      return call;
    };
    rpc1.__lvPin = true; sb.rpc = rpc1;
  }
  wrap(); setTimeout(wrap, 1500); setTimeout(wrap, 5000);
})();


/* ===== Vendors map: using the search box clears the shop card, the rail and the buttons so results are easy to see ===== */
(function () {
  "use strict";
  var t = 0;
  document.addEventListener("focusin", function (e) { if (e.target && e.target.id === "vmpQ") { clearTimeout(t); var p = document.getElementById("vmPage"); if (p) p.classList.add("vmp-searching"); } }, true);
  document.addEventListener("focusout", function (e) { if (e.target && e.target.id === "vmpQ") { t = setTimeout(function () { var p = document.getElementById("vmPage"), q = document.getElementById("vmpQ"); if (p && !(q && q.value && document.activeElement === q)) p.classList.remove("vmp-searching"); }, 250); } }, true);
})();


/* ===== Admin: a verified vendor can be unverified (back to "pending"): the shop leaves the marketplace until it is approved again ===== */
window.adminUnverifyVendor = async function (id, filterStatus, name) {
  try {
    if (!session || !profile || profile.role !== "admin") return showToast("Admin access is required.", "error");
    var ok = await showConfirmDialog('Unverify "' + (name || "this vendor") + '"? Their storefront and listings stop showing until you approve them again. They are told their account is under review.', { title: "Unverify vendor", okLabel: "Unverify", danger: true, cancelLabel: "Go back" });
    if (!ok) return;
    var r = await sb.rpc("admin_set_vendor_status", { p_vendor_id: id, p_status: "pending" });
    if (r.error) throw r.error;
    try { if (typeof invalidateMarketplaceState === "function") invalidateMarketplaceState(); } catch (_) {}
    showToast((name || "The vendor") + " is unverified.", "success");
    setTimeout(function () { try { navigate("adminPanel", { status: filterStatus || "verified" }, { replace: true }); } catch (_) {} }, 0);
  } catch (err) { showToast((err && err.message) || "Could not unverify this vendor.", "error"); }
};

/* ===== Pictures that were already shown once are drawn again at once when a screen is redrawn (home actions, trending
   products): they are remembered, preloaded, and decoded straight away, so they no longer blink away and come back. ===== */
(function () {
  "use strict";
  var seen = new Set(), keep = [];
  function remember(img) { try { var s = img.currentSrc || img.src; if (s && !seen.has(s)) { seen.add(s); if (keep.length < 160) { var k = new Image(); k.decoding = "sync"; k.src = s; keep.push(k); } } } catch (_) {} }
  document.addEventListener("load", function (e) { if (e.target && e.target.tagName === "IMG") remember(e.target); }, true);
  function ready(img) { try { if (img.dataset.lvk) return; var s = img.currentSrc || img.src; if (s && seen.has(s)) { img.dataset.lvk = "1"; img.decoding = "sync"; img.loading = "eager"; img.style.opacity = ""; img.classList.remove("lv-fade-pending"); } } catch (_) {} }
  new MutationObserver(function (list) { list.forEach(function (m) { m.addedNodes.forEach(function (n) { if (n.nodeType !== 1) return; if (n.tagName === "IMG") ready(n); else if (n.querySelectorAll) n.querySelectorAll("img").forEach(ready); }); }); }).observe(document.documentElement, { childList: true, subtree: true });
  // the three quick-action pictures on Home are fetched as soon as the app starts
  ["shop-products", "rent-items", "book-services", "request-item"].map(function (n) { return "/action-cards/" + n + ".webp"; }).forEach(function (u) { var i = new Image(); i.src = u; keep.push(i); });
})();

/* ===== Refund requests on the order page (migration 0038): the buyer sees where the request is; the shop can refund or decline ===== */
(function () {
  "use strict";
  function oid() { try { return (typeof currentViewParams !== "undefined" && currentViewParams && currentViewParams.orderId) || ""; } catch (_) { return ""; } }
  function card(c, isShop, isBuyer) {
    var open = c.status === "requested", waiting = open && c.vendor_decision !== "declined";
    var title, text, btns = "";
    if (c.requester_role !== "buyer") {
      if (isShop) { title = open ? "Waiting for Levromart" : c.status === "approved" ? "Order cancelled" : "Not approved"; text = open ? "You asked Levromart to cancel this paid order. An admin will decide." : (c.reject_reason || ""); } else return "";
    } else if (isShop && open) {
      title = c.vendor_decision === "declined" ? "You declined this refund request" : "Refund request";
      text = c.vendor_decision === "declined" ? "Levromart will decide. If your reason is good it may stand." : 'The buyer cancelled this paid order and asked for a refund. "' + esc(c.reason || "") + '"';
      if (c.vendor_decision !== "declined") btns = '<div class="lvrq-btns"><button type="button" class="lvrq-go" onclick="lvRefundDecide(\'' + esc(c.id) + '\',\'refund\')">Refund the buyer</button><button type="button" class="lvrq-no" onclick="lvRefundDecide(\'' + esc(c.id) + '\',\'decline\')">Decline</button></div>';
    } else if (isBuyer) {
      if (open) { title = c.vendor_decision === "declined" ? "The shop did not refund" : "Refund requested"; text = c.vendor_decision === "declined" ? "The shop said: " + esc(c.vendor_reason || "") + ". Levromart is looking at your request and will decide." : "The shop and Levromart have been told. Your order is cancelled and your money goes back to your wallet as soon as the shop agrees or Levromart decides."; }
      else if (c.status === "approved") { title = "Refund approved"; text = "Your order was cancelled and what you paid for it is going back to your wallet."; }
      else { title = "Refund not approved"; text = esc(c.reject_reason || "Levromart did not approve this request."); }
    } else return "";
    return '<div class="od-card lvrq' + (waiting ? " wait" : "") + '"><div class="lvrq-h">' + (window.lv3dIcon ? window.lv3dIcon(open ? "tx-pending" : c.status === "approved" ? "tx-paid" : "order-cancelled", 40) : "") + "<b>" + title + "</b></div><p>" + text + "</p>" + btns + "</div>";
  }
  var busy = false, shown = "";
  async function paint() {
    if (busy) return; var id = oid(); if (!id || typeof currentView === "undefined" || currentView !== "orderDetail") { shown = ""; return; }
    var host = document.querySelector("#app .od-actions, #app .od-card"); if (!host) return;
    if (document.getElementById("lvRqCard")) return;
    busy = true;
    try {
      var r = await sb.rpc("get_order_cancellation", { p_order_id: id }); var c = r && r.data;
      if (!c || document.getElementById("lvRqCard")) return;
      var uid = session && session.user && session.user.id, isBuyer = uid === c.buyer_id, isShop = uid === c.vendor_user_id;
      if (!isBuyer && !isShop) {   // a manager of the shop answers refund requests like the owner
        try { var ov = await sb.from("orders").select("vendor_id").eq("id", id).maybeSingle(); var vid = ov && ov.data && ov.data.vendor_id; isShop = !!vid && (window.lvMyTeams || []).some(function (t) { return String(t.vendor_id) === String(vid) && t.role === "manager"; }); } catch (_) {}
      }
      var html = card(c, isShop, isBuyer); if (!html) return;
      var first = document.querySelector("#app .od-card"); if (!first) return;
      var wrap = document.createElement("div"); wrap.id = "lvRqCard"; wrap.innerHTML = html;
      first.parentNode.insertBefore(wrap, first);
    } catch (_) {} finally { busy = false; }
  }
  window.lvRefundDecide = async function (id, how) {
    var reason = null;
    if (how === "decline") { reason = await showTextPromptDialog("Decline the refund", "Tell the buyer why. Levromart sees it too and decides.", { okLabel: "Decline", placeholder: "Why are you not refunding?", required: true }); if (!reason) return; }
    else if (!(await showConfirmDialog("Refund the buyer? The order is cancelled and what they paid for it goes back to their wallet, out of your share.", { title: "Refund the buyer", okLabel: "Refund", cancelLabel: "Go back" }))) return;
    var r = await sb.rpc("vendor_decide_cancellation", { p_request_id: id, p_decision: how, p_reason: reason });
    if (r.error) return showToast(r.error.message || "Could not save.", "error");
    showToast(how === "refund" ? "Refunded. The order is cancelled." : "Your answer was sent to the buyer and Levromart.", "success");
    var oldc = document.getElementById("lvRqCard"); if (oldc) oldc.remove();
    try { await navigate("orderDetail", { orderId: oid() }); } catch (_) { paint(); }
  };
  var t = 0;
  new MutationObserver(function () { if (t) return; t = setTimeout(function () { t = 0; paint(); }, 200); }).observe(document.getElementById("app") || document.body, { childList: true, subtree: true });
})();

/* ===== Settings opens at the top and stays there; notification times never jump ===== */
(function () {
  "use strict";
  var base = window.navigate;
  if (typeof base === "function" && !base.__lvSet) {
    var w = function (view) {
      var r = base.apply(this, arguments);
      if (view === "settings") {
        var moved = false, onScroll = function () { if (Math.abs(window.scrollY) > 2 && Date.now() - t0 > 700) moved = true; }, t0 = Date.now();
        window.addEventListener("scroll", onScroll, { passive: true });
        [0, 120, 350, 700].forEach(function (ms) { setTimeout(function () { if (!moved && window.scrollY > 0) window.scrollTo({ top: 0, behavior: "auto" }); }, ms); });
        setTimeout(function () { window.removeEventListener("scroll", onScroll); }, 900);
      }
      return r;
    };
    w.__lvSet = true; window.navigate = w; try { navigate = w; } catch (_) {}
  }
  // a timestamp without a time zone is UTC; a clock a little ahead of the server never shows a time in the future
  window.timeAgo = function (dateStr) {
    var s = String(dateStr || ""); if (/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d/.test(s) && !/(Z|[+-]\d\d:?\d\d)$/.test(s)) s = s.replace(" ", "T") + "Z";
    var t = new Date(s).getTime(); if (!isFinite(t)) return "";
    var diff = Math.max(0, (Date.now() - t) / 1000);
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    return Math.floor(diff / 86400) + "d ago";
  };
  try { timeAgo = window.timeAgo; } catch (_) {}
})();

/* ===== Adding or changing a payout account asks for the account password (shops and refund accounts) ===== */
(function () {
  "use strict";
  var realFetch = window.fetch;
  if (typeof realFetch !== "function" || realFetch.__lvPw) return;
  function askPassword() {
    return new Promise(function (resolve) {
      var m = document.createElement("div"); m.className = "lvw-sheet-wrap";
      m.innerHTML = '<div class="lvw-sheet" role="dialog" aria-modal="true"><div class="lvw-sheet-grab" aria-hidden="true"></div><div class="lvw-sheet-head"><h3>Confirm it is you</h3></div><div class="lvw-sheet-body"><p class="lvw-sheet-msg">Enter your account password to add or change your payout account.</p><input type="password" id="lvPayPw" autocomplete="current-password" placeholder="Your password" style="width:100%;padding:.8rem;border-radius:12px;border:1.5px solid rgba(128,128,128,.4);font:inherit;background:transparent;color:inherit;margin:.4rem 0 .8rem"><button type="button" class="btn lvw-wd-go" id="lvPayGo">Continue</button><button type="button" class="btn" id="lvPayNo" style="width:100%;margin-top:.5rem;background:transparent;color:#d93025;border:1.5px solid #d93025">Cancel</button></div></div>';
      document.body.appendChild(m);
      var done = function (v) { m.remove(); resolve(v); };
      m.querySelector("#lvPayGo").onclick = function () { var v = m.querySelector("#lvPayPw").value; if (v) done(v); };
      m.querySelector("#lvPayNo").onclick = function () { done(null); };
      setTimeout(function () { try { m.querySelector("#lvPayPw").focus(); } catch (_) {} }, 80);
    });
  }
  window.lvAskPassword = askPassword;
  window.fetch = async function (input, init) {
    try {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      if (/\/api\/vendor-payments/.test(url) && init && typeof init.body === "string" && init.body.indexOf("create-subaccount") > -1) {
        var b = JSON.parse(init.body);
        if (b.action === "create-subaccount" && !b.password) {
          var pw = await askPassword();
          if (!pw) return new Response(JSON.stringify({ error: "Cancelled. Your payout account was not changed." }), { status: 400, headers: { "Content-Type": "application/json" } });
          b.password = pw; init = Object.assign({}, init, { body: JSON.stringify(b) });
        }
      }
    } catch (_) {}
    return realFetch.call(this, input, init);
  };
  window.fetch.__lvPw = true;
})();

/* ===== Levi chat: fits above the keyboard, a copy button under answers ===== */
(function () {
  "use strict";
  var vv = window.visualViewport, ticking = false;
  function panel() { return document.getElementById("aiChatPanel"); }
  // Follow the visible area: when the keyboard opens the whole chat (header included) shrinks to what is left, so nothing is cut off and the page behind never shows through
  function fit() {
    ticking = false;
    var p = panel(); if (!p || p.classList.contains("hidden") || !vv) return;
    var kb = window.innerHeight - vv.height - vv.offsetTop > 80;
    if (p.classList.contains("lv-full")) {
      p.style.setProperty("height", vv.height + "px", "important");
      p.style.setProperty("top", vv.offsetTop + "px", "important");
      p.style.setProperty("bottom", "auto", "important");
    } else if (kb) {
      p.style.setProperty("height", Math.min(vv.height - 8, 780) + "px", "important");
      p.style.setProperty("bottom", Math.max(0, window.innerHeight - vv.height - vv.offsetTop) + "px", "important");
    } else {
      ["height", "top", "bottom"].forEach(function (k) { p.style.removeProperty(k); });
    }
    if (kb) { var m = document.getElementById("aiChatMessages"); if (m) m.scrollTop = m.scrollHeight; }
  }
  function schedule() { if (!ticking) { ticking = true; requestAnimationFrame(fit); } }
  if (vv) { vv.addEventListener("resize", schedule); vv.addEventListener("scroll", schedule); }
  document.addEventListener("focusout", function () { setTimeout(schedule, 120); }, true);
  // a copy button under each of Levi's answers
  function decorate() {
    document.querySelectorAll("#aiChatMessages .ai-chat-msg.assistant").forEach(function (el) {
      // never on the "Thinking… / Checking the shops…" line while Levi is still working
      if (el.id === "aiChatTyping" || el.classList.contains("lvthink-row") || el.classList.contains("typing") || el.querySelector(".lvthink")) return;
      if (el.__lvCopy || el.querySelector(".lv-copy")) return; el.__lvCopy = 1;
      if (!(el.textContent || "").trim()) return;
      var b = document.createElement("button"); b.type = "button"; b.className = "lv-copy"; b.setAttribute("aria-label", "Copy answer"); b.innerHTML = '<i class="fa-regular fa-copy"></i> Copy';
      b.onclick = function (e) {
        e.stopPropagation();
        var t = Array.prototype.map.call(el.childNodes, function (n) { return n.classList && n.classList.contains("lv-copy") ? "" : (n.innerText || n.textContent || ""); }).join("").trim();
        var done = function () { b.innerHTML = '<i class="fa-solid fa-check"></i> Copied'; setTimeout(function () { b.innerHTML = '<i class="fa-regular fa-copy"></i> Copy'; }, 1600); };
        try { navigator.clipboard.writeText(t).then(done, done); } catch (_) { done(); }
      };
      el.appendChild(b);
    });
  }
  var host = document.getElementById("aiChatMessages");
  if (host) new MutationObserver(function () { clearTimeout(decorate.t); decorate.t = setTimeout(decorate, 250); }).observe(host, { childList: true });
})();
/* the wallet "?" stops pulsing once someone has opened the help */
(function () {
  "use strict";
  var seen = false; try { seen = localStorage.getItem("lv-wallet-help-seen") === "1"; } catch (_) {}
  function mark() { document.querySelectorAll(".lvw-help").forEach(function (b) { b.classList.toggle("seen", seen); }); }
  document.addEventListener("click", function (e) { var b = e.target.closest && e.target.closest(".lvw-help"); if (b) { seen = true; try { localStorage.setItem("lv-wallet-help-seen", "1"); } catch (_) {} mark(); } }, true);
  new MutationObserver(function () { clearTimeout(mark.t); mark.t = setTimeout(mark, 100); }).observe(document.body, { childList: true, subtree: true });
  mark();
})();

/* ===== Account page rows (My orders, Wishlist, Support, Settings…) use the 3D pictures ===== */
(function () {
  "use strict";
  var base = window.lvLinkRow;
  if (typeof base !== "function" || base.__lv3) return;
  var MAP = [[/my orders|^orders$/i, "stat-orders"], [/wishlist/i, "stat-wishlist"], [/vendors you follow|following|followers/i, "stat-followers"], [/my details|edit profile|profile/i, "general"], [/location|city/i, "map-pin"],
    [/request an item|^requests?$/i, "requests"], [/take a tour|tour/i, "new-arrival"], [/support|help/i, "support"], [/settings|privacy/i, "settings"], [/suggest/i, "suggestions"], [/leaderboard/i, "vendor-of-week"], [/earnings|wallet/i, "cash"], [/my shop|shop/i, "store"], [/listings/i, "manage-listings"], [/review/i, "reviews"]];
  window.lvLinkRow = function (icon, label, value, onclick) {
    var plain = String(label || "").replace(/&amp;/g, "&").replace(/<[^>]*>/g, "").trim(), three = null;
    for (var i = 0; i < MAP.length; i++) if (MAP[i][0].test(plain)) { three = MAP[i][1]; break; }
    if (three && typeof window.lv3dIcon === "function" && window.LV3D && window.LV3D[three]) icon = window.lv3dIcon(three, 30);
    return base.call(this, icon, label, value, onclick);
  };
  window.lvLinkRow.__lv3 = true;
})();

/* ===== Orders stay honest on a weak connection =====
   A slim bar says when there is no internet; an order action (mark out for delivery, confirm, I have received it) is refused
   with a clear message instead of pretending, and after it succeeds the order lists are redrawn from fresh data. */
(function () {
  "use strict";
  function bar() {
    var b = document.getElementById("lvOfflineBar");
    if (!b) { b = document.createElement("div"); b.id = "lvOfflineBar"; b.setAttribute("role", "alert"); b.innerHTML = '<i class="fa-solid fa-wifi"></i> No internet connection. What you see may be out of date.'; document.body.appendChild(b); }
    b.classList.toggle("on", !navigator.onLine);
    document.documentElement.classList.toggle("lv-offline-on", !navigator.onLine);   // the header and page sit below the bar, never under it
  }
  window.addEventListener("online", function () { bar(); try { if (typeof refreshVisibleOrderView === "function") refreshVisibleOrderView(true); } catch (_) {} });
  window.addEventListener("offline", bar);
  setTimeout(bar, 800);
  function guard(name) {
    var f = window[name]; if (typeof f !== "function" || f.__lvg) return;
    var w = async function () {
      if (!navigator.onLine) { try { showToast("No internet connection. Check your network and try again.", "error"); } catch (_) {} return; }
      var r;
      try { r = await f.apply(this, arguments); }
      finally {
        try { if (typeof __ordersTabCache !== "undefined") __ordersTabCache.clear(); } catch (_) {}
        try { if (typeof refreshVisibleOrderView === "function") { refreshVisibleOrderView(true); setTimeout(function () { try { refreshVisibleOrderView(true); } catch (_) {} }, 1500); } } catch (_) {}
      }
      return r;
    };
    w.__lvg = true; window[name] = w;
  }
  ["updateOrderStatus", "confirmReceivedOrder", "remindOrderVendor", "vendorConfirmReportedPayment"].forEach(guard);
})();

/* ===== Orders: the status tabs switch at once; the side panel opens the moment the picture is touched ===== */
(function () {
  "use strict";
  var FAST = ["all", "pending", "confirmed", "handed_over", "disputed"], filtering = false;
  var base = window.orderListHtml;
  if (typeof base === "function" && !base.__lvf) {
    var w = function (orders, isCust, src) {
      if (!filtering) {
        try {
          var p = (typeof currentViewParams !== "undefined" && currentViewParams) || {};
          if ((p.status || "all") === "all" && (p.type || "all") === "all" && (p.payment || "all") === "all" && !p.dateFrom && !p.dateTo && Array.isArray(orders))
            window.__lvOrderAll = { view: typeof currentView !== "undefined" ? currentView : "", persp: p.perspective || "", orders: orders, isCust: isCust, src: src };
        } catch (_) {}
      }
      if ((!orders || !orders.length) && typeof navigator !== "undefined" && navigator.onLine === false)
        return '<div class="lvo-empty lvo-offline"><span class="lvo-empty-ico"><i class="fa-solid fa-wifi"></i></span><strong>No internet connection</strong><span>Your orders could not be loaded. Check your network and try again.</span><button type="button" class="btn lvo-btn" onclick="try{refreshVisibleOrderView(true)}catch(e){location.reload()}"><i class="fa-solid fa-rotate-right"></i> Try again</button></div>';
      return base.apply(this, arguments);
    };
    w.__lvf = true; window.orderListHtml = w;
    try { orderListHtml = w; } catch (_) {}
  }
  document.addEventListener("click", function (e) {
    var b = e.target && e.target.closest && e.target.closest(".order-status-pill[data-status]"); if (!b) return;
    var st = b.getAttribute("data-status"), A = window.__lvOrderAll, p = (typeof currentViewParams !== "undefined" && currentViewParams) || {};
    if (!A || FAST.indexOf(st) < 0 || A.view !== (typeof currentView !== "undefined" ? currentView : "") || (A.persp || "") !== (p.perspective || "")) return;
    var host = document.getElementById("orderListWrap"); if (!host) return;
    e.stopImmediatePropagation(); e.preventDefault();
    b.parentElement.querySelectorAll(".order-status-pill").forEach(function (x) { x.classList.toggle("active", x === b); });
    var list = st === "all" ? A.orders : A.orders.filter(function (o) { return o.status === st; });
    filtering = true; try { host.innerHTML = window.orderListHtml(list, A.isCust, A.src); } finally { filtering = false; }
    try { currentViewParams.status = st; window.__orderListOrders = list; } catch (_) {}
  }, true);
})();

/* ===== Delivery by campus (migration 0041). A listing can have several delivery options, each for "my campus", campuses
   the shop picks, or every other campus: e.g. free on UNILAG, ₦500 on LASU and YABATECH, ₦200/km everywhere else.
   The buyer says which campus the order goes to and the fee follows it; the server works the fee out again the same way
   (checkout.repository pickDeliveryRule) and the database refuses a contradictory list. Until 0041 is applied the old
   single setting is shown and nothing changes. ===== */
(function () {
  "use strict";
  var OK = null, probing = null;
  function probe() {
    if (OK !== null) return Promise.resolve(OK);
    if (probing) return probing;
    probing = Promise.resolve().then(function () { return sb.from("products").select("delivery_rules").limit(1); })
      .then(function (r) { OK = !(r && r.error); return OK; }, function () { OK = false; return false; });
    return probing;
  }
  function E(s) { return typeof esc === "function" ? esc(s) : String(s == null ? "" : s); }
  function N(n) { return typeof naira === "function" ? naira(n) : "₦" + Number(n || 0).toLocaleString(); }
  function campusName(id) {
    if (!id) return "";
    var r = window.lvCampusById && window.lvCampusById(id);
    if (r && window.lvCampusShort) { try { var s = window.lvCampusShort(id); if (s) return s; } catch (_) {} }
    if (r && r.name) return r.name;
    return String(id).replace(/^custom:/, "").replace(/-/g, " ").replace(/\b\w/g, function (m) { return m.toUpperCase(); });
  }
  window.lvDrCampusName = campusName;
  // the same choice the server makes
  function pick(rules, shopCampus, campus) {
    if (!campus || campus === "none" || !Array.isArray(rules)) return null;
    var own = shopCampus && shopCampus !== "none" ? shopCampus : null;
    return rules.find(function (r) { return r.scope === "mine" && own && own === campus; })
      || rules.find(function (r) { return r.scope === "selected" && (r.campuses || []).indexOf(campus) >= 0; })
      || rules.find(function (r) { return r.scope === "all"; }) || null;
  }
  window.lvDrPick = pick;
  function ruleText(r) { return r.mode === "free" ? "Free delivery" : r.mode === "flat" ? N(r.fee) + " delivery" : N(r.perKm) + "/km"; }

  /* ---------------- buyer: which campus is it going to? ---------------- */
  var REG = {};
  window.lvDrRegister = function (prefix, products, v) {
    var lines = (products || []).map(function (p) {
      return { name: p.name || "", rules: Array.isArray(p.delivery_rules) && p.delivery_rules.length ? p.delivery_rules : null,
        mode: String(p.delivery_fee_mode || "free").toLowerCase(), fee: Number(p.delivery_fee) || 0, perKm: Math.min(1000, Number(p.delivery_fee_per_km) || 0) };
    });
    if (!lines.some(function (l) { return l.rules; })) { delete REG[prefix]; return; }
    REG[prefix] = { lines: lines, vcampus: (v && v.campus_id) || null, vlat: v && v.lat != null ? Number(v.lat) : null, vlng: v && v.lng != null ? Number(v.lng) : null, chosen: null };
  };
  function coverage(R) {
    var ruled = R.lines.filter(function (l) { return l.rules; });
    var own = R.vcampus && R.vcampus !== "none" ? R.vcampus : null;
    if (ruled.every(function (l) { return l.rules.some(function (r) { return r.scope === "all"; }); })) return { any: true, list: [] };
    var cand = [];
    ruled.forEach(function (l) { l.rules.forEach(function (r) {
      if (r.scope === "mine" && own && cand.indexOf(own) < 0) cand.push(own);
      if (r.scope === "selected") (r.campuses || []).forEach(function (c) { if (cand.indexOf(c) < 0) cand.push(c); });
    }); });
    return { any: false, list: cand.filter(function (c) { return ruled.every(function (l) { return pick(l.rules, R.vcampus, c); }); }) };
  }
  function effective(R) {
    return R.lines.map(function (l) {
      if (!l.rules) return { name: l.name, mode: l.mode === "free" ? "flat" : l.mode, fee: l.mode === "flat" ? l.fee : 0, perKm: l.mode === "distance" ? l.perKm : 0 };
      var r = pick(l.rules, R.vcampus, R.chosen);
      if (!r) return { name: l.name, blocked: true };
      return { name: l.name, mode: r.mode === "distance" ? "distance" : "flat", fee: r.mode === "flat" ? Number(r.fee) || 0 : 0, perKm: r.mode === "distance" ? Math.min(1000, Number(r.perKm) || 0) : 0, free: r.mode === "free" };
    });
  }
  function apply(prefix) {
    var R = REG[prefix], wrap = byId(prefix + "DeliveryFields"); if (!R || !wrap) return;
    var nameEl = byId(prefix + "DrName"), line = byId(prefix + "FeeLine"), note = byId(prefix + "DrNote");
    if (nameEl) nameEl.innerHTML = R.chosen ? (window.lvCampusLogoHtml ? '<span class="lvdr-logo">' + window.lvCampusLogoHtml(R.chosen) + "</span>" : "") + E(campusName(R.chosen)) : "Choose your campus";
    if (note) note.textContent = "";
    if (!R.chosen) {
      wrap.dataset.feeMode = "flat"; wrap.dataset.fee = "0"; wrap.dataset.perKm = "0"; if (wrap.dataset.feeLines !== undefined) wrap.dataset.feeLines = "[]";
      if (line) line.innerHTML = '<i class="fa-solid fa-truck"></i> Choose your campus to see the delivery fee.';
      if (typeof refreshPriceBreakdown === "function") refreshPriceBreakdown(prefix);
      return;
    }
    var eff = effective(R), ok = eff.filter(function (x) { return !x.blocked; }), bad = eff.filter(function (x) { return x.blocked; });
    if (bad.length && note) note.textContent = bad.map(function (x) { return x.name; }).join(", ") + (bad.length === 1 ? " is" : " are") + " not delivered to " + campusName(R.chosen) + ". Choose pickup, or check that out separately.";
    var flat = ok.reduce(function (s, x) { return Math.max(s, x.mode === "flat" ? x.fee : 0); }, 0), dist = ok.find(function (x) { return x.mode === "distance" && x.perKm > 0; });
    wrap.dataset.feeMode = dist ? "distance" : "flat"; wrap.dataset.fee = String(flat); wrap.dataset.perKm = String(dist ? dist.perKm : 0);
    if (wrap.dataset.feeLines !== undefined || R.lines.length > 1) wrap.dataset.feeLines = JSON.stringify(ok);
    if (line) {
      if (dist && R.vlat != null && R.vlng != null && typeof deliveryInfoLineHtml === "function") line.innerHTML = deliveryInfoLineHtml(prefix, true, true, R.vlat, R.vlng, dist.perKm);
      else if (dist) line.innerHTML = '<i class="fa-solid fa-circle-info"></i> This shop has not set its location, so delivery by distance is not available. Choose pickup.';
      else line.innerHTML = '<i class="fa-solid fa-truck"></i> ' + (flat > 0 ? "<strong>" + N(flat) + "</strong> delivery" : "<strong>Free delivery</strong>") + " to " + E(campusName(R.chosen));
    }
    if (dist && typeof ensureDeliveryLocation === "function") ensureDeliveryLocation(prefix);
    if (typeof refreshPriceBreakdown === "function") refreshPriceBreakdown(prefix);
  }
  window.lvDrApply = apply;
  function choose(prefix, id) { var R = REG[prefix]; if (!R) return; R.chosen = id || null; try { if (id) localStorage.setItem("lv-dr-campus", id); } catch (_) {} apply(prefix); }
  window.lvDrChoose = function (prefix) {
    var R = REG[prefix]; if (!R) return;
    var cov = coverage(R);
    var go = function () {
      if (cov.any && window.lvOpenCampusPicker) {
        window.lvOpenCampusPicker({ title: "Where should it be delivered?", current: R.chosen || "", onPick: function (id) { choose(prefix, typeof id === "string" ? id : (id && id.id)); } });
        return;
      }
      var old = document.getElementById("lvDrSheet"); if (old) old.remove();
      var w = document.createElement("div"); w.id = "lvDrSheet"; w.className = "lvdr-sheet"; w.setAttribute("role", "dialog"); w.setAttribute("aria-modal", "true");
      w.innerHTML = '<div class="lvdr-sheet-card"><div class="lvdr-sheet-h"><strong>Where should it be delivered?</strong><button type="button" class="lvdr-x" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>'
        + '<p class="lvdr-sheet-sub">This shop delivers to these campuses only.</p><div class="lvdr-sheet-list">'
        + (cov.list.length ? cov.list.map(function (c) { return '<button type="button" class="lvdr-sheet-row' + (c === R.chosen ? " on" : "") + '" data-c="' + E(c) + '"><span class="lvdr-logo">' + (window.lvCampusLogoHtml ? window.lvCampusLogoHtml(c) : "") + "</span><span>" + E(campusName(c)) + "</span></button>"; }).join("") : '<p class="lvdr-sheet-sub">These items have no campus in common. Check them out separately.</p>')
        + '</div><p class="lvdr-sheet-sub">Not on one of these campuses? Choose <b>Pickup</b> instead.</p></div>';
      document.body.appendChild(w);
      w.addEventListener("click", function (ev) {
        var b = ev.target.closest("[data-c]"); if (b) { choose(prefix, b.getAttribute("data-c")); w.remove(); return; }
        if (ev.target === w || ev.target.closest(".lvdr-x")) w.remove();
      });
    };
    (window.lvCampuses ? window.lvCampuses() : Promise.resolve()).then(go, go);
  };
  if (typeof window.deliveryFieldsHtml === "function" && !window.deliveryFieldsHtml.__lvdr) {
    var dfh0 = window.deliveryFieldsHtml;
    var dfh1 = function (prefix) {
      var html = dfh0.apply(this, arguments), R = REG[prefix];
      if (!R) return html;
      var cov = coverage(R), mine = "";
      try { mine = (window.lvMyCampusId && window.lvMyCampusId()) || localStorage.getItem("lv-dr-campus") || ""; } catch (_) {}
      R.chosen = mine && mine !== "none" && (cov.any || cov.list.indexOf(mine) >= 0) ? mine : (cov.list.length === 1 ? cov.list[0] : null);
      html = html.replace(/<p class="delivery-fee-line"[^>]*>[\s\S]*?<\/p>/g, "");
      var row = '<div class="lvdr-pick"><span class="lvdr-k"><i class="fa-solid fa-graduation-cap"></i> Deliver to campus</span>'
        + '<button type="button" class="lvdr-btn" onclick="lvDrChoose(\'' + E(prefix) + '\')"><span id="' + E(prefix) + 'DrName">Choose your campus</span><i class="fa-solid fa-chevron-down"></i></button></div>'
        + '<p class="delivery-fee-line" id="' + E(prefix) + 'FeeLine" style="margin:.35rem 0 0;"></p><p class="lvdr-note" id="' + E(prefix) + 'DrNote"></p>';
      html = html.replace(/(<label class="df-label" for="[^"]*Address")/, row + "$1");
      setTimeout(function () { (window.lvCampuses ? window.lvCampuses() : Promise.resolve()).then(function () { apply(prefix); }, function () { apply(prefix); }); }, 0);
      return html;
    };
    dfh1.__lvdr = true; window.deliveryFieldsHtml = dfh1;
    try { deliveryFieldsHtml = dfh1; } catch (_) {}
  }
  if (typeof window.readDeliveryFields === "function" && !window.readDeliveryFields.__lvdr) {
    var rdf0 = window.readDeliveryFields;
    var rdf1 = function (prefix, errorEl) {
      var d = rdf0.apply(this, arguments), R = REG[prefix];
      if (!d || !R || d.method !== "delivery") return d;
      var fail = function (m) { if (errorEl) { errorEl.textContent = m; errorEl.classList.remove("hidden"); } return null; };
      if (!R.chosen) return fail("Choose the campus it should be delivered to (under Delivery), or switch to pickup.");
      var bad = R.lines.filter(function (l) { return l.rules && !pick(l.rules, R.vcampus, R.chosen); });
      if (bad.length) return fail(bad.map(function (l) { return l.name; }).join(", ") + " can't be delivered to " + campusName(R.chosen) + ". Choose pickup, or check it out separately.");
      var eff = effective(R);
      if (eff.some(function (x) { return x.mode === "distance" && x.perKm > 0; }) && (R.vlat == null || R.vlng == null)) return fail("This shop has not set its location, so delivery by distance is not available. Choose pickup.");
      d.campusId = R.chosen;
      return d;
    };
    rdf1.__lvdr = true; window.readDeliveryFields = rdf1;
    try { readDeliveryFields = rdf1; } catch (_) {}
  }

  /* ---------------- shop: one delivery editor (listing form, package form, Delivery settings page) ---------------- */
  var PK = null, pkProbing = null;   // does vendor_packages have delivery_rules yet (0042)?
  function probePkg() {
    if (PK !== null) return Promise.resolve(PK);
    if (pkProbing) return pkProbing;
    pkProbing = Promise.resolve().then(function () { return sb.from("vendor_packages").select("delivery_rules").limit(1); })
      .then(function (r) { PK = !(r && r.error); return PK; }, function () { PK = false; return false; });
    return pkProbing;
  }
  var SHOP = { vcampus: null, vlat: null, vlng: null, fee: 0, mode: "flat", perKm: 0, loaded: false };
  function myVendor() { try { return typeof vendor !== "undefined" && vendor && vendor.id ? vendor : null; } catch (_) { return null; } }
  function shopInfo() {
    var v = myVendor(); if (!v) return Promise.resolve();
    return Promise.resolve().then(function () { return sb.from("vendors").select("campus_id,lat,lng,delivery_fee,delivery_fee_mode,delivery_fee_per_km").eq("id", v.id).maybeSingle(); }).then(function (r) {
      var d = r && r.data; if (!d) return;
      SHOP.vcampus = d.campus_id && d.campus_id !== "none" ? d.campus_id : null; SHOP.vlat = d.lat; SHOP.vlng = d.lng;
      SHOP.mode = d.delivery_fee_mode || (Number(d.delivery_fee) > 0 ? "flat" : "free"); SHOP.fee = Number(d.delivery_fee) || 0; SHOP.perKm = Number(d.delivery_fee_per_km) || 0; SHOP.loaded = true;
    }, function () {});
  }
  function ready() { return Promise.all([shopInfo(), window.lvCampuses ? window.lvCampuses().catch(function () {}) : null]); }
  var ICON = { free: "gift", flat: "cash", distance: "map-pin" };
  var TYPE = { free: ["Free", "No charge"], flat: ["Flat fee", "One price"], distance: ["By distance", "Per km"] };
  function ico(mode, size) { return window.lv3dIcon ? window.lv3dIcon(ICON[mode] || "cash", size || 40) : ""; }
  function legacyRule(p) {
    var m = String((p && p.delivery_fee_mode) || "free");
    var r = { mode: m === "flat" || m === "distance" ? m : "free", fee: Number(p && p.delivery_fee) || 0, perKm: Number(p && p.delivery_fee_per_km) || 0, scope: "all", campuses: [] };
    if (r.mode === "flat" && !(r.fee > 0)) r.mode = "free";
    return r;
  }
  function norm(list) { return (list || []).map(function (r) { return { mode: r.mode, fee: Number(r.fee) || 0, perKm: Number(r.perKm) || 0, scope: r.scope || "all", campuses: (r.campuses || []).slice() }; }); }
  function whereText(r, rules, own) {
    var others = rules.some(function (x) { return x !== r && x.scope !== "all"; });
    if (r.scope === "mine") return own ? campusName(own) : "Your campus";
    if (r.scope === "selected") return r.campuses.length === 1 ? campusName(r.campuses[0]) : r.campuses.length ? r.campuses.length + " campuses" : "No campus yet";
    return others ? "Everywhere else" : "All campuses";
  }
  function shortSummary(rules) {
    if (!rules || !rules.length) return "";
    return rules.map(function (r) { return (r.mode === "free" ? "Free" : r.mode === "flat" ? N(r.fee) : N(r.perKm) + "/km") + " · " + whereText(r, rules, SHOP.vcampus); }).join("  ·  ");
  }
  function problemsOf(rules) {
    var out = [], seen = {}, nAll = 0, nMine = 0;
    rules.forEach(function (r, i) {
      var n = rules.length > 1 ? " (option " + (i + 1) + ")" : "";
      if (r.mode === "flat" && !(r.fee > 0)) out.push("Enter a delivery fee above ₦0" + n + ", or choose Free.");
      if (r.mode === "flat" && r.fee > 1000000) out.push("That delivery fee is too high" + n + ".");
      if (r.mode === "distance" && !(r.perKm > 0 && r.perKm <= 1000)) out.push("Enter a fee per km between ₦1 and ₦1,000" + n + ".");
      if (r.mode === "distance" && (SHOP.vlat == null || SHOP.vlng == null)) out.push("Set your shop's location first (Edit shop) to charge by distance" + n + ".");
      if (r.scope === "all") nAll++;
      if (r.scope === "mine") { nMine++; if (!SHOP.vcampus) out.push("Your shop has no campus yet, so \"My campus\" can't be used" + n + "."); else seen[SHOP.vcampus] = (seen[SHOP.vcampus] || 0) + 1; }
      if (r.scope === "selected") { if (!r.campuses.length) out.push("Add at least one campus" + n + "."); r.campuses.forEach(function (c) { seen[c] = (seen[c] || 0) + 1; }); }
    });
    if (nAll > 1) out.push("Only one option can be \"Everywhere else\".");
    if (nMine > 1) out.push("Only one option can be \"My campus\".");
    Object.keys(seen).forEach(function (c) { if (seen[c] > 1) out.push(campusName(c) + " is in two options. Each campus can only have one."); });
    return out;
  }
  function toSave(rules) {
    return rules.map(function (r) {
      var o = { mode: r.mode, scope: r.scope };
      if (r.mode === "flat") o.fee = Math.round(Number(r.fee) * 100) / 100;
      if (r.mode === "distance") o.perKm = Math.round(Number(r.perKm));
      if (r.scope === "selected") o.campuses = r.campuses.slice(0, 300);
      return o;
    });
  }
  function legacyOf(rules) {   // the single setting kept for cards and older screens: the "everywhere" option, or the first
    var m = rules.find(function (r) { return r.scope === "all"; }) || rules[0];
    return { delivery_fee_mode: m.mode, delivery_fee: m.mode === "flat" ? m.fee : 0, delivery_fee_per_km: m.mode === "distance" ? m.perKm : 0 };
  }
  function Editor(hostEl, onChange) {
    var self = this; this.el = hostEl; this.rules = [legacyRule(null)];
    hostEl.classList.add("lde");
    hostEl.addEventListener("click", function (ev) { self.click(ev); });
    hostEl.addEventListener("input", function (ev) { self.input(ev); });
    this.changed = function () { if (onChange) onChange(self.rules); };
  }
  Editor.prototype.set = function (rules) { this.rules = norm(rules && rules.length ? rules : [legacyRule(null)]); this.render(); };
  Editor.prototype.problems = function () { return problemsOf(this.rules); };
  Editor.prototype.taken = function (i) {
    var t = {}, own = SHOP.vcampus;
    this.rules.forEach(function (r, j) {
      if (j === i) return;
      if (r.scope === "mine" && own) t[own] = "Your campus option";
      if (r.scope === "selected") r.campuses.forEach(function (c) { t[c] = "In option " + (j + 1); });
    });
    return t;
  };
  Editor.prototype.render = function () {
    var self = this, rules = this.rules, own = SHOP.vcampus, many = rules.length > 1;
    var html = rules.map(function (r, i) {
      var type = function (m) { return '<button type="button" class="lde-type' + (r.mode === m ? " on" : "") + '" data-a="mode" data-i="' + i + '" data-v="' + m + '" aria-pressed="' + (r.mode === m) + '"><span class="lde-type-ico">' + ico(m, 34) + '</span><b>' + TYPE[m][0] + "</b><small>" + TYPE[m][1] + '</small><i class="fa-solid fa-circle-check lde-tick"></i></button>'; };
      var scope = function (s, label, dis) { return '<button type="button" class="lde-pill' + (r.scope === s ? " on" : "") + '" data-a="scope" data-i="' + i + '" data-v="' + s + '"' + (dis ? " disabled" : "") + ">" + label + "</button>"; };
      return '<div class="lde-opt">'
        + '<div class="lde-opt-top"><span class="lde-opt-ico">' + ico(r.mode, 40) + '</span><div class="lde-opt-t"><b>' + E(r.mode === "free" ? "Free delivery" : r.mode === "flat" ? (r.fee > 0 ? N(r.fee) + " delivery" : "Flat fee") : (r.perKm > 0 ? N(r.perKm) + " per km" : "By distance")) + "</b><small>" + E(whereText(r, rules, own)) + "</small></div>"
        + (many ? '<button type="button" class="lde-del" data-a="del" data-i="' + i + '" aria-label="Remove this option"><i class="fa-regular fa-trash-can"></i></button>' : "") + "</div>"
        + '<div class="lde-types">' + type("free") + type("flat") + type("distance") + "</div>"
        + (r.mode === "flat" ? '<label class="lde-money"><span class="lde-cur">₦</span><input type="number" inputmode="numeric" min="1" step="50" data-f="fee" data-i="' + i + '" value="' + (r.fee || "") + '" placeholder="500" aria-label="Delivery fee in naira"><span class="lde-unit">per order</span></label>' : "")
        + (r.mode === "distance" ? '<label class="lde-money"><span class="lde-cur">₦</span><input type="number" inputmode="numeric" min="1" max="1000" step="10" data-f="perKm" data-i="' + i + '" value="' + (r.perKm || "") + '" placeholder="200" aria-label="Fee per kilometre in naira"><span class="lde-unit">per km · max ₦1,000</span></label>' : "")
        + (self.single ? "" : '<div class="lde-cap">Which campuses?</div>')
        + (self.single ? "" : '<div class="lde-pills">' + scope("mine", own ? "My campus" : "My campus (not set)", !own) + scope("selected", "Selected") + scope("all", many ? "All others" : "All campuses") + "</div>")
        + (self.single ? "" : r.scope === "mine" && own ? '<div class="lde-chips"><span class="lde-chip"><span class="lvdr-logo">' + (window.lvCampusLogoHtml ? window.lvCampusLogoHtml(own) : "") + "</span>" + E(campusName(own)) + "</span></div>" : "")
        + (self.single ? "" : r.scope === "selected" ? '<div class="lde-chips">' + r.campuses.map(function (c) { return '<span class="lde-chip"><span class="lvdr-logo">' + (window.lvCampusLogoHtml ? window.lvCampusLogoHtml(c) : "") + "</span>" + E(campusName(c)) + '<button type="button" data-a="unc" data-i="' + i + '" data-c="' + E(c) + '" aria-label="Remove ' + E(campusName(c)) + '"><i class="fa-solid fa-xmark"></i></button></span>'; }).join("") + '<button type="button" class="lde-addc" data-a="pickc" data-i="' + i + '"><i class="fa-solid fa-plus"></i> ' + (r.campuses.length ? "Add or remove" : "Add campuses") + "</button></div>" : "")
        + (self.single ? "" : (r.scope === "all" && many ? '<p class="lde-hint">Every campus not listed in your other options.</p>' : ""))
        + "</div>";
    }).join("");
    if (this.single) html += '<p class="lde-soon"><i class="fa-solid fa-circle-info"></i> A different delivery for each campus is being switched on by the Levromart team. For now this delivery applies to every campus.</p>';
    else if (rules.length < 10) html += '<button type="button" class="lde-more" data-a="add"><i class="fa-solid fa-plus"></i> Add delivery for other campuses</button>';
    html += '<div class="lde-sum">' + this.sumHtml() + "</div>";
    this.el.innerHTML = html;
  };
  Editor.prototype.sumHtml = function () {
    var rules = this.rules, own = SHOP.vcampus, p = this.problems();
    var rows = rules.map(function (r) { return '<li><span class="lde-sum-ico">' + ico(r.mode, 24) + "</span><span><b>" + E(r.scope === "selected" && r.campuses.length > 1 ? r.campuses.map(campusName).join(", ") : whereText(r, rules, own)) + "</b> " + E(ruleText(r)) + "</span></li>"; });
    if (!rules.some(function (r) { return r.scope === "all"; })) rows.push('<li class="lde-sum-muted"><span class="lde-sum-ico"><i class="fa-solid fa-store"></i></span><span>Other campuses: <b>pickup only</b></span></li>');
    return '<div class="lde-cap">What buyers see</div><ul>' + rows.join("") + "</ul>"
      + (p.length ? '<div class="lde-err">' + p.map(function (x) { return '<div><i class="fa-solid fa-circle-exclamation"></i> ' + E(x) + "</div>"; }).join("") + "</div>" : "");
  };
  Editor.prototype.click = function (ev) {
    var b = ev.target.closest("[data-a]"); if (!b || b.disabled || !this.el.contains(b)) return;
    var self = this, a = b.getAttribute("data-a"), i = Number(b.getAttribute("data-i")), r = this.rules[i];
    if (a === "mode") r.mode = b.getAttribute("data-v");
    else if (a === "scope") r.scope = b.getAttribute("data-v");
    else if (a === "del") this.rules.splice(i, 1);
    else if (a === "unc") r.campuses = r.campuses.filter(function (c) { return c !== b.getAttribute("data-c"); });
    else if (a === "add") {
      var hasAll = this.rules.some(function (x) { return x.scope === "all"; }), hasMine = this.rules.some(function (x) { return x.scope === "mine"; });
      this.rules.push({ mode: "flat", fee: 0, perKm: 0, scope: !hasMine && SHOP.vcampus ? "mine" : !hasAll ? "all" : "selected", campuses: [] });
      // a new option for "my campus" goes first, so it reads top to bottom: my campus, picked campuses, everywhere else
      this.rules.sort(function (x, y) { var o = { mine: 0, selected: 1, all: 2 }; return o[x.scope] - o[y.scope]; });
    } else if (a === "pickc" && window.lvOpenCampusPicker) {
      window.lvCampuses().then(function () {
        var taken = self.taken(i);
        window.lvOpenCampusPicker({ title: "Campuses for this option", multi: true, selected: r.campuses.slice(), taken: taken,
          onDone: function (ids) { r.campuses = (ids || []).filter(function (c) { return c && c !== "none" && c !== "all" && !taken[c]; }); self.render(); self.changed(); } });
      });
      return;
    } else return;
    this.render(); this.changed();
  };
  Editor.prototype.input = function (ev) {
    var f = ev.target.getAttribute("data-f"); if (!f) return;
    var r = this.rules[Number(ev.target.getAttribute("data-i"))]; if (!r) return;
    r[f] = Math.max(0, Number(ev.target.value) || 0);
    var top = ev.target.closest(".lde-opt"), t = top && top.querySelector(".lde-opt-t b");
    if (t) t.textContent = r.mode === "flat" ? (r.fee > 0 ? N(r.fee) + " delivery" : "Flat fee") : (r.perKm > 0 ? N(r.perKm) + " per km" : "By distance");
    var sum = this.el.querySelector(".lde-sum"); if (sum) sum.innerHTML = this.sumHtml();
    this.changed();
  };
  window.lvDrEditor = Editor;

  /* the listing form */
  var FORM = { on: false, ed: null };
  function formHost() {
    var box = byId("prodDeliverySettings"); if (!box) return null;
    var h = byId("lvDrEditor");
    if (!h) {
      h = document.createElement("div"); h.id = "lvDrEditor"; box.appendChild(h);
      var link = document.createElement("button"); link.type = "button"; link.className = "lde-link"; link.id = "lvDrAllLink";
      link.innerHTML = '<i class="fa-solid fa-layer-group"></i> Set the same delivery for all your listings'; link.onclick = function () { window.lvDrOpenPage(); };
      box.appendChild(link);
      FORM.ed = new Editor(h);
    }
    return h;
  }
  function legacyEls() { return ["prodDeliveryMode", "prodDeliveryFlatRow", "prodDeliveryDistanceRow", "prodDeliveryHint"].map(byId).concat([document.querySelector("#prodDeliverySettings > label")]).filter(Boolean); }
  window.lvDrLoad = function (p) {
    var rules = p && Array.isArray(p.delivery_rules) && p.delivery_rules.length ? p.delivery_rules : [legacyRule(p)];
    FORM.on = false;
    probe().then(function (ok) {
      return ready().then(function () {
        if (!formHost()) return;
        FORM.on = true; FORM.single = !ok; FORM.ed.single = !ok;
        legacyEls().forEach(function (el) { el.classList.add("lvdr-hide"); });
        FORM.ed.set(ok ? rules : [rules.find(function (r) { return r.scope === "all"; }) || rules[0]].map(function (r) { return Object.assign({}, r, { scope: "all", campuses: [] }); }));
      });
    });
  };
  // Levi's guided "add a listing" fills the old single setting: follow it while there is one option for every campus
  document.addEventListener("change", function (ev) {
    if (!FORM.on || !FORM.ed || FORM.ed.rules.length !== 1 || FORM.ed.rules[0].scope !== "all") return;
    if (["prodDeliveryMode", "prodDeliveryFee", "prodDeliveryPerKm"].indexOf(ev.target && ev.target.id) < 0) return;
    FORM.ed.set([legacyRule({ delivery_fee_mode: byId("prodDeliveryMode").value, delivery_fee: byId("prodDeliveryFee").value, delivery_fee_per_km: byId("prodDeliveryPerKm").value })]);
  }, true);
  window.lvDrRead = function (isService) {
    if (!FORM.on || !FORM.ed) return undefined;
    if (isService) return null;
    var p = FORM.ed.problems(); if (p.length) throw new Error(p[0]);
    var rules = toSave(FORM.ed.rules), L = legacyOf(rules);
    var set = function (id, v) { var el = byId(id); if (el) el.value = v; };
    set("prodDeliveryMode", L.delivery_fee_mode); set("prodDeliveryFee", L.delivery_fee); set("prodDeliveryPerKm", L.delivery_fee_per_km);
    if (FORM.single) return undefined;   // the database has no campus options yet: the single setting above is what is saved
    return rules;   // always kept (one option for every campus too), so the shop counts as "delivery set up"
  };

  /* the package form */
  var PKG = { on: false, ed: null };
  window.lvDrPkgRules = function (id) {
    return probePkg().then(function (ok) {
      if (!ok) return null;
      return sb.from("vendor_packages").select("delivery_rules").eq("id", id).maybeSingle().then(function (r) { return (r && r.data && r.data.delivery_rules) || null; });
    });
  };
  window.lvDrPkgLoad = function (pkg) {
    PKG.on = false; var sec = byId("pkgDeliverySec");
    Promise.all([probe(), probePkg()]).then(function (ok) {
      if (!ok[0] || !ok[1] || !sec) return;
      return ready().then(function () {
        if (!PKG.ed) PKG.ed = new Editor(byId("pkgDeliveryHost"));
        var rules = pkg && Array.isArray(pkg.delivery_rules) && pkg.delivery_rules.length ? pkg.delivery_rules : [legacyRule({ delivery_fee_mode: SHOP.mode, delivery_fee: SHOP.fee, delivery_fee_per_km: SHOP.perKm })];
        PKG.ed.set(rules); sec.classList.remove("hidden"); PKG.on = true;
      });
    });
  };
  window.lvDrPkgRead = function () {
    if (!PKG.on || !PKG.ed) return undefined;
    var p = PKG.ed.problems(); if (p.length) throw new Error(p[0]);
    return toSave(PKG.ed.rules);
  };

  /* ---------------- the Delivery settings page: every listing, one tap to edit, or one setting for all ---------------- */
  function thumb(x) { var ph = Array.isArray(x.photos) ? x.photos.filter(Boolean)[0] : null; return ph ? '<img src="' + E(ph) + '" alt="" loading="lazy" decoding="async">' : '<i class="fa-solid fa-box"></i>'; }
  function rowSummary(x) {
    var rules = Array.isArray(x.delivery_rules) && x.delivery_rules.length ? x.delivery_rules : [x.kind === "package" ? legacyRule({ delivery_fee_mode: SHOP.mode, delivery_fee: SHOP.fee, delivery_fee_per_km: SHOP.perKm }) : legacyRule(x)];
    return { rules: rules, text: shortSummary(norm(rules)), mode: rules[0].mode, custom: Array.isArray(x.delivery_rules) && x.delivery_rules.length > 0 };
  }
  var PG = null;
  window.lvDrOpenPage = function () {
    var v = myVendor(); if (!v) { if (typeof showToast === "function") showToast("Open your shop first.", "info"); return; }
    var old = byId("ldePage"); if (old) old.remove();
    var w = document.createElement("div"); w.id = "ldePage"; w.className = "lde-page"; w.setAttribute("role", "dialog"); w.setAttribute("aria-modal", "true"); w.setAttribute("aria-label", "Delivery settings");
    w.innerHTML = '<div class="lde-top"><button type="button" class="lde-back" data-a="close" aria-label="Back"><i class="fa-solid fa-arrow-left"></i></button><div><h2>Delivery settings</h2><p>How each listing gets to your buyers</p></div></div>'
      + '<div class="lde-scroll"><div class="lde-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading your listings…</div></div>';
    document.body.appendChild(w); document.documentElement.classList.add("lde-open");
    // the phone's back button / gesture closes this page (and nothing behind it)
    try { history.pushState(Object.assign({}, history.state, { lvOverlay: "lde" }), ""); } catch (_) {}
    w.addEventListener("click", function (ev) { pageClick(ev, w); });
    Promise.all([probe(), probePkg(), ready()]).then(function (ok) {
      var single = !ok[0];   // before migration 0041: one delivery per listing, for every campus
      var prods = sb.from("products").select("id,name,photos,listing_type,status," + (single ? "" : "delivery_rules,") + "delivery_fee_mode,delivery_fee,delivery_fee_per_km").eq("vendor_id", v.id).eq("is_service", false).neq("status", "deleted").order("name");
      var pkgs = ok[1] && !single ? sb.from("vendor_packages").select("id,name,photos,status,delivery_rules").eq("vendor_id", v.id).order("name") : Promise.resolve({ data: [] });
      return Promise.all([prods, pkgs]).then(function (res) {
        var list = (res[0].data || []).map(function (x) { x.kind = x.listing_type === "rent" ? "rental" : "product"; return x; })
          .concat((res[1].data || []).map(function (x) { x.kind = "package"; return x; }));
        if (single) list = list.filter(function (x) { return x.kind !== "package"; });
        PG = { w: w, list: list, open: null, ed: null, allEd: null, all: false, single: single };
        paint();
      });
    }).catch(function (e) { var s = w.querySelector(".lde-scroll"); if (s) s.innerHTML = '<div class="lde-card"><p>Couldn\'t load your listings. ' + E(e && e.message || "") + "</p></div>"; });
  };
  function paint() {
    var w = PG.w, sc = w.querySelector(".lde-scroll"), n = PG.list.length;
    var steps = '<div class="lde-hero"><div class="lde-hero-h"><span>' + ico("distance", 48) + "</span><div><b>Delivery by campus</b><small>Give each campus the delivery that makes sense.</small></div></div>"
      + '<ol class="lde-steps"><li><span>' + ico("free", 30) + "</span><div><b>Pick a delivery type</b><small>Free, a flat fee, or a fee per km.</small></div></li>"
      + "<li><span>" + ico("distance", 30) + "</span><div><b>Choose the campuses</b><small>Your campus, campuses you pick, or everywhere else. Each campus gets one option.</small></div></li>"
      + "<li><span>" + ico("flat", 30) + "</span><div><b>Buyers see the right fee</b><small>They choose their campus at checkout. Pickup is always available.</small></div></li></ol></div>";
    var allCard = '<div class="lde-card lde-allcard"><label class="lde-switch-row"><div><b>Same delivery for all listings</b><small>Set it once and use it for every product and package, like copying Monday to every day.</small></div><span class="lde-switch"><input type="checkbox" data-a="allsw"' + (PG.all ? " checked" : "") + '><i></i></span></label>'
      + (PG.all ? '<div id="ldeAllEd"></div><button type="button" class="lde-save" data-a="applyall"><i class="fa-solid fa-check-double"></i> Use for all ' + n + " listing" + (n === 1 ? "" : "s") + "</button>" : "") + "</div>";
    var rows = PG.list.map(function (x, i) {
      var s = rowSummary(x), open = PG.open === i;
      return '<div class="lde-item' + (open ? " open" : "") + (PG.all ? " dim" : "") + '"><button type="button" class="lde-row" data-a="row" data-i="' + i + '" aria-expanded="' + open + '">'
        + '<span class="lde-thumb">' + thumb(x) + '</span><span class="lde-row-t"><b>' + E(x.name || "Untitled") + '</b><small><span class="lde-mini">' + ico(s.mode, 18) + "</span>" + E(s.text) + "</small></span>"
        + '<span class="lde-kind lde-k-' + x.kind + '">' + (x.kind === "package" ? "Package" : x.kind === "rental" ? "Rental" : "Product") + '</span><i class="fa-solid fa-chevron-down lde-chev"></i></button>'
        + (open ? '<div class="lde-panel"><div id="ldeRowEd"></div><div class="lde-actions"><button type="button" class="lde-ghost" data-a="copyall" data-i="' + i + '"><i class="fa-regular fa-copy"></i> Use for all listings</button><button type="button" class="lde-save" data-a="saverow" data-i="' + i + '">Save</button></div></div>' : "")
        + "</div>";
    }).join("");
    sc.innerHTML = steps + allCard + '<div class="lde-cap lde-listcap">Your listings (' + n + ")</div>"
      + (n ? '<div class="lde-list">' + rows + "</div>" : '<div class="lde-card"><p>You have no products or packages yet. Add one and come back here.</p></div>')
      + '<p class="lde-foot"><i class="fa-solid fa-circle-info"></i> Services happen in person, so they have no delivery.</p>';
    if (PG.all) { PG.allEd = PG.allEd && PG.allEd.el === byId("ldeAllEd") ? PG.allEd : new Editor(byId("ldeAllEd")); PG.allEd.single = PG.single; if (!PG.allRules) PG.allRules = rowSummary(PG.list[0] || {}).rules; PG.allEd.set(PG.allRules); PG.allEd.changed = function () { PG.allRules = PG.allEd.rules; }; }
    if (PG.open != null && byId("ldeRowEd")) { PG.ed = new Editor(byId("ldeRowEd")); PG.ed.single = PG.single; PG.ed.set(rowSummary(PG.list[PG.open]).rules); }
  }
  function saveOne(x, rules) {
    var payload, q;
    if (x.kind === "package") { payload = { delivery_rules: rules }; q = sb.from("vendor_packages").update(payload).eq("id", x.id); }
    else { payload = Object.assign(PG && PG.single ? {} : { delivery_rules: rules }, legacyOf(rules)); q = sb.from("products").update(payload).eq("id", x.id); }
    return Promise.resolve(q).then(function (r) { if (r && r.error) throw r.error; Object.assign(x, payload); markDone(); });
  }
  function saveAll(rules) {
    var v = myVendor(), single = false;
    var a = sb.from("products").update(Object.assign(PG.single ? {} : { delivery_rules: rules }, legacyOf(rules))).eq("vendor_id", v.id).eq("is_service", false);
    var b = PG.list.some(function (x) { return x.kind === "package"; }) ? sb.from("vendor_packages").update({ delivery_rules: rules }).eq("vendor_id", v.id) : Promise.resolve({});
    return Promise.all([a, b]).then(function (res) {
      res.forEach(function (r) { if (r && r.error) throw r.error; }); markDone();
      PG.list.forEach(function (x) { x.delivery_rules = x.kind === "package" || !single ? rules : null; if (x.kind !== "package") Object.assign(x, legacyOf(rules)); });
    });
  }
  function busy(btn, on) { if (!btn) return; if (on) { btn.dataset.l = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…'; } else { btn.disabled = false; if (btn.dataset.l) btn.innerHTML = btn.dataset.l; } }
  function toast(m, t) { if (typeof showToast === "function") showToast(m, t || "success"); }
  function confirmAll(n) {
    var msg = "This replaces the delivery on all " + n + " listing" + (n === 1 ? "" : "s") + ". You can still change any one of them afterwards.";
    return typeof showConfirmDialog === "function" ? showConfirmDialog(msg, { title: "Use for all listings?", okLabel: "Use for all" }) : Promise.resolve(window.confirm(msg));
  }
  window.addEventListener("popstate", function (e) {
    var pg = document.getElementById("ldePage");
    if (!pg) return;
    pg.remove(); document.documentElement.classList.remove("lde-open");
    e.stopImmediatePropagation();
  }, true);
  function pageClick(ev, w) {
    var b = ev.target.closest("[data-a]"); if (!b || !PG && b.getAttribute("data-a") !== "close") return;
    var a = b.getAttribute("data-a"), i = Number(b.getAttribute("data-i"));
    if (a === "close") { if (history.state && history.state.lvOverlay === "lde") { history.back(); return; } w.remove(); document.documentElement.classList.remove("lde-open"); return; }
    if (a === "allsw") { PG.all = b.checked; PG.open = null; paint(); return; }
    if (a === "row") { if (PG.all) return; PG.open = PG.open === i ? null : i; paint(); var it = w.querySelectorAll(".lde-item")[i]; if (it && PG.open != null) it.scrollIntoView({ block: "start", behavior: "smooth" }); return; }
    var ed = a === "applyall" ? PG.allEd : PG.ed; if (!ed) return;
    var p = ed.problems(); if (p.length) { toast(p[0], "error"); return; }
    var rules = toSave(ed.rules);
    if (a === "saverow") { busy(b, true); saveOne(PG.list[i], rules).then(function () { toast("Delivery saved."); PG.open = null; paint(); }, function (e) { busy(b, false); toast("Couldn't save: " + (e && e.message || "try again"), "error"); }); }
    if (a === "applyall" || a === "copyall") {
      confirmAll(PG.list.length).then(function (yes) {
        if (!yes) return; busy(b, true);
        saveAll(rules).then(function () { toast("Delivery set for all your listings."); PG.all = false; PG.open = null; PG.allRules = null; paint(); }, function (e) { busy(b, false); toast("Couldn't save: " + (e && e.message || "try again"), "error"); });
      });
    }
  }

  /* ---------------- tell shops about it every time the app opens until their delivery is set up ---------------- */
  function markDone() { var v = myVendor(); try { if (v) localStorage.setItem("lv-dr-intro:" + v.id, "done"); } catch (_) {} }
  function laterKey(v) { return "lv-dr-later:" + v.id; }
  function setUpAlready(v) {   // set up = any of the shop's listings has its delivery options saved (on any device)
    try { if (localStorage.getItem("lv-dr-intro:" + v.id) === "done") return Promise.resolve(true); } catch (_) {}
    var a = sb.from("products").select("id", { count: "exact", head: true }).eq("vendor_id", v.id).not("delivery_rules", "is", null);
    var b = probePkg().then(function (ok) { return ok ? sb.from("vendor_packages").select("id", { count: "exact", head: true }).eq("vendor_id", v.id).not("delivery_rules", "is", null) : { count: 0 }; });
    return Promise.all([a, b]).then(function (r) { var n = (r[0] && r[0].count || 0) + (r[1] && r[1].count || 0); if (n > 0) markDone(); return n > 0; }, function () { return true; });
  }
  function intro() {
    var v = myVendor(); if (!v || byId("ldeIntro")) return;
    try { if (sessionStorage.getItem(laterKey(v))) return; } catch (_) {}
    probe().then(function (ok) {
      if (!ok) return;   // the database does not have delivery by campus yet (migration 0041)
      return setUpAlready(v).then(function (done) {
        if (done) return;
        return sb.from("products").select("id", { count: "exact", head: true }).eq("vendor_id", v.id).eq("is_service", false).neq("status", "deleted").then(function (r) {
          if (!r || r.error || !(r.count > 0) || byId("ldeIntro")) return;
          var w = document.createElement("div"); w.id = "ldeIntro"; w.className = "lde-intro"; w.setAttribute("role", "dialog"); w.setAttribute("aria-modal", "true"); w.setAttribute("aria-label", "Delivery by campus");
          w.innerHTML = '<div class="lde-intro-card"><div class="lde-intro-icons">' + ico("free", 56) + ico("flat", 56) + ico("distance", 56) + "</div>"
            + "<h3>Set up your delivery</h3><p>Free delivery on your campus, a flat fee on nearby campuses, per km everywhere else. Buyers choose their campus and see the right fee. It takes a minute.</p>"
            + '<button type="button" class="lde-save" data-a="go">Set up delivery</button><button type="button" class="lde-ghost" data-a="later">I\'ll do it later</button></div>';
          document.body.appendChild(w);
          w.addEventListener("click", function (ev) {
            var b = ev.target.closest("[data-a]"); if (!b && ev.target !== w) return;
            var a = b ? b.getAttribute("data-a") : "later";
            try { sessionStorage.setItem(laterKey(v), "1"); } catch (_) {}   // not again until the app is opened again
            w.remove(); if (a === "go") window.lvDrOpenPage();
          });
        });
      });
    });
  }
  // wait for the shop to load (slow networks), then ask
  (function wait(n) { if (myVendor()) { setTimeout(intro, 1500); return; } if (n < 45) setTimeout(function () { wait(n + 1); }, 2000); })(0);
  window.lvDrHubRowOk = true;
  probe();

  /* ---------------- product cards: the delivery line shows the type, for the buyer's campus ---------------- */
  var RC = {}, VC = {}, PC = {}, want = [], wantT = null;
  function cardLine(p) {
    var item = p.discount_price != null && Number(p.discount_price) > 0 && Number(p.discount_price) < Number(p.sale_price) ? Number(p.discount_price) : Number(p.sale_price);
    var rules = Array.isArray(p.delivery_rules) ? p.delivery_rules : RC[p.id], rule;
    if (rules && rules.length) {
      var me = window.lvMyCampusId ? window.lvMyCampusId() : "";
      rule = me && me !== "none" ? pick(rules, VC[p.id] || (p.vendor && p.vendor.campus_id) || null, me) : (rules.find(function (r) { return r.scope === "all"; }) || null);
      if (!rule && (!me || me === "none")) rule = rules[0];
      if (!rule) return '<div class="product-card-total-line lvdb lvdb-pick" title="Not delivered to your campus"><i class="fa-solid fa-store" aria-hidden="true"></i><span class="product-card-total-label">Pickup only</span><strong>' + N(item) + "</strong></div>";
    } else rule = legacyRule(p);
    if (rule.mode === "free") return '<div class="product-card-total-line lvdb lvdb-free" title="Free delivery"><i class="fa-solid fa-gift" aria-hidden="true"></i><span class="product-card-total-label">Free delivery</span><strong>' + N(item) + "</strong></div>";
    if (rule.mode === "distance") return '<div class="product-card-total-line lvdb lvdb-km" title="Delivery fee per km"><i class="fa-solid fa-route" aria-hidden="true"></i><span class="product-card-total-label">Delivery</span><strong>' + N(rule.perKm) + "/km</strong></div>";
    return '<div class="product-card-total-line lvdb lvdb-flat" title="Total with ' + N(rule.fee) + ' delivery"><i class="fa-solid fa-truck" aria-hidden="true"></i><span class="product-card-total-label">Total</span><strong>' + N(item + (Number(rule.fee) || 0)) + "</strong></div>";
  }
  function flushWant() {
    var ids = want.splice(0, want.length); if (!ids.length || !OK) return;
    for (var k = 0; k < ids.length; k += 100) (function (chunk) {
      Promise.resolve(sb.from("products").select("id,delivery_rules,vendor:vendors(campus_id)").in("id", chunk)).then(function (r) {
        (r && r.data || []).forEach(function (x) { RC[x.id] = x.delivery_rules || null; VC[x.id] = x.vendor && x.vendor.campus_id || null; });
        chunk.forEach(function (id) { if (RC[id] === undefined) RC[id] = null; if (RC[id] && PC[id]) document.querySelectorAll('.product-card-wrap[data-product-id="' + id + '"] .product-card-total-line').forEach(function (el) { el.outerHTML = cardLine(PC[id]); }); });
      }, function () {});
    })(ids.slice(k, k + 100));
  }
  if (typeof window.productCardHtml === "function" && !window.productCardHtml.__lvdr) {
    var pch0 = window.productCardHtml;
    var pch1 = function (p) {
      var html = pch0.apply(this, arguments);
      try {
        if (!p || p.is_service || p.sale_price == null || !/product-card-total-label">(Total|Delivery)</.test(html)) return html;
        PC[p.id] = p;
        if (OK && p.delivery_rules === undefined && RC[p.id] === undefined && want.indexOf(p.id) < 0) { want.push(p.id); clearTimeout(wantT); wantT = setTimeout(flushWant, 150); }
        return html.replace(/<div class="product-card-total-line"[^>]*>[\s\S]*?<\/div>/, cardLine(p));
      } catch (_) { return html; }
    };
    pch1.__lvdr = true; window.productCardHtml = pch1;
    try { productCardHtml = pch1; } catch (_) {}
  }

  /* package cards: the same delivery types (the package's own options, else the shop's fee) */
  var PRC = {}, PV = {}, pwant = [], pwantT = null;
  function pkgLine(pkg) {
    var v = pkg && pkg.vendor || {}, rules = Array.isArray(pkg.delivery_rules) ? pkg.delivery_rules : PRC[pkg.id], rule = null, me = window.lvMyCampusId ? window.lvMyCampusId() : "";
    if (rules && rules.length) { rule = me && me !== "none" ? pick(rules, v.campus_id || PV[pkg.id] || null, me) : (rules.find(function (r) { return r.scope === "all"; }) || rules[0]); }
    else rule = legacyRule({ delivery_fee_mode: v.delivery_fee_mode || (Number(v.delivery_fee) > 0 ? "flat" : "free"), delivery_fee: v.delivery_fee, delivery_fee_per_km: v.delivery_fee_per_km });
    var a = ' data-lvdb-pkg="' + E(pkg.id) + '"';
    return !rule ? '<div class="package-card-delivery lvdb-pick"' + a + '><i class="fa-solid fa-store"></i> Pickup only on your campus</div>'
      : rule.mode === "free" ? '<div class="package-card-delivery lvdb-free"' + a + '><i class="fa-solid fa-gift"></i> Free delivery</div>'
      : rule.mode === "distance" ? '<div class="package-card-delivery lvdb-km"' + a + '><i class="fa-solid fa-route"></i> Delivery ' + N(rule.perKm) + "/km</div>"
      : '<div class="package-card-delivery lvdb-flat"' + a + '><i class="fa-solid fa-truck"></i> ' + N(rule.fee) + " delivery</div>";
  }
  function flushPkg() {
    var ids = pwant.splice(0, pwant.length); if (!ids.length || !PK) return;
    Promise.resolve(sb.from("vendor_packages").select("id,delivery_rules,vendor:vendors(campus_id)").in("id", ids.slice(0, 200))).then(function (r) {
      (r && r.data || []).forEach(function (x) { PRC[x.id] = x.delivery_rules || null; PV[x.id] = x.vendor && x.vendor.campus_id || null; });
      ids.forEach(function (id) { if (PRC[id] === undefined) PRC[id] = null; if (PRC[id] && PC["pkg:" + id]) document.querySelectorAll('[data-lvdb-pkg="' + id + '"]').forEach(function (el) { el.outerHTML = pkgLine(PC["pkg:" + id]); }); });
    }, function () {});
  }
  if (typeof window.packageCardHtml === "function" && !window.packageCardHtml.__lvdr) {
    var pkc0 = window.packageCardHtml;
    var pkc1 = function (pkg) {
      var html = pkc0.apply(this, arguments);
      try {
        if (!pkg || !pkg.id) return html;
        PC["pkg:" + pkg.id] = pkg;
        if (pkg.delivery_rules === undefined && PRC[pkg.id] === undefined && pwant.indexOf(pkg.id) < 0) {
          probePkg().then(function (ok) { if (!ok) return; pwant.push(pkg.id); clearTimeout(pwantT); pwantT = setTimeout(flushPkg, 150); });
        }
        html = html.replace(/<div class="package-card-delivery[^"]*"[^>]*>[\s\S]*?<\/div>/, "");
        return html.replace(/(<div class="package-card-vendor">[\s\S]*?<\/div>)/, "$1" + pkgLine(pkg));
      } catch (_) { return html; }
    };
    pkc1.__lvdr = true; window.packageCardHtml = pkc1;
    try { packageCardHtml = pkc1; } catch (_) {}
  }
})();


/* ===== Admin: tap a line of Levromart's transaction history and a sheet slides up with everything behind it: who paid,
   from whom to whom, the order, the shop, the bank, the references. ===== */
(function () {
  "use strict";
  function E(s) { return typeof esc === "function" ? esc(s) : String(s == null ? "" : s); }
  function K(k) { return "₦" + (Number(k || 0) / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 }); }   // these amounts are in kobo: 150 kobo is ₦1.50
  function NA(n) { return "₦" + Number(n || 0).toLocaleString("en-NG", { maximumFractionDigits: 2 }); }                  // orders are in naira
  function when(t) { try { return new Date(t).toLocaleString("en-NG", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }); } catch (_) { return String(t || ""); } }
  function who(name, handle) { return (name ? E(name) : "Someone") + (handle ? ' <span class="ltx-h">@' + E(handle) + "</span>" : ""); }
  function row(label, value) { return value == null || value === "" ? "" : '<div class="ltx-row"><span>' + E(label) + "</span><b>" + value + "</b></div>"; }
  function initials(n) { return String(n || "?").trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0] || ""; }).join("").toUpperCase() || "?"; }
  // a person or shop as the app shows them: their photo, or their initials on their own colour
  function hue(t) { var h = 0; t = String(t || "?"); for (var i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % 360; return h; }
  function avatar(name, pic, kind) {
    var ini = E(initials(name)), h = hue(name), bg = "background:linear-gradient(135deg,hsl(" + h + ",62%,52%),hsl(" + ((h + 38) % 360) + ",64%,36%))";
    if (kind === "bank") return '<span class="ltx-av ltx-av-bank"><i class="fa-solid fa-building-columns"></i></span>';
    if (kind === "levromart") return '<span class="ltx-av ltx-av-img"><img src="/icon-192.png" alt=""></span>';
    if (pic) return '<span class="ltx-av ltx-av-img" style="' + bg + '" data-ini="' + ini + '"><img src="' + E(pic) + '" alt="" loading="lazy" onerror="var p=this.parentNode;p.classList.remove(\'ltx-av-img\');p.textContent=p.getAttribute(\'data-ini\')"></span>';
    return '<span class="ltx-av" style="' + bg + '">' + ini + "</span>";
  }
  function party(label, name, handle, sub, pic, kind) {
    return '<div class="ltx-party">' + avatar(name, pic, kind) + '<small>' + E(label) + "</small><b>" + E(name || "Someone") + "</b>" + (handle ? '<em>@' + E(handle) + "</em>" : "") + (sub ? "<em>" + E(sub) + "</em>" : "") + "</div>";
  }
  function flow(a, b, amount) { return '<div class="ltx-flow">' + a + '<div class="ltx-arrow"><span>' + amount + '</span><i class="fa-solid fa-arrow-right-long"></i></div>' + b + "</div>"; }
  function status(s) {
    var map = { success: ["Sent", "ok"], processing: ["On its way", "wait"], requested: ["Waiting for approval", "wait"], failed: ["Failed", "bad"], reversed: ["Returned", "bad"], rejected: ["Rejected", "bad"], completed: ["Completed", "ok"], cancelled: ["Cancelled", "bad"] };
    var m = map[s] || [String(s || "").replace(/_/g, " "), "wait"];
    return s ? '<span class="ltx-chip ltx-' + m[1] + '">' + E(m[0]) + "</span>" : "";
  }
  function body(d) {
    var k = Number(d.amount_kobo), plus = k > 0, ref = d.reference || "", out = "", title = d.note || "Transaction";
    var kind = d.kind;
    if (kind === "commission" || kind === "commission_reversed") {
      title = kind === "commission" ? "Commission (3%)" : "Commission taken back";
      out += flow(party("Buyer", d.buyer_name, d.buyer_handle, null, d.buyer_avatar), party("Shop", d.shop_name, d.shop_handle, null, d.shop_avatar), d.order_total ? NA(d.order_total) : "Order");
      out += '<div class="ltx-card">' + row("Order", d.order_id ? '<a href="#" class="ltx-link" data-order="' + E(d.order_id) + '">#' + E(String(d.order_id).slice(0, 8).toUpperCase()) + "</a>" : "")
        + row("Order total", d.order_total != null ? NA(d.order_total) : "") + row("Delivery fee", d.order_delivery_fee != null && Number(d.order_delivery_fee) > 0 ? NA(d.order_delivery_fee) : "")
        + row("Levromart's 3%", (plus ? "+" : "−") + K(Math.abs(k))) + row("Order status", status(d.order_status)) + row("Buyer email", d.buyer_email ? E(d.buyer_email) : "") + "</div>";
    } else if (kind === "transaction_fee" || kind === "transaction_fee_return") {
      if (d.transfer_id) {
        title = "Transfer fee";
        out += flow(party("From", d.from_name, d.from_handle, null, d.from_avatar), party("To", d.to_name, d.to_handle, null, d.to_avatar), K(d.transfer_amount_kobo));
        out += '<div class="ltx-card">' + row("Amount sent", K(d.transfer_amount_kobo)) + row("Note", d.transfer_note ? "“" + E(d.transfer_note) + "”" : "") + row("Fee paid by", who(d.from_name, d.from_handle)) + row("Levromart's fee", (plus ? "+" : "−") + K(Math.abs(k))) + "</div>";
      } else if (d.user_withdrawal_id) {
        title = kind === "transaction_fee" ? "Withdrawal fee" : "Withdrawal fee given back";
        out += flow(party("Wallet of", d.user_withdrawal_name, d.user_withdrawal_handle, null, d.user_withdrawal_avatar), party("Bank", d.user_withdrawal_bank || "Bank", null, d.user_withdrawal_last4 ? "···" + d.user_withdrawal_last4 : "", null, "bank"), K(d.user_withdrawal_amount_kobo));
        out += '<div class="ltx-card">' + row("Withdrawn", K(d.user_withdrawal_amount_kobo)) + row("Account name", d.user_withdrawal_account_name ? E(d.user_withdrawal_account_name) : "") + row("Status", status(d.user_withdrawal_status)) + row("Levromart's fee", (plus ? "+" : "−") + K(Math.abs(k))) + "</div>";
      } else if (d.order_id) {
        title = "Wallet payment fee";
        out += flow(party("Buyer paid", d.buyer_name, d.buyer_handle, null, d.buyer_avatar), party("Shop", d.shop_name, d.shop_handle, null, d.shop_avatar), d.order_total ? NA(d.order_total) : "Order");
        out += '<div class="ltx-card">' + row("Paid with", "Levromart wallet") + row("Order", '<a href="#" class="ltx-link" data-order="' + E(d.order_id) + '">#' + E(String(d.order_id).slice(0, 8).toUpperCase()) + "</a>") + row("Order total", d.order_total != null ? NA(d.order_total) : "") + row("Fee paid by", who(d.buyer_name, d.buyer_handle)) + row("Levromart's fee", (plus ? "+" : "−") + K(Math.abs(k))) + "</div>";
      } else out += '<div class="ltx-card">' + row("What", E(d.note || "Transaction fee")) + row("Amount", K(Math.abs(k))) + "</div>";
    } else if (kind === "listing_fee") {
      title = "Monthly listing fee";
      out += flow(party("Shop", d.shop_name, d.shop_handle, null, d.shop_avatar), party("To", "Levromart", null, null, null, "levromart"), "+" + K(k));
      out += '<div class="ltx-card">' + row("Shop", who(d.shop_name, d.shop_handle)) + row("What", E(d.note || "Monthly listing fee")) + row("Levromart got", "+" + K(k) + ' <small class="ltx-mute">after Paystack\'s fee</small>') + "</div>";
    } else if (kind === "withdrawal" || kind === "withdrawal_return") {
      title = kind === "withdrawal" ? "Levromart withdrawal" : "Withdrawal returned";
      out += flow(party("From", "Levromart wallet", null, null, null, "levromart"), party("To", d.bank_name || "Bank", null, d.account_last4 ? "···" + d.account_last4 : "", null, "bank"), K(d.withdrawal_amount_kobo || Math.abs(k)));
      out += '<div class="ltx-card">' + row("Account name", d.account_name ? E(d.account_name) : "") + row("Status", status(d.withdrawal_status)) + row("Asked by", d.requested_by_name ? E(d.requested_by_name) : "") + row("Problem", d.last_error ? E(d.last_error) : "") + row("Bank reference", d.transfer_reference ? '<code>' + E(d.transfer_reference) + "</code>" : "") + "</div>";
    }
    out += '<div class="ltx-card ltx-refs">' + row("Date", E(when(d.created_at))) + (ref ? row("Reference", '<button type="button" class="ltx-copy" data-copy="' + E(ref) + '"><code>' + E(ref) + '</code> <i class="fa-regular fa-copy"></i></button>') : "") + row("Transaction ID", '<button type="button" class="ltx-copy" data-copy="' + E(d.id) + '"><code>' + E(String(d.id).slice(0, 8)) + '…</code> <i class="fa-regular fa-copy"></i></button>') + "</div>";
    return { title: title, html: out, plus: plus, k: k };
  }
  function open(id, icon) {
    var old = document.getElementById("ltxSheet"); if (old) old.remove();
    var m = document.createElement("div"); m.id = "ltxSheet"; m.className = "ltx-wrap";
    m.innerHTML = '<div class="ltx-sheet" role="dialog" aria-modal="true" aria-label="Transaction details"><div class="ltx-grab" aria-hidden="true"></div><button type="button" class="ltx-x" data-x aria-label="Close"><i class="fa-solid fa-xmark"></i></button><div class="ltx-in"><div class="ltx-load"><i class="fa-solid fa-spinner fa-spin"></i> Loading details…</div></div></div>';
    document.body.appendChild(m);
    requestAnimationFrame(function () { m.classList.add("on"); });
    var close = function () { m.classList.remove("on"); setTimeout(function () { m.remove(); }, 260); };
    m.addEventListener("click", function (ev) {
      if (ev.target === m || ev.target.closest("[data-x]")) return close();
      var c = ev.target.closest("[data-copy]");
      if (c) { try { navigator.clipboard.writeText(c.getAttribute("data-copy")); if (typeof showToast === "function") showToast("Copied.", "success"); } catch (_) {} return; }
      var o = ev.target.closest("[data-order]");
      if (o) { ev.preventDefault(); close(); try { navigate("orderDetail", { orderId: o.getAttribute("data-order") }); } catch (_) {} }
    });
    // drag the sheet down to close it
    var sh = m.querySelector(".ltx-sheet"), y0 = null, dy = 0;
    sh.addEventListener("touchstart", function (e) { if (sh.scrollTop > 0) return; y0 = e.touches[0].clientY; dy = 0; }, { passive: true });
    sh.addEventListener("touchmove", function (e) { if (y0 == null) return; dy = Math.max(0, e.touches[0].clientY - y0); sh.style.transform = "translateY(" + dy + "px)"; }, { passive: true });
    sh.addEventListener("touchend", function () { if (y0 == null) return; y0 = null; sh.style.transform = ""; if (dy > 90) close(); });
    Promise.resolve(sb.rpc("get_levromart_wallet_entry", { p_id: id })).then(function (r) {
      var box = m.querySelector(".ltx-in"); if (!box) return;
      if (!r || r.error || !r.data) { box.innerHTML = '<p class="ltx-load">Couldn\'t load the details. ' + E(r && r.error && r.error.message || "") + "</p>"; return; }
      var b = body(r.data);
      box.innerHTML = '<div class="ltx-head"><span class="ltx-ico">' + (window.lv3dIcon ? window.lv3dIcon(icon || "tx-all", 56) : "") + '</span><small>' + E(b.title) + '</small><b class="ltx-amt ' + (b.plus ? "in" : "out") + '">' + (b.plus ? "+" : "−") + K(Math.abs(b.k)) + '</b><span class="ltx-when">' + E(when(r.data.created_at)) + "</span></div>" + b.html;
    }, function () { var box = m.querySelector(".ltx-in"); if (box) box.innerHTML = '<p class="ltx-load">Couldn\'t load the details. Check your connection.</p>'; });
  }
  window.lvAdminTxOpen = open;
  document.addEventListener("click", function (ev) {
    var r = ev.target.closest && ev.target.closest(".lwa-row[data-eid]"); if (!r) return;
    open(r.getAttribute("data-eid"), r.getAttribute("data-e3d"));
  });
  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    var r = ev.target.closest && ev.target.closest(".lwa-row[data-eid]"); if (!r) return;
    ev.preventDefault(); open(r.getAttribute("data-eid"), r.getAttribute("data-e3d"));
  });
})();

/* Payment result / transaction details page (full screen, bank-app style) */
(function () {
  if (window.lvTxPage) return;
  function nair(k) { return "₦" + (Number(k || 0) / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function E(s) { return typeof esc === "function" ? esc(s) : String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function when(d) { try { return new Date(d || Date.now()).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }); } catch (_) { return ""; } }
  var KINDS = { topup: "Money added", transfer_in: "Received", transfer_out: "Transfer", order_payment: "Order payment", refund_in: "Refund", refund_out: "Refund to a buyer", earnings_in: "Shop earnings", withdrawal: "Withdrawal", withdrawal_return: "Returned to wallet", points_in: "Points converted" };
  function favs() { try { return JSON.parse(localStorage.getItem("lv-fav-people") || "[]"); } catch (_) { return []; } }
  function fromEntry(e) {
    var k = e.kind, amt = Math.abs(Number(e.amount_kobo || 0)), s = { kind: k, amountKobo: amt, when: e.created_at, ref: e.id, detail: true, status: "Successful", received: Number(e.amount_kobo) > 0 };
    s.title = KINDS[k] || "Wallet";
    if (k === "transfer_in" || k === "transfer_out") s.person = { name: e.counterparty_name, handle: e.counterparty_handle, avatar_url: e.counterparty_avatar };
    if (k === "withdrawal") { s.bank = { bank_name: e.bank_name, last4: e.account_last4 }; s.status = ({ requested: "Waiting for Levromart's check", processing: "On its way", success: "Successful", failed: "Not sent", reversed: "Returned", rejected: "Not approved" })[e.withdrawal_status] || "Successful"; }
    if (e.note) s.note = e.note;
    return s;
  }
  function rowsOf(s) {
    var r = [];
    if (s.person) { r.push([s.received ? "From" : "To", (s.person.name || "") + (s.person.handle ? " (@" + s.person.handle + ")" : "")]); }
    if (s.bank) r.push(["To bank", (s.bank.bank_name || "Your bank") + " ···" + (s.bank.last4 || s.bank.account_last4 || "") + (s.bank.account_name ? " · " + s.bank.account_name : "")]);
    if (s.via) r.push(["Paid with", s.via]);
    if (s.shop) r.push(["Shop", s.shop]);
    if (s.amountKobo) r.push(["Amount", nair(s.amountKobo)]);
    if (s.feeKobo) r.push(["Fee", nair(s.feeKobo)]);
    if (s.note) r.push([s.kind === "order_payment" ? "Order" : "Note", s.note]);
    r.push(["Status", s.status || "Successful"]);
    r.push(["Date", when(s.when)]);
    if (s.ref) r.push(["Reference", String(s.ref).slice(0, 36)]);
    return r;
  }
  function ic(name, fa) { return typeof window.lv3dIcon === "function" && window.LV3D && window.LV3D[name] ? window.lv3dIcon(name, 40) : '<i class="fa-solid ' + fa + '"></i>'; }
  function close() { var p = document.getElementById("lvTxPage"); if (p) { p.classList.add("out"); setTimeout(function () { p.remove(); }, 180); } document.body.classList.remove("lv-tx-open"); }
  // receipt looks (like a bank app's: pick one for a normal day, a celebration or something urgent)
  var RTHEMES = [
    { id: "classic", name: "Classic", a: "#0f9a69", b: "#06402e", ink: "#ffffff", tint: "#e8f7f0" },
    { id: "midnight", name: "Midnight", a: "#1e293b", b: "#0b1220", ink: "#ffffff", tint: "#e8edf5" },
    { id: "royal", name: "Royal", a: "#6d4aff", b: "#2a1a78", ink: "#ffffff", tint: "#eeeaff" },
    { id: "sunset", name: "Sunset", a: "#ff8a3d", b: "#c2410c", ink: "#ffffff", tint: "#fff0e6" },
    { id: "rose", name: "Rose", a: "#ec4899", b: "#9d174d", ink: "#ffffff", tint: "#fde8f2" },
    { id: "urgent", name: "Urgent", a: "#ef4444", b: "#991b1b", ink: "#ffffff", tint: "#fee9e9", tag: "URGENT" },
    { id: "festive", name: "Merry Christmas", a: "#15803d", m: "#14532d", b: "#b91c1c", ink: "#ffffff", tint: "#eaf6ec", tag: "MERRY CHRISTMAS", deco: "snow" }
  ];
  function theme(id) { for (var i = 0; i < RTHEMES.length; i++) if (RTHEMES[i].id === id) return RTHEMES[i]; return RTHEMES[0]; }
  function savedTheme() { try { return localStorage.getItem("lv-receipt-theme") || "classic"; } catch (_) { return "classic"; } }
  function rr(x, px, py, w, h, r) { x.beginPath(); x.moveTo(px + r, py); x.arcTo(px + w, py, px + w, py + h, r); x.arcTo(px + w, py + h, px, py + h, r); x.arcTo(px, py + h, px, py, r); x.arcTo(px, py, px + w, py, r); x.closePath(); }
  function fit(x, text, maxW) { var v = String(text == null ? "" : text); if (x.measureText(v).width <= maxW) return v; while (v.length > 3 && x.measureText(v + "…").width > maxW) v = v.slice(0, -1); return v + "…"; }
  async function receiptBlob(s, themeId) {
    var T = theme(themeId || savedTheme()), rows = rowsOf(s), W = 900, pad = 56, rowH = 84;
    var headH = 380, bodyTop = headH + 40, H = bodyTop + rows.length * rowH + 250;
    var c = document.createElement("canvas"); c.width = W; c.height = H; var x = c.getContext("2d");
    var F = "system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif";
    x.fillStyle = "#f4f6f8"; x.fillRect(0, 0, W, H);
    // header with the brand colours
    var g = x.createLinearGradient(0, 0, W, headH); g.addColorStop(0, T.a); if (T.m) g.addColorStop(.5, T.m); g.addColorStop(1, T.b);
    x.fillStyle = g; x.fillRect(0, 0, W, headH);
    x.fillStyle = "rgba(255,255,255,.08)"; x.beginPath(); x.arc(W - 90, 60, 190, 0, 7); x.fill(); x.beginPath(); x.arc(70, headH - 20, 130, 0, 7); x.fill();
    if (T.deco === "snow") { x.fillStyle = "rgba(255,255,255,.85)"; for (var i = 0; i < 46; i++) { var sx = (i * 197) % W, sy = (i * 83) % headH; if (sy < 150 && sx < 560) continue; x.beginPath(); x.arc(sx, sy, 2 + (i % 4), 0, 7); x.fill(); } }
    x.fillStyle = T.ink; x.textAlign = "left"; x.font = "800 40px " + F; x.fillText("Levromart", pad, 84);
    x.font = "600 24px " + F; x.globalAlpha = .85; x.fillText("Transaction receipt", pad, 122); x.globalAlpha = 1;
    if (T.tag) { x.font = "800 22px " + F; var tw = x.measureText(T.tag).width + 44; rr(x, W - pad - tw, 56, tw, 46, 23); x.fillStyle = "rgba(255,255,255,.22)"; x.fill(); x.fillStyle = T.ink; x.textAlign = "center"; x.fillText(T.tag, W - pad - tw / 2, 88); x.textAlign = "left"; }
    // the amount card
    var ok = !/not sent|not approved|returned/i.test(s.status || ""), inKind = s.kind === "topup" || s.received;
    rr(x, pad, 170, W - pad * 2, 250, 36); x.fillStyle = "#fff"; x.shadowColor = "rgba(15,23,42,.16)"; x.shadowBlur = 36; x.shadowOffsetY = 12; x.fill(); x.shadowColor = "transparent"; x.shadowBlur = 0; x.shadowOffsetY = 0;
    x.fillStyle = ok ? T.a : "#dc2626"; x.beginPath(); x.arc(W / 2, 170, 34, 0, 7); x.fill(); x.fillStyle = "#fff"; x.beginPath(); x.arc(W / 2, 170, 29, 0, 7); x.fill();
    x.fillStyle = ok ? T.a : "#dc2626"; x.beginPath(); x.arc(W / 2, 170, 24, 0, 7); x.fill();
    x.strokeStyle = "#fff"; x.lineWidth = 6; x.lineCap = "round"; x.lineJoin = "round"; x.beginPath();
    if (ok) { x.moveTo(W / 2 - 11, 171); x.lineTo(W / 2 - 3, 180); x.lineTo(W / 2 + 12, 161); } else { x.moveTo(W / 2 - 9, 161); x.lineTo(W / 2 + 9, 179); x.moveTo(W / 2 + 9, 161); x.lineTo(W / 2 - 9, 179); }
    x.stroke();
    x.textAlign = "center"; x.fillStyle = "#6b7280"; x.font = "600 26px " + F; x.fillText(s.title || "Successful", W / 2, 250);
    x.fillStyle = "#0f172a"; x.font = "800 70px " + F; x.fillText((inKind ? "+" : "") + nair(s.amountKobo), W / 2, 330);
    var pill = String(s.status || "Successful"); x.font = "700 22px " + F; var pw = x.measureText(pill).width + 44; rr(x, W / 2 - pw / 2, 352, pw, 44, 22);
    x.fillStyle = ok ? T.tint : "#fee2e2"; x.fill(); x.fillStyle = ok ? T.b : "#b91c1c"; x.fillText(pill, W / 2, 382);
    // the details
    x.textAlign = "left"; var by = 470;
    rr(x, pad, by, W - pad * 2, rows.length * rowH + 30, 32); x.fillStyle = "#fff"; x.fill();
    rows.forEach(function (r, k) {
      var y = by + 20 + k * rowH + 54;
      x.font = "500 26px " + F; x.fillStyle = "#6b7280"; x.textAlign = "left"; x.fillText(r[0], pad + 36, y);
      x.font = "700 27px " + F; x.fillStyle = "#0f172a"; x.textAlign = "right"; x.fillText(fit(x, r[1], 460), W - pad - 36, y);
      if (k < rows.length - 1) { x.strokeStyle = "#eef0f3"; x.lineWidth = 2; x.beginPath(); x.moveTo(pad + 36, y + 24); x.lineTo(W - pad - 36, y + 24); x.stroke(); }
    });
    var fy = by + rows.length * rowH + 30 + 70;
    x.textAlign = "center"; x.fillStyle = "#94a3b8"; x.font = "600 22px " + F; x.fillText("Thank you for using Levromart", W / 2, fy);
    x.font = "500 20px " + F; x.fillText("levromart.com", W / 2, fy + 34);
    return new Promise(function (res) { c.toBlob(res, "image/jpeg", .93); });
  }
  // the receipt screen: a preview, the look to choose, then Share (WhatsApp and anywhere), Send in a chat, or Save
  async function shareReceipt(s) {
    var d = document.createElement("div"); d.className = "lv-rc"; var cur = savedTheme(), url = "", blob = null, busy = false;
    d.innerHTML = '<div class="lv-rc-in" role="dialog" aria-modal="true" aria-label="Share receipt"><span class="lv-rc-grab"></span><div class="lv-rc-h"><b>Share receipt</b><button type="button" data-x aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>' +
      '<div class="lv-rc-prev"><img alt="Receipt preview"><i class="lv-rc-spin fa-solid fa-circle-notch"></i></div>' +
      '<div class="lv-rc-looks" role="radiogroup" aria-label="Receipt look">' + RTHEMES.map(function (t) { return '<button type="button" role="radio" data-t="' + t.id + '" aria-checked="' + (t.id === cur) + '" class="' + (t.id === cur ? "on" : "") + '"><i style="background:linear-gradient(135deg,' + t.a + ',' + t.b + ')"></i><span>' + E(t.name) + '</span></button>'; }).join("") + '</div>' +
      '<div class="lv-rc-acts"><button type="button" class="pri" data-a="share"><i class="fa-solid fa-share-nodes"></i> Share</button><button type="button" data-a="chat"><i class="fa-regular fa-comment-dots"></i> Send in chat</button><button type="button" data-a="save"><i class="fa-solid fa-download"></i> Save</button></div></div>';
    document.body.appendChild(d);
    var img = d.querySelector(".lv-rc-prev img"), spin = d.querySelector(".lv-rc-spin");
    async function draw() {
      spin.hidden = false; img.style.opacity = ".35";
      var b = await receiptBlob(s, cur); if (!d.isConnected) return;
      blob = b; if (url) URL.revokeObjectURL(url); url = URL.createObjectURL(b); img.src = url; img.onload = function () { spin.hidden = true; img.style.opacity = ""; };
    }
    function done() { if (url) URL.revokeObjectURL(url); d.remove(); }
    draw();
    d.onclick = async function (ev) {
      if (ev.target === d || ev.target.closest("[data-x]")) return done();
      var t = ev.target.closest("[data-t]");
      if (t) { cur = t.dataset.t; try { localStorage.setItem("lv-receipt-theme", cur); } catch (_) {} d.querySelectorAll("[data-t]").forEach(function (x) { var on = x === t; x.classList.toggle("on", on); x.setAttribute("aria-checked", on); }); return draw(); }
      var b = ev.target.closest("[data-a]"); if (!b || busy) return; var a = b.dataset.a; if (!blob) return;
      var name = "levromart-receipt.jpg", file = null; try { file = new File([blob], name, { type: "image/jpeg" }); } catch (_) {}
      if (a === "share") {
        try {
          if (file && navigator.canShare && navigator.canShare({ files: [file] })) { busy = true; await navigator.share({ files: [file], title: "Levromart receipt", text: (s.title || "Receipt") + " " + nair(s.amountKobo) }); busy = false; showToast("Receipt shared.", "success"); return done(); }
        } catch (e) { busy = false; if (e && e.name === "AbortError") return; }
        var a2 = document.createElement("a"); a2.href = url; a2.download = name; document.body.appendChild(a2); a2.click(); a2.remove(); showToast("Receipt saved. Open WhatsApp or any app and attach it.", "info");
      } else if (a === "save") {
        var a3 = document.createElement("a"); a3.href = url; a3.download = name; document.body.appendChild(a3); a3.click(); a3.remove(); showToast("Receipt saved to your phone.", "success");
      } else if (a === "chat") { var keep = cur; done(); sendReceiptInChat(s, keep); }
    };
  }
  async function sendReceiptInChat(s, themeId) {
    var d = document.createElement("div"); d.className = "lv-tx-pick"; d.innerHTML = '<div class="lv-tx-pick-in"><div class="lv-tx-pick-h"><b>Send receipt to</b><button type="button" data-x aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div><input type="search" placeholder="Search chats" class="lv-tx-pick-s"><div class="lv-tx-pick-l"><p class="muted" style="padding:1rem;text-align:center">Loading chats…</p></div></div>';
    document.body.appendChild(d);
    var list = [];
    try { var r = await sb.rpc("list_my_conversations"); list = (r && r.data) || []; } catch (_) {}
    var host = d.querySelector(".lv-tx-pick-l");
    function paint(q) {
      var rows = list.filter(function (c) { return !q || String(c.other_name || "").toLowerCase().indexOf(q) > -1; });
      host.innerHTML = rows.length ? rows.map(function (c) { var av = c.other_avatar || c.other_logo || c.other_avatar_url; return '<button type="button" class="lv-tx-pick-r" data-id="' + E(c.conversation_id) + '"><span>' + (av ? '<img src="' + E(av) + '" alt="">' : E(String(c.other_name || "?").slice(0, 1).toUpperCase())) + '</span><b>' + E(c.other_name || "Chat") + '</b></button>'; }).join("") : '<p class="muted" style="padding:1rem;text-align:center">' + (list.length ? "No chat found." : "You have no chats yet. Receipts can only be shared inside Levromart chats.") + '</p>';
    }
    paint("");
    d.querySelector(".lv-tx-pick-s").oninput = function () { paint(this.value.trim().toLowerCase()); };
    d.onclick = async function (ev) {
      if (ev.target === d || ev.target.closest("[data-x]")) return d.remove();
      var b = ev.target.closest(".lv-tx-pick-r"); if (!b) return;
      b.disabled = true; b.querySelector("b").textContent = "Sending…";
      try {
        var blob = await receiptBlob(s, themeId);
        await sendPreparedChatImage(b.dataset.id, { blob: blob, caption: "", name: "levromart-receipt.jpg", type: "image/jpeg" }, null, null);
        d.remove(); showToast("Receipt sent in the chat.", "success");
      } catch (e) { b.disabled = false; showToast((e && e.message) || "Could not send the receipt.", "error"); d.remove(); }
    };
  }
  window.__lvReceiptTest = async function (entry, t) { var b = await receiptBlob(fromEntry(entry), t); return await new Promise(function (ok) { var fr = new FileReader(); fr.onload = function () { ok(fr.result); }; fr.readAsDataURL(b); }); };
  window.lvTxPage = async function (spec) {
    var s = spec.entry ? fromEntry(spec.entry) : Object.assign({ status: "Successful", when: Date.now() }, spec);
    if (spec.detail) s.detail = true;
    if (s.kind === "order" && s.orderId) {
      try {
        var q = await sb.from("orders").select("total_amount,delivery_fee,vendor:vendors(business_name)").eq("id", s.orderId).maybeSingle();
        var o = q && q.data; if (o) { if (!s.amountKobo) s.amountKobo = Math.round(Number(o.total_amount || 0) * 100); if (o.vendor && o.vendor.business_name) s.shop = o.vendor.business_name; }
      } catch (_) {}
      s.note = s.note || "Order #" + String(s.orderId).slice(0, 8).toUpperCase();
    }
    close();
    // the flat Levromart brand mark (the app icon's arcs and dot, white on brand green): no ring, shadow or depth
    var LV_FLAT_LOGO = '<svg viewBox="0 0 64 64" width="60" height="60" role="img" aria-label="Levromart"><defs><linearGradient id="lvTxLogoG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2bbb7d"/><stop offset="1" stop-color="#0e7a4e"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#lvTxLogoG)"/><g fill="none" stroke="#fff" stroke-width="5.2" stroke-linecap="round"><path d="M25.5 44.3A13.9 13.9 0 0 1 25.5 19.7"/><path d="M38.5 19.7A13.9 13.9 0 0 1 38.5 44.3"/></g><circle cx="32" cy="32" r="5.8" fill="#fff"/></svg>';
    var done = !s.detail, ok = !/not sent|not approved|returned/i.test(s.status || "");
    var p = document.createElement("div"); p.id = "lvTxPage"; p.className = "lv-tx";
    var inKind = s.kind === "topup" || s.received;
    var who = s.person ? (s.person.name || "@" + s.person.handle) : s.bank ? (s.bank.bank_name || "your bank") : s.shop || "";
    var isFav = s.person && s.person.handle && favs().some(function (f) { return f.handle === s.person.handle; });
    p.innerHTML = '<div class="lv-tx-top"><button type="button" class="lv-tx-x" data-x aria-label="Close"><i class="fa-solid fa-' + (done ? "xmark" : "arrow-left") + '"></i></button><span>' + E(done ? "" : "Transaction details") + '</span></div>' +
      '<div class="lv-tx-hero' + (done ? "" : " lv-tx-hero-d") + '">' + (done ? '<div class="lv-tx-check' + (ok ? "" : " bad") + '"><svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24" fill="currentColor"/><path d="M15 27l8 8 15-17" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" pathLength="40"/></svg></div>' : '<div class="lv-tx-logo">' + LV_FLAT_LOGO + "</div><small class=\"lv-tx-brand\">Levromart Wallet</small>") +
      '<h2>' + E(done ? s.title : (s.title || "Transaction")) + '</h2><div class="lv-tx-amt">' + (done ? "" : inKind ? "+" : "−") + nair(s.amountKobo) + '</div>' + (who ? '<p class="lv-tx-sub">' + E((inKind && s.person ? "from " : s.kind === "topup" ? "" : "to ") + (s.kind === "topup" ? "your wallet" : who)) + '</p>' : "") + '<span class="lv-tx-pill' + (ok ? "" : " bad") + '">' + E(s.status || "Successful") + '</span></div>' +
      '<div class="lv-tx-card" id="lvTxRows">' + rowsOf(s).map(function (r) { return '<div><span>' + E(r[0]) + '</span><b>' + E(r[1]) + '</b></div>'; }).join("") + '</div>' +
      '<div class="lv-tx-acts"><button type="button" data-a="share">' + ic("moved-up", "fa-share-nodes") + '<span>Share receipt</span></button>' +
      (s.person && s.person.handle && !s.received ? '<button type="button" data-a="fav"' + (isFav ? ' class="on"' : "") + '>' + ic("points", "fa-heart") + '<span>' + (isFav ? "In favourites" : "Add to favourites") + '</span></button>' : "") +
      '<button type="button" data-a="add">' + ic("cash", "fa-plus") + '<span>Add money</span></button>' +
      (s.orderId ? '<button type="button" data-a="order">' + ic("order-confirmed", "fa-bag-shopping") + '<span>View order</span></button>' : "") + '</div>' +
      (done ? '<button type="button" class="btn lv-tx-done" data-x>Done</button>' : "");
    document.body.appendChild(p); document.body.classList.add("lv-tx-open");
    p.onclick = function (ev) {
      if (ev.target.closest("[data-x]")) return close();
      var b = ev.target.closest("[data-a]"); if (!b) return;
      var a = b.dataset.a;
      if (a === "share") shareReceipt(s);
      else if (a === "add") { close(); try { window.lvW3Add(); } catch (_) {} }
      else if (a === "order") { close(); try { navigate("orderDetail", { orderId: s.orderId }); } catch (_) {} }
      else if (a === "fav") {
        var f = favs(), i = f.findIndex(function (x) { return x.handle === s.person.handle; });
        if (i > -1) f.splice(i, 1); else f.unshift({ handle: s.person.handle, name: s.person.name || "", avatar_url: s.person.avatar_url || "" });
        try { localStorage.setItem("lv-fav-people", JSON.stringify(f.slice(0, 30))); } catch (_) {}
        var on = i < 0; b.classList.toggle("on", on); b.innerHTML = ic("points", "fa-heart") + '<span>' + (on ? "In favourites" : "Add to favourites") + '</span>';
        showToast(on ? "Added to your favourites." : "Removed from favourites.", "success");
      }
    };
  };
  window.lvFavPeople = favs;
  window.lvIsFav = function (handle) { return favs().some(function (x) { return x.handle === handle; }); };
  // add / remove a person from favourites; returns true when they are now a favourite
  window.lvFavToggle = function (person) {
    if (!person || !person.handle) return false;
    var f = favs(), i = f.findIndex(function (x) { return x.handle === person.handle; });
    if (i > -1) f.splice(i, 1); else f.unshift({ handle: person.handle, name: person.name || "", avatar_url: person.avatar_url || "" });
    try { localStorage.setItem("lv-fav-people", JSON.stringify(f.slice(0, 30))); } catch (_) {}
    return i < 0;
  };
})();

/* After an order is placed: go straight to the orders list (a shop to "My purchases") with the new order at the top, never from an older copy. */
window.lvGoToNewOrder = function (orderId) {
  try { __ordersTabCache.clear(); } catch (_) {}
  try { window.__ordCnt = null; window.__orderStatsOrders = null; } catch (_) {}
  try { showToast("Order placed. You will see it change here as the shop answers.", "success"); } catch (_) {}
  try { if (typeof refreshNotifications === "function") refreshNotifications(); } catch (_) {}
  try {
    if (typeof vendor !== "undefined" && vendor) return navigate("vendorOrders", { status: "all", perspective: "purchases" });
    return navigate("buyerOrders");
  } catch (_) { try { return navigate("orderDetail", { orderId: orderId }); } catch (e) {} }
};

/* ===== Repeat protection (orders and money): a second tap while the first is still working, or the same action again
   a moment after it worked, asks "Repeat ... detected" instead of sending it again and flooding the shop. ===== */
(function () {
  "use strict";
  var RECENT = {}, TTL = 3 * 60 * 1000;
  window.lvRepeatMark = function (key) { RECENT[key] = Date.now(); };
  window.lvRepeatCheck = async function (key, o) {
    var t = RECENT[key];
    if (!(t && Date.now() - t < TTL)) return true;
    try { return await showConfirmDialog(o.text, { title: o.title, okLabel: o.okLabel, cancelLabel: o.cancelLabel || "No, cancel", three: "order-reminder" }); } catch (_) { return false; }
  };
  var running = {}, asking = false, okAt = 0;
  var prevGo = window.lvGoToNewOrder;
  window.lvGoToNewOrder = function () { okAt = Date.now(); return prevGo.apply(this, arguments); };   // an order really went through
  function guard(name) {
    var f = window[name]; if (typeof f !== "function" || f.__lvOnce) return;
    var w = async function () {
      var args = [].slice.call(arguments), key = "order:" + name + ":" + JSON.stringify(args) + ":" + (function () { try { return JSON.stringify(currentViewParams || {}); } catch (_) { return ""; } })();
      var recent = RECENT[key] && Date.now() - RECENT[key] < TTL;
      if (running[key] || recent) {
        if (asking) return;   // already asking: more taps do nothing
        asking = true;
        var ok = false;
        try { ok = await showConfirmDialog("This looks like the order you just placed. Placing it again will send the shop another order.", { title: "Repeat order detected", okLabel: "Place another order", cancelLabel: "No, don't repeat", three: "order-reminder" }); } catch (_) {}
        asking = false;
        if (!ok) return;
      }
      var started = Date.now(); running[key] = (running[key] || 0) + 1;
      try { return await f.apply(this, args); }
      finally { running[key]--; if (!running[key]) delete running[key]; if (okAt >= started) RECENT[key] = Date.now(); }
    };
    w.__lvOnce = true; window[name] = w;
  }
  ["checkoutCartAll", "checkoutCartVendor", "buyNow", "confirmRental", "buyPackageFromDetail", "buyPackage"].forEach(guard);
  setTimeout(function () { ["checkoutCartAll", "checkoutCartVendor", "buyNow", "confirmRental", "buyPackageFromDetail", "buyPackage"].forEach(guard); }, 1500);
})();

/* ===== Payments carousel (Transfer and Withdraw pages): a few bright banners that slide by themselves ===== */
(function () {
  "use strict";
  var SLIDES = {
    send: [
      ["First 3 order payments free", "Pay for orders with your wallet: your first three are on us.", "cash", "#0f9a69,#06402e"],
      ["Instant, to any @tag", "Money arrives in their wallet the moment you send it.", "tx-paid", "#5b3fe0,#2a1a78"],
      ["Protected by your PIN", "Nothing leaves your wallet without your 6-digit PIN.", "withdrawal-approved", "#2f6bff,#1a3fa8"],
      ["Save your favourites", "Tap the heart on a receipt to send again in one tap.", "points", "#f59e0b,#b45309"]
    ],
    history: [
      ["Share any receipt", "Open a transaction and tap Share receipt to send it on WhatsApp or anywhere.", "moved-up", "#0f9a69,#06402e"],
      ["See where your money goes", "Tap Analysis for a clear picture of your month.", "stat-views", "#5b3fe0,#2a1a78"],
      ["Your wallet is protected", "Every payment, transfer and withdrawal needs your 6-digit PIN.", "withdrawal-approved", "#2f6bff,#1a3fa8"]
    ],
    withdraw: [
      ["To any Nigerian bank", "Send your money to your own account, any time.", "payout-sent", "#0f9a69,#06402e"],
      ["Usually in minutes", "Most withdrawals arrive within minutes.", "tx-onway", "#2f6bff,#1a3fa8"],
      ["Protected by your PIN", "Every withdrawal needs your 6-digit PIN.", "withdrawal-approved", "#5b3fe0,#2a1a78"]
    ]
  };
  window.lvPayCarousel = function (kind) {
    var list = SLIDES[kind] || SLIDES.send, id = "lvpc" + Math.random().toString(36).slice(2, 7);
    var ic = function (n) { return window.lv3dIcon && window.LV3D && window.LV3D[n] ? window.lv3dIcon(n, 64) : ""; };
    setTimeout(function () {
      var el = document.getElementById(id); if (!el) return;
      var track = el.querySelector(".lvpc-track"), dots = el.querySelectorAll(".lvpc-dots i"), i = 0;
      var go = function (n) { i = (n + list.length) % list.length; track.style.transform = "translateX(" + (-100 * i) + "%)"; dots.forEach(function (d, k) { d.classList.toggle("on", k === i); }); };
      var t = setInterval(function () { if (!document.body.contains(el)) return clearInterval(t); go(i + 1); }, 3800);
      var sx = 0; el.addEventListener("touchstart", function (e) { sx = e.touches[0].clientX; }, { passive: true });
      el.addEventListener("touchend", function (e) { var dx = e.changedTouches[0].clientX - sx; if (Math.abs(dx) > 40) go(i + (dx < 0 ? 1 : -1)); }, { passive: true });
    }, 50);
    return '<div class="lvpc" id="' + id + '"><div class="lvpc-track">' + list.map(function (s) {
      return '<div class="lvpc-slide" style="background:linear-gradient(135deg,' + s[3] + ')"><div class="lvpc-txt"><b>' + esc(s[0]) + '</b><span>' + esc(s[1]) + '</span></div><div class="lvpc-ic">' + ic(s[2]) + '</div></div>';
    }).join("") + '</div><div class="lvpc-dots">' + list.map(function (_, k) { return '<i class="' + (k ? "" : "on") + '"></i>'; }).join("") + '</div></div>';
  };
})();

/* ===== Wallet analysis (from Transaction history → Analysis): Expenses / Income by month, a daily chart, where the money
   went, and Levi's read of it. While this page is open Levi's button shows a chart icon. ===== */
(function () {
  "use strict";
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var CAT = { topup: "Money added", transfer_in: "Received", transfer_out: "Transfers", order_payment: "Order payments", refund_in: "Refunds", refund_out: "Refunds to buyers", earnings_in: "Shop earnings", withdrawal: "Withdrawals", withdrawal_return: "Returned" };
  var COLORS = ["#10a36d", "#7c4dff", "#2f6bff", "#f59e0b", "#ef4444", "#14b8a6", "#ec4899"];
  function N(k) { return "₦" + (Number(k || 0) / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function E(v) { return typeof esc === "function" ? esc(v) : String(v); }
  // Levi's Analysis mode for the month on screen: what he is told (figures, categories, the month's transactions) and the
  // questions offered. `state()` gives the page's current transactions and month, so moving to another month moves Levi too.
  function analysisMode(state) {
    function monthRows(all, y, m) { return all.filter(function (e) { var d = new Date(e.created_at); return d.getFullYear() === y && d.getMonth() === m; }); }
    function split(rows) {
      var o = { out: 0, outN: 0, inn: 0, inN: 0, outCat: {}, inCat: {} };
      rows.forEach(function (e) { var a = Number(e.amount_kobo), c = CAT[e.kind] || "Other"; if (a < 0) { o.out -= a; o.outN++; o.outCat[c] = (o.outCat[c] || 0) - a; } else if (a > 0) { o.inn += a; o.inN++; o.inCat[c] = (o.inCat[c] || 0) + a; } });
      return o;
    }
    function cats(obj) { return Object.keys(obj).sort(function (a, b) { return obj[b] - obj[a]; }).map(function (k) { return k + " " + N(obj[k]); }).join(", ") || "none"; }
    return {
      id: "analysis",
      placeholder: "Ask about your money this month…",
      sticky: true,   // stays on while the analysis page is open, even if the chat is closed and opened again
      icon: "fa-chart-pie",
      label: function () { var st = state(); return "Analysis mode · " + MONTHS[st.month.m] + " " + st.month.y; },
      intro: function () {
        var st = state(), cur = split(monthRows(st.all, st.month.y, st.month.m)), when = MONTHS[st.month.m] + " " + st.month.y;
        if (!cur.outN && !cur.inN) return "I'm in **Analysis mode** for **" + when + "**. There are no wallet transactions that month yet. Ask me anything about your money, or pick another month on the page.";
        return "I'm in **Analysis mode** for **" + when + "**: **" + N(cur.out) + "** went out in " + cur.outN + " transaction" + (cur.outN === 1 ? "" : "s") + " and **" + N(cur.inn) + "** came in. What would you like to know?";
      },
      chips: [["Where did my money go?", "Where did most of my money go this month?"], ["Compare with last month", "How does this month compare with last month?"], ["Help me spend less", "How can I spend less next month?"], ["Summarise my income", "Summarise the money that came in this month."]],
      context: function () {
        var st = state(), y = st.month.y, m = st.month.m, rows = monthRows(st.all, y, m), cur = split(rows);
        var py = m ? y : y - 1, pm = (m + 11) % 12, prev = split(monthRows(st.all, py, pm));
        var byDay = {}; rows.forEach(function (e) { var a = Number(e.amount_kobo); if (a < 0) { var d = new Date(e.created_at).getDate(); byDay[d] = (byDay[d] || 0) - a; } });
        var busiest = Object.keys(byDay).sort(function (a, b) { return byDay[b] - byDay[a]; })[0];
        var lines = rows.slice(0, 40).map(function (e) {
          var d = new Date(e.created_at), a = Number(e.amount_kobo), who = e.counterparty_name || (e.counterparty_handle ? "@" + e.counterparty_handle : "") || e.bank_name || "";
          return "- " + d.getDate() + " " + MONTHS[m].slice(0, 3) + ": " + (CAT[e.kind] || e.kind) + " " + (a < 0 ? "-" : "+") + N(Math.abs(a)) + (who ? " (" + who + ")" : "") + (e.note ? " note: " + String(e.note).slice(0, 60) : "");
        });
        return ["The user opened Levi from the Analysis page of their Levromart wallet (Analysis mode). Answer about their wallet money for " + MONTHS[m] + " " + y + " using these figures from the app. Amounts are in naira. Be specific and practical, and do not invent transactions.",
          "Money out: " + N(cur.out) + " in " + cur.outN + " transactions. By category: " + cats(cur.outCat) + ".",
          "Money in: " + N(cur.inn) + " in " + cur.inN + " transactions. By category: " + cats(cur.inCat) + ".",
          busiest ? "Busiest spending day: " + busiest + " " + MONTHS[m] + " (" + N(byDay[busiest]) + ")." : "",
          "Previous month (" + MONTHS[pm] + " " + py + "): out " + N(prev.out) + " in " + prev.outN + " transactions; in " + N(prev.inn) + " in " + prev.inN + " transactions.",
          lines.length ? "This month's transactions (newest first" + (rows.length > 40 ? ", first 40 of " + rows.length : "") + "):\n" + lines.join("\n") : "No transactions this month."].filter(Boolean).join("\n");
      },
      topic: function () { var st = state(); return "my wallet for " + MONTHS[st.month.m] + " " + st.month.y; }
    };
  }
  window.lvWalletAnalysis = function (all, start) {
    var now = new Date(), month = { y: (start && start.y) || now.getFullYear(), m: start ? start.m : now.getMonth() }, tab = "out";
    var old = document.getElementById("lvAnPage"); if (old) old.remove();
    var pg = document.createElement("div"); pg.id = "lvAnPage"; pg.className = "lv-mvp lv-an";
    pg.innerHTML = '<div class="lv-mvp-top"><button type="button" class="lv-tx-x" data-back aria-label="Back"><i class="fa-solid fa-arrow-left"></i></button><b>Statistical analysis</b><span></span></div>' +
      '<div class="lv-an-tabs"><button type="button" data-t="out" class="on">Expenses</button><button type="button" data-t="in">Income</button></div><div id="lvAnBody"></div>';
    document.body.appendChild(pg); document.body.classList.add("lv-analysis-open");
    var fab = document.getElementById("aiChatFab"), chartIc = null;
    if (fab) { chartIc = document.createElement("img"); chartIc.className = "lv-fab-chart"; chartIc.src = "/icons3d/lv/chart.webp"; chartIc.alt = ""; fab.appendChild(chartIc); }
    // while this page is open, Levi works in Analysis mode: tapping his (chart) button, or "Ask Levi about my money", opens the
    // usual Levi chat on top of this page, with this month's figures handed to him
    var levi = analysisMode(function () { return { all: all, month: month }; });
    if (window.lvSetLeviMode) window.lvSetLeviMode(levi);
    var close = function () {
      pg.remove(); document.body.classList.remove("lv-analysis-open"); if (chartIc) chartIc.remove();
      if (window.lvLeviMode && window.lvLeviMode() === levi) window.lvSetLeviMode(null);
    };
    pg.addEventListener("click", function (ev) {
      if (ev.target.closest("[data-back]")) return close();
      var t = ev.target.closest("[data-t]"); if (t) { tab = t.dataset.t; pg.querySelectorAll("[data-t]").forEach(function (x) { x.classList.toggle("on", x === t); }); return paint(); }
      var mv = ev.target.closest("[data-mv]"); if (mv) { var d = Number(mv.dataset.mv); month = { y: month.y + (month.m + d < 0 ? -1 : month.m + d > 11 ? 1 : 0), m: (month.m + d + 12) % 12 }; return paint(); }
      if (ev.target.closest("[data-ask]") && window.lvAskLevi) window.lvAskLevi(levi);
    });
    function paint() {
      var rows = all.filter(function (e) { var d = new Date(e.created_at); return d.getFullYear() === month.y && d.getMonth() === month.m && (tab === "out" ? Number(e.amount_kobo) < 0 : Number(e.amount_kobo) > 0); });
      var total = rows.reduce(function (a, e) { return a + Math.abs(Number(e.amount_kobo)); }, 0);
      var days = new Date(month.y, month.m + 1, 0).getDate(), byDay = new Array(days).fill(0);
      rows.forEach(function (e) { byDay[new Date(e.created_at).getDate() - 1] += Math.abs(Number(e.amount_kobo)); });
      var max = Math.max.apply(null, byDay.concat([1]));
      var W = 340, H = 150, bw = W / days;
      var bars = byDay.map(function (v, i) { var h = Math.round((v / max) * (H - 20)); return '<rect x="' + (i * bw + 1).toFixed(1) + '" y="' + (H - h) + '" width="' + Math.max(2, bw - 2).toFixed(1) + '" height="' + Math.max(v ? 3 : 0, h) + '" rx="2" fill="' + (tab === "out" ? "#ef6b5b" : "#10a36d") + '"/>'; }).join("");
      var cats = {}; rows.forEach(function (e) { var c = CAT[e.kind] || "Other"; cats[c] = (cats[c] || 0) + Math.abs(Number(e.amount_kobo)); });
      var list = Object.keys(cats).map(function (k) { return [k, cats[k]]; }).sort(function (a, b) { return b[1] - a[1]; });
      var acc = 0, R = 52, C = 2 * Math.PI * R;
      var donut = list.map(function (c, i) { var frac = c[1] / (total || 1), seg = '<circle r="' + R + '" cx="70" cy="70" fill="none" stroke="' + COLORS[i % COLORS.length] + '" stroke-width="22" stroke-dasharray="' + (frac * C).toFixed(2) + ' ' + C.toFixed(2) + '" stroke-dashoffset="' + (-acc * C).toFixed(2) + '" transform="rotate(-90 70 70)"/>'; acc += frac; return seg; }).join("");
      var busiest = byDay.indexOf(max), prevRows = all.filter(function (e) { var d = new Date(e.created_at), pm = (month.m + 11) % 12, py = month.m ? month.y : month.y - 1; return d.getFullYear() === py && d.getMonth() === pm && (tab === "out" ? Number(e.amount_kobo) < 0 : Number(e.amount_kobo) > 0); });
      var prevTotal = prevRows.reduce(function (a, e) { return a + Math.abs(Number(e.amount_kobo)); }, 0);
      var change = prevTotal ? Math.round(((total - prevTotal) / prevTotal) * 100) : null;
      var tips = [];
      if (rows.length) {
        tips.push((tab === "out" ? "You spent " : "You received ") + "<b>" + N(total) + "</b> in " + rows.length + " transaction" + (rows.length === 1 ? "" : "s") + ".");
        if (list[0]) tips.push("Most of it was <b>" + E(list[0][0]) + "</b> (" + Math.round((list[0][1] / total) * 100) + "%).");
        if (max > 0) tips.push("Your busiest day was <b>" + (busiest + 1) + " " + MONTHS[month.m].slice(0, 3) + "</b> (" + N(max) + ").");
        if (change !== null) tips.push("That is <b>" + (change >= 0 ? change + "% more" : Math.abs(change) + "% less") + "</b> than last month.");
        if (tab === "out") tips.push("Tip: your first 3 order payments with the wallet are free. Paying with the wallet saves card charges.");
      } else tips.push("No " + (tab === "out" ? "spending" : "income") + " this month yet.");
      pg.querySelector("#lvAnBody").innerHTML =
        '<div class="lv-an-month"><button type="button" data-mv="-1" aria-label="Previous month"><i class="fa-solid fa-chevron-left"></i></button><b>' + MONTHS[month.m].slice(0, 3) + "." + month.y + '</b><button type="button" data-mv="1" aria-label="Next month"' + (month.y === now.getFullYear() && month.m === now.getMonth() ? " disabled" : "") + '><i class="fa-solid fa-chevron-right"></i></button></div>' +
        '<div class="lv-an-total"><small>Total ' + rows.length + ' ' + (tab === "out" ? "expenses" : "income") + '</small><b>' + N(total) + '</b></div>' +
        '<div class="lv-an-card"><div class="lv-an-h">Daily ' + (tab === "out" ? "expenses" : "income") + '</div><svg viewBox="0 0 ' + W + ' ' + (H + 18) + '" class="lv-an-bars"><line x1="0" y1="' + H + '" x2="' + W + '" y2="' + H + '" stroke="rgba(127,127,127,.3)"/>' + bars + '<text x="0" y="' + (H + 15) + '" font-size="10" fill="#8a85a8">1</text><text x="' + (W / 2 - 6) + '" y="' + (H + 15) + '" font-size="10" fill="#8a85a8">' + Math.ceil(days / 2) + '</text><text x="' + (W - 14) + '" y="' + (H + 15) + '" font-size="10" fill="#8a85a8">' + days + '</text></svg></div>' +
        '<div class="lv-an-card"><div class="lv-an-h">Where it ' + (tab === "out" ? "went" : "came from") + '</div>' + (list.length ? '<div class="lv-an-donut"><svg viewBox="0 0 140 140" width="140" height="140">' + donut + '</svg><ul>' + list.map(function (c, i) { return '<li><i style="background:' + COLORS[i % COLORS.length] + '"></i><span>' + E(c[0]) + '</span><b>' + N(c[1]) + '</b></li>'; }).join("") + '</ul></div>' : '<p class="muted">Nothing to show.</p>') + '</div>' +
        '<div class="lv-an-card lv-an-levi"><div class="lv-an-levi-h">' + (window.lv3dIcon ? window.lv3dIcon("chart", 52) : "") + '<div><b>Levi\'s analysis</b><small>Your money this month, in plain words</small></div></div><ul>' + tips.map(function (t) { return "<li>" + t + "</li>"; }).join("") + '</ul><button type="button" class="btn lw-go" data-ask>Ask Levi about my money</button></div>';
      if (window.lvLeviModeRefresh) window.lvLeviModeRefresh();
    }
    paint();
  };
})();

/* ===== Levi with a subject: Analysis mode (the wallet's Analysis page) and "Ask Levi about my listing" =====
   This is the same Levi chat (same conversation, history, voice and AI): a mode only adds a bar under Levi's header saying what
   he is looking at, an opening line, suggested questions, and, with each question, the figures from the app he needs to answer
   it. The mode ends with Exit, when the chat closes (a listing), or when the analysis page closes (Analysis mode). */
(function () {
  "use strict";
  var mode = null, introduced = null;
  function val(v) { try { return typeof v === "function" ? v() : v; } catch (_) { return ""; } }
  function panel() { return document.getElementById("aiChatPanel"); }
  function isOpen() { var p = panel(); return !!p && !p.classList.contains("hidden"); }
  function E(v) { return typeof esc === "function" ? esc(v) : String(v); }

  window.lvLeviMode = function () { return mode; };
  window.lvSetLeviMode = function (m) { if (m !== mode) introduced = null; mode = m || null; paint(); refreshStrip(); placeholder(); if (mode && isOpen()) enter(); };
  window.lvLeviModeRefresh = function () { paint(); };
  // open Levi on a subject (from a button on the page)
  window.lvAskLevi = function (m) {
    if (typeof session !== "undefined" && !session) { if (typeof showLogin === "function") showLogin(); return; }
    if (m && m !== mode) { introduced = null; mode = m; }
    if (window.lvOpenLevi) window.lvOpenLevi(); else if (!isOpen() && typeof toggleAiChat === "function") toggleAiChat();
    setTimeout(enter, 0);
  };

  // the bar under Levi's header: what he is looking at, and Exit
  function paint() {
    var p = panel(); if (!p) return;
    var bar = document.getElementById("lvLeviModeBar");
    if (!mode) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement("div"); bar.id = "lvLeviModeBar"; bar.className = "lv-levi-mode"; bar.setAttribute("role", "status");
      var head = p.querySelector(".drawer-header");
      p.insertBefore(bar, head ? head.nextSibling : p.firstChild);
      bar.addEventListener("click", function (e) { if (e.target.closest("[data-exit]")) { e.stopPropagation(); window.lvSetLeviMode(null); } });
    }
    bar.innerHTML = '<i class="fa-solid ' + E(mode.icon || "fa-wand-magic-sparkles") + '" aria-hidden="true"></i><span>' + E(val(mode.label)) + '</span><button type="button" data-exit>Exit</button>';
  }
  // the suggested questions above the message box follow the mode (the strip is rebuilt when it is missing)
  function refreshStrip() { var s = document.getElementById("lvLeviSuggest"); if (s) s.remove(); }

  // Levi has just opened (or a mode was chosen while he is open): show the bar, then his opening line once per subject
  function placeholder() {
    var i = document.getElementById("aiChatInput"); if (!i) return;
    if (mode) i.placeholder = mode.placeholder || "Ask Levi about this…";
    else if (/^Ask (Levi )?about /.test(i.placeholder)) i.placeholder = "Ask Levi anything…";
  }
  function enter() {
    if (!mode || !isOpen()) return;
    paint(); refreshStrip(); placeholder();
    document.querySelectorAll("#aiChatMessages .lvw-vsug").forEach(function (x) { x.remove(); });   // the general vendor suggestions
    if (introduced === mode) return;
    var m = mode, tries = 0;
    introduced = m;
    // a saved conversation may still be loading: wait until the messages have settled so the opening line comes last
    (function wait(lastCount) {
      var box = document.getElementById("aiChatMessages"), n = box ? box.children.length : 0;
      if (mode !== m || !isOpen()) { if (introduced === m) introduced = null; return; }
      if ((n === 0 || n !== lastCount) && tries++ < 15) return setTimeout(function () { wait(n); }, 120);
      try {
        var text = val(m.intro);
        if (text && typeof appendAiChatMessage === "function") {
          appendAiChatMessage("assistant", text);
          if (typeof persistAiMessage === "function") persistAiMessage("assistant", text);
          if (typeof scrollAiChatToBottom === "function") scrollAiChatToBottom();
        }
      } catch (_) {}
    })(-1);
  }

  // what Levi is told with each question while a mode is on: the app's figures, just before the question, and a note on the
  // question saying what it is about (so a short question such as "is my price right?" is answered about this subject)
  function wrapFetch() {
    if (typeof fetchLeviReply !== "function" || fetchLeviReply.__lvMode) return;
    var orig = fetchLeviReply;
    var f = function (payload) {
      if (mode && payload && Array.isArray(payload.messages)) {
        try {
          var msgs = payload.messages.slice(), i = msgs.length - 1;
          while (i >= 0 && msgs[i].role !== "user") i--;
          var ctx = String(val(mode.context) || "").slice(0, 4500);
          if (i >= 0 && ctx) {
            var last = Object.assign({}, msgs[i], { content: String(msgs[i].content || "") + "\n\n(Levi: this question is about " + val(mode.topic) + ".)" });
            msgs.splice(i, 1, { role: "user", content: "APP CONTEXT FOR LEVI (added by the Levromart app, not typed by the user):\n" + ctx }, last);
            payload = Object.assign({}, payload, { messages: msgs });
          }
        } catch (_) {}
      }
      return orig.call(this, payload);
    };
    f.__lvMode = true;
    window.fetchLeviReply = f; try { fetchLeviReply = f; } catch (_) {}
  }
  // in a mode, questions go to Levi's AI with the subject, not to the quick built-in answers (which would, for example, start
  // the "add a listing" flow for "how can I sell this listing faster?")
  function wrapLocal() {
    if (typeof resolveLeviLocalAction !== "function" || resolveLeviLocalAction.__lvMode) return;
    var orig = resolveLeviLocalAction;
    var g = async function (text) { if (mode) return { handled: false }; return orig.apply(this, arguments); };
    g.__lvMode = true; g.__lvVendor = orig.__lvVendor;
    window.resolveLeviLocalAction = g; try { resolveLeviLocalAction = g; } catch (_) {}
  }
  // a new chat in a mode starts with the opening line again
  function wrapNewChat() {
    if (typeof startNewAiChat !== "function" || startNewAiChat.__lvMode) return;
    var orig = startNewAiChat;
    var h = function () { var r = orig.apply(this, arguments); if (mode) { introduced = null; setTimeout(enter, 0); } return r; };
    h.__lvMode = true;
    window.startNewAiChat = h; try { startNewAiChat = h; } catch (_) {}
  }
  function wire() { wrapFetch(); wrapLocal(); wrapNewChat(); }
  wire(); setTimeout(wire, 1500);

  // Levi opening or closing by any route (his button, a link, the close button)
  var was = null;
  function watch() {
    var p = panel(); if (!p) return setTimeout(watch, 500);
    new MutationObserver(function () {
      var open = isOpen(); if (open === was) return; was = open;
      if (open) { if (mode) enter(); }
      else if (mode && !mode.sticky) window.lvSetLeviMode(null);
    }).observe(p, { attributes: true, attributeFilter: ["class"] });
    was = isOpen();
  }
  watch();
})();

/* ===== Messages: a sticker button (replaces the microphone) sends the same stickers as comments; Levi's button inserts emoji ===== */
(function () {
  var RX = /^::s:((?:still\/|3d\/)?[0-9a-f-]+)::$/;
  function emoji(code) { try { return String.fromCodePoint.apply(null, code.split("-").map(function (h) { return parseInt(h, 16); })); } catch (_) { return ""; } }
  function panelFor(anchor, cls) {
    var row = anchor.parentNode, wrap = row.parentNode;
    var p = wrap.querySelector(":scope > ." + cls);
    if (!p) { p = document.createElement("div"); p.className = "lv-msgstk " + cls; p.hidden = true; wrap.insertBefore(p, row); }
    return p;
  }
  window.lvMsgStickers = function (btn) {
    var p = panelFor(btn, "lv-msgstk-m");
    if (!p.dataset.ready) {
      p.dataset.ready = "1";
      ["3d", "still", ""].forEach(function (set) {
        (window.lvStk ? window.lvStk.list : []).forEach(function (code) {
          var id = (set ? set + "/" : "") + code, b = document.createElement("button");
          b.type = "button"; b.setAttribute("aria-label", "Send sticker");
          b.innerHTML = '<img src="' + window.lvStk.src(id) + '" alt="" width="48" height="48" loading="lazy" decoding="async">';
          b.onclick = function () {
            var row = btn.parentNode, ta = row.querySelector("textarea"), send = row.querySelector(":scope > .btn");
            if (!ta || !send) return;
            p.hidden = true; ta.value = "::s:" + id + "::"; send.click();
          };
          if (set === "3d") b.className = "s3"; p.appendChild(b);
        });
      });
    }
    p.hidden = !p.hidden;
  };
  window.lvAiEmojis = function (btn) {
    var p = panelFor(btn, "lv-msgstk-ai");
    if (!p.dataset.ready) {
      p.dataset.ready = "1";
      (window.lvStk ? window.lvStk.list : []).forEach(function (code) {
        var b = document.createElement("button"); b.type = "button"; b.textContent = emoji(code);
        b.onclick = function () { var ta = btn.parentNode.querySelector("textarea"); if (!ta) return; ta.value += b.textContent; ta.dispatchEvent(new Event("input", { bubbles: true })); ta.focus(); };
        p.appendChild(b);
      });
    }
    p.hidden = !p.hidden;
  };
  function dress() {
    document.querySelectorAll(".chat-bubble-text:not([data-stk])").forEach(function (b) {
      b.dataset.stk = "1";
      var m = RX.exec((b.textContent || "").trim());
      if (m && window.lvStk) { b.innerHTML = '<img class="lv-stk" src="' + window.lvStk.src(m[1]) + '" alt="sticker" width="96" height="96" loading="lazy" decoding="async">'; b.closest(".chat-bubble")?.classList.add("lv-stk-only"); }
    });
  }
  var raf = 0;
  try { new MutationObserver(function () { if (!raf) raf = requestAnimationFrame(function () { raf = 0; dress(); }); }).observe(document.body, { childList: true, subtree: true, characterData: true }); } catch (_) {}
})();

/* ===== Vendors: once per app open, a bottom drawer asks how long customers may wait for them to confirm an order ===== */
(function () {
  var shown = false;
  function uid() { try { return session && session.user && session.user.id; } catch (_) { return null; } }
  function isSet(id) { try { return localStorage.getItem("lv-expiry-set:" + id) === "1"; } catch (_) { return false; } }
  function ask() {
    if (shown || document.hidden) return;
    var v = (typeof vendor !== "undefined" ? vendor : null), id = uid();
    if (!id || !v || !v.id || isSet(v.id) || v.status === "pending" || document.getElementById("lvExpirySheet")) return;
    // never in the middle of something: only on the home screen, and not while a dialog or sheet is open
    if (document.querySelector(".lvw-sheet-wrap, .modal-overlay:not(.hidden), .lv-pin")) return;
    shown = true;
    build();
  }
  function build() {
    var v = (typeof vendor !== "undefined" ? vendor : null); if (!v || !v.id || document.getElementById("lvExpirySheet")) return;
    var m = document.createElement("div");
    m.id = "lvExpirySheet"; m.className = "lvw-sheet-wrap lw-wrap";
    m.innerHTML = '<div class="lvw-sheet lw-sheet lvx" role="dialog" aria-modal="true" aria-label="Order confirmation time"><div class="lvw-sheet-grab" aria-hidden="true"></div>' +
      '<div class="lvx-ic"><i class="fa-regular fa-clock"></i></div><h3 class="lvx-t">Confirm orders in time</h3>' +
      '<p class="lvx-s">An order you don\'t confirm within this time cancels itself and the customer is told.</p>' +
      '<label class="lvx-sel"><select id="lvExpirySel"><option value="30">30 minutes</option><option value="60">1 hour</option><option value="120">2 hours (good for food and snacks)</option><option value="180">3 hours</option><option value="1440">1 day</option><option value="2880">2 days</option><option value="10080">1 week</option><option value="0">Never cancel by itself</option></select><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></label>' +
      '<button type="button" class="lvx-go" id="lvExpirySave">Save</button><button type="button" class="lvx-later" id="lvExpiryLater">Do it later</button>' +
      '<p class="lvx-fine">You can change this any time in your shop profile, or per product.</p></div>';
    m.addEventListener("click", function (e) { if (e.target === m) m.remove(); });
    document.body.appendChild(m);
    var sel = m.querySelector("#lvExpirySel"); sel.value = String(v.order_expiry_minutes == null ? 30 : v.order_expiry_minutes);
    m.querySelector("#lvExpiryLater").onclick = function () { m.remove(); };
    m.querySelector("#lvExpirySave").onclick = async function () {
      var b = this; b.disabled = true;
      var n = Number(sel.value);
      try {
        var r = await sb.from("vendors").update({ order_expiry_minutes: n }).eq("id", v.id);
        if (r && r.error) throw r.error;
        v.order_expiry_minutes = n;
        try { localStorage.setItem("lv-expiry-set:" + v.id, "1"); } catch (_) {}
        m.remove(); showToast("Saved. Unconfirmed orders will cancel after your chosen time.", "success");
      } catch (e) { b.disabled = false; showToast((e && e.message) || "Could not save. Please try again.", "error"); }
    };
  }
  setInterval(function () { if (!shown) ask(); }, 6000);
  window.lvOpenExpirySheet = build;   // also reachable from the shop menu
})();

/* ===== Chat list: "typing..." in green on a row while that person types, before the chat is opened ===== */
(function () {
  var subs = {}, timers = {};
  function row(id) { return document.querySelector('.conv-list-item[data-conversation-id="' + id + '"] .conv-preview'); }
  function setTyping(id, on) {
    var p = row(id); if (!p) return;
    if (on && p.dataset.lvOrig === undefined) { p.dataset.lvOrig = p.innerHTML; p.innerHTML = '<span class="lv-conv-typing">typing<i></i><i></i><i></i></span>'; }
    if (!on && p.dataset.lvOrig !== undefined) { p.innerHTML = p.dataset.lvOrig; delete p.dataset.lvOrig; }
  }
  function drop(id) { try { sb.removeChannel(subs[id]); } catch (_) {} delete subs[id]; clearTimeout(timers[id]); }
  function sync() {
    try {
      if (!session || !session.user || typeof sb.channel !== "function" || document.hidden) return;
      var ids = [].map.call(document.querySelectorAll(".conv-list-item[data-conversation-id]"), function (e) { return e.getAttribute("data-conversation-id"); }).slice(0, 30);
      var open = typeof activeConversationId !== "undefined" ? activeConversationId : null;
      Object.keys(subs).forEach(function (id) { if (ids.indexOf(id) < 0 || id === open) drop(id); });
      ids.forEach(function (id) {
        if (subs[id] || id === open) return;   // the open chat has its own channel
        var ch = sb.channel("conv-" + id + "-list");
        subs[id] = ch;
        // the sender's typing is also sent on the list channel (see lvListTyping below)
        ch.on("broadcast", { event: "typing" }, function (m) {
          var pl = m && m.payload; if (!pl || pl.user_id === session.user.id) return;
          setTyping(id, !!pl.typing); clearTimeout(timers[id]);
          if (pl.typing) timers[id] = setTimeout(function () { setTyping(id, false); }, 2600);
        }).subscribe();
      });
    } catch (_) {}
  }
  setInterval(sync, 2500);
  // the chat that is being typed in also announces on the "-list" channel so rows elsewhere can show it
  var lastSent = 0, sender = {};
  window.lvListTyping = function (conversationId, on) {
    try {
      var now = Date.now(); if (on && now - lastSent < 900) return; lastSent = now;
      var ch = sender[conversationId];
      if (!ch) { ch = sender[conversationId] = sb.channel("conv-" + conversationId + "-list"); ch.subscribe(); }
      ch.send({ type: "broadcast", event: "typing", payload: { user_id: session.user.id, typing: !!on, at: now } });
    } catch (_) {}
  };
  var h = window.handleChatTyping;
  if (typeof h === "function") window.handleChatTyping = function (cid) { var r = h.apply(this, arguments); try { window.lvListTyping(cid, true); } catch (_) {} return r; };
})();

/* ===== Messages: long-press shows the message lifted over a soft backdrop, reactions above it, a clean action list below ===== */
(function () {
  var EMO = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
  function close() { var o = document.getElementById("lvMm"); if (o) o.remove(); document.querySelectorAll(".msg-action-menu, .reaction-picker").forEach(function (p) { p.remove(); }); }
  window.lvCloseMsgMenu = close;
  window.showMessageActionMenu = function (bubble) {
    close();
    var id = bubble.dataset.msgId; if (!id) return;
    var mine = bubble.classList.contains("mine");
    var within = !!bubble.dataset.createdAt && Date.now() - new Date(bubble.dataset.createdAt).getTime() <= (typeof MESSAGE_EDIT_WINDOW_MS !== "undefined" ? MESSAGE_EDIT_WINDOW_MS : 15 * 60 * 1000);
    var hasText = !!bubble.querySelector(".chat-bubble-text") && !bubble.querySelector(".chat-bubble-text img.lv-stk");
    var pinned = typeof isChatMessagePinned === "function" && isChatMessagePinned(id);
    var rows = [["fa-reply", "Reply", "setChatReplyTarget"]];
    if (hasText) rows.push(["fa-regular fa-copy", "Copy", "copySingleChatMessage"]);
    rows.push([pinned ? "fa-thumbtack-slash" : "fa-thumbtack", pinned ? "Unpin" : "Pin", pinned ? "unpinChatMessage" : "pinChatMessage"]);
    if (mine && within && hasText) rows.push(["fa-pen", "Edit", "startEditMessage"]);
    rows.push(["fa-regular fa-square-check", "Select", "enterChatSelectionMode"]);
    if (mine && within) rows.push(["fa-trash", "Delete", "confirmDeleteMessage", 1]);
    var rect = bubble.getBoundingClientRect(), vh = window.innerHeight, vw = window.innerWidth;
    var o = document.createElement("div"); o.id = "lvMm"; o.className = "lv-mm";
    var clone = bubble.cloneNode(true); clone.removeAttribute("data-msg-id"); clone.classList.add("lv-mm-clone");
    clone.querySelectorAll("[id]").forEach(function (n) { n.removeAttribute("id"); });
    var react = document.createElement("div"); react.className = "lv-mm-react";
    react.innerHTML = EMO.map(function (e) { return '<button type="button" aria-label="React ' + e + '">' + e + "</button>"; }).join("");
    var menu = document.createElement("div"); menu.className = "lv-mm-menu";
    menu.innerHTML = rows.map(function (r) { return '<button type="button"' + (r[3] ? ' class="danger"' : "") + ' data-act="' + r[2].replace(/"/g, "&quot;") + '"><span>' + r[1] + '</span><i class="' + (r[0].indexOf(" ") > -1 ? r[0] : "fa-solid " + r[0]) + '"></i></button>'; }).join("");
    o.appendChild(react); o.appendChild(clone); o.appendChild(menu);
    document.body.appendChild(o);
    // lay out: reactions above the message, actions below it; shift the whole stack so everything stays on screen
    var rh = 46, gap = 8, mh = menu.offsetHeight, top0 = 10 + (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--safe-top")) || 0), bot0 = 10 + (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--safe-bottom")) || 0);
    var maxB = Math.max(80, vh - top0 - bot0 - rh - mh - gap * 2);
    var bh = Math.min(rect.height, maxB), bw = Math.min(rect.width, vw - 24);
    var top = Math.min(Math.max(rect.top, top0 + rh + gap), vh - bot0 - mh - gap - bh);
    clone.style.cssText = "position:fixed;left:" + Math.min(Math.max(8, rect.left), vw - bw - 8) + "px;top:" + top + "px;width:" + bw + "px;max-height:" + bh + "px;overflow:hidden;margin:0";
    var left = mine ? Math.max(8, rect.right - 232) : Math.min(rect.left, vw - 240);
    react.style.cssText = "left:" + Math.min(Math.max(8, mine ? rect.right - 300 : rect.left), vw - 308) + "px;top:" + (top - rh - gap) + "px";
    menu.style.cssText = "left:" + Math.max(8, left) + "px;top:" + (top + bh + gap) + "px";
    o.addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (b && react.contains(b)) { var em = b.textContent; close(); try { reactToMessage({ stopPropagation: function () {} }, id, em); } catch (_) {} return; }
      if (b && menu.contains(b)) { var a = b.getAttribute("data-act"); close(); try { var fn = window[a] || (typeof globalThis[a] === "function" ? globalThis[a] : null); if (fn) fn(id); } catch (_) {} return; }
      if (e.target === o) close();
    });
  };
  // ---- edit in the message box (not inside the bubble)
  window.startEditMessage = function (msgId) {
    close();
    var bubble = document.querySelector('.chat-bubble[data-msg-id="' + msgId + '"]'), ta = document.getElementById("chatInput");
    if (!bubble || !ta) return;
    window.__lvEditId = msgId;
    var box = document.getElementById("chatReplyPreview");
    if (box) { box.innerHTML = '<span class="reply-accent"></span><div class="reply-copy"><div class="reply-label">Editing message</div><div class="reply-text"></div></div><button type="button" class="reply-close" aria-label="Cancel edit" onclick="lvCancelEdit()"><i class="fa-solid fa-xmark"></i></button>'; box.querySelector(".reply-text").textContent = bubble.querySelector(".chat-bubble-text").textContent; box.classList.remove("hidden"); }
    ta.value = bubble.querySelector(".chat-bubble-text").textContent || ""; ta.dispatchEvent(new Event("input", { bubbles: true })); ta.focus();
  };
  window.lvCancelEdit = function () {
    window.__lvEditId = null; var ta = document.getElementById("chatInput"); if (ta) { ta.value = ""; ta.dispatchEvent(new Event("input", { bubbles: true })); }
    var box = document.getElementById("chatReplyPreview"); if (box) { box.classList.add("hidden"); box.innerHTML = ""; }
  };
  async function saveEdit() {
    var id = window.__lvEditId, ta = document.getElementById("chatInput"); if (!id || !ta) return;
    var text = ta.value.trim(); if (!text) { showToast("Message can't be empty.", "error"); return; }
    var r = await sb.rpc("edit_message", { p_message_id: id, p_new_body: text });
    if (r.error) { showToast(r.error.message, "error"); return; }
    var bubble = document.querySelector('.chat-bubble[data-msg-id="' + id + '"]');
    if (bubble) {
      var t = bubble.querySelector(".chat-bubble-text"); if (t) t.textContent = text;
      var tm = bubble.querySelector(".chat-time"); if (tm && tm.innerHTML.indexOf("(edited)") < 0) tm.insertAdjacentHTML("afterbegin", '<span class="muted" style="font-size:0.7rem;">(edited)</span>');
    }
    window.lvCancelEdit();
  }
  // the send button and Enter save the edit instead of sending a new message
  document.addEventListener("click", function (e) {
    if (!window.__lvEditId) return;
    var b = e.target.closest && e.target.closest(".chat-input-row > .btn"); if (!b) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); saveEdit();
  }, true);
  document.addEventListener("keydown", function (e) {
    if (!window.__lvEditId || e.key !== "Enter" || e.shiftKey || !e.target || e.target.id !== "chatInput") return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); saveEdit();
  }, true);
})();

/* The product photo never opens a full-screen viewer */
window.openProductImageLightbox = function () {};
window.openProductGallerySlide = function (event) { try { event && event.stopPropagation && event.stopPropagation(); } catch (_) {} };

/* ===== Tapping a notification lands on the exact thing and flashes it (the new comment, reply, suggestion or order) ===== */
(function () {
  function flash(el) {
    try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (_) {}
    el.classList.add("lv-flash"); setTimeout(function () { el.classList.remove("lv-flash"); }, 3200);
  }
  function seek(ids, tries) {
    var hit = null;
    for (var i = 0; i < ids.length && !hit; i++) {
      var v = CSS.escape(ids[i]);
      hit = document.querySelector('[data-comment-id="' + v + '"], [data-reply-id="' + v + '"], [data-suggestion-id="' + v + '"], [data-order-id="' + v + '"], [data-message-id="' + v + '"], [data-msg-id="' + v + '"]');
    }
    if (hit) return flash(hit);
    if (tries > 0) setTimeout(function () { seek(ids, tries - 1); }, 400);
  }
  var orig = window.handleNotifItemClick;
  if (typeof orig !== "function") return;
  window.handleNotifItemClick = async function (event, id) {
    var item = event && event.currentTarget, params = {}, view = "", type = "";
    try { params = JSON.parse((item && item.dataset.params) || "{}"); view = (item && item.dataset.view) || ""; type = (item && item.dataset.type) || ""; } catch (_) {}
    var r = await orig.apply(this, arguments);
    try {
      var ids = Object.keys(params).map(function (k) { return params[k]; }).filter(function (x) { return typeof x === "string" && x.length > 8; });
      var pid = params.productId || params.product_id;
      // a comment or reply on a product: open its comments first so the new one is on screen
      if (view === "productDetail" && pid && (params.commentId || params.comment_id || /comment|reply/i.test(type))) setTimeout(function () { try { window.lvOpenProductComments && window.lvOpenProductComments(pid); } catch (_) {} }, 600);
      if (ids.length) seek(ids.filter(function (x) { return x !== pid; }), 14);
    } catch (_) {}
    return r;
  };
})();

/* ===== Shop page: "Online now" or "Last seen ..." under the shop's name ===== */
(function () {
  var cache = {};
  function line(on, at) {
    if (on) return '<span class="sf-pdot on"></span>Online now';
    if (!at) return "";
    var ago = typeof timeAgo === "function" ? timeAgo(at) : "";
    return ago ? '<span class="sf-pdot"></span>Last seen ' + ago.replace(/^just now$/i, "just now") : "";
  }
  function dress() {
    var row = document.querySelector(".storefront-name-row");
    if (!row || row.nextElementSibling && row.nextElementSibling.classList.contains("sf-presence")) return;
    var vt = row.querySelector("[data-vt]"), id = vt && vt.getAttribute("data-vt");
    if (!id) return;
    try { if (typeof isOwnVendorId === "function" && isOwnVendorId(id)) return; } catch (_) {}
    var el = document.createElement("div"); el.className = "sf-presence"; row.insertAdjacentElement("afterend", el);
    var c = cache[id];
    var paint = function (d) { var h = d ? line(d.online, d.last_seen_at) : ""; el.innerHTML = h; el.hidden = !h; };
    if (c && Date.now() - c.at < 60000) return paint(c.d);
    el.hidden = true;
    Promise.resolve(sb.rpc("get_shop_presence", { p_vendor_id: id })).then(function (r) { var d = r && r.data; if (d && Array.isArray(d)) d = d[0]; cache[id] = { at: Date.now(), d: d }; paint(d); }).catch(function () {});
  }
  // the same line on a product / service page, under the shop's name
  function dressPd() {
    var anchors = document.querySelectorAll(".product-detail-vendor-link, .service-vendor-info-head");
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      if (a.getAttribute("data-lv-pres")) continue;
      var m = /vendorId:\s*'([0-9a-f-]{36})'/i.exec(a.getAttribute("onclick") || ""); if (!m) continue;
      var id = m[1];
      a.setAttribute("data-lv-pres", "1");
      try { if (typeof isOwnVendorId === "function" && isOwnVendorId(id)) continue; } catch (_) {}
      var el = document.createElement("div"); el.className = "sf-presence pd-presence"; el.hidden = true;
      // inside the "Vendor:" line, right under the shop's name (a sibling would be moved by the page's flex ordering)
      if (a.classList.contains("product-detail-vendor-link")) a.insertAdjacentElement("afterend", el);
      else a.insertAdjacentElement("beforeend", el);
      (function (el, id) {
        var paint = function (d) { var h = d ? line(d.online, d.last_seen_at) : ""; el.innerHTML = h; el.hidden = !h; };
        var c = cache[id];
        if (c && Date.now() - c.at < 60000) return paint(c.d);
        Promise.resolve(sb.rpc("get_shop_presence", { p_vendor_id: id })).then(function (r) { var d = r && r.data; if (d && Array.isArray(d)) d = d[0]; cache[id] = { at: Date.now(), d: d }; paint(d); }).catch(function () {});
      })(el, id);
    }
  }
  var raf = 0;
  try { new MutationObserver(function () { if (!raf) raf = requestAnimationFrame(function () { raf = 0; dress(); dressPd(); }); }).observe(document.body, { childList: true, subtree: true }); } catch (_) {}
})();

/* ===== Everyone sets a delivery address once: a bottom drawer asks signed-in people who have none (each time the app opens, until they save one),
   and the cart asks for it before checking out ===== */
(function () {
  var shown = false;
  // opens the drawer; resolves true when an address was saved, false on "Later"
  window.lvAskAddress = function () {
    return new Promise(function (resolve) {
      var id = null; try { id = session && session.user && session.user.id; } catch (_) {}
      if (!id || document.getElementById("lvAddrSheet")) return resolve(false);
      var m = document.createElement("div"); m.id = "lvAddrSheet"; m.className = "lvw-sheet-wrap lw-wrap";
      m.innerHTML = '<div class="lvw-sheet lw-sheet" role="dialog" aria-modal="true" aria-label="Delivery address"><div class="lvw-sheet-grab" aria-hidden="true"></div>' +
        '<div class="lvw-sheet-head"><h3>Where should orders be delivered?</h3></div>' +
        '<p class="muted" style="margin:.2rem 0 .7rem">Add your delivery address once and every order uses it. You can change it any time in your profile.</p>' +
        '<textarea id="lvAddrIn" rows="2" class="ve-input" placeholder="e.g. Elkanemi Hostel, Block A, Room A12"></textarea><p class="lw-err" id="lvAddrErr" hidden></p>' +
        '<div style="display:flex;gap:.6rem;margin-top:.9rem"><button type="button" class="btn btn-secondary" id="lvAddrLater" style="flex:1">Later</button><button type="button" class="btn btn-primary" id="lvAddrSave" style="flex:1">Save</button></div></div>';
      document.body.appendChild(m);
      m.querySelector("#lvAddrLater").onclick = function () { m.remove(); resolve(false); };
      m.querySelector("#lvAddrSave").onclick = async function () {
        var b = this, v = m.querySelector("#lvAddrIn").value.trim(), er = m.querySelector("#lvAddrErr");
        if (v.length < 5) { er.textContent = "Please enter your full delivery address."; er.hidden = false; return; }
        b.disabled = true;
        var r = await sb.from("users").update({ address: v }).eq("id", id);
        if (r && r.error) { b.disabled = false; er.textContent = r.error.message || "Could not save."; er.hidden = false; return; }
        profile.address = v; m.remove(); showToast("Delivery address saved.", "success"); resolve(true);
      };
    });
  };
  function ask() {
    if (shown || document.hidden) return;
    var id = null; try { id = session && session.user && session.user.id; } catch (_) {}
    if (!id || typeof profile === "undefined" || !profile || profile.address || profile.role === "admin" || !profile.name) return;
    if (document.getElementById("lvAddrSheet") || document.querySelector("#lvCampus, #lvSetup, #lvOnb, .lvw-sheet-wrap, .modal-overlay:not(.hidden)")) return;
    shown = true; window.lvAskAddress();
  }
  setInterval(function () { if (!shown) ask(); }, 7000);
  // checking out from the cart without an address: ask first, then carry on
  ["checkoutCartAll", "checkoutCartVendor"].forEach(function (n) {
    var f = window[n]; if (typeof f !== "function") return;
    window[n] = async function () {
      try { if (session && typeof profile !== "undefined" && profile && !profile.address && profile.role !== "admin" && !(await window.lvAskAddress())) return; } catch (_) {}
      return f.apply(this, arguments);
    };
  });
})();

/* a flat "no image" picture for listings without a photo (cards, shop strips and the product page) */
window.lvNoImageHtml = function (seed) {
  // soft lilac / peach / rose / sky colours only (never green or yellow)
  var HUES = [268, 18, 338, 204, 288, 12, 252, 350, 190, 305, 25, 225], h = HUES[0];
  try { h = HUES[stableAvatarHue(String(seed || "x")) % HUES.length]; } catch (_) {}
  return '<span class="lv-noimg" role="img" aria-label="No photo yet" style="--ni-h:' + h + '"><svg viewBox="0 0 64 64" width="48" height="48" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 22h36l-3 30a4 4 0 0 1-4 3.6H21a4 4 0 0 1-4-3.6z"/><path d="M24 22v-3a8 8 0 0 1 16 0v3"/><path d="M50 8l1.6 4.4L56 14l-4.4 1.6L50 20l-1.6-4.4L44 14l4.4-1.6z" fill="currentColor" stroke="none"/></svg></span>';
};

/* ===== The chat's three-dots menu is a bottom drawer with coloured icons (tap outside to close) ===== */
(function () {
  var COL = [[/thumbtack|pin/, "#f59e0b"], [/list|folder|plus|bookmark/, "#3b82f6"], [/box-archive|archive|inbox/, "#8b5cf6"], [/user-slash|ban|block/, "#ef4444"], [/trash/, "#e11d48"], [/user|profile|store|eye/, "#14b8a6"], [/flag|exclamation|triangle/, "#f97316"], [/envelope|unread|circle-dot/, "#0ea5e9"]];
  function colorFor(cls) { for (var i = 0; i < COL.length; i++) if (COL[i][0].test(cls)) return COL[i][1]; return "#64748b"; }
  function close() {
    var s = document.getElementById("lvChatSheet"); if (!s) return;
    s.classList.add("out"); setTimeout(function () { s.remove(); }, 200);
  }
  window.closeChatMenu = close;
  window.toggleChatMenu = function (evt) {
    if (evt && evt.stopPropagation) evt.stopPropagation();
    if (document.getElementById("lvChatSheet")) return close();
    var dd = document.getElementById("chatMenuDropdown"); if (!dd) return;
    var srcs = [].filter.call(dd.querySelectorAll("button, a"), function (b) { return !/^\s*(pin|unpin|view (the )?(store|shop|profile))/i.test(b.textContent || ""); });
    var rows = srcs.map(function (b) {
      var ic = b.querySelector("i"), cls = ic ? ic.className : "";
      var label = (b.textContent || "").replace(/\s+/g, " ").trim();
      var danger = /delete|block/i.test(label);
      return '<button type="button" class="lvcs-row' + (danger ? " danger" : "") + '"><span class="lvcs-ic" style="--c:' + colorFor(cls) + '"><i class="' + cls + '"></i></span><span>' + label.replace(/[<>&]/g, "") + "</span></button>";
    }).join("");
    var s = document.createElement("div"); s.id = "lvChatSheet"; s.className = "lvcs-wrap";
    s.innerHTML = '<div class="lvcs-sheet" role="dialog" aria-modal="true"><div class="lvcs-grab"></div>' + rows + "</div>";
    s.addEventListener("click", function (e) {
      if (e.target === s) return close();
      var row = e.target.closest(".lvcs-row"); if (!row) return;
      var idx = [].indexOf.call(s.querySelectorAll(".lvcs-row"), row), src = srcs[idx];
      close(); if (src) setTimeout(function () { src.click(); }, 120);
    });
    document.body.appendChild(s);
  };
})();

/* ===== Chat list: "You:" and ticks (sent / delivered / read) on the last message of each chat ===== */
(function () {
  var cache = {}, timer = 0, busy = false;
  function tickHtml(st) {
    if (!st) return "";
    if (st.read_at) return '<i class="fa-solid fa-check-double conv-tk read"></i>';
    if (st.delivered_at) return '<i class="fa-solid fa-check-double conv-tk"></i>';
    return '<i class="fa-solid fa-check conv-tk"></i>';
  }
  function paint() {
    var me = null; try { me = session && session.user && session.user.id; } catch (_) {}
    if (!me) return;
    document.querySelectorAll(".conv-list-item[data-conversation-id]").forEach(function (row) {
      var id = row.getAttribute("data-conversation-id"), st = cache[id], pv = row.querySelector(".conv-preview");
      if (!st || !pv || pv.querySelector(".lv-conv-typing")) return;
      var mine = st.last_sender_id === me, key = (mine ? "m" : "t") + (st.read_at ? "r" : st.delivered_at ? "d" : "s");
      if (pv.dataset.tk === key) return;
      pv.querySelectorAll(".conv-tk, .conv-you").forEach(function (n) { n.remove(); });
      if (mine) pv.insertAdjacentHTML("afterbegin", tickHtml(st) + ' ');
      pv.dataset.tk = key;
    });
  }
  function load() {
    if (busy) return; busy = true;
    var ids = [].map.call(document.querySelectorAll(".conv-list-item[data-conversation-id]"), function (r) { return r.getAttribute("data-conversation-id"); }).slice(0, 80);
    if (!ids.length) { busy = false; return; }
    Promise.resolve(sb.rpc("get_conversation_last_status", { p_conversation_ids: ids })).then(function (r) {
      (r && r.data || []).forEach(function (x) { cache[x.conversation_id] = x; });
      paint();
    }).catch(function () {}).then(function () { busy = false; });
  }
  var raf = 0;
  try { new MutationObserver(function () { if (!raf) raf = requestAnimationFrame(function () { raf = 0; paint(); var need = document.querySelector(".conv-list-item[data-conversation-id]:not([data-tkreq])"); if (need) { document.querySelectorAll(".conv-list-item[data-conversation-id]").forEach(function (r) { r.setAttribute("data-tkreq", "1"); }); clearTimeout(timer); timer = setTimeout(load, 150); } }); }).observe(document.body, { childList: true, subtree: true }); } catch (_) {}
  setInterval(function () { if (!document.hidden && document.querySelector(".conv-list-item")) load(); }, 20000);
})();

/* ===== Vendor statuses: a strip on the Vendors page, a Status page, a full-screen viewer and "Add an update" (24 hours) ===== */
(function () {
  "use strict";
  var SEEN = "lv-st-seen", cache = { at: 0, rows: [] };
  function E(s) { return typeof esc === "function" ? esc(s) : String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function seenMap() { try { return JSON.parse(localStorage.getItem(SEEN) || "{}"); } catch (_) { return {}; } }
  function markSeen(id) { var m = seenMap(); m[id] = Date.now(); var keys = Object.keys(m); if (keys.length > 400) keys.sort(function (a, b) { return m[a] - m[b]; }).slice(0, 150).forEach(function (k) { delete m[k]; }); try { localStorage.setItem(SEEN, JSON.stringify(m)); } catch (_) {} try { window.lvStatusBadge && window.lvStatusBadge(); } catch (_) {} }
  function naira(n) { return "₦" + Number(n || 0).toLocaleString("en-NG"); }
  function myVendorId() { try { return typeof vendor !== "undefined" && vendor && vendor.id ? vendor.id : null; } catch (_) { return null; } }
  function avatar(url, name, cls) { return '<span class="' + (cls || "lvst-av") + '">' + (url ? '<img src="' + E(url) + '" alt="" loading="lazy" onerror="this.remove()">' : "") + '<b>' + E(String(name || "?").trim().charAt(0).toUpperCase()) + "</b></span>"; }
  var KEEP = "lv-st-cache";
  try { var kept = JSON.parse(localStorage.getItem(KEEP) || "null"); if (kept && Array.isArray(kept.rows)) cache = { at: 0, rows: kept.rows.filter(function (r) { return r && new Date(r.expires_at) > new Date(); }) }; } catch (_) {}
  var loading = null;
  // Never throws away what we already know: if the request fails (slow network, session not ready yet) the last good list stays on screen
  async function load(force) {
    if (!force && cache.at && Date.now() - cache.at < 30000) return cache.rows;
    if (loading) return loading;
    loading = (async function () {
      for (var tries = 0; tries < 3; tries++) {
        try {
          var r = await sb.from("vendor_statuses").select("id,vendor_id,product_id,caption,show_price,animation,created_at,expires_at,vendor:vendors(id,business_name,logo_url,verification_status),product:products(id,name,photos,sale_price,discount_price,is_service)").gt("expires_at", new Date().toISOString()).order("created_at", { ascending: true }).limit(200);
          if (r && !r.error && Array.isArray(r.data)) { cache = { at: Date.now(), rows: r.data }; try { localStorage.setItem(KEEP, JSON.stringify({ rows: r.data })); } catch (_) {} return cache.rows; }
        } catch (_) {}
        await new Promise(function (ok) { setTimeout(ok, 700 * (tries + 1)); });
      }
      cache.at = Date.now() - 20000; // try again in about 10 seconds; keep showing the last good list
      return cache.rows;
    })();
    try { return await loading; } finally { loading = null; }
  }
  function unseenCount() { var seen = seenMap(), mine = myVendorId(); return cache.rows.filter(function (s) { return s.vendor && s.vendor_id !== mine && followed(s.vendor_id) && !seen[s.id] && new Date(s.expires_at) > new Date(); }).length; }
  function paintNavBadge() {
    var n = unseenCount();
    document.querySelectorAll(".bottom-nav-item").forEach(function (b) {
      if (!/navigate\('vendors'\)/.test(b.getAttribute("onclick") || "")) return;
      var ic = b.querySelector(".bn-icon"); if (!ic) return; var old = ic.querySelector(".bn-badge.lv-st-badge");
      if (!n) { if (old) old.remove(); return; }
      if (!old) { old = document.createElement("span"); old.className = "bn-badge lv-st-badge"; ic.appendChild(old); }
      old.textContent = n > 9 ? "9+" : String(n);
    });
  }
  window.lvStatusBadge = paintNavBadge;
  setTimeout(function () { load(false).then(paintNavBadge); }, 2500);
  setInterval(function () { if (!document.hidden) load(true).then(function () { paintNavBadge(); paintStrip(); }); }, 90000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) load(true).then(function () { paintNavBadge(); paintStrip(); }); });
  var nbT = 0;
  new MutationObserver(function () { if (nbT) return; nbT = setTimeout(function () { nbT = 0; paintNavBadge(); }, 150); }).observe(document.body, { childList: true, subtree: true });
  var NOSTATUS = '<svg class="lvst-noic" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="26" fill="none" stroke="currentColor" stroke-opacity=".35" stroke-width="3" stroke-dasharray="7 6" stroke-linecap="round"/><circle cx="32" cy="32" r="17" fill="currentColor" fill-opacity=".1"/><path d="M26 32h12M32 26v12" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"/><circle cx="50" cy="14" r="4" fill="#22c55e"/></svg>';
  // people only see updates from the shops they follow (and their own shop's)
  function followed(vid) {
    try { var f = typeof window.followedVendorSet === "function" ? window.followedVendorSet() : null; return !!(f && f.has(String(vid))); } catch (_) { return false; }
  }
  function groups(rows) {
    var by = {}, seen = seenMap(), mine = myVendorId();
    rows.forEach(function (s) { if (!s.vendor) return; if (s.vendor_id !== mine && !followed(s.vendor_id)) return; var g = by[s.vendor_id] || (by[s.vendor_id] = { id: s.vendor_id, vendor: s.vendor, items: [], unseen: 0, latest: 0, own: s.vendor_id === mine }); g.items.push(s); if (!seen[s.id]) g.unseen++; g.latest = Math.max(g.latest, +new Date(s.created_at)); });
    return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return (b.own - a.own) || ((b.unseen > 0) - (a.unseen > 0)) || (b.latest - a.latest); });
  }
  function vtick(v) { return v && v.verification_status === "verified" ? ' <i class="fa-solid fa-circle-check lvst-tick" title="Verified" aria-label="Verified"></i>' : ""; }
  function ago(d) { var m = Math.max(1, Math.round((Date.now() - new Date(d)) / 60000)); return m < 60 ? m + "m ago" : Math.round(m / 60) + "h ago"; }

  /* ---- the strip on the Vendors page ---- */
  async function paintStrip() {
    var host = document.getElementById("lvStStrip"); if (!host) return;
    try { if (cache.rows.length) drawStrip(host, groups(cache.rows)); } catch (_) {}
    var rows = cache.rows; try { rows = await load(false); } catch (_) {}
    try { drawStrip(host, groups(rows)); } catch (_) { try { drawStrip(host, []); } catch (__) { host.innerHTML = ""; } }
  }
  function cardPhoto(g) { var it = g.items[g.items.length - 1], p = it && it.product; return (p && p.photos && p.photos[0]) || ""; }
  function drawStrip(host, gs) {
    var mine = myVendorId(), own = gs.filter(function (g) { return g.own; })[0], h = "";
    function card(g, isOwn) {
      // your own card, like WhatsApp: with no status yet, your picture sits in the middle with a + on it and the whole card adds
      // one; with a status, the card shows it and the + on your picture adds another
      var ownLogo = (typeof vendor !== "undefined" && vendor && vendor.logo_url) || (typeof profile !== "undefined" && profile && profile.avatar_url) || "";
      var ph = g ? cardPhoto(g) : "", name = isOwn ? (g ? "My status" : "Add status") : g.vendor.business_name, logo = isOwn ? (g && g.vendor.logo_url) || ownLogo : g.vendor.logo_url, bname = g ? g.vendor.business_name : vendor.business_name;
      var attr = g ? 'data-open="' + E(g.id) + '"' : "data-add", empty = isOwn && !g;
      return '<div class="lvu-card' + (g && !isOwn && !g.unseen ? " seen" : "") + (isOwn ? " own" : "") + (empty ? " lvu-empty" : "") + '"><button type="button" class="lvu-hit" ' + attr + ' aria-label="' + E(empty ? "Add a status" : name) + '">' +
        (ph ? '<img class="lvu-ph" src="' + E(ph) + '" alt="" loading="lazy" onerror="this.remove()">' : '<span class="lvu-ph lvu-none"></span>') + '<span class="lvu-shade"></span>' +
        '<span class="lvu-ring">' + avatar(logo, bname, "lvu-av") + (empty ? '<span class="lvu-badge" aria-hidden="true"><i class="fa-solid fa-plus"></i></span>' : "") + "</span>" + '<b class="lvu-name">' + E(name) + (isOwn ? "" : vtick(g && g.vendor)) + "</b></button>" +
        (isOwn && !empty ? '<button type="button" class="lvu-plus" data-add aria-label="Add a status"><i class="fa-solid fa-plus"></i></button>' : "") + "</div>";
    }
    if (mine) h += card(own || null, true);
    gs.filter(function (g) { return !g.own; }).forEach(function (g) { h += card(g, false); });
    if (gs.length) h += '<div class="lvu-card lvu-all"><button type="button" class="lvu-hit" data-page aria-label="See all updates"><i class="fa-solid fa-arrow-right"></i><b class="lvu-name">See all</b></button></div>';
    host.hidden = false; try { paintNavBadge(); } catch (_) {}
    if (!h && !drawStrip.__retry && typeof session !== "undefined" && session) { drawStrip.__retry = 1; setTimeout(function () { paintStrip(); paintNavBadge(); }, 2500); }
    var real = gs.length + (mine ? 1 : 0), ghosts = mine ? 3 : 0, gh = "";
    var GH = [["fa-bag-shopping", "New arrivals", "g2"], ["fa-tags", "Fresh offers", "g3"], ["fa-bullhorn", "Promote your shop", "g4"]];
    for (var gi = 0; gi < ghosts; gi++) { var g3 = GH[gi % 3]; gh += '<div class="lvu-card lvu-ghost ' + g3[2] + '" aria-hidden="true"><span class="lvu-gi"><i class="fa-solid ' + g3[0] + '"></i></span><b>' + g3[1] + "</b></div>"; }
    var html = !gs.length && !mine
      ? '<div class="lvst-none lvst-none-h">' + NOSTATUS + '<span><b>Updates from shops you follow</b>Only shops you follow show here, and each update disappears after 24 hours.</span></div>'
      : '<p class="lvu-cap">From shops you follow</p><div class="lvu-row">' + h + gh + "</div>";
    if (host.__h !== html) { host.__h = html; host.innerHTML = html; }
  }
  document.addEventListener("click", function (e) {
    var o = e.target.closest && e.target.closest("#lvStStrip [data-open]"), a = e.target.closest && e.target.closest("#lvStStrip [data-add], .lvst-addbtn"), pg = e.target.closest && e.target.closest("#lvStStrip [data-page], #vendorsViewStatusBtn");
    if (o) { e.preventDefault(); openViewer(o.getAttribute("data-open")); }
    else if (a) { e.preventDefault(); openAdd(); }
    else if (pg) { e.preventDefault(); openPage(); }
  });
  var t = 0;
  new MutationObserver(function () {
    if (t) return; t = requestAnimationFrame(function () {
      t = 0;
      var page = document.querySelector("#app .vd-page"); if (!page) return;
      var preStrip = document.getElementById("lvStStrip"); if (preStrip && !preStrip.__p) { preStrip.__p = 1; paintStrip(); }
      if (!document.getElementById("lvStStrip")) { var head = page.querySelector(".vd-head"), s = document.createElement("section"); s.id = "lvStStrip"; s.className = "lvst-strip"; s.hidden = false; s.innerHTML = '<div class="lvu-row">' + [1, 2, 3].map(function () { return '<div class="lvu-card sk"></div>'; }).join("") + "</div>"; if (head) head.before(s); else page.prepend(s); paintStrip(); }
      var vs = page.querySelector(".vd-views");
      if (vs && !document.getElementById("vendorsViewStatusBtn")) { var b = document.createElement("button"); b.type = "button"; b.className = "vd-view"; b.id = "vendorsViewStatusBtn"; b.title = "Updates"; b.setAttribute("aria-label", "Updates"); b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5" stroke-dasharray="3.2 2.6"/><circle cx="12" cy="12" r="3.2"/></svg>'; vs.appendChild(b); }
    });
  }).observe(document.documentElement, { childList: true, subtree: true });

  /* ---- the Status page (like WhatsApp's Updates) ---- */
  async function openPage() {
    if (typeof lvTeamOverlay !== "function") return;
    var el = lvTeamOverlay("lvStPage", "Updates", '<p class="muted">Loading…</p>', "Updates from vendors, for 24 hours");
    var body = el.querySelector("[data-lv-body]"), mine = myVendorId();
    var row = function (g) { var last = g.items[g.items.length - 1]; var p = last.product, ph = p && p.photos && p.photos[0]; return '<button type="button" class="lvst-li" data-open="' + E(g.id) + '"><div class="lvst-ring' + (g.unseen ? " live" : " seen") + '">' + avatar(g.vendor.logo_url, g.vendor.business_name) + '</div><div class="lvst-lt"><b>' + E(g.vendor.business_name) + vtick(g.vendor) + "</b><small>" + ago(last.created_at) + " · " + g.items.length + " update" + (g.items.length === 1 ? "" : "s") + "</small></div>" + (ph ? '<img class="lvst-th" src="' + E(ph) + '" alt="" loading="lazy">' : "") + "</button>"; };
    var paintPage = function (gs) {
    var own = gs.filter(function (g) { return g.own; })[0], rest = gs.filter(function (g) { return !g.own; }), fresh = rest.filter(function (g) { return g.unseen; }), old = rest.filter(function (g) { return !g.unseen; });
    body.innerHTML = (mine ? '<div class="lvst-me"><div class="lvst-ring own' + (own ? " live" : "") + '" ' + (own ? 'data-open="' + E(mine) + '"' : "") + ">" + avatar(vendor.logo_url, vendor.business_name) + '<button type="button" class="lvst-plusb" data-add aria-label="Add a status"><i class="fa-solid fa-plus"></i></button></div><div class="lvst-lt"><b>My status</b><small>' + (own ? own.items.length + " live · tap to view" : "Add a product for 24 hours") + '</small></div><button type="button" class="lvst-addbtn" data-add><i class="fa-solid fa-plus"></i> Add</button></div>' : "") +
      (fresh.length ? '<p class="tm-label">Recent updates</p>' + fresh.map(row).join("") : "") + (old.length ? '<p class="tm-label">Viewed</p>' + old.map(row).join("") : "") +
      (!rest.length ? '<div class="lvst-empty">' + NOSTATUS + '<b>No updates yet</b><span>When vendors you follow post a product, it shows here for 24 hours.</span></div>' : "");
    };
    if (cache.rows.length) paintPage(groups(cache.rows));
    paintPage(groups(await load(true)));
    body.addEventListener("click", function (e) { var a = e.target.closest("[data-add]"); if (a) { el.remove(); openAdd(); return; } var o = e.target.closest("[data-open]"); if (o) { el.remove(); openViewer(o.getAttribute("data-open")); } });
  }

  /* ---- the full-screen viewer (WhatsApp-style: bars + header on top, the picture, a compact product card and a slim like row) ---- */
  var V = null, DUR = 6000;
  async function openViewer(vendorId) {
    var gs = groups(await load(false)), gi = gs.findIndex(function (g) { return g.id === vendorId; }); if (gi < 0) return;
    closeViewer();
    var seen = seenMap(), idx = gs[gi].items.findIndex(function (s) { return !seen[s.id]; }); if (idx < 0) idx = 0;
    var el = document.createElement("div"); el.className = "lvst-v"; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", "Update");
    document.body.appendChild(el); V = { el: el, gs: gs, gi: gi, i: idx, timer: 0, left: DUR, t0: 0, holds: {}, s: null, downAt: 0 };
    try { history.pushState(Object.assign({}, history.state, { lvStatus: 1 }), ""); window.addEventListener("popstate", V.pop = function () { closeViewer(true); }, { once: true }); } catch (_) {}
    V.key = function (e) { if (e.key !== "Escape" || !V) return; if (V.el.querySelector(".lvst-sheet,.lvst-menu")) closeLayers(); else closeViewer(); };
    document.addEventListener("keydown", V.key);
    bindViewer(el);
    show();
  }
  function closeViewer(fromPop, then) {
    if (!V) return; clearTimeout(V.timer); V.el.remove();
    try { window.removeEventListener("popstate", V.pop); } catch (_) {} try { document.removeEventListener("keydown", V.key); } catch (_) {}
    V = null;
    var back = !fromPop && history.state && history.state.lvStatus;
    if (back && typeof then === "function") {
      // go back first, then act: if we navigate first, the delayed "back" would undo it (this is why the buttons used to do nothing)
      var done = false, go = function () { if (done) return; done = true; window.removeEventListener("popstate", go); setTimeout(then, 40); };
      window.addEventListener("popstate", go); setTimeout(go, 700);
    }
    if (back) { try { history.back(); } catch (_) {} } else if (typeof then === "function") then();
    paintStrip();
  }
  // the 6-second timer can be paused by several things at once (finger held, menu open, sheet open, button pressed)
  function runTimer() { if (!V) return; clearTimeout(V.timer); V.t0 = Date.now(); V.timer = setTimeout(function () { step(1); }, Math.max(50, V.left)); }
  function pause(why) { if (!V) return; if (!Object.keys(V.holds).length) { clearTimeout(V.timer); V.left = Math.max(50, V.left - (Date.now() - V.t0)); V.el.classList.add("lvst-paused"); barState("paused"); } V.holds[why] = 1; }
  function resume(why) { if (!V || !V.holds[why]) return; delete V.holds[why]; if (!Object.keys(V.holds).length) { V.el.classList.remove("lvst-paused"); barState("running"); runTimer(); } }
  // the progress bar is drawn by script on every frame (not by a CSS animation), so nothing in the page can switch it off
  function barLoop() {
    if (!V) return; var v = V; cancelAnimationFrame(v.raf);
    (function frame() {
      if (!V || V !== v) return;
      var fill = v.stage && v.stage.querySelector(".lvst-bars i.run b");
      if (fill) { var p = 0; if (v.ready) { var running = Object.keys(v.holds).length ? 0 : Date.now() - v.t0; p = Math.max(0, Math.min(1, (DUR - v.left + running) / DUR)); } fill.style.transform = "scaleX(" + p.toFixed(4) + ")"; }
      v.raf = requestAnimationFrame(frame);
    })();
  }
  function barState(st) { try { V.el.querySelectorAll(".lvst-bars i.run b").forEach(function (b) { b.style.animationPlayState = st; }); } catch (_) {} }
  // a cube turn between two updates: the old picture and the new one are two faces of a box that rotates
  function cubeSwap(markup, old, dir, kind) {
    var slide = kind === "slide", el = V.el, w = el.clientWidth || window.innerWidth, tmp = document.createElement("div"); tmp.innerHTML = markup; var nu = tmp.firstChild; V.stage = nu;
    [].slice.call(el.children).forEach(function (n) { if (n !== old) n.remove(); });
    var wrap = document.createElement("div"); wrap.className = "lvst-cube" + (slide ? " lvst-slide" : "");
    old.style.transition = "none"; old.style.transformOrigin = "center";
    if (slide) { old.style.transform = "translateX(0)"; nu.style.transform = "translateX(" + dir * 100 + "%)"; wrap.style.transform = "translateX(0)"; }
    else { old.style.transform = "rotateY(0deg) translateZ(" + w / 2 + "px)"; nu.style.transform = "rotateY(" + dir * 90 + "deg) translateZ(" + w / 2 + "px)"; wrap.style.transform = "translateZ(" + -w / 2 + "px)"; }
    el.appendChild(wrap); wrap.appendChild(old); wrap.appendChild(nu); void wrap.offsetWidth;
    wrap.style.transition = "transform " + (slide ? ".3s ease" : ".42s cubic-bezier(.4,0,.2,1)");
    wrap.style.transform = slide ? "translateX(" + -dir * 100 + "%)" : "translateZ(" + -w / 2 + "px) rotateY(" + -dir * 90 + "deg)";
    var fin = function () { if (!V || V.stage !== nu) return; nu.style.transform = ""; el.innerHTML = ""; el.appendChild(nu); var b = V.begin; V.begin = null; if (b) b(); };
    setTimeout(fin, slide ? 330 : 450);
  }
  function closeLayers() { if (!V) return; V.el.querySelectorAll(".lvst-sheet,.lvst-sheet-bg,.lvst-menu,.lvst-menu-bg").forEach(function (n) { n.remove(); }); resume("menu"); resume("sheet"); }
  function step(d) {
    if (!V) return; var g = V.gs[V.gi], g0 = V.gi;
    if (d > 0) { if (V.i < g.items.length - 1) V.i++; else if (V.gi < V.gs.length - 1) { V.gi++; V.i = 0; } else return closeViewer(); }
    else { if (V.i > 0) V.i--; else if (V.gi > 0) { V.gi--; V.i = 0; } else return; }
    // the cube turns only when going to another shop; within one shop the picture just changes, like WhatsApp
    V.cube = V.gi !== g0 ? (d > 0 ? 1 : -1) : 0; V.cubeKind = "cube";
    show();
  }
  function productUrl(s) { return location.origin + "/p/" + encodeURIComponent(String(s.product_id || "")); }
  function goProduct(s, order) {
    var pid = s.product_id; if (!pid) return;
    if (order && !(typeof session !== "undefined" && session && session.user)) { closeViewer(false, function () { try { showLogin(); } catch (_) {} }); return; }
    closeViewer(false, function () {
      var r; try { r = navigate("productDetail", { productId: pid }); } catch (_) {}
      if (order) Promise.resolve(r).then(function () { setTimeout(function () { var b = document.querySelector("#app .pd-place-order, #app button[onclick^='confirmRental']"), c = b && (b.closest(".card") || b); if (c && c.scrollIntoView) c.scrollIntoView({ behavior: "smooth", block: "center" }); }, 300); });
    });
  }
  async function shareStatus(s, copyOnly) {
    var p = s.product || {}, url = productUrl(s), name = p.name || "this product";
    try {
      if (!copyOnly && navigator.share) { await navigator.share({ title: name + " | Levromart", text: "Check out " + name + " on Levromart.", url: url }); return; }
      await navigator.clipboard.writeText(url); showToast("Link copied.", "success");
    } catch (err) { if (err && err.name === "AbortError") return; showToast("Could not share it. Try again.", "error"); }
  }
  function layer(kind, html) {
    if (!V) return null; closeLayers();
    var bg = document.createElement("div"); bg.className = "lvst-" + kind + "-bg"; bg.setAttribute("data-bg", "1");
    var box = document.createElement("div"); box.className = "lvst-" + kind; box.innerHTML = html; if (kind === "menu") box.setAttribute("role", "menu"); else { box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true"); }
    V.el.appendChild(bg); V.el.appendChild(box); pause(kind); return box;
  }
  // "Add to cart" on a status: adds one and stays on the status (the cart fills up while you scroll through updates)
  async function addStatusToCart(s, btn) {
    if (!(typeof session !== "undefined" && session && session.user)) { closeViewer(false, function () { try { showLogin(); } catch (_) {} }); return; }
    try { if (typeof blockOwnVendorPurchase === "function" && blockOwnVendorPurchase(s.vendor_id, "buy")) return; } catch (_) {}
    if (btn.__busy) return; btn.__busy = 1;
    var label = btn.innerHTML; btn.innerHTML = '<i class="fa-solid fa-check"></i> Added'; btn.classList.add("added");
    var back = function () { setTimeout(function () { try { btn.innerHTML = label; btn.classList.remove("added"); } catch (_) {} btn.__busy = 0; }, 1600); };
    try {
      var r = await levroData.cart.add(s.product_id, 1, null);
      if (r && r.error) { btn.innerHTML = label; btn.classList.remove("added"); btn.__busy = 0; showToast(r.error.message || "Could not add it.", "error"); return; }
      showToast("Added to cart.", "success");
      try { buyerCartCount += 1; updateCartFab(); window.lmSyncCartCount && window.lmSyncCartCount(); } catch (_) {}
      back();
    } catch (_) { btn.innerHTML = label; btn.classList.remove("added"); btn.__busy = 0; showToast("Could not add it. Try again.", "error"); }
  }
  function openMenu(s, own) {
    var it = function (a, ic, t, cls) { return '<button type="button" role="menuitem" data-m="' + a + '" class="' + (cls || "") + '"><b class="lvst-mi"><i class="' + ic + '"></i></b><span>' + t + "</span></button>"; };
    var h = (own ? it("views", "fa-regular fa-eye", "Viewers") : it("shop", "fa-solid fa-store", "Visit shop")) + it("share", "fa-solid fa-share-nodes", "Share") + it("copy", "fa-regular fa-copy", "Copy link") + (own ? it("del", "fa-regular fa-trash-can", "Delete status", "danger") : "");
    layer("sheet", '<span class="lvst-handle"></span><div class="lvst-ml" role="menu">' + h + "</div>");
  }
  function confirmDelete(s) {
    var b = layer("sheet", '<span class="lvst-handle"></span><h3>Delete this status?</h3><p class="lvst-sub">It will disappear for everyone.</p><div class="lvst-two"><button type="button" data-m="cancel">Cancel</button><button type="button" class="danger" data-m="really">Delete</button></div>'); return b;
  }
  async function deleteStatus(s) {
    var r = await sb.from("vendor_statuses").delete().eq("id", s.id);
    if (r.error) { showToast(r.error.message || "Could not delete it.", "error"); return; }
    cache.at = 0; cache.rows = cache.rows.filter(function (x) { return x.id !== s.id; });
    showToast("Status deleted.", "success"); closeViewer();
  }
  function bindViewer(el) {
    var holdOn = ".lvst-tap, .lvst-bottom";
    el.addEventListener("pointerdown", function (e) { if (!V || !e.target.closest(holdOn)) return; V.downAt = Date.now(); pause("press"); });
    ["pointerup", "pointercancel", "pointerleave"].forEach(function (ev) { el.addEventListener(ev, function () { if (V) resume("press"); }); });
    // WhatsApp-style gestures: drag down to close; swipe left / right to move between updates
    var dr = null, ptrs = {}, pz = null;
    function stage() { return el.querySelector(".lvst-stage"); }
    // pinch with two fingers to zoom into the picture (the text fades away while you look); let go and it settles back
    function startPinch() {
      var ids = Object.keys(ptrs), a = ptrs[ids[0]], b = ptrs[ids[1]], media = el.querySelector(".lvst-media"); if (!media || !a || !b) return;
      dr = null; V.dragged = true; el.style.transform = ""; el.style.opacity = ""; var st0 = stage(); if (st0) st0.style.transform = "";
      var r = media.getBoundingClientRect(); pz = { media: media, d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx0: (a.x + b.x) / 2, cy0: (a.y + b.y) / 2, s: 1, tx: 0, ty: 0 };
      media.style.transformOrigin = (pz.cx0 - r.left) + "px " + (pz.cy0 - r.top) + "px"; pause("zoom"); el.classList.add("lvst-zooming");
    }
    function movePinch() {
      var ids = Object.keys(ptrs); if (!pz || ids.length < 2) return; var a = ptrs[ids[0]], b = ptrs[ids[1]];
      pz.s = Math.max(1, Math.min(4, Math.hypot(a.x - b.x, a.y - b.y) / pz.d0)); pz.tx = (a.x + b.x) / 2 - pz.cx0; pz.ty = (a.y + b.y) / 2 - pz.cy0;
      pz.media.style.transform = "translate(" + pz.tx + "px," + pz.ty + "px) scale(" + pz.s + ")";
    }
    function endPinch() {
      var z = pz; pz = null; if (!z) return; var t0 = performance.now();
      (function f(now) { var k = Math.min(1, (now - t0) / 220), e2 = 1 - Math.pow(1 - k, 3); z.media.style.transform = "translate(" + z.tx * (1 - e2) + "px," + z.ty * (1 - e2) + "px) scale(" + (z.s + (1 - z.s) * e2) + ")"; if (k < 1) requestAnimationFrame(f); else z.media.style.transform = ""; })(t0);
      el.classList.remove("lvst-zooming"); resume("zoom"); setTimeout(function () { if (V) V.dragged = false; }, 260);
    }
    el.addEventListener("pointerdown", function (e) { if (!V || e.target.closest(".lvst-sheet,.lvst-menu")) return; ptrs[e.pointerId] = { x: e.clientX, y: e.clientY }; if (Object.keys(ptrs).length === 2) startPinch(); });
    el.addEventListener("pointermove", function (e) { if (!ptrs[e.pointerId]) return; ptrs[e.pointerId] = { x: e.clientX, y: e.clientY }; if (pz) movePinch(); });
    ["pointerup", "pointercancel"].forEach(function (ev) { el.addEventListener(ev, function (e) { if (!ptrs[e.pointerId]) return; delete ptrs[e.pointerId]; if (pz && Object.keys(ptrs).length < 2) endPinch(); }); });
    el.addEventListener("pointerdown", function (e) { if (!V || pz || Object.keys(ptrs).length > 1 || e.target.closest(".lvst-sheet,.lvst-menu") || (e.pointerType === "mouse" && e.button !== 0)) return; dr = { x: e.clientX, y: e.clientY, on: "", id: e.pointerId }; });
    el.addEventListener("pointermove", function (e) {
      if (pz || !dr || !V || e.pointerId !== dr.id) return; var dy = e.clientY - dr.y, dx = e.clientX - dr.x, st = stage();
      if (!dr.on) {
        if (dy > 12 && dy > Math.abs(dx) * 1.2) dr.on = "y"; else if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.2) dr.on = "x"; else return;
        V.dragged = true; pause("drag"); el.style.transition = "none"; if (st) st.style.transition = "none";
      }
      if (dr.on === "y") { dy = Math.max(0, dy); el.style.transform = "translateY(" + dy + "px) scale(" + (1 - Math.min(dy, 400) / 2400) + ")"; el.style.opacity = String(1 - Math.min(dy, 400) / 700); el.style.borderRadius = Math.min(dy / 4, 28) + "px"; }
      else if (st) { var first = V.gi === 0 && V.i === 0; if (dx > 0 && first) dx = dx / 4; var sameShop = dx < 0 ? V.i < V.gs[V.gi].items.length - 1 : V.i > 0; if (sameShop) { /* no movement inside one shop */ } else { st.style.transformOrigin = dx < 0 ? "right center" : "left center"; st.style.transform = "rotateY(" + (dx / (el.clientWidth || 390) * 38) + "deg)"; } }
    });
    function endDrag(e) {
      if (!dr || (e && e.pointerId !== dr.id)) return; var d = dr; dr = null; if (!d.on || !V) return;
      var dy = (e && e.clientY != null ? e.clientY : d.y) - d.y, dx = (e && e.clientX != null ? e.clientX : d.x) - d.x, st = stage(); setTimeout(function () { if (V) V.dragged = false; }, 60);
      if (d.on === "y") {
        if (dy > 110) { el.style.transition = "transform .18s ease,opacity .18s ease"; el.style.transform = "translateY(100%)"; el.style.opacity = "0"; setTimeout(function () { if (V && V.el === el) closeViewer(); }, 170); }
        else { el.style.transition = "transform .2s ease,opacity .2s ease"; el.style.transform = ""; el.style.opacity = ""; el.style.borderRadius = ""; resume("drag"); }
        return;
      }
      var first = V.gi === 0 && V.i === 0;
      if (st && Math.abs(dx) > 70 && !(dx > 0 && first)) {
        st.style.transition = "none"; st.style.transform = ""; step(dx < 0 ? 1 : -1);
      } else if (st) { st.style.transition = "transform .2s ease"; st.style.transform = ""; resume("drag"); }
    }
    el.addEventListener("pointerup", endDrag); el.addEventListener("pointercancel", endDrag);
    el.addEventListener("click", async function (e) {
      if (!V) return; if (V.dragged) return; var s = V.s; if (!s) return; var t = e.target;
      if (t.closest("[data-bg]")) { closeLayers(); return; }
      var m = t.closest("[data-m]");
      if (m) {
        var a = m.getAttribute("data-m"); if (a === "cancel") { closeLayers(); return; }
        if (a === "views") { openViewers(s); return; }
        if (a === "del") { confirmDelete(s); return; }
        if (a === "really") { var b = m; b.disabled = true; await deleteStatus(s); return; }
        closeLayers();
        if (a === "share") shareStatus(s); else if (a === "copy") shareStatus(s, true);
        else if (a === "shop") { var vid = s.vendor_id; closeViewer(false, function () { try { navigate("storefront", { vendorId: vid }); } catch (_) {} }); }
        return;
      }
      if (t.closest("[data-x]")) return closeViewer();
      if (t.closest("[data-dots]")) { openMenu(s, V.gs[V.gi].own); return; }
      // the shop's picture or name at the top opens its shop, like WhatsApp
      if (t.closest("[data-shop]")) { var sv = s.vendor_id; closeViewer(false, function () { try { navigate("storefront", { vendorId: sv }); } catch (_) {} }); return; }
      if (t.closest("[data-n]")) { if (Date.now() - V.downAt > 350 && V.downAt) return; return step(1); }
      if (t.closest("[data-p]")) { if (Date.now() - V.downAt > 350 && V.downAt) return; return step(-1); }
      var vb = t.closest("button[data-views]"); if (vb) { e.stopPropagation(); return openViewers(s); }
      var pb = t.closest("button[data-view]"); if (pb) { e.stopPropagation(); return goProduct(s, false); }
      var cb = t.closest("button[data-cart]"); if (cb) { e.stopPropagation(); return addStatusToCart(s, cb); }
      if (t.closest("[data-like]")) return toggleLike(s);
    });
  }
  async function show() {
    if (!V) return; clearTimeout(V.timer);
    var g = V.gs[V.gi], s = g.items[V.i], p = s.product || {}, ph = p.photos && p.photos[0], own = g.own;
    V.s = s; V.holds = {}; V.left = DUR; V.el.classList.remove("lvst-paused");
    markSeen(s.id);
    if (!own && typeof session !== "undefined" && session && session.user) { try { Promise.resolve(sb.from("vendor_status_views").insert({ status_id: s.id, viewer_id: session.user.id })).catch(function () {}); } catch (_) {} }
    var price = s.show_price !== false && p.sale_price ? (p.discount_price && Number(p.discount_price) < Number(p.sale_price) ? "<s>" + naira(p.sale_price) + "</s> " + naira(p.discount_price) : naira(p.sale_price)) : "";
    var ANIMS = ["zoom", "pan", "advert"], anim = s.animation && s.animation !== "none" ? (s.animation === "random" ? ANIMS[Math.floor(Math.random() * ANIMS.length)] : s.animation) : "none";
    var kind = p.is_service ? "service" : "product", gone = !p.id;
    // shoppers add straight to the cart without leaving the status; the shop (and services / rentals, which have no cart) just view it
    var cartable = !own && !p.is_service && p.sale_price != null;
    var acts = gone ? "" : '<div class="lvst-acts' + (cartable ? "" : " one") + '"><button type="button" data-view>View ' + kind + "</button>" + (cartable ? '<button type="button" class="pri" data-cart><i class="fa-solid fa-cart-plus"></i> Add to cart</button>' : "") + "</div>";
    var like = own
      ? '<div class="lvst-likes"><button type="button" id="lvStViews" data-views aria-label="See who viewed"><i class="fa-regular fa-eye"></i> <span>…</span><i class="fa-solid fa-chevron-up lvst-up" aria-hidden="true"></i></button></div>'
      : '<button type="button" class="lvst-lk" id="lvStLike" data-like aria-pressed="false"><i class="fa-regular fa-heart"></i><span>Like</span></button>';
    var oldStage = V.cube ? V.el.querySelector(".lvst-stage") : null, cubeDir = V.cube, cubeKind = V.cubeKind; V.cube = 0;
    var markup = '<div class="lvst-stage">' + '<div class="lvst-media"><div class="lvst-bg lvst-a-' + anim + '" style="background-image:url(' + E(ph || "") + ')"></div></div><div class="lvst-shade"></div>' +
      '<div class="lvst-bars">' + g.items.map(function (_, k) { return '<i class="' + (k < V.i ? "d" : k === V.i ? "run" : "") + '">' + (k === V.i ? "<b></b>" : "") + "</i>"; }).join("") + "</div>" +
      '<div class="lvst-top"><button type="button" class="lvst-shop" data-shop aria-label="Open ' + E(g.vendor.business_name) + '\'s shop">' + avatar(g.vendor.logo_url, g.vendor.business_name, "lvst-av sm") + '<span class="lvst-who"><b>' + E(g.vendor.business_name) + vtick(g.vendor) + "</b><small>" + ago(s.created_at) + '</small></span></button><button type="button" class="lvst-ib" data-dots aria-label="More options" aria-haspopup="menu"><i class="fa-solid fa-ellipsis-vertical"></i></button></div>' +
      '<button type="button" class="lvst-tap l" data-p aria-label="Previous"></button><button type="button" class="lvst-tap r" data-n aria-label="Next"></button>' +
      '<div class="lvst-bottom"><div class="lvst-card' + (anim === "advert" ? " lvst-adv" : "") + '">' + (s.caption ? '<p class="lvst-cap">' + E(s.caption) + "</p>" : "") + '<div class="lvst-line"><h4>' + E(gone ? "This product is no longer available" : p.name) + "</h4>" + (price && !gone ? '<div class="lvst-pr">' + price + "</div>" : "") + "</div>" + acts + "</div>" + like + "</div></div>";
    if (oldStage) cubeSwap(markup, oldStage, cubeDir, cubeKind); else { V.el.innerHTML = markup; V.stage = V.el.firstChild; }
    V.ready = false;
    var begin = function () { if (!V) return; V.ready = true; runTimer(); barLoop(); };
    if (oldStage) { V.begin = begin; } else { begin(); }
    var mine = V.s;
    if (!own && typeof session !== "undefined" && session && session.user) { try { var lk = await sb.from("vendor_status_likes").select("user_id").eq("status_id", s.id).eq("user_id", session.user.id); var btn = document.getElementById("lvStLike"); if (V && V.s === mine && btn && lk && lk.data && lk.data.length) setLiked(btn, true); } catch (_) {} }
    if (own) {
      try {
        var c = await sb.from("vendor_status_views").select("viewer_id", { count: "exact", head: true }).eq("status_id", s.id);
        if (!V || V.s !== mine) return;
        var ve = document.querySelector("#lvStViews span"), n = c && c.count != null ? c.count : 0;
        if (ve) ve.textContent = n + (n === 1 ? " view" : " views");
      } catch (_) {}
    }
  }
  function setLiked(btn, on) { btn.classList.toggle("on", on); btn.setAttribute("aria-pressed", on ? "true" : "false"); btn.innerHTML = '<i class="fa-' + (on ? "solid" : "regular") + ' fa-heart"></i><span>' + (on ? "Liked" : "Like") + "</span>"; }
  async function toggleLike(s) {
    if (typeof session === "undefined" || !session || !session.user) { closeViewer(false, function () { try { showLogin(); } catch (_) {} }); return; }
    var btn = document.getElementById("lvStLike"), on = btn && btn.classList.contains("on");
    if (btn) { setLiked(btn, !on); if (!on) { btn.classList.remove("pop"); void btn.offsetWidth; btn.classList.add("pop"); } }
    try {
      var r = on ? await sb.from("vendor_status_likes").delete().eq("status_id", s.id).eq("user_id", session.user.id) : await sb.from("vendor_status_likes").insert({ status_id: s.id, user_id: session.user.id });
      if (r && r.error && !/duplicate/i.test(r.error.message || "")) throw r.error;
    } catch (_) { var b2 = document.getElementById("lvStLike"); if (b2) setLiked(b2, !!on); showToast("Could not save that. Try again.", "error"); }
  }
  // the shop's own "who viewed" sheet: the count and a list of people (picture, name, when)
  async function openViewers(s) {
    var box = layer("sheet", '<span class="lvst-handle"></span><h3>Viewers</h3><p class="lvst-sub">Who saw this update</p><div class="lvst-sl"><p class="lvst-muted">Loading…</p></div>'); if (!box) return;
    var v = await sb.from("vendor_status_views").select("viewer_id,viewer_name,viewer_avatar,seen_at").eq("status_id", s.id).order("seen_at", { ascending: false }).limit(300);
    var l = await sb.from("vendor_status_likes").select("user_id").eq("status_id", s.id);
    var ordered = {};
    try { var o = await sb.from("orders").select("buyer_id,status,created_at,order_items!inner(product_id)").eq("vendor_id", s.vendor_id).eq("order_items.product_id", s.product_id).gte("created_at", s.created_at).limit(300); ((o && o.data) || []).forEach(function (x) { if (x.status !== "cancelled") ordered[x.buyer_id] = 1; }); } catch (_) {}
    if (!V || !box.isConnected) return;
    var liked = {}; ((l && l.data) || []).forEach(function (x) { liked[x.user_id] = 1; });
    var rows = (v && v.data) || [];
    box.innerHTML = '<span class="lvst-handle"></span><h3>Viewed by ' + rows.length + "</h3>" +
      '<div class="lvst-sl">' + (rows.length ? rows.map(function (r) { return '<div class="lvst-vr">' + avatar(r.viewer_avatar, r.viewer_name || "Someone", "lvst-av sm") + '<div class="lvst-lt"><b>' + E(r.viewer_name || "Someone") + "</b><small>" + ago(r.seen_at) + "</small></div>" + (ordered[r.viewer_id] ? '<span class="lvst-ordtag"><i class="fa-solid fa-bag-shopping"></i> Ordered</span>' : "") + (liked[r.viewer_id] ? '<i class="fa-solid fa-heart lvst-vh" aria-label="Liked"></i>' : "") + "</div>"; }).join("") : '<p class="lvst-muted">No views yet. People who open your update will show here.</p>') + "</div>";
  }

  /* ---- Add a status (the shop's owner): one flat page. Preview and edits on top, your products in a grid underneath ---- */
  var STYLES = [["none", "Standard", "fa-image"], ["zoom", "Zoom", "fa-magnifying-glass-plus"], ["pan", "Drift", "fa-arrows-left-right"], ["advert", "Advert", "fa-bullhorn"], ["random", "Surprise me", "fa-shuffle"]];
  async function openAdd() {
    var vid = myVendorId(); if (!vid) { showToast("Only shops can add a status.", "info"); return; }
    var el = lvTeamOverlay("lvStAdd", "New status", '<p class="muted">Loading your products…</p>', "Pick products, then make it yours");
    var body = el.querySelector("[data-lv-body]");
    var r = await sb.from("products").select("id,name,photos,sale_price,is_service").eq("vendor_id", vid).eq("status", "active").order("created_at", { ascending: false }).limit(200);
    var list = (r && r.data) || [];
    if (!list.length) { body.innerHTML = '<div class="tm-empty"><i class="fa-solid fa-box-open"></i><b>No products yet</b>Add a product first, then share it as a status.</div>'; return; }
    try { await load(true); } catch (_) {}
    var live = {}, liveN = 0; cache.rows.forEach(function (x) { if (x.vendor_id === vid && new Date(x.expires_at) > new Date()) { liveN++; if (x.product_id) live[x.product_id] = 1; } });
    var room = Math.max(0, 10 - liveN), picks = [], caps = {}, active = null, showPrice = true, anim = "none", q = "";
    var byId = function (id) { return list.find(function (x) { return x.id === id; }); };
    body.innerHTML = '<div class="lve"><div class="lve-prev" id="lvePrev"></div><div class="lve-edit" id="lveEdit"></div>' +
      '<h3 class="lve-h">Your products</h3><div class="lve-search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input type="text" id="lvPkQ" inputmode="search" enterkeyhint="search" placeholder="Search your products" aria-label="Search your products" autocomplete="off" autocapitalize="off" spellcheck="false"></div>' +
      '<div class="lvpk-grid" id="lvPkGrid"></div></div>' +
      '<div class="lve-bar"><span id="lveN"></span><button type="button" class="lve-go" id="lveGo" disabled>Post</button></div>';
    var $ = function (id) { return document.getElementById(id); };
    var prev = $("lvePrev"), edit = $("lveEdit"), grid = $("lvPkGrid"), cnt = $("lveN"), go = $("lveGo"), inp = $("lvPkQ");
    function drawPrev() {
      var p = byId(active);
      if (!p) { prev.className = "lve-prev"; prev.innerHTML = '<div class="lve-empty"><i class="fa-regular fa-image"></i><b>Your status preview</b><span>Pick a product below to start</span></div>'; return; }
      var ph = p.photos && p.photos[0], an = anim === "random" ? "zoom" : anim;
      prev.className = "lve-prev on";
      prev.innerHTML = '<div class="lve-bg lve-a-' + an + '"' + (ph ? ' style="background-image:url(' + E(ph) + ')"' : "") + '></div><span class="lve-sh"></span><span class="lve-who">' + avatar(vendor.logo_url, vendor.business_name, "lvu-av") + "<b>" + E(vendor.business_name) + '</b></span>' +
        '<div class="lve-tx' + (anim === "advert" ? " lve-adv" : "") + '"><p class="lve-cap"' + (caps[active] ? "" : " hidden") + ">" + E(caps[active] || "") + '</p><div class="lve-line"><b>' + E(p.name) + "</b>" + (showPrice && p.sale_price ? '<em class="lve-pr">' + naira(p.sale_price) + "</em>" : "") + "</div></div>";
    }
    function drawEdit() {
      if (!picks.length) { edit.innerHTML = ""; return; }
      var rows = picks.map(function (id) {
        var x = byId(id), ph = x && x.photos && x.photos[0];
        return '<div class="lve-row' + (id === active ? " on" : "") + '" data-row="' + E(id) + '"><span class="lve-rt">' + (ph ? '<img src="' + E(ph) + '" alt="">' : '<i class="fa-solid fa-image"></i>') + '</span><span class="lve-rc"><b>' + E(x ? x.name : "") + '</b><input class="lve-in" data-cap="' + E(id) + '" maxlength="140" placeholder="Add a caption (optional)" value="' + E(caps[id] || "") + '"></span><button type="button" class="lve-rm" data-rm="' + E(id) + '" aria-label="Remove ' + E(x ? x.name : "") + '"><i class="fa-solid fa-xmark"></i></button></div>';
      }).join("");
      edit.innerHTML = '<div class="lve-rows">' + rows + "</div>" +
        '<label class="lve-sw"><span>Show the price</span><button type="button" data-price class="' + (showPrice ? "on" : "") + '" role="switch" aria-checked="' + showPrice + '"><i></i></button></label>' +
        '<p class="lve-l">Style</p><div class="lve-anims">' + STYLES.map(function (a) { return '<button type="button" data-anim="' + a[0] + '" class="' + (anim === a[0] ? "on" : "") + '"><i class="fa-solid ' + a[2] + '"></i>' + a[1] + "</button>"; }).join("") + "</div>" +
        '<p class="lve-note"><i class="fa-regular fa-clock"></i> Stays up for 24 hours. Followers who allow it get an alert.</p>';
    }
    function drawBar() { cnt.innerHTML = picks.length ? "<b>" + picks.length + "</b> selected" : "Select products"; go.disabled = !picks.length; go.textContent = picks.length > 1 ? "Post " + picks.length : "Post"; }
    function drawGrid() {
      var f = list.filter(function (x) { return !q || String(x.name || "").toLowerCase().indexOf(q) >= 0; });
      grid.innerHTML = f.length ? f.map(function (x) {
        var ph = x.photos && x.photos[0], on = picks.indexOf(x.id) >= 0;
        return '<button type="button" class="lvpk-t' + (on ? " sel" : "") + '" data-p="' + E(x.id) + '" aria-pressed="' + on + '" aria-label="' + E(x.name) + '"><span class="lvpk-ti">' + (ph ? '<img src="' + E(ph) + '" alt="" loading="lazy">' : '<i class="fa-solid fa-image"></i>') + '<em aria-hidden="true"><i class="fa-solid fa-check"></i></em>' + (live[x.id] ? "<u>Live</u>" : "") + "</span><b>" + E(x.name) + "</b><small>" + (x.sale_price ? naira(x.sale_price) : "") + "</small></button>";
      }).join("") : '<p class="lvpk-none">No products match “' + E(q) + "”.</p>";
    }
    function all() { drawPrev(); drawEdit(); drawBar(); }
    grid.onclick = function (e) {
      var b = e.target.closest("[data-p]"); if (!b) return; var id = b.getAttribute("data-p"), at = picks.indexOf(id);
      if (at >= 0) { picks.splice(at, 1); if (active === id) active = picks[picks.length - 1] || null; }
      else { if (picks.length >= room) { showToast(room ? "You can add " + room + " more right now." : "You have 10 live statuses. Delete one or wait for it to expire.", "info"); return; } picks.push(id); active = id; }
      b.classList.toggle("sel", at < 0); b.setAttribute("aria-pressed", at < 0 ? "true" : "false"); all();
    };
    inp.oninput = function () { q = inp.value.trim().toLowerCase(); drawGrid(); };
    edit.onclick = function (e) {
      var rm = e.target.closest("[data-rm]"); if (rm) { var id = rm.getAttribute("data-rm"); picks.splice(picks.indexOf(id), 1); if (active === id) active = picks[picks.length - 1] || null; drawGrid(); all(); return; }
      var an = e.target.closest("[data-anim]"); if (an) { anim = an.getAttribute("data-anim"); drawPrev(); drawEdit(); return; }
      if (e.target.closest("[data-price]")) { showPrice = !showPrice; drawPrev(); drawEdit(); return; }
      var row = e.target.closest("[data-row]"); if (row && row.getAttribute("data-row") !== active && !e.target.closest("input")) { active = row.getAttribute("data-row"); drawPrev(); edit.querySelectorAll(".lve-row").forEach(function (n) { n.classList.toggle("on", n === row); }); }
    };
    edit.addEventListener("focusin", function (e) { var c = e.target.closest && e.target.closest("[data-cap]"); if (!c) return; var id = c.getAttribute("data-cap"); if (id === active) return; active = id; drawPrev(); edit.querySelectorAll(".lve-row").forEach(function (n) { n.classList.toggle("on", n.getAttribute("data-row") === id); }); });
    edit.oninput = function (e) { var c = e.target.closest && e.target.closest("[data-cap]"); if (!c) return; var id = c.getAttribute("data-cap"); caps[id] = c.value; if (id !== active) return; var cp = prev.querySelector(".lve-cap"); if (cp) { cp.textContent = c.value; cp.hidden = !c.value; } };
    go.onclick = async function () {
      if (!picks.length) return; go.disabled = true; go.textContent = "Posting…";
      var rowsA = picks.map(function (id) { return { vendor_id: vid, product_id: id, caption: (caps[id] || "").trim() || null, show_price: showPrice, animation: anim }; });
      var ins = await sb.from("vendor_statuses").insert(rowsA);
      if (ins.error && /animation|column/i.test(ins.error.message || "")) ins = await sb.from("vendor_statuses").insert(rowsA.map(function (x) { return { vendor_id: x.vendor_id, product_id: x.product_id, caption: x.caption, show_price: x.show_price }; }));
      if (ins.error) { drawBar(); showToast(/not valid|does not exist|relation/i.test(ins.error.message || "") ? "Status is not switched on yet. Please try again shortly." : (ins.error.message || "Could not post it."), "error"); return; }
      cache.at = 0; showToast(picks.length > 1 ? picks.length + " statuses are live for 24 hours." : "Your status is live for 24 hours.", "success"); try { history.back(); } catch (_) { el.remove(); } setTimeout(paintStrip, 300);
    };
    drawGrid(); all();
  }
  window.lvStatusOpen = openPage; window.lvStatusAdd = openAdd;
  /* ---- the same ring on a shop's picture on its storefront and in chats: tap it to see the status ---- */
  function liveFor(vid) { var g = groups(cache.rows).filter(function (x) { return x.id === vid; })[0]; return g || null; }
  function decorate() {
    if (Date.now() - cache.at > 60000) { load(false).then(decorate); return; }
    // storefront
    try {
      var vid = typeof currentView !== "undefined" && currentView === "storefront" && currentViewParams && currentViewParams.vendorId;
      var btn = vid && document.querySelector("#app .storefront-avatar-button"), g = vid && liveFor(vid);
      if (btn) { btn.classList.toggle("lvst-sf-live", !!g); btn.classList.toggle("lvst-sf-seen", !!g && !g.unseen); if (g) btn.setAttribute("data-lvst", vid); else btn.removeAttribute("data-lvst"); }
    } catch (_) {}
    // the shop's own profile page: its picture shows the ring when it has a live update
    try {
      var mine = typeof vendor !== "undefined" && vendor && vendor.id, av = mine && document.querySelector("#app .vendor-profile-header-avatar, #app .vendor-profile-header-avatar-row .avatar-circle");
      if (av) { var og = liveFor(vendor.id), ho = av.closest("span,div") || av; var host2 = av.parentElement && av.parentElement.classList.contains("vendor-profile-header-avatar-row") ? av : av; host2.classList.toggle("lvst-chat-live", !!og); host2.classList.toggle("lvst-sf-seen", !!og && !og.unseen); if (og) host2.setAttribute("data-lvst", vendor.id); else host2.removeAttribute("data-lvst"); }
    } catch (_) {}
    // chat list rows (the shop is the other side for a buyer)
    document.querySelectorAll("#app .conv-list-item[data-conversation-id]").forEach(function (row) {
      var c = (window.__conversations || []).filter(function (x) { return x.conversation_id === row.getAttribute("data-conversation-id"); })[0];
      var av = row.querySelector(".avatar-circle, img, .avatar-fallback, [class*='avatar']");
      if (!c || !c.vendor_id || !av) return;
      var g = liveFor(c.vendor_id), host = av.closest("button,span,div") || av;
      if (host === row || host.querySelector("strong,b,h3,h4,small,p")) host = av;
      host.classList.toggle("lvst-chat-live", !!g); host.classList.toggle("lvst-sf-seen", !!g && !g.unseen);
      if (g) host.setAttribute("data-lvst", c.vendor_id); else host.removeAttribute("data-lvst");
    });
  }
  // A shop's own picture on its storefront does two things (like WhatsApp): a small sheet asks "view updates" or "view profile picture".
  function chooseStatusOrPicture(el) {
    var vid = el.getAttribute("data-lvst"), old = document.getElementById("lvspSheet"); if (old) old.remove();
    var w = document.createElement("div"); w.id = "lvspSheet"; w.className = "lvsp";
    w.innerHTML = '<div class="lvsp-bd"></div><div class="lvsp-card" role="dialog" aria-label="Profile picture"><span class="lvsp-handle"></span>' +
      '<button type="button" data-a="updates"><i class="fa-solid fa-circle-play"></i><span>View updates</span></button>' +
      '<button type="button" data-a="picture"><i class="fa-regular fa-image"></i><span>View profile picture</span></button></div>';
    document.body.appendChild(w);
    var close = function () { w.remove(); document.removeEventListener("keydown", key); };
    var key = function (ev) { if (ev.key === "Escape") close(); };
    document.addEventListener("keydown", key);
    w.addEventListener("click", function (ev) {
      var b = ev.target.closest("button[data-a]");
      if (!b) { if (ev.target.classList.contains("lvsp-bd")) close(); return; }
      var a = b.getAttribute("data-a"); close();
      if (a === "updates") openViewer(vid);
      else { window.__lvstBypass = true; try { el.click(); } finally { window.__lvstBypass = false; } }
    });
  }
  document.addEventListener("click", function (e) {
    if (window.__lvstBypass) return;
    var el = e.target.closest && e.target.closest("[data-lvst]"); if (!el) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    if (el.classList.contains("storefront-avatar-button")) chooseStatusOrPicture(el); else openViewer(el.getAttribute("data-lvst"));
  }, true);
  // search results: shop rows/cards get the ring too
  function decorateSearch() {
    document.querySelectorAll("#app [data-vendor-id], #app [onclick*=\"storefront\"]").forEach(function (row) {
      if (row.closest("#lvStStrip,.vd-page,.lvst-v")) return;
      var vid = row.getAttribute("data-vendor-id"); if (!vid) { var m = /vendorId:'([0-9a-f-]{36})'/.exec(row.getAttribute("onclick") || ""); vid = m && m[1]; }
      if (!vid) return;
      var av = row.querySelector(".avatar-circle, img, [class*='avatar'], [class*='logo'], .vd-initials"); if (!av) return;
      var host = av.closest("span,div,button") || av, g = liveFor(vid);
      // the ring belongs on the little picture only: when the picture sits straight in the row (like the Hall of fame), the nearest box is the
      // whole row, and the ring was drawn as a big oval around the shop's name and points
      if (host === row || host.querySelector("strong,b,h3,h4,small,p,button")) host = av;
      host.classList.toggle("lvst-chat-live", !!g); host.classList.toggle("lvst-sf-seen", !!g && !g.unseen);
    });
  }
  var dt = 0; new MutationObserver(function () { if (dt) return; dt = setTimeout(function () { dt = 0; decorate(); try { decorateSearch(); } catch (_) {} }, 150); }).observe(document.documentElement, { childList: true, subtree: true });
})();

/* ===== Vendors page: one clear row per shop (logo, name, rating, place, a peek of products, Follow) ===== */
(function () {
  "use strict";
  var peekCache = {}, pending = 0;
  function E(s) { return typeof esc === "function" ? esc(s) : String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  async function fetchPeeks(ids) {
    var need = ids.filter(function (i) { return !(i in peekCache); }); if (!need.length) return;
    need.forEach(function (i) { peekCache[i] = null; });
    // one small request per shop, so a shop with hundreds of products cannot crowd the others out
    await Promise.all(need.map(async function (id) {
      try {
        var r = await sb.from("products").select("photos").eq("vendor_id", id).eq("status", "active").order("created_at", { ascending: false }).limit(6);
        if (r && r.error) { delete peekCache[id]; return; }
        peekCache[id] = ((r && r.data) || []).map(function (p) { return p.photos && p.photos[0]; }).filter(Boolean);
      } catch (_) { delete peekCache[id]; }
    }));
  }
  async function dress() {
    var grid = document.getElementById("vendorsGrid"); if (!grid || grid.classList.contains("vendors-list-mode") && false) return;
    var page = grid.closest(".vd-page"); if (page && !page.querySelector(".lv-vd-title")) { var h = document.createElement("h2"); h.className = "lv-vd-title"; h.textContent = "Updates"; var strip = page.querySelector(".lvst-strip"); if (strip) strip.before(h); else page.prepend(h); }
    var cards = [].slice.call(grid.querySelectorAll(".vc2[data-vendor-id]"));
    if (!cards.length) return;
    await fetchPeeks(cards.map(function (c) { return c.getAttribute("data-vendor-id"); }));
    cards.forEach(function (c) {
      if (c.querySelector(".lv-peek")) return;
      var ph = peekCache[c.getAttribute("data-vendor-id")]; if (!ph || !ph.length) return;
      var body = c.querySelector(".vc2-body"); if (!body) return;
      body.insertAdjacentHTML("beforeend", '<div class="lv-peek">' + ph.slice(0, 3).map(function (u) { return '<img src="' + E(u) + '" alt="" loading="lazy" onerror="this.remove()">'; }).join("") + (ph.length > 3 ? "<span>+" + (ph.length - 3) + "</span>" : "") + "</div>");
    });
  }
  var t = 0;
  new MutationObserver(function () { if (t) return; t = requestAnimationFrame(function () { t = 0; dress(); }); }).observe(document.documentElement, { childList: true, subtree: true });
})();

/* ===== Vendors page, final layout: Near you strip, "All shops" header with Sort, floating Map button ===== */
(function () {
  "use strict";
  var LABEL = { rated: "Top rated", closest: "Nearest", alphabetical: "A to Z", shuffled: "Mixed" };
  function E(x) { return typeof esc === "function" ? esc(x) : String(x == null ? "" : x).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function pic(v) { return v.profile_avatar_url || v.avatar_url || v.logo_url || ""; }
  function nearList() {
    var all = (window.__filteredVendors || []).filter(function (v) { return v && v.id; }), loc = typeof buyerLocation !== "undefined" ? buyerLocation : null, hav = typeof haversineKm === "function" ? haversineKm : null;
    var withD = all.map(function (v) { var d = loc && hav && v.lat != null && v.lng != null ? hav(loc.lat, loc.lng, v.lat, v.lng) : null; return { v: v, d: d }; });
    var near = withD.filter(function (x) { return x.d != null; }).sort(function (a, b) { return a.d - b.d; });
    if (near.length) return near.slice(0, 10);
    // no location yet: shops from the shopper's own campus first, then the best rated
    var cid = typeof profile !== "undefined" && profile && profile.campus_id;
    var pool = withD.slice().sort(function (a, b) { return ((cid && b.v.campus_id === cid) - (cid && a.v.campus_id === cid)) || (Number(b.v.avg_rating || 0) - Number(a.v.avg_rating || 0)); });
    return pool.slice(0, 10);
  }
  function dist(d) { return d == null ? "" : d < 1 ? Math.round(d * 1000) + " m" : d.toFixed(1) + " km"; }
  function build() {
    var grid = document.getElementById("vendorsGrid"); if (!grid) return;
    var page = grid.closest(".vd-page"); if (!page || page.dataset.lvFinal === "map") return;
    var mapMode = !document.getElementById("vendorsMapWrap") || !document.getElementById("vendorsMapWrap").classList.contains("hidden");
    var list = nearList();
    var near = document.getElementById("lvNear");
    if (!near) { near = document.createElement("section"); near.id = "lvNear"; near.className = "lv-near"; grid.before(near); }
    var head = document.getElementById("lvAllHead");
    if (!head) { head = document.createElement("div"); head.id = "lvAllHead"; head.className = "lv-sec"; grid.before(head); }
    var nh = list.length ? '<div class="lv-sec"><b>Near you</b><button type="button" data-lvmap>See map</button></div><div class="lv-near-row">' + list.map(function (x) { var u = pic(x.v); return '<button type="button" class="lv-nc" onclick="navigate(\'storefront\',{vendorId:\'' + E(x.v.id) + '\'})">' + (u ? '<img src="' + E(u) + '" alt="" loading="lazy" onerror="this.remove()">' : '<span class="lv-nc-i">' + E(String(x.v.business_name || "?").charAt(0).toUpperCase()) + "</span>") + "<b>" + E(x.v.business_name) + "</b><small>" + (x.d != null ? dist(x.d) : E(x.v.city || "Lagos")) + "</small></button>"; }).join("") + "</div>" : '<div class="lv-sec"><b>Near you</b><button type="button" data-lvmap>See map</button></div><div class="lv-near-row">' + [1, 2, 3, 4].map(function () { return '<span class="lv-nc sk"></span>'; }).join("") + "</div>";
    if (near.__h !== nh) { near.__h = nh; near.innerHTML = nh; }
    var hh = "<b>All shops</b><button type=\"button\" data-lvsort>Sort: " + E(LABEL[window.__lvVdSort || "rated"]) + " ▾</button>";
    if (head.__h !== hh) { head.__h = hh; head.innerHTML = hh; }
   
  }
  function cleanup() {}
  document.addEventListener("click", function (e) {
    if (e.target.closest("[data-lvmap]")) { e.preventDefault(); try { navigate("vendorsMap"); } catch (_) {} return; }
    if (e.target.closest("[data-lvsort]") && typeof lvSheet === "function") {
      var go = function (m) { return function () { window.__lvVdSort = m; try { setVendorDirectorySort(m); } catch (_) {} setTimeout(build, 50); }; };
      lvSheet("Sort shops", "", [{ label: "Top rated", icon: "fa-star", run: go("rated") }, { label: "Nearest to me", icon: "fa-location-dot", run: go("closest") }, { label: "A to Z", icon: "fa-arrow-down-a-z", run: go("alphabetical") }, { label: "Mixed", icon: "fa-shuffle", run: go("shuffled") }]);
    }
  });
  var t = 0;
  new MutationObserver(function () { if (t) return; t = requestAnimationFrame(function () { t = 0; try { build(); cleanup(); } catch (_) {} }); }).observe(document.documentElement, { childList: true, subtree: true });
})();

/* ===== Photo viewer for request photos and verification documents: one picture at a time, with names (ID card / Biodata / Selfie) ===== */
(function () {
  "use strict";
  function E(s) { return typeof esc === "function" ? esc(s) : String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  window.reqPhotoOpen = function (k, i) {
    var l = (window.__reqPhotoSets || [])[k] || []; if (!l.length) return;
    var labels = l.labels || [], at = Math.max(0, Math.min(l.length - 1, Number(i) || 0));
    var w = document.createElement("div"); w.className = "req-lightbox lvpv";
    w.innerHTML = '<button type="button" class="x" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>' +
      (labels.length > 1 ? '<div class="lvpv-tabs">' + l.map(function (u, n) { return '<button type="button" data-n="' + n + '">' + E(labels[n] || "Photo " + (n + 1)) + "</button>"; }).join("") + "</div>" : "") +
      '<div class="lvpv-stage"><button type="button" class="lvpv-nav prev" aria-label="Previous"><i class="fa-solid fa-chevron-left"></i></button><img alt=""><button type="button" class="lvpv-nav next" aria-label="Next"><i class="fa-solid fa-chevron-right"></i></button></div><div class="n"></div>';
    document.body.appendChild(w);
    var img = w.querySelector("img");
    function show(n) {
      at = (n + l.length) % l.length; img.src = l[at];
      w.querySelector(".n").textContent = (labels[at] ? labels[at] + " · " : "") + (at + 1) + " / " + l.length;
      [].forEach.call(w.querySelectorAll(".lvpv-tabs button"), function (b) { b.classList.toggle("on", +b.getAttribute("data-n") === at); });
      w.classList.toggle("single", l.length < 2);
    }
    show(at);
    w.addEventListener("click", function (e) {
      var t = e.target.closest("[data-n]"); if (t) { show(+t.getAttribute("data-n")); return; }
      if (e.target.closest(".prev")) { show(at - 1); return; }
      if (e.target.closest(".next")) { show(at + 1); return; }
      if (e.target === w || e.target.closest(".x") || e.target.classList.contains("lvpv-stage")) w.remove();
    });
    var x0 = null;
    w.addEventListener("touchstart", function (e) { x0 = e.touches[0].clientX; }, { passive: true });
    w.addEventListener("touchend", function (e) { if (x0 == null) return; var dx = e.changedTouches[0].clientX - x0; x0 = null; if (Math.abs(dx) > 50 && l.length > 1) show(at + (dx < 0 ? 1 : -1)); }, { passive: true });
  };
})();

/* ===== Order page: the main buttons (Pay, I've received it, Cancel, ask for a refund) live in one dock that stays on screen ===== */
(function () {
  "use strict";
  var raf = 0;
  function dock() {
    var bar = document.querySelector("#app .od-bottom-bar"), main = document.querySelector("#app .od-action-wrap");
    if (!bar && !main) return;
    var d = document.querySelector("#app .od-dock");
    if (!d) { d = document.createElement("div"); d.className = "od-dock"; (bar || main).before(d); }
    if (main && main.parentNode !== d) d.appendChild(main);
    if (bar && bar.parentNode !== d) d.appendChild(bar);
    var empty = !d.querySelector("button,a");
    d.classList.toggle("od-dock-empty", empty);
    // the dock floats above the tab bar, so the page gets room under its last line
    var sp = d.nextElementSibling && d.nextElementSibling.classList.contains("od-dock-sp") ? d.nextElementSibling : null;
    if (!sp) { sp = document.createElement("div"); sp.className = "od-dock-sp"; d.after(sp); }
    sp.style.height = empty ? "0" : Math.ceil(d.getBoundingClientRect().height + 16) + "px";
  }
  new MutationObserver(function () { if (!raf) raf = requestAnimationFrame(function () { raf = 0; try { dock(); } catch (_) {} }); }).observe(document.documentElement, { childList: true, subtree: true });
})();

/* ===== "What's new" tour: everyone who already uses the app sees it once, with Levi pointing at the new things ===== */
(function () {
  "use strict";
  var KEY = "lv-whatsnew-seen", VER = "2026-11", tries = 0;
  function seen() { try { return localStorage.getItem(KEY) === VER; } catch (_) { return true; } }
  function mark() { try { localStorage.setItem(KEY, VER); } catch (_) {} }
  var VENDORS_TAB = "#bottomNav .bottom-nav-item[onclick*=\"'vendors'\"]";
  function panelOpen() { var p = document.getElementById("profilePanel"); if (!p) return false; var r = p.getBoundingClientRect(); return r.width > 0 && r.right > 30 && r.left < innerWidth - 30; }
  async function openPanelOn(label) {
    try { if (!panelOpen()) toggleProfilePanel(); } catch (_) {}
    await new Promise(function (ok) { setTimeout(ok, 450); });
    try { var row = document.querySelector('#profilePanel .lv-pp-row[data-lbl="' + label + '"]'); if (row) row.scrollIntoView({ block: "center" }); } catch (_) {}
  }
  function steps() {
    var isVendor = false; try { isVendor = !!(typeof vendor !== "undefined" && vendor && vendor.id); } catch (_) {}
    var closePanel = function () { try { closeAllPanels(); } catch (_) {} };
    var out = [
      { icon: "fa-wand-magic-sparkles", title: "What's new on Levromart", body: "A quick look at what we added. This shows only once.", selector: null },
      { icon: "fa-bullhorn", title: "Updates from shops you follow", body: "Photos and offers from the shops you follow, like WhatsApp Updates. New ones come first, and a green number shows on the Vendors tab.", view: "vendors", selector: "#lvStStrip", onEnter: closePanel },
      { icon: "fa-location-crosshairs", title: "Shops near you", body: "The closest shops come first. Slide sideways to see more.", view: "vendors", selector: "#lvNear" },
      { icon: "fa-map-location-dot", title: "Open the map", body: "Tap the floating 3D pin any time to see shops on the map.", view: "vendors", selector: "#lvMapFab" },
      { icon: "fa-receipt", title: "Orders are easier", body: "Pay, cancel, ask for a refund or say you received it from the buttons that stay at the bottom of every order.", selector: "#bottomNav .bottom-nav-item[onclick*=\"Orders\"]" },
      { icon: "fa-wallet", title: "A faster wallet", body: "Send money with your PIN, add money, and share a receipt in a style you like.", view: isVendor ? "vendorDashboard" : "buyerProfile", selector: ".lvw-card" }
    ];
    if (isVendor) {
      out.push({ icon: "fa-circle-plus", title: "Post an update", body: "Tap the + on Your update, pick a product, choose a style (even an animated advert) and share it for 24 hours. You can see who viewed and liked it.", view: "vendors", selector: ".lvu-card.own" });
      out.push({ icon: "fa-building", title: "Businesses", body: "Run up to 5 businesses with one login and switch between them here.", selector: '#profilePanel .lv-pp-row[data-lbl="Businesses"]', onEnter: function () { return openPanelOn("Businesses"); } });
      out.push({ icon: "fa-people-group", title: "Your team", body: "Invite managers and staff. Managers can manage listings, staff handle orders and chats.", selector: '#profilePanel .lv-pp-row[data-lbl="Team"]', onEnter: function () { return openPanelOn("Team"); } });
    }
    out.push({ icon: "fa-heart", title: "Your wishlist", body: "Everything you saved is here, for customers and vendors alike.", selector: '#profilePanel .lv-pp-row[data-lbl="Wishlist"]', onEnter: function () { return openPanelOn("Wishlist"); }, onExit: closePanel });
    if (isVendor) out.push({ icon: "fa-hourglass-half", title: "Order time limit", body: "Choose how long you wait before an order cancels itself. The hourglass on each order shows the time left.", selector: null, onEnter: closePanel });
    return out;
  }
  function tick() {
    if (seen()) return;
    tries++;
    try {
      if (typeof localStorage !== "undefined" && !localStorage.getItem("levromart-tour-seen")) { mark(); return; }   // brand new: the full tour already covers everything
      var busy = (typeof dismissibleModalId !== "undefined" && dismissibleModalId) || (function () { var o = document.getElementById("lvOnb"), m = document.getElementById("loginModal"); return (o && !o.hidden) || (m && !m.classList.contains("hidden")) || document.querySelector(".modal:not(.hidden):not(#loginModal), #lvTour:not(.hidden)"); })() || document.body.classList.contains("tour-active");
      var ready = typeof showTour === "function";
      if (ready && !busy && !document.hidden) { mark(); showTour(steps()); return; }
    } catch (_) {}
    if (tries < 40) setTimeout(tick, 4000);
  }
  setTimeout(tick, 9000);
})();

/* ===== Admin pages: Login logs, Finance and Inventory get pictures, groups, and CSV / print-ready PDF with the Levromart letter-head ===== */
(function () {
  "use strict";
  function E(s) { return typeof esc === "function" ? esc(s) : String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  var TONES = ["#16a34a", "#2563eb", "#7c3aed", "#ea580c", "#db2777", "#0891b2", "#ca8a04", "#4f46e5"];
  function tone(k) { var h = 0, s = String(k || "?"); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return TONES[h % TONES.length]; }
  var ICONS = [[/fashion|cloth|beauty|hair|jewel|perfume|bag/i, "fa-shirt"], [/food|grocer|snack|drink|bever|bak/i, "fa-utensils"], [/tech|phone|gadget|electr|laptop/i, "fa-laptop"], [/book|stationer|school|educat/i, "fa-book"], [/service|repair|clean|tutor/i, "fa-screwdriver-wrench"], [/home|furnit|kitchen|decor/i, "fa-couch"], [/health|pharm|care/i, "fa-heart-pulse"], [/gift|art|craft/i, "fa-gift"]];
  function iconFor(name) { for (var i = 0; i < ICONS.length; i++) if (ICONS[i][0].test(name || "")) return ICONS[i][1]; return "fa-box"; }
  window.lvInvIconHtml = function (sector) { return '<span class="inv-ic" style="background:' + tone(sector) + '"><i class="fa-solid ' + iconFor(sector) + '"></i></span>'; };
  window.lvInvIcon = function (sector) { var t = document.createElement("template"); t.innerHTML = window.lvInvIconHtml(sector); return t.content.firstChild; };
  function avatar(url, name) {
    var ini = E(String(name || "?").trim().charAt(0).toUpperCase() || "?");
    return '<span class="adm-av" style="background:' + tone(name) + '">' + (url ? '<img src="' + E(url) + '" alt="" loading="lazy" onerror="this.remove()">' : "") + "<b>" + ini + "</b></span>";
  }
  /* letter-head + diagonal watermark for printed pages */
  window.lvLetterhead = function (title) {
    var css = '<style>@page{margin:14mm}body{position:relative}.lh{display:flex;align-items:center;gap:14px;border-bottom:3px solid #16a34a;padding-bottom:10px;margin-bottom:6px}.lh .lg{width:46px;height:46px;border-radius:14px;background:linear-gradient(145deg,#2bbb7d,#0e7a4e);display:grid;place-items:center}.lh h1{margin:0;font-size:22px;color:#0e7a4e}.lh small{color:#5c7269;display:block}.wm{position:fixed;left:0;right:0;top:38%;text-align:center;font-size:96px;font-weight:900;letter-spacing:.2em;color:rgba(22,163,74,.08);transform:rotate(-28deg);pointer-events:none;z-index:0}table,.stats{position:relative;z-index:1}tr{page-break-inside:avoid}thead{display:table-header-group}</style>';
    var logo = '<svg viewBox="0 0 64 64" width="30" height="30"><g fill="none" stroke="#fff" stroke-width="5.4" stroke-linecap="round"><path d="M22 20a17 17 0 0 0 0 24"/><path d="M42 44a17 17 0 0 0 0-24"/></g><circle cx="32" cy="32" r="6" fill="#fff"/></svg>';
    return { css: css, head: '<div class="wm">LEVROMART</div><div class="lh"><span class="lg">' + logo + '</span><div><h1>Levromart · ' + E(title) + '</h1><small>Generated ' + E(new Date().toLocaleString()) + "</small></div></div>" };
  };
  function csvCell(v) { var t = String(v == null ? "" : v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; }
  window.lvDownloadCsv = function (name, headers, rows) {
    var text = "﻿" + [headers].concat(rows).map(function (r) { return r.map(csvCell).join(","); }).join("\r\n");
    var a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  };
  window.lvPrintTable = function (title, headers, rows, sub) {
    var w = window.open("", "_blank"); if (!w) { showToast("Please allow pop-ups to export the PDF.", "error"); return; }
    var lh = window.lvLetterhead(title);
    w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Levromart ' + E(title) + "</title>" + lh.css + '<style>body{font-family:-apple-system,"Segoe UI",Roboto,sans-serif;color:#0d201c;padding:1.2rem}table{width:100%;border-collapse:collapse;margin-top:1rem;font-size:.82rem}th,td{padding:.45rem .55rem;text-align:left;border-bottom:1px solid #e2e8f0}th{background:#f3f8f7}</style></head><body>' + lh.head + (sub ? '<p style="color:#5c7269">' + E(sub) + "</p>" : "") + "<table><thead><tr>" + headers.map(function (h) { return "<th>" + E(h) + "</th>"; }).join("") + "</tr></thead><tbody>" + rows.map(function (r) { return "<tr>" + r.map(function (c) { return "<td>" + E(c) + "</td>"; }).join("") + "</tr>"; }).join("") + "</tbody></table><scr" + "ipt>window.onload=function(){window.print()}<\/script></body></html>");
    w.document.close();
  };
  function exportBar(csvFn, pdfFn) { return '<span class="adm-exp"><button type="button" class="fin-icbtn" title="Download CSV" aria-label="Download CSV" data-lvcsv><i class="fa-solid fa-file-csv"></i></button><button type="button" class="fin-icbtn" title="Print or save as PDF" aria-label="PDF" data-lvpdf><i class="fa-solid fa-file-pdf"></i></button></span>'; }

  /* ---- Login logs / admin activity ---- */
  var ACTION = { approve_vendor: ["approved vendor", "fa-circle-check", "ok"], reject_vendor: ["rejected vendor", "fa-circle-xmark", "bad"], pause_storefront: ["paused storefront", "fa-pause", "warn"], reactivate_storefront: ["reactivated storefront", "fa-play", "ok"], suspend_user: ["suspended account", "fa-user-slash", "bad"], unsuspend_user: ["reinstated account", "fa-user-check", "ok"], promote_admin: ["promoted to admin", "fa-user-shield", "warn"], demote_admin: ["removed admin access", "fa-user-minus", "bad"] };
  var logRows = [];
  window.renderAdminLog = async function () {
    if (!session || typeof isSuperAdmin !== "function" || !isSuperAdmin()) return '<div class="empty-state">Access denied.</div>';
    var r = await sb.from("admin_actions").select("*").order("created_at", { ascending: false }).limit(300);
    var log = (r && r.data) || []; logRows = log;
    var html = '<h2><i class="fa-solid fa-clock-rotate-left"></i> Admin activity log</h2>' + adminNavHtml("adminLog");
    if (!log.length) return html + '<div class="empty-state"><i class="fa-regular fa-clock"></i><b>Nothing logged yet</b></div>';
    html += '<div class="adm-bar"><input type="search" placeholder="Search the log…" oninput="lvLogFilter(this.value)">' + exportBar() + "</div>";
    var byDate = {}, order = [];
    log.forEach(function (e) { var k = new Date(e.created_at).toLocaleDateString("en-NG", { weekday: "short", year: "numeric", month: "short", day: "numeric" }); if (!byDate[k]) { byDate[k] = []; order.push(k); } byDate[k].push(e); });
    html += '<div id="lvLogList">' + order.map(function (k) {
      return '<div class="adm-day">' + E(k) + "</div>" + byDate[k].map(function (e) {
        var m = ACTION[e.action] || [String(e.action || "").replace(/_/g, " "), "fa-circle-info", ""];
        return '<div class="adm-row" data-q="' + E((e.admin_name + " " + m[0] + " " + (e.target_label || "")).toLowerCase()) + '">' + avatar("", e.admin_name || "?") + '<div class="adm-main"><b>' + E(e.admin_name || "Admin") + '</b><span class="adm-pill ' + m[2] + '"><i class="fa-solid ' + m[1] + '"></i> ' + E(m[0]) + "</span><small>" + E(e.target_label || e.target_id || "") + '</small></div><time>' + E(new Date(e.created_at).toLocaleTimeString("en-NG", { hour: "numeric", minute: "2-digit" })) + "</time></div>";
      }).join("");
    }).join("") + "</div>";
    return html;
  };
  window.lvLogFilter = function (q) { q = String(q || "").toLowerCase(); document.querySelectorAll("#lvLogList .adm-row").forEach(function (r) { r.style.display = !q || r.getAttribute("data-q").indexOf(q) >= 0 ? "" : "none"; }); };
  function logTable() { return [["Date", "Time", "Admin", "Action", "Target"], logRows.map(function (e) { var m = ACTION[e.action] || [String(e.action || "")]; var d = new Date(e.created_at); return [d.toLocaleDateString("en-NG"), d.toLocaleTimeString("en-NG", { hour: "numeric", minute: "2-digit" }), e.admin_name || "", m[0], e.target_label || e.target_id || ""]; })]; }

  /* ---- Finance: picture, sector groups, exports ---- */
  var vendorMeta = null;
  async function regroupFinance() {
    var list = document.querySelector(".financeVendorsTableWrap"); if (!list || list.__lvG) return;
    var rows = [].slice.call(list.querySelectorAll(":scope > .fin-row")); if (!rows.length) return;
    list.__lvG = 1;
    if (!vendorMeta) {
      vendorMeta = {};
      try { var r = await sb.from("vendors").select("id,logo_url,sector:sectors(name)").is("deleted_at", null).limit(2000); ((r && r.data) || []).forEach(function (v) { vendorMeta[String(v.id)] = { logo: v.logo_url, sector: v.sector && v.sector.name }; }); } catch (_) {}
      window.__lvVendorMeta = vendorMeta;
    }
    if (!list.isConnected) return;
    var groups = {}, order = [];
    rows.forEach(function (r) {
      var id = r.getAttribute("data-vendor-id"), m = vendorMeta[id] || {}, nm = r.querySelector(".fin-name"), nmWrap = r.querySelector(".fin-nm");
      if (nmWrap && !nmWrap.querySelector(".adm-av")) nmWrap.insertAdjacentHTML("afterbegin", avatar(m.logo, nm ? nm.textContent : ""));
      var s = m.sector || "Other"; if (!groups[s]) { groups[s] = []; order.push(s); } groups[s].push(r);
    });
    order.sort(function (a, b) { return a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b); });
    var frag = document.createDocumentFragment();
    order.forEach(function (s) { var h = document.createElement("div"); h.className = "adm-day"; h.innerHTML = '<i class="fa-solid ' + iconFor(s) + '"></i> ' + E(s) + " · " + groups[s].length; frag.appendChild(h); groups[s].forEach(function (r) { frag.appendChild(r); }); });
    list.appendChild(frag);
    var bar = document.createElement("div"); bar.className = "adm-bar"; bar.innerHTML = '<span class="muted">Vendors by sector</span>' + exportBar(); list.before(bar);
    bar.__kind = "vendors";
  }
  function vendorTable() { var d = ((typeof __adminFinanceData !== "undefined" ? __adminFinanceData.vendors : []) || []).map(function (v) { var m = (window.__lvVendorMeta || {})[String(v.vendor_id)] || {}; return Object.assign({}, v, { sector_name: m.sector }); }); return [["Sector", "Vendor", "Verification", "Commission %", "Completed orders", "Collected", "Commission owed", "Status"], d.slice().sort(function (a, b) { return String(a.sector_name || "~").localeCompare(String(b.sector_name || "~")) || String(a.business_name).localeCompare(String(b.business_name)); }).map(function (v) { return [v.sector_name || "Other", v.business_name, v.verification_status, v.commission_pct, v.completed_orders, v.total_paid_in, v.commission_owed, v.commission_status]; })]; }
  /* ---- Inventory CSV ---- */
  window.lvInventoryCsv = function () {
    var all = window.__adminInventoryAll || []; if (!all.length) { showToast("No inventory to export yet.", "error"); return; }
    window.lvDownloadCsv("levromart-inventory.csv", ["Sector", "Category", "Product", "Vendor", "Price", "Status", "Quantity left", "Added"], all.slice().sort(function (a, b) { return String(a.sector_name).localeCompare(String(b.sector_name)) || String(a.name).localeCompare(String(b.name)); }).map(function (p) { return [p.sector_name, p.category_name, p.name, p.vendor_name, p.price, p.status, p.quantity_available, p.created_at ? new Date(p.created_at).toISOString().slice(0, 10) : ""]; }));
  };
  document.addEventListener("click", function (e) {
    var c = e.target.closest && e.target.closest("[data-lvcsv]"), p = e.target.closest && e.target.closest("[data-lvpdf]"); if (!c && !p) return;
    var bar = (c || p).closest(".adm-bar"), isLog = !!document.getElementById("lvLogList"), t = isLog ? logTable() : vendorTable(), title = isLog ? "Admin activity log" : "Vendors by sector";
    if (!isLog && !(bar && bar.__kind === "vendors")) return;
    e.preventDefault(); e.stopPropagation();
    if (c) window.lvDownloadCsv("levromart-" + title.toLowerCase().replace(/\W+/g, "-") + ".csv", t[0], t[1]); else window.lvPrintTable(title, t[0], t[1]);
  }, true);
  var raf = 0;
  new MutationObserver(function () { if (!raf) raf = requestAnimationFrame(function () { raf = 0; try { regroupFinance(); } catch (_) {} }); }).observe(document.body, { childList: true, subtree: true });
})();

/* ===== Admin: Orders (every shop's orders, so admins can nudge shops that have not answered) ===== */
(function () {
  "use strict";
  function E(s) { return typeof esc === "function" ? esc(s) : String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function money(n) { return "₦" + Number(n || 0).toLocaleString("en-NG", { maximumFractionDigits: 2 }); }
  function ref(id) { return "#" + String(id || "").slice(0, 8).toUpperCase(); }
  function age(iso) { var m = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000)); return m < 1 ? "just now" : m < 60 ? m + " min" : m < 1440 ? Math.floor(m / 60) + " h " + (m % 60) + " min" : Math.floor(m / 1440) + " d"; }
  function mins(iso) { return Math.round((Date.now() - new Date(iso)) / 60000); }
  var LABEL = { pending: "Waiting for the shop", confirmed: "Accepted", handed_over: "Out for delivery", completed: "Completed", cancelled: "Cancelled", disputed: "Disputed", payment_unresolved: "Payment check", returned: "Returned" };
  var tab = "pending", rows = [], timer = 0;
  var TABS = [["pending", "Pending", "fa-hourglass-half"], ["late", "Not answered (10+ min)", "fa-bell-slash"], ["active", "In progress", "fa-truck-fast"], ["all", "All recent", "fa-list"]];
  function pick(o) {
    if (tab === "pending") return o.status === "pending";
    if (tab === "late") return o.status === "pending" && mins(o.created_at) >= 10;
    if (tab === "active") return ["confirmed", "handed_over", "payment_unresolved", "disputed"].indexOf(o.status) >= 0;
    return true;
  }
  function card(o) {
    var v = o.vendor || {}, b = o.buyer || {}, items = o.items || [], first = items[0] && items[0].product, ph = first && first.photos && first.photos[0];
    var m = mins(o.created_at), hot = o.status === "pending" && m >= 10, phone = v.whatsapp_number || v.phone || "";
    var title = first ? first.name + (items.length > 1 ? " +" + (items.length - 1) + " more" : "") : "Order";
    var msg = "Hi " + (v.business_name || "there") + ", you have a new order on Levromart (" + ref(o.id) + ", " + money(o.total_amount) + ") waiting for you. Please open the app to accept it.";
    var wa = phone ? "https://wa.me/" + String(phone).replace(/\D/g, "").replace(/^0/, "234") + "?text=" + encodeURIComponent(msg) : "";
    return '<article class="aor' + (hot ? " hot" : "") + '" data-id="' + E(o.id) + '"><button type="button" class="aor-top" data-fold><span class="aor-ph">' + (ph ? '<img src="' + E(ph) + '" alt="" loading="lazy">' : '<i class="fa-solid fa-box"></i>') + '</span><span class="aor-main"><b>' + E(v.business_name || "Shop") + '</b><small>' + E(title) + " · " + money(o.total_amount) + '</small><small class="aor-age"><i class="fa-regular fa-clock"></i> ' + E(age(o.created_at)) + ' ago · ' + E(ref(o.id)) + '</small></span><span class="aor-st aor-st-' + E(o.status) + '">' + E(LABEL[o.status] || o.status) + '</span><i class="fa-solid fa-chevron-down aor-chev"></i></button>' +
      '<div class="aor-more"><div class="aor-grid"><div><small>Customer</small><b>' + E(b.name || "Customer") + '</b></div><div><small>Delivery</small><b>' + E((o.delivery_method === "delivery" ? "Delivery" : "Pickup") + (o.delivery_address ? " · " + o.delivery_address : "")) + '</b></div><div><small>Type</small><b>' + E(String(o.order_type || "sale")) + '</b></div><div><small>Shop phone</small><b>' + E(phone || "not listed") + "</b></div></div>" +
      '<div class="aor-items">' + items.map(function (i) { var p = i.product || {}; return '<div><span>' + E(p.name || "Item") + " × " + E(i.quantity) + "</span><b>" + money(Number(i.unit_price || 0) * Number(i.quantity || 1)) + "</b></div>"; }).join("") + '<div class="aor-tot"><span>Total</span><b>' + money(o.total_amount) + "</b></div></div>" +
      '<div class="aor-acts">' + (wa ? '<a class="aor-btn go" href="' + E(wa) + '" target="_blank" rel="noopener"><i class="fa-brands fa-whatsapp"></i> Tell the shop</a>' : "") + '<button type="button" class="aor-btn" data-copy="' + E(msg) + '"><i class="fa-regular fa-copy"></i> Copy message</button><button type="button" class="aor-btn" onclick="navigate(\'orderDetail\',{orderId:\'' + E(o.id) + '\'})"><i class="fa-solid fa-arrow-up-right-from-square"></i> Open order</button></div></div></article>';
  }
  function paint() {
    var host = document.getElementById("aorList"); if (!host) return;
    var list = rows.filter(pick);
    document.querySelectorAll(".aor-tab").forEach(function (b) { b.classList.toggle("on", b.dataset.t === tab); var c = b.querySelector("i.aor-n"); if (c) c.textContent = rows.filter(function (o) { var t = tab; tab = b.dataset.t; var r = pick(o); tab = t; return r; }).length; });
    host.innerHTML = list.length ? list.map(card).join("") : '<div class="adp-empty"><i class="fa-solid fa-circle-check"></i><strong>' + (tab === "all" ? "No orders yet" : "Nothing waiting here") + "</strong></div>";
  }
  async function load() {
    var r = await sb.from("orders").select("id,status,order_type,total_amount,delivery_method,delivery_address,created_at,buyer:users(name),vendor:vendors(id,business_name,phone,whatsapp_number),items:order_items(quantity,unit_price,product:products(name,photos))").order("created_at", { ascending: false }).limit(200);
    if (r && !r.error && Array.isArray(r.data)) { rows = r.data; paint(); }
    return r;
  }
  window.renderAdminOrders = async function () {
    if (!session || !profile || profile.role !== "admin") return '<div class="empty-state">Access denied.</div>';
    var r = await load();
    var head = '<h2><i class="fa-solid fa-clipboard-list"></i> Orders</h2>' + adminNavHtml("adminOrders");
    if (r && r.error) return head + errorStateHtml(r.error);
    var tabs = '<div class="adp-tabs aor-tabs" role="tablist">' + TABS.map(function (t) { return '<button type="button" role="tab" class="adp-tab aor-tab' + (t[0] === tab ? " on" : "") + '" data-t="' + t[0] + '"><span class="fa-solid ' + t[2] + '"></span> ' + t[1] + ' <i class="aor-n"></i></button>'; }).join("") + "</div>";
    clearInterval(timer); timer = setInterval(function () { if (document.getElementById("aorList") && !document.hidden) load(); else if (!document.getElementById("aorList")) clearInterval(timer); }, 45000);
    setTimeout(paint, 0);
    return head + '<div class="adp">' + tabs + '<p class="aor-hint">New orders appear here at once. If a shop has not answered, tap the order and send it a message.</p><div id="aorList"></div></div>';
  };
  document.addEventListener("click", function (e) {
    var t = e.target.closest && e.target.closest(".aor-tab"); if (t) { tab = t.dataset.t; paint(); return; }
    var f = e.target.closest && e.target.closest("[data-fold]"); if (f) { f.closest(".aor").classList.toggle("open"); return; }
    var c = e.target.closest && e.target.closest("[data-copy]"); if (c) { var txt = c.getAttribute("data-copy"); try { navigator.clipboard.writeText(txt).then(function () { showToast("Message copied.", "success"); }); } catch (_) { showToast("Could not copy.", "error"); } }
  });
})();

/* ===== Vendors map: the open shop card shows "Online now" or "Last seen ..." ===== */
(function () {
  "use strict";
  var cache = {}, raf = 0;
  function line(on, at) {
    if (on) return '<span class="sf-pdot on"></span>Online now';
    var ago = at && typeof timeAgo === "function" ? timeAgo(at) : "";
    return ago ? '<span class="sf-pdot"></span>Last seen ' + ago : "";
  }
  function dress() {
    var box = document.getElementById("vmpExpandedCard"); if (!box || box.classList.contains("hidden")) return;
    var m = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(box.innerHTML); if (!m) return;
    var id = m[0], cur = box.querySelector(".sf-presence");
    if (cur && cur.getAttribute("data-v") === id) return;
    if (cur) cur.remove();
    try { if (typeof isOwnVendorId === "function" && isOwnVendorId(id)) return; } catch (_) {}
    var el = document.createElement("div"); el.className = "sf-presence vmp-presence"; el.setAttribute("data-v", id); el.hidden = true;
    var anchor = box.querySelector("h3,h4,strong,b"); if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(el, anchor.nextSibling); else box.prepend(el);
    var paint = function (d) { var h = d ? line(d.online, d.last_seen_at) : ""; el.innerHTML = h; el.hidden = !h; };
    var c = cache[id]; if (c && Date.now() - c.at < 60000) return paint(c.d);
    Promise.resolve(sb.rpc("get_shop_presence", { p_vendor_id: id })).then(function (r) { var d = r && r.data; if (d && Array.isArray(d)) d = d[0]; cache[id] = { at: Date.now(), d: d }; paint(d); }).catch(function () {});
  }
  new MutationObserver(function () { if (!raf) raf = requestAnimationFrame(function () { raf = 0; try { dress(); } catch (_) {} }); }).observe(document.body, { childList: true, subtree: true });
})();

/* ===== Updates page top bar: your picture, a search bar for updates and shops, and a pen to manage your updates ===== */
(function () {
  "use strict";
  var raf = 0;
  function onVendors() { return document.body.getAttribute("data-view") === "vendors" || !!document.querySelector("#app .vd-page"); }
  function ensure() {
    var btn = document.querySelector(".header-search-row"); if (!btn) return;
    var inp = document.getElementById("lvVdSearch");
    if (!inp) {
      inp = document.createElement("input"); inp.id = "lvVdSearch"; inp.type = "search"; inp.className = "lv-vd-search"; inp.placeholder = "Search updates and shops"; inp.setAttribute("aria-label", "Search updates and shops"); inp.autocomplete = "off";
      btn.insertAdjacentElement("afterend", inp);
      inp.addEventListener("input", function () {
        var q = inp.value.trim().toLowerCase(), g = document.getElementById("vendorSearchInput");
        if (g) { g.value = inp.value; try { filterVendorsDirectory(); } catch (_) {} }
        document.querySelectorAll("#lvStStrip .lvu-card:not(.lvu-all)").forEach(function (c) { var n = (c.textContent || "").toLowerCase(); c.style.display = !q || n.indexOf(q) >= 0 || c.classList.contains("own") ? "" : "none"; });
        document.querySelectorAll("#lvNear .lv-nc").forEach(function (c) { c.style.display = !q || (c.textContent || "").toLowerCase().indexOf(q) >= 0 ? "" : "none"; });
      });
    }
    var pen = document.getElementById("lvVdPen");
    var isVendor = false; try { isVendor = !!(typeof vendor !== "undefined" && vendor && vendor.id); } catch (_) {}
    // signed in but the account is still loading: leave the pen and the layout as they are, never flip a shop into a customer for a moment
    try { if (!isVendor && typeof session !== "undefined" && session && typeof profile !== "undefined" && !profile && pen) return; } catch (_) {}
    if (!pen) {
      var right = document.querySelector(".header-right"); if (!right) return;
      pen = document.createElement("button"); pen.type = "button"; pen.id = "lvVdPen"; pen.className = "icon-btn lv-vd-pen"; pen.setAttribute("aria-label", "My updates"); pen.title = "My updates"; pen.innerHTML = '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H7.5A3.5 3.5 0 0 0 4 7.5v9A3.5 3.5 0 0 0 7.5 20h9a3.5 3.5 0 0 0 3.5-3.5V13"/><path d="M18.4 3.6a1.9 1.9 0 0 1 2.7 2.7l-8.1 8.1-3.6.9.9-3.6z" fill="currentColor" fill-opacity=".14"/></svg>';
      pen.onclick = function () { try { window.lvStatusOpen(); } catch (_) {} };
      right.prepend(pen);
    }
    pen.hidden = !isVendor;
    var on = onVendors();
    document.body.classList.toggle("lv-vd-bar", on);
    document.body.classList.toggle("lv-vd-cust", on && !isVendor);   // shoppers get the cart beside the search bar; shops get "add a status"
    if (!on && inp.value) { inp.value = ""; }
  }
  new MutationObserver(function () { if (!raf) raf = requestAnimationFrame(function () { raf = 0; try { ensure(); } catch (_) {} }); }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-view"] });
  // scrolling down slides the bar away so it never covers the list; scrolling up (or reaching the top) brings it back
  var lastY = 0;
  window.addEventListener("scroll", function () {
    var y = window.pageYOffset || document.documentElement.scrollTop || 0, b = document.body;
    if (!b.classList.contains("lv-vd-bar")) { b.classList.remove("lv-vd-away"); lastY = y; return; }
    if (y > lastY + 6 && y > 60) b.classList.add("lv-vd-away"); else if (y < lastY - 6 || y < 30) b.classList.remove("lv-vd-away");
    lastY = y;
  }, { passive: true });
})();
