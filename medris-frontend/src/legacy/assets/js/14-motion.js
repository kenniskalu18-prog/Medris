/* ---- app-like motion: pages slide/fade in, and a re-render that changes nothing no longer wipes and redraws the screen ---- */
(function(){
  "use strict";
  var app=document.getElementById("app"); if(!app) return;
  var desc=Object.getOwnPropertyDescriptor(Element.prototype,"innerHTML"); if(!desc||!desc.set) return;
  var reduce=false; try{ reduce=window.matchMedia("(prefers-reduced-motion: reduce)").matches; }catch(_){}
  var TABS={home:1,vendors:1,search:1,notifications:1,vendorOrders:1,buyerOrders:1,buyerProfile:1,vendorDashboard:1,requestEquipment:1,vendorRequests:1,cart:1,wishlist:1,messages:1};
  var last={html:null,gen:-1,view:null}, goingBack=false, animTimer=null;
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
        if(document.hidden||Date.now()<homeCarouselResumeAt) return;
        var r=vp.getBoundingClientRect(); if(r.bottom<0||r.top>window.innerHeight) return;
        var step=homeCarouselStep(vp); if(!step) return;
        homeCarouselGoTo(vp,Math.round(vp.scrollLeft/step)+1);
      },HOME_CAROUSEL_INTERVAL_MS);
    }catch(_){}
  }
  window.lvResumeCarousel=resumeCarousel;
  var KEEP=[
    {sel:"#homePromotionalCarousel",
     sig:function(n){ return Array.prototype.map.call(n.querySelectorAll(".home-promotional-slide:not([data-clone])"),function(b){ var i=b.querySelector("img"); return (i?(i.getAttribute("src")||""):"")+"|"+(b.getAttribute("data-link-url")||""); }).join(";"); },
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
          var html=String(v);
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
      var g=gen(), vw=view(), html=String(v);
      var sameNav=(g===last.gen&&vw===last.view);
      // the cached page and the freshly loaded page are identical: leave the screen exactly as it is
      if(sameNav&&html===last.html) return;
      var prevView=last.view, self=this;
      KEEP.forEach(function(k){ var n=self.querySelector(k.sel); if(n) stash[k.sel]={node:n,sig:k.sig(n),scroll:k.scroll(n)}; });
      var liveBar=document.getElementById("lvCampusBar"); if(liveBar) window.__lvBarStash=liveBar;
      desc.set.call(this,v);
      KEEP.forEach(function(k){
        var st=stash[k.sel], nw=self.querySelector(k.sel);
        if(st&&nw&&nw!==st.node&&k.sig(nw)===st.sig){ nw.replaceWith(st.node); k.after(st.node,st.scroll); }
      });
      last={html:html,gen:g,view:vw};
      installSmart(this);
      if(reduce||!this.animate) return;
      if(sameNav){ animate(this,[{opacity:.6},{opacity:1}],150); return; }
      var chat=document.body&&document.body.classList.contains("chat-full-page");
      var tabSwitch=!!(TABS[prevView]&&TABS[vw]);
      if(chat) animate(this,[{opacity:0},{opacity:1}],180);
      else if(tabSwitch&&!goingBack) animate(this,[{opacity:0,transform:"translateY(8px)"},{opacity:1,transform:"none"}],170);
      else if(goingBack) animate(this,[{opacity:0,transform:"translateX(-22px)"},{opacity:1,transform:"none"}],190);
      else animate(this,[{opacity:0,transform:"translateX(26px)"},{opacity:1,transform:"none"}],190);
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
    { sel: "#aiChatPanel:not(.hidden)", close: function () { try { toggleAiChat(); } catch (_) {} }, back: null },
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
    return window.levroData.payments.config().then(function (r) { onCache = !!(r && r.data && r.data.paystackCheckout); onAt = Date.now(); return onCache; }, function () { return false; });
  }
  window.lvPaystackOn = paystackOn;
  function closeModal() { var m = document.getElementById("lvPayModal"); if (m) m.remove(); }
  function openModal(html) {
    closeModal();
    var m = document.createElement("div");
    m.id = "lvPayModal"; m.className = "modal lv-pm open";
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
    var on = await paystackOn();
    if (!on) return origDirect.apply(this, args);
    return startPaystack(orderId);
  };

  // Step 2: ask the server what to pay, show it, then continue to Paystack
  async function startPaystack(orderId) {
    openModal('<div class="lv-pm-head"><h3 id="lvPmTitle">Getting your payment ready…</h3></div><p class="muted" role="status" aria-live="polite">Please wait a moment.</p>');
    var r = await window.levroData.payments.initialize(orderId);
    if (r.error || !r.data) {
      openModal('<div class="lv-pm-head"><h3 id="lvPmTitle">We could not start the payment</h3></div><p class="lv-pm-err" role="alert">' + esc((r.error && r.error.message) || "Please try again.") + '</p>' + (r.error && (r.error.code || r.error.status) ? '<p class="muted" style="font-size:.72rem;margin:.25rem 0 0">Code: ' + esc([r.error.code, r.error.status].filter(Boolean).join(" ")) + '</p>' : '') + '<div class="lv-pm-actions"><button type="button" class="btn" onclick="document.getElementById(\'lvPayModal\')?.remove()">Close</button></div>');
      return;
    }
    var d = r.data;
    openModal(
      '<div class="lv-pm-head"><h3 id="lvPmTitle"><span class="lv-pm-ico" aria-hidden="true"><i class="fa-solid fa-credit-card"></i></span>Pay ' + esc(naira(d.amountNaira)) + '</h3><button type="button" class="icon-btn" aria-label="Close" onclick="document.getElementById(\'lvPayModal\')?.remove()"><i class="fa-solid fa-xmark"></i></button></div>' +
      '<ul class="lv-pm-sum"><li><span>Order amount</span><b>' + esc(naira(d.orderAmountNaira)) + '</b></li><li><span>Paystack fee</span><b>' + esc(naira(d.feeNaira)) + '</b></li><li class="tot"><span>You pay</span><b>' + esc(naira(d.amountNaira)) + '</b></li></ul>' +
      '<p class="lv-pm-secure"><i class="fa-solid fa-lock" aria-hidden="true"></i><span>Secured by Paystack. The vendor is paid after you confirm you have your order.</span></p>' +
      '<div class="lv-pm-actions"><button type="button" class="btn btn-outline" onclick="document.getElementById(\'lvPayModal\')?.remove()">Cancel</button><button type="button" class="btn" id="lvPmGo">Continue to Paystack</button></div>'
    );
    var go = document.getElementById("lvPmGo");
    go.addEventListener("click", function () {
      if (go.disabled) return; go.disabled = true; go.textContent = "Opening Paystack…";   // a second tap must not open a second payment
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

  // After Paystack: "Confirming your payment…", then Paid or not completed. Used by the popup and the return link.
  window.lvConfirmPaystack = async function (reference, orderId) {
    openModal('<div class="lv-pm-head"><h3 id="lvPmTitle">Confirming your payment…</h3></div><p class="muted" role="status" aria-live="polite">This usually takes a few seconds. Please do not close the app.</p><div class="lv-pm-spin" aria-hidden="true"></div>');
    var outcome = await window.levroData.payments.confirm(reference);
    closeModal();
    if (outcome === "paid") showToast("Paid. Thank you!", "success");
    else if (outcome === "failed") showToast("Payment not completed. You were not charged. Please try again.", "error");
    else showToast("We could not confirm that payment yet. It may still be processing; check your order in a minute.", "info");
    if (orderId) { try { await navigate("orderDetail", { orderId: orderId }); } catch (_) {} }
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
              window.levroData.payments.status(ref).then(function (r) {
                if (r && r.data && window.levroData.payments.outcomeOf(r.data.status) === "paid" && typeof currentView !== "undefined" && currentView === "orderDetail") {
                  showToast("Payment confirmed. Thank you!", "success");
                  navigate("orderDetail", { orderId: orderId }, false);
                }
              }, function () {});
            }
          } catch (_) {}
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
      box.innerHTML = d && d.verified
        ? '<div class="banner banner-success" style="margin-top:0.6rem;"><strong><i class="fa-solid fa-circle-check"></i> Account verified.</strong> ' + esc(d.accountName || "") + " · " + esc(d.bankName || "") + " ···" + esc(d.accountLast4 || "") + "</div>"
        : '<div class="banner banner-warning" style="margin-top:0.6rem;"><strong><i class="fa-solid fa-triangle-exclamation"></i> Account not verified.</strong> Add your bank below and confirm the name to be paid.</div>';
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
    return html + '<section class="lv-payouts" id="lvPayoutList" aria-live="polite"></section>';
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
  var tab = "payouts", range = "today";
  function naira(n) { try { return "₦" + Number(n || 0).toLocaleString("en-NG", { maximumFractionDigits: 2 }); } catch (_) { return "₦" + n; } }
  function when(t) { try { return new Date(t).toLocaleString("en-NG", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch (_) { return ""; } }
  function api() { return window.levroData && window.levroData.adminPayments; }
  var STATUS = { pending: "Waiting", processing: "On its way", success: "Sent", on_hold: "On hold", failed: "Failed", reversed: "Returned by bank", paid_manually: "Paid by hand", initialized: "Started", abandoned: "Abandoned", refunded: "Refunded", partially_refunded: "Part refunded", processed: "Done" };
  function pill(s) { var good = s === "success" || s === "processed" || s === "paid_manually"; var bad = s === "failed" || s === "reversed"; return '<span class="badge ' + (good ? "badge-success" : bad ? "badge-danger" : "badge-warning") + '">' + esc(STATUS[s] || s) + "</span>"; }

  function ask(title, label, withAmount, onOk) {
    var m = document.createElement("div");
    m.className = "modal lv-pm open"; m.id = "lvAdminAsk";
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
      if (res && res.error) { var er2 = document.getElementById("lvAskErr"); er2.textContent = res.error.message || "Something went wrong."; er2.classList.remove("hidden"); return; }
      m.remove(); showToast("Done.", "success"); navigate("adminPayments", {}, false);
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
    else if (kind === "refund") ask("Refund this order", "Reason for the refund", true, function (t, amt) { return a.refund(id, { amountNaira: amt, reason: t }); });
  };
  window.lvPayTab = function (t) { tab = t; navigate("adminPayments", {}, false); };
  window.lvPayRange = function (r) { range = r; navigate("adminPayments", {}, false); };

  function payoutRow(p) {
    var acts = "";
    if (["on_hold", "failed", "reversed"].indexOf(p.status) >= 0) acts += '<button class="btn btn-sm" onclick="lvPayAct(\'release\',\'' + esc(p.id) + '\')">Release</button>';
    if (p.status === "pending" || p.status === "failed") acts += '<button class="btn btn-sm btn-outline" onclick="lvPayAct(\'hold\',\'' + esc(p.id) + '\')">Hold</button>';
    if (["pending", "on_hold", "failed", "reversed"].indexOf(p.status) >= 0) acts += '<button class="btn btn-sm btn-outline" onclick="lvPayAct(\'manual\',\'' + esc(p.id) + '\')">Paid by hand</button>';
    return '<div class="lv-ap-row"><div class="lv-ap-main"><b>' + naira(p.amount) + "</b> " + pill(p.status) + "<small>" + esc(p.business_name || "") + " · " + when(p.created_at) + (p.hold_reason ? " · " + esc(p.hold_reason) : "") + (p.last_error ? " · " + esc(p.last_error) : "") + '</small><a class="lv-ap-link" onclick="navigate(\'orderDetail\',{orderId:\'' + esc(p.order_id) + '\'})">Open order</a></div><div class="lv-ap-acts">' + acts + "</div></div>";
  }
  function txRow(t) {
    var can = t.order_id && (t.status === "success" || t.status === "partially_refunded");
    return '<div class="lv-ap-row"><div class="lv-ap-main"><b>' + naira(t.amount) + "</b> " + pill(t.status) + "<small>" + esc(String(t.purpose).replace("_", " ")) + " · " + esc(t.business_name || "") + " · " + when(t.paid_at || t.created_at) + '</small></div><div class="lv-ap-acts">' + (can ? '<button class="btn btn-sm btn-outline" onclick="lvPayAct(\'refund\',\'' + esc(t.order_id) + '\')">Refund</button>' : "") + "</div></div>";
  }
  function refundRow(r) { return '<div class="lv-ap-row"><div class="lv-ap-main"><b>' + naira(r.amount) + "</b> " + pill(r.status) + "<small>" + esc(r.reason || "") + " · " + when(r.created_at) + (r.last_error ? " · " + esc(r.last_error) : "") + "</small></div></div>"; }
  function reportRow(r) {
    var rep = r.report || {}; var list = (rep.problems || []).map(function (p) { return "<li>" + esc(p.detail) + "</li>"; }).join("");
    return '<div class="lv-ap-row lv-ap-col"><div class="lv-ap-main"><b>' + esc(String(r.window_start).slice(0, 10)) + "</b> " + (r.problems ? '<span class="badge badge-danger">' + r.problems + " to check</span>" : '<span class="badge badge-success">All matched</span>') + "<small>" + (rep.error ? esc(rep.error) : (rep.checked || 0) + " payments checked") + "</small></div>" + (list ? "<ul class=\"lv-ap-list\">" + list + "</ul>" : "") + "</div>";
  }

  window.renderAdminPayments = async function () {
    var a = api();
    var nav = typeof adminNavHtml === "function" ? adminNavHtml("adminPayments") : "";
    if (!a) return nav + '<div class="empty-state">Payments are not available right now.</div>';
    var sum = await a.summary();
    if (sum.error) return nav + '<div class="empty-state">' + esc(sum.error.message || "Only admins can see payments.") + "</div>";
    var s = sum.data, h = s.health, t = s[range];
    var q = { limit: 40 };
    var rows;
    if (tab === "payouts") rows = await a.payouts(q);
    else if (tab === "held") rows = await a.payouts({ limit: 40, status: "on_hold" });
    else if (tab === "failed") rows = await a.payouts({ limit: 40, status: "failed" });
    else if (tab === "payments") rows = await a.transactions(q);
    else if (tab === "refunds") rows = await a.refunds(q);
    else rows = await a.reports();
    var list = ((rows && rows.data) || []).map(tab === "payments" ? txRow : tab === "refunds" ? refundRow : tab === "checks" ? reportRow : payoutRow).join("") || '<p class="muted" style="text-align:center;">Nothing here.</p>';
    var tabs = [["payouts", "Payouts"], ["held", "On hold" + (h.held_payouts ? " (" + h.held_payouts + ")" : "")], ["failed", "Failed" + (h.failed_payouts ? " (" + h.failed_payouts + ")" : "")], ["payments", "Payments"], ["refunds", "Refunds"], ["checks", "Daily checks"]];
    return nav + '<h2 style="text-align:center;"><i class="fa-solid fa-credit-card"></i> Payments</h2>' +
      (h.needsAttention ? '<div class="banner banner-warning" role="status"><strong><i class="fa-solid fa-triangle-exclamation"></i> ' + h.needsAttention + ' thing(s) need attention.</strong> Stuck or failed payouts and refunds, or mismatches in the last daily check.</div>' : '<div class="banner banner-success" role="status"><i class="fa-solid fa-circle-check"></i> Everything is matching.</div>') +
      '<div class="segmented-tabs">' + [["today", "Today"], ["week", "7 days"], ["month", "30 days"]].map(function (r) { return '<button class="' + (r[0] === range ? "active" : "") + '" onclick="lvPayRange(\'' + r[0] + '\')">' + r[1] + "</button>"; }).join("") + "</div>" +
      '<div class="lv-ap-totals">' + [["Collected", t.collected], ["Refunded", t.refunded], ["Paid to vendors", t.paidToVendors], ["Levromart commission", t.commission]].map(function (x) { return '<div class="stat"><div class="n">' + naira(x[1]) + '</div><div class="muted">' + x[0] + "</div></div>"; }).join("") + "</div>" +
      '<div class="segmented-tabs" style="margin-top:1rem;">' + tabs.map(function (x) { return '<button class="' + (x[0] === tab ? "active" : "") + '" onclick="lvPayTab(\'' + x[0] + '\')">' + esc(x[1]) + "</button>"; }).join("") + "</div>" +
      '<div class="lv-ap-list-wrap">' + list + "</div>";
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
  function remember() {
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
  document.addEventListener("click", function (e) { if (e.target && e.target.closest && e.target.closest("a, button, [onclick], .card, .product-card-wrap")) remember(); }, true);
  addEventListener("pagehide", remember);
  if (typeof orig === "function") {
    window.navigate = async function (view, params, pushHistory) {
      var prev = depth(), pushes = pushHistory !== false && !(pushHistory && typeof pushHistory === "object" && pushHistory.replace === true);
      if (pushes) remember();
      // Going Back: keep the page as tall as it was, so the saved spot exists straight away (the list fills in afterwards)
      // and we do not first show the top and then scroll down.
      var heldBody = false;
      if (pushHistory === false) {
        try { var hk = keyOf(false), hh = hk != null ? heights[hk] : 0; if (hh > 0) { document.body.style.minHeight = hh + "px"; heldBody = true; } } catch (_) {}
      }
      var r = await orig.apply(this, arguments);
      if (heldBody) setTimeout(function () { document.body.style.minHeight = ""; }, 2200);
      try {
        var st = history.state;
        if (pushes && st && st.view === view && st.lvDepth == null) history.replaceState(Object.assign({}, st, { lvDepth: prev + 1 }), "");
        if (pushHistory === false) {            // Back / forward: return to where this screen was left
          var k = keyOf(false), y = k != null ? scrolls[k] : undefined;
          if (Number.isFinite(y)) { window.scrollTo({ top: y, behavior: "instant" }); restore(y); }
        }
      } catch (_) {}
      return r;
    };
  }
  window.lvGoBack = function (fallback) {
    if (depth() > 0) history.back();
    else if (typeof navigate === "function") navigate(fallback || "home");
  };
})();

/* ===== A refresh never leaves you on the old version =====
   The app opens instantly from a saved copy and checks for a newer one in the background. When a newer one is found in the
   first seconds, and nothing has been touched yet, the page reloads itself once, so you never see the old look (or a mix of
   old and new) after an update. */
(function () {
  "use strict";
  var touched = false;
  ["pointerdown", "keydown", "touchstart"].forEach(function (t) { addEventListener(t, function () { touched = true; }, { once: true, capture: true, passive: true }); });
  try {
    navigator.serviceWorker && navigator.serviceWorker.addEventListener("message", function (e) {
      if (e.data && e.data.type === "LV_APP_UPDATED" && !touched && performance.now() < 20000) location.reload();
    });
  } catch (_) {}
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
  function dress() {
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
