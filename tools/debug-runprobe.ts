import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChromeManager } from "../src/browser/chrome.ts";
import { bing } from "../src/engines/bing.ts";
import type { Probe } from "../src/engines/types.ts";

const probe: Probe = { id: "x", query: "postgres index bloat", label: "dbg" };
const profileDir = mkdtempSync(join(tmpdir(), "pbs-rp-"));
const chrome = new ChromeManager({ profileDir, idleMs: 0 });
try {
	const page = await chrome.newPage();
	const url = bing.buildUrl(probe, 0);
	console.log("url:", url);
	const t0 = Date.now();
	await page.navigate(url, { timeoutMs: 30_000 });
	console.log("navigate done in", Date.now() - t0, "ms; href =", await page.evaluate("location.href.slice(0,100)"));
	console.log("readyState:", await page.evaluate("document.readyState"));
	console.log("algo immediately:", await page.evaluate("document.querySelectorAll('li.b_algo').length"));
	console.log("body len:", await page.evaluate("document.body ? document.body.innerText.length : -1"));
	const rendered = await bing.waitForResults(page, 12_000);
	console.log("waitForResults:", rendered, "after", Date.now() - t0, "ms");
	console.log("algo now:", await page.evaluate("document.querySelectorAll('li.b_algo').length"));
	const block = await bing.detectBlock(page);
	console.log("detectBlock:", block ?? "(none)");
	const hits = await bing.extract({ page, probe, limit: 10, offset: 0 });
	console.log("extract hits:", hits.length);
	if (hits.length === 0) {
		const diag = await page.evaluate(`JSON.stringify({
			href: location.href.slice(0,120),
			algos: document.querySelectorAll('li.b_algo').length,
			bodyStart: document.body.innerText.slice(0,300).replace(/\\s+/g,' ')
		})`);
		console.log("diag:", diag);
	}
	await page.close();
} finally {
	await chrome.close();
	rmSync(profileDir, { recursive: true, force: true });
}
