/**
 * Bing adapter.
 *
 * Measured as the most permissive of the three engines: it serves organic
 * results server-side into `li.b_algo` blocks and tolerated every profile used
 * during investigation, including a cold headless one.
 *
 *  - Needs a plausible `Referer`; a bare SERP request without one is flagged.
 *  - Localisation follows `mkt`/`setlang`, not IP alone, so both are set
 *    explicitly to keep results stable.
 *  - Pagination uses `first=` (1-based, steps of ~10), not a page number.
 *  - Outbound links can be wrapped in Bing's `ck/a` redirect with a base64url
 *    `u=a1...` payload, which must be decoded.
 */

import type { CdpSession } from "../browser/cdp.ts";
import { DESKTOP_UA } from "../browser/chrome.ts";
import type { EngineAdapter, EngineId, ExtractContext, Probe, RawHit } from "./types.ts";

const RESULTS_PER_PAGE = 20;

export const bing: EngineAdapter = {
	id: "bing" as EngineId,

	buildUrl(probe: Probe, offset: number): string {
		const params = new URLSearchParams();
		params.set("q", buildQuery(probe));
		params.set("count", String(RESULTS_PER_PAGE));
		params.set("mkt", "en-US");
		params.set("setlang", "en");
		if (probe.recencyMonths && probe.recencyMonths <= 12) {
			// Bing expresses freshness as a `filters` day-delimited expression.
			const days = probe.recencyMonths * 31;
			params.set("filters", `ex1:"ez5_${days}"`);
		}
		if (offset > 0) params.set("first", String(offset + 1));
		return `https://www.bing.com/search?${params.toString()}`;
	},

	async detectBlock(page: CdpSession): Promise<string | undefined> {
		const signal = await page.evaluate<{ captcha: boolean; blocked: boolean }>(`
			(() => {
				const text = (document.body ? document.body.innerText : '').slice(0, 4000);
				return {
					captcha: /verify you are a human|are you a robot|solve the challenge|recaptcha/i.test(text),
					blocked: /your request has been blocked|unusual traffic/i.test(text),
				};
			})()
		`);
		if (signal.captcha) return "Bing served a bot challenge";
		if (signal.blocked) return "Bing blocked the request";
		return undefined;
	},

	async waitForResults(page: CdpSession, timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			// Bing emits the `li.b_algo` shell first and hydrates it afterwards, so
			// counting containers reports ready while the items are still empty.
			// `innerText` additionally requires layout, so gate on rendered text
			// content rather than on the anchors merely existing.
			const count = await page
				.evaluate<number>(
					`Array.from(document.querySelectorAll('li.b_algo h2 a[href]')).filter((a) => (a.textContent || '').trim().length > 2).length`,
				)
				.catch(() => 0);
			if (count > 0) return true;
			const exhausted = await page
				.evaluate<boolean>(`/no results found|there are no results/i.test(document.body.innerText.slice(0,2000))`)
				.catch(() => false);
			if (exhausted) return true;
			if (await this.detectBlock(page)) return false;
			await new Promise((r) => setTimeout(r, 120));
		}
		return false;
	},

	async extract({ page, probe, limit, offset }: ExtractContext): Promise<RawHit[]> {
		// Bing's redirect unwrapping needs atob, so it runs in-page.
		const raw = await page.evaluate<RawHit[]>(`
			(() => {
				const out = [];
				const seen = new Set();
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
							}
						}
						return u.href;
					} catch { return href; }
				};
				for (const item of document.querySelectorAll('li.b_algo')) {
					if (out.length >= ${limit}) break;
					// Only real organic results carry an h2 > a link. Cards such as
					// related-topic strips also match li.b_algo but have no h2 title.
					const heading = item.querySelector('h2');
					const anchor = heading ? heading.querySelector('a[href]') : null;
					if (!heading || !anchor) continue;
					// textContent, not innerText: the latter needs layout and reads empty
					// on a freshly-hydrated item.
					const title = (heading.textContent || '').replace(/\s+/g, ' ').trim();
					if (title.length < 3) continue;
					const url = unwrap(anchor.getAttribute('href'));
					if (!/^https?:\\/\\//i.test(url)) continue;
					if (/(^|\\.)bing\\.com$/.test(new URL(url).hostname)) continue;
					if (seen.has(url)) continue;
					seen.add(url);

					const snippetNode = item.querySelector('.b_caption p, p.b_lineclamp2, p.b_lineclamp3, p.b_lineclamp4, .b_algoSlug, p');
					let snippet = snippetNode ? (snippetNode.innerText || '').trim() : (item.innerText || '').replace(/\\s+/g, ' ');
					if (snippet.startsWith(title)) snippet = snippet.slice(title.length).trim();
					out.push({
						title,
						url,
						snippet: snippet.replace(/\\s+/g, ' ').trim().slice(0, 400),
						position: 0,
						engine: 'bing',
						probeId: ${JSON.stringify(probe.id)},
					});
				}
				return out;
			})()
		`);
		return (raw ?? []).map((hit, index) => ({ ...hit, position: offset + index + 1 }));
	},
};

function buildQuery(probe: Probe): string {
	const parts = [probe.query];
	if (probe.site) parts.push(`site:${probe.site}`);
	if (probe.filetype) parts.push(`filetype:${probe.filetype}`);
	return parts.join(" ");
}

/** Bing expects a same-origin referer; send one on navigations. */
export const BING_HEADERS = {
	"User-Agent": DESKTOP_UA,
	Referer: "https://www.bing.com/",
} as const;
