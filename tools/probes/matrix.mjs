import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const REAL_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

async function session({ profile, port, ua }) {
  mkdirSync(profile, { recursive: true });
  const c = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--no-first-run","--no-default-browser-check","--disable-background-networking",
    "--disable-sync","--disable-default-apps","--disable-blink-features=AutomationControlled",
    "--window-size=1440,2000","about:blank",
  ], { stdio: "ignore" });
  let ver;
  for (let i=0;i<60;i++){ try{ ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break;}catch{ await sleep(250);} }
  if(!ver) { c.kill("SIGKILL"); throw new Error("no cdp"); }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
  let id=0; const pending=new Map();
  ws.onmessage=(ev)=>{const m=JSON.parse(ev.data); if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
  const send=(method,params={},sessionId)=>new Promise(res=>{const mid=++id;pending.set(mid,res);ws.send(JSON.stringify({id:mid,method,params,...(sessionId?{sessionId}:{})}));});
  const {result:t}=await send("Target.createTarget",{url:"about:blank"});
  const {result:att}=await send("Target.attachToTarget",{targetId:t.targetId,flatten:true});
  const sid=att.sessionId;
  await send("Page.enable",{},sid);
  if (ua) {
    await send("Emulation.setUserAgentOverride",{userAgent:ua,acceptLanguage:"en-US,en;q=0.9",platform:"MacIntel"},sid);
  }
  const evalJs=async(e)=>{const r=await send("Runtime.evaluate",{expression:e,returnByValue:true,userGesture:true},sid);return r.result?.result?.value;};
  const nav=async(u)=>{await send("Page.navigate",{url:u},sid);};
  const close=async()=>{ try{ws.close();}catch{} c.kill("SIGKILL"); };
  return { nav, evalJs, send, sid, close };
}

const READ = `(() => ({
  href: location.href.slice(0,70),
  sorry: /sorry\\/index|unusual traffic|Verifying your request/i.test(location.href + document.body.innerText.slice(0,3000)),
  duckCaptcha: /Select all squares containing/i.test(document.body.innerText),
  h3: document.querySelectorAll('h3').length,
  ved: document.querySelectorAll('div[data-ved][data-hveid]').length,
  algo: document.querySelectorAll('li.b_algo').length,
  ddg: document.querySelectorAll('a.result-link, a.result__a').length,
  ua: navigator.userAgent.includes('Headless') ? 'HEADLESS-UA' : 'clean-UA',
}))()`;

async function googleTrial(label, {profile, port, ua, warm}) {
  const s = await session({ profile, port, ua });
  try {
    if (warm) {
      await s.nav("https://www.google.com/");
      await sleep(2000);
      const consent = await s.evalJs(`(()=>{const b=[...document.querySelectorAll('button,div[role=button]')].find(x=>/accept all|prihvati sve|i agree/i.test(x.innerText)); if(b){b.click();return 'clicked'} return 'none'})()`);
      await sleep(1500);
      console.log(`   warm-up: ${consent}, href=${await s.evalJs("location.href.slice(0,50)")}`);
    }
    await s.nav("https://www.google.com/search?q=kubernetes+operator+best+practices&num=20&hl=en");
    await sleep(4000);
    console.log(label.padEnd(34), JSON.stringify(await s.evalJs(READ)));
  } catch(e){ console.log(label.padEnd(34), "ERR", e.message); }
  finally { await s.close(); }
}

console.log("--- GOOGLE trials ---");
await googleTrial("A fresh profile, HEADLESS UA", { profile:"/tmp/serptest/pA", port:19401, ua:null });
await googleTrial("B fresh profile, clean UA", { profile:"/tmp/serptest/pB", port:19402, ua:REAL_UA });
await googleTrial("C warm-up + clean UA", { profile:"/tmp/serptest/pC", port:19403, ua:REAL_UA, warm:true });
await googleTrial("D re-use warm profile C", { profile:"/tmp/serptest/pC", port:19404, ua:REAL_UA });
