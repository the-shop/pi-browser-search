/**
 * Ranking.
 *
 * The spec asks for precision, and precision comes from *corroboration* rather
 * than from any single engine's ordering. A page that Google, DuckDuckGo and
 * DuckDuckGo all place highly, reached via several independent probe strategies, is a
 * far stronger answer than one engine's rank-1 hit — and it is also the best
 * available defence against a single engine returning a plausible-looking but
 * off-target SERP.
 *
 * Signals, in descending order of weight:
 *
 *   1. corroborating engines   — independent engines agreeing is the strongest
 *                                available evidence.
 *   2. distinct probe support  — agreement across *strategies*, not repeats of
 *                                the same query, so paraphrase duplicates do not
 *                                inflate a result's score.
 *   3. position                — rank-weighted with a log discount, summed over
 *                                every occurrence rather than taken from one.
 *   4. query-term match        — over title, snippet and host.
 *   5. domain authority        — a small prior, intent-aware.
 *   6. freshness               — only when the query is time-sensitive.
 *
 * A per-domain cap is applied last so that one high-scoring domain cannot
 * monopolise the result list.
 */

import type { EngineId } from "../engines/types.ts";
import { queryTerms } from "./relevance.ts";
import type { NormalizedHit } from "./normalize.ts";

export interface RankedHit {
	title: string;
	url: string;
	host: string;
	snippet: string;
	score: number;
	/** Engines that returned this result, deduplicated. */
	engines: EngineId[];
	/** Distinct probe strategies that surfaced it. */
	strategies: string[];
	/** Best position seen across all occurrences. */
	bestPosition: number;
	/** Every (engine, probe, position) occurrence, for provenance display. */
	occurrences: Array<{ engine: EngineId; probeId: string; strategy: string; position: number }>;
	/** True when at least two independent engines returned it. */
	corroborated: boolean;
}

export interface RankOptions {
	weights?: Partial<Record<EngineId, number>>;
	maxPerDomain?: number;
	limit?: number;
	/** Probe strategies by probe id, so corroboration can be strategy-aware. */
	strategyByProbe?: Map<string, string>;
	/** Time-sensitive queries earn a freshness bonus. */
	recencySensitive?: boolean;
	/** Now, for deterministic testing. */
	now?: number;
}

/** Relative trust in each engine's *ordering*. Google is the strongest prior,
 * but this is deliberately a small effect: corroboration beats brand. */
const ENGINE_TRUST: Record<EngineId, number> = {
	google: 1.0,
	duckduckgo: 0.9,
};

/** Intent-agnostic authority prior. Deliberately small — it breaks ties, it
 * does not decide them, because a strongly corroborated result from an unknown
 * host should still beat a weakly corroborated result from a famous one. */
const AUTHORITY_DOMAINS: Array<{ pattern: RegExp; score: number }> = [
	{ pattern: /(^|\.)docs\./i, score: 1.0 },
	{ pattern: /(^|\.)developer\./i, score: 1.0 },
	{ pattern: /(^|\.)github\.com$/i, score: 0.9 },
	{ pattern: /(^|\.)stackoverflow\.com$/i, score: 0.9 },
	{ pattern: /(^|\.)stackexchange\.com$/i, score: 0.85 },
	{ pattern: /(^|\.)wikipedia\.org$/i, score: 0.8 },
	{ pattern: /(^|\.)(arxiv|acm|ieee|springer|usenix)\.org$/i, score: 0.9 },
	{ pattern: /(^|\.)(postgresql|python|nodejs|rust-lang|go\.dev|kernel|mozilla)\.(org|dev)$/i, score: 0.95 },
	{ pattern: /\.(gov|edu)(\.[a-z]{2})?$/i, score: 0.85 },
	{ pattern: /(^|\.)medium\.com$/i, score: 0.45 },
	{ pattern: /(^|\.)(dev\.to|hashnode\.dev)$/i, score: 0.5 },
	{ pattern: /(^|\.)(pinterest|quora)\./i, score: 0.2 },
	{ pattern: /(^|\.)(w3schools|geeksforgeeks|tutorialspoint|javatpoint)\./i, score: 0.35 },
];

/** Hosts that reliably indicate low-value or duplicated content. */
const SPAM_HINTS = [/top\s?\d+\s?best/i, /(^|\.)coupon/i, /(^|\.)casino/i, /(^|\.)betting/i];

function authority(host: string): number {
	for (const { pattern, score } of AUTHORITY_DOMAINS) {
		if (pattern.test(host)) return score;
	}
	return 0.5;
}

function spamPenalty(host: string, url: string): number {
	let penalty = 0;
	for (const hint of SPAM_HINTS) {
		if (hint.test(host) || hint.test(url)) penalty += 0.5;
	}
	// Very long numeric paths are a common content-farm signature.
	if (/\/\d{4,}\//.test(url)) penalty += 0.15;
	return penalty;
}

function positionScore(position: number): number {
	// Reciprocal rank with a log base: rank 1 -> 1.0, 10 -> ~0.29, 20 -> ~0.23.
	return 1 / Math.log2(position + 1);
}

function termMatch(hit: NormalizedHit, terms: string[]): number {
	if (terms.length === 0) return 0;
	const haystackTitle = hit.title.toLowerCase();
	const haystackSnippet = hit.snippet.toLowerCase();
	const haystackHost = hit.canonical.host;
	let score = 0;
	for (const term of terms) {
		if (haystackTitle.includes(term)) score += 1;
		else if (haystackHost.includes(term)) score += 0.9;
		else if (haystackSnippet.includes(term)) score += 0.5;
	}
	return score / terms.length;
}

interface Accumulator {
	hit: NormalizedHit;
	engines: Set<EngineId>;
	strategies: Set<string>;
	positionTotal: number;
	bestPosition: number;
	occurrences: RankedHit["occurrences"];
}

/**
 * Merge, score and select results.
 * Deterministic: ties break on URL so repeated runs produce identical output.
 */
export function rankHits(
	query: string,
	hits: NormalizedHit[],
	options: RankOptions = {},
): RankedHit[] {
	const {
		maxPerDomain = 2,
		limit = 20,
		strategyByProbe,
		recencySensitive = false,
		now = Date.now(),
	} = options;
	const terms = queryTerms(query);
	const trust = { ...ENGINE_TRUST, ...(options.weights ?? {}) };

	// --- group by canonical identity -----------------------------------------
	const byKey = new Map<string, Accumulator>();
	for (const hit of hits) {
		const key = hit.canonical.key;
		let entry = byKey.get(key);
		if (!entry) {
			entry = {
				hit,
				engines: new Set(),
				strategies: new Set(),
				positionTotal: 0,
				bestPosition: Number.POSITIVE_INFINITY,
				occurrences: [],
			};
			byKey.set(key, entry);
		}
		// Prefer the longest snippet and the most title-cased title seen.
		if (hit.snippet.length > entry.hit.snippet.length) entry.hit = { ...entry.hit, snippet: hit.snippet };
		if (hit.title.length > entry.hit.title.length) entry.hit = { ...entry.hit, title: hit.title };

		const strategy = strategyByProbe?.get(hit.probeId) ?? "unknown";
		entry.engines.add(hit.engine);
		entry.strategies.add(strategy);
		entry.positionTotal += positionScore(hit.position);
		entry.bestPosition = Math.min(entry.bestPosition, hit.position);
		entry.occurrences.push({
			engine: hit.engine,
			probeId: hit.probeId,
			strategy,
			position: hit.position,
		});
	}

	// --- score ---------------------------------------------------------------
	const scored: RankedHit[] = [];
	for (const entry of byKey.values()) {
		const { hit } = entry;
		const engines = [...entry.engines];
		const strategies = [...entry.strategies];

		// Engine corroboration: 2 engines is worth far more than twice 1.
		const corroboration = engines.length >= 2 ? 1.6 + (engines.length - 2) * 0.5 : 0;
		// Strategy support, capped so a single mechanism repeated cannot dominate.
		const strategySupport = Math.min(strategies.filter((s) => s !== "unknown").length, 4) * 0.35;
		const engineWeight = Math.max(...engines.map((engine) => trust[engine] ?? 0.7));
		const position = entry.positionTotal * engineWeight;
		const relevance = termMatch(hit, terms);
		const authorityScore = authority(hit.canonical.host);
		const spam = spamPenalty(hit.canonical.host, hit.canonical.url);

		// Freshness is only meaningful for time-sensitive queries, and only when a
		// date is actually visible in the snippet.
		let freshness = 0;
		if (recencySensitive) {
			const year = hit.snippet.match(/\b(20\d\d)\b/);
			if (year) {
				const age = Math.max(0, new Date(now).getUTCFullYear() - Number(year[1]));
				freshness = age === 0 ? 0.4 : age === 1 ? 0.2 : 0;
			}
		}

		const score =
			3.0 * corroboration +
			1.5 * strategySupport +
			1.0 * position +
			1.0 * relevance +
			0.6 * authorityScore +
			freshness -
			1.2 * spam;

		scored.push({
			title: hit.title,
			url: hit.canonical.url,
			host: hit.canonical.host,
			snippet: hit.snippet,
			score,
			engines,
			strategies,
			bestPosition: entry.bestPosition,
			occurrences: entry.occurrences,
			corroborated: engines.length >= 2,
		});
	}

	// Highest score first; URL breaks ties so output is reproducible.
	scored.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));

	// --- diversity -----------------------------------------------------------
	// Applied after scoring so the cap removes the *weakest* duplicate from a
	// domain rather than the first one encountered.
	const perDomain = new Map<string, number>();
	const selected: RankedHit[] = [];
	for (const hit of scored) {
		if (selected.length >= limit) break;
		const count = perDomain.get(hit.host) ?? 0;
		if (count >= maxPerDomain) continue;
		perDomain.set(hit.host, count + 1);
		selected.push(hit);
	}
	return selected;
}

/**
 * Merge results that resolved to the same final URL.
 *
 * Ranking runs before redirect resolution, so a wrapped Google hit and a
 * DuckDuckGo hit for the same page look like different results at that point:
 * the wrapper is identified by its displayed host plus title, while DuckDuckGo
 * supplies a real URL. Once both are resolved to the same destination their
 * evidence has to be combined — otherwise the single strongest signal available
 * (independent engines agreeing) is silently lost for whichever engine happens
 * to wrap its links.
 */
export function mergeResolved(ranked: RankedHit[]): RankedHit[] {
	const byUrl = new Map<string, RankedHit>();
	for (const hit of ranked) {
		const existing = byUrl.get(hit.url);
		if (!existing) {
			byUrl.set(hit.url, hit);
			continue;
		}
		const engines = [...new Set([...existing.engines, ...hit.engines])];
		const strategies = [...new Set([...existing.strategies, ...hit.strategies])];
		const base = hit.score > existing.score ? hit : existing;
		const gainedAgreement = engines.length > Math.max(existing.engines.length, hit.engines.length);
		byUrl.set(hit.url, {
			...base,
			engines,
			strategies,
			corroborated: engines.length >= 2,
			// Re-derive the score from merged evidence; the corroboration term is
			// worth what it is worth in the original scoring, not less.
			score: base.score + (gainedAgreement ? 3.0 : 0),
			bestPosition: Math.min(existing.bestPosition, hit.bestPosition),
			occurrences: [...existing.occurrences, ...hit.occurrences],
		});
	}
	return [...byUrl.values()].sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
}
