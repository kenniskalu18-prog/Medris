// ---------- AUDIO COMPATIBILITY ----------
// Levromart notification sound. This is the app-level sound used while the web app
// is actively open. OS-level push notification audio remains controlled by the
// browser/phone notification settings (web apps cannot force a custom OS sound).
let soundEnabled = true;
let audioCtx = null;
const heardNotifications=new Set();let notificationSoundUntil=0;
function unlockNotificationAudio(){
  const Ctx=window.AudioContext||window.webkitAudioContext;if(!Ctx)return;
  if(!audioCtx||audioCtx.state==='closed')audioCtx=new Ctx();
  if(audioCtx.state!=='running')audioCtx.resume().catch(()=>{});
}
// The Levromart notification sound, synthesised once into samples (no audio file to download):
// a soft low "boom" under each of three warm mallet notes (D major, rising), then a bright
// ringing top note, all with a gentle echo tail. The same samples feed WebAudio and the
// <audio> fallback used on phones whose WebAudio context is locked or "interrupted".
function levroChimeSamples(rate){
  const dur=1.9,len=Math.floor(rate*dur),out=new Float32Array(len),TAU=2*Math.PI;
  const mallet=(at,hz,amp,ring)=>{               // marimba-like: a few partials, the upper ones die fast
    [[1,1,ring],[2,.28,ring*.55],[3.98,.16,ring*.22],[6.2,.06,ring*.12]].forEach(([m,a,r])=>{
      const f=hz*m,start=Math.floor(at*rate);
      for(let n=start;n<Math.min(len,start+Math.floor(rate*r*5));n++){
        const t=(n-start)/rate;
        out[n]+=Math.sin(TAU*f*t)*amp*a*Math.min(1,t/.004)*Math.exp(-t/r);
      }
    });
  };
  const boom=(at,amp)=>{                          // soft low thump, pitch settles from 190 Hz to 120 Hz
    const start=Math.floor(at*rate);
    for(let n=start;n<Math.min(len,start+Math.floor(rate*.32));n++){
      const t=(n-start)/rate,f=120+70*Math.exp(-t*18);
      out[n]+=Math.sin(TAU*f*t)*amp*Math.min(1,t/.006)*Math.exp(-t*11);
    }
  };
  [[0,587.33,.5],[.13,739.99,.5],[.27,880,.5]].forEach(([at,hz,amp])=>{boom(at,.5);mallet(at,hz,amp,.22);});
  boom(.44,.35);mallet(.44,1174.66,.55,.5);       // the sparkle on top
  // echo tail: two feedback delays, a little different on each so it shimmers
  [[.19,.34],[.31,.26]].forEach(([d,fb])=>{
    const k=Math.floor(rate*d);
    for(let n=k;n<len;n++)out[n]+=out[n-k]*fb;
  });
  let peak=0;for(let n=0;n<len;n++)peak=Math.max(peak,Math.abs(out[n]));
  const g=peak>0?.72/peak:1,fade=Math.floor(rate*.12);
  for(let n=0;n<len;n++){out[n]*=g;if(n>len-fade)out[n]*=(len-n)/fade;}
  return out;
}
let __chimeEl=null,__chimeBuf=null;
function chimeWavUrl(){
  if(window.__chimeWavUrl)return window.__chimeWavUrl;
  const rate=22050,samples=levroChimeSamples(rate),len=samples.length,buf=new Int16Array(len);
  for(let n=0;n<len;n++)buf[n]=Math.round(Math.max(-1,Math.min(1,samples[n]))*32767);
  const hdr=new ArrayBuffer(44),v=new DataView(hdr),w=(o,str)=>{for(let k=0;k<str.length;k++)v.setUint8(o+k,str.charCodeAt(k));};
  w(0,'RIFF');v.setUint32(4,36+len*2,true);w(8,'WAVE');w(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,rate,true);v.setUint32(28,rate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);w(36,'data');v.setUint32(40,len*2,true);
  window.__chimeWavUrl=URL.createObjectURL(new Blob([hdr,buf.buffer],{type:'audio/wav'}));
  return window.__chimeWavUrl;
}
function playChimeFallback(){
  try{ if(!__chimeEl){__chimeEl=new Audio(chimeWavUrl());__chimeEl.preload='auto';} __chimeEl.currentTime=0; const pr=__chimeEl.play(); if(pr&&pr.catch)pr.catch(()=>{}); }catch(_){}
}
function playNotificationSound(n){
  if(!soundEnabled||!n?.id||!session?.user?.id)return;
  const key=`${session.user.id}:${n.id}`;
  if(heardNotifications.has(key))return;
  if(document.hidden)return;
  heardNotifications.add(key);
  unlockNotificationAudio();
  const go=()=>{
    const now=audioCtx.currentTime;
    if(now<notificationSoundUntil)return;
    notificationSoundUntil=now+2.2;
    try{
      if(!__chimeBuf||__chimeBuf.sampleRate!==audioCtx.sampleRate){
        const data=levroChimeSamples(audioCtx.sampleRate);
        __chimeBuf=audioCtx.createBuffer(1,data.length,audioCtx.sampleRate);__chimeBuf.getChannelData(0).set(data);
      }
      const src=audioCtx.createBufferSource();src.buffer=__chimeBuf;src.connect(audioCtx.destination);src.start(now);
    }catch(_){playChimeFallback();}
  };
  if(audioCtx&&audioCtx.state==='running'){go();return;}
  if(audioCtx){
    let done=false;
    const t=setTimeout(()=>{if(!done){done=true;playChimeFallback();}},350);
    audioCtx.resume().then(()=>{if(done)return;done=true;clearTimeout(t);if(audioCtx.state==='running')go();else playChimeFallback();}).catch(()=>{if(!done){done=true;clearTimeout(t);playChimeFallback();}});
  } else playChimeFallback();
}
// A notification that arrives while the app is open must always chime, even if the
// live connection missed it: look for fresh unread ones every few seconds.
const __notifSoundBoot=Date.now()-8000;
setInterval(async()=>{
  try{
    if(document.hidden||!session?.user?.id||!soundEnabled)return;
    const {data}=await levroData.notifications.recentUnread(session.user.id,5);
    (data||[]).forEach(n=>{
      if(new Date(n.created_at).getTime()<__notifSoundBoot)return;
      if(n.type==='incoming_call')return;
      if(n.type==='new_message'&&currentView==='messages'&&activeConversationId&&String(n.target_params?.conversationId||'')===String(activeConversationId))return;
      playNotificationSound(n);
    });
  }catch(_){}
},6000);
function playReminderChime(){ playNotificationSound({id:'reminder-'+Date.now()}); }
function playSound() {}
function initSound() {
  if(!window.__notificationAudioBound){
    window.__notificationAudioBound=true;
    ["pointerdown","touchstart","touchend","click","keydown"].forEach(ev=>document.addEventListener(ev,unlockNotificationAudio,{passive:true,capture:true}));
    document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")unlockNotificationAudio();});
  }
  soundEnabled = true;
}


