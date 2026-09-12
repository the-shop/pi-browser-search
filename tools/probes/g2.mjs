import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
const CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const REAL_UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

async function launch(extra, profile, port){
  mkdirSync(profile,{recursive:true});
  const c=spawn(CHROME,[...extra,`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,"--no-first-run","--no-default-browser-check","--disable-background-networking","--disable-sync","--window-size=1280,1600","about:blank"],{stdio:"ignore"});
  let ver; for(let i=0;i<60;i++){try{ver=await(await fetch(`http://127.0.0.1:${port}/json/version`)).json();break;}catch{await sleep(250);}}
  if(!ver){c.kill("SIGKILL");throw new Error("no cdp");}
  const ws=new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  let id=0;const pending=new Map();
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
  const send=(method,params={},sessionId)=>new Promise(res=>{const mid=++id;pending.set(mid,res);ws.send(JSON.stringify({id:mid,method,params,...(sessionId?{sessionId}:{})}));});
  const {result:t}=await send("Target.createTarget",{url:"about:blank"});
  const {result:a}=await send("Target.attachToTarget",{targetId:t.targetId,flatten:true});
  await send("Page.enable",{},a.sessionId);
  await send("Emulation.setUserAgentOverride",{userAgent:REAL_UA,acceptLanguage:"en-US,en;q=0.9",platform:"MacIntel"},a.sessionId);
  const ev=async x=>{const r=await send("Runtime.evaluate",{expression:x,returnByValue:true,userGesture:true},a.sessionId);return r.result?.result?.value;};
  return {nav:u=>send("Page.navigate",{url:u},a.sessionId),ev,close:async()=>{try{ws.close()}catch{};c.kill("SIGKILL");}};
}
const READ=`(()=>({href:location.href.slice(0,60),sorry:/sorry\\/index|unusual traffic/i.test(location.href+document.body.innerText.slice(0,2000)),h3:document.querySelectorAll('h3').length,ved:document.querySelectorAll('div[data-ved][data-hveid]').length,res:document.querySelectorAll('a.result-link,a.result__a,article, .result, li.b_algo, .g').length,headless:navigator.userAgent.includes('Headless')}))()`;

async function trial(label,{extra,profile,port,url,wait=4000}){
  let s; try{ s=await launch(extra,profile,port);
    await s.nav(url); await sleep(wait);
    console.log(label.padEnd(30), JSON.stringify(await s.ev(READ)));
  }catch(e){console.log(label.padEnd(30),"ERR",e.message.slice(0,60));}
  finally{ if(s) await s.close(); }
}

const Q="kubernetes+operator+best+practices";
console.log("--- is it headless-detection or IP? ---");
await trial("HEADFUL fresh profile",{extra:[],profile:"/tmp/serptest/hF",port:19501,url:`https://www.google.com/search?q=${Q}&num=20&hl=en`});
await trial("headless=old",{extra:["--headless=old"],profile:"/tmp/serptest/hO",port:19502,url:`https://www.google.com/search?q=${Q}&num=20&hl=en`});
await trial("google gbv=1 (no-JS)",{extra:["--headless=new"],profile:"/tmp/serptest/hG",port:19503,url:`https://www.google.com/search?q=${Q}&num=20&gbv=1&hl=en`});
await trial("google udm=14 (web only)",{extra:["--headless=new"],profile:"/tmp/serptest/hU",port:19504,url:`https://www.google.com/search?q=${Q}&num=20&udm=14&hl=en`});
console.log("--- Google-substitute engines (headless) ---");
await trial("startpage (Google proxy)",{extra:["--headless=new"],profile:"/tmp/serptest/hS",port:19505,url:"https://www.startpage.com/sp/search?query="+Q});
await trial("brave search",{extra:["--headless=new"],profile:"/tmp/serptest/hB",port:19506,url:"https://search.brave.com/search?q="+Q});
await trial("ecosia",{extra:["--headless=new"],profile:"/tmp/serptest/hE",port:19507,url:"https://www.ecosia.org/search?q="+Q});
await trial("mojeek",{extra:["--headless=new"],profile:"/tmp/serptest/hM",port:19508,url:"https://www.mojeek.com/search?q="+Q});
await trial("bing (control)",{extra:["--headless=new"],profile:"/tmp/serptest/hN",port:19509,url:"https://www.bing.com/search?q="+Q+"&count=20"});
