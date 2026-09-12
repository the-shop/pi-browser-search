// Ad-hoc engine dump: verify extraction quality per engine.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChromeManager } from "../src/browser/chrome.ts";
import { runWave } from "../src/engines/execute.ts";
import type { EngineId, Probe } from "../src/engines/types.ts";

const engine = (process.argv[2] ?? "bing") as EngineId;
const query = process.argv[3] ?? "postgres index bloat";
const profileDir = mkdtempSync(join(tmpdir(), "pbs-dump-"));
const chrome = new ChromeManager({ profileDir, idleMs: 0 });
try {
	const probes: Probe[] = [{ id: "d1", query, label: "dump", engines: [engine] }];
	const wave = await runWave({ chrome, probes, perPageLimit: 10, renderTimeoutMs: 12_000 });
	const outcome = wave.outcomes[0];
	console.log(`${engine}: status=${outcome?.status} hits=${outcome?.hits.length} ${outcome?.elapsedMs}ms ${outcome?.detail ?? ""}\n`);
	outcome?.hits.forEach((hit, i) => {
		console.log(`${String(i + 1).padStart(2)}. ${hit.title.slice(0, 70)}`);
		console.log(`    ${hit.url.slice(0, 95)}`);
		console.log(`    ${hit.snippet.slice(0, 95)}`);
	});
} finally {
	await chrome.close();
	rmSync(profileDir, { recursive: true, force: true });
}
