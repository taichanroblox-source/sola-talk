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
 try{return JSON.parse(localStorage.getItem(resumeKey(roomId))||"null");}catch{return null;}
}
function clearResume(){try{localStorage.removeItem(resumeKey(roomId));}catch{}}
function rememberResume(name,password){
 try{localStorage.setItem(resumeKey(roomId),JSON.stringify({name,password}));}catch{}
}
let joinPassword="";
let joinWatchdog=null;
let audioDiagnosticsTimer=null;
function clearJoinWatchdog(){if(joinWatchdog){clearTimeout(joinWatchdog);joinWatchdog=null;}}
function joinFailed(message){clearJoinWatchdog();$("joinBtn").disabled=false;$("status").textContent="未接続";toast(message);}

let currentDisplayName="ゲスト";

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
const hostKey = () => localStorage.getItem(hostStorageKey(roomId)) || sessionStorage.getItem(hostStorageKey(roomId)) || "";
const setTheme = val => {document.body.classList.toggle("light",val==="light");localStorage.setItem("sola-talk-theme",val);};
setTheme(localStorage.getItem("sola-talk-theme")||"dark");
$("themeBtn").onclick=()=>setTheme(document.body.classList.contains("light")?"dark":"light");
const savedName=()=>{try{return localStorage.getItem("sola-talk-name")||"";}catch{return "";}};
const saveName=()=>{const name=$("displayName").value.trim();try{if(name)localStorage.setItem("sola-talk-name",name);}catch(e){console.warn("Name storage",e);}};
$("displayName").value=savedName();
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
 localStorage.setItem(hostStorageKey(data.room.id),data.host_key);location.href=data.url;
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
 if(!$("displayName").value)$("displayName").value=savedName();
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
   tracks.forEach(t=>{local.removeTrack(t);t.stop();});
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
  let changed=false;
  for(const kind of ["audio","video"]){
   const track=kind==="audio"?local.getAudioTracks()[0]:local.getVideoTracks()[0];
   let sender=pc.getSenders().find(x=>x._solaKind===kind);
   try{
    if(sender){
     if(sender.track!==track){
      await sender.replaceTrack(track||null);
      changed=true;
     }
    }else if(track){
     sender=pc.addTrack(track,local);sender._solaKind=kind;changed=true;
    }
   }catch(e){console.warn("Media track update failed",kind,e);toast(kind==="video"?"カメラの送信に失敗したよ":"マイクの送信に失敗したよ");}
  }
  // Safari can need a new SDP exchange when a previously empty sender
  // gets its first camera or microphone track.
  if(changed)requestRenegotiation(sid,pc);
 }
}
function requestRenegotiation(sid,pc){
 if(!socket?.connected||pc.signalingState==="closed")return;
 if(socket.id<sid)makeOffer(sid,pc);
 else socket.emit("signal",{to:sid,kind:"renegotiate",payload:null});
}
$("previewMic").onclick=()=>toggleDevice("audio");
$("previewCam").onclick=()=>toggleDevice("video");
$("backBtn").onclick=()=>location.href="/";
$("joinBtn").onclick=async ()=>{
 try {
 const name=$("displayName").value.trim()||savedName()||"ゲスト";saveName();joinPassword=$("password").value;
 $("joinBtn").disabled=true;
 await loadRtcConfig();
 connect(name);
 }catch(err){toast("カメラ・マイクの許可を確認してね: "+err.message);}
};
function connect(name){
 currentDisplayName=name;
 socket=io({transports:["polling","websocket"],upgrade:true,reconnection:true,reconnectionDelay:1000,timeout:12000});
 $("status").textContent="サーバーに接続中";
 clearJoinWatchdog();
 joinWatchdog=setTimeout(()=>{if(!joined){joinFailed("入室できませんでした。学校のネットワークやサーバーの接続を確認してね。");socket?.disconnect();socket=null;}},18000);
 socket.on("connect_error",e=>{$("status").textContent="接続に失敗";console.warn("SOLA TALK connect error",e);});
 socket.on("connect",()=>{ $("status").textContent="接続済み"; if(!joined)socket.emit("join_call",{room_id:roomId,host_key:hostKey(),name,password:joinPassword}); });
 socket.on("disconnect",()=>{$("status").textContent="再接続中";joined=false;for(const pc of peers.values())pc.close();peers.clear();remoteStreams.clear();remoteScreens.clear();remoteScreenIds.clear();});
 socket.on("waiting",()=>{clearJoinWatchdog();$("status").textContent="承認待ち";toast("管理者の承認待ち");$("joinBtn").disabled=true;});
 socket.on("join_error",d=>{clearJoinWatchdog();clearResume();$("joinBtn").disabled=false;toast(d.error);socket.disconnect();socket=null;show("lobby");});
 socket.on("action_error",d=>toast(d.error));
 socket.on("rename_result",d=>{if(d.ok){currentDisplayName=d.name;names.set(socket.id,d.name);$("displayName").value=d.name;saveName();rememberResume(d.name,joinPassword);renderTiles();toast("名前を変更したよ");}else toast(d.error||"名前を変更できなかったよ");});
 socket.on("admitted",d=>{clearJoinWatchdog();joined=true;isHost=d.host;roomInfo=d.room;rememberResume(name,joinPassword);startCall();});
 socket.on("roster",d=>{names.clear();d.members.forEach(m=>names.set(m.sid,m.name));renderTiles(); for(const m of d.members){if(m.sid!==socket.id && !peers.has(m.sid))createPeer(m.sid,socket.id<m.sid);}});
 socket.on("peer_joined",d=>{
  names.set(d.sid,d.name);
  if(d.sid!==socket.id&&!peers.has(d.sid))createPeer(d.sid,socket.id<d.sid);
  beep("join");renderTiles();
 });
 socket.on("peer_left",d=>{peers.get(d.sid)?.close();peers.delete(d.sid);remoteStreams.delete(d.sid);remoteScreens.delete(d.sid);remoteScreenIds.delete(d.sid);names.delete(d.sid);beep("leave");renderTiles();});
 socket.on("signal",data=>{
  if(data.kind==="screen"){handleSignal(data);return;}
  let pc=peers.get(data.from);
  if(!pc)pc=createPeer(data.from,false);
  pc._signalQueue=pc._signalQueue.then(()=>handleSignal(data)).catch(e=>console.warn("Signal queue error",e));
 });
 socket.on("chat",d=>addMessage(d.name,d.text));
 socket.on("pending_requests",d=>{if(isHost)renderRequests(d.requests);});
 socket.on("room_state",d=>{roomInfo=d;$("lockBtn").textContent=d.locked?"ロック解除":"ルームをロック";});
 socket.on("removed",d=>{toast(d.reason);clearResume();cleanup();setTimeout(()=>location.href="/",1000);});
}
$("renameBtn").onclick=()=>{
 if(!joined||!socket?.connected)return toast("通話に接続してから変更してね");
 const input=prompt("新しい表示名（32文字以内）",currentDisplayName);
 if(input===null)return;
 socket.emit("rename_self",{name:input.trim().slice(0,32)||"ゲスト"});
};
function startCall(){
 startAudioDiagnostics();
 show("call");$("callTitle").textContent=roomInfo.name;$("hostControls").classList.toggle("hidden",!isHost);
 if(!startTime)startTime=Date.now();
 clearInterval(timerInterval);
 timerInterval=setInterval(()=>{const t=Math.floor((Date.now()-startTime)/1000);$("timer").textContent=String(Math.floor(t/60)).padStart(2,"0")+":"+String(t%60).padStart(2,"0");},1000);
 renderTiles();if(micEnabled)setupMeter();
}
function sendScreenState(sid,active,streamId){
 if(socket?.connected)socket.emit("signal",{to:sid,kind:"screen",payload:{active,streamId:streamId||null}});
}
function startAudioDiagnostics(){
 if(audioDiagnosticsTimer)clearInterval(audioDiagnosticsTimer);
 const last=new Map();
 audioDiagnosticsTimer=setInterval(async()=>{
  if(!joined)return;
  const lines=[];
  const ownVideo=local?.getVideoTracks()[0],ownAudio=local?.getAudioTracks()[0];
  lines.push("自分のマイク: "+(ownAudio?.readyState==="live"&&ownAudio.enabled?"ON":"OFF")+" / カメラ: "+(ownVideo?.readyState==="live"&&ownVideo.enabled?"ON":"OFF"));
  for(const [sid,pc] of peers){
   try{
    const stats=await pc.getStats();
    const totals={audioIn:0,audioOut:0,videoIn:0,videoOut:0,framesIn:0,framesOut:0};
    stats.forEach(s=>{
     const kind=s.kind||s.mediaType;
     if(kind!=="audio"&&kind!=="video")return;
     if(s.type==="inbound-rtp"){
      totals[kind==="audio"?"audioIn":"videoIn"]+=s.bytesReceived||0;
      if(kind==="video")totals.framesIn+=s.framesDecoded||0;
     }
     if(s.type==="outbound-rtp"){
      totals[kind==="audio"?"audioOut":"videoOut"]+=s.bytesSent||0;
      if(kind==="video")totals.framesOut+=s.framesEncoded||0;
     }
    });
    const old=last.get(sid)||totals;
    const rate=(key)=>Math.max(0,Math.round((totals[key]-old[key])/2.5/1024));
    const stream=remoteStreams.get(sid);
    const track=stream?.getVideoTracks()[0];
    const video=document.querySelector("#tile-"+sid+" video");
    const sending=pc.getSenders().find(s=>s._solaKind==="video")?.track;
    const received=rate("videoIn"),sent=rate("videoOut");
    const remoteAudio=document.querySelector("#tile-"+sid+" audio.remote-audio");
    const audioSender=pc.getSenders().find(s=>s._solaKind==="audio")?.track;
    const videoState=!track?"映像トラックなし":track.muted?"映像停止中":video?.readyState>=2?"映像再生可能":"映像読み込み中";
    lines.push((names.get(sid)||"相手")+" ("+pc.connectionState+"): 音声送信 "+rate("audioOut")+"KB/s・受信 "+rate("audioIn")+"KB/s / "+(remoteAudio?.paused?"再生停止":"再生中")+" / マイク送信 "+(audioSender?.readyState==="live"&&audioSender.enabled?"ON":"OFF")+" | 映像送信 "+sent+"KB/s・受信 "+received+"KB/s / "+videoState+" / 送信カメラ "+(sending?.readyState==="live"?"ON":"OFF"));
    last.set(sid,totals);
   }catch(e){lines.push("映像診断エラー: "+e.message);}
  }
  const box=$("audioDiagnostics");
  if(box)box.textContent=lines.join(" | ");
 },2500);
}
function classifyRemoteTrack(sid,track,streamId){
 const screenId=remoteScreenIds.get(sid);
 const isScreen=track.kind==="video"&&screenId&&screenId===streamId;
 const targetMap=isScreen?remoteScreens:remoteStreams;
 let stream=targetMap.get(sid);
 if(!stream){stream=new MediaStream();targetMap.set(sid,stream);}
 if(!stream.getTracks().includes(track))stream.addTrack(track);

 track.onmute=()=>{console.info("Remote track muted",sid,track.kind);renderTiles();};
 track.onunmute=()=>{console.info("Remote track resumed",sid,track.kind);renderTiles();if(track.kind==="audio")playRemoteAudio();};
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
 pc._signalQueue=Promise.resolve();
 // Reserve both media directions even if the microphone/camera is OFF at entry.
 // Without transceivers an audio-only call can start with no SDP media sections.
 for(const kind of ["audio","video"]){
  const track=kind==="audio"?local?.getAudioTracks()[0]:local?.getVideoTracks()[0];
  const transceiver=pc.addTransceiver(track||kind,{direction:"sendrecv",streams:[local]});
  transceiver.sender._solaKind=kind;
 }
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
 pc.onconnectionstatechange=()=>{
  $("quality").textContent=pc.connectionState;
  if(pc.connectionState==="failed"&&socket?.id<sid){
   try{pc.restartIce();requestRenegotiation(sid,pc);}catch(e){console.warn("ICE restart",e);}
  }
 };
 pc.onnegotiationneeded=()=>requestRenegotiation(sid,pc);
 if(screenStream)sendScreenState(sid,true,screenStream.id);
 if(initiator)queueMicrotask(()=>requestRenegotiation(sid,pc));
 return pc;
}
async function makeOffer(sid,pc){
 if(pc.signalingState==="closed"||!socket?.connected)return;
 if(pc.signalingState!=="stable" || pc._makingOffer){pc._offerQueued=true;return;}
 pc._makingOffer=true;
 try{
  await pc.setLocalDescription(await pc.createOffer());
  socket.emit("signal",{to:sid,kind:"offer",payload:pc.localDescription});
 }catch(e){console.warn("Offer error",e);}
 finally{
  pc._makingOffer=false;
  if(pc._offerQueued&&pc.signalingState==="stable"){
   pc._offerQueued=false;
   queueMicrotask(()=>requestRenegotiation(sid,pc));
  }
 }
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
  if(data.kind==="renegotiate"){if(socket.id<data.from)await makeOffer(data.from,pc);return;}
  if(data.kind==="offer"){
   // Only the lower socket ID is allowed to initiate offers.
   // This removes offer collisions across 2–5 participants.
   if(pc.signalingState!=="stable"){
    console.warn("Unexpected offer while negotiating",data.from);
    return;
   }
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
   if(pc.remoteDescription)await pc.addIceCandidate(data.payload);
   else{pc._pendingIce??=[];pc._pendingIce.push(data.payload);}
  }
  if(pc.signalingState==="stable"&&pc._offerQueued){
   pc._offerQueued=false;
   if(socket.id<data.from)await makeOffer(data.from,pc);
  }
 }catch(e){console.warn("Signal error",e);}
}
function videoOnlyStream(stream){
 const tracks=stream?.getVideoTracks()||[];
 return tracks.length?new MediaStream(tracks):null;
}
function audioOnlyStream(stream){
 const tracks=stream?.getAudioTracks()||[];
 return tracks.length?new MediaStream(tracks):null;
}
function playRemoteAudio(){
 for(const audio of document.querySelectorAll("#tiles audio.remote-audio")){
  if(!audio.srcObject?.getAudioTracks().length)continue;
  audio.muted=false;
  audio.volume=1;
  if(audio.paused)audio.play().catch(e=>console.warn("Remote audio autoplay blocked",e.name));
 }
}
document.addEventListener("pointerdown",()=>{if(joined)playRemoteAudio();},{passive:true});
document.addEventListener("keydown",()=>{if(joined)playRemoteAudio();});
function tile(id,name,stream,self=false){
 const node=document.createElement("div");node.className="tile";node.id="tile-"+id;
 const video=document.createElement("video");video.autoplay=true;video.playsInline=true;video.muted=true;
 video._solaTrack=stream?.getVideoTracks()[0]||null;
 video.srcObject=self?(stream||null):videoOnlyStream(stream);
 video.addEventListener("loadedmetadata",()=>video.play().catch(()=>{}));
 video.addEventListener("stalled",()=>{if(video.srcObject)video.play().catch(()=>{});});
 node.append(video);
 if(!self){const audio=document.createElement("audio");audio.className="remote-audio";audio.autoplay=true;audio.playsInline=true;audio._solaTrack=stream?.getAudioTracks()[0]||null;audio.srcObject=audioOnlyStream(stream);
 audio.addEventListener("loadedmetadata",playRemoteAudio);
 audio.addEventListener("canplay",playRemoteAudio);
 node.append(audio);}
 const caption=document.createElement("div");caption.className="person";caption.textContent=name+(self?" (自分)":"");node.append(caption);
 if(!stream || !stream.getVideoTracks().some(t=>t.enabled && t.readyState==="live"&&!t.muted)){node.classList.add("audioOnly");const av=document.createElement("div");av.className="avatar";av.textContent="👤";node.append(av);}
 return node;
}
function renderTiles(){
 if(!joined)return;
 const tiles=$("tiles");
 const desired=[["me",currentDisplayName,local,true]];
 for(const [sid,name] of names){
  if(sid!==socket?.id){
   desired.push([sid,name,remoteStreams.get(sid),false]);
   if(remoteScreenIds.has(sid))desired.push(["screen-"+sid,name+"の画面",remoteScreens.get(sid),false]);
  }
 }
 if(screenStream)desired.push(["screen-me","自分の画面",screenStream,true]);
 const wanted=new Set(desired.map(([id])=>"tile-"+id));
 for(const node of [...tiles.children])if(!wanted.has(node.id))node.remove();
 for(const [id,name,stream,self] of desired){
  let node=document.getElementById("tile-"+id);
  if(!node){node=tile(id,name,stream,self);tiles.append(node);}
  else{
   const video=node.querySelector("video");
   if(video){
    const videoTrack=stream?.getVideoTracks()[0]||null;
    if(video._solaTrack!==videoTrack){
     video._solaTrack=videoTrack;
     video.srcObject=self?(stream||null):videoOnlyStream(stream);
     if(videoTrack)video.play().catch(e=>console.warn("Video playback",e.name));
    }
   }
   if(!self){const audio=node.querySelector("audio.remote-audio");if(audio){const track=stream?.getAudioTracks()[0];if(audio._solaTrack!==track){audio._solaTrack=track||null;audio.srcObject=audioOnlyStream(stream);if(track)audio.play().catch(e=>console.warn("Audio playback",e.name));}}}
   const caption=node.querySelector(".person");
   if(caption)caption.textContent=name+(self?" (自分)":"");
   const hasVideo=!!stream&&stream.getVideoTracks().some(t=>t.enabled&&t.readyState==="live"&&!t.muted);
   node.classList.toggle("audioOnly",!hasVideo);
   let avatar=node.querySelector(".avatar");
   if(!hasVideo&&!avatar){avatar=document.createElement("div");avatar.className="avatar";avatar.textContent="👤";node.append(avatar);}
   if(hasVideo&&avatar)avatar.remove();
  }
 }
 playRemoteAudio();
}
function setupMeter(){
 if(!local||window.solaMeter)return;
 try {
 const ctx=new AudioContext(),analyser=ctx.createAnalyser(),source=ctx.createMediaStreamSource(local);
 analyser.fftSize=128;source.connect(analyser);const samples=new Uint8Array(analyser.frequencyBinCount);
 const loop=()=>{if(!joined){ctx.close();window.solaMeter=false;return;}analyser.getByteFrequencyData(samples);const avg=samples.reduce((a,b)=>a+b,0)/samples.length;$("tile-me")?.classList.toggle("speaking",avg>18&&micEnabled);setTimeout(loop,120);};
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
  if(sender){pc.removeTrack(sender);sender._solaScreen=false;if(socket.id<sid)await makeOffer(sid,pc);}
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
   if(socket.id<sid)await makeOffer(sid,pc);
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
function cleanup(){if(audioDiagnosticsTimer)clearInterval(audioDiagnosticsTimer);clearJoinWatchdog();joined=false;clearInterval(timerInterval);for(const pc of peers.values())pc.close();peers.clear();remoteScreens.clear();remoteScreenIds.clear();local?.getTracks().forEach(t=>t.stop());screenStream?.getTracks().forEach(t=>t.stop());socket?.disconnect();}
window.addEventListener("beforeunload",()=>{ /* Socket.IO disconnect releases this participant; resume token remains for reload. */ });
setupLobby();
})();