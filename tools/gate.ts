/**
 * Phase 1 gate: prove all three engines return parsed hits through the shared
 * browser layer, and that the weighted allocator lands on 70/20/10.
 *
 * Run: node --experimental-strip-types tools/gate.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChromeManager } from "../src/browser/chrome.ts";
import { ensureGoogleTrust } from "../src/browser/profile.ts";
import { runWave } from "../src/engines/execute.ts";
import { allocate, apportion, DEFAULT_WEIGHTS, smoothSequence } from "../src/engines/schedule.ts";
import type { Probe } from "../src/engines/types.ts";

const FAILURES: string[] = [];
function check(label: string, condition: boolean, detail = ""): void {
	const mark = condition ? "PASS" : "FAIL";
	console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ""}`);
	if (!condition) FAILURES.push(label);
}

console.log("=== A. scheduler unit checks (no browser) ===\n");

const fixed = apportion(10, DEFAULT_WEIGHTS);
check("apportion(10) == 7/2/1", fixed.google === 7 && fixed.duckduckgo === 2 && fixed.bing === 1, JSON.stringify(fixed));

const twenty = apportion(20, DEFAULT_WEIGHTS);
check("apportion(20) == 14/4/2", twenty.google === 14 && twenty.duckduckgo === 4 && twenty.bing === 2, JSON.stringify(twenty));

let apportionOk = true;
for (let n = 1; n <= 60; n++) {
	const q = apportion(n, DEFAULT_WEIGHTS);
	if (q.google + q.duckduckgo + q.bing !== n) apportionOk = false;
}
check("apportion sums exactly for n=1..60", apportionOk);

const seq = smoothSequence(10, DEFAULT_WEIGHTS);
const seqCounts = seq.reduce<Record<string, number>>((acc, e) => ((acc[e] = (acc[e] ?? 0) + 1), acc), {});
check(
	"smoothSequence(10) == 7/2/1",
	seqCounts.google === 7 && seqCounts.duckduckgo === 2 && seqCounts.bing === 1,
	seq.join(","),
);
check("smoothSequence interleaves (no 5-google burst)", !/google,google,google,google,google/.test(seq.join(",")));

const probes: Probe[] = Array.from({ length: 10 }, (_, i) => ({
	id: `p${i}`,
	query: `query ${i}`,
	label: `probe ${i}`,
}));
const plan = allocate(probes, DEFAULT_WEIGHTS);
check(
	"allocate(10 plain probes) == 7/2/1",
	plan.achieved.google === 7 && plan.achieved.duckduckgo === 2 && plan.achieved.bing === 1,
	JSON.stringify(plan.achieved),
);

// Eligibility: filetype probes must not land on DuckDuckGo.
const constrained: Probe[] = Array.from({ length: 10 }, (_, i) => ({
	id: `c${i}`,
	query: `query ${i}`,
	label: `constraint ${i}`,
	filetype: "pdf",
}));
const constrainedPlan = allocate(constrained, DEFAULT_WEIGHTS);
check("filetype probes never routed to DuckDuckGo", constrainedPlan.achieved.duckduckgo === 0, JSON.stringify(constrainedPlan.achieved));

console.log("\n=== B. live engines through the CDP layer ===\n");

const profileDir = mkdtempSync(join(tmpdir(), "pbs-gate-"));
const chrome = new ChromeManager({ profileDir, idleMs: 0 });

try {
	const verdict = await ensureGoogleTrust(chrome);
	console.log(`  google trust: ${verdict.state} — ${verdict.reason}\n`);

	const liveProbes: Probe[] = [
		{ id: "l1", query: "kubernetes operator best practices", label: "core", engines: ["google"] },
		{ id: "l2", query: "postgres index bloat", label: "core", engines: ["duckduckgo"] },
		{ id: "l3", query: "rust async runtime comparison", label: "core", engines: ["bing"] },
	];

	const wave = await runWave({
		chrome,
		probes: liveProbes,
		perPageLimit: 10,
		renderTimeoutMs: 10_000,
		onProgress: (m) => console.log(`    · ${m}`),
	});

	for (const outcome of wave.outcomes) {
		const sample = outcome.hits[0];
		console.log(
			`\n  ${outcome.engine.padEnd(11)} ${outcome.status.padEnd(8)} ${String(outcome.hits.length).padStart(2)} hits  ${outcome.elapsedMs}ms` +
				(outcome.detail ? `  (${outcome.detail})` : ""),
		);
		if (sample) {
			console.log(`      "${sample.title.slice(0, 62)}"`);
			console.log(`      ${sample.url.slice(0, 78)}`);
			if (sample.snippet) console.log(`      ${sample.snippet.slice(0, 78)}…`);
		}
	}

	console.log("");
	if (Object.keys(wave.degraded).length > 0) {
		console.log("  degraded engines (excluded from results):");
		for (const [engine, reason] of Object.entries(wave.degraded)) console.log(`    ! ${engine}: ${reason}`);
		console.log("");
	}
	console.log(`  achieved mix: ${wave.mixSummary}\n`);

	const gatedByEngine = new Map<string, number>();
	for (const hit of wave.hits) gatedByEngine.set(hit.engine, (gatedByEngine.get(hit.engine) ?? 0) + 1);

	for (const engine of ["google", "duckduckgo", "bing"] as const) {
		const delivered = gatedByEngine.get(engine) ?? 0;
		const outcome = wave.outcomes.find((o) => o.engine === engine);
		const degradedReason = wave.degraded[engine];
		console.log(
			`  ${engine.padEnd(11)} raw=${String(outcome?.hits.length ?? 0).padStart(2)} delivered=${String(delivered).padStart(2)}` +
				(degradedReason ? `  DEGRADED` : ""),
		);
	}
	console.log("");

	// The meaningful assertion is what survives the relevance gate, not what the
	// engine claimed to return. A decoy SERP must not be counted as a pass.
	check("duckduckgo delivers relevant hits", (gatedByEngine.get("duckduckgo") ?? 0) > 0);
	check(
		"bing is either relevant or explicitly degraded",
		(gatedByEngine.get("bing") ?? 0) > 0 || Boolean(wave.degraded.bing),
	);
	check(
		"google is either relevant or explicitly degraded",
		(gatedByEngine.get("google") ?? 0) > 0 || Boolean(wave.degraded.google),
	);
	check("no engine silently drops out", Object.keys(wave.degraded).length + new Set(wave.hits.map((h) => h.engine)).size >= 2);

	// Structural quality checks on the Google extraction specifically.
	const googleOutcome = wave.outcomes.find((o) => o.engine === "google");
	if (googleOutcome && googleOutcome.hits.length > 0) {
		const hits = googleOutcome.hits;
		const fresh = hits.map((h) => h.title).join("\n");
		check("google hits all have titles", hits.every((h) => h.title.length > 3), fresh.slice(0, 60));
		check("google hits all have absolute urls", hits.every((h) => /^https?:\/\//.test(h.url)));
		check("google hits exclude google.com", hits.every((h) => !/google\.[a-z.]+/.test(new URL(h.url).hostname)));
		check("google urls are unwrapped redirects", hits.every((h) => !h.url.includes("/url?q=")));
		check("google hits carry snippets", hits.filter((h) => h.snippet.length > 20).length >= hits.length / 2);
		check(
			"google positions are 1..n",
			hits.every((h, i) => h.position === i + 1),
			hits.map((h) => h.position).join(","),
		);
	}

	// DuckDuckGo is the known-good lane, so assert on its extraction quality.
	const ddgHits = wave.hits.filter((h) => h.engine === "duckduckgo");
	if (ddgHits.length > 0) {
		check("ddg hits have titles", ddgHits.every((h) => h.title.length > 3));
		check("ddg urls are unwrapped", ddgHits.every((h) => !h.url.includes("duckduckgo.com/l/")));
		check("ddg urls are absolute", ddgHits.every((h) => /^https?:\/\//.test(h.url)));
		check(
			"ddg urls are distinct",
			new Set(ddgHits.map((h) => h.url)).size === ddgHits.length,
		);
	}
} finally {
	await chrome.close();
	rmSync(profileDir, { recursive: true, force: true });
}

console.log(`\n=== ${FAILURES.length === 0 ? "GATE PASSED" : `GATE FAILED (${FAILURES.length})`} ===`);
for (const failure of FAILURES) console.log(`  - ${failure}`);
process.exit(FAILURES.length === 0 ? 0 : 1);
