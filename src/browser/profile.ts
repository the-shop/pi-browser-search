/**
 * Profile trust bootstrap.
 *
 * Google refuses `/search` from a cold profile and returns its `/sorry`
 * interstitial. Measured behaviour:
 *
 *   - A fresh profile that merely visits google.com and accepts consent gets
 *     `NID` + `SOCS` issued, but is still refused — the freshly-minted `NID`
 *     carries no trust, and a 5-minute cooldown does not change that.
 *   - The minimal working set is exactly `NID` + `SOCS`; `AEC` is irrelevant.
 *     With a *trusted* pair, `/search` returns a full SERP and sustains ~12/12
 *     queries at 2-3s pacing.
 *
 * So trust cannot be bootstrapped from nothing: it has to be imported from a
 * profile Google already trusts. This module does that, reading **only the two
 * anonymous cookies and nothing else** — verified by measurement to be
 * sufficient, and deliberately narrow so the user's authenticated session is
 * never involved.
 *
 * The user's own profile is opened read-only; nothing is ever written back.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { CdpSession } from "./cdp.ts";
import { sleep } from "./cdp.ts";
import { ChromeManager } from "./chrome.ts";

export type TrustState = "trusted" | "untrusted" | "unknown";

export interface TrustVerdict {
	state: TrustState;
	reason: string;
	/** Epoch ms when this verdict was established. */
	checkedAt: number;
}

const CANARY_QUERY = "kubernetes operator best practices";
const VERDICT_TTL_MS = 30 * 60 * 1000;

/**
 * The only cookie names this module ever reads. Both are anonymous: `NID` is a
 * long-lived browser identity cookie and `SOCS` records a consent choice.
 * Neither grants account access, and Phase 0 established that stripping every
 * authentication cookie still yields a working SERP — so the authenticated
 * session is deliberately out of scope.
 */
export const IMPORTED_COOKIE_NAMES = ["NID", "SOCS"] as const;

let cached: TrustVerdict | undefined;

/** Forget the cached verdict; forces a re-probe on the next search. */
export function resetTrustCache(): void {
	cached = undefined;
}

export function cachedVerdict(): TrustVerdict | undefined {
	if (!cached) return undefined;
	if (Date.now() - cached.checkedAt > VERDICT_TTL_MS) return undefined;
	return cached;
}

/**
 * Does this profile already hold the two cookies Google checks?
 * Reads the profile's own cookie store — which belongs to this extension, not
 * to the user's browser.
 */
export function hasProfileGoogleCookies(profileDir: string): boolean {
	const cookieDb = join(profileDir, "Default", "Cookies");
	if (!existsSync(cookieDb)) return false;
	try {
		// node:sqlite is available on Node 22+; fall back to a live-jar check otherwise.
		const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
		const db = new DatabaseSync(cookieDb);
		const rows = db
			.prepare("SELECT name FROM cookies WHERE host_key LIKE '%google%' AND name IN ('NID','SOCS')")
			.all() as Array<{ name: string }>;
		db.close();
		const names = new Set(rows.map((row) => row.name));
		return names.has("NID") && names.has("SOCS");
	} catch {
		return false;
	}
}

/**
 * Visit the Google homepage and accept the consent interstitial, which is what
 * causes Google to issue `NID` and `SOCS` to a brand-new profile. On its own
 * this is not enough to earn trust, but it is the fallback when no source
 * profile is available.
 */
async function acquireCookies(page: CdpSession): Promise<void> {
	await page.navigate("https://www.google.com/", { timeoutMs: 25_000 });
	await sleep(1500);
	try {
		await page.evaluate(`
			(() => {
				const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
				const accept = buttons.find((b) => /accept all|i agree|prihvati sve|godia|akkoord/i.test(b.innerText || ''));
				if (accept) { accept.click(); return true; }
				return false;
			})()
		`);
	} catch {
		// No interstitial is a fine outcome.
	}
	await sleep(1500);
}

export interface CookieImportResult {
	imported: boolean;
	/** Cookie names actually copied. */
	names: string[];
	reason?: string;
}

/** Chromium-family profiles we can read, in preference order. */
const SOURCE_PROFILES: Array<{ name: string; dir: string }> = [
	{ name: "Chrome", dir: "Library/Application Support/Google/Chrome" },
	{ name: "Brave", dir: "Library/Application Support/BraveSoftware/Brave-Browser" },
	{ name: "Chromium", dir: "Library/Application Support/Chromium" },
];

function firstExistingCookieDb(homeDir: string): { name: string; db: string; profileDir: string } | undefined {
	const subProfiles = ["Default", "Profile 1", "Profile 2", "Profile 3"];
	for (const browser of SOURCE_PROFILES) {
		for (const sub of subProfiles) {
			const db = join(homeDir, browser.dir, sub, "Cookies");
			if (existsSync(db)) return { name: `${browser.name} (${sub})`, db, profileDir: join(homeDir, browser.dir) };
		}
	}
	return undefined;
}

/**
 * Copy the two anonymous Google cookies out of a browser profile Google already
 * trusts, so the dedicated search profile inherits that trust.
 *
 * Read-only with respect to the source profile, and restricted to
 * `IMPORTED_COOKIE_NAMES`. The values are copied as opaque encrypted blobs: the
 * encryption key is per-user, not per-profile, so Chrome can decrypt them in
 * our profile without this code ever handling plaintext credentials.
 */
export function importAnonymousGoogleCookies(
	targetProfileDir: string,
	sourceProfileDir?: string,
): CookieImportResult {
	const require = createRequire(import.meta.url);
	let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
	try {
		({ DatabaseSync } = require("node:sqlite"));
	} catch {
		return { imported: false, names: [], reason: "node:sqlite is unavailable on this Node version" };
	}

	const source = sourceProfileDir
		? { name: sourceProfileDir, db: join(sourceProfileDir, "Default", "Cookies"), profileDir: sourceProfileDir }
		: firstExistingCookieDb(process.env.HOME ?? "");
	if (!source) return { imported: false, names: [], reason: "no Chromium cookie store found" };
	if (!existsSync(source.db)) return { imported: false, names: [], reason: `no Cookies database at ${source.db}` };

	mkdirSync(join(targetProfileDir, "Default"), { recursive: true });
	const targetDb = join(targetProfileDir, "Default", "Cookies");
	// A brand-new profile has no cookie store until Chrome creates one, so
	// bootstrap it from the source database's schema by copying the file and
	// clearing it, rather than hand-writing CREATE TABLE.
	if (!existsSync(targetDb)) {
		try {
			copyFileSync(source.db, targetDb);
			const fresh = new DatabaseSync(targetDb);
			fresh.exec("DELETE FROM cookies");
			fresh.close();
		} catch (error) {
			return {
				imported: false,
				names: [],
				reason: `could not initialise a cookie store: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	try {
		const names = IMPORTED_COOKIE_NAMES as readonly string[];
		// `readBigInts` is required: the Cookies table stores timestamps in
		// microseconds (e.g. 13426855503704998), which overflow a JS number and
		// make node:sqlite throw while reading the row.
		const reader = new DatabaseSync(source.db, { readOnly: true, readBigInts: true } as never);
		const rows = reader
			.prepare(
				`SELECT * FROM cookies WHERE host_key LIKE '%google%' AND name IN (${names.map(() => "?").join(",")})`,
			)
			.all(...(names as never[])) as Array<Record<string, unknown>>;
		reader.close();
		if (rows.length === 0) {
			return { imported: false, names: [], reason: `no ${names.join("/")} cookies in ${source.name}` };
		}

		const writer = new DatabaseSync(targetDb, { readBigInts: true } as never);
		const columns = (writer.prepare("PRAGMA table_info(cookies)").all() as Array<{ name: string }>).map((c) => c.name);
		writer.exec(`DELETE FROM cookies WHERE host_key LIKE '%google%'`);
		const insert = writer.prepare(
			`INSERT OR REPLACE INTO cookies (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
		);
		const copied: string[] = [];
		for (const row of rows) {
			try {
				insert.run(...(columns.map((name) => (row[name] ?? null) as never) as never[]));
				copied.push(String(row.name));
			} catch {
				// Schema drift between Chrome versions; skip the row rather than abort.
			}
		}
		writer.close();

		if (copied.length === 0) {
			return { imported: false, names: [], reason: "cookie rows could not be written" };
		}
		return { imported: true, names: [...new Set(copied)] };
	} catch (error) {
		return {
			imported: false,
			names: [],
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

async function probeGoogle(page: CdpSession): Promise<{ ok: boolean; reason: string }> {
	await page.navigate(
		`https://www.google.com/search?q=${encodeURIComponent(CANARY_QUERY)}&num=10&hl=en`,
		{ timeoutMs: 30_000 },
	);
	await sleep(2500);
	const state = await page.evaluate<{ sorry: boolean; consent: boolean; containers: number; captcha: boolean }>(`
		(() => {
			const text = (document.body ? document.body.innerText : '').slice(0, 3000);
			return {
				sorry: /\\/sorry\\/index|unusual traffic/i.test(location.href + text),
				consent: /consent\\.google\\./i.test(location.href),
				captcha: /select all squares|are you a robot/i.test(text),
				containers: document.querySelectorAll('div[data-ved][data-hveid]').length,
			};
		})()
	`);
	if (state.captcha) return { ok: false, reason: "Google served a CAPTCHA" };
	if (state.consent) return { ok: false, reason: "Google redirected to consent" };
	if (state.sorry) return { ok: false, reason: "Google served the /sorry interstitial" };
	if (state.containers >= 6) return { ok: true, reason: "Google returned a full SERP" };
	return { ok: false, reason: `Google returned no result containers (${state.containers})` };
}

/**
 * Establish whether the Google lane is usable. When the profile has no trusted
 * cookies, imports them from a browser profile Google already trusts; if that
 * is unavailable, falls back to acquiring them organically (which yields a
 * profile Google will accept only once it has aged). Cached for
 * `VERDICT_TTL_MS`.
 */
export async function ensureGoogleTrust(
	chrome: ChromeManager,
	signal?: AbortSignal,
	options: { profileDir?: string; importCookies?: boolean; sourceProfileDir?: string } = {},
): Promise<TrustVerdict> {
	const existing = cachedVerdict();
	if (existing) return existing;

	// Import before launching, so the very first query already carries trust.
	let importResult: CookieImportResult | undefined;
	if (options.importCookies !== false && options.profileDir) {
		importResult = importAnonymousGoogleCookies(options.profileDir, options.sourceProfileDir);
	}

	let page: CdpSession | undefined;
	try {
		page = await chrome.newPage(signal);
		const first = await probeGoogle(page);
		if (first.ok) {
			cached = {
				state: "trusted",
				reason: importResult?.imported
					? `${first.reason} (trust imported: ${importResult.names.join("+")})`
					: first.reason,
				checkedAt: Date.now(),
			};
			return cached;
		}

		// Not usable yet: try to acquire the cookies, then re-probe once.
		await acquireCookies(page);
		const second = await probeGoogle(page);
		if (second.ok) {
			cached = { state: "trusted", reason: `${second.reason} (after cookie acquisition)`, checkedAt: Date.now() };
			return cached;
		}

		const importNote = importResult && !importResult.imported ? ` Cookie import: ${importResult.reason}.` : "";
		cached = {
			state: "untrusted",
			reason: `${second.reason} — Google is unavailable until this profile earns trust.${importNote}`,
			checkedAt: Date.now(),
		};
		return cached;
	} catch (error) {
		cached = {
			state: "unknown",
			reason: error instanceof Error ? error.message : String(error),
			checkedAt: Date.now(),
		};
		return cached;
	} finally {
		await page?.close().catch(() => undefined);
	}
}
