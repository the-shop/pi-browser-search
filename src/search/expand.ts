/**
 * Query fan-out.
 *
 * The owner's requirement is "at least 10 searches per web search, more if
 * needed / dig deeper to increase search precision". This module turns one
 * query into the probe set that satisfies it.
 *
 * The design point is that more *searches* is not the same as more *coverage*.
 * Ten paraphrases of the same question retrieve ten near-identical result sets,
 * which wastes the budget and adds nothing to ranking. So probes are drawn from
 * orthogonal strategies — lexical, intent, source-scoped, recency, terminology —
 * and each probe records the strategy that produced it. That label is what lets
 * the ranker treat agreement *across strategies* as strong evidence while
 * discounting agreement between near-duplicates.
 */

import type { Probe } from "../engines/types.ts";

export type ProbeStrategy =
	| "verbatim"
	| "quoted"
	| "explanatory"
	| "practical"
	| "issues"
	| "reference"
	| "comparison"
	| "recency"
	| "terminology"
	| "longtail"
	| "site-scoped";

export type Intent =
	| "howto"
	| "definition"
	| "comparison"
	| "troubleshooting"
	| "reference"
	| "news"
	| "general";

export interface ExpansionOptions {
	query: string;
	/** Minimum probes to generate. The spec floor is 10. */
	minProbes?: number;
	/** Override intent detection. */
	intent?: Intent;
	/** Domains worth mining directly, e.g. from a previous wave. */
	sites?: string[];
	/** Bias probes toward the last year. */
	recencySensitive?: boolean;
	/** Restrict every probe to a document type. */
	filetype?: string;
	/** Emit at most this many probes, even if the requested minimum is higher. */
	maxProbes?: number;
}

export interface ExpandedProbe extends Probe {
	strategy: ProbeStrategy;
	/** Whether the probe is a near-duplicate of another probe's retrieval intent. */
	distinct: boolean;
}

const INTENT_PATTERNS: Array<{ intent: Intent; pattern: RegExp }> = [
	{ intent: "troubleshooting", pattern: /\b(error|fails?|failing|broken|not working|won'?t|crash|bug|issue|problem|debug|troubleshoot)\b/i },
	{ intent: "comparison", pattern: /\b(vs\.?|versus|compare|comparison|difference between|better than|alternatives? to)\b/i },
	{ intent: "howto", pattern: /\b(how to|how do i|how does|setup|set up|configure|install|tutorial|guide|example|walkthrough)\b/i },
	{ intent: "definition", pattern: /\b(what is|what are|meaning of|definition of|explain|overview)\b/i },
	{ intent: "reference", pattern: /\b(docs?|documentation|api|reference|spec|specification|changelog|manual)\b/i },
	{ intent: "news", pattern: /\b(news|release[ds]?|announc\w+|latest|upcoming|roadmap|20\d\d)\b/i },
];

export function detectIntent(query: string): Intent {
	for (const { intent, pattern } of INTENT_PATTERNS) {
		if (pattern.test(query)) return intent;
	}
	return "general";
}

/** Content words, used to build terminology variants and to spot duplicates. */
export function contentWords(query: string): string[] {
	const stop = new Set([
		"the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "at", "by", "with",
		"is", "are", "was", "were", "be", "how", "what", "when", "where", "which", "who",
		"why", "this", "that", "it", "its", "as", "from", "into", "than", "do", "does",
		"i", "you", "my", "your", "we", "best", "good", "use", "using",
	]);
	return query
		.toLowerCase()
		.replace(/[^\p{L}\p{N}+#.\s-]/gu, " ")
		.split(/\s+/)
		.filter((word) => word.length >= 2 && !stop.has(word));
}

/** A short "topic phrase" — the query with question scaffolding removed. */
function topicPhrase(query: string): string {
	return query
		.replace(/^(how (to|do i|does|can i)|what (is|are)|why (is|does)|when (should|to)|where (is|can i))\s+/i, "")
		.replace(/[?]+\s*$/, "")
		.trim();
}

interface Candidate {
	strategy: ProbeStrategy;
	query: string;
	recencyMonths?: number;
	sites?: string[];
}

/** Strategy templates, ordered by how much new information they tend to add. */
function candidates(options: ExpansionOptions, intent: Intent): Candidate[] {
	const { query, recencySensitive = false } = options;
	const topic = topicPhrase(query);
	const out: Candidate[] = [];

	// 1. The query as asked. Always first: it is the best single predictor of
	//    what the user meant, and it is the baseline other probes extend.
	out.push({ strategy: "verbatim", query });

	// 2. Exact-phrase, to force precision and surface the canonical page.
	out.push({ strategy: "quoted", query: `"${topic}"` });

	// 3-4. Intent-shaped reformulations. These change *which pages rank*, not
	//      just the wording, so they add genuine retrieval diversity.
	switch (intent) {
		case "troubleshooting":
			out.push({ strategy: "issues", query: `${topic} fix`, recencyMonths: recencySensitive ? 12 : undefined });
			out.push({ strategy: "practical", query: `${topic} solution workaround` });
			out.push({ strategy: "reference", query: `${topic} error reference` });
			break;
		case "comparison":
			out.push({ strategy: "comparison", query: `${topic} comparison` });
			out.push({ strategy: "practical", query: `${topic} when to use each` });
			out.push({ strategy: "issues", query: `${topic} drawbacks limitations pitfalls` });
			break;
		case "howto":
			out.push({ strategy: "practical", query: `how to ${topic}` });
			out.push({ strategy: "practical", query: `${topic} step by step example` });
			out.push({ strategy: "issues", query: `${topic} common mistakes` });
			break;
		case "definition":
			out.push({ strategy: "explanatory", query: `what is ${topic}` });
			out.push({ strategy: "explanatory", query: `${topic} explained` });
			out.push({ strategy: "practical", query: `${topic} example` });
			break;
		case "reference":
			out.push({ strategy: "reference", query: `${topic} documentation` });
			out.push({ strategy: "reference", query: `${topic} api reference` });
			out.push({ strategy: "practical", query: `${topic} example` });
			break;
		case "news":
			out.push({ strategy: "recency", query: `${topic} latest`, recencyMonths: 12 });
			out.push({ strategy: "recency", query: `${topic} release notes`, recencyMonths: 12 });
			out.push({ strategy: "explanatory", query: `${topic} changes` });
			break;
		default:
			out.push({ strategy: "explanatory", query: `${topic} explanation` });
			out.push({ strategy: "practical", query: `${topic} guide example` });
			out.push({ strategy: "issues", query: `${topic} problems limitations` });
	}

	// 5. Source-scoped mining. Highest-precision probes available: they trade
	//    breadth for depth, which is exactly what a precision target wants.
	const sites = options.sites ?? [];
	if (sites.length > 0) {
		for (const site of sites.slice(0, 3)) {
			out.push({ strategy: "site-scoped", query: topic, sites: [site] });
		}
	} else {
		// No discovered domains yet (wave 1): mine the canonical host for intent.
		const seeds = SEED_SITES[intent] ?? SEED_SITES.general;
		out.push({ strategy: "site-scoped", query: topic, sites: [seeds[0]] });
	}

	// 6. Recency, when the topic moves fast.
	if (recencySensitive || intent === "news") {
		out.push({ strategy: "recency", query: topic, recencyMonths: 12 });
	} else {
		out.push({ strategy: "longtail", query: `${query} 2026` });
	}

	// 7. Terminology variants: the same concept under a different name is the
	//    single most reliable way to reach a page that ranking missed.
	out.push({ strategy: "terminology", query: `${topic} terminology naming conventions` });

	// 8. Long-tail natural language, which surfaces forum and Q&A content that
	//    keyword-shaped probes miss.
	out.push({ strategy: "longtail", query: `explain ${topic} in depth` });

	return out;
}

/** Canonical starting hosts per intent, used only when no domains are known. */
const SEED_SITES: Record<Intent, string[]> = {
	howto: ["stackoverflow.com"],
	definition: ["wikipedia.org"],
	comparison: ["stackoverflow.com"],
	troubleshooting: ["stackoverflow.com"],
	reference: ["github.com"],
	news: ["github.com"],
	general: ["wikipedia.org"],
};

/** Normalised form used to detect probes that would retrieve the same pages. */
function fingerprint(query: string): string {
	return contentWords(query).sort().join(" ");
}

export interface ExpansionResult {
	probes: ExpandedProbe[];
	intent: Intent;
	/** Strategies actually represented, for reporting and for the ranker. */
	strategies: ProbeStrategy[];
}

export function expandQuery(options: ExpansionOptions): ExpansionResult {
	const { query, minProbes = 10, maxProbes = 24 } = options;
	if (!query.trim()) throw new Error("expandQuery requires a non-empty query");

	const intent = options.intent ?? detectIntent(query);
	const pool = candidates(options, intent);

	// Deduplicate by retrieval fingerprint, not by string. Two probes phrased
	// differently but containing the same content words will fetch the same
	// results, so the second one is wasted budget.
	const seen = new Set<string>();
	const probes: ExpandedProbe[] = [];
	const strategies: ProbeStrategy[] = [];

	const push = (candidate: Candidate, distinct: boolean) => {
		const key = fingerprint(candidate.query) + "|" + (candidate.sites?.[0] ?? "");
		if (seen.has(key)) return false;
		seen.add(key);
		const id = `p${probes.length + 1}`;
		probes.push({
			id,
			query: candidate.query,
			label: candidate.strategy,
			strategy: candidate.strategy,
			distinct,
			...(candidate.sites?.length ? { engines: undefined } : {}),
			...(candidate.recencyMonths ? { recencyMonths: candidate.recencyMonths } : {}),
			...(options.filetype ? { filetype: options.filetype } : {}),
			// Site restriction is expressed on the probe so every adapter applies it
			// uniformly via the shared `site:` builder.
			...(candidate.sites?.length === 1 ? { site: candidate.sites[0] } : {}),
		});
		if (!strategies.includes(candidate.strategy)) strategies.push(candidate.strategy);
		return true;
	};

	for (const candidate of pool) {
		if (probes.length >= maxProbes) break;
		push(candidate, true);
	}

	// Top up to the floor with extra angles rather than duplicates, so a call
	// that asks for 15 probes still gets 15 *useful* probes.
	if (probes.length < minProbes) {
		const topic = topicPhrase(query);
		const filler: Candidate[] = [
			{ strategy: "explanatory", query: `${topic} architecture design` },
			{ strategy: "practical", query: `${topic} production experience` },
			{ strategy: "issues", query: `${topic} gotchas caveats` },
			{ strategy: "comparison", query: `${topic} alternatives` },
			{ strategy: "reference", query: `${topic} specification` },
			{ strategy: "longtail", query: `${topic} real world usage` },
			{ strategy: "recency", query: `${topic} recent changes`, recencyMonths: 12 },
			{ strategy: "terminology", query: `${topic} glossary` },
			{ strategy: "site-scoped", query: topic, sites: ["github.com"] },
			{ strategy: "site-scoped", query: topic, sites: ["stackoverflow.com"] },
			{ strategy: "explanatory", query: `${topic} deep dive` },
			{ strategy: "practical", query: `${topic} checklist` },
		];
		for (const candidate of filler) {
			if (probes.length >= minProbes) break;
			push(candidate, false);
		}
	}

	return { probes, intent, strategies };
}
