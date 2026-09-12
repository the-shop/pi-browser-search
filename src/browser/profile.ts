/**
 * Profile trust bootstrap.
 *
 * Google refuses `/search` from a cold profile and returns its `/sorry`
 * interstitial. Measured behaviour:
 *
 *   - A fresh profile that merely visits google.com and accepts consent gets
 *     `NID` + `SOCS` issued, but is still refused — the freshly-minted `NID`
 *     carries no trust.
 *   - The minimal working set is exactly `NID` + `SOCS`; `AEC` is irrelevant.
 *     With a *trusted* pair, `/search` returns a full SERP.
 *
 * This module therefore treats Google as a **probationary** lane rather than an
 * assumed one: it probes once, caches the verdict, and lets the executor report
 * a degraded mix when trust has not been earned. It never reads or writes the
 * user's own browser profile.
 */

import { existsSync } from "node:fs";
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
 * causes Google to issue `NID` and `SOCS` to this profile.
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

async function probeGoogle(page: CdpSession): Promise<{ ok: boolean; reason: string }> {
	await page.navigate(
		`https://www.google.com/search?q=${encodeURIComponent(CANARY_QUERY)}&num=10&hl=en&udm=14`,
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
 * Establish whether the Google lane is usable, acquiring cookies first if the
 * profile has none. Cached for `VERDICT_TTL_MS`.
 */
export async function ensureGoogleTrust(
	chrome: ChromeManager,
	signal?: AbortSignal,
): Promise<TrustVerdict> {
	const existing = cachedVerdict();
	if (existing) return existing;

	let page: CdpSession | undefined;
	try {
		page = await chrome.newPage(signal);
		const first = await probeGoogle(page);
		if (first.ok) {
			cached = { state: "trusted", reason: first.reason, checkedAt: Date.now() };
			return cached;
		}

		// Not usable yet: try to acquire the cookies, then re-probe once.
		await acquireCookies(page);
		const second = await probeGoogle(page);
		if (second.ok) {
			cached = { state: "trusted", reason: `${second.reason} (after cookie acquisition)`, checkedAt: Date.now() };
			return cached;
		}

		cached = {
			state: "untrusted",
			reason: `${second.reason} — Google is unavailable until this profile earns trust`,
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
