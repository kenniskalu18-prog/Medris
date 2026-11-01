
(function(){
  // This watchdog intentionally lives before the large application bundle.
  // If a later script has a parse/runtime error, a network dependency stalls,
  // or a future patch breaks init(), the black splash must still disappear.
  var started=Date.now();
  function hide(){
    var el=document.getElementById("levromartSplash");
    if(!el)return;
    el.classList.add("is-hidden");
    el.setAttribute("aria-hidden","true");
  }
  // Do not hide the branded surface merely because window.load fired. The
  // app may still be preparing its first route; exposing the raw header at
  // that point produces the ugly green logo rectangles/empty controls.
  // init() hides this surface in its finally block once routing is ready.
  // Hard limit: the splash is never on screen for more than about 4.5 seconds, whatever the app is still waiting for (the sign-in check,
  // the network, a slow phone). The app is drawn underneath and fills in as its data arrives.
  // The one exception: while our own style files have not all arrived (slow connection), keep the splash up to 10 s, because the page
  // without its styles is the half-built screen nobody should see.
  function styled(){
    try{
      if(document.readyState==="loading") return false;
      var l=document.querySelectorAll('link[rel="stylesheet"][href*="/assets/css/"]');
      for(var i=0;i<l.length;i++) if(!l[i].sheet && navigator.onLine!==false) return false;
      return true;
    }catch(_){ return true; }
  }
  // On a very slow connection the big app script can still be on its way. Revealing the page then shows raw, jumbled controls
  // (search box, assistant button, empty cards), so while the app has not arrived the splash stays and says the network is slow.
  function appArrived(){ return typeof window.renderHome==="function" && typeof window.navigate==="function"; }
  function slowNotice(){
    var el=document.getElementById("levromartSplash");
    if(!el||document.getElementById("lvSlowNet"))return;
    var d=document.createElement("div");
    d.id="lvSlowNet";
    d.setAttribute("role","status");
    d.style.cssText="position:absolute;left:0;right:0;bottom:calc(5.5rem + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;align-items:center;gap:.7rem;padding:0 1.5rem;text-align:center;font-family:inherit";
    d.innerHTML='<strong style="font-size:1.02rem;color:inherit">Your network is very slow</strong><span style="font-size:.88rem;opacity:.75;line-height:1.4">Still loading. It will open as soon as the connection catches up.</span><button type="button" id="lvSlowRetry" style="margin-top:.2rem;border:0;border-radius:999px;padding:.7rem 1.4rem;font:inherit;font-weight:800;background:#16a06a;color:#fff">Try again</button>';
    el.appendChild(d);
    document.getElementById("lvSlowRetry").onclick=function(){ location.reload(); };
  }
  setTimeout(function tick(){
    var waited=Date.now()-started;
    var arrived=appArrived();
    // Never trap someone behind the splash screen. If the app bundle has
    // failed to arrive, reveal the document after a firm 10-second ceiling.
    // The app can still initialise underneath and take over when ready.
    if(!arrived && !window.__levroSplashHidden && waited<10000){
      if(waited>6000) slowNotice();
      setTimeout(tick,300);
      return;
    }
    var n=document.getElementById("lvSlowNet"); if(n) n.remove();
    try{ window.__levroSplashHidden=true; }catch(_){}
    hide();
  },4500);

})();
