// Phase 0: isolate WHAT makes Google accept the profile.
// Vary: auth cookies (present/absent) x browsing history (present/absent).
import { spawn } from "node:child_process";
import { cpSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";

const SRC = process.env.HOME + "/Library/Application Support/Google/Chrome";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.83 Safari/537.36";

// Cookies that indicate a logged-in Google identity. Keep the anonymous ones (NID/SOCS/AEC).
const AUTH = ["SID","HSID","SSID","APISID","SAPISID","LSID","OSID",
  "__Secure-1PSID","__Secure-3PSID","__Secure-1PAPISID","__Secure-3PAPISID",
  "__Secure-1PSIDTS","__Secure-3PSIDTS","__Secure-1PSIDCC","__Secure-3PSIDCC",
  "SIDCC","ACCOUNT_CHOOSER","SAPISIDHASH","__Host-1PLSID","__Host-3PLSID","__Host-GAPS"];

function buildProfile(dest, { keepAuth, keepHistory }) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(join(dest, "Default"), { recursive: true });
  cpSync(join(SRC, "Local State"), join(dest, "Local State"));
  for (const f of ["Cookies","Preferences","Web Data","Secure Preferences"]) {
    if (existsSync(join(SRC, "Default", f))) cpSync(join(SRC, "Default", f), join(dest, "Default", f));
  }
  if (keepHistory && existsSync(join(SRC,"Default","History"))) cpSync(join(SRC,"Default","History"), join(dest,"Default","History"));
  const db = new DatabaseSync(join(dest, "Default", "Cookies"));
  const before = db.prepare("SELECT COUNT(*) c FROM cookies WHERE host_key LIKE '%google%'").get().c;
  if (!keepAuth) {
    const q = `DELETE FROM cookies WHERE host_key LIKE '%google%' AND name IN (${AUTH.map(()=>"?").join(",")})`;
    db.prepare(q).run(...AUTH);
  }
  const after = db.prepare("SELECT COUNT(*) c FROM cookies WHERE host_key LIKE '%google%'").get().c;
  const kept = db.prepare("SELECT name FROM cookies WHERE host_key LIKE '%google%'").all().map(r=>r.name);
  db.close();
  return { before, after, hasAuth: kept.filter(n=>AUTH.includes(n)).length };
}

async function attach(profile, port) {
  const c = spawn(CHROME, ["--headless=new",`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,
    "--no-first-run","--no-default-browser-check","--disable-background-networking","--disable-sync",
    "--disable-component-update","--window-size=1440,2000","about:blank"], { stdio: "ignore" });
  let v; for (let i=0;i<80;i++){try{v=await(await fetch(`http://127.0.0.1:${port}/json/version`)).json();break}catch{await sleep(250)}}
  if(!v){c.kill("SIGKILL");throw new Error("no cdp");}
  const ws=new WebSocket(v.webSocketDebuggerUrl); await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  let id=0;const p=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}};
  const send=(M,P={},sid)=>new Promise(res=>{const i=++id;p.set(i,res);ws.send(JSON.stringify({id:i,method:M,params:P,...(sid?{sessionId:sid}:{})}));});
  const {result:t}=await send("Target.createTarget",{url:"about:blank"});
  const {result:a}=await send("Target.attachToTarget",{targetId:t.targetId,flatten:true});const sid=a.sessionId;
  await send("Page.enable",{},sid);
  await send("Emulation.setUserAgentOverride",{userAgent:UA,acceptLanguage:"en-US,en;q=0.9",platform:"MacIntel"},sid);
  await send("Page.addScriptToEvaluateOnNewDocument",{source:`Object.defineProperty(navigator,'webdriver',{get:()=>undefined});`},sid);
  const ev=async x=>{const r=await send("Runtime.evaluate",{expression:x,returnByValue:true,userGesture:true},sid);return r.result?.result?.value;};
  return { nav:u=>send("Page.navigate",{url:u},sid), ev, close:async()=>{try{ws.close()}catch{};c.kill("SIGKILL");} };
}
const PROBE=`(()=>({sorry:/sorry\\/index|unusual traffic/i.test(location.href+document.body.innerText.slice(0,1200)),
  results:document.querySelectorAll('h3').length, ved:document.querySelectorAll('div[data-ved][data-hveid]').length}))()`;

async function run(label, cfg, port) {
  const dir = join(tmpdir(), "p0-" + port);
  const meta = buildProfile(dir, cfg);
  let s; try {
    s = await attach(dir, port);
    const out = [];
    for (const q of ["kubernetes operator best practices","postgres index bloat"]) {
      await s.nav("https://www.google.com/search?q="+encodeURIComponent(q)+"&num=20&hl=en");
      await sleep(3500);
      const r = await s.ev(PROBE);
      out.push(`${r.sorry?"SORRY":(r.results+"res/"+r.ved+"ved")}`);
      await sleep(1500);
    }
    console.log(`${label.padEnd(40)} auth_kept=${String(meta.hasAuth).padStart(2)} hist=${cfg.keepHistory?"y":"n"}  ->  ${out.join("  |  ")}`);
  } catch(e){ console.log(label.padEnd(40), "ERR", e.message.slice(0,50)); }
  finally { if(s) await s.close(); rmSync(dir,{recursive:true,force:true}); }
}

console.log("baseline (already measured): full real profile = WORKS | fresh empty profile = SORRY\n");
await run("T1 auth cookies STRIPPED, no history", {keepAuth:false, keepHistory:false}, 19901);
await run("T2 auth cookies KEPT,   no history",   {keepAuth:true,  keepHistory:false}, 19902);
