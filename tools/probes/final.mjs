import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
const CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.83 Safari/537.36";
const SOCS="CAISNQgQEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjUwMTA4LjA4X3AxGgJlbiACGgYIgLC_pwY";

async function S(profile,port){
  mkdirSync(profile,{recursive:true});
  const c=spawn(CHROME,["--headless=new",`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,"--no-first-run","--no-default-browser-check","--disable-background-networking","--disable-sync","--disable-blink-features=AutomationControlled","--window-size=1440,2000","about:blank"],{stdio:"ignore"});
  let v;for(let i=0;i<60;i++){try{v=await(await fetch(`http://127.0.0.1:${port}/json/version`)).json();break}catch{await sleep(250)}}
  if(!v){c.kill("SIGKILL");throw new Error("no cdp")}
  const ws=new WebSocket(v.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
  let id=0;const p=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id)}};
  const send=(M,P={},sid)=>new Promise(res=>{const i=++id;p.set(i,res);ws.send(JSON.stringify({id:i,method:M,params:P,...(sid?{sessionId:sid}:{})}))});
  const {result:t}=await send("Target.createTarget",{url:"about:blank"});
  const {result:a}=await send("Target.attachToTarget",{targetId:t.targetId,flatten:true});const sid=a.sessionId;
  await send("Page.enable",{},sid);
  await send("Emulation.setUserAgentOverride",{userAgent:UA,acceptLanguage:"en-US,en;q=0.9",platform:"MacIntel"},sid);
  // strip automation tells
  await send("Page.addScriptToEvaluateOnNewDocument",{source:`
    Object.defineProperty(navigator,'webdriver',{get:()=>undefined});
    Object.defineProperty(navigator,'plugins',{get:()=>[1,2,3,4,5]});
    window.chrome=window.chrome||{runtime:{}};
  `},sid);
  await send("Network.enable",{},sid);
  const ev=async x=>{const r=await send("Runtime.evaluate",{expression:x,returnByValue:true,userGesture:true},sid);return r.result?.result?.value};
  return {send,sid,nav:u=>send("Page.navigate",{url:u},sid),ev,close:async()=>{try{ws.close()}catch{};c.kill("SIGKILL")}};
}
const R=`(()=>({href:location.href.slice(0,55),sorry:/sorry\\/index|unusual traffic/i.test(location.href+document.body.innerText.slice(0,1500)),consent:/consent\\.google/i.test(location.href),captcha:/Select all squares|are you a robot/i.test(document.body.innerText),h3:document.querySelectorAll('h3').length,ved:document.querySelectorAll('div[data-ved][data-hveid]').length,algo:document.querySelectorAll('li.b_algo').length,sp:document.querySelectorAll('.w-gl__result, .result, article').length,ddg:document.querySelectorAll('a.result-link,a.result__a').length}))()`;

// trial 1: Google with SOCS consent cookie pre-injected
let s=await S("/tmp/serptest/pG",19601);
await s.send("Network.setCookie",{name:"SOCS",value:SOCS,domain:".google.com",path:"/",secure:true},s.sid);
await s.send("Network.setCookie",{name:"CONSENT",value:"YES+cb",domain:".google.com",path:"/",secure:true},s.sid);
await s.nav("https://www.google.com/search?q=kubernetes+operator+best+practices&num=20&hl=en&gl=us");
await sleep(4500);
console.log("google+SOCS cookie        ", JSON.stringify(await s.ev(R)));
await s.close();

// trial 2: Google gbv=1 with consent click
s=await S("/tmp/serptest/pG2",19602);
await s.nav("https://www.google.com/search?q=kubernetes+operator+best+practices&num=20&gbv=1&hl=en");
await sleep(2500);
console.log("google gbv=1 landing      ", JSON.stringify(await s.ev(R)));
const clicked=await s.ev(`(()=>{const b=[...document.querySelectorAll('button,div[role=button],form button')].find(x=>/accept all|i agree|agree/i.test(x.innerText));if(b){b.click();return 'clicked '+b.innerText.slice(0,20)}return 'no button'})()`);
await sleep(2500);
console.log("  after consent:",clicked,"->",JSON.stringify(await s.ev(R)));
await s.close();

// trial 3: Startpage quality
s=await S("/tmp/serptest/pSP",19603);
await s.nav("https://www.startpage.com/sp/search?query=kubernetes+operator+best+practices");
await sleep(4000);
console.log("startpage                 ", JSON.stringify(await s.ev(R)));
const sp=await s.ev(`(()=>[...document.querySelectorAll('.w-gl__result')].slice(0,4).map(r=>({t:(r.querySelector('a')?.innerText||'').slice(0,60),u:(r.querySelector('a')?.href||'').slice(0,70)})))()`);
console.log("  sample:",JSON.stringify(sp,null,1));
await s.close();

// trial 4: DDG lite with CLEAN UA in browser
s=await S("/tmp/serptest/pD",19604);
await s.nav("https://lite.duckduckgo.com/lite/?q=kubernetes+operator+best+practices");
await sleep(3000);
console.log("ddg-lite clean-UA browser ", JSON.stringify(await s.ev(R)));
await s.close();

// trial 5: Bing with clean UA
s=await S("/tmp/serptest/pB",19605);
await s.nav("https://www.bing.com/search?q=kubernetes+operator+best+practices&count=20");
await sleep(3000);
console.log("bing clean-UA browser     ", JSON.stringify(await s.ev(R)));
await s.close();
