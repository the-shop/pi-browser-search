// Minimal CDP driver using native WebSocket (node 26) + system Chrome with a dedicated warmed profile
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PROFILE = "/tmp/serptest/profile";
const PORT = 19333;
mkdirSync(PROFILE, { recursive: true });

const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  "--no-first-run", "--no-default-browser-check",
  "--disable-background-networking", "--disable-sync", "--disable-default-apps",
  "--disable-blink-features=AutomationControlled",
  "--window-size=1440,2000",
  "about:blank",
], { stdio: "ignore", detached: false });

process.on("exit", () => { try { chrome.kill("SIGKILL"); } catch {} });

// wait for CDP
let ver = null;
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); ver = await r.json(); break; } catch { await sleep(250); }
}
if (!ver) { console.log("CHROME FAILED TO START"); process.exit(1); }
console.log("browser:", ver.Browser);
console.log("ua:", ver["User-Agent"]);

const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0; const pending = new Map(); const events = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method) events.push(m);
};
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const mid = ++id; pending.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
});

// Create a page target and attach. NOTE: we deliberately do NOT call Runtime.enable,
// Network.enable, or Page.enable unless needed -- avoids CDP execution-context leaks.
const { result: t } = await send("Target.createTarget", { url: "about:blank" });
const { result: att } = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
const sid = att.sessionId;

const nav = async (url) => {
  const r = await send("Page.navigate", { url }, sid);
  return r.result?.errorText ?? null;
};
const evalJs = async (expr, awaitPromise = false) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise, userGesture: true, includeCommandLineAPI: false }, sid);
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
};

await send("Page.enable", {}, sid);

const probe = async (name, url) => {
  const t0 = Date.now();
  const err = await nav(url);
  await sleep(3500); // fixed wait: google trackers never go networkidle
  const info = await evalJs(`(() => ({
    href: location.href,
    title: document.title,
    bytes: document.documentElement.outerHTML.length,
    h3: document.querySelectorAll('h3').length,
    dataVed: document.querySelectorAll('div[data-ved][data-hveid]').length,
    algo: document.querySelectorAll('li.b_algo').length,
    ddgRes: document.querySelectorAll('a.result-link, a.result__a').length,
    sorry: /sorry|unusual traffic|Verifying your request|robot/i.test(document.body.innerText.slice(0,4000)),
    webdriver: navigator.webdriver,
    plugins: navigator.plugins.length,
    langs: navigator.languages.join(','),
    chromeObj: !!window.chrome,
    snippet: document.body.innerText.slice(0,220).replace(/\\s+/g,' ')
  }))()`);
  console.log(`\n== ${name} == ${Date.now()-t0}ms ${err ? "navErr="+err : ""}`);
  console.log(JSON.stringify(info, null, 1));
};

await probe("GOOGLE", "https://www.google.com/search?q=headless+chrome+test&num=20");
await probe("DDG-LITE", "https://lite.duckduckgo.com/lite/?q=headless+chrome+test");
await probe("BING", "https://www.bing.com/search?q=headless+chrome+test&count=20");

ws.close(); chrome.kill("SIGKILL");
