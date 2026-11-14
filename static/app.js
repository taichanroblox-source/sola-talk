(() => {
"use strict";
const $ = id => document.getElementById(id);
const roomId = window.SOLA_ROOM_ID;
let roomInfo = null, socket = null, local = null, screenStream = null, joined = false, isHost = false;
let micEnabled = true, camEnabled = true, startTime = 0, timerInterval = null;
const peers = new Map(), remoteStreams = new Map(), names = new Map();
const remoteScreens = new Map(), remoteScreenIds = new Map();
const hostStorageKey = id => "sola-talk-host-" + id;
const resumeKey = id => "sola-talk-resume-" + id;
function readResume(){
 try{return JSON.parse(sessionStorage.getItem(resumeKey(roomId))||"null");}catch{return null;}
}
function clearResume(){try{sessionStorage.removeItem(resumeKey(roomId));}catch{}}
function rememberResume(name,password){
 try{sessionStorage.setItem(resumeKey(roomId),JSON.stringify({name,password}));}catch{}
}
let joinPassword="";

const rtcConfig={iceServers:[{urls:"stun:stun.l.google.com:19302"},{urls:"stun:stun1.l.google.com:19302"}]};
async function loadRtcConfig(){
 try{const res=await fetch("/api/rtc-config",{cache:"no-store"});if(res.ok){const data=await res.json();if(Array.isArray(data.iceServers)&&data.iceServers.length)rtcConfig.iceServers=data.iceServers;}}
 catch(e){console.warn("RTC config",e);}
}
const toast = message => { const t=$("toast"); t.textContent=message; t.style.display="block"; setTimeout(()=>{ if(t.textContent===message)t.style.display="none"; },4000); };
const show = id => { ["home","lobby","call"].forEach(x=>$(x).classList.toggle("hidden",x!==id)); };
const safeName = name => name || "ゲスト";
// Short, clearly audible notification tones with a gentle envelope.
let notificationAudio=null;
function beep(type="message"){
 try{
  const AudioContextClass=window.AudioContext||window.webkitAudioContext;
  if(!AudioContextClass)return;
  if(!notificationAudio)notificationAudio=new AudioContextClass();
  const ctx=notificationAudio;
  if(ctx.state==="suspended")ctx.resume().catch(()=>{});
  const patterns={
   join:[[660,0,0.13],[880,0.16,0.17]],
   leave:[[720,0,0.13],[480,0.16,0.18]],
   message:[[880,0,0.16]]
  };
  for(const [frequency,delay,duration] of patterns[type]||patterns.message){
   const osc=ctx.createOscillator(),gain=ctx.createGain();
   osc.type="sine";osc.frequency.setValueAtTime(frequency,ctx.currentTime+delay);
   const start=ctx.currentTime+delay;
   gain.gain.setValueAtTime(0.0001,start);
   gain.gain.exponentialRampToValueAtTime(0.16,start+0.018);
   gain.gain.exponentialRampToValueAtTime(0.0001,start+duration);
   osc.connect(gain);gain.connect(ctx.destination);
   osc.start(start);osc.stop(start+duration+0.02);
  }
 }catch(e){console.warn("Notification sound",e);}
}
const shareUrl = () => location.origin + "/r/" + roomId;
const hostKey = () => sessionStorage.getItem(hostStorageKey(roomId)) || "";
const setTheme = val => {document.body.classList.toggle("light",val==="light");localStorage.setItem("sola-talk-theme",val);};
setTheme(localStorage.getItem("sola-talk-theme")||"dark");
$("themeBtn").onclick=()=>setTheme(document.body.classList.contains("light")?"dark":"light");
const savedName=()=>{try{return localStorage.getItem("sola-talk-name")||"";}catch{return "";}};
const saveName=()=>{const name=$("displayName").value.trim();try{if(name)localStorage.setItem("sola-talk-name",name);}catch(e){console.warn("Name storage",e);}};
$("displayName").value="";
const nameHint=$("displayName").getAttribute("placeholder")||"";
$("displayName").addEventListener("focus",()=>{$("displayName").placeholder="";});
$("displayName").addEventListener("blur",()=>{if(!$("displayName").value)$("displayName").placeholder=nameHint;});
$("displayName").addEventListener("input",saveName);
$("displayName").addEventListener("change",saveName);
$("createForm").onsubmit=async e=>{
 e.preventDefault();
 try{
 const res=await fetch("/api/rooms",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:$("roomName").value,password:$("newPassword").value,limit:+$("roomLimit").value,approval:$("approval").checked})});
 const data=await res.json();if(!res.ok)throw Error(data.error);
 sessionStorage.setItem(hostStorageKey(data.room.id),data.host_key);location.href=data.url;
 }catch(err){toast(err.message);}
};
$("joinForm").onsubmit=e=>{
 e.preventDefault();
 const value=$("joinUrl").value.trim();let id=value;
 try { if(value.includes("/")) id=new URL(value,location.origin).pathname.split("/r/")[1]?.split("/")[0]||""; }catch{}
 if(!/^[A-Za-z0-9_-]{8,40}$/.test(id))return toast("URLまたはルームIDが正しくありません");
 location.href="/r/"+encodeURIComponent(id);
};
async function setupLobby(){
 if(!roomId){show("home");return;}
 const res=await fetch("/api/rooms/"+encodeURIComponent(roomId));
 if(!res.ok){show("home");toast("ルームが見つかりません");return;}
 roomInfo=await res.json();$("lobbyName").textContent=roomInfo.name;$("roomMeta").textContent=roomInfo.count+" / "+roomInfo.limit+"人";
 $("password").parentElement.classList.toggle("hidden",!!hostKey() || !roomInfo.password);
 show("lobby");
 const resume=readResume();
 if(resume?.name){
  $("displayName").value=resume.name;
  $("password").value=resume.password||"";
  joinPassword=resume.password||"";
  $("joinBtn").disabled=true;
  try{await loadRtcConfig();connect(resume.name);}
  catch(e){$("joinBtn").disabled=false;toast("再入室に失敗しました: "+e.message);}
 }
}
// Permission requests happen only when the user turns a device ON.
micEnabled=false;camEnabled=false;
local=new MediaStream();
function updateDeviceUI(){
 $("previewMic").textContent="マイク "+(micEnabled?"ON":"OFF");
 $("previewCam").textContent="カメラ "+(camEnabled?"ON":"OFF");
 $("micBtn").textContent=micEnabled?"🎙 マイクON":"🔇 マイクOFF";
 $("camBtn").textContent=camEnabled?"📷 カメラON":"📷 カメラOFF";
 $("preview").srcObject=local;
 renderTiles();
}
async function toggleDevice(kind){
 const isMic=kind==="audio";
 const active=isMic?micEnabled:camEnabled;
 const tracks=isMic?local.getAudioTracks():local.getVideoTracks();
 if(active){
   tracks.forEach(t=>{t.stop();local.removeTrack(t);});
   if(isMic)micEnabled=false;else camEnabled=false;
 }else{
   if(!navigator.mediaDevices?.getUserMedia){toast("HTTPSまたはlocalhostで開いてね");return;}
   try{
     const stream=await navigator.mediaDevices.getUserMedia(isMic
       ?{audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false}
       :{audio:false,video:true});
     for(const track of stream.getTracks()){local.addTrack(track);track.onended=()=>{if(local.getTracks().includes(track)){local.removeTrack(track);if(isMic)micEnabled=false;else camEnabled=false;updateDeviceUI();syncTracks();}};}
     if(isMic)micEnabled=true;else camEnabled=true;
   }catch(e){toast((isMic?"マイク":"カメラ")+"を使えません。ブラウザの権限設定を確認してね");return;}
 }
 updateDeviceUI();
 await syncTracks();
}
async function syncTracks(){
 for(const [sid,pc] of peers){
  for(const kind of ["audio","video"]){
   const track=kind==="audio"?local.getAudioTracks()[0]:local.getVideoTracks()[0];
   let sender=pc.getSenders().find(x=>x._solaKind===kind);
   if(sender)await sender.replaceTrack(track||null);
   else if(track){
    sender=pc.addTrack(track,local);sender._solaKind=kind;
    await makeOffer(sid,pc);
   }
  }
 }
}
$("previewMic").onclick=()=>toggleDevice("audio");
$("previewCam").onclick=()=>toggleDevice("video");
$("backBtn").onclick=()=>location.href="/";
$("joinBtn").onclick=async ()=>{
 try {
 const name=$("displayName").value.trim()||"ゲスト";saveName();joinPassword=$("password").value;
 $("joinBtn").disabled=true;
 await loadRtcConfig();
 connect(name);
 }catch(err){toast("カメラ・マイクの許可を確認してね: "+err.message);}
};
function connect(name){
 socket=io({transports:["websocket","polling"],reconnection:true});
 socket.on("connect",()=>{ $("status").textContent="接続済み"; if(!joined)socket.emit("join_call",{room_id:roomId,host_key:hostKey(),name,password:joinPassword}); });
 socket.on("disconnect",()=>{$("status").textContent="再接続中";joined=false;for(const pc of peers.values())pc.close();peers.clear();remoteStreams.clear();remoteScreens.clear();remoteScreenIds.clear();});
 socket.on("waiting",()=>{toast("管理者の承認待ち");$("joinBtn").disabled=true;});
 socket.on("join_error",d=>{clearResume();$("joinBtn").disabled=false;toast(d.error);socket.disconnect();socket=null;show("lobby");});
 socket.on("action_error",d=>toast(d.error));
 socket.on("admitted",d=>{joined=true;isHost=d.host;roomInfo=d.room;rememberResume(name,joinPassword);startCall();});
 socket.on("roster",d=>{names.clear();d.members.forEach(m=>names.set(m.sid,m.name));renderTiles(); for(const m of d.members){if(m.sid!==socket.id && !peers.has(m.sid))createPeer(m.sid,socket.id<m.sid);}});
 socket.on("peer_joined",d=>{names.set(d.sid,d.name);beep("join");renderTiles();});
 socket.on("peer_left",d=>{peers.get(d.sid)?.close();peers.delete(d.sid);remoteStreams.delete(d.sid);remoteScreens.delete(d.sid);remoteScreenIds.delete(d.sid);names.delete(d.sid);beep("leave");renderTiles();});
 socket.on("signal",handleSignal);
 socket.on("chat",d=>addMessage(d.name,d.text));
 socket.on("pending_requests",d=>{if(isHost)renderRequests(d.requests);});
 socket.on("room_state",d=>{roomInfo=d;$("lockBtn").textContent=d.locked?"ロック解除":"ルームをロック";});
 socket.on("removed",d=>{toast(d.reason);clearResume();cleanup();setTimeout(()=>location.href="/",1000);});
}
function startCall(){
 show("call");$("callTitle").textContent=roomInfo.name;$("hostControls").classList.toggle("hidden",!isHost);
 if(!startTime)startTime=Date.now();
 clearInterval(timerInterval);
 timerInterval=setInterval(()=>{const t=Math.floor((Date.now()-startTime)/1000);$("timer").textContent=String(Math.floor(t/60)).padStart(2,"0")+":"+String(t%60).padStart(2,"0");},1000);
 renderTiles();setupMeter();
}
function sendScreenState(sid,active,streamId){
 if(socket?.connected)socket.emit("signal",{to:sid,kind:"screen",payload:{active,streamId:streamId||null}});
}
function classifyRemoteTrack(sid,track,streamId){
 const screenId=remoteScreenIds.get(sid);
 const isScreen=track.kind==="video"&&screenId&&screenId===streamId;
 const targetMap=isScreen?remoteScreens:remoteStreams;
 let stream=targetMap.get(sid);
 if(!stream){stream=new MediaStream();targetMap.set(sid,stream);}
 if(!stream.getTracks().includes(track))stream.addTrack(track);
 track.onended=()=>{stream.removeTrack(track);renderTiles();};
 renderTiles();
}
function updateRemoteScreenState(sid,payload){
 if(payload?.active&&payload.streamId){
  remoteScreenIds.set(sid,payload.streamId);
  const main=remoteStreams.get(sid);
  if(main)for(const track of main.getVideoTracks()){
   if(track._solaStreamId===payload.streamId){
    main.removeTrack(track);
    classifyRemoteTrack(sid,track,payload.streamId);
   }
  }
 }else{
  remoteScreenIds.delete(sid);
  remoteScreens.delete(sid);
  renderTiles();
 }
}
function createPeer(sid,initiator){
 const pc=new RTCPeerConnection(rtcConfig);peers.set(sid,pc);
 local?.getTracks().forEach(t=>{const sender=pc.addTrack(t,local);sender._solaKind=t.kind;});
 if(screenStream){
  const track=screenStream.getVideoTracks()[0];
  if(track){const sender=pc.addTrack(track,screenStream);sender._solaScreen=true;}
 }
 pc.onicecandidate=e=>{if(e.candidate)socket.emit("signal",{to:sid,kind:"candidate",payload:e.candidate});};
 pc.ontrack=e=>{
  const streamId=e.streams[0]?.id||"";
  e.track._solaStreamId=streamId;
  classifyRemoteTrack(sid,e.track,streamId);
 };
 pc.onconnectionstatechange=()=>{$("quality").textContent=pc.connectionState;};
 if(screenStream)sendScreenState(sid,true,screenStream.id);
 if(initiator)makeOffer(sid,pc);
 return pc;
}
async function makeOffer(sid,pc){
 if(pc.signalingState!=="stable" || pc._makingOffer){pc._offerQueued=true;return;}
 pc._makingOffer=true;
 try{
  await pc.setLocalDescription(await pc.createOffer());
  socket.emit("signal",{to:sid,kind:"offer",payload:pc.localDescription});
 }catch(e){console.warn("Offer error",e);}
 finally{pc._makingOffer=false;}
}
async function flushCandidates(pc){
 const pending=pc._pendingIce||[];pc._pendingIce=[];
 for(const candidate of pending){
  try{await pc.addIceCandidate(candidate);}catch(e){console.warn("ICE candidate error",e);}
 }
}
async function handleSignal(data){
 try{
  if(data.kind==="screen"){updateRemoteScreenState(data.from,data.payload);return;}
  let pc=peers.get(data.from);
  if(!pc)pc=createPeer(data.from,false);
  if(data.kind==="offer"){
   const collision=pc.signalingState!=="stable"||pc._makingOffer;
   const polite=socket.id>data.from;
   if(collision&&!polite){console.info("Ignoring colliding offer",data.from);pc._ignoreOffer=true;return;}
   pc._ignoreOffer=false;
   await pc.setRemoteDescription(data.payload);
   await flushCandidates(pc);
   await pc.setLocalDescription(await pc.createAnswer());
   socket.emit("signal",{to:data.from,kind:"answer",payload:pc.localDescription});
  }else if(data.kind==="answer"){
   if(pc.signalingState!=="have-local-offer"){
    console.info("Ignoring stale answer",data.from,pc.signalingState);return;
   }
   await pc.setRemoteDescription(data.payload);
   await flushCandidates(pc);
  }else if(data.kind==="candidate"){
   if(pc._ignoreOffer)return;
   if(pc.remoteDescription)await pc.addIceCandidate(data.payload);
   else{pc._pendingIce??=[];pc._pendingIce.push(data.payload);}
  }
  if(pc.signalingState==="stable"&&pc._offerQueued){
   pc._offerQueued=false;await makeOffer(data.from,pc);
  }
 }catch(e){console.warn("Signal error",e);}
}
function tile(id,name,stream,self=false){
 const node=document.createElement("div");node.className="tile";node.id="tile-"+id;
 const video=document.createElement("video");video.autoplay=true;video.playsInline=true;video.muted=self;video.srcObject=stream||null;node.append(video);
 const caption=document.createElement("div");caption.className="person";caption.textContent=name+(self?" (自分)":"");node.append(caption);
 if(!stream || !stream.getVideoTracks().some(t=>t.enabled && t.readyState==="live")){node.classList.add("audioOnly");const av=document.createElement("div");av.className="avatar";av.textContent="👤";node.append(av);}
 return node;
}
function renderTiles(){
 if(!joined)return;
 const tiles=$("tiles");tiles.replaceChildren();
 tiles.append(tile("me",$("displayName").value.trim()||"ゲスト",local,true));
 for(const [sid,name] of names){if(sid!==socket?.id){tiles.append(tile(sid,name,remoteStreams.get(sid)));if(remoteScreenIds.has(sid))tiles.append(tile("screen-"+sid,name+"の画面",remoteScreens.get(sid)));}}
 if(screenStream)tiles.append(tile("screen-me","自分の画面",screenStream,true));
}
function setupMeter(){
 if(!local||window.solaMeter)return;
 try {
 const ctx=new AudioContext(),analyser=ctx.createAnalyser(),source=ctx.createMediaStreamSource(local);
 analyser.fftSize=512;source.connect(analyser);const samples=new Uint8Array(analyser.frequencyBinCount);
 const loop=()=>{if(!joined){ctx.close();window.solaMeter=false;return;}analyser.getByteFrequencyData(samples);const avg=samples.reduce((a,b)=>a+b,0)/samples.length;$("tile-me")?.classList.toggle("speaking",avg>18&&micEnabled);requestAnimationFrame(loop);};
 window.solaMeter=true;loop();
 }catch{}
}
$("micBtn").onclick=()=>toggleDevice("audio");
$("camBtn").onclick=()=>toggleDevice("video");
async function stopScreenShare(){
 const previous=screenStream;
 if(!previous)return;
 screenStream=null;
 for(const [sid,pc] of peers){
  const sender=pc.getSenders().find(x=>x._solaScreen);
  if(sender){pc.removeTrack(sender);sender._solaScreen=false;await makeOffer(sid,pc);}
  sendScreenState(sid,false);
 }
 previous.getTracks().forEach(t=>{t.onended=null;t.stop();});
 $("screenBtn").textContent="▣ 画面共有";
 renderTiles();
}
$("screenBtn").onclick=async()=>{
 if(screenStream){await stopScreenShare();return;}
 try{
  if(!navigator.mediaDevices?.getDisplayMedia){toast("このブラウザは画面共有に対応していないよ");return;}
  const captured=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});
  const track=captured.getVideoTracks()[0];
  if(!track){captured.getTracks().forEach(t=>t.stop());return;}
  screenStream=captured;
  track.onended=()=>stopScreenShare().catch(console.warn);
  for(const [sid,pc] of peers){
   sendScreenState(sid,true,captured.id);
   const sender=pc.addTrack(track,captured);
   sender._solaScreen=true;
   await makeOffer(sid,pc);
  }
  $("screenBtn").textContent="共有停止";
  renderTiles();
 }catch(e){console.warn("Screen share error",e);toast("画面共有できません: "+e.message);}
};
$("chatBtn").onclick=()=>{
 const open=$("chatPanel").classList.toggle("hidden")===false;
 $("chatBtn").textContent=open?"💬 チャットを閉じる":"💬 チャットを開く";
 $("chatBtn").setAttribute("aria-expanded",String(open));
 $("call").classList.toggle("chatClosed",!open);
};
$("inviteBtn").onclick=async()=>{try{await navigator.clipboard.writeText(shareUrl());toast("招待URLをコピーしたよ");}catch{toast(shareUrl());}};
$("leaveBtn").onclick=()=>{if(confirm("通話から退出する？")){clearResume();socket?.emit("leave_call");cleanup();location.href="/";}};
$("chatForm").onsubmit=e=>{e.preventDefault();const val=$("chatInput").value.trim();if(val&&joined){socket.emit("chat",{text:val});$("chatInput").value="";}};
function addMessage(name,text){const box=document.createElement("div");box.className="msg";const small=document.createElement("small");small.textContent=name;const content=document.createElement("div");content.textContent=text;box.append(small,content);$("messages").append(box);$("messages").scrollTop=$("messages").scrollHeight;beep("message");}
function manage(action,options={}){socket.emit("manage",{room_id:roomId,host_key:hostKey(),action,...options});}
function renderRequests(requests){const box=$("requests");box.replaceChildren();for(const r of requests){const line=document.createElement("div");line.textContent=r.name+" が参加申請中 ";const yes=document.createElement("button");yes.textContent="承認";yes.onclick=()=>manage("approve",{target:r.sid});const no=document.createElement("button");no.className="secondary";no.textContent="拒否";no.onclick=()=>manage("reject",{target:r.sid});line.append(yes,no);box.append(line);} }
$("lockBtn").onclick=()=>manage("lock",{value:!roomInfo.locked});
$("endBtn").onclick=()=>{if(confirm("全員の通話を終了する？"))manage("end");};
function cleanup(){joined=false;clearInterval(timerInterval);for(const pc of peers.values())pc.close();peers.clear();remoteScreens.clear();remoteScreenIds.clear();local?.getTracks().forEach(t=>t.stop());screenStream?.getTracks().forEach(t=>t.stop());socket?.disconnect();}
window.addEventListener("beforeunload",()=>{ /* Socket.IO disconnect releases this participant; resume token remains for reload. */ });
setupLobby();
})();