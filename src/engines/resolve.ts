/**
 * Redirect resolution.
 *
 * Google wraps outbound result links in an opaque redirect
 * (`https://www.google.com/goto?url=CAES...`). The payload is an encrypted
 * protobuf — decoding it offline yields no URL — and an in-page `fetch` is
 * blocked by CORS, so the only way to learn the destination is to let Chrome
 * follow it and read where it lands.
 *
 * Resolution is deliberately deferred until *after* ranking: a 10-probe wave can
 * produce well over a hundred wrapped hits, and resolving all of them would cost
 * more than the search itself. Ranking only needs the displayed host and title,
 * both of which are available up front, so only the results actually being
 * returned are resolved.
 */

import { setTimeout as sleep } from "node:timers/promises";
import type { CdpSession } from "../browser/cdp.ts";
import { ChromeManager } from "../browser/chrome.ts";
import { canonicalizeUrl } from "../search/normalize.ts";

/** Hosts whose URLs are wrappers rather than destinations. */
function isWrapper(url: string): boolean {
	try {
		const parsed = new URL(url);
		return /(^|\.)google\.[a-z.]+$/i.test(parsed.hostname) && /^\/(goto|url)$/.test(parsed.pathname);
	} catch {
		return false;
	}
}

export interface ResolveOptions {
	/** Per-URL budget for the redirect to complete. */
	timeoutMs?: number;
	/** Overall budget; resolution stops once exceeded and leaves the rest wrapped. */
	budgetMs?: number;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

export interface ResolveResult {
	/** wrapper url -> destination url */
	resolved: Map<string, string>;
	unresolved: string[];
}

/**
 * Follow each wrapper URL and capture where it lands.
 *
 * Uses `Page.navigate` plus a poll of `location.href` rather than the normal
 * navigation helper, because the destination page does not need to finish
 * loading — the redirect target is known as soon as the URL commits, and
 * waiting for `readyState: complete` would make this several times slower.
 */
export async function resolveWrappedUrls(
	chrome: ChromeManager,
	urls: string[],
	options: ResolveOptions = {},
): Promise<ResolveResult> {
	const timeoutMs = options.timeoutMs ?? 4_000;
	const budgetMs = options.budgetMs ?? 45_000;
	const resolved = new Map<string, string>();
	const unresolved: string[] = [];
	const targets = [...new Set(urls.filter(isWrapper))];
	if (targets.length === 0) return { resolved, unresolved };

	const started = Date.now();
	let page: CdpSession | undefined;
	try {
		page = await chrome.newPage(options.signal);
		for (const [index, wrapper] of targets.entries()) {
			if (options.signal?.aborted) break;
			if (Date.now() - started > budgetMs) {
				unresolved.push(...targets.slice(index));
				break;
			}

			const deadline = Date.now() + timeoutMs;
			try {
				await page.send("Page.navigate", { url: wrapper });
				let landed: string | undefined;
				while (Date.now() < deadline) {
					const current = await page.evaluate<string>("location.href").catch(() => undefined);
					if (current && !isWrapper(current) && !current.startsWith("about:")) {
						landed = current;
						break;
					}
					await sleep(80);
				}
				if (landed && canonicalizeUrl(landed)) {
					resolved.set(wrapper, landed);
				} else {
					unresolved.push(wrapper);
				}
			} catch {
				unresolved.push(wrapper);
			}
			options.onProgress?.(`resolved ${resolved.size}/${targets.length}`);
		}
	} finally {
		await page?.close().catch(() => undefined);
	}

	return { resolved, unresolved };
}

export { isWrapper as isWrappedUrl };
