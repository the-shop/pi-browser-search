import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChromeManager } from "../src/browser/chrome.ts";
const profileDir = mkdtempSync(join(tmpdir(), "pbs-ins-"));
const chrome = new ChromeManager({ profileDir, idleMs: 0 });
try {
	const page = await chrome.newPage();
	await page.navigate("https://www.bing.com/search?q=postgres+index+bloat&count=20&mkt=en-US&setlang=en");
	await new Promise((r) => setTimeout(r, 4000));
	const info = await page.evaluate(`
		(() => {
			const algos = document.querySelectorAll('li.b_algo');
			const first = algos[0];
			return {
				url: location.href.slice(0,110),
				title: document.title,
				algoCount: algos.length,
				bodyStart: document.body.innerText.slice(0,200).replace(/\\s+/g,' '),
				firstOuter: first ? first.outerHTML.slice(0, 700) : '(none)',
				firstH2: first ? (first.querySelector('h2') ? first.querySelector('h2').outerHTML.slice(0,300) : 'NO H2') : '',
				allAnchors: first ? Array.from(first.querySelectorAll('a')).slice(0,3).map(a=>({t:(a.innerText||'').slice(0,40),h:(a.getAttribute('href')||'').slice(0,80)})) : [],
			};
		})()
	`);
	console.log(JSON.stringify(info, null, 1));
	await page.close();
} finally {
	await chrome.close();
	rmSync(profileDir, { recursive: true, force: true });
}
