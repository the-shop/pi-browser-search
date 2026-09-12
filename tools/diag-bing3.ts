import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChromeManager } from "../src/browser/chrome.ts";
const profileDir = mkdtempSync(join(tmpdir(), "pbs-d3-"));
const chrome = new ChromeManager({ profileDir, idleMs: 0 });
const variants: Array<[string, string]> = [
	["baseline mkt/setlang", "https://www.bing.com/search?q=postgres+index+bloat&count=20&mkt=en-US&setlang=en"],
	["ensearch=1", "https://www.bing.com/search?q=postgres+index+bloat&count=20&ensearch=1"],
	["setmkt+setlang", "https://www.bing.com/search?q=postgres+index+bloat&count=20&setmkt=en-US&setlang=en-US"],
	["cc=US + ensearch", "https://www.bing.com/search?q=postgres+index+bloat&count=20&cc=US&ensearch=1&setlang=en"],
	["no params at all", "https://www.bing.com/search?q=postgres+index+bloat"],
];
try {
	const page = await chrome.newPage();
	for (const [label, url] of variants) {
		await page.navigate(url);
		await new Promise((r) => setTimeout(r, 3500));
		const snap = await page.evaluate(`(() => {
			const items = Array.from(document.querySelectorAll('#b_results > li.b_algo'));
			const first = items[0];
			const h2 = first ? first.querySelector('h2') : null;
			const a = h2 ? h2.querySelector('a[href]') : null;
			let host = '';
			try {
				const href = a ? a.getAttribute('href') : '';
				const u = new URL(href, location.origin);
				const p = u.searchParams.get('u');
				if (p && p.startsWith('a1')) { let b = p.slice(2).replace(/-/g,'+').replace(/_/g,'/'); while (b.length % 4) b += '='; host = atob(b); }
				else host = href;
			} catch { host = 'ERR'; }
			return {
				n: items.length,
				title: (h2 ? h2.textContent : '').slice(0, 46),
				host: String(host).slice(0, 60),
				lang: document.documentElement.lang,
				cn: /[\\u4e00-\\u9fff]/.test(h2 ? h2.textContent : ''),
			};
		})()`);
		console.log(`${label.padEnd(22)} n=${String(snap.n).padStart(2)} cn=${snap.cn ? "YES" : "no "} lang=${String(snap.lang).padEnd(6)} ${snap.title}`);
		console.log(`${" ".repeat(22)} -> ${snap.host}`);
	}
	await page.close();
} finally {
	await chrome.close();
	rmSync(profileDir, { recursive: true, force: true });
}
