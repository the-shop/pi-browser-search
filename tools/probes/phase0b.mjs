// Phase 0b: can we BOOTSTRAP a trust profile from a blank one?
// Fresh profile -> inject only the anonymous Google cookies (verbatim encrypted blobs) -> test.
import { spawn } from "node:child_process";
import { cpSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";

const SRC = process.env.HOME + "/Library/Application Support/Google/Chrome";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.83 Safari/537.36";
const ANON = ["NID","SOCS","AEC"];

async function launch(profile, port) {
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
async function test(label, dir, port) {
  let s; try { s = await launch(dir, port);
    const out=[];
    for (const q of ["kubernetes operator best practices","postgres index bloat"]) {
      await s.nav("https://www.google.com/search?q="+encodeURIComponent(q)+"&num=20&hl=en");
      await sleep(3500);
      const r=await s.ev(PROBE);
      out.push(r.sorry?"SORRY":(r.results+"res/"+r.ved+"ved"));
      await sleep(1500);
    }
    console.log(label.padEnd(46), out.join("  |  "));
  } catch(e){ console.log(label.padEnd(46),"ERR",e.message.slice(0,50)); }
  finally { if(s) await s.close(); }
}

const dir = join(tmpdir(), "p0b");
// Step 1: let Chrome create a pristine profile structure
rmSync(dir,{recursive:true,force:true}); mkdirSync(dir,{recursive:true});
let s = await launch(dir, 19911); await sleep(1500); await s.close(); await sleep(1500);

// Step 2: pull the anonymous cookie rows out of the real profile
const srcDb = new DatabaseSync(join(SRC,"Default","Cookies"), { readBigInts: true });
const rows = srcDb.prepare(`SELECT * FROM cookies WHERE host_key LIKE '%google%' AND name IN (${ANON.map(()=>"?").join(",")})`).all(...ANON);
srcDb.close();
console.log("injecting cookie rows:", rows.map(r=>r.name+"@"+r.host_key).join(", "));

// Step 3: write them into the pristine profile
const dst = join(dir,"Default","Cookies");
if (!existsSync(dst)) { console.log("!! fresh profile has no Cookies db"); process.exit(1); }
const dstDb = new DatabaseSync(dst, { readBigInts: true });
const cols = dstDb.prepare("PRAGMA table_info(cookies)").all().map(c=>c.name);
const usable = rows.map(r => { const o={}; for (const c of cols) o[c]=r[c]; return o; });
const stmt = dstDb.prepare(`INSERT OR REPLACE INTO cookies (${cols.join(",")}) VALUES (${cols.map(()=>"?").join(",")})`);
let n=0; for (const o of usable) { try { stmt.run(...cols.map(c=>o[c]??null)); n++; } catch(e){ console.log("  insert fail:",e.message.slice(0,60)); } }
console.log("inserted:",n);
dstDb.close();

await test("fresh + 3 anon cookies (NID/SOCS/AEC)", dir, 19912);
await test("same profile, second run (persisted)", dir, 19913);
