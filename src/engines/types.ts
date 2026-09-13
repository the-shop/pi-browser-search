/**
 * Engine adapter contract.
 *
 * Every adapter is responsible for three things and nothing else:
 *   1. turning a Probe into a URL,
 *   2. deciding whether the response is a real SERP or a block/challenge page,
 *   3. extracting organic results.
 *
 * Normalisation, deduplication and ranking happen later in the pipeline — an
 * adapter must not dedupe against itself or reorder results.
 */

import type { CdpSession } from "../browser/cdp.ts";

export type EngineId = "google" | "duckduckgo";

/** How a probe intends to be searched; adapters translate these to URL params. */
export interface Probe {
	/** Stable id, unique within one tool call. Used for provenance. */
	id: string;
	/** The literal query text sent to the engine. */
	query: string;
	/** Optional engine-side restriction, e.g. `site:github.com`. */
	site?: string;
	/** Optional `filetype:` restriction. */
	filetype?: string;
	/** Restrict to the last N months, when the engine supports it. */
	recencyMonths?: number;
	/** Which engines make sense for this probe. Undefined means all. */
	engines?: EngineId[];
	/** Human-readable label used in progress output. */
	label: string;
}

export interface RawHit {
	title: string;
	url: string;
	snippet: string;
	/** 1-based rank within this engine's result list. */
	position: number;
	engine: EngineId;
	probeId: string;
	/**
	 * Host as displayed by the engine, when it differs from the URL's host.
	 * Google wraps outbound links in an opaque encrypted redirect
	 * (`/goto?url=CAES...`) that cannot be decoded offline, so the displayed
	 * `<cite>` host is the only host information available before resolution.
	 */
	displayHost?: string;
	/** True when `url` is an engine redirect wrapper rather than the destination. */
	unresolved?: boolean;
}

export type EngineStatus = "ok" | "blocked" | "empty" | "error";

export interface EngineOutcome {
	engine: EngineId;
	probeId: string;
	status: EngineStatus;
	hits: RawHit[];
	/** Populated when status is blocked/error. Surfaced to the user verbatim. */
	detail?: string;
	elapsedMs: number;
}

export interface ExtractContext {
	page: CdpSession;
	probe: Probe;
	/** Max hits to keep from this page. */
	limit: number;
	/** Result offset, for page-2 deepening. */
	offset: number;
}

/**
 * Resolves engine redirect wrappers to their real destinations.
 * Implemented on the browser because the wrappers are opaque and same-origin
 * CORS blocks an in-page fetch.
 */
export interface RedirectResolver {
	resolve(page: CdpSession, url: string): Promise<string | undefined>;
}

export interface EngineAdapter {
	readonly id: EngineId;
	/** Build the SERP URL for a probe. */
	buildUrl(probe: Probe, offset: number): string;
	/**
	 * Whether this page is a block/challenge page rather than results.
	 * Must be structural — Google's block page returns HTTP 200 with a valid
	 * document, so status codes are never sufficient.
	 */
	detectBlock(page: CdpSession): Promise<string | undefined>;
	/**
	 * Attempt to clear a recoverable block in place (consent interstitials,
	 * cookie banners). Return true when the caller should retry navigation.
	 * Terminal blocks (CAPTCHA, /sorry) must return false.
	 */
	recover?(page: CdpSession, reason: string): Promise<boolean>;
	/** Wait until organic results have rendered. Returns false on timeout. */
	waitForResults(page: CdpSession, timeoutMs: number): Promise<boolean>;
	/** Extract organic results, already rank-ordered. */
	extract(ctx: ExtractContext): Promise<RawHit[]>;
}

/** Shared helper: run an extraction function in the page and coerce the result. */
export async function extractInPage<T>(page: CdpSession, fnSource: string): Promise<T> {
	return page.evaluate<T>(`(() => { ${fnSource} })()`, { awaitPromise: true });
}
