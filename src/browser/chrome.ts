/**
 * Chrome process lifecycle + CDP connection management.
 *
 * One long-lived, dedicated browser profile per install, reused across tool
 * calls and reaped when idle. The user's own Chrome profile is never opened,
 * read, or modified: trust is bootstrapped inside this profile (see profile.ts).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { CdpConnection, CdpError, sleep, type CdpSession } from "./cdp.ts";

const DEFAULT_IDLE_MS = 5 * 60 * 1000;
const LAUNCH_TIMEOUT_MS = 30_000;

const MACOS_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LINUX_CANDIDATES = [
	"/usr/bin/google-chrome",
	"/usr/bin/google-chrome-stable",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
];

/** A plausible desktop Chrome fingerprint. The `HeadlessChrome` token in
 * Chrome's default UA is a tell that DuckDuckGo rejects outright, so we never
 * send it. */
export const DESKTOP_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

export interface ChromeLaunchOptions {
	profileDir: string;
	chromePath?: string;
	headless?: boolean | "shell";
	extraArgs?: string[];
	idleMs?: number;
	onExit?: () => void;
}

export function resolveChromePath(explicit?: string): string {
	if (explicit) {
		if (!existsSync(explicit)) throw new CdpError(`Chrome not found at ${explicit}`);
		return explicit;
	}
	const fromEnv = process.env.PI_BROWSER_SEARCH_CHROME;
	if (fromEnv) {
		if (!existsSync(fromEnv)) throw new CdpError(`PI_BROWSER_SEARCH_CHROME points at a missing file: ${fromEnv}`);
		return fromEnv;
	}
	for (const candidate of [MACOS_CHROME, ...LINUX_CANDIDATES]) {
		if (existsSync(candidate)) return candidate;
	}
	throw new CdpError(
		"Could not find Google Chrome. Install Chrome or set PI_BROWSER_SEARCH_CHROME to the executable path.",
	);
}

export function defaultProfileDir(): string {
	const base = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(base, "browser-search", "profile");
}

/**
 * Per-process working profile.
 *
 * A single shared profile directory meant every concurrent process opened the
 * same Chrome user-data-dir, so sibling processes fought over it: two of five
 * parallel subagent runs logged "Chrome exited immediately after launch" 10 and
 * 14 times, and two Chromes concurrently opened the same SQLite cookie store.
 * Nothing corrupt that time, but sharing mutable state across processes is a
 * hazard rather than a design, and it is not representable if each process owns
 * its own directory.
 *
 * The profile therefore contains nothing that needs to be shared: cache,
 * history and GPU state are all disposable, and the only irreplaceable content
 * is the two anonymous Google cookies, which are copied in from
 * `defaultProfileDir()` on first use (see `seedProfileIfNeeded`).
 */
export function processProfileDir(): string {
	return `${defaultProfileDir()}-${process.pid}`;
}

/**
 * Remove working profiles left behind by processes that are gone.
 *
 * A crashed or hard-killed run cannot clean up after itself, so without this
 * the per-process directories accumulate. Age is used rather than a liveness
 * check because PIDs are recycled.
 */
export function pruneStaleProfiles(maxAgeMs = 3 * 24 * 60 * 60 * 1000): number {
	const reference = defaultProfileDir();
	const parent = dirname(reference);
	const prefix = `${basename(reference)}-`;
	let removed = 0;
	try {
		for (const entry of readdirSync(parent, { withFileTypes: true })) {
			if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
			const full = join(parent, entry.name);
			if (full === processProfileDir()) continue;
			try {
				if (Date.now() - statSync(full).mtimeMs < maxAgeMs) continue;
				rmSync(full, { recursive: true, force: true });
				removed += 1;
			} catch {
				// Another process may be removing it concurrently.
			}
		}
	} catch {
		// No parent directory yet on a first run.
	}
	return removed;
}

async function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address && typeof address === "object") {
				const { port } = address;
				server.close(() => resolve(port));
			} else {
				server.close(() => reject(new CdpError("Could not allocate a debugging port")));
			}
		});
	});
}

interface VersionInfo {
	webSocketDebuggerUrl: string;
	Browser: string;
	"User-Agent": string;
}

export class ChromeManager {
	private readonly options: ChromeLaunchOptions;
	private child?: ChildProcess;
	private connection?: CdpConnection;
	private launching?: Promise<CdpConnection>;
	private idleTimer?: NodeJS.Timeout;
	private closed = false;

	constructor(options: ChromeLaunchOptions) {
		this.options = options;
	}

	get isRunning(): boolean {
		return Boolean(this.child) && !this.closed;
	}

	/** Connect, launching Chrome if it is not already up. Single-flight. */
	async connect(signal?: AbortSignal): Promise<CdpConnection> {
		if (this.closed) throw new CdpError("ChromeManager is closed");
		if (this.connection) {
			this.touch();
			return this.connection;
		}
		if (!this.launching) {
			this.launching = this.launch(signal).finally(() => {
				this.launching = undefined;
			});
		}
		const connection = await this.launching;
		this.touch();
		return connection;
	}

	/** Open a page with the stealth baseline already applied. */
	async newPage(signal?: AbortSignal): Promise<CdpSession> {
		const connection = await this.connect(signal);
		const page = await connection.newPage();
		await applyStealthBaseline(page);
		this.touch();
		return page;
	}

	private async launch(signal?: AbortSignal): Promise<CdpConnection> {
		const chromePath = resolveChromePath(this.options.chromePath);
		const { profileDir, headless = true, extraArgs = [] } = this.options;
		mkdirSync(profileDir, { recursive: true });
		// Safe because the profile is exclusive to this process (see
		// `processProfileDir`): any lock found here belongs to a previous run of
		// *this* process that was hard-killed, never to a live sibling.
		for (const stale of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
			rmSync(join(profileDir, stale), { force: true });
		}

		const port = await findFreePort();
		const args = [
			headless === "shell" ? "--headless=old" : "--headless=new",
			`--remote-debugging-port=${port}`,
			`--user-data-dir=${profileDir}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-background-networking",
			"--disable-sync",
			"--disable-default-apps",
			"--disable-component-update",
			"--disable-features=Translate,BackForwardCache",
			// Removes the webdriver bit that Chrome would otherwise set under
			// automation. Without this, navigator.webdriver === true is trivially
			// detectable.
			"--disable-blink-features=AutomationControlled",
			"--window-size=1440,2000",
			...extraArgs,
			"about:blank",
		]
			.filter((arg) => typeof arg === "string")
			.map(String);

		const child = spawn(chromePath, args, { stdio: "ignore", detached: false });
		this.child = child;
		child.once("exit", () => {
			this.child = undefined;
			this.connection = undefined;
			this.clearIdleTimer();
			this.options.onExit?.();
		});

		const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
		let version: VersionInfo | undefined;
		while (Date.now() < deadline) {
			if (signal?.aborted) throw new CdpError("Aborted while launching Chrome");
			if (!this.child) throw new CdpError("Chrome exited immediately after launch");
			try {
				const response = await fetch(`http://127.0.0.1:${port}/json/version`);
				if (response.ok) {
					version = (await response.json()) as VersionInfo;
					break;
				}
			} catch {
				// Not listening yet.
			}
			await sleep(200);
		}
		if (!version) {
			this.kill();
			throw new CdpError(`Chrome did not expose CDP within ${LAUNCH_TIMEOUT_MS}ms`);
		}

		const connection = await CdpConnection.connect(version.webSocketDebuggerUrl, { signal });
		this.connection = connection;
		return connection;
	}

	private clearIdleTimer(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = undefined;
		}
	}

	/** Reset the idle countdown; Chrome is reaped after `idleMs` of silence. */
	touch(): void {
		const idleMs = this.options.idleMs ?? DEFAULT_IDLE_MS;
		if (idleMs <= 0) return;
		this.clearIdleTimer();
		this.idleTimer = setTimeout(() => {
			void this.shutdown();
		}, idleMs);
		this.idleTimer.unref?.();
	}

	private kill(): void {
		const child = this.child;
		this.child = undefined;
		if (!child || child.killed) return;
		try {
			child.kill("SIGKILL");
		} catch {
			// Already gone.
		}
	}

	async shutdown(): Promise<void> {
		this.clearIdleTimer();
		this.connection?.close();
		this.connection = undefined;
		if (this.child) {
			// Ask politely first so the profile's cookie jar is flushed to disk.
			this.child.kill("SIGTERM");
			await sleep(400);
			this.kill();
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.shutdown();
	}
}

/**
 * Apply the anti-detection baseline to a fresh page.
 *
 * These run before any page script, via `Page.addScriptToEvaluateOnNewDocument`,
 * so they cannot be observed or reverted by the page. `Runtime.enable` is
 * deliberately not called — see the note in cdp.ts.
 */
export async function applyStealthBaseline(page: CdpSession): Promise<void> {
	await page.send("Page.enable");
	await page.send("Emulation.setUserAgentOverride", {
		userAgent: DESKTOP_UA,
		acceptLanguage: "en-US,en;q=0.9",
		platform: "MacIntel",
	});
	await page.send("Page.addScriptToEvaluateOnNewDocument", {
		source: `
			Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
			Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
			Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
			// Headless Chrome reports 0 plugins; a real desktop profile reports several.
			if (navigator.plugins.length === 0) {
				const fake = [
					{ name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
					{ name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
					{ name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
				];
				Object.defineProperty(navigator, 'plugins', { get: () => fake });
				Object.defineProperty(navigator, 'mimeTypes', { get: () => fake.map((f) => ({ type: 'application/pdf', suffixes: 'pdf', description: f.description })) });
			}
			if (!window.chrome) { window.chrome = {}; }
			if (!window.chrome.runtime) { window.chrome.runtime = {}; }
			// Headless leaves this undefined on some builds; real Chrome has it.
			if (!Object.getOwnPropertyDescriptor(navigator, 'pdfViewerEnabled')) {
				Object.defineProperty(navigator, 'pdfViewerEnabled', { get: () => true });
			}
		`.trim(),
	});
}
