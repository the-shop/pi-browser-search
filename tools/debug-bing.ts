import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChromeManager } from "../src/browser/chrome.ts";
const profileDir = mkdtempSync(join(tmpdir(), "pbs-dbg-"));
const chrome = new ChromeManager({ profileDir, idleMs: 0 });
try {
	const page = await chrome.newPage();
	await page.navigate("https://www.bing.com/search?q=postgres+index+bloat&count=20&mkt=en-US&setlang=en");
	await new Promise((r) => setTimeout(r, 4000));
	const info = await page.evaluate(`
		(() => {
			const unwrap = (href) => {
				try {
					const u = new URL(href, location.origin);
					if (/(^|\\.)bing\\.com$/.test(u.hostname) && u.pathname.startsWith('/ck/a')) {
						const payload = u.searchParams.get('u');
						if (payload && payload.startsWith('a1')) {
							let b64 = payload.slice(2).replace(/-/g, '+').replace(/_/g, '/');
							while (b64.length % 4) b64 += '=';
							const decoded = atob(b64);
							if (/^https?:\\/\\//i.test(decoded)) return decoded;
							return 'DECODE_NOT_URL:' + decoded.slice(0,40);
						}
						return 'NO_U_PARAM';
					}
					return u.href;
				} catch (e) { return 'THREW:' + e.message; }
			};
			const items = Array.from(document.querySelectorAll('li.b_algo'));
			const first = items[0];
			const h2 = first ? first.querySelector('h2') : null;
			const a = h2 ? h2.querySelector('a[href]') : null;
			return {
				algoCount: items.length,
				hasH2: !!h2,
				hasAnchor: !!a,
				rawHref: a ? a.getAttribute('href').slice(0, 200) : null,
				unwrapped: a ? String(unwrap(a.getAttribute('href'))).slice(0, 120) : null,
				titleText: h2 ? (h2.innerText || '').slice(0, 80) : null,
				// replicate the pipeline for every item
				pipeline: items.map((it) => {
					const h = it.querySelector('h2');
					const an = h ? h.querySelector('a[href]') : null;
					if (!h || !an) return 'no-h2-anchor';
					const u = unwrap(an.getAttribute('href'));
					if (!/^https?:\\/\\//i.test(u)) return 'BADURL:' + String(u).slice(0, 40);
					try { if (/(^|\\.)bing\\.com$/.test(new URL(u).hostname)) return 'STILL-BING'; } catch { return 'URL-PARSE-FAIL'; }
					return 'ok';
				}),
			};
		})()
	`);
	console.log(JSON.stringify(info, null, 1));
	await page.close();
} finally {
	await chrome.close();
	rmSync(profileDir, { recursive: true, force: true });
}
