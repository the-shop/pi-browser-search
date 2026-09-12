// How many Google queries can we sustain before a soft block? Sizes the 70% lane pacing.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
const CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.83 Safari/537.36";
const PROFILE = join(tmpdir(),"p0b");   // the bootstrapped profile from Phase 0b

const c=spawn(CHROME,["--headless=new","--remote-debugging-port=19920",`--user-data-dir=${PROFILE}`,
 "--no-first-run","--no-default-browser-check","--disable-background-networking","--disable-sync",
 "--window-size=1440,2000","about:blank"],{stdio:"ignore"});
let v;for(let i=0;i<80;i++){try{v=await(await fetch("http://127.0.0.1:19920/json/version")).json();break}catch{await sleep(250)}}
const ws=new WebSocket(v.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let id=0;const p=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}};
const send=(M,P={},sid)=>new Promise(res=>{const i=++id;p.set(i,res);ws.send(JSON.stringify({id:i,method:M,params:P,...(sid?{sessionId:sid}:{})}));});
const {result:t}=await send("Target.createTarget",{url:"about:blank"});
const {result:a}=await send("Target.attachToTarget",{targetId:t.targetId,flatten:true});const sid=a.sessionId;
await send("Page.enable",{},sid);
await send("Emulation.setUserAgentOverride",{userAgent:UA,acceptLanguage:"en-US,en;q=0.9",platform:"MacIntel"},sid);
await send("Page.addScriptToEvaluateOnNewDocument",{source:`Object.defineProperty(navigator,'webdriver',{get:()=>undefined});`},sid);
const ev=async x=>{const r=await send("Runtime.evaluate",{expression:x,returnByValue:true,userGesture:true},sid);return r.result?.result?.value;};

const queries=["rust ownership rules","kafka vs rabbitmq","pytest fixtures scope","css grid vs flexbox","docker multi stage build",
  "typescript satisfies operator","linux io_uring explained","react server components","sqlite wal mode","terraform state locking",
  "nginx reverse proxy config","python gil removed"];
let ok=0, sorry=0; const t0=Date.now();
for (const [i,q] of queries.entries()) {
  await send("Page.navigate",{url:"https://www.google.com/search?q="+encodeURIComponent(q)+"&num=20&hl=en"},sid);
  const gap = 1800 + Math.random()*1400;
  await sleep(3200);
  const r=await ev(`(()=>({sorry:/sorry\\/index|unusual traffic/i.test(location.href+document.body.innerText.slice(0,1200)),n:document.querySelectorAll('h3').length,ved:document.querySelectorAll('div[data-ved][data-hveid]').length}))()`);
  if (r.sorry) { sorry++; console.log(` ${String(i+1).padStart(2)}. SORRY  <-- blocked at query ${i+1}`); }
  else { ok++; console.log(` ${String(i+1).padStart(2)}. ok  ${String(r.n).padStart(2)}res ${String(r.ved).padStart(3)}ved  (gap ${Math.round(gap)}ms)`); }
  await sleep(gap);
}
console.log(`\n=== ${ok}/${queries.length} succeeded, ${sorry} blocked, ${((Date.now()-t0)/1000).toFixed(1)}s total ===`);
ws.close(); c.kill("SIGKILL");
