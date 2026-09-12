/**
 * Pure-logic unit tests: expansion, normalisation, ranking.
 * No browser required — safe to run while the host is loaded.
 *
 * Run: node --experimental-strip-types tools/unit.ts
 */

import { canonicalizeUrl, cleanText, normalizeHits } from "../src/search/normalize.ts";
import { contentWords, detectIntent, expandQuery } from "../src/search/expand.ts";
import { rankHits } from "../src/search/rank.ts";
import { queryTerms, scoreHit } from "../src/search/relevance.ts";
import type { RawHit } from "../src/engines/types.ts";

const FAILURES: string[] = [];
let checks = 0;
function check(label: string, condition: boolean, detail = ""): void {
	checks += 1;
	if (!condition) {
		FAILURES.push(label);
		console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
	}
}
function eq<T>(label: string, actual: T, expected: T): void {
	check(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}

console.log("=== expansion ===");
{
	const result = expandQuery({ query: "kubernetes operator best practices" });
	check("generates at least 10 probes", result.probes.length >= 10, `${result.probes.length}`);
	check("probe ids are unique", new Set(result.probes.map((p) => p.id)).size === result.probes.length);
	check("first probe is verbatim", result.probes[0].query === "kubernetes operator best practices");
	check("all probes non-empty", result.probes.every((p) => p.query.trim().length > 0));
	check(
		"strategies span several kinds",
		new Set(result.probes.map((p) => p.strategy)).size >= 5,
		[...new Set(result.probes.map((p) => p.strategy))].join(","),
	);
	check("no duplicate retrieval fingerprints", (() => {
		const keys = result.probes.map((p) => contentWords(p.query).sort().join(" ") + (p.site ?? ""));
		return new Set(keys).size === keys.length;
	})());
	eq("detects howto intent", detectIntent("how to configure nginx"), "howto");
	eq("detects comparison intent", detectIntent("rust vs go performance"), "comparison");
	eq("detects troubleshooting intent", detectIntent("postgres error connection refused"), "troubleshooting");
	eq("detects reference intent", detectIntent("react api documentation"), "reference");
	eq("defaults to general", detectIntent("kubernetes operator"), "general");

	const fifteen = expandQuery({ query: "postgres index bloat", minProbes: 15 });
	check("respects minProbes=15", fifteen.probes.length >= 15, `${fifteen.probes.length}`);

	const scoped = expandQuery({ query: "rust async", sites: ["github.com", "tokio.rs"] });
	check("site-scoped probes carry the site", scoped.probes.some((p) => p.site === "github.com"));
	check("site-scoped strategy present", scoped.probes.some((p) => p.strategy === "site-scoped"));

	const typed = expandQuery({ query: "spec", filetype: "pdf" });
	check("filetype propagates to probes", typed.probes.every((p) => p.filetype === "pdf"));
}

console.log("=== normalisation ===");
{
	eq("strips utm params", canonicalizeUrl("https://example.com/a?utm_source=x&utm_medium=y")?.url, "https://example.com/a");
	eq("strips fragment via path handling", canonicalizeUrl("https://example.com/a#frag")?.url, "https://example.com/a");
	eq("drops www", canonicalizeUrl("https://www.example.com/x")?.host, "example.com");
	eq("strips trailing slash", canonicalizeUrl("https://example.com/x/")?.url, "https://example.com/x");
	eq("strips index.html", canonicalizeUrl("https://example.com/docs/index.html")?.url, "https://example.com/docs");
	eq("keeps meaningful params", canonicalizeUrl("https://www.youtube.com/watch?v=abc123")?.url, "https://youtube.com/watch?v=abc123");
	eq("drops empty params", canonicalizeUrl("https://example.com/a?x=")?.url, "https://example.com/a");
	eq("rejects non-http", canonicalizeUrl("mailto:a@b.com"), undefined);
	eq("rejects garbage", canonicalizeUrl("not a url"), undefined);

	// www and bare host must share an identity key.
	const a = canonicalizeUrl("https://www.example.com/docs/page")?.key;
	const b = canonicalizeUrl("https://example.com/docs/page/")?.key;
	eq("www and bare host share a key", a, b);

	eq("cleanText decodes entities", cleanText("a &amp; b&nbsp;c"), "a & b c");
	eq("cleanText collapses whitespace", cleanText("a\n\n  b"), "a b");

	const raw: RawHit[] = [
		{ title: "Good", url: "https://example.com/a?utm_source=q", snippet: "s", position: 1, engine: "google", probeId: "p1" },
		{ title: "x", url: "https://example.com/b", snippet: "s", position: 2, engine: "google", probeId: "p1" },
		{ title: "Ok", url: "https://example.com/c", snippet: "s", position: 3, engine: "google", probeId: "p1" },
	];
	const normalized = normalizeHits(raw);
	// "x" (1 char) and "Ok" (2 chars) are both below the 3-character floor.
	eq("drops titles shorter than 3 chars", normalized.length, 1);
	check("normalised hit url is canonical", normalized[0].url === "https://example.com/a", normalized[0]?.url);
	check("no tracking params survive normalisation", !normalized.some((h) => h.url.includes("utm_")));
}

console.log("=== ranking ===");
{
	const mk = (
		url: string,
		engine: RawHit["engine"],
		position: number,
		probeId = "p1",
		title = "Postgres index bloat explained",
		snippet = "index bloat in postgres",
	): RawHit => ({ title, url, snippet, position, engine, probeId });

	// A result found by two independent engines must outrank a rank-1 result
	// from a single engine.
	const hits = normalizeHits([
		mk("https://single.example.com/x", "google", 1, "p1", "Unrelated page", "nothing relevant"),
		mk("https://wiki.example.org/bloat", "google", 3, "p1"),
		mk("https://wiki.example.org/bloat", "duckduckgo", 2, "p2"),
	]);
	const ranked = rankHits("postgres index bloat", hits, {
		strategyByProbe: new Map([["p1", "verbatim"], ["p2", "practical"]]),
	});
	eq("corroborated result ranks first", ranked[0].host, "wiki.example.org");
	check("corroborated flag set", ranked[0].corroborated);
	eq("engines deduplicated", ranked[0].engines.sort(), ["duckduckgo", "google"]);
	eq("strategies deduplicated", ranked[0].strategies.sort(), ["practical", "verbatim"]);
	eq("occurrences recorded", ranked[0].occurrences.length, 2);

	// Duplicate near-identical URLs must collapse to one entry.
	const dupes = normalizeHits([
		mk("https://example.com/page", "google", 1),
		mk("https://www.example.com/page/", "duckduckgo", 1),
		mk("https://example.com/page?utm_source=x", "bing", 1),
	]);
	const deduped = rankHits("postgres index bloat", dupes);
	eq("url variants collapse to one result", deduped.length, 1);
	eq("all three engines counted", deduped[0].engines.length, 3);

	// Per-domain cap.
	const many = normalizeHits(
		Array.from({ length: 6 }, (_, i) => mk(`https://one.example.com/p${i}`, "google", i + 1)),
	);
	const capped = rankHits("postgres index bloat", many, { maxPerDomain: 2 });
	eq("per-domain cap honoured", capped.length, 2);

	// Determinism.
	const again = rankHits("postgres index bloat", normalizeHits([
		mk("https://single.example.com/x", "google", 1, "p1", "Unrelated page", "nothing relevant"),
		mk("https://wiki.example.org/bloat", "google", 3, "p1"),
		mk("https://wiki.example.org/bloat", "duckduckgo", 2, "p2"),
	]), { strategyByProbe: new Map([["p1", "verbatim"], ["p2", "practical"]]) });
	eq("ranking is deterministic", again.map((r) => r.url), ranked.map((r) => r.url));

	// limit respected.
	check("limit respected", rankHits("x", many, { limit: 3 }).length <= 3);
}

console.log("=== relevance gate ===");
{
	const terms = queryTerms("postgres index bloat");
	check("queryTerms drops stopwords", !terms.includes("the") && terms.includes("postgres"), terms.join(","));

	const onTopic: RawHit = {
		title: "Understanding Postgres index bloat",
		url: "https://wiki.postgresql.org/wiki/Index_Maintenance",
		snippet: "how index bloat happens",
		position: 1, engine: "google", probeId: "p1",
	};
	const offTopic: RawHit = {
		title: "Frasi di auguri di buon onomastico",
		url: "https://www.frasimania.it/frasi-buon-onomastico/",
		snippet: "immagini di auguri",
		position: 1, engine: "bing", probeId: "p1",
	};
	check("on-topic hit passes", scoreHit(onTopic, terms).relevant);
	check("off-topic hit fails", !scoreHit(offTopic, terms).relevant);
	check("on-topic coverage exceeds off-topic", scoreHit(onTopic, terms).coverage > scoreHit(offTopic, terms).coverage);
}

console.log(`\n=== ${FAILURES.length === 0 ? `UNIT PASSED (${checks} checks)` : `UNIT FAILED (${FAILURES.length}/${checks})`} ===`);
for (const failure of FAILURES) console.log(`  - ${failure}`);
process.exit(FAILURES.length === 0 ? 0 : 1);
