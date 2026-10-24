/* ---- script ---- */
(function(){
  if(window.__levroFinalNotificationChatStability) return;
  window.__levroFinalNotificationChatStability=true;

  /* Keep cached notification paint structurally identical to live paint. */
  const notificationAvatarHtml = (n) => {
    if(n?.actor_avatar_url) return `<img src="${esc(n.actor_avatar_url)}" class="avatar-circle" style="width:2.15rem;height:2.15rem;object-fit:cover;flex:none;" alt="" draggable="false" />`;
    if(n?.actor_name) return avatarFallbackHtml(n.actor_name,"2.15rem","notification-avatar-fallback",n.actor_name,n.actor_id||n.actor_name);
    return notificationSystemIconHtml(n);
  };
  const notificationRowHtml = (n) => `<div class="notif-item-wrap" data-id="${esc(n.id)}">
    <button type="button" class="notif-item ${n.read?'':'unread'}" data-id="${esc(n.id)}" data-view="${esc(n.target_view||'home')}" data-params='${esc(JSON.stringify(n.target_params||{}))}' data-actor-name="${esc(n.actor_name||'')}" data-actor-avatar="${esc(n.actor_avatar_url||'')}" onclick="handleNotifItemClick(event,'${esc(n.id)}')">
      ${notificationAvatarHtml(n)}
      <span class="notif-copy"><strong>${esc(n.title||'Notification')}</strong>${n.body?`<span class="muted" style="font-size:.8rem;">${esc(n.notification_category==='new_follower'?(n.actor_name||n.body):maskSensitiveNumbers(n.body))}</span>`:''}<span class="muted" style="font-size:.72rem;">${timeAgo(n.created_at)}</span></span>
    </button>
  </div>`;
  window.__levroNotificationRowHtml=notificationRowHtml;

  /* Restore optimistic notification-read behaviour: navigation must never
     wait for the database write. */
  window.markSingleNotifRead = async function(id){
    if(!session) return;
    const selector=`.notif-item[data-id="${CSS.escape(String(id))}"]`;
    const el=document.querySelector(selector);
    if(!el || !el.classList.contains('unread')) return;
    el.classList.remove('unread');
    notifCount=Math.max(0,notifCount-1);
    const dot=byId('notifDot');
    if(dot){ if(notifCount>0){dot.textContent=notifCount>9?'9+':notifCount;dot.classList.remove('hidden');}else dot.classList.add('hidden'); }
    Promise.resolve(levroData.notifications.markRead(id)).catch(()=>{});
  };

  /* Replace only the cached first-paint branch inside renderNotifPanel so it
     cannot briefly use a different card geometry than the fresh branch. */
  const originalRenderNotifPanel=window.renderNotifPanel;
  if(typeof originalRenderNotifPanel==='function' && !window.__levroNotifRenderWrapped){
    window.__levroNotifRenderWrapped=true;
    window.renderNotifPanel=async function(){
      /* The original function owns the full filtering/category logic. Before
         it runs, normalize any cached rows in-place to the same flex layout;
         this prevents the old copy-only cache template from producing a
         transient vertical column. */
      try{
        const uid=session?.user?.id;
        if(uid){
          const key=`levromart-notifications-cache-v2:${uid}`;
          const cached=JSON.parse(localStorage.getItem(key)||'[]');
          const host=getNotifHost();
          if(host && Array.isArray(cached) && cached.length){
            host.innerHTML=cached.slice(0,60).map(notificationRowHtml).join('');
          }
        }
      }catch(_){}
      return originalRenderNotifPanel.apply(this,arguments);
    };
  }

  /* Realtime remains primary. This tiny foreground-only reconciliation is a
     safety net for mobile WebSocket stalls: it checks only the newest 20
     messages while a conversation is actually open. */
  let pollTimer=null, pollConversation=null, pollBusy=false;
  function stopChatMessageFallback(){
    if(pollTimer){clearInterval(pollTimer);pollTimer=null;}
    pollConversation=null; pollBusy=false;
  }
  async function reconcileLatestChatMessages(conversationId){
    if(pollBusy || !session || activeConversationId!==conversationId || currentView!=='messages' || document.hidden) return;
    const el=byId('chatMessages'); if(!el) return;
    pollBusy=true;
    try{
      /* Only ask for messages newer than the newest real (server) bubble on
         screen, minus a few seconds of slack -- an empty answer costs almost
         nothing, versus re-downloading the last 20 messages every tick. */
      let newest=0;
      el.querySelectorAll('.chat-bubble[data-msg-id][data-created-at]').forEach(b=>{
        if(!/^[0-9a-f-]{36}$/i.test(b.dataset.msgId||'')) return;
        const t=Date.parse(b.dataset.createdAt||''); if(t>newest) newest=t;
      });
      let q=sb.from('messages').select('*').eq('conversation_id',conversationId);
      if(newest) q=q.gt('created_at',new Date(newest-5000).toISOString());
      const {data,error}=await q.order('created_at',{ascending:false}).limit(20);
      if(error || !Array.isArray(data) || activeConversationId!==conversationId) return;
      const missing=data.filter(m=>!el.querySelector(`.chat-bubble[data-msg-id="${CSS.escape(String(m.id))}"]`)).reverse();
      if(!missing.length) return;
      await enrichMessageReplies(missing);
      missing.forEach(m=>el.insertAdjacentHTML('beforeend',chatBubbleHtml(m)));
      lastSeenMessagesByConv.set(conversationId,[...(lastSeenMessagesByConv.get(conversationId)||[]),...missing]);
      scrollChatToBottom();
      resolveVisibleAttachments(el); setupMessageInteractions(el);
      // One batched update for all new incoming messages (was one PATCH per message).
      const incomingIds=missing.filter(m=>m.sender_id!==session.user.id&&!m.read_at).map(m=>m.id);
      if(incomingIds.length){
        const nowIso=new Date().toISOString();
        Promise.resolve(sb.from('messages').update({read_at:nowIso,delivered_at:nowIso}).in('id',incomingIds)).then(()=>refreshNotifications(false)).catch(()=>{});
      }
    }catch(_){}finally{pollBusy=false;}
  }
  window.__levroStartChatMessageFallback=function(conversationId){
    stopChatMessageFallback();
    if(!conversationId) return;
    pollConversation=String(conversationId);
    reconcileLatestChatMessages(pollConversation);
    // Realtime is the primary path. While its channel is healthy only double-check
    // about every 15s; if the channel is down fall back to every 3s.
    let tick=0;
    pollTimer=setInterval(()=>{
      tick++;
      const healthy=(typeof typingChannelReady!=="undefined")&&typingChannelReady===true;
      if(healthy&&tick%10!==0)return;
      reconcileLatestChatMessages(pollConversation);
    },3000);
  };
  /* Pull right now (called when a new-message notification arrives, or the app comes back to the foreground). */
  window.__levroReconcileChatNow=function(){ if(pollConversation) return reconcileLatestChatMessages(pollConversation); };
  document.addEventListener('visibilitychange',()=>{ if(!document.hidden) window.__levroReconcileChatNow?.(); },{passive:true});
  window.addEventListener('online',()=>window.__levroReconcileChatNow?.(),{passive:true});
  window.__levroStopChatMessageFallback=stopChatMessageFallback;

  /* Start the fallback whenever the existing conversation subscription is
     established. No changes to the existing typing/presence channel. */
  const originalSubscribe=window.subscribeToConversation;
  if(typeof originalSubscribe==='function' && !window.__levroChatFallbackWrapped){
    window.__levroChatFallbackWrapped=true;
    window.subscribeToConversation=async function(conversationId){
      const result=await originalSubscribe.apply(this,arguments);
      window.__levroStartChatMessageFallback?.(String(conversationId));
      return result;
    };
  }
  const originalNavigate=window.navigate;
  if(typeof originalNavigate==='function' && !window.__levroChatFallbackNavWrapped){
    window.__levroChatFallbackNavWrapped=true;
    window.navigate=async function(view,params,pushHistory){
      if(view!=='messages' || !params?.conversationId) stopChatMessageFallback();
      return originalNavigate.apply(this,arguments);
    };
  }
})();

/* ---- levromart-service-negotiation-payment-bridge ---- */
(function(){
  "use strict";
  const baseReport=window.reportDirectVendorPayment;
  if(typeof baseReport!=="function"||window.__serviceNegotiationPaymentBridge)return;
  window.__serviceNegotiationPaymentBridge=true;
  window.reportDirectVendorPayment=async function(orderId,amount,paymentStage=""){
    try{
      const {data:order,error}=await sb.from("orders").select("service_offer_id").eq("id",orderId).maybeSingle();
      if(!error&&order?.service_offer_id){
        const err=byId("directPaymentError"),btn=byId("directPaymentReportedBtn");
        if(!err||!btn)return;
        err.classList.add("hidden");btn.disabled=true;
        const {error:rpcError}=await sb.rpc("report_service_offer_payment",{p_order_id:orderId,p_amount:Number(amount)});
        if(rpcError)throw rpcError;
        byId("manualVendorPaymentModal")?.remove();
        showToast("Payment reported. The order is now Payment unresolved until the vendor confirms receipt or raises a dispute.","success");
        await navigate("orderDetail",{orderId},false);
        return;
      }
    }catch(e){
      const err=byId("directPaymentError"),btn=byId("directPaymentReportedBtn");
      if(err){err.textContent=e?.message||"Could not report the payment.";err.classList.remove("hidden");}
      if(btn)btn.disabled=false;
      return;
    }
    return baseReport(orderId,amount,paymentStage);
  };
})();

/* ---- levromart-vendor-application-final-repair-20260916 ---- */
(function(){
  "use strict";

  const escLocal = (v) => {
    try { return typeof esc === "function" ? esc(v) : String(v ?? ""); }
    catch(_) { return String(v ?? ""); }
  };

  function getBanks(){
    return Array.isArray(window.NIGERIAN_BANKS) ? window.NIGERIAN_BANKS : [];
  }

  function getBankName(code){
    const hit = getBanks().find(b => String(b.code) === String(code));
    return hit?.name || String(code || "");
  }

  async function getLocation(){
    try{
      if(typeof captureVendorCurrentLocationForApplication === "function"){
        const loc = await captureVendorCurrentLocationForApplication();
        if(loc?.lat != null && loc?.lng != null) return loc;
      }
    }catch(_){}
    if(!navigator.geolocation) return null;
    return await new Promise(resolve=>{
      navigator.geolocation.getCurrentPosition(
        p=>resolve({lat:p.coords.latitude,lng:p.coords.longitude}),
        ()=>resolve(null),
        {enableHighAccuracy:true,timeout:8000,maximumAge:300000}
      );
    });
  }

  window.renderVendorApply = async function(){
    if(!session) return '<div class="empty-state">Please log in to apply as a vendor.</div>';
    if(profile?.role === "admin") return '<div class="empty-state">Admin accounts can\'t own a vendor store on Levromart.</div>';

    const {data:existing,error:existingError} = await sb
      .from("vendors")
      .select("id")
      .eq("user_id",session.user.id)
      .is("deleted_at",null)
      .maybeSingle();

    if(existingError) console.warn("[Levromart] Vendor application existing-check:", existingError);
    if(existing){
      navigate("vendorDashboard");
      return '<p class="muted">Redirecting…</p>';
    }

    if(!Array.isArray(sectors) || !sectors.length){
      const {data} = await levroData.catalogue.sectors("sort_order");
      sectors = data || [];
    }

    const banks = getBanks();

    return `<div class="va-page">
      <div class="va-hero">
        <div class="va-bg" aria-hidden="true"><i class="o1"></i><i class="o2"></i></div>
        <div class="va-hero-grid">
          <div class="va-copy">
            <p class="va-eyebrow">Become a vendor</p>
            <h2>Grow your <em>business.</em></h2>
            <p class="va-lead">Open your LevroMart shop, reach nearby buyers and get paid safely. Every application is reviewed by our team.</p>
          </div>
          <div class="va-art"><span class="va-chip c1"><i class="fa-solid fa-store"></i></span><span class="va-chip c2"><i class="fa-solid fa-chart-line"></i></span>${(function(){var im=document.querySelectorAll("#lvOnb .lv-hero")[2]||document.querySelector("#loginModal .lv-auth-char");return im&&im.src?`<img class="va-char" alt="" src="${im.src}" draggable="false">`:"";})()}</div>
        </div>
        <div class="va-perks"><span><i class="fa-solid fa-circle-check"></i> Free to apply</span><span><i class="fa-solid fa-shield-halved"></i> Verified badge</span><span><i class="fa-solid fa-users"></i> Reach new buyers</span></div>
      </div>
      <div id="vendorApplyError" class="error-text hidden"></div>

      <label>Which sector is your business in? *</label>
      <select id="vaSector" required>
        ${sectors.map(s=>`<option value="${escLocal(s.id)}">${escLocal(s.name)}</option>`).join("")}
      </select>

      <label>Business name *</label>
      <input id="vaBusinessName" autocomplete="organization" />

      <label>Address <span class="muted">(leave blank if you're an online-only business)</span></label>
      <input id="vaAddress" autocomplete="street-address" />

      <label>City</label>
      <input id="vaCity" value="Lagos" autocomplete="address-level2" />

      <label>Phone *</label>
      <input id="vaPhone" type="tel" autocomplete="tel" />

      <label>WhatsApp number *</label>
      <input id="vaWhatsapp" type="tel" autocomplete="tel" required />

      <div class="vendor-application-payout-section">
        <div class="vendor-application-payout-heading">
          <strong>Payout account *</strong>
          <span>The bank details you enter here automatically become your Levromart payout account.</span>
        </div>

        <label>Bank <span class="muted">(optional)</span></label>
        <button type="button" id="vaBankPickerBtn" class="bank-picker-trigger"
          onclick="openVendorApplyBankPicker()" aria-haspopup="dialog" aria-expanded="false">
          <span id="vaBankPickerLabel">Select a bank</span>
          <i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
        </button>
        <select id="vaBankCode" class="hidden" aria-hidden="true" tabindex="-1">
          <option value="">Select a bank</option>
          ${banks.map(b=>`<option value="${escLocal(b.code)}">${escLocal(b.name)}</option>`).join("")}
        </select>

        <label>Account name *</label>
        <input id="vaAccountName" autocomplete="name" placeholder="Name on the bank account" />

        <label>Account number <span class="muted">(optional)</span></label>
        <input id="vaAccountNumber" inputmode="numeric" maxlength="10"
          autocomplete="off" placeholder="10-digit account number" />
      </div>

      <label>CAC number <span class="muted">(optional)</span></label>
      <input id="vaCac" autocomplete="off" />

      <label>CAC document <span class="muted">(optional upload)</span></label>
      <input id="vaDoc" type="file" accept="application/pdf,image/*" />

      <label>About your business <span class="muted">(optional)</span></label>
      <textarea id="vaBio" rows="3"
        placeholder="Tell buyers briefly what your business offers."></textarea>

      <button type="button" class="btn" id="vendorApplySubmitBtn"
        style="margin-top:.8rem;" onclick="submitVendorApply()">
        <i class="fa-solid fa-paper-plane"></i> Submit application
      </button>
    </div>`;
  };

  let submitting = false;

  window.submitVendorApply = async function(){
    if(submitting) return;

    const errorEl = byId("vendorApplyError");
    const button = byId("vendorApplySubmitBtn");
    if(!errorEl || !button) return;

    const businessName = String(byId("vaBusinessName")?.value || "").trim();
    const phone = String(byId("vaPhone")?.value || "").trim();
    const bankCode = String(byId("vaBankCode")?.value || "").trim();
    const accountName = String(byId("vaAccountName")?.value || "").trim();
    const accountNumber = String(byId("vaAccountNumber")?.value || "").trim();

    errorEl.classList.add("hidden");
    errorEl.textContent = "";

    /* Only genuinely required application fields are enforced. */
    if(!businessName){
      errorEl.textContent = "Please enter your business name.";
      errorEl.classList.remove("hidden");
      byId("vaBusinessName")?.focus();
      return;
    }
    if(!phone){
      errorEl.textContent = "Please enter your phone number.";
      errorEl.classList.remove("hidden");
      byId("vaPhone")?.focus();
      return;
    }
    if(!bankCode){
      errorEl.textContent = "Please select your payout bank.";
      errorEl.classList.remove("hidden");
      byId("vaBankPickerBtn")?.focus();
      return;
    }
    if(!accountName){
      errorEl.textContent = "Please enter the name on the bank account.";
      errorEl.classList.remove("hidden");
      byId("vaAccountName")?.focus();
      return;
    }
    if(!/^\d{10}$/.test(accountNumber)){
      errorEl.textContent = "Please enter a valid 10-digit account number.";
      errorEl.classList.remove("hidden");
      byId("vaAccountNumber")?.focus();
      return;
    }

    submitting = true;
    button.disabled = true;
    button.classList.add("is-busy");
    const original = button.innerHTML;
    let createdVendorId = null;

    try{
      const address = String(byId("vaAddress")?.value || "").trim();
      const city = String(byId("vaCity")?.value || "").trim();
      const whatsapp = String(byId("vaWhatsapp")?.value || "").trim();
      const cac = String(byId("vaCac")?.value || "").trim();
      const bio = String(byId("vaBio")?.value || "").trim();

      let verificationDocs = [];
      const file = byId("vaDoc")?.files?.[0];
      if(file){
        const ext=(file.name.split(".").pop()||"bin").replace(/[^a-z0-9]/gi,"").toLowerCase()||"bin";
        const path=String(session.user.id)+"/"+String(Date.now())+"."+ext;
        button.innerHTML='<i class="fa-solid fa-upload"></i> Uploading…';
        const {error:uploadError}=await sb.storage.from("vendor-docs").upload(
          path,file,{contentType:file.type||"application/octet-stream",upsert:false}
        );
        if(uploadError) throw new Error(`Document upload failed: ${uploadError.message}`);
        verificationDocs=[path];
      }

      button.innerHTML='<i class="fa-solid fa-location-dot"></i> Getting location…';
      const loc = await getLocation();

      button.innerHTML='<i class="fa-solid fa-paper-plane"></i> Submitting…';

      const bankName = getBankName(bankCode);

      const {data:createdVendor,error:insertError}=await sb.from("vendors").insert({
        user_id:session.user.id,
        sector_id:byId("vaSector")?.value || null,
        business_name:businessName,
        address:address || null,
        city:city || null,
        phone,
        whatsapp_number:whatsapp || null,
        cac_number:cac || null,
        bio:bio || null,
        verification_docs:verificationDocs,
        bank_code:bankCode,
        bank_name:bankName,
        account_name:accountName,
        account_number:accountNumber,
        logo_url:profile?.avatar_url || null,
        lat:loc?.lat ?? null,
        lng:loc?.lng ?? null,
        is_active:false
      }).select("id").single();

      if(insertError) throw new Error(insertError.message);
      createdVendorId=createdVendor?.id;
      if(!createdVendorId) throw new Error("The vendor application could not be created.");

      /*
       * The payout account is created immediately from the exact bank details
       * supplied above. No second payout setup is required by the vendor.
       */
      button.innerHTML='<i class="fa-solid fa-building-columns"></i> Activating payout…';

      const payoutRes=await fetch("/api/vendor-payments",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          action:"create-subaccount",
          accessToken:session.access_token,
          bankCode,
          accountNumber
        })
      });

      let payoutJson={};
      try{ payoutJson=await payoutRes.json(); }catch(_){}

      if(!payoutRes.ok){
        throw new Error(
          payoutJson.error ||
          "We couldn't verify the payout account. Please check the bank details and try again."
        );
      }

      const subaccountCode =
        payoutJson.subaccount_code ||
        payoutJson.subaccount?.subaccount_code ||
        null;

      if(!subaccountCode){
        throw new Error("The payout account could not be activated. Please try again.");
      }

      const {error:savePayoutError}=await sb.from("vendors").update({
        bank_code:bankCode,
        bank_name:bankName,
        account_name:accountName || payoutJson.account_name || null,
        account_number:accountNumber,
        paystack_subaccount_code:subaccountCode
      }).eq("id",createdVendorId).eq("user_id",session.user.id);

      if(savePayoutError) throw new Error("Your application was created, but the payout account could not be linked. Please try again.");

      showToast(
        loc
          ? "Application submitted. Your payout account is already linked."
          : "Application submitted. Your payout account is already linked.",
        "success"
      );

      await refreshAuthState();
      navigate("vendorDashboard");
    }catch(err){
      console.error("[Levromart] Vendor application submit failed:",err);

      /* If payout activation failed after vendor creation, remove only the
         just-created application so it cannot look payout-ready when it isn't. */
      if(createdVendorId){
        try{
          await sb.from("vendors")
            .delete()
            .eq("id",createdVendorId)
            .eq("user_id",session.user.id);
        }catch(cleanupErr){
          console.warn("[Levromart] Vendor application cleanup failed:",cleanupErr);
        }
      }

      errorEl.textContent = err?.message || "We couldn't submit your application. Please try again.";
      errorEl.classList.remove("hidden");
      button.innerHTML=original;
    }finally{
      submitting=false;
      button.disabled=false;
      button.classList.remove("is-busy");
      if(button.innerHTML.includes("Uploading") || button.innerHTML.includes("Getting location") || button.innerHTML.includes("Submitting") || button.innerHTML.includes("Activating payout")){
        button.innerHTML=original;
      }
    }
  };

  /* Existing bank-picker functions use #vaBankCode. Because this final form
     contains exactly one such element, the custom picker now writes to the
     same field that submitVendorApply() reads. */
})();

/* ---- levromart-bank-picker-and-install-final-20260916 ---- */
(function(){
  "use strict";

  /* The existing bank picker lived inside an IIFE, so inline onclick handlers
     could not reach it. Expose the exact functions globally. */
  function syncBankLabel(){
    const select=document.getElementById("vaBankCode");
    const label=document.getElementById("vaBankPickerLabel");
    if(!select||!label)return;
    const opt=select.options[select.selectedIndex];
    label.textContent=(opt&&opt.value)?opt.textContent.trim():"Select a bank";
  }

  window.closeVendorApplyBankPicker=function(){
    document.getElementById("vendorApplyBankPickerModal")?.remove();
    document.getElementById("vaBankPickerBtn")?.setAttribute("aria-expanded","false");
  };

  window.selectVendorApplyBank=function(code){
    const select=document.getElementById("vaBankCode");
    if(!select)return;
    const option=Array.from(select.options).find(o=>String(o.value)===String(code));
    if(!option)return;
    select.value=String(code);
    syncBankLabel();
    window.closeVendorApplyBankPicker();
  };

  window.openVendorApplyBankPicker=function(){
    const select=document.getElementById("vaBankCode");
    if(!select){
      console.warn("[Levromart] Bank selector is not mounted yet.");
      return;
    }
    window.closeVendorApplyBankPicker();
    const banks=Array.from(select.options)
      .map(o=>({code:String(o.value||""),name:String(o.textContent||"").trim()}))
      .filter(b=>b.code&&b.name)
      .sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:"base"}));

    const modal=document.createElement("div");
    modal.id="vendorApplyBankPickerModal";
    modal.className="modal vendor-bank-picker-modal";
    modal.style.zIndex="100000";
    modal.addEventListener("click",e=>{if(e.target===modal)window.closeVendorApplyBankPicker();});
    modal.innerHTML=`<div class="vendor-bank-picker-content" role="dialog" aria-modal="true" aria-labelledby="vaBankPickerTitle">
      <div class="vendor-bank-picker-header"><div><h3 id="vaBankPickerTitle"><i class="fa-solid fa-building-columns"></i> Select payout bank</h3><p>${banks.length} supported banks and financial institutions</p></div>
      <button type="button" class="vendor-bank-picker-close" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>
      <div class="vendor-bank-search-wrap"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input id="vaBankSearch" class="vendor-bank-search" type="search" placeholder="Search bank…" autocomplete="off" /></div>
      <div id="vaBankPickerList" class="vendor-bank-picker-list"></div></div>`;
    document.body.appendChild(modal);
    modal.querySelector(".vendor-bank-picker-close")?.addEventListener("click",window.closeVendorApplyBankPicker);

    const list=document.getElementById("vaBankPickerList");
    const render=q=>{
      const query=String(q||"").trim().toLowerCase();
      const current=String(select.value||"");
      const filtered=query?banks.filter(b=>b.name.toLowerCase().includes(query)||b.code.toLowerCase().includes(query)):banks;
      if(!list)return;
      list.innerHTML=filtered.length?filtered.map(b=>{
        const safeCode=String(b.code).replace(/[^a-zA-Z0-9._-]/g,"");
        const safeName=esc(b.name);
        return `<button type="button" class="vendor-bank-option ${String(b.code)===current?"selected":""}" data-bank-code="${safeCode}"><span class="vendor-bank-option-icon"><i class="fa-solid fa-building-columns"></i></span><span class="vendor-bank-option-main"><strong>${safeName}</strong><small>${esc(b.code)}</small></span><i class="fa-solid ${String(b.code)===current?"fa-circle-check":"fa-chevron-right"}"></i></button>`;
      }).join(""):"<div class=\"vendor-bank-picker-empty\">No banks match your search.</div>";
      list.querySelectorAll("[data-bank-code]").forEach(btn=>btn.addEventListener("click",()=>window.selectVendorApplyBank(btn.dataset.bankCode)));
    };
    document.getElementById("vaBankSearch")?.addEventListener("input",e=>render(e.target.value));
    render("");
    document.getElementById("vaBankPickerBtn")?.setAttribute("aria-expanded","true");
    setTimeout(()=>document.getElementById("vaBankSearch")?.focus(),30);
  };

  // The browser install strip lives in one place now -- see
  // addInstallBanner()/showInstallBanner() further down. A second, earlier
  // copy of this same banner used to live here, sharing the exact same
  // element id; whichever one's timer fired first silently "won" the DOM
  // element and its own (weaker) click handler, while the other's improved
  // per-platform fallback text never actually got attached. That's why
  // tapping Install sometimes did nothing at all with no feedback.
})();

/* ---- levromart-bank-list-visible-and-install-banner-final-js-20260916 ---- */
(function(){
  "use strict";

  function bankSource(){
    /* Prefer the live Paystack-backed list when already loaded. */
    const live = Array.isArray(window.__levroBankOptions) ? window.__levroBankOptions : [];
    if(live.length) return live;

    /* NIGERIAN_BANKS is a top-level lexical binding in this index, not a
       window property, so read it directly when available. */
    try{
      if(typeof NIGERIAN_BANKS !== "undefined" && Array.isArray(NIGERIAN_BANKS) && NIGERIAN_BANKS.length){
        return NIGERIAN_BANKS;
      }
    }catch(_){}

    return [];
  }

  function bankListFromSelect(){
    const select=document.getElementById("vaBankCode");
    if(select){
      const rows=Array.from(select.options)
        .map(o=>({code:String(o.value||"").trim(),name:String(o.textContent||"").trim()}))
        .filter(b=>b.code && b.name);
      if(rows.length) return rows;
    }
    return bankSource().map(b=>({code:String(b.code||"").trim(),name:String(b.name||"").trim()}))
      .filter(b=>b.code && b.name);
  }

  window.openVendorApplyBankPicker=function(){
    const select=document.getElementById("vaBankCode");
    if(!select) return;

    window.closeVendorApplyBankPicker?.();

    const seen=new Set();
    const banks=bankListFromSelect()
      .filter(b=>{
        const key=`${b.code}::${b.name.toLowerCase()}`;
        if(seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:"base"}));

    const modal=document.createElement("div");
    modal.id="vendorApplyBankPickerModal";
    modal.className="modal vendor-bank-picker-modal";
    modal.innerHTML=`
      <div class="vendor-bank-picker-content" role="dialog" aria-modal="true" aria-labelledby="vaBankPickerTitle">
        <div class="vendor-bank-picker-header">
          <div>
            <h3 id="vaBankPickerTitle"><i class="fa-solid fa-building-columns"></i> Select payout bank</h3>
            <p>${banks.length} supported banks and financial institutions</p>
          </div>
          <button type="button" class="vendor-bank-picker-close" id="vaBankPickerClose" aria-label="Close">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>

        <div class="vendor-bank-search-wrap">
          <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
          <input id="vaBankSearch" class="vendor-bank-search" type="search"
                 placeholder="Search bank…" autocomplete="off" aria-label="Search bank" />
        </div>

        <div id="vaBankPickerList" class="vendor-bank-picker-list"></div>
      </div>`;

    document.body.appendChild(modal);

    const list=document.getElementById("vaBankPickerList");
    const search=document.getElementById("vaBankSearch");
    const current=()=>String(select.value||"");

    const choose=(code)=>{
      const option=Array.from(select.options).find(o=>String(o.value)===String(code));
      if(!option){
        const source=banks.find(b=>String(b.code)===String(code));
        if(source){
          const opt=document.createElement("option");
          opt.value=source.code;
          opt.textContent=source.name;
          select.appendChild(opt);
        }
      }
      select.value=String(code);
      const label=document.getElementById("vaBankPickerLabel");
      const chosen=Array.from(select.options).find(o=>String(o.value)===String(code));
      if(label) label.textContent=chosen?.textContent?.trim() || banks.find(b=>String(b.code)===String(code))?.name || "Select a bank";
      window.closeVendorApplyBankPicker();
    };

    const paint=()=>{
      const q=String(search?.value||"").trim().toLowerCase();
      const rows=q
        ? banks.filter(b=>b.name.toLowerCase().includes(q)||b.code.toLowerCase().includes(q))
        : banks;

      if(!list) return;

      list.innerHTML=rows.length
        ? rows.map(b=>`
            <button type="button"
                    class="vendor-bank-option ${String(b.code)===current()?"selected":""}"
                    data-bank-code="${String(b.code).replace(/[^a-zA-Z0-9._-]/g,"")}">
              <span class="vendor-bank-option-icon"><i class="fa-solid fa-building-columns"></i></span>
              <span class="vendor-bank-option-main">
                <strong>${esc(b.name)}</strong>
                <small>${esc(b.code)}</small>
              </span>
              <i class="fa-solid ${String(b.code)===current()?"fa-circle-check":"fa-chevron-right"}"></i>
            </button>`).join("")
        : `<div class="vendor-bank-picker-empty">${banks.length ? "No banks match your search." : "Bank list unavailable right now. Please try again."}</div>`;

      list.querySelectorAll("[data-bank-code]").forEach(btn=>{
        btn.addEventListener("click",()=>choose(btn.dataset.bankCode));
      });
    };

    document.getElementById("vaBankPickerClose")?.addEventListener("click",window.closeVendorApplyBankPicker);
    modal.addEventListener("click",e=>{if(e.target===modal)window.closeVendorApplyBankPicker();});
    search?.addEventListener("input",paint);
    paint();

    document.getElementById("vaBankPickerBtn")?.setAttribute("aria-expanded","true");
    setTimeout(()=>search?.focus(),60);
  };

  window.closeVendorApplyBankPicker=function(){
    document.getElementById("vendorApplyBankPickerModal")?.remove();
    document.getElementById("vaBankPickerBtn")?.setAttribute("aria-expanded","false");
  };

  /* Ensure the application form's hidden select always contains the fallback
     bank list even when the form was rendered through an older code path. */
  function hydrateApplicationBankSelect(){
    const select=document.getElementById("vaBankCode");
    if(!select) return;

    const existing=Array.from(select.options).filter(o=>o.value);
    if(existing.length) return;

    const banks=bankSource();
    if(!banks.length) return;

    select.innerHTML='<option value="">Select a bank</option>'+
      banks.map(b=>`<option value="${esc(String(b.code))}">${esc(String(b.name))}</option>`).join("");
  }

  setInterval(()=>{ if(!document.hidden) hydrateApplicationBankSelect(); },2500);

  /* ---------- Install banner ---------- */
  function isStandalone(){
    return window.matchMedia("(display-mode: standalone)").matches ||
           window.navigator.standalone === true;
  }

  function addInstallBanner(){
    if(isStandalone()) return null;
    let banner=document.getElementById("levroInstallBanner");
    if(banner) return banner;

    banner=document.createElement("div");
    banner.id="levroInstallBanner";
    banner.innerHTML=`
      <div class="levro-install-icon">
        <img src="${typeof MEDRIS_LOGO!=="undefined"?MEDRIS_LOGO:""}" alt="Levromart">
      </div>
      <div class="levro-install-copy">
        <strong>Install Levromart</strong>
        <span id="levroInstallBannerText">Install Levromart for a faster app-like experience.</span>
      </div>
      <div class="levro-install-actions">
        <button type="button" class="levro-install-btn" id="levroInstallBannerAction">Install</button>
        <button type="button" class="levro-install-close" id="levroInstallBannerClose" aria-label="Dismiss">×</button>
      </div>`;

    const header=document.querySelector("header");
    if(header?.parentNode) header.parentNode.insertBefore(banner,header.nextSibling);
    else document.body.prepend(banner);

    banner.querySelector("#levroInstallBannerClose")?.addEventListener("click",()=>{
      banner.classList.remove("is-visible");
    });

    banner.querySelector("#levroInstallBannerAction")?.addEventListener("click",async()=>{
      if(typeof deferredInstallPrompt!=="undefined" && deferredInstallPrompt){
        try{
          deferredInstallPrompt.prompt();
          await deferredInstallPrompt.userChoice;
        }catch(_){}
        deferredInstallPrompt=null;
        banner.classList.remove("is-visible");
        return;
      }

      /* Some browsers do not expose beforeinstallprompt. Give the user an
         actionable browser-specific instruction instead of a dead button. */
      const t=document.getElementById("levroInstallBannerText");
      const ua=navigator.userAgent||"";
      if(/iPhone|iPad|iPod/i.test(ua)){
        if(t)t.textContent="Tap Share → Add to Home Screen.";
      }else if(/Android/i.test(ua)){
        if(t)t.textContent="Tap your browser menu → Install app or Add to Home screen.";
      }else{
        if(t)t.textContent="Use your browser menu to install Levromart as an app.";
      }
    });

    return banner;
  }

  function showInstallBanner(){
    if(isStandalone()) return;
    // The install modal covers the same job (asking to install, or giving
    // iOS instructions) -- both showing at once just doubles up on the same
    // ask and, since they share one deferred prompt, made it look like
    // whichever the visitor didn't tap first had simply stopped working.
    if(!document.getElementById("installPromptModal")?.classList.contains("hidden")) return;
    const banner=addInstallBanner();
    if(!banner) return;

    const hasNativePrompt=typeof deferredInstallPrompt!=="undefined" && !!deferredInstallPrompt;
    if(hasNativePrompt){
      banner.querySelector("#levroInstallBannerText").textContent="Install Levromart for a faster app-like experience.";
    }
    banner.classList.add("is-visible");
  }

  window.addEventListener("beforeinstallprompt",(e)=>{
    /* A separate early handler may already own this event; use the shared
       deferred prompt and surface the banner immediately. */
    setTimeout(showInstallBanner,50);
  });

  window.addEventListener("appinstalled",()=>{
    document.getElementById("levroInstallBanner")?.classList.remove("is-visible");
  });

  setTimeout(showInstallBanner,2200);
})();

/* ---- levromart-vendor-application-final-behavior-20260916 ---- */
(function(){
  "use strict";

  const escLocal = (v) => {
    try { return typeof esc === "function" ? esc(v) : String(v ?? ""); }
    catch(_) { return String(v ?? ""); }
  };

  function applicationSectors(){
    const list = Array.isArray(window.__vendorApplySectorOptions) && window.__vendorApplySectorOptions.length
      ? window.__vendorApplySectorOptions
      : (Array.isArray(sectors) ? sectors : []);
    const seen = new Set();
    return list.filter(s=>{
      const id=String(s?.id||"").trim(), name=String(s?.name||"").trim();
      if(!id||!name||seen.has(name.toLowerCase())) return false;
      seen.add(name.toLowerCase());
      return true;
    }).sort((a,b)=>String(a.name).localeCompare(String(b.name),undefined,{sensitivity:"base"}));
  }

  function syncSectorLabel(){
    const select=byId("vaSector"), label=byId("vaSectorPickerLabel");
    if(!select||!label)return;
    if(select.value==="__other__"){
      label.textContent="Other";
      return;
    }
    const opt=Array.from(select.options).find(o=>String(o.value)===String(select.value));
    label.textContent=opt?.textContent?.trim() || "Select a sector";
  }

  window.closeVendorApplySectorPicker=function(){
    byId("vendorApplySectorPickerModal")?.remove();
    byId("vaSectorPickerBtn")?.setAttribute("aria-expanded","false");
  };

  window.openVendorApplySectorPicker=function(){
    const select=byId("vaSector");
    if(!select)return;
    window.closeVendorApplySectorPicker();

    const rows=applicationSectors();
    const current=String(select.value||"");

    const modal=document.createElement("div");
    modal.id="vendorApplySectorPickerModal";
    modal.className="vendor-application-sector-modal";
    modal.addEventListener("click",e=>{if(e.target===modal)window.closeVendorApplySectorPicker();});
    modal.innerHTML=`
      <div class="vendor-application-sector-sheet" role="dialog" aria-modal="true" aria-label="Choose business sector">
        <div class="vendor-application-sector-head">
          <strong>Choose a business sector</strong>
          <button type="button" class="icon-btn" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="vendor-application-sector-search">
          <i class="fa-solid fa-magnifying-glass"></i>
          <input id="vaSectorSearch" type="search" autocomplete="off" placeholder="Search sectors…" />
        </div>
        <div id="vaSectorPickerResults" class="vendor-application-sector-results"></div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector(".icon-btn")?.addEventListener("click",window.closeVendorApplySectorPicker);

    const list=byId("vaSectorPickerResults");
    const render=(q="")=>{
      const query=String(q).trim().toLowerCase();
      const filtered=query ? rows.filter(s=>String(s.name).toLowerCase().includes(query)) : rows;
      const all=[...filtered,{id:"__other__",name:"Other"}];
      list.innerHTML=all.length
        ? all.map(s=>`<button type="button" class="vendor-application-sector-option ${String(s.id)===current?"selected":""}" data-sector="${escLocal(s.id)}"><span>${escLocal(s.name)}</span><i class="fa-solid ${String(s.id)===current?"fa-circle-check":"fa-chevron-right"}"></i></button>`).join("")
        : `<div class="vendor-application-sector-empty">No sectors match your search.</div>`;
      list.querySelectorAll("[data-sector]").forEach(btn=>{
        btn.addEventListener("click",()=>{
          select.value=btn.dataset.sector;
          syncSectorLabel();
          window.closeVendorApplySectorPicker();
          if(btn.dataset.sector==="__other__"){
            openVendorApplyOtherSector();
          }
        });
      });
    };
    byId("vaSectorSearch")?.addEventListener("input",e=>render(e.target.value));
    render("");
    byId("vaSectorPickerBtn")?.setAttribute("aria-expanded","true");
    setTimeout(()=>byId("vaSectorSearch")?.focus(),30);
  };

  function openVendorApplyOtherSector(){
    const wrap=byId("vaOtherSectorWrap");
    if(!wrap)return;
    wrap.classList.remove("hidden");
    setTimeout(()=>byId("vaOtherSector")?.focus(),30);
  }

  function closeVendorApplyOtherSector(){
    byId("vaOtherSectorWrap")?.classList.add("hidden");
  }

  window.renderVendorApply = async function(){
    if(!session) return '<div class="empty-state">Please log in to apply as a vendor.</div>';
    if(profile?.role==="admin") return '<div class="empty-state">Admin accounts can\'t own a vendor store on Levromart.</div>';

    const {data:existing,error:existingError}=await sb.from("vendors")
      .select("id,verification_status")
      .eq("user_id",session.user.id).is("deleted_at",null).maybeSingle();

    if(existingError) console.warn("[Levromart] Vendor application existing-check:",existingError);
    if(existing){
      // Any existing non-deleted application (pending, rejected, or verified)
      // already has its own status view on the dashboard, never re-show a
      // blank, resubmittable application form to a returning applicant.
      navigate("vendorDashboard");
      return '<p class="muted">Redirecting…</p>';
    }

    if(!Array.isArray(sectors)||!sectors.length){
      const {data}=await levroData.catalogue.sectors("sort_order");
      sectors=data||[];
    }

    const rows=Array.isArray(sectors)?sectors:[];
    window.__vendorApplySectorOptions=rows;

    const banks=(typeof NIGERIAN_BANKS!=="undefined"&&Array.isArray(NIGERIAN_BANKS))?NIGERIAN_BANKS:[];

    return `<div class="va-page">
      <div class="va-hero">
        <div class="va-bg" aria-hidden="true"><i class="o1"></i><i class="o2"></i></div>
        <div class="va-hero-grid">
          <div class="va-copy">
            <p class="va-eyebrow">Become a vendor</p>
            <h2>Grow your <em>business.</em></h2>
            <p class="va-lead">Open your LevroMart shop, reach nearby buyers and get paid safely. Every application is reviewed by our team.</p>
          </div>
          <div class="va-art"><span class="va-chip c1"><i class="fa-solid fa-store"></i></span><span class="va-chip c2"><i class="fa-solid fa-chart-line"></i></span>${(function(){var im=document.querySelectorAll("#lvOnb .lv-hero")[2]||document.querySelector("#loginModal .lv-auth-char");return im&&im.src?`<img class="va-char" alt="" src="${im.src}" draggable="false">`:"";})()}</div>
        </div>
        <div class="va-perks"><span><i class="fa-solid fa-circle-check"></i> Free to apply</span><span><i class="fa-solid fa-shield-halved"></i> Verified badge</span><span><i class="fa-solid fa-users"></i> Reach new buyers</span></div>
      </div>

      <div id="vendorApplyError" class="error-text hidden"></div>

      <section class="va-sec va-s1">
      <div class="va-sec-h"><span class="va-ico"><i class="fa-solid fa-store"></i></span><div><strong>Your business</strong><small>What you sell and where buyers find you</small></div><span class="va-step">1</span></div>
      <label>Which sector is your business in? *</label>
      <div class="vendor-application-sector-wrap">
        <button type="button" id="vaSectorPickerBtn" class="vendor-application-sector-trigger" onclick="openVendorApplySectorPicker()" aria-haspopup="dialog" aria-expanded="false">
          <span id="vaSectorPickerLabel">Select a sector</span><i class="fa-solid fa-chevron-down"></i>
        </button>
        <select id="vaSector" class="hidden" aria-hidden="true" tabindex="-1">
          <option value="">Select a sector</option>
          ${rows.map(s=>`<option value="${escLocal(s.id)}">${escLocal(s.name)}</option>`).join("")}
          <option value="__other__">Other</option>
        </select>
      </div>
      <div id="vaOtherSectorWrap" class="vendor-application-sector-other hidden">
        <label>Name of your sector</label>
        <input id="vaOtherSector" type="text" autocomplete="organization-title" placeholder="Enter your business sector…" />
      </div>

      <label>Business name *</label>
      <input id="vaBusinessName" autocomplete="organization" />

      <label>Address <span class="muted">(leave blank if you're an online-only business)</span></label>
      <input id="vaAddress" autocomplete="street-address" />

      <label>City</label>
      <input id="vaCity" value="Lagos" autocomplete="address-level2" />
      </section>

      <section class="va-sec va-s2">
      <div class="va-sec-h"><span class="va-ico"><i class="fa-solid fa-phone"></i></span><div><strong>How buyers reach you</strong><small>Orders and questions come to these numbers</small></div><span class="va-step">2</span></div>
      <label>Phone *</label>
      <input id="vaPhone" type="tel" autocomplete="tel" />

      <label>WhatsApp number <span class="muted">(optional)</span></label>
      <input id="vaWhatsapp" type="tel" autocomplete="tel" />
      </section>

      <section class="va-sec va-s3">
      <div class="va-sec-h"><span class="va-ico"><i class="fa-solid fa-wallet"></i></span><div><strong>Get paid</strong><small>Where your earnings go</small></div><span class="va-step">3</span></div>
      <div class="vendor-application-payout-section">
        <div class="vendor-application-payout-heading">
          <strong>Payout account <span class="muted">(optional at application stage)</span></strong>
          <span>Your payout account can be completed separately after your application is submitted.</span>
        </div>

        <label>Bank *</label>
        <button type="button" id="vaBankPickerBtn" class="bank-picker-trigger" onclick="openVendorApplyBankPicker()" aria-haspopup="dialog" aria-expanded="false">
          <span id="vaBankPickerLabel">Select a bank</span><i class="fa-solid fa-chevron-down"></i>
        </button>
        <select id="vaBankCode" class="hidden" aria-hidden="true" tabindex="-1">
          <option value="">Select a bank</option>
          ${banks.map(b=>`<option value="${escLocal(b.code)}">${escLocal(b.name)}</option>`).join("")}
        </select>

        <label>Account number *</label>
        <input id="vaAccountNumber" inputmode="numeric" maxlength="10" autocomplete="off" placeholder="10-digit account number" />

        <label>Account name *</label>
        <input id="vaAccountName" autocomplete="name" placeholder="Name on the bank account" />
      </div>
      </section>

      <section class="va-sec va-s4">
      <div class="va-sec-h"><span class="va-ico"><i class="fa-solid fa-shield-halved"></i></span><div><strong>Verify your business</strong><small>Optional, but it builds buyer trust faster</small></div><span class="va-step">4</span></div>
      <label>CAC number <span class="muted">(optional)</span></label>
      <input id="vaCac" autocomplete="off" />

      <label>CAC document <span class="muted">(optional)</span></label>
      <div class="va-drop" id="vaDrop" role="button" tabindex="0" onclick="document.getElementById('vaDoc').click()" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();document.getElementById('vaDoc').click()}">
        <span class="va-drop-ico"><i class="fa-solid fa-file-arrow-up"></i></span>
        <span class="va-drop-txt"><b id="vaDocName">Upload document</b><small id="vaDocHint">PDF or a clear photo</small></span>
        <span class="va-drop-btn" id="vaDocBtn">Choose file</span>
      </div>
      <input id="vaDoc" class="va-file" type="file" accept="application/pdf,image/*" onchange="vaDocPicked(this)" />
      </section>

      <section class="va-sec va-s5">
      <div class="va-sec-h"><span class="va-ico"><i class="fa-solid fa-pen-to-square"></i></span><div><strong>Tell buyers more</strong><small>A short intro and when you are open</small></div><span class="va-step">5</span></div>
      <label>About your business <span class="muted">(optional)</span></label>
      <textarea id="vaBio" rows="3" placeholder="Tell buyers briefly what your business offers."></textarea>

      <label>Working hours</label>
      <select id="vaHoursPreset" onchange="toggleVendorApplyCustomHours()">
        <option value="daily_9_6">Every day, 9:00 AM – 6:00 PM</option>
        <option value="daily_8_8">Every day, 8:00 AM – 8:00 PM</option>
        <option value="weekdays_9_6">Mon–Fri, 9:00 AM – 6:00 PM (closed weekends)</option>
        <option value="mon_sat_9_7">Mon–Sat, 9:00 AM – 7:00 PM (closed Sunday)</option>
        <option value="24_7" selected>Open 24/7</option>
        <option value="custom">Custom, day by day…</option>
      </select>
      <div id="vaCustomHoursWrap" class="hidden" style="margin-top:.6rem;">
        <div id="vaHoursRows">${HOURS_DAYS.map(d=>hoursDayRowHtml(d.key,d.label,{closed:false,open:"09:00",close:"18:00"})).join("")}</div>
        <button type="button" class="btn btn-sm btn-outline" style="margin-top:.5rem;" onclick="copyMondayHoursToAll()"><i class="fa-solid fa-copy"></i> Use Monday's hours for every day</button>
      </div>
      </section>

      <div class="vendor-application-actions">
        <button type="button" class="btn" id="vendorApplySubmitBtn" onclick="submitVendorApply()"><i class="fa-solid fa-paper-plane"></i> Submit application</button>
      </div>
    </div>`;
  };

  let vendorApplyBusy=false;

  // Presets keep the application form to one dropdown instead of the full
  // day-by-day editor Edit Profile uses -- "Custom" reveals that same
  // editor (collectBusinessHoursFromForm etc., shared with Edit Profile)
  // only for the applicants who actually need it.
  // Shows the chosen CAC document in the upload card instead of the browser's plain "Choose file" box.
  window.vaDocPicked=function(inp){
    const f=inp&&inp.files&&inp.files[0], box=byId("vaDrop");
    if(!box) return;
    if(!f){ box.classList.remove("has-file"); byId("vaDocName").textContent="Upload document"; byId("vaDocHint").textContent="PDF or a clear photo"; byId("vaDocBtn").textContent="Choose file"; box.querySelector(".va-drop-ico i").className="fa-solid fa-file-arrow-up"; return; }
    const kb=f.size/1024, size=kb>=1024?(kb/1024).toFixed(1)+" MB":Math.max(1,Math.round(kb))+" KB";
    box.classList.add("has-file");
    byId("vaDocName").textContent=f.name;
    byId("vaDocHint").textContent=size+" · ready to upload";
    byId("vaDocBtn").textContent="Change";
    box.querySelector(".va-drop-ico i").className=(/pdf$/i.test(f.name)||f.type==="application/pdf")?"fa-solid fa-file-pdf":"fa-solid fa-file-circle-check";
  };
  window.toggleVendorApplyCustomHours=function(){
    const preset=byId("vaHoursPreset")?.value;
    byId("vaCustomHoursWrap")?.classList.toggle("hidden",preset!=="custom");
  };
  function vendorApplyHoursPresetToJson(preset){
    const allDay=(open,close)=>Object.fromEntries(HOURS_DAYS.map(d=>[d.key,{closed:false,open,close}]));
    const weekdaysOnly=(open,close)=>Object.fromEntries(HOURS_DAYS.map(d=>[d.key,(d.key==="sat"||d.key==="sun")?{closed:true}:{closed:false,open,close}]));
    const monSat=(open,close)=>Object.fromEntries(HOURS_DAYS.map(d=>[d.key,d.key==="sun"?{closed:true}:{closed:false,open,close}]));
    switch(preset){
      case "daily_9_6": return allDay("09:00","18:00");
      case "daily_8_8": return allDay("08:00","20:00");
      case "weekdays_9_6": return weekdaysOnly("09:00","18:00");
      case "mon_sat_9_7": return monSat("09:00","19:00");
      case "24_7": return allDay("00:00","23:59");
      default: return null;
    }
  }

  window.cancelVendorApply=function(){
    if(vendorApplyBusy)return;
    window.closeVendorApplySectorPicker();
    window.closeVendorApplyBankPicker();
    closeVendorApplyOtherSector();
    navigate("home");
  };

  window.submitVendorApply=async function(){
    if(vendorApplyBusy)return;
    const errorEl=byId("vendorApplyError"),button=byId("vendorApplySubmitBtn");
    if(!errorEl||!button)return;
    errorEl.classList.add("hidden");errorEl.textContent="";

    const business_name=String(byId("vaBusinessName")?.value||"").trim();
    const phone=String(byId("vaPhone")?.value||"").trim();
    const whatsapp=String(byId("vaWhatsapp")?.value||"").trim();
    const sectorSelection=String(byId("vaSector")?.value||"").trim();
    const customSector=String(byId("vaOtherSector")?.value||"").trim();
    const bankCode=String(byId("vaBankCode")?.value||"").trim();
    const bankName=String(byId("vaBankPickerLabel")?.textContent||"").trim();
    const accountNumber=String(byId("vaAccountNumber")?.value||"").trim();
    const accountName=String(byId("vaAccountName")?.value||"").trim();
    const hoursPreset=String(byId("vaHoursPreset")?.value||"").trim();
    const business_hours=hoursPreset==="custom"?collectBusinessHoursFromForm():vendorApplyHoursPresetToJson(hoursPreset);

    const flag=(id,msg,fallbackId)=>{
      errorEl.textContent=msg;errorEl.classList.remove("hidden");
      document.querySelectorAll(".va-missing").forEach(x=>x.classList.remove("va-missing"));
      const el=byId(id)&&!byId(id).classList.contains("hidden")?byId(id):(byId(fallbackId)||byId(id));
      if(el){
        el.classList.add("va-missing");
        try{el.scrollIntoView({block:"center",behavior:"smooth"});}catch(_){}
        setTimeout(()=>{try{el.focus({preventScroll:true});}catch(_){}},350);
        const clear=()=>{el.classList.remove("va-missing");el.removeEventListener("input",clear);el.removeEventListener("click",clear);};
        el.addEventListener("input",clear);el.addEventListener("click",clear);
      }
    };
    if(!sectorSelection){flag("vaSector","Please select your business sector.","vaSectorPickerBtn");return;}
    if(sectorSelection==="__other__"&&!customSector){flag("vaOtherSector","Please enter your business sector.","vaSectorPickerBtn");openVendorApplyOtherSector();return;}
    if(!business_name){flag("vaBusinessName","Please enter your business name.");return;}
    if(!phone){flag("vaPhone","Please enter your phone number.");return;}
    if(!whatsapp){flag("vaWhatsapp","Please enter your WhatsApp number.");return;}

    vendorApplyBusy=true;button.disabled=true;button.classList.add("is-busy");
    const original=button.innerHTML;
    let vendorId=null;

    try{
      let sectorId=sectorSelection;
      if(sectorSelection==="__other__"){
        button.innerHTML='<i class="fa-solid fa-layer-group"></i> Saving sector…';
        const {data:newSector,error:sectorError}=await sb.rpc("get_or_create_custom_sector",{p_name:customSector});
        if(sectorError)throw new Error(sectorError.message);
        if(!newSector)throw new Error("We couldn't save that sector. Please try again.");
        sectorId=newSector;
      }

      const address=String(byId("vaAddress")?.value||"").trim();
      const city=String(byId("vaCity")?.value||"").trim();
      const cac=String(byId("vaCac")?.value||"").trim();
      const bio=String(byId("vaBio")?.value||"").trim();
      const file=byId("vaDoc")?.files?.[0]||null;

      button.innerHTML='<i class="fa-solid fa-paper-plane"></i> Submitting…';

      // Atomic server-side upsert. This specifically fixes the
      // vendors_user_id_key failure caused by an existing soft-deleted vendor
      // row. It also creates the applicant notification in the same transaction.
      const {data:submittedVendorId,error:submitError}=await sb.rpc("submit_vendor_application",{
        p_sector_id:sectorId,
        p_business_name:business_name,
        p_address:address||null,
        p_city:city||null,
        p_phone:phone||null,
        p_whatsapp:whatsapp,
        p_cac_number:cac||null,
        p_bio:bio||null,
        p_bank_code:bankCode||null,
        p_bank_name:bankName||null,
        p_account_name:accountName||null,
        p_account_number:/^\d{10}$/.test(accountNumber)?accountNumber:null
      });
      if(submitError)throw new Error(submitError.message);
      vendorId=submittedVendorId;
      if(!vendorId)throw new Error("The application could not be submitted. Please try again.");

      // A successful RPC means the application and notification are already
      // committed. Never wait for Storage, Paystack, auth refresh, or navigation.
      showToast("Application submitted successfully. Your application is now awaiting review.","success");

      // Working hours aren't part of submit_vendor_application -- same
      // "secondary, never blocks the submit" treatment as the CAC document
      // below. Whatever's saved here is what the storefront, product pages,
      // and order details already read straight off the vendor row.
      if(business_hours){
        sb.from("vendors").update({business_hours,opening_hours:summarizeBusinessHours(business_hours)||null}).eq("id",vendorId).eq("user_id",session.user.id)
          .then(({error})=>{if(error)console.warn("[Levromart] Saving working hours failed:",error);});
      }

      // Optional document upload is deliberately secondary to application
      // submission. It can never make the Submit button appear stuck.
      if(file&&vendorId){
        void (async()=>{
          try{
            const ext=(file.name.split(".").pop()||"bin").replace(/[^a-z0-9]/gi,"").toLowerCase()||"bin";
            const path=String(session.user.id)+"/"+String(Date.now())+"."+ext;
            const {error:uploadError}=await sb.storage.from("vendor-docs").upload(path,file,{contentType:file.type||"application/octet-stream",upsert:false});
            if(uploadError)throw uploadError;
            const {data:cur,error:readError}=await sb.from("vendors").select("verification_docs").eq("id",vendorId).eq("user_id",session.user.id).maybeSingle();
            if(readError)throw readError;
            const docs=Array.isArray(cur?.verification_docs)?cur.verification_docs.slice():[];
            docs.push(path);
            const {error:updateError}=await sb.from("vendors").update({verification_docs:docs}).eq("id",vendorId).eq("user_id",session.user.id);
            if(updateError)throw updateError;
          }catch(e){
            console.warn("[Levromart] Background vendor document upload failed:",e);
            void sb.rpc("create_notification",{
              p_user_id:session.user.id,p_type:"vendor_application_document_action_needed",
              p_title:"Application submitted, document needs attention",
              p_body:"Your vendor application was submitted successfully, but the optional verification document could not be uploaded. Please add it from your vendor profile if required.",
              p_target_view:"home",p_target_params:{vendorId},p_actor_id:null
            }).catch(()=>{});
          }
        })();
      }

      // Approval remains a separate, admin-controlled step, but a freshly
      // submitted applicant is sent straight into payout setup so their
      // account is ready to receive money the moment they're approved.
      try { await refreshAuthState(); } catch(e) { console.warn("[Levromart] Post-application auth refresh failed:",e); }
      if (typeof window.openVendorPayoutSetup === "function") {
        void window.openVendorPayoutSetup().catch(e=>console.warn("[Levromart] Post-application payout setup redirect failed:",e));
      } else {
        void navigate("vendorEditProfile",{focusPayout:true},false).catch(e=>console.warn("[Levromart] Post-application navigation failed:",e));
      }
      return;
    }catch(err){
      console.error("[Levromart] Vendor application failed:",err);
      errorEl.textContent=err?.message||"We couldn't submit your application. Please check the form and try again.";
      errorEl.classList.remove("hidden");
      button.innerHTML=original;
    }finally{
      vendorApplyBusy=false;button.disabled=false;button.classList.remove("is-busy");
      if(button.innerHTML.includes("Saving sector")||button.innerHTML.includes("Submitting"))button.innerHTML=original;
    }
  };

  /* Make the sector picker react if a caller changes the hidden select. */
  document.addEventListener("change",e=>{
    if(e.target?.id==="vaSector"){
      syncSectorLabel();
      if(e.target.value==="__other__")openVendorApplyOtherSector();else closeVendorApplyOtherSector();
    }
  },true);
})();

/* ---- levromart-admin-delete-password-only-js-20260916 ---- */
(function(){
  "use strict";

  /* Replace the shared hard-coded admin password check with a real
     verification against the currently signed-in admin account. */
  window.promptAdminPassword=async function(actionLabel){
    if(!session?.user?.id||!profile?.email){
      showToast("Your admin session has expired. Please sign in again.","error");
      return false;
    }
    return await promptPasswordConfirm(actionLabel,async(value)=>{
      const password=String(value||"");
      if(!password)return false;
      const {data,error}=await sb.auth.signInWithPassword({email:profile.email,password});
      if(error||!data?.user)return false;
      return String(data.user.id)===String(session.user.id);
    });
  };

  const originalDelete=window.adminDeleteVendor;
  window.adminDeleteVendor=async function(vendorId,filterStatus,businessName){
    if(adminVendorActionBusy.has(vendorId))return;
    if(profile?.email!==SUPER_ADMIN_EMAIL)return;
    adminVendorActionBusy.add(vendorId);
    try{
      if(!businessName){
        const {data:target}=await sb.from("vendors").select("business_name").eq("id",vendorId).maybeSingle();
        businessName=target?.business_name||"this vendor";
      }
      if(!(await showConfirmDialog(
        `Permanently delete "${businessName}"? Their storefront and all listings are pulled immediately, they're demoted back to an ordinary buyer account, and past orders and reviews stay on record.`,
        {title:"Delete vendor",okLabel:"Delete vendor",danger:true}
      )))return;


      const {data:{session:liveSession}={}}=await sb.auth.getSession();
      if(!liveSession?.user?.id){showToast("Your admin session has expired. Please sign in again and retry.","error");return;}

      const {data,error}=await sb.rpc("admin_delete_vendor",{p_vendor_id:vendorId});
      if(error){showToast(error.message||"Could not delete this vendor.","error");return;}
      if(!data?.deleted){showToast("The delete request did not complete. Please check this vendor before retrying.","error");return;}

      invalidateMarketplaceState();
      showToast("Vendor deleted and demoted to a customer.","success");
      await navigate("adminPanel",{status:filterStatus||"pending"});
    }catch(err){
      console.error("[Levromart] Admin vendor deletion failed:",err);
      showToast(err?.message||"Could not delete this vendor.","error");
    }finally{
      adminVendorActionBusy.delete(vendorId);
    }
  };
})();

/* ---- levromart-admin-approval-auto-payout-20260916 ---- */
(function(){
  "use strict";
  window.setVendorStatus=async function(id,status,filterStatus,businessName){
    if(status!=="verified"){
      if(typeof window.__levroOriginalSetVendorStatusForApproval === "function") return window.__levroOriginalSetVendorStatusForApproval(id,status,filterStatus,businessName);
      return;
    }
    // Payout setup is intentionally NOT part of vendor approval. The admin
    // approval decision only changes the vendor verification state.
    if(typeof window.__levroFastApproveVendor === "function") return window.__levroFastApproveVendor(id,filterStatus,businessName);
    if(!session?.user?.id||profile?.role!=="admin"){showToast("Admin access is required.","error");return;}
    const {data,error}=await sb.rpc("admin_set_vendor_status",{p_vendor_id:id,p_status:"verified"});
    if(error||!data?.success){showToast(error?.message||"Could not approve this vendor.","error");return;}
    showToast(`${businessName||"Vendor"} approved successfully.` ,"success");
    await navigate("adminPanel",{status:filterStatus||"pending"},{replace:true});
  };
})();

/* ---- levromart-google-role-prompt-final-20260916 ---- */
(function(){
  "use strict";
  /* The database trigger now marks new OAuth accounts as role_selected=false.
     Keep this fallback for a Google callback that lands before the profile
     row has fully hydrated. */
  const oldSignInWithGoogle=window.signInWithGoogle;
  if(typeof oldSignInWithGoogle==="function"){
    window.signInWithGoogle=async function(){
      try{sessionStorage.setItem("levromart-google-role-selection-pending","1");}catch(_){}
      return oldSignInWithGoogle.apply(this,arguments);
    };
  }
})();

/* ---- levromart-vendor-recycle-bin-final-js-20260916 ---- */
(function(){
  "use strict";

  /* Delete = move to recycle bin. No password, no phone-number confirmation. */
  window.adminDeleteVendor = async function(vendorId, filterStatus, businessName){
    if(adminVendorActionBusy.has(vendorId)) return;
    if(!session?.user?.id || profile?.role !== "admin"){
      showToast("Admin access is required.","error"); return;
    }
    adminVendorActionBusy.add(vendorId);
    try{
      if(!businessName){
        const {data:target}=await sb.from("vendors").select("business_name").eq("id",vendorId).maybeSingle();
        businessName=target?.business_name||"this vendor";
      }
      if(!(await showConfirmDialog(
        `Move "${businessName}" to the Recycle Bin? Their storefront and listings will be hidden, but everything can be restored later.`,
        {title:"Move to Recycle Bin",okLabel:"Move to Recycle Bin",danger:true}
      ))) return;

      const {data,error}=await sb.rpc("admin_delete_vendor",{p_vendor_id:vendorId});
      if(error){showToast(error.message||"Could not move this vendor to the Recycle Bin.","error");return;}
      if(!data?.deleted){showToast("The vendor could not be moved to the Recycle Bin.","error");return;}

      invalidateMarketplaceState();
      showToast(`${businessName} moved to the Recycle Bin.`,"success");
      await navigate("adminPanel",{status:filterStatus||"pending"},{replace:true});
    }catch(err){
      console.error("[Levromart] Recycle-bin delete failed:",err);
      showToast(err?.message||"Could not move this vendor to the Recycle Bin.","error");
    }finally{adminVendorActionBusy.delete(vendorId);}
  };

  function friendlyVendorRecycleError(err, fallback){
    const raw=String(err?.message||err||"");
    if(/deleted_previous_verification_status|column \"role\"|user_role|vendor_verification_status/i.test(raw)){
      return fallback;
    }
    return raw||fallback;
  }

  window.restoreAdminVendor = async function(vendorId){
    if(adminVendorActionBusy.has(vendorId)) return;
    if(!session?.user?.id || profile?.role !== "admin"){showToast("Admin access is required.","error");return;}
    adminVendorActionBusy.add(vendorId);
    try{
      const {data:target}=await sb.from("vendors").select("business_name").eq("id",vendorId).maybeSingle();
      const name=target?.business_name && target.business_name!=="Deleted vendor" ? target.business_name : "this vendor";
      if(!(await showConfirmDialog(`Restore "${name}"? Their storefront, vendor status and saved listings will be restored.`,{title:"Restore vendor",okLabel:"Restore"})))return;
      const {data,error}=await sb.rpc("admin_restore_vendor",{p_vendor_id:vendorId});
      if(error){showToast(friendlyVendorRecycleError(error,"Could not restore this vendor. Please try again."),"error");return;}
      if(!data?.restored){showToast("The vendor was not restored.","error");return;}
      invalidateMarketplaceState();
      showToast(`${name} restored successfully.`,"success");
      await navigate("adminPanel",{status:"recycle"},{replace:true});
    }catch(err){console.error("[Levromart] Vendor restore failed:",err);showToast(err?.message||"Could not restore this vendor.","error");}
    finally{adminVendorActionBusy.delete(vendorId);}
  };

  window.permanentlyDeleteAdminVendor = async function(vendorId){
    if(adminVendorActionBusy.has(vendorId)) return;
    if(!session?.user?.id || profile?.role !== "admin"){showToast("Admin access is required.","error");return;}
    adminVendorActionBusy.add(vendorId);
    try{
      const {data:target}=await sb.from("vendors").select("business_name").eq("id",vendorId).maybeSingle();
      const name=target?.business_name && target.business_name!=="Deleted vendor" ? target.business_name : "this vendor";
      if(!(await showConfirmDialog(
        `Permanently delete "${name}"? They will be removed from the Recycle Bin, remain a buyer, and must apply again to become a vendor. This cannot be undone.`,
        {title:"Delete permanently",okLabel:"Delete permanently",danger:true}
      )))return;
      const {data,error}=await sb.rpc("admin_permanently_delete_vendor",{p_vendor_id:vendorId});
      if(error){showToast(friendlyVendorRecycleError(error,"Could not permanently delete this vendor. Please try again."),"error");return;}
      if(!data?.deleted_permanently){showToast("The vendor was not permanently deleted.","error");return;}
      invalidateMarketplaceState();
      showToast(`${name} was permanently removed. The account is now a buyer and must apply again to become a vendor.`,"success");
      await navigate("adminPanel",{status:"recycle"},{replace:true});
    }catch(err){console.error("[Levromart] Permanent vendor deletion failed:",err);showToast(err?.message||"Could not permanently delete this vendor.","error");}
    finally{adminVendorActionBusy.delete(vendorId);}
  };

  /* Keep the old route renderer's status validation from rejecting the new tab. */
  const oldNavigate = window.navigate;
  if(typeof oldNavigate === "function"){
    window.navigate = function(view, params, ...rest){ return oldNavigate.call(this,view,params,...rest); };
  }
})();
