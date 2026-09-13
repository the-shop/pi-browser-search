/**
 * Relevance gate.
 *
 * Measured hazard: Bing answers an automated client with a **complete,
 * well-formed SERP of entirely unrelated results** — a "postgres index bloat"
 * query returned German trade listings, Italian name-day greetings and a
 * Spanish dictionary entry, all inside ordinary `li.b_algo` containers, at
 * HTTP 200. Google has an equivalent failure (its `/sorry` page also returns
 * 200). Structural checks therefore cannot distinguish a real SERP from a
 * decoy; only the *content* can.
 *
 * This gate scores how much of an engine's output actually relates to the
 * query. A poor score marks the engine degraded instead of letting noise into
 * the ranking, so a failed lane is reported rather than silently absorbed.
 */

import type { EngineOutcome, Probe, RawHit } from "../engines/types.ts";

/** Words carrying no retrieval signal in a search query. */
const STOPWORDS = new Set([
	"the", "a", "an", "and", "or", "but", "of", "for", "to", "in", "on", "at", "by", "with",
	"is", "are", "was", "were", "be", "been", "being", "do", "does", "did", "how", "what",
	"when", "where", "which", "who", "why", "this", "that", "these", "those", "it", "its",
	"as", "from", "into", "than", "then", "there", "here", "can", "could", "should", "would",
	"will", "shall", "may", "might", "must", "not", "no", "yes", "vs", "versus", "about",
]);

/** Significant lowercase terms from a query. */
export function queryTerms(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^a-z0-9+#.]+/)
		.map((term) => term.replace(/^[.]+|[.]+$/g, ""))
		.filter((term) => term.length >= 2 && !STOPWORDS.has(term));
}

export interface RelevanceScore {
	/** Fraction of significant query terms present in the hit, 0..1. */
	coverage: number;
	/** Whether the hit clears the per-hit bar. */
	relevant: boolean;
}

/**
 * Score one hit against the query terms.
 * Titles and hosts are weighted above snippets, because a snippet can match on
 * incidental boilerplate while the title/host reflect the actual target.
 */
export function scoreHit(hit: RawHit, terms: string[]): RelevanceScore {
	if (terms.length === 0) return { coverage: 1, relevant: true };
	const title = hit.title.toLowerCase();
	const host = safeHost(hit.url);
	const snippet = hit.snippet.toLowerCase();

	let matched = 0;
	for (const term of terms) {
		const inTitle = title.includes(term);
		const inHost = host.includes(term);
		const inSnippet = snippet.includes(term);
		// A term in the title or host is decisive on its own; a snippet-only
		// match counts half, so boilerplate alone cannot carry a hit.
		if (inTitle || inHost) matched += 1;
		else if (inSnippet) matched += 0.5;
	}
	const coverage = Math.min(1, matched / terms.length);
	return { coverage, relevant: coverage >= 0.34 };
}

function safeHost(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

export interface EngineRelevance {
	engine: EngineOutcome["engine"];
	probeId: string;
	total: number;
	relevant: number;
	/** Fraction of hits that cleared the bar. */
	ratio: number;
	/** True when the engine's output looks like a decoy SERP. */
	suspect: boolean;
}

/** Below this fraction of relevant hits, an engine's output is treated as decoy. */
const SUSPECT_RATIO = 0.34;
/** Small result sets are judged leniently; one good hit out of two is not a decoy. */
const MIN_SAMPLE = 4;

export function assessOutcome(outcome: EngineOutcome, probes: Map<string, Probe>): EngineRelevance {
	const probe = probes.get(outcome.probeId);
	const terms = queryTerms(probe?.query ?? "");
	let relevant = 0;
	for (const hit of outcome.hits) {
		if (scoreHit(hit, terms).relevant) relevant += 1;
	}
	const total = outcome.hits.length;
	const ratio = total === 0 ? 0 : relevant / total;
	return {
		engine: outcome.engine,
		probeId: outcome.probeId,
		total,
		relevant,
		ratio,
		suspect: total >= MIN_SAMPLE && ratio < SUSPECT_RATIO,
	};
}

export interface RelevanceVerdict {
	hits: RawHit[];
	/** Engines whose output was discarded as irrelevant. */
	suspectEngines: Partial<Record<EngineOutcome["engine"], string>>;
	assessments: EngineRelevance[];
}

/**
 * Filter a wave's hits, dropping output from engines that look like they served
 * a decoy SERP, and flag engines that produced nothing at all.
 *
 * The zero-result case is reported explicitly because its cause is often
 * ambiguous from the outside: Google's block page, a consent redirect loop and
 * a blank timeout all look identical to a caller that only inspects results.
 * Saying "this engine delivered nothing" is always truthful, whereas guessing
 * the specific cause would not be.
 */
export function applyRelevanceGate(
	outcomes: EngineOutcome[],
	probes: Probe[],
): RelevanceVerdict {
	const probeById = new Map(probes.map((probe) => [probe.id, probe]));
	const assessments = outcomes
		.filter((outcome) => outcome.status === "ok")
		.map((outcome) => assessOutcome(outcome, probeById));

	const suspectEngines: Partial<Record<EngineOutcome["engine"], string>> = {};
	for (const engine of ["google", "duckduckgo", "bing"] as const) {
		const engineOutcomes = outcomes.filter((outcome) => outcome.engine === engine);
		if (engineOutcomes.length === 0) continue;

		const delivered = engineOutcomes.reduce((total, outcome) => total + outcome.hits.length, 0);
		if (delivered === 0) {
			const reason = engineOutcomes.find((outcome) => outcome.detail)?.detail ?? "returned no results";
			suspectEngines[engine] =
				`${engine} delivered no results across ${engineOutcomes.length} probe(s) — ${reason}`;
			continue;
		}

		// Condemn on the engine's AGGREGATE precision, not per-probe.
		//
		// This previously required *every* outcome to look suspect, on the
		// reasoning that one bad probe should not kill a working engine. The
		// reasoning was backwards in the case that matters: with 40 probes it
		// takes a single probe whose decoy hits coincidentally share a few query
		// terms to exonerate an engine that is decoying everywhere else. Measured
		// exactly that — Bing returned carnival listings for a laptop query
		// across 40/40 probes and was passed through as "bing 40/40 (100%)",
		// because one probe scored above the per-hit bar by coincidence.
		//
		// Aggregate precision is the property we actually care about, and it has
		// no such loophole: an engine that returns 400 hits of which almost none
		// relate to the query is decoying, whatever any single probe looks like.
		const engineAssessments = assessments.filter((a) => a.engine === engine && a.total > 0);
		if (engineAssessments.length === 0) continue;
		const totalHits = engineAssessments.reduce((sum, a) => sum + a.total, 0);
		const totalRelevant = engineAssessments.reduce((sum, a) => sum + a.relevant, 0);
		const precision = totalHits > 0 ? totalRelevant / totalHits : 0;
		if (totalHits > 0 && precision < SUSPECT_RATIO) {
			suspectEngines[engine] =
				`${engine} returned results unrelated to the query ` +
				`(${totalRelevant}/${totalHits} relevant across ${engineAssessments.length} probe(s)) ` +
				`— treating this engine as degraded`;
		}
	}

	const hits = outcomes
		.filter((outcome) => outcome.status === "ok" && !suspectEngines[outcome.engine])
		.flatMap((outcome) => outcome.hits);

	return { hits, suspectEngines, assessments };
}
