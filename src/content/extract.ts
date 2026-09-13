/**
 * Page content extraction.
 *
 * Browser-based rather than HTTP-based, so it sees what a reader sees: JS-
 * rendered content, lazy-loaded bodies, and pages that serve a bot a different
 * document than a browser. That is the point of scraping through Chrome instead
 * of `fetch`.
 *
 * The extractor is a deliberately small readability-style implementation. It
 * scores candidate containers by paragraph text density, picks the best, then
 * strips navigation, sidebars, footers and boilerplate from the winner. It aims
 * to be predictable on documentation and article pages, which is what a coding
 * agent actually fetches, and to fall back to whole-page text rather than
 * returning nothing when scoring finds no clear winner.
 */

import type { CdpSession } from "../browser/cdp.ts";
import { ChromeManager } from "../browser/chrome.ts";

export type ContentKind = "html" | "pdf" | "image" | "json" | "text" | "other";

export interface PageContent {
	/** Final URL after redirects. */
	url: string;
	title: string;
	kind: ContentKind;
	/** Extracted readable text (HTML) or raw body (other kinds). */
	text: string;
	/** Byte length of the original document. */
	bytes: number;
	/** Whether `text` was truncated to `maxChars`. */
	truncated: boolean;
	/** Set when extraction fell back to whole-page text. */
	fallback?: string;
	/**
	 * Set when the extracted text failed the content-quality check — most often
	 * because a cookie-consent overlay was captured instead of the page. Callers
	 * must surface this rather than presenting the text as page content.
	 */
	suspect?: string;
	/** Whether a consent overlay was dismissed before extraction. */
	consentDismissed?: boolean;
}

export interface FetchOptions {
	maxChars?: number;
	/** Milliseconds to wait for the document to settle. */
	settleMs?: number;
	signal?: AbortSignal;
}

const DEFAULT_MAX_CHARS = 30_000;

/**
 * Phrases that appear in a cookie-consent *dialog*, as opposed to prose that
 * merely discusses cookies. Multi-word and dialog-specific on purpose: counting
 * bare words like "cookie" flagged a genuine article about cookies, which is
 * the false positive that makes a detector like this worse than none.
 */
const CONSENT_DIALOG_PHRASES: RegExp[] = [
	/we use cookies/i,
	/this (web)?site uses cookies/i,
	/we and (our|third)[\s\S]{0,40}use cookies/i,
	/koristimo kolačiće/i,
	/ova (web )?stranica koristi kolačiće/i,
	/mi i koristimo kolačiće/i,
	/prihvaćam sve/i,
	/prihvati sve/i,
	/prilagodite postavke/i,
	/postavke pristanka/i,
	/opcije pristanka/i,
	/kategorije kolačića/i,
	/cookie categories/i,
	/necessary cookies/i,
	/neophodni kolačići/i,
	/nužni kolačići/i,
	/vaši izbori/i,
	/your choices/i,
	/možemo pohraniti/i,
	/obraditi osobne podatke/i,
	/consent to the use/i,
	/suglasnost za kolačiće/i,
	/pristanak na kolačiće/i,
	/povući svoj pristanak/i,
	/withdraw your consent/i,
	/personalizirano oglašavanje/i,
	/personalised advertising/i,
	/trajanje skladištenja/i,
	/storage duration/i,
	/no description available/i,
	/opis nije dostupan/i,
	/preferencijalni/i,
	/marketinški/i,
];

/** How many distinct dialog phrases must appear before extraction is condemned. */
const CONSENT_PHRASE_THRESHOLD = 4;

/**
 * Decide whether extracted text is plausibly page content.
 *
 * Pure and separate from extraction so it can be tested directly, and so the
 * judgement is visible rather than implied by a pile of selectors. The failure
 * it exists to catch is specific: a consent-walled site extracts to a few
 * thousand characters of cookie dialog and otherwise looks successful, which is
 * far worse than an outright error because the caller cannot tell.
 */
export function assessExtraction(
	text: string,
	documentBytes: number,
): { suspect: boolean; reason?: string } {
	const trimmed = text.trim();
	if (trimmed.length < 200) {
		return { suspect: true, reason: "extracted text is too short to be page content" };
	}

	// Count *distinct* dialog phrases, not total term occurrences. A page that
	// genuinely discusses cookies repeats the word many times; a consent dialog
	// instead piles up boilerplate phrases that never co-occur in prose.
	const matched = CONSENT_DIALOG_PHRASES.filter((phrase) => phrase.test(trimmed));
	const lines = trimmed.split("\n").map((line) => line.trim()).filter(Boolean);
	const longLines = lines.filter((line) => line.length > 200).length;
	const hasProse = longLines >= 2;

	if (matched.length >= CONSENT_PHRASE_THRESHOLD && !hasProse) {
		return {
			suspect: true,
			reason: `content is a cookie-consent dialog (${matched.length} distinct consent phrases, no prose paragraph)`,
		};
	}

	// Prose test on its own: menu and dialog chrome is a list of short fragments.
	const shortLines = lines.filter((line) => line.length <= 40).length;
	if (!hasProse && lines.length > 20 && shortLines / lines.length > 0.75) {
		return {
			suspect: true,
			reason: "content is a list of short fragments with no prose paragraph — likely navigation or dialog chrome",
		};
	}

	if (documentBytes > 200_000 && trimmed.length < 500) {
		return {
			suspect: true,
			reason: `extracted only ${trimmed.length} chars from a ${documentBytes}-char document`,
		};
	}

	return { suspect: false };
}

/**
 * Dismiss a cookie-consent overlay so the real page can render.
 *
 * The accept control is matched by visible label rather than by vendor
 * selector, because these sites use hashed class names and several different
 * consent products. Cross-origin consent iframes (Sourcepoint and friends)
 * cannot be reached from the parent frame; that case is reported by the quality
 * check rather than silently returning the overlay.
 */
async function dismissConsent(page: CdpSession): Promise<boolean> {
	try {
		return await page.evaluate<boolean>(`
			(() => {
				const LABELS = /^(accept all|accept cookies|accept|allow all|allow|i agree|agree|got it|ok|okay|prihvati sve|prihvati|slažem se|slazem se|u redu|razumijem|pove\u0107aj|povecaj|sve\u017e|dopusti sve)\\b/i;
			const nodes = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], .cky-btn, [id*="accept" i], [class*="accept" i]'));
			for (const node of nodes) {
				const label = ((node.innerText || node.value || node.getAttribute('aria-label') || '') + '').trim();
				if (!LABELS.test(label)) continue;
				const rect = node.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) continue;
				try { node.click(); } catch (e) { continue; }
				return true;
			}
			// Vendor-specific fallbacks, then a last resort on consent containers.
			const VENDORS = ['#onetrust-accept-btn-handler', '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', '.cky-btn-accept', '[data-testid="uc-accept-all-button"]', '#axeptio_btn_acceptAll', '.cc-allow', '.js-cookie-consent-agree'];
			for (const selector of VENDORS) {
				const node = document.querySelector(selector);
				if (node) { try { node.click(); return true; } catch (e) {} }
			}
			return false;
			})()
		`);
	} catch {
		return false;
	}
}

export async function fetchPage(
	chrome: ChromeManager,
	url: string,
	options: FetchOptions = {},
): Promise<PageContent> {
	const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
	const signal = options.signal;
	const settleMs = options.settleMs ?? 900;
	const page = await chrome.newPage(signal);
	const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
	try {
		await page.navigate(url, { timeoutMs: 30_000 });
		// `readyState: complete` fires before client-rendered pages have painted,
		// and before many consent overlays have appeared.
		await wait(settleMs);

		// Clear the overlay first: on a consent-walled site the dialog is the
		// largest text block, so extraction otherwise returns the dialog.
		const consentDismissed = await dismissConsent(page);
		if (consentDismissed) await wait(settleMs);

		const read = () =>
			page.evaluate<{
				url: string;
				title: string;
				kind: ContentKind;
				text: string;
				bytes: number;
				fallback?: string;
			}>(`(${extractSource.toString()})()`);

		let raw = await read();
		if (!raw || typeof raw.text !== "string") {
			throw new Error(`Could not extract content from ${url}`);
		}

		let quality = assessExtraction(raw.text, raw.bytes);
		// One retry: a second consent layer, or content that only renders after the
		// overlay is gone. Keep whichever attempt is clearly better.
		if (quality.suspect && raw.kind === "html") {
			const second = await dismissConsent(page);
			await wait(Math.round(settleMs * 1.6));
			const retry = await read();
			if (retry && typeof retry.text === "string") {
				const retryQuality = assessExtraction(retry.text, retry.bytes);
				if (!retryQuality.suspect || retry.text.length > raw.text.length * 1.5) {
					raw = retry;
					quality = retryQuality;
				}
			}
			if (quality.suspect && !second) {
				quality = {
					...quality,
					reason: `${quality.reason}; no dismissible consent control was found (the overlay may be in a cross-origin iframe)`,
				};
			}
		}

		const truncated = raw.text.length > maxChars;
		return {
			url: raw.url || url,
			title: raw.title || "",
			kind: raw.kind,
			text: truncated ? raw.text.slice(0, maxChars) : raw.text,
			bytes: raw.bytes,
			truncated,
			...(raw.fallback ? { fallback: raw.fallback } : {}),
			...(quality.suspect ? { suspect: quality.reason } : {}),
			...(consentDismissed ? { consentDismissed: true } : {}),
		};
	} finally {
		await page.close().catch(() => undefined);
	}
}

/**
 * Runs inside the page. Self-contained: no closure over module scope, because
 * it is serialised and sent over CDP.
 */
function extractSource(): {
	url: string;
	title: string;
	kind: ContentKind;
	text: string;
	bytes: number;
	fallback?: string;
} {
	const doc = document;
	const contentType = doc.contentType || "";

	// Non-HTML documents cannot be read as text.

	const kind = ((): ContentKind => {
		if (contentType.includes("pdf")) return "pdf";
		if (contentType.startsWith("image/")) return "image";
		if (contentType.includes("json")) return "json";
		if (contentType.includes("html")) return "html";
		if (contentType.startsWith("text/")) return "text";
		return "other";
	})();

	const bytes = doc.documentElement ? doc.documentElement.outerHTML.length : 0;

	if (kind === "pdf") {
		// A PDF viewer exposes no useful DOM text; the caller should handle it as
		// a binary asset rather than pretending to have extracted content.
		return { url: location.href, title: doc.title || "", kind, text: "", bytes };
	}
	if (kind === "image") {
		return { url: location.href, title: doc.title || "", kind, text: "", bytes };
	}
	if (kind === "json" || kind === "text") {
		const body = doc.body ? doc.body.textContent || "" : "";
		return { url: location.href, title: doc.title || "", kind, text: body.trim(), bytes };
	}

	// --- HTML readable extraction -------------------------------------------
	const NOISE_SELECTORS = [
		"script", "style", "noscript", "template", "iframe", "svg", "canvas",
		"nav", "header", "footer", "aside", "form", "button", "input", "select",
		"[role=navigation]", "[role=banner]", "[role=contentinfo]", "[role=complementary]",
		"[aria-hidden=true]", "[hidden]", ".nav", ".navbar", ".menu", ".sidebar",
		".footer", ".header", ".breadcrumb", ".pagination", ".toc", ".advert",
		".ad", ".ads", ".cookie", ".consent", ".share", ".social", ".comment",
		".comments", ".related", ".recommend", ".newsletter", ".subscribe",
		"#nav", "#footer", "#header", "#sidebar", "#comments", "#search",
		// Cookie-consent overlays. Without these a consent-walled site returns its
		// dialog as the page content, which reads as a successful extraction of a
		// page that is actually all boilerplate. Covers the vendors seen on
		// Croatian retail sites plus the generic shapes.
		"#onetrust-consent-sdk", "#onetrust-banner-sdk", ".optanon-alert-box-wrapper",
		"#CybotCookiebotDialog", "#CookiebotWidget", ".cky-consent-container", ".cky-modal",
		"#usercentrics-root", "#usercentrics-cmp-ui", "#cookie-banner", "#cookie-notice",
		"#cookieConsent", "#gdpr-banner", "#consent-banner", "#privacy-banner",
		"[id*=consent i]", "[class*=consent i]", "[id*=cookie i]", "[class*=cookie i]",
		"[id*=gdpr i]", "[class*=gdpr i]",
	];

	function cleanNode(node: Element): void {
		for (const selector of NOISE_SELECTORS) {
			for (const found of Array.from(node.querySelectorAll(selector))) {
				found.remove();
			}
		}
	}

	function textOf(node: Element): string {
		return (node.textContent || "").replace(/\s+/g, " ").trim();
	}

	/** Paragraph-density score: text in <p>/<li> counts, nav noise does not. */
	function score(node: Element): number {
		const paragraphs = node.querySelectorAll("p, li, pre, blockquote, td");
		let total = 0;
		let counted = 0;
		for (const paragraph of Array.from(paragraphs)) {
			const length = textOf(paragraph).length;
			// Ignore fragments that are too short to be prose.
			if (length < 25) continue;
			total += length;
			counted += 1;
		}
		if (counted === 0) return 0;
		// Density: total prose length, mildly damped by link-heavy containers.
		const linkText = Array.from(node.querySelectorAll("a")).reduce((sum, a) => sum + textOf(a).length, 0);
		const linkRatio = total === 0 ? 1 : Math.min(1, linkText / Math.max(total, 1));
		return total * (1 - linkRatio * 0.6);
	}

	const candidates: Element[] = [];
	for (const selector of ["article", "main", "[role=main]", "#content", ".content", "#main", ".post", ".article", ".markdown-body", ".doc-content"]) {
		for (const found of Array.from(doc.querySelectorAll(selector))) candidates.push(found);
	}
	// Always include a generic container as a fallback candidate.
	if (doc.body) candidates.push(doc.body);

	let best: Element | undefined;
	let bestScore = 0;
	for (const candidate of candidates) {
		const value = score(candidate);
		if (value > bestScore) {
			bestScore = value;
			best = candidate;
		}
	}

	let fallback: string | undefined;
	let root: Element;
	if (best && bestScore > 200) {
		root = best;
	} else {
		// No confident winner: use the whole body and say so, rather than
		// returning an empty document.
		root = doc.body ?? doc.documentElement;
		fallback = "no high-confidence content container; returned whole-page text";
	}

	const clone = root.cloneNode(true) as Element;
	cleanNode(clone);

	// Preserve code block boundaries: they are the most valuable content for a
	// coding agent and collapse badly if whitespace is normalised blindly.
	for (const pre of Array.from(clone.querySelectorAll("pre"))) {
		const code = pre.textContent || "";
		pre.replaceWith(doc.createTextNode(`\n\n\`\`\`\n${code.replace(/\n{3,}/g, "\n\n").trim()}\n\`\`\`\n\n`));
	}
	// Headings become markdown so document structure survives.
	for (const level of [1, 2, 3, 4, 5, 6]) {
		for (const heading of Array.from(clone.querySelectorAll(`h${level}`))) {
			heading.replaceWith(doc.createTextNode(`\n\n${"#".repeat(level)} ${textOf(heading)}\n\n`));
		}
	}
	for (const item of Array.from(clone.querySelectorAll("li"))) {
		item.replaceWith(doc.createTextNode(`\n- ${textOf(item)}`));
	}
	// Links keep their href, which matters for following references.
	for (const anchor of Array.from(clone.querySelectorAll("a[href]"))) {
		const label = textOf(anchor);
		const href = anchor.getAttribute("href") || "";
		if (!label) continue;
		anchor.replaceWith(doc.createTextNode(href && !href.startsWith("#") ? `${label} (${href})` : label));
	}

	let text = (clone.textContent || "")
		.replace(/[ \t\u00a0]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	return {
		url: location.href,
		title: doc.title || "",
		kind: "html",
		text,
		bytes,
		...(fallback ? { fallback } : {}),
	};
}
