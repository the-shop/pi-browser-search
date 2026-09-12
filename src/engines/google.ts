/**
 * Google adapter.
 *
 * Fragility notes, from measurement rather than guesswork:
 *
 *  - Google's block page returns **HTTP 200 with a valid-looking document**.
 *    Every success check here is structural (result-container counts), never a
 *    status code.
 *  - Class names are obfuscated and rotate constantly. Extraction therefore
 *    anchors on the one durable invariant: an `<h3>` whose surrounding anchor
 *    points off-Google. Snippets are read from the nearest ancestor block that
 *    carries a stable Google data attribute (`data-hveid`, `data-snc`), which
 *    is far more stable than any class name.
 *  - `num=` above ~20 is ignored by Google, so 20 is the per-page ceiling and
 *    deeper results require `start=` pagination.
 */

import type { CdpSession } from "../browser/cdp.ts";
import type { EngineAdapter, EngineId, ExtractContext, Probe, RawHit } from "./types.ts";

const MAX_PER_PAGE = 20;

/** Selectors for "results have rendered". `data-hveid` blocks are the most
 * stable signal Google exposes; a real SERP carries dozens. */
const RESULT_CONTAINER = "div[data-ved][data-hveid]";

export const google: EngineAdapter = {
	id: "google" as EngineId,

	buildUrl(probe: Probe, offset: number): string {
		const params = new URLSearchParams();
		params.set("q", buildQuery(probe));
		params.set("num", String(MAX_PER_PAGE));
		params.set("hl", "en");
		if (offset > 0) params.set("start", String(offset));
		const range = recencyRange(probe.recencyMonths);
		if (range) params.set("tbs", range);
		// Deliberately minimal. `udm=14` (web-only) and `gbv=1` (basic HTML) both
		// looked attractive — they strip AI Overviews and heavy JS — but measured
		// on a trusted profile they route to the consent interstitial and return no
		// results at all. This parameter set is the shape verified to work (12/12
		// sustained queries); Google's own surfaces are filtered during extraction.
		return `https://www.google.com/search?${params.toString()}`;
	},

	async detectBlock(page: CdpSession): Promise<string | undefined> {
		const signal = await page.evaluate<{ href: string; sorry: boolean; consent: boolean; captcha: boolean }>(`
			(() => {
				const text = (document.body ? document.body.innerText : '').slice(0, 4000);
				return {
					href: location.href,
					sorry: /\\/sorry\\/index|unusual traffic|detected unusual traffic/i.test(location.href + text),
					consent: /consent\\.google\\./i.test(location.href),
					captcha: /select all squares|are you a robot|recaptcha/i.test(text),
				};
			})()
		`);
		if (signal.sorry) return "Google served its 'unusual traffic' interstitial (/sorry)";
		if (signal.captcha) return "Google served a CAPTCHA challenge";
		if (signal.consent) return "Google redirected to the consent interstitial";
		return undefined;
	},

	/**
	 * Consent is a recoverable interstitial, not a block: accepting it issues the
	 * cookies Google wants and lets the original query proceed. Measured on a
	 * fresh profile, `/search` redirects to consent.google.com before any SERP
	 * is served.
	 */
	async recover(page: CdpSession, reason: string): Promise<boolean> {
		if (!/consent/i.test(reason)) return false;
		try {
			const clicked = await page.evaluate<boolean>(`
				(() => {
					const candidates = Array.from(document.querySelectorAll('button, div[role="button"], form button'));
					const accept = candidates.find((b) =>
						/accept all|i agree|agree to|prihvati sve|alle akzeptieren|tout accepter/i.test(b.innerText || '')
					);
					if (accept) { accept.click(); return true; }
					// Some variants render the accept action as a submit input.
					const submit = document.querySelector('form[action*="consent"] button, form[action*="save"] button');
					if (submit) { submit.click(); return true; }
					return false;
				})()
			`);
			if (clicked) await new Promise((resolve) => setTimeout(resolve, 1500));
			return Boolean(clicked);
		} catch {
			return false;
		}
	},

	async waitForResults(page: CdpSession, timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const count = await page
				.evaluate<number>(`document.querySelectorAll('${RESULT_CONTAINER}').length`)
				.catch(() => 0);
			// A rendered SERP carries well over this many containers; the number also
			// guards against matching a half-rendered shell.
			if (count >= 6) return true;
			const blocked = await this.detectBlock(page).catch(() => undefined);
			if (blocked) return false;
			await new Promise((r) => setTimeout(r, 120));
		}
		return false;
	},

	async extract({ page, probe, limit, offset }: ExtractContext): Promise<RawHit[]> {
		const raw = await page.evaluate<RawHit[]>(`
			(() => {
				const out = [];
				const seen = new Set();
				const decodeRedirect = (href) => {
					try {
						const u = new URL(href, location.origin);
						if (/(^|\\.)google\\.com$/.test(u.hostname) && u.pathname === '/url') {
							const target = u.searchParams.get('q') || u.searchParams.get('url');
							if (target) return target;
						}
						return href;
					} catch { return href; }
				};
				for (const h3 of document.querySelectorAll('h3')) {
					if (out.length >= ${limit}) break;
					const anchor = h3.closest('a') || (h3.parentElement ? h3.parentElement.querySelector('a') : null);
					if (!anchor || !anchor.href) continue;
					const url = decodeRedirect(anchor.href);
					if (!/^https?:\\/\\//i.test(url)) continue;
					const block = h3.closest('div[data-hveid]') || h3.closest('div[data-snc]') || anchor.closest('div');
					// Google wraps outbound links in an opaque, encrypted redirect
					// (/goto?url=CAES...) whose payload is not decodable offline. The
					// displayed <cite> host is then the only host information available
					// until the redirect is followed, so capture it here: ranking and
					// cross-engine deduplication both run before resolution and need a host.
					// No regex here on purpose: this block is shipped to the page through a
					// TypeScript template literal, where every backslash must be escaped for both
					// TypeScript and the page-side parser. Plain string operations cannot be
					// silently mangled by one missing escape level.
					let isWrapper = false;
					try {
					  const wrapperPath = new URL(url).pathname;
					  isWrapper = wrapperPath === "/goto" || wrapperPath === "/url";
					} catch (e) { isWrapper = false; }
					let displayHost = "";
					if (isWrapper && block) {
					  const cite = block.querySelector("cite");
					  if (cite) {
					    // Displayed as "https://host › path › ..." with the path truncated,
					    // so only the host is trustworthy. Splitting rather than matching keeps
					    // this free of escapes.
					    const shown = (cite.textContent || "").trim();
					    let host = (shown.split(" ")[0] || "").replace("https://", "").replace("http://", "");
					    host = host.split("/")[0].split("›")[0];
					    if (host && host.indexOf(".") !== -1) displayHost = host.toLowerCase();
					  }
					}
					// Google's own surfaces (AI Mode, knowledge panels, sitelinks) are not
					// results; wrapped outbound links are.
					// Google's own surfaces (AI Mode, knowledge panels, sitelinks) are not
					// results; wrapped outbound links are. Substring host comparison avoids
					// another regex, for the same escaping reason as above.
					if (!isWrapper) {
					  let host = "";
					  try { host = new URL(url).hostname; } catch (e) { host = ""; }
					  if (host.indexOf("google.") !== -1) continue;
					}
					if (url.includes('google.com/search')) continue;
					// A wrapper with no displayed host cannot be ranked or resolved usefully.
					if (isWrapper && !displayHost) continue;
					const title0 = (h3.innerText || '').trim();
					// Wrapper hrefs are opaque per-impression, so identity must come from the
					// displayed host plus the title rather than from the URL.
					const identity = isWrapper ? 'wrapper:' + displayHost + ':' + title0.toLowerCase() : url;
					if (seen.has(identity)) continue;
					seen.add(identity);
					let snippet = '';
					if (block) {
						// Pick the single longest matching node rather than concatenating all
						// of them: the selectors overlap, so joining yielded the same prose
						// two or three times over.
						const nodes = block.querySelectorAll(
							'div[data-sncf], div.VwiC3b, div[data-content-feature], span.aCOpRe, div.lEBKkf, div[data-sncf="1"]'
						);
						for (const node of Array.from(nodes)) {
							const candidate = (node.innerText || '').trim();
							if (candidate.length > snippet.length) snippet = candidate;
						}
					}
					if (!snippet && block) {
						snippet = (block.innerText || '').replace(/\\s+/g, ' ');
					}
					// Strip the title text that the block-level fallback duplicates.
					const title = (h3.innerText || '').trim();
					if (snippet.startsWith(title)) snippet = snippet.slice(title.length).trim();
					// Trim engine chrome that is not part of the description.
					snippet = snippet.replace(/\s*Read more\s*$/i, '').trim();
					// Defensive: if a node still repeated itself, keep one copy.
					const half = Math.floor(snippet.length / 2);
					if (snippet.length > 80 && snippet.slice(0, half).trim() === snippet.slice(half).trim()) {
						snippet = snippet.slice(0, half).trim();
					}
					out.push({
						title,
						url: isWrapper ? new URL(url, location.origin).href : url,
						snippet: snippet.replace(/\\s+/g, ' ').trim().slice(0, 400),
						position: 0,
						engine: 'google',
						probeId: ${JSON.stringify(probe.id)},
						...(displayHost ? { displayHost } : {}),
						...(isWrapper ? { unresolved: true } : {}),
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

/** Google's `tbs=qdr:*` recency filters. */
function recencyRange(months?: number): string | undefined {
	if (!months || months <= 0) return undefined;
	if (months <= 1) return "qdr:m";
	if (months <= 3) return "qdr:m3";
	if (months <= 6) return "qdr:m6";
	return "qdr:y";
}

export { buildQuery as buildGoogleQuery, recencyRange };
