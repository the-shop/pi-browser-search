import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
const CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.83 Safari/537.36";
async function S(profile,port,extra=[]){
  const c=spawn(CHROME,["--headless=new",`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,"--no-first-run","--no-default-browser-check","--disable-background-networking","--disable-sync","--window-size=1440,2000",...extra,"about:blank"],{stdio:"ignore"});
  let v;for(let i=0;i<80;i++){try{v=await(await fetch(`http://127.0.0.1:${port}/json/version`)).json();break}catch{await sleep(250)}}
  if(!v){c.kill("SIGKILL");throw new Error("no cdp")}
  const ws=new WebSocket(v.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
  let id=0;const p=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id)}};
  const send=(M,P={},sid)=>new Promise(res=>{const i=++id;p.set(i,res);ws.send(JSON.stringify({id:i,method:M,params:P,...(sid?{sessionId:sid}:{})}))});
  const {result:t}=await send("Target.createTarget",{url:"about:blank"});
  const {result:a}=await send("Target.attachToTarget",{targetId:t.targetId,flatten:true});const sid=a.sessionId;
  await send("Page.enable",{},sid);
  await send("Emulation.setUserAgentOverride",{userAgent:UA,acceptLanguage:"en-US,en;q=0.9",platform:"MacIntel"},sid);
  await send("Page.addScriptToEvaluateOnNewDocument",{source:`Object.defineProperty(navigator,'webdriver',{get:()=>undefined});`},sid);
  const ev=async x=>{const r=await send("Runtime.evaluate",{expression:x,returnByValue:true,userGesture:true},sid);return r.result?.result?.value};
  return {nav:u=>send("Page.navigate",{url:u},sid),ev,close:async()=>{try{ws.close()}catch{};c.kill("SIGKILL")}};
}
const R=`(()=>({href:location.href.slice(0,60),sorry:/sorry\\/index|unusual traffic/i.test(location.href+document.body.innerText.slice(0,1500)),signedIn:/Sign out|Odjava|My Account/i.test(document.body.innerText.slice(0,3000)),h3:document.querySelectorAll('h3').length,ved:document.querySelectorAll('div[data-ved][data-hveid]').length,body:document.body.innerText.slice(0,150).replace(/\\s+/g,' ')}))()`;

console.log("=== real profile COPY, headless ===");
let s=await S("/tmp/serptest/pReal",19701);
await s.nav("https://www.google.com/search?q=kubernetes+operator+best+practices&num=20&hl=en");
await sleep(5000);
console.log(JSON.stringify(await s.ev(R),null,1));
await s.close();
