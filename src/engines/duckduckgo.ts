/**
 * DuckDuckGo adapter.
 *
 * Implemented against the no-JS surfaces (`html.duckduckgo.com/html/` and
 * `lite.duckduckgo.com/lite/`). Notes from measurement:
 *
 *  - The `HeadlessChrome` UA token is rejected outright with a duck CAPTCHA.
 *    The stealth baseline in chrome.ts already strips it.
 *  - GET is safe; POST to the same endpoint trips DDG's anomaly page.
 *  - DDG rate-limits with a soft `202`, so this engine is the cheapest to
 *    retry and the natural spillover target when Google blocks.
 *  - Result links are wrapped as `//duckduckgo.com/l/?uddg=<encoded>` and must
 *    be unwrapped — the visible URL is useless for dedupe.
 */

import type { CdpSession } from "../browser/cdp.ts";
import type { EngineAdapter, EngineId, ExtractContext, Probe, RawHit } from "./types.ts";

/** Both endpoints are supported in one adapter; extraction handles either DOM. */
export type DuckVariant = "html" | "lite";

const HOSTS: Record<DuckVariant, string> = {
	html: "https://html.duckduckgo.com/html/",
	lite: "https://lite.duckduckgo.com/lite/",
};

export const duckduckgo: EngineAdapter & { buildUrl(probe: Probe, offset: number, variant?: DuckVariant): string } = {
	id: "duckduckgo" as EngineId,

	buildUrl(probe: Probe, offset: number, variant: DuckVariant = "html"): string {
		const params = new URLSearchParams();
		params.set("q", buildQuery(probe));
		if (offset > 0) {
			// DDG pages in tens; `s` is the 0-based result offset.
			params.set("s", String(offset));
			params.set("dc", String(offset + 1));
		}
		if (probe.recencyMonths && probe.recencyMonths <= 12) params.set("df", "y");
		return `${HOSTS[variant]}?${params.toString()}`;
	},

	async detectBlock(page: CdpSession): Promise<string | undefined> {
		const signal = await page.evaluate<{ captcha: boolean; anomaly: boolean; rate: boolean }>(`
			(() => {
				const text = (document.body ? document.body.innerText : '').slice(0, 4000);
				return {
					captcha: /select all squares containing|confirm this search was made by a human|are you a robot/i.test(text),
					anomaly: /anomaly|unfortunately, bots use duckduckgo/i.test(text),
					rate: /202 ratelimit|too many requests/i.test(text),
				};
			})()
		`);
		if (signal.captcha) return "DuckDuckGo served a bot challenge";
		if (signal.anomaly) return "DuckDuckGo anomaly page";
		if (signal.rate) return "DuckDuckGo rate limit (202)";
		return undefined;
	},

	async waitForResults(page: CdpSession, timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const count = await page
				.evaluate<number>(`document.querySelectorAll('a.result__a, a.result-link').length`)
				.catch(() => 0);
			if (count > 0) return true;
			// A genuinely empty result set is a valid outcome, not a timeout.
			const exhausted = await page
				.evaluate<boolean>(`/no results|did not match any documents/i.test(document.body.innerText.slice(0,2000))`)
				.catch(() => false);
			if (exhausted) return true;
			if (await this.detectBlock(page)) return false;
			await new Promise((r) => setTimeout(r, 120));
		}
		return false;
	},

	async extract({ page, probe, limit, offset }: ExtractContext): Promise<RawHit[]> {
		const raw = await page.evaluate<RawHit[]>(`
			(() => {
				const out = [];
				const seen = new Set();
				const unwrap = (href) => {
					if (!href) return '';
					try {
						const u = new URL(href, location.origin);
						// //duckduckgo.com/l/?uddg=<encoded>&rut=...
						if (/(^|\\.)duckduckgo\\.com$/.test(u.hostname) && u.pathname.startsWith('/l/')) {
							const target = u.searchParams.get('uddg');
							if (target) return target;
						}
						return u.href;
					} catch { return href; }
				};
				// html/ endpoint uses .result__a; lite/ uses .result-link.
				const anchors = document.querySelectorAll('a.result__a, a.result-link');
				for (const anchor of anchors) {
					if (out.length >= ${limit}) break;
					const url = unwrap(anchor.getAttribute('href'));
					if (!/^https?:\\/\\//i.test(url)) continue;
					if (/(^|\\.)duckduckgo\\.com$/.test(new URL(url).hostname)) continue;
					if (seen.has(url)) continue;
					seen.add(url);

					const title = (anchor.innerText || '').trim();
					let snippet = '';
					const container =
						anchor.closest('.result__body') ||
						anchor.closest('.result') ||
						anchor.closest('tr') ||
						anchor.parentElement;
					if (container) {
						const node = container.querySelector('.result__snippet, .result-snippet, td.result-snippet');
						if (node) snippet = (node.innerText || '').trim();
						// lite/ puts the snippet in a sibling table row.
						if (!snippet) {
							const row = container.closest('tr');
							const next = row && row.nextElementSibling;
							const cell = next && next.querySelector('td.result-snippet');
							if (cell) snippet = (cell.innerText || '').trim();
						}
						if (!snippet) snippet = (container.innerText || '').replace(/\\s+/g, ' ');
					}
					if (snippet.startsWith(title)) snippet = snippet.slice(title.length).trim();
					out.push({
						title,
						url,
						snippet: snippet.replace(/\\s+/g, ' ').trim().slice(0, 400),
						position: 0,
						engine: 'duckduckgo',
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
