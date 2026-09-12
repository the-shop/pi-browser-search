import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChromeManager } from "../src/browser/chrome.ts";
import { google } from "../src/engines/google.ts";
import type { Probe } from "../src/engines/types.ts";
const probe: Probe = { id: "g", query: "kubernetes operator best practices", label: "dbg" };
const profileDir = mkdtempSync(join(tmpdir(), "pbs-goog-"));
const chrome = new ChromeManager({ profileDir, idleMs: 0 });
try {
	const page = await chrome.newPage();
	const url = google.buildUrl(probe, 0);
	console.log("url:", url);
	await page.navigate(url);
	for (const wait of [0, 1000, 3000, 6000]) {
		if (wait) await new Promise((r) => setTimeout(r, wait));
		const snap = await page.evaluate(`(() => ({
			href: location.href.slice(0,110),
			title: document.title.slice(0,50),
			containers: document.querySelectorAll('div[data-ved][data-hveid]').length,
			h3: document.querySelectorAll('h3').length,
			bodyLen: document.body ? document.body.innerText.length : -1,
			bodyStart: (document.body ? document.body.innerText : '').slice(0,160).replace(/\\s+/g,' '),
		}))()`);
		const block = await google.detectBlock(page);
		console.log(`t+${String(wait).padStart(4)}ms  block=${block ?? "(none)"}`);
		console.log(`          ${JSON.stringify(snap)}`);
	}
	await page.close();
} finally {
	await chrome.close();
	rmSync(profileDir, { recursive: true, force: true });
}
