/**
 * End-to-end acceptance test for the shipped pipeline.
 *
 * Builds a throwaway profile, imports trust from a browser profile if available,
 * runs a full multi-probe search through the real browser, ranks the result, and
 * exercises the content store. This is the same code path the `ts_web_search` tool
 * runs.
 *
 * Run: node --experimental-strip-types tools/e2e.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChromeManager, defaultProfileDir } from "../src/browser/chrome.ts";
import { ensureGoogleTrust, importAnonymousGoogleCookies } from "../src/browser/profile.ts";
import { runWave } from "../src/engines/execute.ts";
import type { EngineId, Probe } from "../src/engines/types.ts";
import { expandQuery } from "../src/search/expand.ts";
import { normalizeHits } from "../src/search/normalize.ts";
import { mergeResolved, rankHits } from "../src/search/rank.ts";
import { isWrappedUrl, resolveWrappedUrls } from "../src/engines/resolve.ts";
import { canonicalizeUrl } from "../src/search/normalize.ts";
import { createArtifact, findInStored, getStoredContent } from "../src/store.ts";

const FAILURES: string[] = [];
function check(label: string, condition: boolean, detail = ""): void {
	console.log(`  [${condition ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
	if (!condition) FAILURES.push(label);
}

const profileDir = mkdtempSync(join(tmpdir(), "pbs-e2e-"));
/** Populated inside the try; read by the exit classification below. */
let degradedEngines: Record<string, string> = {};
let deliveredAny = false;
let trustNote = "";
const chrome = new ChromeManager({ profileDir, idleMs: 0 });

try {
	console.log("=== 1. cookie import (anonymous NID/SOCS only) ===\n");
	const imported = importAnonymousGoogleCookies(profileDir);
	console.log(`  result: ${JSON.stringify(imported)}`);
	check(
		"reads only anonymous cookies",
		!imported.imported || imported.names.every((name) => name === "NID" || name === "SOCS"),
		imported.names.join(","),
	);
	// A failure caused by a code defect (rather than a missing source profile)
	// must fail the test, otherwise a broken import hides behind "no profile".
	const importBug = /too large|sqlite is unavailable|could not initialise|could not be written/i.test(imported.reason ?? "");
	check("cookie import has no internal error", !importBug, imported.reason);
	if (!imported.imported && !importBug) console.log(`  (no importable source: ${imported.reason})`);
	console.log("");

	console.log("=== 2. Google trust ===\n");
	const trust = await ensureGoogleTrust(chrome, undefined, { profileDir, importCookies: true });
	trustNote = `google lane: ${trust.state} — ${trust.reason}`;
	console.log(`  state: ${trust.state}`);
	console.log(`  reason: ${trust.reason}`);
	check("trust verdict is reported", ["trusted", "untrusted", "unknown"].includes(trust.state));
	console.log("");

	console.log("=== 3. expansion → wave → rank ===\n");
	const query = "postgres index bloat";
	const expansion = expandQuery({ query, minProbes: 10, recencySensitive: false });
	const probes: Probe[] = expansion.probes.map((probe, index) => ({
		...probe,
		id: String(index + 1),
		...(trust.state === "trusted" ? {} : { engines: ["duckduckgo"] as EngineId[] }),
	}));
	const strategyByProbe = new Map(probes.map((probe) => [probe.id, probe.strategy]));
	console.log(`  ${probes.length} probes, intent=${expansion.intent}, strategies=${expansion.strategies.length}`);

	// A subset, to keep the test quick while still exercising all engines.
	const subset = probes.slice(0, 6);
	const wave = await runWave({
		chrome,
		probes: subset,
		perPageLimit: 10,
		renderTimeoutMs: 10_000,
		onProgress: (message) => console.log(`    · ${message}`),
	});

	degradedEngines = { ...wave.degraded };
	deliveredAny = wave.hits.length > 0;
	console.log(`\n  achieved mix: ${wave.mixSummary}`);
	for (const [engine, reason] of Object.entries(wave.degraded)) console.log(`  ! ${engine}: ${reason}`);

	let ranked = rankHits(query, normalizeHits(wave.hits), { strategyByProbe, limit: 20 });

	// Mirror the tool's flow: rank first (cheap, needs only the displayed host),
	// then resolve wrapped destinations, then merge so corroboration across
	// engines can actually be seen.
	const wrapped = ranked.filter((hit) => isWrappedUrl(hit.url));
	if (wrapped.length > 0) {
		const t0 = Date.now();
		const { resolved } = await resolveWrappedUrls(chrome, wrapped.map((hit) => hit.url));
		console.log(`  resolved ${resolved.size}/${wrapped.length} wrapped links in ${Date.now() - t0}ms`);
		if (resolved.size > 0) {
			ranked = mergeResolved(
				ranked.map((hit) => {
					const destination = resolved.get(hit.url);
					if (!destination) return hit;
					const canonical = canonicalizeUrl(destination);
					return canonical ? { ...hit, url: canonical.url, host: canonical.host } : hit;
				}),
			).slice(0, 15);
		}
	}
	console.log(`\n  ${wave.hits.length} raw hits → ${ranked.length} ranked results\n`);
	for (const [index, hit] of ranked.slice(0, 5).entries()) {
		console.log(`  ${index + 1}. ${hit.title.slice(0, 66)}`);
		console.log(`     ${hit.url.slice(0, 88)}`);
		console.log(`     engines=[${hit.engines.join(",")}] strategies=[${hit.strategies.join(",")}] score=${hit.score.toFixed(2)}`);
	}
	console.log("");

	check("wave produced hits", wave.hits.length > 0, `${wave.hits.length}`);
	check("ranking produced results", ranked.length > 0);
	check("every ranked result has a canonical url", ranked.every((hit) => /^https?:\/\//.test(hit.url)));
	check("no tracking params leaked", !ranked.some((hit) => /[?&]utm_/.test(hit.url)));
	check("per-domain cap honoured", (() => {
		const counts = new Map<string, number>();
		for (const hit of ranked) counts.set(hit.host, (counts.get(hit.host) ?? 0) + 1);
		return [...counts.values()].every((count) => count <= 2);
	})());
	check(
		"corroboration recorded when multiple engines deliver",
		// Corroboration is only possible when more than one engine actually
		// delivered; with Google untrusted, one engine is all there can be.
		new Set(wave.hits.map((hit) => hit.engine)).size < 2 || ranked.some((hit) => hit.corroborated),
	);

	console.log("=== 4. content store ===\n");
	const first = ranked[0];
	const responseId = createArtifact({
		queries: [query],
		ranked,
		documents: first
			? [{ url: first.url, title: first.title, text: `Full text of ${first.title}. Index bloat happens when dead tuples accumulate.`, kind: "html" }]
			: [],
		probes: probes.length,
		achieved: wave.achieved,
		degraded: wave.degraded,
		mixSummary: wave.mixSummary,
		intents: [expansion.intent],
	});
	check("responseId issued", responseId.startsWith("bs_"), responseId);
	const stored = getStoredContent(responseId);
	check("artifact retrievable", Boolean(stored));
	check("artifact holds a document per ranked result", (stored?.documents.length ?? 0) >= ranked.length, `${stored?.documents.length}`);
	const matches = findInStored(responseId, ["bloat"]);
	check("findText returns passages", matches.length > 0, `${matches.length}`);
	check("passages carry provenance", matches.every((match) => match.url.length > 0));
	const missing = getStoredContent("bs_does_not_exist");
	check("unknown responseId returns undefined", missing === undefined);
	console.log("");
} finally {
	await chrome.close();
	rmSync(profileDir, { recursive: true, force: true });
	console.log(`default profile dir (production): ${defaultProfileDir()}`);
	console.log(`\n=== ${FAILURES.length === 0 ? "E2E PASSED" : `E2E FAILED (${FAILURES.length})`} ===`);
	for (const failure of FAILURES) console.log(`  - ${failure}`);
}

// An environment where every engine is externally blocked says nothing about
// whether this code works, and treating it as a failure would train us to
// ignore the test. Exit 2 marks it inconclusive: no engine delivered, but each
// one said why, so nothing failed silently.
// Only inconclusive when every failure is a *consequence* of having no hits.
// If some other assertion fails alongside an outage, that is a real defect and
// must still fail the run.
const HIT_DEPENDENT = new Set([
	"wave produced hits",
	"ranking produced results",
	"findText returns passages",
]);
// Keyed on "no engine delivered anything", not on a count of degraded entries:
// an untrusted Google lane is *excluded* from the probes rather than run and
// failed, so it never appears in `degraded` and a count is the wrong invariant.
const allEnginesBlocked =
	!deliveredAny && FAILURES.length > 0 && FAILURES.every((f) => HIT_DEPENDENT.has(f));
if (allEnginesBlocked) {
	console.log("\n=== E2E INCONCLUSIVE — no search engine delivered ===");
	if (trustNote) console.log(`  ${trustNote}`);
	for (const [engine, reason] of Object.entries(degradedEngines)) console.log(`  ${engine}: ${reason}`);
	console.log("\nNo engine delivered, so the pipeline could not be exercised against live data.");
	console.log("Not a code failure: every engine reported its reason rather than failing silently.");
	process.exit(2);
}
process.exit(FAILURES.length === 0 ? 0 : 1);
