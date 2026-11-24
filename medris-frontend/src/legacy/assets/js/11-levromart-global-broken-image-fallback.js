/* ---- levromart-global-broken-image-fallback ---- */
/* Product photos, chat attachments, cover images, package photos etc. all
   render a plain <img src="..."> with no per-call-site error handling --
   a dead/expired storage URL just shows the browser's ugly broken-image
   icon. A few call sites (avatars) already handle their own onerror with a
   smarter fallback (initials, vendor logo) -- this only steps in for the
   many that don't, one listener instead of patching every template. */
(function () {
  "use strict";
  var PLACEHOLDER = "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">' +
    '<rect width="120" height="120" fill="#e9edf1"/>' +
    '<path d="M35 78l16-20 12 14 10-12 18 22z" fill="#c4ccd4"/>' +
    '<circle cx="46" cy="46" r="8" fill="#c4ccd4"/>' +
    '</svg>'
  );
  document.addEventListener("error", function (e) {
    var img = e.target;
    if (!img || img.tagName !== "IMG") return;
    if (img.dataset.levroBrokenHandled) return;
    if (img.getAttribute("onerror")) return; // has its own smarter fallback already
    img.dataset.levroBrokenHandled = "1";
    img.src = PLACEHOLDER;
    if (!img.alt) img.alt = "Image unavailable";
  }, true);
})();

/* ---- levromart-notif-longpress-full-text ---- */
/* A notification row's body text is CSS-clipped to keep the list compact,
   but the full text is still sitting right there in the DOM -- long-pressing
   just needs to reveal it, not fetch anything. One delegated listener
   covers every notification list in the app (there's more than one markup
   copy of this row), instead of wiring this into each one separately. */
(function () {
  "use strict";
  let pressTimer = null, longPressed = false, startX = 0, startY = 0;
  const HOLD_MS = 480, MOVE_TOLERANCE = 10;

  function closeNotifSheet() {
    const w = document.getElementById("notifSheetWrap"); if (!w) return;
    w.classList.remove("in"); setTimeout(() => w.remove(), 260);
  }
  window.lvCloseNotifSheet = closeNotifSheet;
  // The full notification as a sheet that slides up from the bottom: its picture or icon, title, the whole text, when it came, and a button to open it
  function showFullNotifText(item) {
    const title = item.querySelector("strong")?.textContent?.trim() || "Notification";
    const muted = [...item.querySelectorAll(".muted")];
    const body = muted[0]?.textContent?.trim() || "";
    const when = muted.length > 1 ? muted[muted.length - 1]?.textContent?.trim() : "";
    const lead = item.querySelector(".notification-system-icon, img.avatar-circle, .notification-avatar-fallback, .avatar-circle, .avatar-fallback");
    document.getElementById("notifSheetWrap")?.remove();
    const w = document.createElement("div");
    w.id = "notifSheetWrap"; w.className = "nsheet-wrap";
    w.innerHTML = '<div class="nsheet-back"></div><section class="nsheet" role="dialog" aria-modal="true"><div class="nsheet-handle"></div>' +
      '<div class="nsheet-head"><span class="nsheet-lead"></span><div class="nsheet-titles"><h3></h3><small></small></div></div>' +
      '<p class="nsheet-body"></p>' +
      '<div class="nsheet-actions"><button type="button" class="nsheet-close">Close</button><button type="button" class="nsheet-open">Open</button></div></section>';
    w.querySelector("h3").textContent = title;
    w.querySelector("small").textContent = when;
    const bodyEl = w.querySelector(".nsheet-body");
    if (body) bodyEl.textContent = body; else bodyEl.remove();
    if (lead) w.querySelector(".nsheet-lead").appendChild(lead.cloneNode(true));
    else w.querySelector(".nsheet-lead").innerHTML = '<span class="notification-system-icon notif-type-icon" style="--nti:#64748b"><i class="fa-solid fa-bell"></i></span>';
    w.querySelector(".nsheet-back").addEventListener("click", closeNotifSheet);
    w.querySelector(".nsheet-close").addEventListener("click", closeNotifSheet);
    w.querySelector(".nsheet-open").addEventListener("click", () => { closeNotifSheet(); try { item.click(); } catch (_) {} });
    document.body.appendChild(w);
    requestAnimationFrame(() => requestAnimationFrame(() => w.classList.add("in")));
  }
  function clearPressTimer() { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } }

  document.addEventListener("touchstart", (e) => {
    const item = e.target.closest?.(".notif-item");
    if (!item) return;
    longPressed = false;
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
    pressTimer = setTimeout(() => {
      longPressed = true;
      try { navigator.vibrate?.(12); } catch (_) {}
      showFullNotifText(item);
    }, HOLD_MS);
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (!pressTimer) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - startX) > MOVE_TOLERANCE || Math.abs(t.clientY - startY) > MOVE_TOLERANCE) clearPressTimer();
  }, { passive: true });
  document.addEventListener("touchend", clearPressTimer, { passive: true });
  document.addEventListener("touchcancel", clearPressTimer, { passive: true });
  // A long-press still fires a synthetic click on release -- swallow just
  // that one so it doesn't also navigate away from the notification.
  document.addEventListener("click", (e) => {
    if (!longPressed) return;
    longPressed = false;
    if (e.target.closest?.(".notif-item")) { e.preventDefault(); e.stopPropagation(); }
  }, true);
})();

/* ---- levromart-modal-backdrop-dismiss ---- */
/* Tapping outside a popup to close it is standard, expected behaviour that
   most of this app's ~70 individual modals never got wired up for one by
   one. Rather than touch each one, this triggers whichever close button a
   modal already has (same aria-label="Close"/×-icon convention used
   throughout) when the tap lands on the backdrop itself -- e.target is only
   the modal element for a direct hit, never for a tap on its content, so
   this can't fire from clicking inside the popup. A modal with no close
   button at all (the "storefront paused, pay to continue" lock, the admin
   login-code prompt) is deliberately not dismissible, and finding nothing
   to click here correctly leaves it alone instead of inventing a way to
   close it. */
(function () {
  "use strict";
  document.addEventListener("click", (e) => {
    const modal = e.target;
    if (!(modal instanceof Element) || !modal.classList.contains("modal") || modal.classList.contains("hidden")) return;
    const closer = modal.querySelector('[aria-label="Close" i]') ||
      [...modal.querySelectorAll("button")].find((b) => b.querySelector(".fa-xmark"));
    if (closer) closer.click();
  });
})();

// Vendor "logos" that are really the owner's Google sign-in photo (often
// Google's auto-generated coloured-letter avatar) look out of place on shop
// cards, so cards show the soft initials avatar for those instead.
(function(){
  const GOOGLE_PHOTO=/^https?:\/\/[a-z0-9-]+\.googleusercontent\.com\//i;
  function swap(img){
    if(!img || img.dataset.googleSwapped)return;
    if(!GOOGLE_PHOTO.test(img.getAttribute("src")||""))return;
    const card=img.closest(".vendor-card, .vendors-map-vendor-chip, .vendor-card-avatar-wrap");
    if(!card)return;
    const nameEl=card.closest(".vendor-card, .vendors-map-vendor-chip")?.querySelector(".vendor-directory-name, .vendor-home-copy strong, .vendor-directory-copy strong, strong");
    const name=(img.alt||nameEl?.textContent||"Vendor").trim();
    img.dataset.googleSwapped="1";
    const cls=String(img.className||"").replace(/\bavatar-circle\b/g,"").trim();
    const tpl=document.createElement("template");
    tpl.innerHTML=avatarFallbackHtml(name,"3rem",cls,name);
    img.replaceWith(tpl.content);
  }
  function scan(root){
    if(!root)return;
    if(root.nodeType===1){
      if(root.tagName==="IMG")swap(root);
      root.querySelectorAll?.("img[src*='googleusercontent.com']").forEach(swap);
    }
  }
  const start=()=>{
    scan(document.body);
    new MutationObserver((muts)=>{for(const m of muts)m.addedNodes.forEach(scan);}).observe(document.body,{childList:true,subtree:true});
  };
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);else start();
})();

// ---- Online / last seen ----
// Every signed-in, foreground session pings touch_last_seen about every 45s
// (and once more as it goes to the background), so "online" means "seen in the
// last ~90s" and "last seen" is the last ping. Inside a chat, the other person
// shows as online instantly if they are in the same conversation channel.
(function(){
  const PING_MS=60000, ONLINE_WINDOW_MS=150000;
  let lastPing=0;
  function ping(force){
    try{
      if(typeof session==="undefined"||!session||typeof sb==="undefined")return;
      if(!force&&Date.now()-lastPing<20000)return;
      lastPing=Date.now();
      Promise.resolve(sb.rpc("touch_last_seen")).catch(()=>{});
    }catch(_){}
  }
  setInterval(()=>{if(!document.hidden)ping(false);},PING_MS);
  setTimeout(()=>ping(true),4000);
  document.addEventListener("visibilitychange",()=>ping(true),{passive:true});
  window.addEventListener("pagehide",()=>ping(true),{passive:true});

  function whenText(iso){
    const d=new Date(iso);if(isNaN(d))return "";
    const now=new Date();
    const time=d.toLocaleTimeString("en-GB",{hour:"numeric",minute:"2-digit",hour12:true});
    const startOf=(x)=>new Date(x.getFullYear(),x.getMonth(),x.getDate()).getTime();
    const days=Math.round((startOf(now)-startOf(d))/86400000);
    if(days<=0)return `last seen today at ${time}`;
    if(days===1)return `last seen yesterday at ${time}`;
    return `last seen ${d.toLocaleDateString("en-GB",{day:"numeric",month:"short"})} at ${time}`;
  }
  let timer=null,activeFor=null,lastSeenIso=null,fetching=false;
  function otherIsInChannel(){
    try{
      const st=window.activeMsgChannel?.presenceState?.()||(typeof activeMsgChannel!=="undefined"&&activeMsgChannel?.presenceState?.())||{};
      const me=session?.user?.id;
      return Object.keys(st).some((k)=>k&&k!==me);
    }catch(_){return false;}
  }
  function paint(){
    const el=document.getElementById("chatHeaderPresence");
    if(!el)return;
    const online=otherIsInChannel()||(lastSeenIso&&Date.now()-new Date(lastSeenIso).getTime()<ONLINE_WINDOW_MS);
    if(online){el.textContent="Online";el.classList.add("online");}
    else{el.classList.remove("online");el.textContent=lastSeenIso?whenText(lastSeenIso):"";}
  }
  async function load(){
    if(fetching||!activeFor||document.hidden)return;
    fetching=true;
    try{
      const {data,error}=await sb.rpc("get_conversation_presence",{p_conversation_id:activeFor});
      if(!error&&data){lastSeenIso=data;try{localStorage.setItem("levro-seen-v1:"+activeFor,String(data));}catch(_){}}
    }catch(_){}finally{fetching=false;}
    paint();
  }
  window.__levroPresenceText=function(conversationId){
    try{const iso=localStorage.getItem("levro-seen-v1:"+conversationId);if(!iso)return"";return Date.now()-new Date(iso).getTime()<ONLINE_WINDOW_MS?"Online":whenText(iso);}catch(_){return"";}
  };
  window.__levroStartChatPresence=function(conversationId){
    clearInterval(timer);activeFor=String(conversationId);
    // Start from the last value we knew, so the line is there the moment the chat opens.
    try{lastSeenIso=localStorage.getItem("levro-seen-v1:"+activeFor)||null;}catch(_){lastSeenIso=null;}
    paint();load();
    let tick=0;
    timer=setInterval(()=>{
      tick++;
      if(typeof activeConversationId==="undefined"||String(activeConversationId)!==activeFor||typeof currentView==="undefined"||currentView!=="messages"){clearInterval(timer);timer=null;activeFor=null;return;}
      paint();
      if(tick%10===0&&!document.hidden)load(); // network check roughly every 30s, never in a background tab
    },3000);
  };
  const wrapSub=window.subscribeToConversation;
  if(typeof wrapSub==="function"&&!window.__levroPresenceWrapped){
    window.__levroPresenceWrapped=true;
    window.subscribeToConversation=async function(conversationId){
      const r=await wrapSub.apply(this,arguments);
      try{window.__levroStartChatPresence(conversationId);}catch(_){}
      return r;
    };
  }
})();

// ---- Keep the keyboard up while chatting ----
// Tapping Send used to pull focus off the message box, so the keyboard dropped
// after every message. Stop the button from taking focus, and put focus back on
// the box right after sending (inside the same tap, which iOS requires).
(function(){
  const stopFocusSteal=(e)=>{
    const btn=e.target.closest?.(".chat-input-row .btn[onclick*='sendChatMessage']");
    if(btn && document.activeElement===byId("chatInput")) e.preventDefault();
  };
  document.addEventListener("mousedown",stopFocusSteal,true);
  document.addEventListener("pointerdown",(e)=>{ if(e.pointerType==="mouse") stopFocusSteal(e); },true);
  const orig=window.sendChatMessage;
  if(typeof orig==="function" && !window.__levroKeepKeyboard){
    window.__levroKeepKeyboard=true;
    window.sendChatMessage=function(){
      const input=byId("chatInput");
      const wasFocused=input && (document.activeElement===input || window.__chatInputWasFocused);
      const result=orig.apply(this,arguments);
      if(input && wasFocused){ try{ input.focus({preventScroll:true}); }catch(_){} }
      return result;
    };
    document.addEventListener("focusin",(e)=>{ if(e.target?.id==="chatInput") window.__chatInputWasFocused=true; },true);
    document.addEventListener("focusout",(e)=>{
      if(e.target?.id!=="chatInput") return;
      // Only forget focus if it moved somewhere that isn't the send button.
      setTimeout(()=>{ if(document.activeElement && document.activeElement!==document.body && !document.activeElement.closest?.(".chat-input-row")) window.__chatInputWasFocused=false; },0);
    },true);
  }
})();

// ---- Levi: collapsed tools, long-press to hide, triple-tap to bring back, "Ask me" nudge ----
function toggleLeviTools(force) {
  const tools = byId("leviTools"), btn = byId("leviToolsToggle");
  if (!tools || !btn) return;
  const open = typeof force === "boolean" ? force : !tools.classList.contains("open");
  tools.classList.toggle("open", open);
  btn.setAttribute("aria-expanded", open ? "true" : "false");
}
function hideLeviFromPanel() {
  byId("aiChatPanel")?.classList.add("hidden");
  toggleLeviTools(false);
  if (leviVisible) toggleLeviVisible(); else syncLeviFabVisibility();
}
(function(){
  byId("aiChatFab")?.addEventListener("contextmenu",(e)=>e.preventDefault());
  const origToggleAi=window.toggleAiChat;
  if(typeof origToggleAi==="function"&&!window.__leviToolsCollapseWrapped){
    window.__leviToolsCollapseWrapped=true;
    window.toggleAiChat=function(){ toggleLeviTools(false); return origToggleAi.apply(this,arguments); };
  }

  // Triple-tap anywhere on the page to bring a hidden Levi back.
  let taps=[];
  document.addEventListener("click",(e)=>{
    if(leviVisible)return;
    const now=Date.now();
    taps=taps.filter((t)=>now-t.at<650);
    taps.push({at:now,x:e.clientX,y:e.clientY});
    if(taps.length>=3){
      const a=taps[0],b=taps[taps.length-1];
      if(Math.hypot(a.x-b.x,a.y-b.y)<60){
        taps=[];
        toggleLeviVisible();
      }
    }
  },true);

  // A small "Ask me" nudge from Levi: only after a fresh login (or a long gap),
  // never while Levi is hidden or his chat is open, and it fades by itself.
  const ASK_KEY="levromart_levi_ask_last", ASK_GAP_MS=8*3600*1000;
  function removeBubble(){const b=byId("leviAskBubble");if(b){b.classList.remove("show");setTimeout(()=>b.remove(),300);}}
  function showAskBubble(){
    const fab=byId("aiChatFab"),panel=byId("aiChatPanel");
    if(!fab||!leviVisible||fab.classList.contains("hidden")||(panel&&!panel.classList.contains("hidden")))return;
    if(!fab.offsetWidth||document.hidden)return;
    if(typeof session==="undefined"||!session)return;
    try{localStorage.setItem(ASK_KEY,String(Date.now()));}catch(_){}
    document.getElementById("leviAskBubble")?.remove();
    const b=document.createElement("div");
    b.id="leviAskBubble";
    b.innerHTML='Ask me anything 👋<small>Products, vendors, how things work</small>';
    document.body.appendChild(b);
    const r=fab.getBoundingClientRect();
    const w=b.offsetWidth,h=b.offsetHeight;
    let left=Math.min(window.innerWidth-w-10,Math.max(10,r.right-w));
    let top=r.top-h-10; if(top<10) top=r.bottom+10;
    b.style.left=left+"px"; b.style.top=top+"px";
    requestAnimationFrame(()=>b.classList.add("show"));
    b.addEventListener("click",()=>{removeBubble();try{toggleAiChat();}catch(_){}});
    setTimeout(removeBubble,7000);
  }
  function maybeAsk(){
    let last=0;try{last=Number(localStorage.getItem(ASK_KEY)||0);}catch(_){}
    if(Date.now()-last<ASK_GAP_MS)return;
    showAskBubble();
  }
  // Wait for the app to be signed in and settled, then nudge once.
  let tries=0;
  const t=setInterval(()=>{
    tries++;
    if(typeof session!=="undefined"&&session&&typeof currentView!=="undefined"&&currentView){clearInterval(t);setTimeout(maybeAsk,2500);}
    else if(tries>40)clearInterval(t);
  },500);
  byId("aiChatFab")?.addEventListener("pointerdown",removeBubble,{passive:true});
})();

// ---- Keep the order tab row exactly where the user scrolled it ----
// Tapping a tab re-renders the page (a brand-new tab row), which used to reset
// its horizontal scroll back to "All". Remember the scroll position as the row
// is scrolled and put it back the instant a new row appears.
(function(){
  let last=0;
  document.addEventListener("scroll",(e)=>{
    const t=e.target;
    if(t&&t.classList&&t.classList.contains("order-status-pills-rail")) last=t.scrollLeft;
  },true);
  function restore(rail){
    if(!rail||rail.dataset.railRestored)return;
    rail.dataset.railRestored="1";
    if(last>0) rail.scrollLeft=last;
  }
  const mo=new MutationObserver((muts)=>{
    for(const m of muts)for(const n of m.addedNodes){
      if(n.nodeType!==1)continue;
      if(n.classList?.contains("order-status-pills-rail")) restore(n);
      else n.querySelectorAll?.(".order-status-pills-rail").forEach(restore);
    }
  });
  mo.observe(document.body,{childList:true,subtree:true});
  // A fresh visit to the orders page from elsewhere starts at the left again.
  const origNavigate=window.navigate;
  if(typeof origNavigate==="function"&&!window.__ordersRailNavWrapped){
    window.__ordersRailNavWrapped=true;
    window.navigate=function(view){
      if(!["buyerOrders","vendorOrders"].includes(view)) last=0;
      return origNavigate.apply(this,arguments);
    };
  }
})();

// ---- Mark icons that have a badge so CSS can animate them ----
(function(){
  const dots=[["messagesDot","#messagesWrap .icon-btn"],["notifDot","#notifWrap .icon-btn"],["headerCartBadge","#headerCartWrap .icon-btn"]];
  function visible(d){return !!d && !d.classList.contains("hidden") && String(d.textContent||"").trim()!=="" && String(d.textContent).trim()!=="0";}
  function sync(){
    try{
      dots.forEach(([id,sel])=>{const btn=document.querySelector(sel);if(btn)btn.classList.toggle("attn",visible(document.getElementById(id)));});
      document.querySelectorAll("#bottomNav .bottom-nav-item").forEach((it)=>it.classList.toggle("attn",!!it.querySelector(".bn-badge")));
      const fab=document.getElementById("cartFab");
      if(fab)fab.classList.toggle("attn",visible(document.getElementById("cartFabBadge")));
    }catch(_){}
  }
  let queued=false;
  const queue=()=>{if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;sync();});};
  const watch=()=>{
    const mo=new MutationObserver(queue);
    ["header","#bottomNav","#cartFab"].forEach((sel)=>{const el=document.querySelector(sel);if(el)mo.observe(el,{childList:true,subtree:true,attributes:true,attributeFilter:["class"],characterData:true});});
    sync();
  };
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",watch);else watch();
  setInterval(sync,3000);
})();

// ---- Come back to the same spot in the conversation list ----
(function(){
  const orig=window.navigate;
  if(typeof orig!=="function"||window.__msgListScrollWrapped)return;
  window.__msgListScrollWrapped=true;
  let saved=null;
  window.navigate=async function(view,params){
    try{
      const inList=typeof currentView!=="undefined"&&currentView==="messages"&&!(typeof currentViewParams!=="undefined"&&currentViewParams?.conversationId);
      if(inList&&view==="messages"&&params?.conversationId){
        const wrap=document.getElementById("convListWrap");
        saved={y:window.scrollY||document.documentElement.scrollTop||0,inner:wrap?wrap.scrollTop:0};
      }else if(view!=="messages"){saved=null;}
    }catch(_){}
    const restore=view==="messages"&&!params?.conversationId&&saved?{...saved}:null;
    const result=await orig.apply(this,arguments);
    if(restore){
      const apply=()=>{try{window.scrollTo(0,restore.y);const w=document.getElementById("convListWrap");if(w&&restore.inner)w.scrollTop=restore.inner;}catch(_){}};
      [0,60,160,360].forEach((t)=>setTimeout(apply,t));
    }
    return result;
  };
})();

// ---- In-app voice calls (browser-to-browser, no phone numbers) ----
// Signalling goes over a Realtime broadcast channel per call; audio is a direct
// WebRTC connection. Calls only start inside a conversation that has an accepted
// order (checked in the database). Add TURN servers to window.LEVROMART_TURN_SERVERS
// for calls across strict mobile networks.
(function(){
  let ICE=[{urls:["stun:stun.l.google.com:19302","stun:stun1.l.google.com:19302"]},
    {urls:["turn:openrelay.metered.ca:80","turn:openrelay.metered.ca:443","turns:openrelay.metered.ca:443?transport=tcp"],username:"openrelayproject",credential:"openrelayproject"}].concat(window.LEVROMART_TURN_SERVERS||[]);
  // Relay (TURN) servers come from /api/turn so phones on carrier NAT can still connect.
  let iceLoaded=null;
  const loadIce=()=>iceLoaded||(iceLoaded=Promise.race([fetch("/api/turn").then(r=>r.json()).then(j=>{if(Array.isArray(j?.iceServers)&&j.iceServers.length)ICE=[{urls:["stun:stun.l.google.com:19302","stun:stun1.l.google.com:19302","stun:stun.cloudflare.com:3478"]}].concat(j.iceServers,window.LEVROMART_TURN_SERVERS||[]);}).catch(()=>{}),new Promise(r=>setTimeout(r,2500))]));
  setTimeout(()=>{try{loadIce();}catch(_){}},3000);
  const RING_TIMEOUT_MS=45000;
  let call=null, ringTimer=null, ringtone=null, pollTimer=null, tickTimer=null, ringAgainTimer=null;

  const uid=()=>session?.user?.id;
  const sig=(payload)=>{try{call?.channel?.send({type:"broadcast",event:"sig",payload});}catch(_){}};

  // Ring tone (incoming) / ring-back tone (outgoing), generated with the same audio
  // context the notification chime uses (it is unlocked by the first tap in the app).
  function ringStart(kind){
    ringStop();
    try{
      if(typeof unlockNotificationAudio==="function")unlockNotificationAudio();
      const ctx=(typeof audioCtx!=="undefined"&&audioCtx)||null; if(!ctx)return;
      if(ctx.state==="suspended")ctx.resume().catch(()=>{});
      const incoming=kind!=="outgoing";
      const burst=(at,hz,len,vol)=>{ const o=ctx.createOscillator(),g=ctx.createGain(); o.type="sine"; o.frequency.setValueAtTime(hz,at);
        g.gain.setValueAtTime(0,at); g.gain.linearRampToValueAtTime(vol,at+.03); g.gain.setValueAtTime(vol,at+len-.05); g.gain.linearRampToValueAtTime(0,at+len);
        o.connect(g); g.connect(ctx.destination); o.start(at); o.stop(at+len+.02); };
      const ring=()=>{
        if(ctx.state!=="running")return;
        const t=ctx.currentTime+.02;
        if(incoming){ [0,.55].forEach((d)=>{ burst(t+d,440,.4,.16); burst(t+d,480,.4,.16); }); }
        else { burst(t,425,1.0,.07); }
      };
      ring();
      const every=incoming?2800:3200;
      const timer=setInterval(ring,every);
      let vib=null;
      if(incoming&&navigator.vibrate){ const v=()=>{try{navigator.vibrate([500,250,500]);}catch(_){}}; v(); vib=setInterval(v,every); }
      ringtone={stop:()=>{clearInterval(timer);if(vib){clearInterval(vib);try{navigator.vibrate(0);}catch(_){}}}};
    }catch(_){}
  }
  function ringStop(){try{ringtone?.stop();}catch(_){} ringtone=null;}

  function overlay(kind,name,avatar){
    document.getElementById("levroCallOverlay")?.remove();
    const el=document.createElement("div"); el.id="levroCallOverlay";
    const initial=(String(name||"?").trim()[0]||"?").toUpperCase();
    const face=avatar?`<img src="${esc(avatar)}" alt="" onerror="this.replaceWith(document.createTextNode('${esc(initial)}'))">`:esc(initial);
    el.innerHTML=`<div class="lc-avatar">${face}</div><div class="lc-name">${esc(name||"Levromart call")}</div><div class="lc-status" id="lcStatus">${kind==="incoming"?"Incoming voice call…":"Calling…"}</div>
      <div class="lc-actions">${kind==="incoming"
        ? `<button class="lc-btn decline" id="lcDecline" aria-label="Decline"><i class="fa-solid fa-phone-slash"></i></button><button class="lc-btn accept" id="lcAccept" aria-label="Answer"><i class="fa-solid fa-phone"></i></button>`
        : `<button class="lc-btn" id="lcMute" aria-label="Mute"><i class="fa-solid fa-microphone"></i></button><button class="lc-btn end" id="lcEnd" aria-label="End call"><i class="fa-solid fa-phone-slash"></i></button>`}</div>
      <div class="lc-hint">Voice call inside Levromart. Your phone number is never shared.</div>`;
    document.body.appendChild(el);
    return el;
  }
  function setStatus(t){const e=document.getElementById("lcStatus"); if(e)e.textContent=t;}
  function showActive(){
    const el=document.getElementById("levroCallOverlay"); if(!el)return;
    el.classList.add("lc-connected");
    const actions=el.querySelector(".lc-actions");
    actions.innerHTML=`<button class="lc-btn" id="lcMute" aria-label="Mute"><i class="fa-solid fa-microphone"></i></button><button class="lc-btn end" id="lcEnd" aria-label="End call"><i class="fa-solid fa-phone-slash"></i></button>`;
    bindActive();
    const t0=Date.now(); clearInterval(tickTimer);
    tickTimer=setInterval(()=>{const s=Math.floor((Date.now()-t0)/1000);setStatus(`Connected · ${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`);},1000);
    setStatus("Connected · 00:00");
  }
  function bindActive(){
    document.getElementById("lcEnd")?.addEventListener("click",()=>endCall(true));
    document.getElementById("lcMute")?.addEventListener("click",(e)=>{
      const b=e.currentTarget; const track=call?.stream?.getAudioTracks?.()[0]; if(!track)return;
      track.enabled=!track.enabled; b.classList.toggle("on",!track.enabled);
      b.innerHTML=`<i class="fa-solid ${track.enabled?"fa-microphone":"fa-microphone-slash"}"></i>`;
    });
  }

  function cleanup(){
    clearInterval(ringAgainTimer);
    clearTimeout(ringTimer); clearInterval(tickTimer); clearInterval(pollTimer); ringStop();
    try{call?.stream?.getTracks().forEach(t=>t.stop());}catch(_){}
    try{call?.pc?.close();}catch(_){}
    try{if(call?.channel)sb.removeChannel(call.channel);}catch(_){}
    try{clearInterval(call?.readyTimer);}catch(_){}
    document.getElementById("levroCallAudio")?.remove();
    document.getElementById("levroCallOverlay")?.remove();
    call=null;
  }
  async function endCall(notify,reason,status="ended"){
    if(!call)return;
    const id=call.id;
    if(notify){ sig({t:"end"}); try{await sb.rpc("update_voice_call",{p_call_id:id,p_status:status});}catch(_){} }
    cleanup();
    try{window.chatSyncCallLogsSoon?.(true);setTimeout(()=>window.chatSyncCallLogsSoon?.(true),1500);}catch(_){}
    if(reason) showToast(reason,"info");
  }

  async function getMic(){
    if(!navigator.mediaDevices?.getUserMedia||!window.RTCPeerConnection) throw new Error("Voice calls aren't supported on this browser.");
    const ask=(c)=>Promise.race([navigator.mediaDevices.getUserMedia(c),new Promise((_,rej)=>setTimeout(()=>rej(new Error("mic timeout")),12000))]);
    try{ return await ask({audio:{echoCancellation:true,noiseSuppression:true},video:false}); }
    catch(_){
      // Some Android phones reject the processing hints; retry with plain audio.
      try{ return await ask({audio:true,video:false}); }
      catch(_2){ throw new Error("Allow microphone access to make or answer calls."); }
    }
  }
  function joinChannel(callId,onSig){
    return new Promise((resolve)=>{
      const ch=sb.channel(`voicecall-${callId}`,{config:{broadcast:{self:false}}});
      ch.on("broadcast",{event:"sig"},({payload})=>onSig(payload));
      ch.subscribe((st)=>{ if(st==="SUBSCRIBED")resolve(ch); });
      setTimeout(()=>resolve(ch),4000);
    });
  }
  const waitGather=(pc,ms)=>new Promise((res)=>{ if(pc.iceGatheringState==='complete')return res(); const done=()=>{ if(pc.iceGatheringState==='complete'){pc.removeEventListener('icegatheringstatechange',done);res();} }; pc.addEventListener('icegatheringstatechange',done); setTimeout(res,ms); });
  function makePeer(){
    const pc=new RTCPeerConnection({iceServers:ICE,iceCandidatePoolSize:2});
    call.stream.getTracks().forEach(t=>pc.addTrack(t,call.stream));
    const audio=document.createElement("audio"); audio.id="levroCallAudio"; audio.autoplay=true; audio.playsInline=true; document.body.appendChild(audio);
    pc.ontrack=(e)=>{audio.srcObject=e.streams[0]; audio.play?.().catch(()=>{ const again=()=>{ audio.play?.().catch(()=>{}); }; ["pointerdown","touchstart","click","keydown"].forEach((ev)=>document.addEventListener(ev,again,{once:true,capture:true})); }); setTimeout(()=>{ if(call&&call.pc===pc&&!document.getElementById('levroCallOverlay')?.classList.contains('lc-connected')&&['connected','completed'].includes(pc.iceConnectionState))showActive(); },300); };
    pc.oniceconnectionstatechange=()=>{ if(!call||call.pc!==pc)return; if(['connected','completed'].includes(pc.iceConnectionState)){ clearInterval(call.readyTimer); clearTimeout(ringTimer); ringStop(); if(!document.getElementById('levroCallOverlay')?.classList.contains('lc-connected'))showActive(); } };
    pc.onicecandidate=(e)=>{ if(e.candidate)sig({t:"ice",c:e.candidate.toJSON?e.candidate.toJSON():e.candidate}); };
    let lostTimer=null;
    pc.onconnectionstatechange=()=>{
      if(!call)return;
      if(pc.connectionState==="connected"){ clearInterval(call.readyTimer); clearTimeout(lostTimer); clearTimeout(ringTimer); ringStop(); if(!document.getElementById("levroCallOverlay")?.classList.contains("lc-connected"))showActive(); }
      else if(pc.connectionState==="failed"){ endCall(true,"The call dropped. Check your connection and try again."); }
      else if(pc.connectionState==="disconnected"){ clearTimeout(lostTimer); lostTimer=setTimeout(()=>{ if(call&&pc.connectionState!=="connected")endCall(true,"The call dropped."); },8000); }
    };
    call.pc=pc; call.pendingIce=[];
    return pc;
  }
  async function onSignal(m){
    if(!call||!m)return;
    const pc=call.pc;
    try{
      if(m.t==="end"){ cleanup(); showToast("Call ended.","info"); return; }
      if(m.t==="ready"&&call.role==="caller"&&pc&&!pc.currentRemoteDescription){
        // The callee may have joined the channel after our first offer went out (slow phones),
        // so answer every "ready" with the offer until an answer comes back.
        if(!call.offered){ call.offered=true; const offer=await pc.createOffer(); await pc.setLocalDescription(offer); await waitGather(pc,2500); }
        if(pc.localDescription)sig({t:"offer",sdp:{type:pc.localDescription.type,sdp:pc.localDescription.sdp}});
      } else if(m.t==="offer"&&call.role==="callee"&&pc){
        if(call.answered){ if(pc.localDescription&&pc.connectionState!=="connected")sig({t:"answer",sdp:{type:pc.localDescription.type,sdp:pc.localDescription.sdp}}); return; }
        call.answered=true;
        await pc.setRemoteDescription(m.sdp);
        for(const c of call.pendingIce.splice(0))await pc.addIceCandidate(c).catch(()=>{});
        const ans=await pc.createAnswer(); await pc.setLocalDescription(ans); await waitGather(pc,2500); sig({t:"answer",sdp:{type:pc.localDescription.type,sdp:pc.localDescription.sdp}});
      } else if(m.t==="answer"&&call.role==="caller"&&pc&&!pc.currentRemoteDescription){
        await pc.setRemoteDescription(m.sdp);
        for(const c of call.pendingIce.splice(0))await pc.addIceCandidate(c).catch(()=>{});
      } else if(m.t==="ice"&&pc){
        if(pc.remoteDescription)await pc.addIceCandidate(m.c).catch(()=>{}); else call.pendingIce.push(m.c);
      }
    }catch(e){ console.warn("[Levromart] call signal error",e); }
  }
  function watchStatus(){
    clearInterval(pollTimer);
    let tick=0;
    pollTimer=setInterval(async()=>{
      if(!call)return;
      tick++;
      // While ringing check every 4s; once connected the broadcast "end" message is
      // the main signal, so only double-check about every 20s.
      if(document.getElementById("levroCallOverlay")?.classList.contains("lc-connected")&&tick%5!==0)return;
      try{
        const {data}=await sb.from("voice_calls").select("status").eq("id",call.id).maybeSingle();
        if(data&&["ended","declined","missed"].includes(data.status)){
          const was=data.status; cleanup();
          showToast(was==="declined"?"Call declined.":was==="missed"?"No answer.":"Call ended.","info");
        }
      }catch(_){}
    },3000);
  }

  window.startVoiceCall=async function(conversationId){
    if(call){ showToast("You're already on a call.","info"); return; }
    if(!session){ showLogin(); return; }
    let party={name:document.querySelector(".chat-header-name")?.textContent?.trim()||"Levromart call",avatar:document.querySelector(".chat-header-avatar")?.getAttribute?.("src")||null};
    const partyReq=Promise.resolve(sb.rpc("get_call_party",{p_conversation_id:conversationId})).then(({data})=>{const r=Array.isArray(data)?data[0]:data;if(r?.name)party={name:r.name,avatar:r.avatar_url||party.avatar};}).catch(()=>{});
    let stream;
    try{ stream=await getMic(); }catch(e){ showToast(e.message,"error"); return; }
    await loadIce();
    await Promise.race([partyReq,new Promise(r=>setTimeout(r,800))]);
    const name=party.name;
    let started;
    try{
      const {data,error}=await sb.rpc("start_voice_call",{p_conversation_id:conversationId});
      if(error)throw error; started=Array.isArray(data)?data[0]:data;
      if(!started?.call_id)throw new Error("Couldn't start the call.");
    }catch(e){ stream.getTracks().forEach(t=>t.stop()); showToast(e.message||"Couldn't start the call.","error"); return; }
    call={id:started.call_id,role:"caller",stream,conversationId};
    overlay("outgoing",name,party.avatar);
    makePeer();
    call.channel=await joinChannel(call.id,onSignal);
    if(!call)return;
    setStatus("Ringing…"); ringStart("outgoing");
    document.getElementById("lcEnd")?.addEventListener("click",()=>endCall(true));
    document.getElementById("lcMute")?.addEventListener("click",(e)=>{const b=e.currentTarget;const t=call?.stream?.getAudioTracks?.()[0];if(!t)return;t.enabled=!t.enabled;b.classList.toggle("on",!t.enabled);b.innerHTML=`<i class="fa-solid ${t.enabled?"fa-microphone":"fa-microphone-slash"}"></i>`;});
    watchStatus();
    ringTimer=setTimeout(()=>{ if(call&&!document.getElementById("levroCallOverlay")?.classList.contains("lc-connected"))endCall(true,"No answer.","missed"); },RING_TIMEOUT_MS);
    // Keep the other phone alerting: push the "incoming call" again every ~8s while it rings (max 5).
    const myCall=call.id; let again=0;
    clearInterval(ringAgainTimer);
    ringAgainTimer=setInterval(()=>{
      if(!call||call.id!==myCall||document.getElementById("levroCallOverlay")?.classList.contains("lc-connected")||++again>8){clearInterval(ringAgainTimer);return;}
      Promise.resolve(sb.rpc("ring_callee_again",{p_call_id:myCall})).catch(()=>{});
    },5000);
  };

  window.__levroIncomingCall=function(n){
    try{
      const p=n?.target_params||{}; const id=p.callId; if(!id||call)return;
      if(Date.now()-new Date(n.created_at||Date.now()).getTime()>RING_TIMEOUT_MS)return;
      const name=p.callerName||String(n.body||"").replace(/ is calling you\.?$/,"")||"Someone";
      call={id,role:"callee",conversationId:p.conversationId,incoming:true};
      overlay("incoming",name,p.callerAvatar||null); ringStart("incoming"); watchStatus();
      ringTimer=setTimeout(()=>{ if(call&&call.incoming&&!call.answeredByMe){ cleanup(); } },RING_TIMEOUT_MS);
      document.getElementById("lcDecline")?.addEventListener("click",async()=>{
        try{await sb.rpc("update_voice_call",{p_call_id:id,p_status:"declined"});}catch(_){}
        cleanup();
      });
      document.getElementById("lcAccept")?.addEventListener("click",async()=>{
        ringStop(); clearTimeout(ringTimer); call.answeredByMe=true; setStatus("Connecting…");
        document.querySelector("#levroCallOverlay .lc-actions").innerHTML=`<button class="lc-btn end" id="lcEnd" aria-label="End call"><i class="fa-solid fa-phone-slash"></i></button>`;
        document.getElementById("lcEnd")?.addEventListener("click",()=>endCall(true));
        try{
          call.stream=await getMic();
          await loadIce();
          await sb.rpc("update_voice_call",{p_call_id:id,p_status:"active"});
          makePeer();
          call.channel=await joinChannel(id,onSignal);
          const ready=()=>{ if(call&&call.pc&&call.pc.connectionState!=="connected")sig({t:"ready"}); };
          ready(); call.readyTimer=setInterval(ready,1500);
          setTimeout(()=>{ if(call&&call.pc&&call.pc.connectionState!=="connected")endCall(true,"Couldn't connect the call. Please try again."); },30000);
        }catch(e){ showToast(e.message||"Couldn't answer the call.","error"); endCall(true); }
      });
    }catch(e){ console.warn("[Levromart] incoming call failed",e); }
  };
  // Safety net if the realtime notification never arrives: look for a fresh ringing call.
  async function checkRinging(){
    if(!session||document.hidden||call)return;
    try{
      const since=new Date(Date.now()-RING_TIMEOUT_MS).toISOString();
      const {data}=await sb.from("voice_calls").select("id,conversation_id,created_at,caller_id").eq("callee_id",uid()).eq("status","ringing").gt("created_at",since).limit(1);
      if(data&&data[0]){
        let who="Someone",face=null;
        try{const {data:o}=await sb.rpc("get_call_party",{p_conversation_id:data[0].conversation_id});if(o&&o[0]?.name){who=o[0].name;face=o[0].avatar_url||null;}}catch(_){}
        window.__levroIncomingCall({created_at:data[0].created_at,body:`${who} is calling you.`,target_params:{callId:data[0].id,conversationId:data[0].conversation_id,callerName:who,callerAvatar:face}});
      }
    }catch(_){}
  }
  window.__levroCheckIncomingCall=checkRinging;
  // No timer: a ringing call arrives as a realtime notification / push, and we also
  // look when the app opens, comes back to the foreground or a push is tapped (below).
  // (A 7s poll here was ~900 requests/day per open tab.)
  // Opened from an "Incoming call" push (or just came back to the app): look right away.
  document.addEventListener("visibilitychange",()=>{ if(!document.hidden)setTimeout(checkRinging,300); },{passive:true});
  setTimeout(checkRinging,2500);
  try{ navigator.serviceWorker?.addEventListener("message",(e)=>{ if(e.data?.type==="PUSH_NOTIFICATION_CLICK")setTimeout(checkRinging,400); }); }catch(_){}

  // Phone button in the chat header (only where a call is allowed).
  // The phone button is part of the header from the first paint (remembered per chat), then
  // confirmed in the background -- it no longer pops in late or blinks away and back.
  const callKey=(id)=>"levro-callok-v1:"+id;
  const bindCallBtn=(b,conversationId)=>{ if(b.dataset.bound==="1")return; b.dataset.bound="1"; b.addEventListener("click",()=>window.startVoiceCall(conversationId)); };
  window.__levroCallBtnHtml=function(conversationId){
    try{ if(localStorage.getItem(callKey(conversationId))!=="1")return""; }catch(_){return"";}
    return `<button id="chatCallBtn" class="chat-header-icon-btn" type="button" title="Voice call" aria-label="Voice call" onclick="window.startVoiceCall('${conversationId}')"><i class="fa-solid fa-phone"></i></button>`;
  };
  window.__levroInitChatCall=async function(conversationId){
    try{
      if(!session)return;
      const {data,error}=await sb.rpc("can_call_in_conversation",{p_conversation_id:conversationId});
      if(error)return;                                   // keep whatever is showing
      try{ localStorage.setItem(callKey(conversationId),data===true?"1":"0"); }catch(_){}
      if(String(activeConversationId)!==String(conversationId))return;
      const existing=document.getElementById("chatCallBtn");
      if(data!==true){ existing?.remove(); return; }
      if(existing){ bindCallBtn(existing,conversationId); return; }
      const actions=document.querySelector(".chat-page-header .chat-header-actions");
      if(!actions)return;
      const b=document.createElement("button");
      b.id="chatCallBtn"; b.className="chat-header-icon-btn"; b.type="button"; b.title="Voice call"; b.setAttribute("aria-label","Voice call");
      b.innerHTML='<i class="fa-solid fa-phone"></i>';
      bindCallBtn(b,conversationId);
      actions.insertBefore(b,actions.firstChild);
    }catch(_){}
  };
})();

/* ---- levromart-keyboard-detector ---- */
/* Virtual-keyboard detector. A text field is focused AND the visual viewport is
   much shorter than the tallest height seen since the keyboard last closed =>
   the on-screen keyboard is open. Works for iOS (visual viewport shrinks) and
   Android (visual viewport and/or layout viewport shrink). Toggles one body
   class plus --levro-kbd-h; CSS hides the bottom bar and adds result padding. */
(function(){
  "use strict";
  var vv = window.visualViewport;
  if (!vv) return;
  var base = Math.max(window.innerHeight, vv.height), open = false, raf = 0;
  var EDITABLE = 'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=range]):not([type=file]):not([type=color]):not([type=hidden]),textarea,[contenteditable=""],[contenteditable="true"]';
  function editableFocused(){ var a = document.activeElement; return !!(a && a.matches && a.matches(EDITABLE)); }
  function apply(){
    raf = 0;
    var h = vv.height, focused = editableFocused();
    if (!focused) base = Math.max(h, window.innerHeight);
    else base = Math.max(base, window.innerHeight);
    var kbd = focused && (base - h) > 140;
    if (kbd !== open) {
      open = kbd;
      document.body.classList.toggle("levro-kbd-open", kbd);
    }
    document.documentElement.style.setProperty("--levro-kbd-h", kbd ? Math.max(0, Math.round(base - h - vv.offsetTop)) + "px" : "0px");
  }
  function schedule(){ if (!raf) raf = requestAnimationFrame(apply); }
  vv.addEventListener("resize", schedule, { passive: true });
  document.addEventListener("focusin", function(){ setTimeout(schedule, 60); setTimeout(schedule, 350); }, true);
  document.addEventListener("focusout", function(){ setTimeout(schedule, 60); setTimeout(schedule, 350); }, true);
  window.addEventListener("orientationchange", function(){ base = 0; setTimeout(schedule, 300); }, { passive: true });
  window.addEventListener("pagehide", function(){ document.body.classList.remove("levro-kbd-open"); }, { passive: true });
})();

/* ---- levromart-leaderboard-js ---- */
/* ===== Leaderboard, points and referrals ===== */
(function () {
  // --- capture a referral link (?ref=CODE) as early as possible ---
  try {
    const u = new URL(location.href);
    const r = u.searchParams.get("ref");
    if (r) {
      localStorage.setItem("levro-ref-code", String(r).trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16));
      u.searchParams.delete("ref");
      history.replaceState(history.state, "", u.pathname + (u.search || "") + u.hash);
    }
  } catch (_) {}

  const ALL_TABS = [["ranking", "Ranking", "fa-ranking-star"], ["mine", "My points", "fa-chart-simple"], ["earn", "Earn", "fa-bolt"], ["refer", "Refer", "fa-gift"], ["winners", "Winners", "fa-award"]];
  const tabsNow = () => { let isV = false; try { isV = !!(vendor && vendor.id) || profile?.role === "admin"; } catch (_) {} return isV || signedIn() ? ALL_TABS : ALL_TABS.filter((t) => t[0] !== "mine"); };
  const PERIODS = [["week", "This week"], ["last_week", "Last week"]];
  const WA_NUMBER = "2348063227669", WA_DISPLAY = "0806 322 7669";
  const waLink = (platform) => {
    const who = [typeof profile !== "undefined" && profile?.name, typeof profile !== "undefined" && profile?.phone].filter(Boolean).join(", ");
    const text = `Hi Levromart, I followed your ${platform || "social"} page. Here is my screenshot as evidence.${who ? " My details: " + who + "." : ""}`;
    return `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(text)}`;
  };
  const TIERS = [[0, "Starter", "fa-seedling"], [250, "Rising", "fa-arrow-trend-up"], [1000, "Pro", "fa-bolt"], [2500, "Elite", "fa-gem"], [6000, "Legend", "fa-award"]];
  const CAT = { sales: ["Sales", "#16a34a"], reputation: ["Reputation", "#e9a912"], referrals: ["Referrals", "#6d5ce8"], growth: ["Growth", "#2563eb"], shop: ["Your shop", "#0891b2"] };
  const SOCIALS = [["instagram", "Instagram", "/social-instagram.jpg", "https://instagram.com/levromart"], ["tiktok", "TikTok", "/social-tiktok.jpg", "https://tiktok.com/@levromart"], ["linkedin", "LinkedIn", "/social-linkedin.png", "https://linkedin.com/company/levromart"]];
  const LB = (window.__lb = { tab: "ranking", period: "week", filter: "all", boards: {}, summary: null, rules: null, winners: null, spot: null, activity: [], activityDone: false, chartMode: "daily", bdMode: "week", channel: null, tick: null, poll: null, prev: null, token: 0 });

  const reduced = () => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) { return false; } };
  const anim = (el, kf, opt) => { if (!el || !el.animate || reduced()) return null; try { return el.animate(kf, Object.assign({ fill: "both", easing: "cubic-bezier(.2,.8,.2,1)", duration: 600 }, opt || {})); } catch (_) { return null; } };
  const num = (n) => Number(n || 0).toLocaleString("en-NG");
  const $ = (id) => document.getElementById(id);
  const isVendor = () => !!(LB.summary?.is_vendor || (typeof vendor !== "undefined" && vendor?.id));
  const signedIn = () => !!(typeof session !== "undefined" && session?.user?.id);
  const myId = () => (signedIn() ? session.user.id : null);
  const av = (url, name, size, cls) => profileAvatarHtml(url, name || "Vendor", size, { extraClass: cls || "lb-av" });

  function countUp(el, to, dur) {
    if (!el) return;
    to = Number(to || 0);
    if (reduced() || to === 0) { el.textContent = num(to); return; }
    const t0 = performance.now(); dur = dur || 800;
    const step = (t) => { const p = Math.min(1, (t - t0) / dur); const e = 1 - Math.pow(1 - p, 3); el.textContent = num(Math.round(to * e)); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }

  function tierFor(total) {
    let i = 0; TIERS.forEach((t, k) => { if (total >= t[0]) i = k; });
    const cur = TIERS[i], next = TIERS[i + 1] || null;
    const pct = next ? Math.max(4, Math.min(100, ((total - cur[0]) / (next[0] - cur[0])) * 100)) : 100;
    return { name: cur[1], icon: cur[2], next, pct, need: next ? next[0] - total : 0 };
  }

  function nextWeekEndMs() {
    const l = new Date(Date.now() + 3600e3), dow = (l.getUTCDay() + 6) % 7;
    return Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate() + (7 - dow), 0, 0, 0) - 3600e3;
  }
  function countdownText() {
    let ms = nextWeekEndMs() - Date.now(); if (ms < 0) ms = 0;
    const d = Math.floor(ms / 864e5), h = Math.floor((ms % 864e5) / 36e5), m = Math.floor((ms % 36e5) / 6e4);
    return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  }
  function tickCountdown() { document.querySelectorAll("[data-lb-countdown]").forEach((el) => { el.textContent = countdownText(); }); }

  // ---------- data ----------
  async function loadBoard(period, quiet) {
    const key = period || LB.period;
    try {
      const { data, error } = await sb.rpc("get_points_leaderboard", { p_period: key, p_limit: 100 });
      if (error) throw error;
      LB.boards[key] = { rows: data || [], at: Date.now() };
    } catch (e) { if (!LB.boards[key]) LB.boards[key] = { rows: [], at: Date.now(), failed: true }; console.warn("[Levromart] leaderboard", e); }
  }
  async function loadSummary() {
    if (!signedIn()) { LB.summary = null; return; }
    try { const { data, error } = await sb.rpc("get_my_points_summary"); if (error) throw error; LB.summary = data; } catch (e) { console.warn("[Levromart] points summary", e); }
    try { const { data: cs } = await sb.rpc("get_points_cashout_status"); if (cs && cs.signed_in) LB.cash = cs; } catch (_) {}
  }
  async function loadRules() {
    if (LB.rules) return;
    try { const { data, error } = await sb.from("points_rules").select("*").eq("active", true).order("sort_order"); if (error) throw error; LB.rules = data || []; } catch (e) { console.warn("[Levromart] points rules", e); }
  }
  // The campus being looked at, or null for "All campuses"
  function campusOnly() { const v = viewCampus(); return v && v !== "all" && v !== "none" ? v : null; }
  // Winners of the chosen campus (its own Vendor of the Week) come from their own database function. If it is not available yet,
  // the whole-app winners are shown, trimmed to that campus, exactly as before.
  // Until the campus database functions exist, a campus's winner is worked out from the whole-app boards: last week's points
  // (the winner) and this week's points (the leaders), keeping only the shops whose home campus is that campus.
  async function campusFromBoards(c) {
    try {
      const home = window.lvVendorHomeCampus; if (!home) return null;
      const [lw, cw] = await Promise.all([sb.rpc("get_points_leaderboard", { p_period: "last_week", p_limit: 300 }), sb.rpc("get_points_leaderboard", { p_period: "week", p_limit: 300 })]);
      if (lw.error || cw.error) return null;
      const mine = (r) => r.points > 0 && home(r.vendor_id) === c;
      const lastRows = (lw.data || []).filter(mine), nowRows = (cw.data || []).filter(mine);
      const wk = new Date(nextWeekEndMs() - 14 * 864e5 + 3600e3).toISOString().slice(0, 10);
      const w = lastRows[0];
      const top = (rows) => rows.slice(0, 3).map((r, i) => ({ rank: i + 1, user_id: r.user_id, vendor_id: r.vendor_id, business_name: r.business_name, points: r.points }));
      const winner = w ? { vendor_id: w.vendor_id, business_name: w.business_name, logo_url: w.logo_url, city: w.city, avg_rating: w.avg_rating, review_count: w.review_count, points: w.points, week_start: wk } : null;
      const spot = { winner, leaders: nowRows.slice(0, 3).map((r, i) => ({ rank: i + 1, vendor_id: r.vendor_id, business_name: r.business_name, logo_url: r.logo_url, points: r.points })), week_ends_at: new Date(nextWeekEndMs()).toISOString() };
      const winners = w ? [{ week_start: wk, vendor_id: w.vendor_id, business_name: w.business_name, logo_url: w.logo_url, points: w.points, top3: top(lastRows) }] : [];
      return { spot, winners };
    } catch (_) { return null; }
  }
  async function loadWinners() {
    const c = campusOnly();
    try {
      if (c && !LB.cwFailed) {
        const [w, s] = await Promise.all([sb.rpc("get_campus_week_winners", { p_campus: c, p_limit: 12 }), sb.rpc("get_campus_vendor_spotlight", { p_campus: c })]);
        if (w.error || s.error) { LB.cwFailed = true; console.warn("[Levromart] campus winners", w.error || s.error); }
        else {
          if (campusOnly() !== c) return;
          LB.winners = w.data || []; LB.spot = s.data || null; LB.winnersFor = c; LB.spotFor = c; spotAt = Date.now();
          return;
        }
      }
      if (c && LB.cwFailed) {
        const fb = await campusFromBoards(c);
        if (fb) { if (campusOnly() !== c) return; LB.winners = fb.winners; LB.spot = fb.spot; LB.winnersFor = c; LB.spotFor = c; spotAt = Date.now(); return; }
      }
      const [w, s] = await Promise.all([sb.rpc("get_past_week_winners", { p_limit: 12 }), sb.rpc("get_vendor_spotlight")]);
      LB.winners = w.data || []; LB.spot = s.data || null; LB.winnersFor = null; LB.spotFor = null; spotAt = Date.now();
    } catch (e) { LB.winners = LB.winners || []; }
  }
  async function loadActivity(more) {
    if (!signedIn()) return;
    const before = more && LB.activity.length ? LB.activity[LB.activity.length - 1].created_at : null;
    try {
      const { data, error } = await sb.rpc("get_my_points_activity", { p_limit: 30, p_before: before });
      if (error) throw error;
      LB.activity = more ? LB.activity.concat(data || []) : (data || []);
      LB.activityDone = (data || []).length < 30;
    } catch (e) { console.warn("[Levromart] points activity", e); }
  }

  // ---------- html ----------
  function loginCta(msg) {
    return `<div class="lb-card lb-empty"><i class="fa-solid fa-lock"></i><strong>Sign in to continue</strong><p>${esc(msg)}</p><button type="button" class="btn" onclick="showLogin()">Sign in</button></div>`;
  }
  function skeleton(n) { return Array.from({ length: n || 5 }, () => `<div class="lb-skel"></div>`).join(""); }

  window.renderLeaderboard = function (params) {
    const want = params?.tab === "activity" ? "mine" : params?.tab;
    LB.tab = want && tabsNow().some((t) => t[0] === want) ? want : "ranking";
    LB.filter = "all";
    LB.mapReady = false; try { window.lvVendorMapReady ? window.lvVendorMapReady().then(() => { LB.mapReady = true; if ($("lbBody")) window.lbRerender(); }, () => { LB.mapReady = true; if ($("lbBody")) window.lbRerender(); }) : (LB.mapReady = true); } catch (_) { LB.mapReady = true; }
    return `<div class="lb-page">
      <div class="lb-hero">
        <div class="lb-hero-top"><div class="lb-hero-badge"><i class="fa-solid fa-award"></i></div>
          <div><h2>Vendor Leaderboard</h2><span class="lb-hero-sub"><i class="fa-regular fa-clock"></i> <span data-lb-countdown>${countdownText()}</span> left<span id="lbScope"></span></span></div></div>
        <div class="lb-hero-meta"><span id="lbHeroPills"></span></div>
        <div class="lb-hero-winner" id="lbHeroWinner" hidden></div>
        <span class="lb-spark s1"></span><span class="lb-spark s2"></span><span class="lb-spark s3"></span><span class="lb-spark s4"></span><span class="lb-spark s5"></span>
        <div class="lb-hero-people lb-hero-prods" id="lbHeroProds"></div>
      </div>
      <div class="lb-scope-seg" id="lbScopeSeg" role="tablist" aria-label="Campus"></div>
      <div class="lb-tabs" role="tablist">${tabsNow().map((t) => `<button type="button" role="tab" class="lb-tab${LB.tab === t[0] ? " active" : ""}" data-tab="${t[0]}" onclick="lbSetTab('${t[0]}')"><i class="fa-solid ${t[2]}"></i>${t[1]}</button>`).join("")}</div>
      <div id="lbBody">${skeleton(6)}</div>
    </div>`;
  };

  // Campus view: "Mine" limits the board to vendors of that campus (and those who sell on it); "All" shows everyone.
  function viewCampus() { try { return window.lvViewCampus ? window.lvViewCampus() : "all"; } catch (_) { return "all"; } }
  // A campus board lists only vendors whose home campus is that campus (plus you). A vendor we cannot place is left out, never shown by default.
  function inView(vendorId) {
    try {
      const v = viewCampus(); if (v === "all") return true;
      try { if (typeof isOwnVendorId === "function" && isOwnVendorId(vendorId)) return true; } catch (_) {}
      return !!window.lvVendorHomeCampus && window.lvVendorHomeCampus(vendorId) === v;
    } catch (_) { return false; }
  }
  function scopeRows(rows) {
    if (viewCampus() === "all") return rows;
    const kept = (rows || []).filter((r) => r.is_me || inView(r.vendor_id));
    return kept.map((r) => ({ ...r, rank: 1 + kept.filter((o) => o.points > r.points).length }));
  }
  function paintScopeSeg() {
    const el = $("lbScopeSeg"); if (!el) return;
    const v = viewCampus(), mine = (window.lvMyCampusId && window.lvMyCampusId()) || "";
    const target = v !== "all" ? v : (mine && mine !== "none" ? mine : "");
    const label = target ? ((window.lvCampusShort && window.lvCampusShort(target)) || "My campus") : "My campus";
    el.innerHTML = `<button type="button" role="tab" data-s="mine" class="${v !== "all" ? "on" : ""}">${esc(label)}</button><button type="button" role="tab" data-s="all" class="${v === "all" ? "on" : ""}">All campuses</button>`;
    el.onclick = (e) => {
      const b = e.target.closest("button[data-s]"); if (!b) return;
      if (b.dataset.s === "all") { window.lvSetViewCampus && window.lvSetViewCampus("all"); return; }
      if (target) { window.lvSetViewCampus && window.lvSetViewCampus(target); return; }
      try { window.lvOpenCampusPicker({ title: "Choose your campus", current: "", onPick: (r) => { if (r && r.id && r.id !== "none") { Promise.resolve(window.lvSaveCampus && window.lvSaveCampus(r.id)).catch(() => {}).then(() => window.lvSetViewCampus(r.id)); } } }); } catch (_) {}
    };
  }
  function paintScope() {
    const el = $("lbScope"); if (!el) return;
    const v = viewCampus();
    el.textContent = v === "all" ? "" : " \u00b7 " + ((window.lvCampusShort && window.lvCampusShort(v)) || "");
  }
  window.lbRerender = function () {
    // the campus changed: fetch that campus's Vendor of the Week (or the whole app's) and tell the Home banners
    const cc = campusOnly(), want = cc || null;
    try { document.dispatchEvent(new Event("lv-spot-changed")); } catch (_) {}
    if ((LB.winnersFor ?? null) !== want && LB.winnersTried !== want && !LB.winnersBusy && LB.winners) {
      LB.winnersBusy = true; LB.winnersTried = want;
      loadWinners().finally(() => { LB.winnersBusy = false; if ($("lbBody")) window.lbRerender(); });
    }
    if (!$("lbBody")) return; paintScopeSeg(); paintScope(); renderBody(false); paintHeroWinner();
  };
  function paintHeroWinner() {
    const el = $("lbHeroWinner"); if (!el) return;
    const w = LB.spot?.winner, cc = campusOnly(), scoped = !!cc && LB.spotFor === cc;
    // no Vendor of the Week for the chosen campus (yet): the floating products come from that campus's own shops, never another campus's winner
    if (!w || (!scoped && !inView(w.vendor_id))) { el.hidden = true; paintHeroProducts(cc ? "campus:" + cc : ""); return; }
    const d0 = new Date(w.week_start + "T00:00:00"), start = new Date(d0.getTime() + 7 * 864e5), end = new Date(start.getTime() + 6 * 864e5);
    const f = (z) => z.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    el.hidden = false;
    el.innerHTML = `<div class="lbw-logo">${av(w.logo_url, w.business_name, "2.9rem", "lb-av")}<i class="fa-solid fa-award lbw-crown"></i></div>
      <div class="lbw-copy"><span class="lbw-tag"><i class="fa-solid fa-award"></i> Vendor of the Week</span><strong>${esc(w.business_name)}</strong><small>${f(start)} to ${f(end)}</small></div>
      <i class="fa-solid fa-chevron-right lbw-go"></i>`;
    el.onclick = () => navigate("storefront", { vendorId: w.vendor_id });
    paintHeroProducts(w.vendor_id);
  }
  // The winner's own products float in the corner of the header and keep reshuffling; tapping one opens it
  async function paintHeroProducts(vid) {
    const box = $("lbHeroProds"); if (!box || box.dataset.v === String(vid)) return;
    box.dataset.v = String(vid);
    clearInterval(window.__lbProdTimer);
    if (!vid) { box.innerHTML = ""; return; }
    box.innerHTML = "";   // the old products leave at once, so another campus's never linger while the new ones load
    try {
      let r;
      const campus = String(vid).indexOf("campus:") === 0 ? String(vid).slice(7) : "";
      if (campus) {
        // this week's campus leaders first, then any shop whose home campus it is
        const lead = ((LB.spotFor === campus && LB.spot && LB.spot.leaders) || []).map((x) => x.vendor_id).filter(Boolean);
        const vs = await sb.from("vendors").select("id").eq("campus_id", campus).is("deleted_at", null).limit(80);
        const ids = [...new Set(lead.concat(((vs && vs.data) || []).map((x) => x.id)))];
        if (!ids.length) { const b0 = $("lbHeroProds"); if (b0 && b0.dataset.v === String(vid)) b0.innerHTML = ""; return; }
        r = await sb.from("products").select("id,name,photos").in("vendor_id", ids).eq("status", "active").order("created_at", { ascending: false }).limit(40);
      } else {
        r = await sb.from("products").select("id,name,photos").eq("vendor_id", vid).eq("status", "active").order("created_at", { ascending: false }).limit(30);
      }
      const pool = ((r && r.data) || []).filter((p) => p.photos && p.photos[0]);
      // a different mix every time the page opens, not always the newest three
      for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
      const again = $("lbHeroProds"); if (!again || again.dataset.v !== String(vid) || !pool.length) return;
      let at = 0;
      const show = (first) => {
        const b = $("lbHeroProds"); if (!b) return false;
        const rows = [0, 1, 2].map((k) => pool[(at + k) % pool.length]).filter((p, k, a) => a.indexOf(p) === k);
        at = (at + 3) % pool.length;
        b.innerHTML = rows.map((p, i) => `<img class="lb-float f${i}${first ? "" : " swap"}" style="--d:${i * 0.18}s" src="${esc(p.photos[0])}" alt="" width="52" height="52" decoding="async" onclick="event.stopPropagation();navigate('productDetail',{productId:'${esc(p.id)}'})">`).join("");
        return true;
      };
      show(true);
      if (pool.length > 3) {
        clearInterval(window.__lbProdTimer);
        window.__lbProdTimer = setInterval(() => { if (document.hidden) return; if (!show(false)) clearInterval(window.__lbProdTimer); }, 3800);
      }
    } catch (_) {}
  }
  function ensureHeroWinner() {
    paintHeroWinner();
    if (!LB.spot) homeSpot().then(() => paintHeroWinner()).catch(() => {});
  }
  function heroPills() {
    const el = $("lbHeroPills"); if (!el) return;
    el.innerHTML = ""; return;
    const s = LB.summary;
    if (!s?.signed_in) { el.innerHTML = ""; return; }
    if (s.is_vendor) {
      el.innerHTML = `${s.rank ? `<span class="lb-pill gold"><i class="fa-solid fa-medal"></i> You are #${s.rank}</span>` : ""}<span class="lb-pill"><i class="fa-solid fa-bolt"></i> ${num(s.week)} pts this week</span>`;
    } else {
      el.innerHTML = `<span class="lb-pill"><i class="fa-solid fa-star"></i> ${num(s.all)} pts</span>`;
    }
  }

  function podiumHtml(rows) {
    const t = rows.slice(0, 3);
    const col = (r, cls, n) => {
      if (!r) return `<div class="lb-pod ${cls}"></div>`;
      return `<div class="lb-pod ${cls}" onclick="navigate('storefront',{vendorId:'${esc(r.vendor_id)}'})" role="link" tabindex="0">
        <div class="lb-pod-crown">${n === 1 ? '<i class="fa-solid fa-award"></i>' : ""}</div>
        <div class="lb-pod-av">${av(r.logo_url, r.business_name, "var(--sz)", "lb-av")}<span class="lb-pod-medal">${n}</span></div>
        <div class="lb-pod-name">${esc(r.business_name)}</div>
        <div class="lb-pod-pts"><b data-count="${r.points}">0</b> pts</div>
        <div class="lb-pod-block"><span class="lb-pod-n">${n}</span><span class="lb-sheen"></span></div>
      </div>`;
    };
    return `<div class="lb-podium">${col(t[1], "second", 2)}${col(t[0], "first", 1)}${col(t[2], "third", 3)}</div>`;
  }

  function rowHtml(r, mine, followed) {
    const gap = mine && !r.is_me && LB.period !== "all"
      ? (r.rank < mine.rank ? `<span class="lb-gap up">${num(r.points - mine.points + 1)} pts to pass</span>` : `<span class="lb-gap down">${num(mine.points - r.points)} pts behind you</span>`)
      : "";
    const sub = [r.city, gap].filter(Boolean).join(" · ");
    const isFol = followed.has(String(r.vendor_id));
    return `<div class="lb-row${r.is_me ? " me" : ""}" data-row onclick="navigate('storefront',{vendorId:'${esc(r.vendor_id)}'})" role="link" tabindex="0">
      <div class="lb-rank">${r.rank}</div><span class="lb-avwrap">${av(r.logo_url, r.business_name, "2.7rem", "lb-av")}${!r.is_me && isFol ? '<i class="fa-solid fa-check lb-folbadge" role="img" aria-label="You follow this vendor" title="You follow this vendor"></i>' : ""}</span>
      <div class="lb-row-copy"><strong><span class="nm">${esc(r.business_name)}</span>${r.is_me ? '<span class="lb-tag you">You</span>' : ""}</strong>${sub ? `<small>${sub}</small>` : ""}</div>
      <div class="lb-row-pts"><b>${num(r.points)}</b>pts</div></div>`;
  }

  function rankingHtml() {
    const chips = `<div class="lb-chips">${PERIODS.map((p) => `<button type="button" class="lb-chip${LB.period === p[0] ? " active" : ""}" onclick="lbSetPeriod('${p[0]}')">${p[1]}</button>`).join("")}</div>`;
    const reward = `<div class="lb-prize"><span class="lb-prize-ico"><i class="fa-solid fa-gift"></i></span><span class="lb-prize-copy"><b>Finish first</b><small>Win a free week of promotion</small></span></div>`;
    const b = LB.boards[LB.period];
    if (!b || (viewCampus() !== "all" && LB.mapReady === false)) return chips + skeleton(7);   // wait for the vendor list so a campus board never flashes other campuses
    const rows = scopeRows(b.rows || []);
    if (!rows.length) return chips + `<div class="lb-card lb-empty"><i class="fa-solid fa-ranking-star"></i><strong>No vendors on the board yet</strong><p>Check back soon.</p></div>`;
    const followed = (window.followedVendorSet && window.followedVendorSet()) || new Set();
    const mine = rows.find((r) => r.is_me) || null;
    let html = chips + reward;
    if (LB.filter === "following") {
      const list = rows.filter((r) => followed.has(String(r.vendor_id)) || r.is_me);
      html += list.length ? `<div class="lb-list">${list.map((r) => rowHtml(r, mine, followed)).join("")}</div>` : `<div class="lb-card lb-empty"><i class="fa-solid fa-heart"></i><strong>You are not following any ranked vendors</strong><p>Follow vendors from their shop pages and they will show up here.</p><button type="button" class="btn btn-outline" onclick="navigate('vendors')">Browse vendors</button></div>`;
      return html;
    }
    const live = rows[0].points > 0;
    if (live) html += podiumHtml(rows);
    else html += `<div class="lb-card lb-empty"><i class="fa-solid fa-seedling"></i><strong>A fresh start</strong><p>${LB.period === "week" ? "No points yet this week. Complete a sale, get a follower or a 5-star review to take the lead." : "No points were earned in this period."}</p></div>`;
    if (mine && isVendor()) {
      const next = mine.rank > 1 ? rows[mine.rank - 2] : null;
      let line, pct = 100;
      if (LB.period === "last_week") line = `You finished #${mine.rank} with ${num(mine.points)} pts`;
      else if (mine.points <= 0) { line = "Earn points to enter the race"; pct = 0; }
      else if (!next) line = "You are leading";
      else { line = `${num(next.points - mine.points + 1)} pts to pass ${esc(next.business_name)}`; pct = Math.max(4, Math.min(100, (mine.points / Math.max(1, next.points)) * 100)); }
      html += `<div class="lb-me"><div class="lb-me-rank">#${mine.rank}</div><div class="lb-me-copy"><strong>Your position</strong><span>${line}</span>${LB.period === "last_week" ? "" : `<div class="lb-me-bar"><i data-w="${pct}"></i></div>`}</div><div class="lb-me-pts"><b>${num(mine.points)}</b>pts</div></div>`;
    }
    const rest = live ? rows.slice(3) : rows;
    html += `<div class="lb-list">${rest.map((r) => rowHtml(r, mine, followed)).join("")}</div>`;
    return html;
  }

  function chartSvg(series, labels, tipFn) {
    const W = 320, H = 170, base = 138, top = 14, n = series.length, max = Math.max(1, ...series.map((s) => s));
    const slot = (W - 20) / n, bw = Math.min(26, slot * 0.62);
    let bars = "";
    series.forEach((v, i) => {
      const h = v > 0 ? Math.max(4, (v / max) * (base - top)) : 2;
      const x = 10 + i * slot + (slot - bw) / 2;
      bars += `<g class="lb-bar${i === n - 1 ? " today" : ""}" data-i="${i}" onclick="lbChartTap(${i})"><rect class="b" x="${x.toFixed(1)}" y="${(base - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="5"/><rect class="hit" x="${(10 + i * slot).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${base + 20}"/></g>`;
    });
    const axis = labels.map((l, i) => `<text x="${(10 + i * slot + slot / 2).toFixed(1)}" y="${H - 8}">${esc(l)}</text>`).join("");
    return `<svg class="lb-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Points over time"><defs><linearGradient id="lbBarGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8f81f5"/><stop offset="1" stop-color="#4b9bf5"/></linearGradient></defs>
      <g class="lb-grid"><line x1="10" x2="${W - 10}" y1="${top}" y2="${top}"/><line x1="10" x2="${W - 10}" y1="${(top + base) / 2}" y2="${(top + base) / 2}"/><line x1="10" x2="${W - 10}" y1="${base}" y2="${base}" style="stroke-dasharray:none"/></g>${bars}<g class="lb-axis">${axis}</g></svg>`;
  }
  function chartData() {
    const s = LB.summary || {};
    if (LB.chartMode === "weekly") {
      const w = s.weekly || [];
      return { series: w.map((x) => x.points), labels: w.map((x) => { const d = new Date(x.week_start + "T00:00:00"); return `${d.getDate()}/${d.getMonth() + 1}`; }), tips: w.map((x) => `Week of ${new Date(x.week_start + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`), total: w.reduce((a, x) => a + x.points, 0), range: "Last 8 weeks" };
    }
    const d = s.daily || [];
    return { series: d.map((x) => x.points), labels: d.map((x) => "SMTWTFS"[new Date(x.date + "T00:00:00").getDay()]), tips: d.map((x) => new Date(x.date + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })), total: d.reduce((a, x) => a + x.points, 0), range: "Last 14 days" };
  }

  // Points to wallet cash: 1 point = ₦1, up to 100 points a day, points at least 24 hours old. The rules are enforced in the database.
  function cashHtml() {
    const c = LB.cash; if (!c) return "";
    const can = c.can_convert || 0, wait = c.waiting || 0;
    const note = can > 0 ? `Ready to convert: <b>${num(can)} points</b> = <b>₦${num(can)}</b>` : (c.converted_today >= c.daily_limit ? "You have converted the most you can today. Come back tomorrow." : "No points ready yet. Points can be converted 24 hours after you earn them.");
    return `<div class="lb-card lb-cash"><h3>Convert points to cash</h3><p class="lb-sub">100 points = ₦100, straight into your Levromart wallet. Up to ${num(c.daily_limit)} points a day.</p>
      <p style="margin:.2rem 0 .6rem">${note}</p>${wait > 0 ? `<p class="lb-sub" style="margin:0 0 .6rem">${num(wait)} more points will be ready within 24 hours.</p>` : ""}
      <button type="button" class="btn" ${can > 0 ? "" : "disabled"} onclick="lbConvertPoints()"><i class="fa-solid fa-wallet"></i> Convert ${can > 0 ? num(can) + " points" : "points"}</button></div>`;
  }
  window.lbConvertPoints = async function () {
    const can = LB.cash?.can_convert || 0; if (can <= 0) return;
    const ok = await showConfirmDialog("Convert " + can + " points to ₦" + can + " in your wallet? This cannot be undone.", { title: "Convert points", okLabel: "Convert" });
    if (!ok) return;
    try {
      const { data, error } = await sb.rpc("convert_points_to_wallet", { p_points: can }); if (error) throw error;
      if (!data?.ok) { showToast(data?.message || "Could not convert your points.", "error"); }
      else { showToast("₦" + num(can) + " added to your wallet.", "success"); }
      await loadSummary();
    } catch (e) { showToast(e?.message || "Could not convert your points.", "error"); }
    if (LB.tab === "mine") renderBody(false);
  };

  function mineHtml() {
    if (!signedIn()) return loginCta("Sign in to see your points, activity and progress.");
    const s = LB.summary;
    if (!s) return skeleton(6);
    const t = tierFor(s.all);
    const cd = chartData();
    const bd = (LB.bdMode === "all" ? s.breakdown_all : s.breakdown_week) || [];
    const bdMax = Math.max(1, ...bd.map((x) => Math.abs(x.points)));
    let html = cashHtml() + `<div class="lb-card"><div class="lb-total"><div class="lb-total-num"><small>All-time points</small><span data-count="${s.all}">0</span></div><span class="lb-tier"><i class="fa-solid ${t.icon}"></i> ${t.name}</span></div>
      <div class="lb-tier-bar"><i data-w="${t.pct}"></i></div><div class="lb-tier-note">${t.next ? `${num(t.need)} more points to reach ${t.next[1]}` : "You have reached the top tier"}</div></div>
      <div class="lb-stats">
        <div class="lb-stat"><small><i class="fa-solid fa-sun"></i>Today</small><b data-count="${s.today}">0</b></div>
        <div class="lb-stat"><small><i class="fa-solid fa-calendar-week"></i>This week</small><b data-count="${s.week}">0</b></div>
        <div class="lb-stat"><small><i class="fa-solid fa-calendar-days"></i>This month</small><b data-count="${s.month}">0</b></div>
        <div class="lb-stat"><small><i class="fa-solid fa-infinity"></i>All time</small><b data-count="${s.all}">0</b></div></div>
      <div class="lb-streaks"><div class="lb-streak fire"><i class="fa-solid fa-fire"></i><div><b>${s.streak} day${s.streak === 1 ? "" : "s"}</b><span>Points streak</span></div></div>${s.is_vendor ? `<div class="lb-streak crown"><i class="fa-solid fa-award"></i><div><b>${s.weeks_won}</b><span>Weeks won</span></div></div>` : ""}</div>
      <div class="lb-card"><div class="lb-chart-head"><div><h3>Points over time</h3><div class="lb-chart-read" id="lbChartRead">${cd.range}: <b>${num(cd.total)} pts</b></div></div><div class="lb-seg"><button type="button" class="${LB.chartMode === "daily" ? "active" : ""}" onclick="lbSetChart('daily')">Daily</button><button type="button" class="${LB.chartMode === "weekly" ? "active" : ""}" onclick="lbSetChart('weekly')">Weekly</button></div></div>${chartSvg(cd.series, cd.labels)}</div>
      <div class="lb-card"><div class="lb-chart-head"><div><h3>Points breakdown</h3></div><div class="lb-seg"><button type="button" class="${LB.bdMode === "week" ? "active" : ""}" onclick="lbSetBd('week')">This week</button><button type="button" class="${LB.bdMode === "all" ? "active" : ""}" onclick="lbSetBd('all')">All time</button></div></div>
        ${bd.length ? `<div class="lb-bd" style="margin-top:.7rem">${bd.map((x) => `<div class="lb-bd-row"><span class="lb-bd-ico"><i class="fa-solid ${esc(x.icon)}"></i></span><strong>${esc(x.label)}<small>× ${x.count}</small></strong><b>+${num(x.points)}</b><div class="lb-bd-track"><i data-w="${Math.max(3, (Math.abs(x.points) / bdMax) * 100)}"></i></div></div>`).join("")}</div>` : `<p class="lb-sub" style="margin-top:.6rem">Nothing here yet. See the Earn points tab for ways to get started.</p>`}</div>
      <div class="lb-card"><h3>Recent activity</h3><p class="lb-sub">Every point you earn, newest first.</p>
        <div class="lb-act">${LB.activity.length ? LB.activity.map((a) => `<div class="lb-act-row"><span class="lb-act-ico"><i class="fa-solid ${esc(a.icon || "fa-star")}"></i></span><div class="lb-act-copy"><strong>${esc(a.note || a.label)}</strong><small>${esc(a.source_name ? a.source_name + " · " : "")}${timeAgo(a.created_at)}</small></div><span class="lb-act-pts${a.points < 0 ? " neg" : ""}">${a.points > 0 ? "+" : ""}${num(a.points)}</span></div>`).join("") : `<div class="lb-empty" style="padding:1rem 0"><strong>No activity yet</strong><p class="muted">Your points will appear here the moment you earn them.</p></div>`}</div>
        ${LB.activity.length && !LB.activityDone ? `<button type="button" class="btn btn-outline btn-sm" style="margin-top:.7rem" onclick="lbMoreActivity()">Load more</button>` : ""}</div>`;
    return html;
  }

  window.lvSaleTiersHtml = function () {
    return `<div class="lb-card lv-tiers"><h3>Points for every sale</h3><p class="lb-sub">Every completed sale earns points. The bigger the sale, the more you earn.</p><div class="lv-tier-rows"><div class="lv-tier"><b>+20</b><span>Sale under ₦1,000</span></div><div class="lv-tier"><b>+50</b><span>Sale from ₦1,000 to ₦5,000</span></div><div class="lv-tier"><b>+100</b><span>Sale above ₦5,000</span></div></div></div>`;
  };
  function earnHtml() {
    const rules = LB.rules;
    if (!rules) return skeleton(6);
    const top = Math.max(...rules.map((r) => r.points));
    const groups = {};
    rules.forEach((r) => { (groups[r.category] = groups[r.category] || []).push(r); });
    const done = new Set(LB.summary?.socials || []);
    let html = `<div class="lb-card"><h3>How points work</h3><p class="lb-sub" style="margin:0">Points are added automatically the moment something happens on Levromart. The board resets every Monday at 12:00 am, so everyone starts level and new vendors can win straight away. The vendor with the most points each week becomes Vendor of the Week. A completed sale is the biggest earner.</p></div>`;
    html += window.lvSaleTiersHtml();
    Object.keys(CAT).forEach((k) => {
      const g = groups[k]; if (!g) return;
      html += `<div class="lb-rule-group"><h4>${CAT[k][0]}</h4>${g.map((r) => {
        const caps = [r.daily_cap ? `up to ${r.daily_cap} a day` : "", r.weekly_cap ? `up to ${r.weekly_cap} a week` : ""].filter(Boolean).join(", ");
        return `<div class="lb-rule${r.points === top ? " top" : ""}" style="--ic:${CAT[k][1]}"><span class="lb-rule-ico"><i class="fa-solid ${esc(r.icon)}"></i></span><div class="lb-rule-copy"><strong>${esc(r.label)}${r.points === top ? '<span class="lb-tag you" style="background:var(--lb-gold);color:#5a3b00">Biggest</span>' : ""}</strong><p>${esc(r.description)}${caps ? ` (${caps})` : ""}</p></div><span class="lb-rule-pts">${r.kind === "order_completed" ? "+20 to +100" : "+" + r.points}</span></div>`;
      }).join("")}</div>`;
    });
    html += `<div class="lb-card"><h3>Follow Levromart, earn points</h3><p class="lb-sub">Each platform is worth 5 points, once. Your referrer earns 5 too.</p>
      <ol class="lb-steps"><li><b>1</b><span>Tap a platform below and follow our page.</span></li><li><b>2</b><span>Take a screenshot that shows you are following us.</span></li><li><b>3</b><span>Send the screenshot on WhatsApp to <a href="${waLink("")}" target="_blank" rel="noopener noreferrer">${WA_DISPLAY}</a> so your points can be added.</span></li></ol>
      <div class="lb-social">${SOCIALS.map((s) => `<button type="button" class="${done.has(s[0]) ? "done" : ""}" onclick="lbSocial('${s[0]}')"><img src="${s[2]}" alt="" loading="lazy"><span>${s[1]}<small>${done.has(s[0]) ? "Points added" : "+5 after we confirm"}</small></span></button>`).join("")}</div>
      <a class="btn lb-wa" href="${waLink("")}" target="_blank" rel="noopener noreferrer"><i class="fa-brands fa-whatsapp"></i> Send screenshot on WhatsApp</a></div>
      ${profile?.role === "admin" ? `<div class="lb-card"><h3>Admin: add social points</h3><p class="lb-sub"><a href="#" onclick="navigate('adminPoints');return false;" style="font-weight:700;text-decoration:underline">Open the Points manager</a> to add or remove points for anyone.</p><p class="lb-sub">Enter the phone number the customer sent their screenshot from (or the one on their account) and pick the platform.</p><div class="lb-apply"><input id="lbAdminPhone" type="tel" placeholder="Phone number" style="text-transform:none;letter-spacing:0"><select id="lbAdminPlatform"><option value="instagram">Instagram</option><option value="tiktok">TikTok</option><option value="linkedin">LinkedIn</option></select><button type="button" class="btn" onclick="lbAdminAward()">Add</button></div></div>` : ""}
      <div class="lb-card"><h3>Fair play</h3><p class="lb-sub">Keeping the board honest.</p><ul class="lb-fair">
        <li><i class="fa-solid fa-circle-check"></i>Only real activity counts. You cannot earn points from your own orders or by following or reviewing yourself.</li>
        <li><i class="fa-solid fa-circle-check"></i>A sale earns 20 points under ₦1,000, 50 points from ₦1,000 to ₦5,000 and 100 points above ₦5,000. Sales to the same customer count up to ${rules.find((x) => x.kind === "order_completed")?.per_source_weekly_cap ?? 5} times a week.</li>
        <li><i class="fa-solid fa-circle-check"></i>Each event is counted once: following, unfollowing and following again earns nothing extra.</li>
        <li><i class="fa-solid fa-circle-check"></i>If an order is cancelled or disputed after completion, its points are taken back.</li>
        <li><i class="fa-solid fa-circle-check"></i>A new listing earns points once. If you delete a listing, its points are taken back. Pausing and unpausing earns or loses nothing.</li>
        <li><i class="fa-solid fa-circle-check"></i>Referral codes must be added within 7 days of creating an account. Vendor referrals pay out once the new vendor is verified.</li>
        <li><i class="fa-solid fa-circle-check"></i>Levromart may remove points earned unfairly. Ties are decided by completed sales, then by who reached the points first.</li></ul></div>`;
    return html;
  }

  function referLink(code) { return `${location.origin}/?ref=${encodeURIComponent(code)}`; }
  function referHtml() {
    if (!signedIn()) return loginCta("Sign in to get your referral code and track who you have brought in.");
    const s = LB.summary;
    if (!s) return skeleton(5);
    const rules = Object.fromEntries((LB.rules || []).map((r) => [r.kind, r.points]));
    const P = (k, d) => rules[k] ?? d;
    const refs = s.referrals || {};
    let html = "";
    if (s.referral_code) {
      html += `<div class="lb-code"><small>Your referral code</small><div class="lb-code-val" onclick="lbCopy('${esc(s.referral_code)}','Referral code copied')">${esc(s.referral_code)}</div><p>Share it with customers and other vendors. You earn every time it is used.</p>
        <div class="lb-code-actions"><button type="button" onclick="lbCopy('${esc(referLink(s.referral_code))}','Referral link copied')"><i class="fa-regular fa-copy"></i> Copy link</button><button type="button" class="alt" onclick="lbShareCode()"><i class="fa-brands fa-whatsapp"></i> WhatsApp</button><button type="button" onclick="lbShareMore()"><i class="fa-solid fa-share-nodes"></i> More</button></div></div>
        <div class="lb-stats"><div class="lb-stat"><small><i class="fa-solid fa-user-plus"></i>Customers</small><b data-count="${refs.referred_customers || 0}">0</b></div><div class="lb-stat"><small><i class="fa-solid fa-store"></i>Vendors</small><b data-count="${refs.referred_vendors || 0}">0</b></div><div class="lb-stat"><small><i class="fa-solid fa-sitemap"></i>Second level</small><b data-count="${refs.second_level || 0}">0</b></div><div class="lb-stat"><small><i class="fa-solid fa-star"></i>Points earned</small><b data-count="${refs.points_earned || 0}">0</b></div></div>`;
    } else {
      html += `<div class="lb-card"><h3>Refer and earn</h3><p class="lb-sub" style="margin:0">Your referral code is getting ready. Open your own shop on Levromart to get a code, earn points every time it is used and compete for Vendor of the Week.</p><button type="button" class="btn" style="margin-top:.75rem" onclick="navigate('vendorApply')">Become a vendor</button></div>`;
    }
    html += `<div class="lb-card"><h3>How referral points work</h3><p class="lb-sub">Points arrive on their own, nothing to claim.</p><div class="lb-flow">
      <div class="lb-flow-step"><i class="ic fa-solid fa-store"></i><div><strong>A vendor joins with your code</strong><span>Paid once they are verified</span></div><em>+${P("ref_vendor", 50)}</em></div>
      <div class="lb-flow-step"><i class="ic fa-solid fa-user-plus"></i><div><strong>A customer joins with your code</strong><span>Vendors earn more than customers</span></div><em>+${P("ref_customer", 20)}</em></div>
      <div class="lb-flow-step"><i class="ic fa-solid fa-box-open"></i><div><strong>Your vendor lists a product</strong><span>First 10 listings per vendor</span></div><em>+${P("ref_vendor_product", 2)} each</em></div>
      <div class="lb-flow-step"><i class="ic fa-solid fa-sitemap"></i><div><strong>Your vendor refers a vendor</strong><span>Second level, paid when verified</span></div><em>+${P("ref2_vendor", 25)}</em></div>
      <div class="lb-flow-step"><i class="ic fa-solid fa-people-arrows"></i><div><strong>Your vendor refers a customer</strong><span>Second level</span></div><em>+${P("ref2_customer", 10)}</em></div>
      <div class="lb-flow-step"><i class="ic fa-solid fa-hashtag"></i><div><strong>Your referral follows our socials</strong><span>Once per platform, after they send their screenshot</span></div><em>+${P("ref_social", 5)}</em></div></div></div>`;
    if ((refs.recent || []).length) {
      html += `<div class="lb-card"><h3>Recently joined with your code</h3><div class="lb-mini-list" style="margin-top:.4rem">${refs.recent.map((r) => `<div class="lb-mini"><i class="fa-solid ${r.role === "vendor" ? "fa-store" : "fa-user"}"></i><span>${esc(r.name)} <span class="muted">· ${r.role}</span></span><small>${timeAgo(r.at)}</small></div>`).join("")}</div></div>`;
    }
    if (refs.referred_by) {
      html += `<div class="lb-card"><h3>You joined with a referral</h3><p class="lb-sub" style="margin:0">Referred by <strong>${esc(refs.referred_by)}</strong>.</p></div>`;
    } else {
      html += `<div class="lb-card"><h3>Have a referral code?</h3><p class="lb-sub">Add it within 7 days of creating your account so the person who invited you gets credit.</p><div class="lb-apply"><input id="lbApplyInput" placeholder="Enter code" maxlength="16" autocomplete="off" value="${esc(localStorage.getItem("levro-ref-code") || "")}"><button type="button" class="btn" onclick="lbApplyCode()">Apply</button></div></div>`;
    }
    return html;
  }

  function winnersHtml() {
    if (!LB.winners) return skeleton(5);
    const cc = campusOnly();
    if (cc && LB.winnersFor !== cc && LB.winnersBusy) return skeleton(5);
    const scoped = !!cc && LB.winnersFor === cc, keep = (id) => scoped || inView(id);
    const w = LB.spot?.winner && keep(LB.spot.winner.vendor_id) ? LB.spot.winner : null;
    let html = "";
    if (w) {
      html += `<div class="lb-champ" onclick="navigate('storefront',{vendorId:'${esc(w.vendor_id)}'})"><div class="crown"><i class="fa-solid fa-award"></i></div>${av(w.logo_url, w.business_name, "4.6rem", "lb-av")}<h3>${esc(w.business_name)}</h3><p>${esc([w.city, w.review_count ? `${Number(w.avg_rating || 0).toFixed(1)} ★ (${w.review_count})` : ""].filter(Boolean).join(" · "))}</p><span class="lb-pill"><i class="fa-solid fa-award"></i> Vendor of the Week · ${num(w.points)} pts</span></div>`;
    }
    html += `<div class="lb-card"><h3>Hall of fame</h3><p class="lb-sub" style="margin:0">A new Vendor of the Week is crowned every Monday, based on the previous week's points.</p></div>`;
    if (!LB.winners.filter((x) => keep(x.vendor_id)).length) return html + `<div class="lb-card lb-empty"><i class="fa-solid fa-award"></i><strong>The first winner is coming soon</strong><p>The week ends in <span data-lb-countdown>${countdownText()}</span>. Every point counts.</p></div>`;
    html += LB.winners.filter((x) => keep(x.vendor_id)).map((x) => {
      const d = new Date(x.week_start + "T00:00:00"), e = new Date(d.getTime() + 6 * 864e5);
      const f = (z) => z.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
      const others = (x.top3 || []).slice(1).map((o) => esc(o.business_name)).join(", ");
      return `<div class="lb-win" onclick="navigate('storefront',{vendorId:'${esc(x.vendor_id)}'})"><div class="wk">${f(d)}<br>to ${f(e)}</div>${av(x.logo_url, x.business_name, "2.6rem", "lb-av")}<div class="lb-win-copy"><strong>${esc(x.business_name)} <i class="fa-solid fa-award"></i></strong>${others ? `<small>Also on the podium: ${others}</small>` : ""}</div><b>${num(x.points)}</b></div>`;
    }).join("");
    return html;
  }

  // ---------- render + animate ----------
  function renderBody(animate) {
    const body = $("lbBody"); if (!body) return;
    const fn = { ranking: rankingHtml, mine: mineHtml, earn: earnHtml, refer: referHtml, winners: winnersHtml }[LB.tab] || rankingHtml;
    body.innerHTML = fn();
    heroPills();
    paintScopeSeg();
    paintScope();
    ensureHeroWinner();
    postRender(animate);
  }
  function postRender(animate) {
    const body = $("lbBody"); if (!body) return;
    body.querySelectorAll("[data-count]").forEach((el) => countUp(el, el.dataset.count, animate ? 850 : 1));
    body.querySelectorAll("[data-w]").forEach((el) => {
      el.style.width = el.dataset.w + "%"; el.style.transformOrigin = "left";
      if (animate) anim(el, [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: 900, delay: 120 });
    });
    if (animate) {
      body.querySelectorAll(".lb-pod").forEach((p, i) => {
        const order = p.classList.contains("first") ? 2 : p.classList.contains("second") ? 0 : 1;
        anim(p, [{ opacity: 0, transform: "translateY(34px)" }, { opacity: 1, transform: "none" }], { duration: 650, delay: order * 140 });
        const blk = p.querySelector(".lb-pod-block"); if (blk) { blk.style.transformOrigin = "bottom"; anim(blk, [{ transform: "scaleY(.05)" }, { transform: "scaleY(1)" }], { duration: 750, delay: order * 140 }); }
      });
      body.querySelectorAll("[data-row],.lb-win,.lb-rule,.lb-act-row").forEach((el, i) => { if (i < 14) anim(el, [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: 420, delay: 80 + i * 35 }); });
      body.querySelectorAll(".lb-bar").forEach((g, i) => anim(g, [{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], { duration: 650, delay: i * 28 }));
    }
    body.querySelectorAll(".lb-pod.first .lb-pod-crown i,.lb-champ .crown i").forEach((c) => anim(c, [{ transform: "translateY(0) rotate(-6deg)" }, { transform: "translateY(-5px) rotate(6deg)" }], { duration: 1400, iterations: Infinity, direction: "alternate", easing: "ease-in-out" }));
    body.querySelectorAll(".lb-pod.first .lb-sheen").forEach((s) => anim(s, [{ transform: "translateX(-130%)" }, { transform: "translateX(130%)" }], { duration: 1800, iterations: Infinity, delay: 900, easing: "ease-in-out" }));
    body.querySelectorAll(".lb-pod.first .lb-pod-av").forEach((s) => anim(s, [{ boxShadow: "0 8px 18px rgba(233,169,18,.35)" }, { boxShadow: "0 8px 30px rgba(233,169,18,.75)" }], { duration: 1500, iterations: Infinity, direction: "alternate", easing: "ease-in-out" }));
  }

  function confetti() {
    if (reduced()) return;
    const old = $("lbConfetti"); if (old) old.remove();
    const c = document.createElement("canvas"); c.id = "lbConfetti"; document.body.appendChild(c);
    const ctx = c.getContext("2d"); const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = innerWidth * dpr; c.height = innerHeight * dpr; ctx.scale(dpr, dpr);
    const cols = ["#fbd45a", "#e9a912", "#8f81f5", "#4b9bf5", "#34d399", "#f472b6"];
    const ps = Array.from({ length: 110 }, () => ({ x: innerWidth / 2 + (Math.random() - .5) * 120, y: innerHeight * .35, vx: (Math.random() - .5) * 11, vy: -Math.random() * 11 - 3, s: 5 + Math.random() * 6, r: Math.random() * 6, vr: (Math.random() - .5) * .4, c: cols[(Math.random() * cols.length) | 0] }));
    const t0 = performance.now();
    (function frame(t) {
      const el = t - t0; ctx.clearRect(0, 0, innerWidth, innerHeight);
      ps.forEach((p) => { p.vy += .28; p.x += p.vx; p.y += p.vy; p.vx *= .992; p.r += p.vr; ctx.save(); ctx.globalAlpha = Math.max(0, 1 - el / 2600); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 3, p.s, p.s * .6); ctx.restore(); });
      if (el < 2700) requestAnimationFrame(frame); else c.remove();
    })(t0);
  }
  window.lbConfetti = confetti;

  // ---------- actions ----------
  window.lbSetTab = function (tab) {
    LB.tab = tab;
    if (tab === "ranking") LB.filter = "all";
    document.querySelectorAll(".lb-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    renderBody(true);
    if (tab === "mine") { if (!LB.activity.length) loadActivity(false).then(() => { if (LB.tab === "mine") renderBody(false); }); }
    if (tab === "winners" && !LB.winners) loadWinners().then(() => { if (LB.tab === "winners") renderBody(true); });
    if (tab === "earn" || tab === "refer") loadRules().then(() => { if (LB.tab === tab) renderBody(false); });
    document.querySelector(".lb-tab.active")?.scrollIntoView({ block: "nearest", inline: "center" });
  };
  window.lbSetPeriod = async function (p) {
    LB.period = p; renderBody(false);
    if (!LB.boards[p] || Date.now() - LB.boards[p].at > 20000) { await loadBoard(p); if (LB.tab === "ranking" && LB.period === p) renderBody(true); }
    else renderBody(true);
  };
  window.lbSetFilter = function (f) { LB.filter = f; renderBody(false); };
  window.lbSetChart = function (m) { LB.chartMode = m; renderBody(false); const g = document.querySelectorAll(".lb-bar"); g.forEach((x, i) => anim(x, [{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], { duration: 550, delay: i * 22 })); };
  window.lbSetBd = function (m) { LB.bdMode = m; renderBody(true); };
  window.lbChartTap = function (i) {
    const cd = chartData();
    document.querySelectorAll(".lb-bar").forEach((g) => g.classList.toggle("on", Number(g.dataset.i) === i));
    const r = $("lbChartRead"); if (r) r.innerHTML = `${esc(cd.tips[i])}: <b>${num(cd.series[i])} pts</b>`;
  };
  window.lbMoreActivity = async function () { await loadActivity(true); if (LB.tab === "mine") renderBody(false); };
  window.lbCopy = async function (text, msg) {
    try { await navigator.clipboard.writeText(text); showToast(msg || "Copied.", "success"); }
    catch (_) { try { const t = document.createElement("textarea"); t.value = text; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove(); showToast(msg || "Copied.", "success"); } catch (e) { showToast(text, "info"); } }
  };
  window.lbShareCode = function () {
    const code = LB.summary?.referral_code; if (!code) return;
    const text = `Join me on Levromart, Nigeria's marketplace to buy, sell and connect. Use my referral code ${code}: ${referLink(code)}`;
    window.lvOpenWhatsApp(text);
  };
  window.lbShareMore = function () {
    const code = LB.summary?.referral_code; if (!code) return;
    const text = `Join me on Levromart, Nigeria's marketplace to buy, sell and connect. Use my referral code ${code}: ${referLink(code)}`;
    if (navigator.share) { navigator.share({ title: "Join Levromart", text }).catch(() => {}); } else { lbCopy(text, "Invite copied"); }
  };
  // Social points are confirmed by hand: follow, screenshot, send it on WhatsApp.
  window.trackSocialClick = function () {};
  window.lbSocial = function (platform) {
    const s = SOCIALS.find((x) => x[0] === platform); if (!s) return;
    window.open(s[3], "_blank", "noopener,noreferrer");
    showToast(`Follow us, then screenshot it and send it on WhatsApp to ${WA_DISPLAY} for your points.`, "info");
  };
  window.lbAdminAward = async function () {
    const phone = String($("lbAdminPhone")?.value || "").trim(), platform = $("lbAdminPlatform")?.value;
    if (!phone) { showToast("Enter a phone number first.", "info"); return; }
    const { data, error } = await sb.rpc("admin_award_social_points", { p_phone: phone, p_platform: platform });
    if (error || !data?.ok) { showToast(data?.message || error?.message || "Could not add points.", "error"); return; }
    showToast(data.already ? `${data.name || "This person"} already has ${platform} points.` : `Added ${data.awarded} points to ${data.name || "the account"}${data.referrer_awarded ? ` and ${data.referrer_awarded} to their referrer` : ""}.`, data.already ? "info" : "success");
    const el = $("lbAdminPhone"); if (el) el.value = "";
  };
  window.lbApplyCode = async function () {
    const input = $("lbApplyInput");
    const code = String(input?.value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!code) { showToast("Enter a referral code first.", "info"); return; }
    if (!signedIn()) { showToast("Sign in first, then enter the code.", "info"); return; }
    const btn = input?.parentElement?.querySelector("button"); if (btn) { btn.disabled = true; btn.dataset.t = btn.textContent; btn.textContent = "Checking..."; }
    const reasons = { invalid: "That referral code was not found. Check the spelling.", already_used: "You have already used a referral code.", too_late: "Referral codes can only be added within 7 days of creating your account.", own_code: "You cannot use your own referral code.", not_signed_in: "Please sign in first.", no_profile: "Your profile is still being set up. Try again in a moment." };
    try {
      const { data, error } = await sb.rpc("apply_referral_code", { p_code: code });
      if (error || !data?.ok) { showToast(data?.message || reasons[data?.error] || "Could not apply that code. Please try again.", "error"); return; }
      try { localStorage.removeItem("levro-ref-code"); } catch (_) {}
      showToast(`Referral applied. You joined with ${data.business_name}'s code.`, "success");
      await loadSummary(); if (LB.tab === "refer") renderBody(false);
    } catch (e) {
      showToast("Could not reach the server. Check your connection and try again.", "error");
    } finally { if (btn) { btn.disabled = false; btn.textContent = btn.dataset.t || "Apply"; } }
  };

  // A code from a ?ref= link or the sign-up form is applied once the account exists.
  window.lbApplyPendingReferral = async function () {
    let code = ""; try { code = localStorage.getItem("levro-ref-code") || ""; } catch (_) {}
    if (!code || !signedIn()) return;
    try {
      const { data } = await sb.rpc("apply_referral_code", { p_code: code });
      if (data?.ok) showToast(`Welcome! You joined with ${data.business_name}'s referral code.`, "success");
      if (data?.ok || ["already_used", "too_late", "own_code", "invalid"].includes(data?.error)) localStorage.removeItem("levro-ref-code");
    } catch (_) {}
  };

  // ---------- live ----------
  function stopLive() {
    try { if (LB.channel) sb.removeChannel(LB.channel); } catch (_) {}
    LB.channel = null; clearInterval(LB.tick); clearInterval(LB.poll); LB.tick = LB.poll = null; clearTimeout(LB.deb);
  }
  async function refreshLive() {
    if (currentView !== "leaderboard") { stopLive(); return; }
    const before = LB.summary;
    await Promise.all([loadBoard(LB.period, true), loadBoard("week", true), loadSummary()]);
    if (currentView !== "leaderboard") return;
    const after = LB.summary;
    if (before && after && after.all > before.all) {
      showToast(`+${num(after.all - before.all)} points`, "success");
      if (after.rank && before.rank && after.rank < before.rank && after.rank <= 3) confetti();
    }
    if (LB.tab === "mine") loadActivity(false).then(() => { if (LB.tab === "mine") renderBody(false); });
    renderBody(false);
  }
  function startLive() {
    stopLive();
    LB.tick = setInterval(tickCountdown, 30000);
    LB.poll = setInterval(() => { if (!document.hidden) refreshLive(); }, 60000);
    try {
      LB.channel = sb.channel("lb-live-" + Date.now()).on("postgres_changes", { event: "*", schema: "public", table: "points_weekly" }, () => {
        clearTimeout(LB.deb); LB.deb = setTimeout(refreshLive, 900);
      }).subscribe();
    } catch (_) {}
  }

  // the two faces in the header drift up and down, out of step, like bubbles (WAAPI: CSS animation is off app-wide)
  function floatFaces() {
    if (reduced()) return;
    document.querySelectorAll(".lb-hero-people img").forEach((img, i) => {
      try { img.animate([{ transform: "translateY(0) rotate(0deg)" }, { transform: `translateY(${i ? -5 : -7}px) rotate(${i ? -2 : 2}deg)` }, { transform: "translateY(0) rotate(0deg)" }], { duration: i ? 3400 : 2800, delay: i ? 600 : 0, iterations: Infinity, easing: "ease-in-out" }); } catch (_) {}
    });
  }
  window.initLeaderboardPage = async function () {
    const tok = ++LB.token;
    floatFaces();
    startLive();
    const wantSummary = signedIn();
    const tasks = [loadBoard(LB.period), loadRules()];
    if (wantSummary) tasks.push(loadSummary());
    if (LB.tab === "winners") tasks.push(loadWinners());
    if (LB.tab === "mine") tasks.push(loadActivity(false));
    // paint cached data straight away while the fresh copies load
    if (LB.boards[LB.period]) renderBody(false);
    await Promise.all(tasks);
    if (tok !== LB.token || currentView !== "leaderboard") return;
    renderBody(true);
    const s = LB.summary;
    try {
      const key = "levro-lb-celebrated-" + (s?.week_start || "");
      if (s?.is_vendor && s.rank === 1 && s.week > 0 && !sessionStorage.getItem(key)) { sessionStorage.setItem(key, "1"); setTimeout(confetti, 500); }
    } catch (_) {}
    if (!LB.winners && LB.tab !== "winners") loadWinners();
  };

  // ---------- home card ----------
  let spotAt = 0, spotBusy = false;
  async function homeSpot() {
    const cc = campusOnly(), want = cc || null;
    if (LB.spot && (LB.spotFor || null) === want && Date.now() - spotAt < 90000) return LB.spot;
    for (let waited = 0; spotBusy && waited < 4000; waited += 100) await new Promise((r) => setTimeout(r, 100));   // a request for another campus is still running: wait for it, then ask again
    if (LB.spot && (LB.spotFor || null) === want && Date.now() - spotAt < 90000) return LB.spot;
    spotBusy = true;
    try {
      let data = null, usedCampus = null;
      if (want) {
        const r = LB.cwFailed ? { error: true } : await sb.rpc("get_campus_vendor_spotlight", { p_campus: want });
        if (r.error) { LB.cwFailed = true; } else { data = r.data; usedCampus = want; }
      }
      if (!data && want && LB.cwFailed) { const fb = await campusFromBoards(want); if (fb) { data = fb.spot; usedCampus = want; } }
      if (!data) { const r = await sb.rpc("get_vendor_spotlight"); data = r.data; usedCampus = null; }
      if (data) { LB.spot = data; LB.spotFor = usedCampus; spotAt = Date.now(); }
    } catch (_) {} finally { spotBusy = false; }
    return LB.spot;
  }
  function homeCardHtml(spot) {
    const w = spot?.winner, leaders = spot?.leaders || [];
    const faces = (w ? [w] : leaders).slice(0, 3).map((x) => av(x.logo_url, x.business_name, "1.95rem", "lb-av")).join("") || "";
    const title = w ? `Vendor of the Week: ${esc(w.business_name)}` : "Vendor Leaderboard";
    const lead = leaders[0];
    const sub = w ? `New race ends in ${countdownText()} · tap to see the board` : lead ? `Ends in ${countdownText()} · ${esc(lead.business_name)} leads with ${num(lead.points)} pts` : `Ends in ${countdownText()} · see who is most active`;
    return `<div class="home-lb-card" id="homeLbCard" role="link" tabindex="0" onclick="navigate('leaderboard')"><div class="home-lb-ico"><i class="fa-solid ${w ? "fa-award" : "fa-award"}"></i></div><div class="home-lb-copy"><strong>${title}</strong><span>${sub}</span></div><div class="home-lb-av">${faces}</div><i class="fa-solid fa-chevron-right go"></i></div>`;
  }
  window.lvVendorSpot = () => homeSpot();
  // the whole-app winner of last week, whichever campus is chosen
  window.lvOverallSpot = async () => {
    if (LB.overall && Date.now() - (LB.overallAt || 0) < 90000) return LB.overall;
    try { const { data } = await sb.rpc("get_vendor_spotlight"); if (data) { LB.overall = data; LB.overallAt = Date.now(); } } catch (_) {}
    return LB.overall || null;
  };
  async function mountHomeCard() {
    // The Vendor of the Week now lives as a trophy button in the campus bar (see lv-campus-js); no big card on Home.
    try { $("homeLbCard")?.remove(); } catch (_) {}
    return;
    if (currentView !== "home") return;
    const app = $("app");
    const anchor = () => app?.querySelector(":scope > .levro-home-hero") || app?.querySelector(":scope > .levro-home-cat-rail");
    if (!anchor() || $("homeLbCard")) return;
    const spot = await homeSpot();
    if (currentView !== "home" || $("homeLbCard")) return;
    const a2 = anchor(); if (!a2) return;
    a2.insertAdjacentHTML(a2.classList.contains("levro-home-hero") ? "afterend" : "beforebegin", homeCardHtml(spot));
  }
  window.mountHomeLeaderboardCard = mountHomeCard;
  try {
    const host = $("app");
    if (host) new MutationObserver(() => { if (currentView === "home" && !$("homeLbCard")) { clearTimeout(window.__lbHomeT); window.__lbHomeT = setTimeout(mountHomeCard, 60); } }).observe(host, { childList: true });
  } catch (_) {}

  // ---------- sign-up field + referral application ----------
  function wireSignup() {
    const input = $("loginReferral"); if (!input) return;
    try { const c = localStorage.getItem("levro-ref-code"); if (c) input.value = c; } catch (_) {}
    let t;
    input.addEventListener("input", () => {
      input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
      try { input.value ? localStorage.setItem("levro-ref-code", input.value) : localStorage.removeItem("levro-ref-code"); } catch (_) {}
      const msg = $("loginReferralMsg"); if (!msg) return;
      clearTimeout(t); msg.textContent = "";
      if (input.value.length < 4) return;
      t = setTimeout(async () => {
        try { const { data } = await sb.rpc("validate_referral_code", { p_code: input.value }); msg.style.color = data?.valid ? "#15803d" : "#b45309"; msg.textContent = data?.valid ? `Referred by ${data.business_name}` : "Code not found yet. Check the spelling."; } catch (_) {}
      }, 350);
    });
    if (input.value) input.dispatchEvent(new Event("input"));
  }
  wireSignup();
  try { sb.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_IN") setTimeout(() => window.lbApplyPendingReferral?.(), 2500); }); } catch (_) {}
  setTimeout(() => { if (typeof session !== "undefined" && session) window.lbApplyPendingReferral?.(); }, 4000);
})();

/* ---- levromart-admin-points-js ---- */
/* ===== Admin: points manager ===== */
(function () {
  const AP = (window.__ap = { rows: [], sel: null, adj: [], skips: null, busy: false });
  const $ = (id) => document.getElementById(id);
  const num = (n) => Number(n || 0).toLocaleString("en-NG");
  const isAdmin = () => typeof profile !== "undefined" && profile?.role === "admin";

  window.renderAdminPoints = function () {
    if (!isAdmin()) return '<div class="empty-state">Access denied.</div>';
    return `<div class="lb-page">
      <div class="lb-hero"><div class="lb-hero-top"><div class="lb-hero-badge"><i class="fa-solid fa-sliders"></i></div>
        <div><h2>Points manager</h2><p>Add or remove points by hand when something genuine goes wrong. The person is notified and it shows in their activity.</p></div></div></div>
      <div class="lb-card" style="margin-top:.85rem"><h3>Find a person</h3><p class="lb-sub">Search by name, shop name, phone number or email.</p>
        <div class="lb-apply"><input id="apQuery" placeholder="e.g. Levromart or 0806..." autocomplete="off" style="text-transform:none;letter-spacing:0" onkeydown="if(event.key==='Enter')apSearch()"><button type="button" class="btn" onclick="apSearch()">Search</button></div>
        <div id="apResults" class="lb-list" style="margin-top:.7rem"></div></div>
      <div id="apAdjust"></div>
      <div class="lb-card"><h3>Social follow points</h3><p class="lb-sub">After someone sends their follow screenshot on WhatsApp, add their 5 points (and their referrer's 5) here. Counts once per platform.</p>
        <div class="lb-apply"><input id="apSocialPhone" type="tel" placeholder="Phone number" style="text-transform:none;letter-spacing:0"><select id="apSocialPlatform"><option value="instagram">Instagram</option><option value="tiktok">TikTok</option><option value="linkedin">LinkedIn</option></select><button type="button" class="btn" onclick="apSocial()">Add</button></div></div>
      <div class="lb-card"><h3>Why was nothing added?</h3><p class="lb-sub">Recent events that earned no points, and the reason. Anything listed here can be corrected above.</p><div id="apSkips" class="lb-act">${'<div class="lb-skel"></div>'}</div></div>
    </div>`;
  };

  window.initAdminPoints = async function () {
    if (!isAdmin()) return;
    try {
      const { data, error } = await sb.rpc("admin_recent_points_skips", { p_limit: 30 });
      if (error) throw error;
      AP.skips = data || [];
    } catch (e) { AP.skips = []; }
    const el = $("apSkips"); if (!el) return;
    const label = { order_completed: "Sale", review_5: "5-star review", review_4: "4-star review", review_3: "3-star review", follower: "Follower", product_listed: "Listing", ref_customer: "Customer referral", ref2_customer: "Second-level customer", ref_vendor_product: "Referred vendor listing" };
    el.innerHTML = AP.skips.length ? AP.skips.map((s) => `<div class="lb-act-row"><span class="lb-act-ico" style="background:color-mix(in srgb,#e9a912 14%,var(--card));color:#b7791f"><i class="fa-solid fa-circle-info"></i></span><div class="lb-act-copy"><strong>${esc(s.business_name || s.name || "Unknown")} · ${esc(label[s.kind] || s.kind)}</strong><small>${esc(s.reason)} · ${timeAgo(s.created_at)}</small></div></div>`).join("") : `<div class="lb-empty" style="padding:.8rem 0"><strong>Nothing skipped</strong><p class="muted">Every recent event was counted.</p></div>`;
  };

  window.apSearch = async function () {
    const q = String($("apQuery")?.value || "").trim();
    const box = $("apResults"); if (!box) return;
    if (q.length < 2) { showToast("Type at least 2 characters.", "info"); return; }
    box.innerHTML = '<div class="lb-skel"></div>';
    const { data, error } = await sb.rpc("admin_search_points_users", { p_q: q });
    if (error) { box.innerHTML = `<p class="muted">${esc(error.message)}</p>`; return; }
    AP.rows = data || [];
    box.innerHTML = AP.rows.length ? AP.rows.map((r, i) => `<div class="lb-row" onclick="apPick(${i})" role="button" tabindex="0"><div class="lb-row-copy"><strong><span class="nm">${esc(r.business_name || r.name || "Unnamed")}</span>${r.business_name ? '<span class="lb-tag you" style="background:#15803d">Vendor</span>' : ""}</strong><small>${esc([r.name, r.phone].filter(Boolean).join(" · "))}</small></div><div class="lb-row-pts"><b>${num(r.week_points)}</b>this week</div></div>`).join("") : '<p class="muted">No one matched that search.</p>';
  };

  async function loadAdj(uid) {
    try { const { data } = await sb.rpc("admin_recent_points_adjustments", { p_user: uid }); AP.adj = data || []; } catch (_) { AP.adj = []; }
  }
  function renderAdjust() {
    const host = $("apAdjust"); if (!host) return;
    const r = AP.sel;
    if (!r) { host.innerHTML = ""; return; }
    host.innerHTML = `<div class="lb-card"><h3>${esc(r.business_name || r.name)}</h3><p class="lb-sub">${esc([r.business_name ? r.name : "", r.phone].filter(Boolean).join(" · "))}<br>This week <strong>${num(r.week_points)}</strong> pts · All time <strong>${num(r.all_points)}</strong> pts</p>
      <label for="apAmount" style="font-weight:700;font-size:.82rem">Points</label>
      <input id="apAmount" type="number" inputmode="numeric" min="1" max="10000" placeholder="e.g. 50" style="text-transform:none;letter-spacing:0">
      <div class="lb-chips" style="margin:.5rem 0">${[5, 10, 20, 50, 100].map((n) => `<button type="button" class="lb-chip" onclick="byId('apAmount').value=${n}">${n}</button>`).join("")}</div>
      <label for="apNote" style="font-weight:700;font-size:.82rem">Reason (shown to them)</label>
      <input id="apNote" maxlength="120" placeholder="e.g. Referral did not register" style="text-transform:none;letter-spacing:0">
      <div class="lb-code-actions" style="margin-top:.8rem;justify-content:stretch"><button type="button" class="btn" style="flex:1" onclick="apApply(1)"><i class="fa-solid fa-plus"></i> Add points</button><button type="button" class="btn btn-outline" style="flex:1;border-color:#dc2626;color:#dc2626" onclick="apApply(-1)"><i class="fa-solid fa-minus"></i> Remove points</button></div>
      ${AP.adj.length ? `<div class="lb-act" style="margin-top:.8rem"><h4 style="margin:0 0 .3rem;font-size:.74rem;letter-spacing:.07em;text-transform:uppercase;color:var(--text-muted)">Recent manual changes</h4>${AP.adj.map((a) => `<div class="lb-act-row"><div class="lb-act-copy"><strong>${esc(a.note || "Adjustment")}</strong><small>${timeAgo(a.created_at)}</small></div><span class="lb-act-pts${a.points < 0 ? " neg" : ""}">${a.points > 0 ? "+" : ""}${num(a.points)}</span></div>`).join("")}</div>` : ""}</div>`;
  }
  window.apPick = async function (i) {
    AP.sel = AP.rows[i] || null; AP.adj = [];
    renderAdjust();
    $("apAdjust")?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (AP.sel) { await loadAdj(AP.sel.user_id); renderAdjust(); }
  };
  window.apApply = async function (sign) {
    const r = AP.sel; if (!r || AP.busy) return;
    const amount = Math.floor(Math.abs(Number($("apAmount")?.value || 0)));
    if (!amount) { showToast("Enter how many points.", "info"); return; }
    const note = String($("apNote")?.value || "").trim();
    const name = r.business_name || r.name;
    const ok = await showConfirmDialog(`${sign > 0 ? "Add" : "Remove"} ${num(amount)} points ${sign > 0 ? "to" : "from"} ${name}?`, { title: sign > 0 ? "Add points" : "Remove points", okLabel: sign > 0 ? "Add points" : "Remove points" });
    if (!ok) return;
    AP.busy = true;
    try {
      const { data, error } = await sb.rpc("admin_adjust_points", { p_user: r.user_id, p_points: sign * amount, p_note: note });
      if (error || !data?.ok) throw new Error(data?.message || error?.message || "Could not change the points.");
      showToast(`${sign > 0 ? "Added" : "Removed"} ${num(amount)} points ${sign > 0 ? "to" : "from"} ${name}.`, "success");
      const q = String($("apQuery")?.value || "").trim();
      if (q.length >= 2) { const res = await sb.rpc("admin_search_points_users", { p_q: q }); AP.rows = res.data || []; const upd = AP.rows.find((x) => x.user_id === r.user_id); if (upd) AP.sel = upd; }
      await loadAdj(r.user_id);
      renderAdjust();
    } catch (e) { showToast(e.message || "Could not change the points.", "error"); }
    finally { AP.busy = false; }
  };
  window.apSocial = async function () {
    const phone = String($("apSocialPhone")?.value || "").trim(), platform = $("apSocialPlatform")?.value;
    if (!phone) { showToast("Enter a phone number first.", "info"); return; }
    const { data, error } = await sb.rpc("admin_award_social_points", { p_phone: phone, p_platform: platform });
    if (error || !data?.ok) { showToast(data?.message || error?.message || "Could not add points.", "error"); return; }
    showToast(data.already ? `${data.name || "This person"} already has ${platform} points.` : `Added ${data.awarded} points to ${data.name || "the account"}${data.referrer_awarded ? ` and ${data.referrer_awarded} to their referrer` : ""}.`, data.already ? "info" : "success");
    const el = $("apSocialPhone"); if (el) el.value = "";
  };
})();

/* ---- levromart-dispute-photos-js ---- */
/* ===== Dispute photos (up to 3) ===== */
(function () {
  const MAX = 3, MAX_BYTES = 12 * 1024 * 1024;
  window.__disputeFiles = [];
  const $ = (id) => document.getElementById(id);
  function renderPhotos() {
    const list = $("disputePhotoList"), btn = $("disputeAddPhotoBtn");
    if (!list) return;
    list.innerHTML = window.__disputeFiles.map((f, i) => `<div class="dispute-photo"><img src="${f.url}" alt="Photo ${i + 1}"><button type="button" aria-label="Remove photo ${i + 1}" onclick="removeDisputePhoto(${i})"><i class="fa-solid fa-xmark"></i></button></div>`).join("");
    if (btn) { btn.classList.toggle("hidden", window.__disputeFiles.length >= MAX); btn.innerHTML = `<i class="fa-solid fa-image"></i> ${window.__disputeFiles.length ? "Add another" : "Add photos"} <small>(${window.__disputeFiles.length}/${MAX})</small>`; }
  }
  window.pickDisputePhotos = function (input) {
    const files = [...(input.files || [])];
    input.value = "";
    for (const f of files) {
      if (window.__disputeFiles.length >= MAX) { showToast(`You can add up to ${MAX} photos.`, "info"); break; }
      if (!/^image\//.test(f.type || "") && !/\.(jpe?g|png|webp|heic|heif)$/i.test(f.name || "")) { showToast("Only photos can be added.", "error"); continue; }
      if (f.size > MAX_BYTES) { showToast("That photo is too large (12 MB maximum).", "error"); continue; }
      window.__disputeFiles.push({ file: f, url: URL.createObjectURL(f) });
    }
    renderPhotos();
  };
  window.removeDisputePhoto = function (i) {
    const f = window.__disputeFiles[i]; if (!f) return;
    try { URL.revokeObjectURL(f.url); } catch (_) {}
    window.__disputeFiles.splice(i, 1);
    renderPhotos();
  };
  window.resetDisputePhotos = function () { (window.__disputeFiles || []).forEach((f) => { try { URL.revokeObjectURL(f.url); } catch (_) {} }); window.__disputeFiles = []; renderPhotos(); };

  window.fileDispute = async function (orderId) {
    const errorEl = $("disputeError"), btn = $("disputeSubmitBtn");
    errorEl.classList.add("hidden");
    const reason = ($("disputeReason").value || "").trim();
    if (!reason) { errorEl.textContent = "Please describe what went wrong."; errorEl.classList.remove("hidden"); return; }
    if (btn) { btn.disabled = true; btn.textContent = window.__disputeFiles.length ? "Uploading photos…" : "Sending…"; }
    const uploaded = [];
    try {
      for (const item of window.__disputeFiles) {
        let blob = item.file;
        try { if (typeof window.compressImage === "function") blob = await window.compressImage(item.file, { maxWidth: 1600, maxHeight: 1600 }); } catch (_) {}
        const ext = ((blob.type || item.file.type || "image/jpeg").split("/")[1] || "jpg").replace(/[^a-z0-9]/gi, "").replace("jpeg", "jpg").slice(0, 5) || "jpg";
        const path = `${session.user.id}/${orderId}/${crypto.randomUUID()}.${ext}`;
        const { error: upErr } = await sb.storage.from("dispute-evidence").upload(path, blob, { upsert: false, contentType: blob.type || item.file.type || "image/jpeg" });
        if (upErr) throw upErr;
        uploaded.push({ path, name: item.file.name || "photo", type: blob.type || item.file.type || "image/jpeg" });
      }
      const { error } = await sb.rpc("raise_dispute", { p_order_id: orderId, p_reason: reason, p_attachments: uploaded });
      if (error) throw error;
    } catch (e) {
      errorEl.textContent = e?.message || "Could not send your report. Please try again.";
      errorEl.classList.remove("hidden");
      if (btn) { btn.disabled = false; btn.textContent = "Submit report"; }
      return;
    }
    window.resetDisputePhotos();
    try { forgetOrderPageCaches(orderId); } catch (_) {}
    navigate("orderDetail", { orderId });
  };

  // Evidence thumbnails: private bucket, so each image is shown through a short-lived signed link.
  window.disputeEvidenceHtml = function (attachments) {
    const list = Array.isArray(attachments) ? attachments.filter((a) => a && a.path) : [];
    if (!list.length) return "";
    return `<div class="dispute-evidence" data-paths='${esc(JSON.stringify(list.map((a) => a.path)))}'><span class="muted" style="font-size:.78rem"><i class="fa-solid fa-camera"></i> Loading photos…</span></div>`;
  };
  window.hydrateDisputeEvidence = async function () {
    for (const box of document.querySelectorAll(".dispute-evidence[data-paths]")) {
      let paths = []; try { paths = JSON.parse(box.dataset.paths || "[]"); } catch (_) {}
      box.removeAttribute("data-paths");
      const urls = await Promise.all(paths.map(async (p) => { try { const { data } = await sb.storage.from("dispute-evidence").createSignedUrl(p, 3600); return data?.signedUrl || ""; } catch (_) { return ""; } }));
      box.innerHTML = urls.filter(Boolean).map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="Evidence photo" loading="lazy"></a>`).join("") || `<span class="muted" style="font-size:.78rem">Photos are not available.</span>`;
    }
  };
})();

/* Banner tint for vendors without a cover: a light shade of their own logo colour (falls back to a per-vendor hue). */
(function () {
  const done = new WeakSet();
  function tintOne(card) {
    if (done.has(card)) return; done.add(card);
    const ban = card.querySelector(".vc2-banner"); const img = card.querySelector(".vc2-logo img");
    if (!ban || ban.querySelector("img") || !img) return;
    const probe = new Image(); probe.crossOrigin = "anonymous";
    probe.onload = () => {
      try {
        const c = document.createElement("canvas"); c.width = c.height = 24;
        const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(probe, 0, 0, 24, 24);
        const d = x.getImageData(0, 0, 24, 24).data; let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) {
          const R = d[i], G = d[i + 1], B = d[i + 2], mx = Math.max(R, G, B), mn = Math.min(R, G, B);
          if (d[i + 3] < 200 || mx - mn < 28 || mx > 245 || mx < 25) continue; // skip white/black/grey
          r += R; g += G; b += B; n++;
        }
        if (n < 8) return;
        r /= n; g /= n; b /= n;
        const mix = (v, t) => Math.round(v + (255 - v) * t);
        ban.style.background = `linear-gradient(135deg,rgb(${mix(r, .72)},${mix(g, .72)},${mix(b, .72)}),rgb(${mix(r, .86)},${mix(g, .86)},${mix(b, .86)}))`;
      } catch (_) {}
    };
    // colour sampling is decoration: do it when the phone is idle so it never delays a page
    const go = () => { probe.src = img.currentSrc || img.src; };
    if (window.requestIdleCallback) requestIdleCallback(go, { timeout: 2500 }); else setTimeout(go, 300);
  }
  let t = 0;
  new MutationObserver(() => { clearTimeout(t); t = setTimeout(() => { document.querySelectorAll(".vc2").forEach(tintOne); levroPulseLbCard(); }, 150); }).observe(document.documentElement, { childList: true, subtree: true });
})();

/* Home leaderboard card: gentle gold pulse (WAAPI, because CSS animation is disabled by the calm-motion guard). */
function levroPulseLbCard() {
  const card = document.getElementById("homeLbCard"); if (!card || card.__pulsing) return;
  const ico = card.querySelector(".home-lb-ico"); if (!ico || !ico.animate) return;
  card.__pulsing = true;
  const ring = () => ico.animate([{ boxShadow: "0 0 0 0 rgba(247,181,0,.65)", transform: "scale(1)" }, { boxShadow: "0 0 0 12px rgba(247,181,0,0)", transform: "scale(1.1)" }, { boxShadow: "0 0 0 0 rgba(247,181,0,0)", transform: "scale(1)" }], { duration: 1500, iterations: 2, easing: "ease-out" });
  const nudge = () => {
    if (!document.body.contains(card)) { clearInterval(card.__t); return; }
    const r = card.getBoundingClientRect(); if (r.bottom < 80 || r.top > innerHeight - 40) { ring(); return; }
    ring();
    const n = document.createElement("div"); n.className = "lb-nudge"; n.innerHTML = '<i class="fa-solid fa-award"></i> See who is leading this week';
    card.appendChild(n);
    const a = n.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "translateY(0)", offset: .15 }, { opacity: 1, transform: "translateY(0)", offset: .8 }, { opacity: 0, transform: "translateY(-6px)" }], { duration: 4200, fill: "forwards" });
    a.onfinish = () => n.remove();
  };
  const sh = document.createElement("span"); sh.className = "lb-shine"; ico.appendChild(sh);
  const sweep = () => sh.animate([{ left: "-60%" }, { left: "130%" }], { duration: 1100, easing: "ease-in-out" });
  card.animate([{ transform: "scale(1)" }, { transform: "scale(1.012)" }, { transform: "scale(1)" }], { duration: 2400, iterations: Infinity, easing: "ease-in-out" });
  setInterval(sweep, 3600); setTimeout(sweep, 500);
  setTimeout(ring, 800); setTimeout(nudge, 3500);
  card.__t = setInterval(nudge, 14000);
}
