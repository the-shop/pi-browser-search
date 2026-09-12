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
}

export interface FetchOptions {
	maxChars?: number;
	/** Milliseconds to wait for the document to settle. */
	settleMs?: number;
	signal?: AbortSignal;
}

const DEFAULT_MAX_CHARS = 30_000;

export async function fetchPage(
	chrome: ChromeManager,
	url: string,
	options: FetchOptions = {},
): Promise<PageContent> {
	const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
	const signal = options.signal;
	const page = await chrome.newPage(signal);
	try {
		await page.navigate(url, { timeoutMs: 30_000 });
		// Give client-rendered pages a moment to hydrate. `readyState: complete`
		// fires before React/Vue apps have painted their content.
		await new Promise((resolve) => setTimeout(resolve, options.settleMs ?? 900));

		const raw = await page.evaluate<{
			url: string;
			title: string;
			kind: ContentKind;
			text: string;
			bytes: number;
			fallback?: string;
			href: string;
		}>(`(${extractSource.toString()})()`);

		if (!raw || typeof raw.text !== "string") {
			throw new Error(`Could not extract content from ${url}`);
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
