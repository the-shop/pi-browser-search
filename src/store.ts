/**
 * Session-scoped content store.
 *
 * `web_search` and `fetch_content` return a compact summary plus a
 * `responseId`; the full text lives here so a follow-up `get_search_content`
 * can pull one source or grep for passages without the model paying for every
 * document up front.
 *
 * Storage is explicit rather than ambient: callers pass their documents in when
 * creating an artifact, so two tool calls running in parallel cannot append into
 * each other's results.
 *
 * Artifacts live for the process lifetime and are also written to disk, so a
 * long session can always recover its sources even though the in-memory map is
 * the fast path.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EngineId } from "../engines/types.ts";
import type { RankedHit } from "./rank.ts";

export interface StoredDocument {
	url: string;
	title: string;
	text: string;
	kind?: string;
}

export interface SearchArtifact {
	responseId: string;
	createdAt: number;
	queries: string[];
	ranked: RankedHit[];
	documents: StoredDocument[];
	probes: number;
	achieved: Record<EngineId, number>;
	degraded: Partial<Record<EngineId, string>>;
	mixSummary: string;
	intents: string[];
}

export interface ArtifactInput {
	queries: string[];
	ranked: RankedHit[];
	/** Full-text documents gathered alongside the search. */
	documents?: StoredDocument[];
	probes: number;
	achieved: Record<EngineId, number>;
	degraded: Partial<Record<EngineId, string>>;
	mixSummary: string;
	intents: string[];
}

const artifacts = new Map<string, SearchArtifact>();
/** Insertion-ordered ids, so the oldest can be evicted first. */
const order: string[] = [];
/** Bound memory: keep the most recent N artifacts fully in RAM. */
const MAX_IN_MEMORY = 30;

function storeDir(): string {
	const base = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(base, "browser-search", "store");
}

function nextId(): string {
	// Short, sortable, and unambiguous to read back from a transcript.
	const stamp = Date.now().toString(36);
	const salt = Math.random().toString(36).slice(2, 6);
	return `bs_${stamp}${salt}`;
}

export function createArtifact(input: ArtifactInput): string {
	const responseId = nextId();
	const artifact: SearchArtifact = {
		responseId,
		createdAt: Date.now(),
		queries: input.queries,
		ranked: input.ranked,
		// Documents gathered by enrichment, plus a snippet-only entry for every
		// ranked result, so `get_search_content` can always return *something*
		// for any URL the search reported.
		documents: [
			...(input.documents ?? []),
			...input.ranked
				.filter((hit) => !(input.documents ?? []).some((doc) => doc.url === hit.url))
				.map((hit) => ({
					url: hit.url,
					title: hit.title,
					text: hit.snippet,
					kind: "snippet",
				})),
		],
		probes: input.probes,
		achieved: input.achieved,
		degraded: input.degraded,
		mixSummary: input.mixSummary,
		intents: input.intents,
	};

	artifacts.set(responseId, artifact);
	order.push(responseId);
	while (order.length > MAX_IN_MEMORY) {
		const oldest = order.shift();
		if (oldest) artifacts.delete(oldest);
	}

	// Persist in the background; a write failure must not fail the tool call.
	try {
		const dir = storeDir();
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${responseId}.json`), JSON.stringify(artifact), "utf8");
	} catch {
		// Best-effort.
	}

	return responseId;
}

export function getStoredContent(responseId: string): SearchArtifact | undefined {
	const inMemory = artifacts.get(responseId);
	if (inMemory) return inMemory;
	// Fall back to disk for artifacts evicted from memory or from a prior turn.
	try {
		const raw = readFileSync(join(storeDir(), `${responseId}.json`), "utf8");
		const parsed = JSON.parse(raw) as SearchArtifact;
		artifacts.set(parsed.responseId, parsed);
		order.push(parsed.responseId);
		return parsed;
	} catch {
		return undefined;
	}
}

export interface PassageMatch {
	url: string;
	title: string;
	passage: string;
}

/**
 * Find passages containing any of `needles`, case-insensitively.
 * Returns a window around each match rather than the whole document, so the
 * model can read several passages without paying for full pages.
 */
export function findInStored(
	responseId: string,
	needles: string[],
	url?: string,
	options: { windowChars?: number; maxMatches?: number } = {},
): PassageMatch[] {
	const artifact = getStoredContent(responseId);
	if (!artifact) return [];
	const windowChars = options.windowChars ?? 400;
	const maxMatches = options.maxMatches ?? 12;
	const lowered = needles.map((needle) => needle.toLowerCase()).filter(Boolean);
	if (lowered.length === 0) return [];

	const matches: PassageMatch[] = [];
	const documents = url ? artifact.documents.filter((doc) => doc.url === url) : artifact.documents;

	for (const doc of documents) {
		const haystack = doc.text.toLowerCase();
		const taken: Array<[number, number]> = [];
		for (const needle of lowered) {
			let from = 0;
			while (matches.length < maxMatches) {
				const at = haystack.indexOf(needle, from);
				if (at === -1) break;
				from = at + needle.length;
				// Skip matches already covered by a recorded window.
				if (taken.some(([start, end]) => at >= start && at <= end)) continue;
				const start = Math.max(0, at - Math.floor(windowChars / 2));
				const end = Math.min(doc.text.length, at + needle.length + Math.floor(windowChars / 2));
				taken.push([start, end]);
				matches.push({
					url: doc.url,
					title: doc.title,
					passage: doc.text.slice(start, end).replace(/\s+/g, " ").trim(),
				});
			}
		}
		if (matches.length >= maxMatches) break;
	}

	return matches;
}

/** Test seam: forget everything held in memory. */
export function clearStore(): void {
	artifacts.clear();
	order.length = 0;
}
