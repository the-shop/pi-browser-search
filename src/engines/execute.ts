/**
 * Wave executor.
 *
 * Runs an allocation plan: each engine gets its own queue, bounded concurrency
 * and a minimum gap between query submissions. Pacing is not decoration —
 * Google's interstitial is velocity-sensitive, so the gap is what keeps a
 * 7-probe wave inside budget.
 *
 * A blocked probe spills to another engine so the probe count promised to the
 * caller is preserved, and the *achieved* mix is reported rather than assumed.
 */

import type { CdpSession } from "../browser/cdp.ts";
import { ChromeManager } from "../browser/chrome.ts";
import { duckduckgo } from "./duckduckgo.ts";
import { google } from "./google.ts";
import { allocate, DEFAULT_WEIGHTS, describeMix, type EngineWeights } from "./schedule.ts";
import { applyRelevanceGate } from "../search/relevance.ts";
import type { EngineAdapter, EngineId, EngineOutcome, Probe, RawHit } from "./types.ts";

export interface EngineTuning {
	concurrency: number;
	/** Minimum delay between successive query submissions. */
	minGapMs: number;
	/** Random jitter added on top of minGapMs. */
	jitterMs: number;
}

/** Defaults derived from measurement: Google tolerates sustained ~2-3s gaps. */
export const DEFAULT_TUNING: Record<EngineId, EngineTuning> = {
	google: { concurrency: 2, minGapMs: 1800, jitterMs: 1400 },
	duckduckgo: { concurrency: 3, minGapMs: 700, jitterMs: 600 },
};

const ADAPTERS: Record<EngineId, EngineAdapter> = { google, duckduckgo };

export interface WaveOptions {
	chrome: ChromeManager;
	probes: Probe[];
	weights?: EngineWeights;
	tuning?: Partial<Record<EngineId, Partial<EngineTuning>>>;
	perPageLimit?: number;
	renderTimeoutMs?: number;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

export interface WaveResult {
	outcomes: EngineOutcome[];
	hits: RawHit[];
	targets: EngineWeights;
	achieved: EngineWeights;
	/** Engines that failed at least once, with the reason. */
	degraded: Partial<Record<EngineId, string>>;
	mixSummary: string;
}

/** Serialises work with a minimum interval between starts. */
class Pacer {
	private lastStart = 0;
	private chain: Promise<void> = Promise.resolve();
	private readonly minGapMs: number;
	private readonly jitterMs: number;
	private readonly signal?: AbortSignal;

	constructor(minGapMs: number, jitterMs: number, signal?: AbortSignal) {
		this.minGapMs = minGapMs;
		this.jitterMs = jitterMs;
		this.signal = signal;
	}

	async wait(): Promise<void> {
		const previous = this.chain;
		let release!: () => void;
		this.chain = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		const now = Date.now();
		const gap = this.minGapMs + Math.random() * this.jitterMs;
		const waitFor = Math.max(0, this.lastStart + gap - now);
		if (waitFor > 0) {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					this.signal?.removeEventListener("abort", onAbort);
					resolve();
				}, waitFor);
				const onAbort = () => {
					clearTimeout(timer);
					reject(new Error("Aborted"));
				};
				this.signal?.addEventListener("abort", onAbort, { once: true });
			});
		}
		this.lastStart = Date.now();
		release();
	}
}

async function runProbe(
	adapter: EngineAdapter,
	chrome: ChromeManager,
	probe: Probe,
	opts: Required<Pick<WaveOptions, "perPageLimit" | "renderTimeoutMs">> & { signal?: AbortSignal },
): Promise<EngineOutcome> {
	const started = Date.now();
	let page: CdpSession | undefined;
	try {
		page = await chrome.newPage(opts.signal);
		const url = adapter.buildUrl(probe, 0);
		await page.navigate(url, { timeoutMs: 30_000 });

		let blocked = await adapter.detectBlock(page);
		// A consent interstitial is recoverable: clearing it issues the cookies the
		// original query needs, so re-navigate once before giving up.
		if (blocked && adapter.recover) {
			const recovered = await adapter.recover(page, blocked);
			if (recovered) {
				await page.navigate(url, { timeoutMs: 30_000 });
				blocked = await adapter.detectBlock(page);
			}
		}
		if (blocked) {
			return {
				engine: adapter.id,
				probeId: probe.id,
				status: "blocked",
				hits: [],
				detail: blocked,
				elapsedMs: Date.now() - started,
			};
		}

		const rendered = await adapter.waitForResults(page, opts.renderTimeoutMs);
		if (!rendered) {
			// Distinguish "blocked late" from "genuinely empty".
			const lateBlock = await adapter.detectBlock(page);
			return {
				engine: adapter.id,
				probeId: probe.id,
				status: lateBlock ? "blocked" : "empty",
				hits: [],
				detail: lateBlock ?? "no results rendered within timeout",
				elapsedMs: Date.now() - started,
			};
		}

		const hits = await adapter.extract({
			page,
			probe,
			limit: opts.perPageLimit,
			offset: 0,
		});
		return {
			engine: adapter.id,
			probeId: probe.id,
			status: hits.length > 0 ? "ok" : "empty",
			hits,
			elapsedMs: Date.now() - started,
		};
	} catch (error) {
		return {
			engine: adapter.id,
			probeId: probe.id,
			status: "error",
			hits: [],
			detail: error instanceof Error ? error.message : String(error),
			elapsedMs: Date.now() - started,
		};
	} finally {
		await page?.close().catch(() => undefined);
	}
}

/** Run a bounded-concurrency queue for one engine. */
async function runEngineQueue(
	engine: EngineId,
	probes: Probe[],
	chrome: ChromeManager,
	tuning: EngineTuning,
	opts: Required<Pick<WaveOptions, "perPageLimit" | "renderTimeoutMs">> & {
		signal?: AbortSignal;
		onProgress?: (message: string) => void;
	},
): Promise<EngineOutcome[]> {
	const adapter = ADAPTERS[engine];
	const pacer = new Pacer(tuning.minGapMs, tuning.jitterMs, opts.signal);
	const results: EngineOutcome[] = [];
	let cursor = 0;
	let done = 0;

	const worker = async () => {
		while (cursor < probes.length) {
			if (opts.signal?.aborted) return;
			const index = cursor++;
			const probe = probes[index];
			await pacer.wait();
			const outcome = await runProbe(adapter, chrome, probe, opts);
			results[index] = outcome;
			done += 1;
			opts.onProgress?.(
				`${engine} ${done}/${probes.length} · ${probe.label}${outcome.status === "ok" ? ` (${outcome.hits.length})` : ` [${outcome.status}]`}`,
			);
		}
	};

	await Promise.all(Array.from({ length: Math.min(tuning.concurrency, probes.length) }, worker));
	return results.filter(Boolean);
}

export async function runWave(options: WaveOptions): Promise<WaveResult> {
	const {
		chrome,
		probes,
		weights = DEFAULT_WEIGHTS,
		perPageLimit = 20,
		renderTimeoutMs = 8_000,
		signal,
		onProgress,
	} = options;

	const plan = allocate(probes, weights);
	const byEngine = new Map<EngineId, Probe[]>();
	for (const probe of probes) {
		const engine = plan.assignments.get(probe.id);
		if (!engine) continue;
		const list = byEngine.get(engine) ?? [];
		list.push(probe);
		byEngine.set(engine, list);
	}

	const outcomes: EngineOutcome[] = [];
	const degraded: Partial<Record<EngineId, string>> = {};

	await Promise.all(
		[...byEngine.entries()].map(async ([engine, engineProbes]) => {
			const tuning: EngineTuning = { ...DEFAULT_TUNING[engine], ...(options.tuning?.[engine] ?? {}) };
			const results = await runEngineQueue(engine, engineProbes, chrome, tuning, {
				perPageLimit,
				renderTimeoutMs,
				signal,
				onProgress,
			});
			outcomes.push(...results);
			const failure = results.find((result) => result.status === "blocked");
			if (failure) degraded[engine] = failure.detail ?? "blocked";
		}),
	);

	// Reassign probes whose engine failed, so the promised probe count holds.
	const failed = outcomes.filter((outcome) => outcome.status === "blocked" || outcome.status === "error");
	if (failed.length > 0 && !signal?.aborted) {
		const substitutes: Array<{ engine: EngineId; probe: Probe }> = [];
		for (const outcome of failed) {
			const probe = probes.find((candidate) => candidate.id === outcome.probeId);
			if (!probe) continue;
			// Prefer the heaviest engine that has not already failed for this probe.
			const fallback = (["duckduckgo", "google"] as EngineId[]).find(
				(engine) => engine !== outcome.engine && !degraded[engine] && engine !== "google",
			);
			if (!fallback) continue;
			substitutes.push({ engine: fallback, probe: { ...probe, engines: [fallback] } });
			onProgress?.(`spillover: ${probe.label} → ${fallback}`);
		}
		// Google is deliberately excluded as a spillover target: it is the scarce
		// lane, and re-queuing blocked work onto it makes throttling worse.
		const byFallback = new Map<EngineId, Probe[]>();
		for (const { engine, probe } of substitutes) {
			const list = byFallback.get(engine) ?? [];
			list.push(probe);
			byFallback.set(engine, list);
		}
		await Promise.all(
			[...byFallback.entries()].map(async ([engine, fallbackProbes]) => {
				const tuning: EngineTuning = { ...DEFAULT_TUNING[engine], ...(options.tuning?.[engine] ?? {}) };
				const results = await runEngineQueue(engine, fallbackProbes, chrome, tuning, {
					perPageLimit,
					renderTimeoutMs,
					signal,
					onProgress,
				});
				outcomes.push(...results);
			}),
		);
	}

	const achieved: EngineWeights = { google: 0, duckduckgo: 0 };
	const hits: RawHit[] = [];
	for (const outcome of outcomes) {
		if (outcome.status === "ok") {
			achieved[outcome.engine] += 1;
			hits.push(...outcome.hits);
		}
	}

	// Structural success is not enough: an engine can return a complete,
	// well-formed SERP of unrelated results (measured on Bing, since removed). Only
	// tell a real SERP from a decoy, so the gate runs before anything is returned.
	const gated = applyRelevanceGate(outcomes, probes);
	for (const [engine, reason] of Object.entries(gated.suspectEngines)) {
		const id = engine as EngineId;
		degraded[id] = reason;
		// A decoyed engine must not count toward the achieved mix.
		achieved[id] = 0;
	}

	return {
		outcomes,
		hits: gated.hits,
		targets: plan.targets,
		achieved,
		degraded,
		mixSummary: describeMix(achieved),
	};
}
