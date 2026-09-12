import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChromeManager } from "../src/browser/chrome.ts";
const profileDir = mkdtempSync(join(tmpdir(), "pbs-d2-"));
const chrome = new ChromeManager({ profileDir, idleMs: 0 });
try {
	const page = await chrome.newPage();
	await page.navigate("https://www.bing.com/search?q=postgres+index+bloat&count=20&mkt=en-US&setlang=en");
	for (const t of [500, 1500, 3000, 5000]) {
		await new Promise((r) => setTimeout(r, t === 500 ? 500 : t - (t === 1500 ? 500 : t === 3000 ? 1500 : 3000)));
		const snap = await page.evaluate(`(() => {
			const all = document.querySelectorAll('li.b_algo');
			const inResults = document.querySelectorAll('#b_results li.b_algo');
			const seen = document.querySelectorAll('#b_results > li.b_algo');
			const first = seen[0];
			return {
				title: document.title.slice(0,60),
				href: location.href.slice(0,90),
				algoAll: all.length,
				algoInBResults: inResults.length,
				algoDirectChildren: seen.length,
				hasBResults: !!document.querySelector('#b_results'),
				firstTitle: first ? (first.querySelector('h2')||{}).textContent?.slice(0,50) : null,
				firstHost: first ? (first.querySelector('h2 a')||{}).getAttribute?.('href')?.slice(0,60) : null,
			};
		})()`);
		console.log(JSON.stringify(snap));
	}
	await page.close();
} finally {
	await chrome.close();
	rmSync(profileDir, { recursive: true, force: true });
}
