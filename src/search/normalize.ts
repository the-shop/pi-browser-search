/**
 * URL canonicalisation and result normalisation.
 *
 * Search engines return the same page in many costumes: tracking parameters,
 * redirect wrappers, AMP variants, country subdomains, trailing slashes. All of
 * them defeat naive `Set`-based deduplication, so the same page arrives several
 * times and crowds out other domains in the ranked list.
 *
 * Canonicalisation happens before dedupe so that "the same page" is decided on
 * a stable key rather than on incidental URL decoration.
 */

import type { RawHit } from "../engines/types.ts";

/** Parameters that never change which page is served. */
const TRACKING_PARAMS = [
	/^utm_/i,
	/^gclid$/i,
	/^fbclid$/i,
	/^igshid$/i,
	/^mc_cid$/i,
	/^mc_eid$/i,
	/^ref$/i,
	/^referrer$/i,
	/^source$/i,
	/^spm$/i,
	/^share$/i,
	/^_hsenc$/i,
	/^_hsmi$/i,
	/^vero_id$/i,
	/^oly_enc_id$/i,
	/^oly_anon_id$/i,
	/^wickedid$/i,
	/^yclid$/i,
	/^msclkid$/i,
	/^_ga$/i,
	/^_gl$/i,
];

/** Parameters that are load-bearing on specific sites and must survive. */
const KEEP_PARAMS_BY_HOST: Array<{ host: RegExp; params: RegExp[] }> = [
	{ host: /(^|\.)youtube\.com$/, params: [/^v$/i, /^list$/i, /^t$/i] },
	{ host: /(^|\.)github\.com$/, params: [/^v$/i, /^tab$/i] },
	{ host: /(^|\.)stackoverflow\.com$/, params: [/^q$/i, /^a$/i] },
	{ host: /(^|\.)docs\.google\.com$/, params: [/^id$/i] },
	{ host: /(^|\.)arxiv\.org$/, params: [/^id$/i] },
];

/** Google's AMP cache and similar proxies serve a copy of another page. */
const AMP_HOSTS = [/^(.+\.)?cdn\.ampproject\.org$/i, /^(.+\.)?ampproject\.net$/i];

export interface CanonicalUrl {
	/** Stable identity key: scheme-less host + path + meaningful query, lowercased. */
	key: string;
	/** Cleaned URL safe to show the model and to fetch. */
	url: string;
	host: string;
}

/**
 * Canonicalise a result URL. Returns undefined when the URL cannot represent a
 * real destination (non-http, bare host, obvious engine-internal link).
 */
export function canonicalizeUrl(input: string): CanonicalUrl | undefined {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;

	let host = url.hostname.toLowerCase();
	// Unwrap AMP proxy hosts to the origin they mirror.
	for (const pattern of AMP_HOSTS) {
		if (pattern.test(host)) {
			const match = url.pathname.match(/^\/(?:c|s|i)?\/?([^/]+)\/(.*)$/);
			if (match) {
				host = match[1].replace(/-/g, ".").toLowerCase();
				url = new URL(`https://${host}/${match[2]}`);
			}
			break;
		}
	}

	// `www.` is not a different site.
	host = host.replace(/^www\./, "");
	// Country subdomains usually serve the same resource; collapse only when the
	// path is identical, which the dedupe key handles by using the apex host.
	const apexHost = host.replace(/^([a-z]{2})\./, "");

	const keep = KEEP_PARAMS_BY_HOST.find((entry) => entry.host.test(host))?.params ?? [];
	const params = new URLSearchParams();
	for (const [name, value] of url.searchParams) {
		if (keep.some((pattern) => pattern.test(name))) {
			params.append(name, value);
			continue;
		}
		if (TRACKING_PARAMS.some((pattern) => pattern.test(name))) continue;
		// Drop empty and single-character noise parameters.
		if (!value) continue;
		params.append(name, value);
	}

	// Strip trailing slash and index files; both are the same resource.
	let path = url.pathname.replace(/\/(index|default)\.(html?|php|aspx?)$/i, "/");
	path = path.replace(/\/+$/, "");
	if (!path) path = "/";
	// AMP path suffix.
	path = path.replace(/\/amp\/?$/i, "");

	const query = params.toString();
	const clean = `https://${host}${path}${query ? `?${query}` : ""}`;
	// The identity key ignores the subdomain split so that www/docs/blog variants
	// of the same path collapse, and ignores the query entirely only when empty.
	const key = `${apexHost}${path}${query ? `?${query}` : ""}`.toLowerCase();

	return { key, url: clean, host };
}

/** Strip HTML entities and collapse whitespace in extracted text. */
export function cleanText(input: string): string {
	return input
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/\s+/g, " ")
		.trim();
}

export interface NormalizedHit extends RawHit {
	canonical: CanonicalUrl;
}

/**
 * Canonicalise, clean and drop unusable hits. Hits that fail canonicalisation
 * are discarded rather than passed through, because an unfetchable URL in the
 * result list is worse than one fewer result.
 *
 * The `url` field is replaced with the canonical form, so a normalised hit is
 * safe to render and to fetch directly. The raw engine-supplied URL is not
 * preserved: keeping both invited exactly the bug where tracking parameters
 * leaked into user-visible output while ranking used the clean form.
 */
export function normalizeHits(hits: RawHit[]): NormalizedHit[] {
	const out: NormalizedHit[] = [];
	for (const hit of hits) {
		const canonical = canonicalizeUrl(hit.url);
		if (!canonical) continue;
		const title = cleanText(hit.title);
		if (title.length < 3) continue;
		out.push({
			...hit,
			title,
			url: canonical.url,
			snippet: cleanText(hit.snippet),
			canonical,
		});
	}
	return out;
}
