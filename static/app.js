(() => {
"use strict";
const $ = id => document.getElementById(id);
const roomId = window.SOLA_ROOM_ID;
let roomInfo = null, socket = null, local = null, screenStream = null, joined = false, isHost = false;
let micEnabled = true, camEnabled = true, startTime = 0, timerInterval = null;
const peers = new Map(), remoteStreams = new Map(), names = new Map();
const hostStorageKey = id => "sola-talk-host-" + id;

const rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
const toast = message => { const t=$("toast"); t.textContent=message; t.style.display="block"; setTimeout(()=>{ if(t.textContent===message)t.style.display="none"; },4000); };
const show = id => { ["home","lobby","call"].forEach(x=>$(x).classList.toggle("hidden",x!==id)); };
const safeName = name => name || "ゲスト";
const beep = () => { try { const a=new (window.AudioContext||window.webkitAudioContext)(), o=a.createOscillator(), g=a.createGain();o.connect(g);g.connect(a.destination);o.frequency.value=640;g.gain.value=.035;o.start();o.stop(a.currentTime+.09);setTimeout(()=>a.close(),220);}catch{} };
const shareUrl = () => location.origin + "/r/" + roomId;
const hostKey = () => sessionStorage.getItem(hostStorageKey(roomId)) || "";
const setTheme = val => {document.body.classList.toggle("light",val==="light");localStorage.setItem("sola-talk-theme",val);};
setTheme(localStorage.getItem("sola-talk-theme")||"dark");
$("themeBtn").onclick=()=>setTheme(document.body.classList.contains("light")?"dark":"light");
$("displayName").value=localStorage.getItem("sola-talk-name")||"";
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
 $("preview").muted=true;
 $("preview").playsInline=true;
 if(camEnabled)$("preview").play().catch(e=>console.warn("Preview playback:",e));
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
   }catch(e){
     console.warn("Media permission/device error:",e);
     const label=isMic?"マイク":"カメラ";
     if(e.name==="NotAllowedError"||e.name==="PermissionDeniedError"){
       toast(label+"の使用がブロックされている可能性があるよ。アドレスバー横のサイト設定で許可してから、もう一度ONを押してね");
     }else if(e.name==="OverconstrainedError"){
       toast(label+"の画質設定が端末に合わなかったよ。もう一度ONを押してね");
     }else if(e.name==="NotFoundError"||e.name==="DevicesNotFoundError"){
       toast(label+"が見つからないよ。Macの接続機器を確認してね");
     }else if(e.name==="NotReadableError"||e.name==="TrackStartError"){
       toast(label+"を別のアプリが使用中かもしれないよ。ほかのアプリを閉じて再試行してね");
     }else{
       toast(label+"を開始できなかったよ（"+e.name+"）。ブラウザの設定を確認してね");
     }
     return;
   }
 }
 updateDeviceUI();
 await syncTracks();
}
async function syncTracks(){
 for(const [sid,pc] of peers){
   const senders=pc.getSenders();
   for(const kind of ["audio","video"]){
     const track=kind==="audio"?local.getAudioTracks()[0]:local.getVideoTracks()[0];
     const sender=senders.find(x=>x._solaKind===kind) || senders.find(x=>x.track?.kind===kind && !(screenStream && screenStream.getTracks().includes(x.track)));
     if(sender){await sender.replaceTrack(track||null);}
     else if(track){const added=pc.addTrack(track,local);added._solaKind=kind;await makeOffer(sid,pc);}
   }
 }
}
$("previewMic").onclick=()=>toggleDevice("audio");
$("previewCam").onclick=()=>toggleDevice("video");
$("backBtn").onclick=()=>location.href="/";
$("joinBtn").onclick=async ()=>{
 try {
 const name=$("displayName").value.trim()||"ゲスト";localStorage.setItem("sola-talk-name",name);
 $("joinBtn").disabled=true;
 connect(name);
 }catch(err){toast("カメラ・マイクの許可を確認してね: "+err.message);}
};
function connect(name){
 socket=io({transports:["websocket","polling"],reconnection:true});
 socket.on("connect",()=>{ $("status").textContent="接続済み"; if(!joined)socket.emit("join_call",{room_id:roomId,host_key:hostKey(),name,password:$("password").value}); });
 socket.on("disconnect",()=>{$("status").textContent="再接続中";joined=false;for(const pc of peers.values())pc.close();peers.clear();remoteStreams.clear();});
 socket.on("waiting",()=>{toast("管理者の承認待ち");$("joinBtn").disabled=true;});
 socket.on("join_error",d=>{$("joinBtn").disabled=false;toast(d.error);});
 socket.on("action_error",d=>toast(d.error));
 socket.on("admitted",d=>{joined=true;isHost=d.host;roomInfo=d.room;startCall();});
 socket.on("roster",d=>{names.clear();d.members.forEach(m=>names.set(m.sid,m.name));renderTiles(); for(const m of d.members){if(m.sid!==socket.id && !peers.has(m.sid))createPeer(m.sid,socket.id<m.sid);}});
 socket.on("peer_joined",d=>{names.set(d.sid,d.name);beep();renderTiles();});
 socket.on("peer_left",d=>{peers.get(d.sid)?.close();peers.delete(d.sid);remoteStreams.delete(d.sid);names.delete(d.sid);beep();renderTiles();});
 socket.on("signal",handleSignal);
 socket.on("chat",d=>addMessage(d.name,d.text));
 socket.on("pending_requests",d=>{if(isHost)renderRequests(d.requests);});
 socket.on("room_state",d=>{roomInfo=d;$("lockBtn").textContent=d.locked?"ロック解除":"ルームをロック";});
 socket.on("removed",d=>{toast(d.reason);cleanup();setTimeout(()=>location.href="/",1000);});
}
function startCall(){
 show("call");$("callTitle").textContent=roomInfo.name;$("hostControls").classList.toggle("hidden",!isHost);
 if(!startTime)startTime=Date.now();
 clearInterval(timerInterval);
 timerInterval=setInterval(()=>{const t=Math.floor((Date.now()-startTime)/1000);$("timer").textContent=String(Math.floor(t/60)).padStart(2,"0")+":"+String(t%60).padStart(2,"0");},1000);
 renderTiles();setupMeter();
}
function createPeer(sid,initiator){
 const pc=new RTCPeerConnection(rtcConfig);peers.set(sid,pc);
 for(const kind of ["audio","video"]){const t=local?.getTracks().find(t=>t.kind===kind);const tr=pc.addTransceiver(t||kind,{direction:"sendrecv",streams:[local]});tr.sender._solaKind=kind;}
 if(screenStream)screenStream.getTracks().forEach(t=>pc.addTrack(t,screenStream));
 pc.onicecandidate=e=>{if(e.candidate)socket.emit("signal",{to:sid,kind:"candidate",payload:e.candidate});};
 pc.ontrack=e=>{let stream=remoteStreams.get(sid);if(!stream){stream=new MediaStream();remoteStreams.set(sid,stream);}stream.addTrack(e.track);e.track.onended=renderTiles;renderTiles();};
 pc.onconnectionstatechange=()=>{$("quality").textContent=pc.connectionState;};
 if(initiator)makeOffer(sid,pc);
 return pc;
}
async function makeOffer(sid,pc){try{const offer=await pc.createOffer();await pc.setLocalDescription(offer);socket.emit("signal",{to:sid,kind:"offer",payload:pc.localDescription});}catch(e){console.error(e);}}
async function handleSignal(data){
 try{
 let pc=peers.get(data.from);
 if(!pc)pc=createPeer(data.from,false);
 if(data.kind==="offer"){
 await pc.setRemoteDescription(data.payload);
 for(const candidate of pc._pendingIce||[])await pc.addIceCandidate(candidate);
 pc._pendingIce=[];
 const ans=await pc.createAnswer();await pc.setLocalDescription(ans);
 socket.emit("signal",{to:data.from,kind:"answer",payload:pc.localDescription});
 }else if(data.kind==="answer"){await pc.setRemoteDescription(data.payload);for(const candidate of pc._pendingIce||[])await pc.addIceCandidate(candidate);pc._pendingIce=[];}
 else if(data.kind==="candidate"){if(pc.remoteDescription)await pc.addIceCandidate(data.payload);else{pc._pendingIce??=[];pc._pendingIce.push(data.payload);}}
 }catch(e){console.warn("Signal error",e);}
}
function tile(id,name,stream,self=false){
 const node=document.createElement("div");node.className="tile";node.id="tile-"+id;
 const video=document.createElement("video");video.autoplay=true;video.playsInline=true;video.muted=self;video.srcObject=stream||null;node.append(video);
 if(stream?.getVideoTracks().length)video.addEventListener("loadedmetadata",()=>video.play().catch(e=>console.warn("Video playback:",e)),{once:true});
 const caption=document.createElement("div");caption.className="person";caption.textContent=name+(self?" (自分)":"");node.append(caption);
 if(!stream || !stream.getVideoTracks().some(t=>t.enabled && t.readyState==="live")){node.classList.add("audioOnly");const av=document.createElement("div");av.className="avatar";av.textContent="👤";node.append(av);}
 return node;
}
function renderTiles(){
 if(!joined)return;
 const tiles=$("tiles");tiles.replaceChildren();
 tiles.append(tile("me",localStorage.getItem("sola-talk-name")||"自分",local,true));
 for(const [sid,name] of names){if(sid!==socket?.id)tiles.append(tile(sid,name,remoteStreams.get(sid)));}
 if(screenStream)tiles.append(tile("screen","共有中の画面",screenStream,true));
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
 const old=screenStream;
 if(!old)return;
 screenStream=null;
 old.getTracks().forEach(t=>{t.onended=null;t.stop();});
 for(const [sid,pc] of peers){
   const sender=pc.getSenders().find(x=>x.track && old.getTracks().includes(x.track));
   if(sender){pc.removeTrack(sender);await makeOffer(sid,pc);}
 }
 $("screenBtn").textContent="▣ 画面共有";
 renderTiles();
}
$("screenBtn").onclick=async()=>{
 if(screenStream){await stopScreenShare();return;}
 if(!navigator.mediaDevices?.getDisplayMedia){toast("このブラウザでは画面共有できないよ。HTTPSでChromeなどを使ってね");return;}
 try{
   // getDisplayMedia must be called directly from the click handler.
   // Avoid min/max/exact constraints: several browsers reject them.
   const stream=await navigator.mediaDevices.getDisplayMedia({
     video:{frameRate:{ideal:10},width:{ideal:1280},height:{ideal:720}},
     audio:false
   });
   screenStream=stream;
   const track=stream.getVideoTracks()[0];
   if(!track)throw Error("画面が選択されませんでした");
   track.onended=()=>{stopScreenShare().catch(console.error);};
   try{await track.applyConstraints({frameRate:{ideal:10,max:10}});}catch(e){console.info("Screen frame rate constraint not supported",e);}
   for(const [sid,pc] of peers){pc.addTrack(track,stream);await makeOffer(sid,pc);}
   $("screenBtn").textContent="共有停止";
   renderTiles();
 }catch(e){
   console.warn("Screen share error:",e);
   if(e.name==="NotAllowedError"||e.name==="PermissionDeniedError"){
     toast("画面共有が許可されなかったよ。Macの「システム設定 → プライバシーとセキュリティ → 画面収録とシステムオーディオ録音」でブラウザを許可してね");
   }else if(e.name==="NotSupportedError"||e.name==="TypeError"){
     toast("このブラウザでは画面共有の設定に対応していないよ。Chromeの最新版などで試してね");
   }else{toast("画面共有できなかったよ（"+e.name+"）");}
 }
};
$("chatBtn").onclick=()=>$("chatPanel").classList.toggle("hidden");
$("inviteBtn").onclick=async()=>{try{await navigator.clipboard.writeText(shareUrl());toast("招待URLをコピーしたよ");}catch{toast(shareUrl());}};
$("leaveBtn").onclick=()=>{if(confirm("通話から退出する？")){socket?.emit("leave_call");cleanup();location.href="/";}};
$("chatForm").onsubmit=e=>{e.preventDefault();const val=$("chatInput").value.trim();if(val&&joined){socket.emit("chat",{text:val});$("chatInput").value="";}};
function addMessage(name,text){const box=document.createElement("div");box.className="msg";const small=document.createElement("small");small.textContent=name;const content=document.createElement("div");content.textContent=text;box.append(small,content);$("messages").append(box);$("messages").scrollTop=$("messages").scrollHeight;beep();}
function manage(action,options={}){socket.emit("manage",{room_id:roomId,host_key:hostKey(),action,...options});}
function renderRequests(requests){const box=$("requests");box.replaceChildren();for(const r of requests){const line=document.createElement("div");line.textContent=r.name+" が参加申請中 ";const yes=document.createElement("button");yes.textContent="承認";yes.onclick=()=>manage("approve",{target:r.sid});const no=document.createElement("button");no.className="secondary";no.textContent="拒否";no.onclick=()=>manage("reject",{target:r.sid});line.append(yes,no);box.append(line);} }
$("lockBtn").onclick=()=>manage("lock",{value:!roomInfo.locked});
$("endBtn").onclick=()=>{if(confirm("全員の通話を終了する？"))manage("end");};
function cleanup(){joined=false;clearInterval(timerInterval);for(const pc of peers.values())pc.close();peers.clear();local?.getTracks().forEach(t=>t.stop());screenStream?.getTracks().forEach(t=>t.stop());socket?.disconnect();}
window.addEventListener("beforeunload",()=>{if(joined)socket?.emit("leave_call");});
setupLobby();
})();