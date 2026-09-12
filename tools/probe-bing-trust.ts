/**
 * Does Bing's decoy SERP depend on profile trust?
 *
 * Bing answers an untrusted client with a complete, well-formed SERP of
 * unrelated results. Google is blocked the same way until it has a trusted
 * `NID`+`SOCS` pair. If Bing's behaviour is also trust-driven, one fix unlocks
 * both lanes; if not, Bing needs a different approach entirely.
 *
 * Three conditions, run against the same query in one window so a time-varying
 * effect cannot be mistaken for a profile effect:
 *
 *   A  fresh profile                        (control — expect decoy)
 *   B  fresh + injected NID/SOCS            (does the Google fix help Bing?)
 *   C  copy of the real Chrome profile      (maximum trust available)
 *
 * Run: node --experimental-strip-types tools/probe-bing-trust.ts
 */

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { ChromeManager, DESKTOP_UA } from "../src/browser/chrome.ts";
import { bing } from "../src/engines/bing.ts";
import { scoreHit } from "../src/search/relevance.ts";
import { queryTerms } from "../src/search/relevance.ts";
import type { Probe, RawHit } from "../src/engines/types.ts";

const REAL_PROFILE = process.env.HOME + "/Library/Application Support/Google/Chrome";
const QUERY = "postgres index bloat";

async function buildInjectedProfile(dest: string, port: number): Promise<number> {
	rmSync(dest, { recursive: true, force: true });
	mkdirSync(dest, { recursive: true });
	// Let Chrome create a valid profile skeleton first.
	const chrome = new ChromeManager({ profileDir: dest, idleMs: 0 });
	const page = await chrome.newPage();
	await page.close();
	await chrome.close();
	await sleep(600);

	if (existsSync(join(REAL_PROFILE, "Local State"))) {
		cpSync(join(REAL_PROFILE, "Local State"), join(dest, "Local State"));
	}
	const source = new DatabaseSync(join(REAL_PROFILE, "Default", "Cookies"), { readBigInts: true } as never);
	const rows = source
		.prepare("SELECT * FROM cookies WHERE host_key LIKE '%google%' AND name IN ('NID','SOCS')")
		.all() as Array<Record<string, unknown>>;
	source.close();

	const target = new DatabaseSync(join(dest, "Default", "Cookies"), { readBigInts: true } as never);
	const columns = (target.prepare("PRAGMA table_info(cookies)").all() as Array<{ name: string }>).map((c) => c.name);
	const insert = target.prepare(
		`INSERT OR REPLACE INTO cookies (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
	);
	let inserted = 0;
	for (const row of rows) {
		try {
			insert.run(...columns.map((name) => (row[name] ?? null) as never));
			inserted += 1;
		} catch {
			// Column mismatch on a Chrome version we do not know about.
		}
	}
	target.close();
	return inserted;
}

/** Copy the minimum a real profile needs to authenticate cookies. */
function buildRealProfileCopy(dest: string): void {
	rmSync(dest, { recursive: true, force: true });
	mkdirSync(join(dest, "Default"), { recursive: true });
	cpSync(join(REAL_PROFILE, "Local State"), join(dest, "Local State"));
	for (const file of ["Cookies", "Preferences", "Web Data", "Secure Preferences"]) {
		const from = join(REAL_PROFILE, "Default", file);
		if (existsSync(from)) cpSync(from, join(dest, "Default", file));
	}
}

interface Verdict {
	label: string;
	hits: number;
	relevant: number;
	ratio: number;
	samples: string[];
}

async function measure(label: string, profileDir: string, probes: Probe[]): Promise<Verdict> {
	const chrome = new ChromeManager({ profileDir, idleMs: 0 });
	try {
		const terms = queryTerms(QUERY);
		const collected: RawHit[] = [];
		const page = await chrome.newPage();
		for (const probe of probes) {
			await page.navigate(bing.buildUrl(probe, 0), { timeoutMs: 30_000 });
			await bing.waitForResults(page, 12_000);
			const hits = await bing.extract({ page, probe, limit: 10, offset: 0 });
			collected.push(...hits);
			await sleep(900);
		}
		await page.close();

		const relevant = collected.filter((hit) => scoreHit(hit, terms).relevant).length;
		return {
			label,
			hits: collected.length,
			relevant,
			ratio: collected.length === 0 ? 0 : relevant / collected.length,
			samples: collected.slice(0, 3).map((hit) => `${hit.title.slice(0, 52)} → ${new URL(hit.url).hostname}`),
		};
	} finally {
		await chrome.close();
	}
}

const workdir = join(tmpdir(), "pbs-bingtrust");
rmSync(workdir, { recursive: true, force: true });
mkdirSync(workdir, { recursive: true });

const probes: Probe[] = [{ id: "b1", query: QUERY, label: "core" }];

try {
	console.log(`query: "${QUERY}"   UA profile: ${DESKTOP_UA.slice(-30)}\n`);

	const freshDir = join(workdir, "fresh");
	mkdirSync(freshDir, { recursive: true });
	const fresh = await measure("A fresh profile", freshDir, probes);
	report(fresh);

	const injectedDir = join(workdir, "injected");
	const inserted = await buildInjectedProfile(injectedDir, 0);
	const injected = await measure(`B fresh + NID/SOCS (${inserted} rows)`, injectedDir, probes);
	report(injected);

	const realDir = join(workdir, "real");
	buildRealProfileCopy(realDir);
	const real = await measure("C full real profile", realDir, probes);
	report(real);

	console.log(`\n${"condition".padEnd(34)} hits  relevant  ratio`);
	for (const verdict of [fresh, injected, real]) {
		console.log(
			`${verdict.label.padEnd(34)} ${String(verdict.hits).padStart(4)}  ${String(verdict.relevant).padStart(8)}  ${(verdict.ratio * 100).toFixed(0).padStart(4)}%`,
		);
	}

	const verdict =
		injected.ratio > fresh.ratio + 0.3 || real.ratio > fresh.ratio + 0.3
			? "TRUST-DEPENDENT — Bing's decoy SERP clears with a trusted profile"
			: "NOT trust-dependent — Bing stays decoyed regardless of profile";
	console.log(`\nCONCLUSION: ${verdict}`);
} finally {
	rmSync(workdir, { recursive: true, force: true });
}

function report(verdict: Verdict): void {
	console.log(`${verdict.label}: ${verdict.hits} hits, ${verdict.relevant} relevant (${(verdict.ratio * 100).toFixed(0)}%)`);
	for (const sample of verdict.samples) console.log(`    ${sample}`);
	console.log("");
}
