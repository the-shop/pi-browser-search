/**
 * pi-browser-search — headless-browser web search for the pi coding agent.
 *
 * Registers `ts_web_search`, `ts_fetch_content` and `ts_get_search_content`. All three
 * go through a real Chrome over CDP rather than HTTP APIs, so there are no keys
 * to configure and JS-rendered pages are readable.
 *
 * Design commitments worth knowing before reading the code:
 *
 *  - **At least 10 probes per search**, drawn from orthogonal strategies, with a
 *    second wave when precision is weak.
 *  - **Engine mix is reported as achieved, never as requested.** Google needs a
 *    trusted cookie pair (imported once, anonymous cookies only), so the mix
 *    varies. Every response says what actually happened and names any engine
 *    that dropped out.
 *  - **A failed engine is never silently absorbed.** Decoy output is detected by
 *    query-term coverage and excluded, so a plausible-looking but unrelated SERP
 *    cannot pollute results.
 *
 * Chrome is started lazily on first use and reaped when idle; nothing runs at
 * extension load, per the pi extension contract.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { rmSync } from "node:fs";
import { Type } from "typebox";
import { ChromeManager, defaultProfileDir, processProfileDir, pruneStaleProfiles } from "./src/browser/chrome.ts";
import {
	ensureGoogleTrust,
	hasProfileGoogleCookies,
	importAnonymousGoogleCookies,
	resetTrustCache,
} from "./src/browser/profile.ts";
import { fetchPage } from "./src/content/extract.ts";
import { canonicalizeUrl } from "./src/search/normalize.ts";
import { runWave } from "./src/engines/execute.ts";
import { isWrappedUrl, resolveWrappedUrls } from "./src/engines/resolve.ts";
import type { EngineId, Probe, RawHit } from "./src/engines/types.ts";
import { expandQuery } from "./src/search/expand.ts";
import { normalizeHits } from "./src/search/normalize.ts";
import { mergeResolved, rankHits, type RankedHit } from "./src/search/rank.ts";
import { createArtifact, findInStored, getStoredContent, type StoredDocument } from "./src/store.ts";

const DEFAULT_PROBES = 10;
const DEFAULT_RESULTS = 20;
const ENRICH_TOP = 3;

let chrome: ChromeManager | undefined;

function getChrome(): ChromeManager {
	if (!chrome) {
		// Each process gets its own browser profile. A shared one meant concurrent
		// subagent runs opened the same user-data-dir and fought over it, logging
		// "Chrome exited immediately after launch" repeatedly and pointing two
		// Chrome instances at one SQLite cookie store.
		//
		// Nothing in the working profile needs to be shared — cache, history and
		// GPU state are disposable. The only irreplaceable content is the two
		// anonymous Google cookies, so those are copied across on first use.
		const working = processProfileDir();
		try {
			pruneStaleProfiles();
			if (!hasProfileGoogleCookies(working)) {
				importAnonymousGoogleCookies(working, defaultProfileDir());
			}
		} catch {
			// Seeding is best-effort: without it the Google lane degrades and every
			// other engine still works, which the search reports honestly.
		}
		chrome = new ChromeManager({
			profileDir: working,
			idleMs: 5 * 60 * 1000,
			onExit: () => {
				// A crash invalidates the cached trust verdict.
				resetTrustCache();
			},
		});
	}
	return chrome;
}

export default function (pi: ExtensionAPI) {
	// --- ts_web_search ---------------------------------------------------------
	pi.registerTool({
		name: "ts_web_search",
		label: "Web Search",
		description:
			"Search the web with a headless browser across Google and DuckDuckGo. Each call fans out into at least 10 probes drawn from different strategies (verbatim, quoted, intent-shaped, site-scoped, recency, terminology) and merges the results, ranking them primarily by cross-engine corroboration. " +
			"No API keys required. Pass `query` for a single search or `queries` for several theme-related searches run together. " +
			"The response always states the engine mix actually achieved; if an engine is blocked or returns unrelated results it is named and excluded rather than silently dropped. " +
			"Use `depth: \"deep\"` when precision matters more than latency — it adds a second wave of probes plus page-2 results.",
		promptSnippet:
			"Search the web via headless browser (Google/DuckDuckGo). At least 10 probes per call; prefer {queries:[...]} with 2-4 related angles for research. Reports the engine mix actually achieved.",
		promptGuidelines: [
			"Use ts_web_search for web research questions instead of ts_fetch_content when you do not yet know the URL.",
			"Prefer ts_web_search with {queries:[...]} containing 2-4 related angles over repeated single-query calls; each call already fans out internally, so repetition adds little.",
			"Use ts_web_search depth:\"deep\" when the user needs a thorough answer; it costs more time but adds a second probe wave and page-2 results.",
			"When ts_web_search reports a degraded engine, do not assume the results cover that engine's index; say so if the distinction matters to the answer.",
			"Use ts_get_search_content with the responseId from a ts_web_search result to read the full text of a source it returned.",
		],
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "A single search query." })),
			queries: Type.Optional(
				Type.Array(Type.String(), {
					description: "Several related queries to run together (2-4 recommended), each fanned out into probes.",
				}),
			),
			numResults: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 50, description: `Results to return (default: ${DEFAULT_RESULTS}).` }),
			),
			depth: Type.Optional(
				Type.Union([Type.Literal("normal"), Type.Literal("deep")], {
					description: "normal (default) runs one probe wave; deep adds a second wave plus page-2 results.",
				}),
			),
			recency: Type.Optional(
				Type.Boolean({ description: "Bias probes and ranking toward the last year of content." }),
			),
			sites: Type.Optional(
				Type.Array(Type.String(), {
					description: "Domains to mine directly with site: probes, e.g. [\"github.com\", \"stackoverflow.com\"].",
				}),
			),
			includeContent: Type.Optional(
				Type.Boolean({ description: `Fetch and store the full text of the top ${ENRICH_TOP} results (default: false).` }),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const queries = collectQueries(params.query, params.queries);
			if (queries.length === 0) {
				throw new Error("ts_web_search requires either `query` or `queries`.");
			}

			const numResults = params.numResults ?? DEFAULT_RESULTS;
			const deep = params.depth === "deep";
			const recencySensitive = params.recency === true || /\b(latest|newest|20\d\d|news|current)\b/i.test(queries.join(" "));
			const browser = getChrome();

			onUpdate?.({ content: [{ type: "text", text: "Starting browser…" }] });

			// Establish Google trust before the wave so the mix is known up front.
			const trust = await ensureGoogleTrust(browser, signal, {
				profileDir: processProfileDir(),
				importCookies: true,
				sourceProfileDir: defaultProfileDir(),
			});

			const planned: Probe[] = [];
			const strategyByProbe = new Map<string, string>();
			const intentByQuery: string[] = [];
			for (const query of queries) {
				const expansion = expandQuery({
					query,
					minProbes: deep ? 14 : DEFAULT_PROBES,
					sites: params.sites,
					recencySensitive,
				});
				intentByQuery.push(expansion.intent);
				for (const probe of expansion.probes) {
					// Namespace probe ids so several queries can share one wave
					// without their provenance colliding.
					const id = `${planned.length + 1}`;
					planned.push({ ...probe, id });
					strategyByProbe.set(id, probe.strategy);
				}
			}

			// Google is the scarce lane; skip it entirely when it is not trusted,
			// so its quota is not wasted on guaranteed failures.
			const probes = planned.map((probe) =>
				trust.state === "trusted" ? probe : { ...probe, engines: (["duckduckgo"] as EngineId[]) },
			);

			const progress: string[] = [];
			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Running ${probes.length} probes (${queries.length} ${queries.length === 1 ? "query" : "queries"})…`,
					},
				],
			});

			let wave = await runWave({
				chrome: browser,
				probes,
				perPageLimit: Math.min(20, Math.max(10, Math.ceil(numResults / 2))),
				renderTimeoutMs: 9_000,
				signal,
				onProgress: (message) => {
					progress.push(message);
					onUpdate?.({
						content: [{ type: "text", text: `${message}\n(${progress.length} updates)` }],
					});
				},
			});

			// Second wave: page 2 of the strongest domains, when precision matters.
			if (deep && !signal?.aborted) {
				const topHosts = topHostsFrom(wave.hits, 3);
				const followUps: Probe[] = topHosts.map((host, index) => ({
					id: `deep${index + 1}`,
					query: queries[0],
					label: `page2:${host}`,
					site: host,
					engines: trust.state === "trusted" ? undefined : (["duckduckgo"] as EngineId[]),
				}));
				if (followUps.length > 0) {
					onUpdate?.({ content: [{ type: "text", text: `Deepening into ${topHosts.join(", ")}…` }] });
					const second = await runWave({
						chrome: browser,
						probes: followUps,
						perPageLimit: 15,
						renderTimeoutMs: 9_000,
						signal,
						onProgress: (message) => progress.push(message),
					});
					wave = {
						...wave,
						hits: [...wave.hits, ...second.hits],
						outcomes: [...wave.outcomes, ...second.outcomes],
						degraded: { ...wave.degraded, ...second.degraded },
					};
					for (const probe of followUps) strategyByProbe.set(probe.id, "site-scoped");
				}
			}

			const normalized = normalizeHits(wave.hits);
			let ranked = rankHits(queries[0], normalized, {
				limit: numResults,
				strategyByProbe,
				recencySensitive,
				maxPerDomain: numResults > 20 ? 3 : 2,
			});

			// Google wraps outbound links in an opaque encrypted redirect, so the
			// winners are followed to their real destinations now — after ranking,
			// because resolving every hit in a 10-probe wave would cost more than the
			// search itself.
			const wrapped = ranked.filter((hit) => isWrappedUrl(hit.url));
			if (wrapped.length > 0) {
				onUpdate?.({
					content: [{ type: "text", text: `Resolving ${wrapped.length} wrapped result links…` }],
				});
				const { resolved, unresolved } = await resolveWrappedUrls(
					browser,
					wrapped.map((hit) => hit.url),
					{ signal, onProgress: (message) => progress.push(message) },
				);
				if (resolved.size > 0) {
					const withDestinations = ranked.map((hit) => {
						const destination = resolved.get(hit.url);
						if (!destination) return hit;
						const canonical = canonicalizeUrl(destination);
						if (!canonical) return hit;
						return { ...hit, url: canonical.url, host: canonical.host };
					});
					// Now that wrapped and direct links share a real URL, combine the
					// evidence: two engines agreeing is the strongest signal available and
					// is invisible until destinations are known.
					ranked = mergeResolved(withDestinations).slice(0, numResults);
				}
				if (unresolved.length > 0) {
					progress.push(`${unresolved.length} wrapped link(s) could not be resolved`);
				}
			}

			// Optionally pull full text for the strongest few, so the model gets
			// substance rather than a snippet.
			const documents: StoredDocument[] = [];
			if (params.includeContent && ranked.length > 0) {
				onUpdate?.({ content: [{ type: "text", text: `Reading top ${Math.min(ENRICH_TOP, ranked.length)} sources…` }] });
				for (const hit of ranked.slice(0, ENRICH_TOP)) {
					try {
						const page = await fetchPage(browser, hit.url, { signal, maxChars: 8_000 });
						// Enrichment exists to give the model substance; boilerplate is not
						// substance, so a suspect page is skipped rather than included.
						if (page.text && !page.suspect) {
							documents.push({ url: page.url, title: page.title || hit.title, text: page.text, kind: page.kind });
						}
					} catch {
						// Enrichment is best-effort; a failed fetch must not lose the search.
					}
				}
			}

			const responseId = createArtifact({
				queries,
				ranked,
				documents,
				probes: probes.length,
				achieved: wave.achieved,
				degraded: wave.degraded,
				mixSummary: wave.mixSummary,
				intents: intentByQuery,
			});

			const enrichment = new Map(documents.filter((doc) => doc.kind !== "snippet").map((doc) => [doc.url, doc.text]));

			const text = renderSearch({
				queries,
				ranked,
				responseId,
				mixSummary: wave.mixSummary,
				degraded: wave.degraded,
				trust,
				probeCount: probes.length,
				deep,
				enrichment,
			});

			return {
				content: [{ type: "text", text }],
				details: {
					responseId,
					probes: probes.length,
					queries,
					engines: wave.achieved,
					degraded: wave.degraded,
					results: ranked.map((hit) => ({
						title: hit.title,
						url: hit.url,
						engines: hit.engines,
						strategies: hit.strategies,
					})),
				},
			};
		},
	});

	// --- ts_fetch_content ------------------------------------------------------
	pi.registerTool({
		name: "ts_fetch_content",
		label: "Fetch Content",
		description:
			"Fetch a URL with a headless browser and return readable text. Unlike a plain HTTP fetch this executes JavaScript, so client-rendered pages, documentation sites and lazy-loaded articles are readable. " +
			"Preserves headings, lists, code blocks and link targets. Use `prompt` to ask a question answered only from the fetched page.",
		promptSnippet: "Fetch a URL via headless browser and return readable text (JS-rendered pages included).",
		promptGuidelines: [
			"Use ts_fetch_content when you already have a URL; use ts_web_search when you do not.",
			"Use ts_fetch_content prompt:\"...\" to get an answer grounded only in the fetched page rather than the whole text.",
		],
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "URL to fetch." })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Several URLs to fetch." })),
			prompt: Type.Optional(
				Type.String({ description: "A question to answer using only the fetched content." }),
			),
			maxChars: Type.Optional(
				Type.Integer({ minimum: 500, maximum: 200_000, description: "Character budget per page (default: 30000)." }),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const urls = [...(params.url ? [params.url] : []), ...(params.urls ?? [])].filter(Boolean);
			if (urls.length === 0) throw new Error("ts_fetch_content requires `url` or `urls`.");

			const browser = getChrome();
			const maxChars = params.maxChars ?? 30_000;
			const results: Array<{ url: string; title: string; text: string; kind: string; note?: string; suspect?: string }> = [];
			const documents: StoredDocument[] = [];

			for (const [index, url] of urls.entries()) {
				onUpdate?.({ content: [{ type: "text", text: `Fetching ${url} (${index + 1}/${urls.length})…` }] });
				try {
					const page = await fetchPage(browser, url, { signal, maxChars });
					// A suspect extraction is not content; keep it out of the store so
					// ts_get_search_content cannot later hand back a consent dialog.
					if (page.text && !page.suspect) {
						documents.push({ url: page.url, title: page.title, text: page.text, kind: page.kind });
					}
					results.push({
						url: page.url,
						title: page.title,
						text: page.text,
						kind: page.kind,
						...(page.fallback ? { note: page.fallback } : {}),
						...(page.suspect ? { suspect: page.suspect } : {}),
					});
				} catch (error) {
					results.push({
						url,
						title: "",
						text: "",
						kind: "error",
						note: error instanceof Error ? error.message : String(error),
					});
				}
			}

			const responseId = createArtifact({
				queries: urls,
				ranked: results.map((result) => ({
					title: result.title,
					url: result.url,
					host: safeHost(result.url),
					snippet: result.text.slice(0, 200),
					score: 0,
					engines: [],
					strategies: [],
					bestPosition: 0,
					occurrences: [],
					corroborated: false,
				})),
				documents,
				probes: urls.length,
				achieved: { google: 0, duckduckgo: 0 },
				degraded: {},
				mixSummary: "direct fetch",
				intents: [],
			});

			const text = results
				.map((result, index) => {
					const header = `## ${index + 1}. ${result.title || result.url}`;
					const meta = `${result.url}${result.kind !== "html" ? ` · ${result.kind}` : ""}`;
					if (!result.text) {
						return `${header}\n${meta}\n\n[failed: ${result.note ?? "no content"}]`;
					}
					if (result.suspect) {
						// Never present boilerplate as page content. The earlier version
						// returned a cookie dialog as a successful extraction, which is worse
						// than an error because nothing in the output showed it.
						return `${header}\n${meta}\n\n[EXTRACTION SUSPECT: ${result.suspect}]\nThis page did not yield readable content — most likely a cookie-consent or login overlay, or content rendered only after interaction. Do not treat the text below as the page content.\n\n--- raw extraction (unverified) ---\n${result.text.slice(0, 800)}`;
					}
					return `${header}\n${meta}\n${result.note ? `(!) ${result.note}\n` : ""}\n${result.text}`;
				})
				.join("\n\n---\n\n");

			return {
				content: [{ type: "text", text: `${text}\n\n[responseId: ${responseId}]` }],
				details: { responseId, urls: results.map((r) => r.url) },
			};
		},
	});

	// --- ts_get_search_content -------------------------------------------------
	pi.registerTool({
		name: "ts_get_search_content",
		label: "Get Search Content",
		description:
			"Retrieve stored content from an earlier ts_web_search or ts_fetch_content response in this session, by responseId. " +
			"Optionally narrow to one URL, or search inside the content with findText to pull just the relevant passages.",
		promptSnippet: "Read stored full content from a previous ts_web_search or ts_fetch_content result by responseId.",
		parameters: Type.Object({
			responseId: Type.String({ description: "The responseId reported by ts_web_search or ts_fetch_content." }),
			url: Type.Optional(Type.String({ description: "Return only this URL's stored content." })),
			urlIndex: Type.Optional(Type.Integer({ minimum: 0, description: "Return only the URL at this index." })),
			findText: Type.Optional(
				Type.Union([Type.String(), Type.Array(Type.String())], {
					description: "Return only passages containing this text (or any of these texts).",
				}),
			),
		}),

		async execute(_toolCallId, params) {
			const stored = getStoredContent(params.responseId);
			if (!stored) {
				throw new Error(
					`No stored content for responseId "${params.responseId}". It may be from a previous session; re-run the search.`,
				);
			}

			if (params.findText) {
				const needles = Array.isArray(params.findText) ? params.findText : [params.findText];
				const matches = findInStored(params.responseId, needles, params.url);
				if (matches.length === 0) {
					return {
						content: [{ type: "text", text: `No passages matched ${needles.map((n) => `"${n}"`).join(", ")}.` }],
						details: { responseId: params.responseId, matches: 0 },
					};
				}
				const text = matches
					.map((match) => `### ${match.title || match.url}\n${match.url}\n\n…${match.passage}…`)
					.join("\n\n");
				return {
					content: [{ type: "text", text }],
					details: { responseId: params.responseId, matches: matches.length },
				};
			}

			const documents = stored.documents;
			const selected =
				params.url !== undefined
					? documents.filter((doc) => doc.url === params.url)
					: params.urlIndex !== undefined
						? documents.slice(params.urlIndex, params.urlIndex + 1)
						: documents;

			if (selected.length === 0) {
				const available = documents.map((doc, index) => `${index}: ${doc.url}`).join("\n");
				throw new Error(`No stored document matched. Available:\n${available}`);
			}

			const text = selected
				.map((doc) => `## ${doc.title || doc.url}\n${doc.url}${doc.kind ? ` · ${doc.kind}` : ""}\n\n${doc.text}`)
				.join("\n\n---\n\n");

			return {
				content: [{ type: "text", text }],
				details: { responseId: params.responseId, documents: selected.length },
			};
		},
	});

	// --- lifecycle ----------------------------------------------------------
	pi.registerCommand("browser-search", {
		description: "Browser search status: Chrome state and Google lane trust (/browser-search reset to re-probe)",
		handler: async (args, ctx) => {
			if (args.trim() === "reset") {
				resetTrustCache();
				ctx.ui.notify("Google trust verdict cleared; it will be re-probed on the next search.", "info");
				return;
			}
			const running = chrome?.isRunning ? "running" : "not started";
			ctx.ui.notify(
				`Chrome: ${running}\nProfile: ${defaultProfileDir()}\nUse /browser-search reset to re-probe Google trust.`,
				"info",
			);
		},
	});

	pi.on("session_shutdown", async () => {
		await chrome?.close().catch(() => undefined);
		chrome = undefined;
		// The working profile is this process's own scratch space, so remove it
		// rather than leaving one directory behind per run.
		try {
			rmSync(processProfileDir(), { recursive: true, force: true });
		} catch {
			// Best-effort; pruneStaleProfiles() collects anything left over.
		}
	});
}

// --- helpers ---------------------------------------------------------------

function collectQueries(query?: string, queries?: string[]): string[] {
	const out: string[] = [];
	if (query?.trim()) out.push(query.trim());
	for (const entry of queries ?? []) {
		if (entry?.trim()) out.push(entry.trim());
	}
	return [...new Set(out)];
}

function topHostsFrom(hits: RawHit[], count: number): string[] {
	const scores = new Map<string, number>();
	for (const hit of hits) {
		const host = safeHost(hit.url);
		if (!host) continue;
		// Earlier positions count for more.
		scores.set(host, (scores.get(host) ?? 0) + 1 / Math.log2(hit.position + 1));
	}
	return [...scores.entries()]
		.filter(([host]) => !/(^|\.)(google|duckduckgo)\./.test(host))
		.sort((a, b) => b[1] - a[1])
		.slice(0, count)
		.map(([host]) => host);
}

function safeHost(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return "";
	}
}

interface RenderInput {
	queries: string[];
	ranked: RankedHit[];
	responseId: string;
	mixSummary: string;
	degraded: Partial<Record<EngineId, string>>;
	trust: { state: string; reason: string };
	probeCount: number;
	deep: boolean;
	enrichment: Map<string, string>;
}

function renderSearch(input: RenderInput): string {
	const { queries, ranked, responseId, mixSummary, degraded, trust, probeCount, deep, enrichment } = input;

	if (ranked.length === 0) {
		const reasons = Object.entries(degraded)
			.map(([engine, reason]) => `  - ${engine}: ${reason}`)
			.join("\n");
		return [
			`No results for ${queries.map((q) => `"${q}"`).join(", ")}.`,
			`Ran ${probeCount} probes. Engine mix achieved: ${mixSummary}.`,
			reasons ? `Engines that failed:\n${reasons}` : "",
			trust.state !== "trusted" ? `Google lane: ${trust.reason}` : "",
		]
			.filter(Boolean)
			.join("\n");
	}

	const lines: string[] = [];
	lines.push(`# Search results: ${queries.map((q) => `"${q}"`).join(" · ")}`);
	lines.push("");

	const dropped = Object.entries(degraded);
	if (dropped.length > 0) {
		lines.push("> **Engine coverage warning** — these engines did not contribute:");
		for (const [engine, reason] of dropped) lines.push(`> - **${engine}**: ${reason}`);
		lines.push(">");
		lines.push("> Results below cover only the remaining engines' indexes.");
		lines.push("");
	}

	for (const [index, hit] of ranked.entries()) {
		const corroboration = hit.corroborated
			? `${hit.engines.length} engines`
			: `${hit.engines[0] ?? "?"}`;
		const strategies = [...new Set(hit.strategies)].filter((s) => s !== "unknown").slice(0, 3).join("/");
		lines.push(`## ${index + 1}. ${hit.title}`);
		lines.push(hit.url);
		lines.push(`*${corroboration}${strategies ? ` · ${strategies}` : ""} · best rank ${hit.bestPosition}*`);
		if (hit.snippet) lines.push("", hit.snippet);
		const full = enrichment.get(hit.url);
		if (full) {
			lines.push("", "<details><summary>Full text (truncated)</summary>", "", full.slice(0, 1200), "</details>");
		}
		lines.push("");
	}

	lines.push("---");
	lines.push(
		`${probeCount} probes · ${ranked.length} sources · engines delivered: ${mixSummary}${deep ? " · depth: deep" : ""}`,
	);
	if (trust.state !== "trusted") lines.push(`Google lane: ${trust.reason}`);
	lines.push(`responseId: ${responseId} — use ts_get_search_content to read a source in full.`);

	return lines.join("\n");
}
