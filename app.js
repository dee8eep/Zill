const socket=io({autoConnect:false});const $=id=>document.getElementById(id);
let name="",code="",joined=false,mode="create",typingTimer,members=0;
function err(s){$("error").textContent=s||""}
function switchMode(m){mode=m;$("createPanel").classList.toggle("hidden",m!=="create");$("joinPanel").classList.toggle("hidden",m!=="join");$("createTab").classList.toggle("active",m==="create");$("joinTab").classList.toggle("active",m==="join");err("")}
$("createTab").onclick=()=>switchMode("create");$("joinTab").onclick=()=>switchMode("join");
async function api(path,data){const r=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify(data)});const j=await r.json().catch(()=>({error:"استجابة غير صالحة من الخادم."}));if(!r.ok)throw new Error(j.error||"حدث خطأ.");return j}
async function enterRoom(roomCode){
  code=roomCode;
  // Connect only after the HTTP request has saved the authorization in the session,
  // so the Socket.IO handshake receives the updated session cookie/state.
  if(!socket.connected){
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{socket.off("connect",onConnect);reject(new Error("انتهت مهلة الاتصال بالخادم."))},10000);
      const onConnect=()=>{clearTimeout(timer);resolve()};
      socket.once("connect",onConnect);
      socket.connect();
    });
  }
  await new Promise((resolve,reject)=>socket.emit("join",{name,code},r=>r?.ok?resolve():reject(new Error(r?.error||"تعذر الانضمام."))));
  joined=true;$("loginScreen").classList.add("hidden");$("chatScreen").classList.remove("hidden");$("shareCode").value=code;$("msgInput").focus();setConn(socket.connected);
}
$("createButton").onclick=async()=>{name=$("nameInput").value.trim();if(!name)return err("اكتب اسم العرض أولاً.");$("createButton").disabled=true;err("");try{const r=await api("/api/rooms",{name});await enterRoom(r.code)}catch(e){err(e.message)}finally{$("createButton").disabled=false}};
$("joinButton").onclick=async()=>{name=$("nameInput").value.trim();const c=$("codeInput").value.trim();if(!name)return err("اكتب اسم العرض أولاً.");if(!c)return err("أدخل رمز الدعوة.");$("joinButton").disabled=true;err("");try{const r=await api("/api/rooms/join",{name,code:c});await enterRoom(r.code)}catch(e){err(e.message)}finally{$("joinButton").disabled=false}};
function setConn(ok){$("connectionStatus").textContent=ok?"● متصل بالخادم"+(joined&&members?" — المتصلون: "+members:""):"○ انقطع الاتصال — جارٍ إعادة المحاولة";$("connectionStatus").classList.toggle("offline",!ok);$("sendButton").disabled=!ok||!joined}
function system(t){const d=document.createElement("div");d.className="system";d.textContent=t;$("messages").append(d);$("messages").scrollTop=$("messages").scrollHeight}
function addMsg(n,t,mine,time){const d=document.createElement("div");d.className="msg "+(mine?"mine":"theirs");const a=document.createElement("div");a.className="name";a.textContent=n;const b=document.createElement("div");b.textContent=t;const c=document.createElement("div");c.className="time";c.textContent=new Date(time||Date.now()).toLocaleTimeString("ar-DZ",{hour:"2-digit",minute:"2-digit"});d.append(a,b,c);$("messages").append(d);$("messages").scrollTop=$("messages").scrollHeight}
$("messageForm").onsubmit=e=>{e.preventDefault();const input=$("msgInput"),text=input.value.trim();if(!text||!joined||!socket.connected)return;$("sendButton").disabled=true;socket.emit("message",{code,text},r=>{setConn(socket.connected);if(!r?.ok){system(r?.error||"تعذر الإرسال.");return}if(r.message)addMsg(r.message.name,r.message.text,true,r.message.time);input.value="";socket.emit("typing",false);input.focus()})};
$("msgInput").oninput=()=>{if(!joined)return;socket.emit("typing",true);clearTimeout(typingTimer);typingTimer=setTimeout(()=>socket.emit("typing",false),900)};
$("copyButton").onclick=async()=>{try{await navigator.clipboard.writeText(code);$("copyButton").textContent="تم النسخ ✓";setTimeout(()=>$("copyButton").textContent="نسخ الرمز",1400)}catch{$("shareCode").select();system("تعذر النسخ التلقائي؛ حدّد الرمز وانسخه يدوياً.")}};
$("leaveButton").onclick=()=>{socket.emit("leave");joined=false;code="";members=0;$("typingStatus").textContent="";$("messages").replaceChildren();$("chatScreen").classList.add("hidden");$("loginScreen").classList.remove("hidden");$("codeInput").value="";err("")};
socket.on("connect",()=>{setConn(true);if(joined&&code){socket.emit("join",{name,code},r=>{if(r?.ok){system("تمت إعادة الاتصال.")}else{joined=false;setConn(true);system(r?.error||"تعذرت إعادة الانضمام، غادر الغرفة وادخل من جديد.")}})}});socket.on("disconnect",()=>{setConn(false);$("typingStatus").textContent=""});
socket.on("message",d=>{if(joined&&d)addMsg(d.name,d.text,false,d.time)});socket.on("system",d=>{if(joined&&d?.text)system(d.text)});socket.on("typing",d=>{if(joined)$("typingStatus").textContent=d?.typing?`${d.name} يكتب الآن…`:""});
socket.on("count",d=>{members=d?.members||0;setConn(socket.connected)});
