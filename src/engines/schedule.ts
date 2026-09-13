/**
 * Engine allocation.
 *
 * The configured split is Google 70 / DuckDuckGo 30. Two
 * properties matter for it to hold in practice:
 *
 *  1. **Exactly proportional, not sampled.** Random weighting would cluster —
 *     a 10-probe call could easily come out 10/0/0. We use smooth weighted
 *     round-robin (the nginx algorithm), which is deterministic and spreads
 *     each engine evenly across the wave instead of bunching it.
 *  2. **Eligibility-aware.** Some probes can only run on some engines
 *     (`filetype:` is Google-only here). Constraints are honoured first, then
 *     the global mix is reported as *achieved* rather than assumed.
 */

import type { EngineId, Probe } from "./types.ts";

export type EngineWeights = Record<EngineId, number>;

/**
 * Google 70 / DuckDuckGo 30.
 *
 * Bing held the remaining 10 points until it was removed: it answered with a
 * complete, well-formed SERP of unrelated results (see the top-level README),
 * so its share was being spent on output the relevance gate then discarded.
 * DuckDuckGo takes the points rather than Google, which is the scarce lane.
 */
export const DEFAULT_WEIGHTS: EngineWeights = {
	google: 70,
	duckduckgo: 30,
};

export interface AllocationPlan {
	/** probeId -> engine */
	assignments: Map<string, EngineId>;
	/** Intended number of probes per engine before eligibility constraints. */
	targets: EngineWeights;
	/** Actual number of probes per engine after constraints. */
	achieved: EngineWeights;
	/** Probes that could not be placed at all (should be empty in practice). */
	unplaced: string[];
}

/** Hamilton largest-remainder apportionment so the quotas sum to exactly `total`. */
export function apportion(total: number, weights: EngineWeights): EngineWeights {
	const engines = Object.keys(weights) as EngineId[];
	const sum = engines.reduce((acc, engine) => acc + weights[engine], 0);
	if (sum <= 0) throw new Error("Engine weights must sum to a positive number");

	const exact = engines.map((engine) => ({ engine, value: (total * weights[engine]) / sum }));
	const floors = exact.map(({ engine, value }) => ({ engine, floor: Math.floor(value), frac: value - Math.floor(value) }));
	const assigned = floors.reduce((acc, { floor }) => acc + floor, 0);

	const result = {} as EngineWeights;
	for (const { engine, floor } of floors) result[engine] = floor;

	// Distribute the remaining slots to the largest fractional parts.
	const remainder = total - assigned;
	const byFraction = [...floors].sort((a, b) => b.frac - a.frac);
	for (let i = 0; i < remainder; i++) {
		const slot = byFraction[i % byFraction.length];
		result[slot.engine] += 1;
	}
	return result;
}

/**
 * Smooth weighted round-robin ordering over `count` slots.
 * Produces an evenly interleaved sequence, e.g. 70/30 over 10 slots yields
 * google, duckduckgo, google, google, duckduckgo, google, google, duckduckgo, ...
 */
export function smoothSequence(count: number, weights: EngineWeights): EngineId[] {
	const engines = Object.keys(weights) as EngineId[];
	const sum = engines.reduce((acc, engine) => acc + weights[engine], 0);
	const current = {} as EngineWeights;
	for (const engine of engines) current[engine] = 0;

	const sequence: EngineId[] = [];
	for (let i = 0; i < count; i++) {
		for (const engine of engines) current[engine] += weights[engine];
		let pick = engines[0];
		for (const engine of engines) {
			if (current[engine] > current[pick]) pick = engine;
		}
		current[pick] -= sum;
		sequence.push(pick);
	}
	return sequence;
}

/** Engines a probe may use, ordered by descending global weight. */
export function eligibleEngines(probe: Probe, weights: EngineWeights): EngineId[] {
	const all = Object.keys(weights) as EngineId[];
	const allowed = probe.engines ? all.filter((engine) => probe.engines!.includes(engine)) : all;
	if (probe.filetype) {
		// Measured: DuckDuckGo's no-JS endpoints do not honour `filetype:` usefully.
		const narrowed = allowed.filter((engine) => engine !== "duckduckgo");
		if (narrowed.length > 0) return narrowed;
	}
	return allowed.length > 0 ? allowed : all;
}

export function allocate(probes: Probe[], weights: EngineWeights = DEFAULT_WEIGHTS): AllocationPlan {
	const targets = apportion(probes.length, weights);
	const assignments = new Map<string, EngineId>();
	const achieved: EngineWeights = { google: 0, duckduckgo: 0 };

	// Walk an ideal SWRR ordering, but only place a probe when the engine is
	// eligible for it. This preserves the interleaving while respecting caps.
	const sequence = smoothSequence(probes.length, weights);
	const remaining = new Set(probes.map((probe) => probe.id));
	const byId = new Map(probes.map((probe) => [probe.id, probe]));

	for (const engine of sequence) {
		if (remaining.size === 0) break;
		for (const probeId of remaining) {
			const probe = byId.get(probeId)!;
			if (!eligibleEngines(probe, weights).includes(engine)) continue;
			assignments.set(probeId, engine);
			achieved[engine] += 1;
			remaining.delete(probeId);
			break;
		}
	}

	// Anything left over (eligibility starved it) gets its heaviest eligible engine.
	for (const probeId of remaining) {
		const probe = byId.get(probeId)!;
		const eligible = eligibleEngines(probe, weights);
		const pick = eligible.reduce((best, engine) =>
			achieved[engine] < achieved[best] ? engine : best,
		eligible[0]);
		assignments.set(probeId, pick);
		achieved[pick] += 1;
	}

	return { assignments, targets, achieved, unplaced: [...remaining] };
}

/** Fractional share of each engine in an achieved mix, for reporting. */
export function describeMix(counts: EngineWeights): string {
	const total = counts.google + counts.duckduckgo;
	if (total === 0) return "no probes run";
	const pct = (n: number) => Math.round((n / total) * 100);
	return `google ${counts.google}/${total} (${pct(counts.google)}%) · duckduckgo ${counts.duckduckgo}/${total} (${pct(counts.duckduckgo)}%)`;
}
