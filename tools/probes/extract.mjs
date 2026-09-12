import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
const CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.83 Safari/537.36";
async function S(profile,port){
  const c=spawn(CHROME,["--headless=new",`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,"--no-first-run","--no-default-browser-check","--disable-background-networking","--disable-sync","--window-size=1440,2000","about:blank"],{stdio:"ignore"});
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
// Durable Google extraction: anchor whose child is h3, walk up to the data-hveid block
const EXTRACT=`(()=>{
  const seen=new Set(); const out=[];
  for (const h3 of document.querySelectorAll('h3')) {
    const a = h3.closest('a') || h3.parentElement?.querySelector('a');
    if (!a || !a.href.startsWith('http')) continue;
    if (a.href.includes('google.com/')) continue;
    if (seen.has(a.href)) continue; seen.add(a.href);
    let block = h3.closest('div[data-hveid]') || h3.closest('div[data-snc]') || a.closest('div');
    let snip = '';
    if (block) {
      const cands=[...block.querySelectorAll('div[data-sncf], div.VwiC3b, div[data-content-feature], span.aCOpRe, div.lEBKkf')];
      snip = cands.map(c=>c.innerText).filter(Boolean).join(' ').slice(0,300);
      if (!snip) snip = (block.innerText||'').replace(/\\s+/g,' ').slice(0,300);
    }
    out.push({ title: h3.innerText.trim(), url: a.href, snippet: snip });
  }
  return out;
})()`;

const s=await S("/tmp/serptest/pReal",19801);
const queries=["kubernetes operator best practices","rust async runtime comparison","postgres index bloat vacuum"];
for (const q of queries) {
  const t0=Date.now();
  await s.nav("https://www.google.com/search?q="+encodeURIComponent(q)+"&num=20&hl=en");
  await sleep(4000);
  const st=await s.ev(`(()=>({sorry:/sorry\\/index|unusual traffic/i.test(location.href+document.body.innerText.slice(0,1000)), ved:document.querySelectorAll('div[data-ved][data-hveid]').length}))()`);
  const res=await s.ev(EXTRACT);
  console.log(`\nQ: ${q}`);
  console.log(`   ${Date.now()-t0}ms  sorry=${st.sorry}  ved=${st.ved}  extracted=${Array.isArray(res)?res.length:'ERR'}`);
  if (Array.isArray(res)) res.slice(0,3).forEach((r,i)=>console.log(`   [${i+1}] ${r.title.slice(0,50)} | ${r.url.slice(0,55)}\n       ${(r.snippet||'').slice(0,90)}`));
  await sleep(2500+Math.random()*2000);
}
await s.close();
