/**
 * Secret scan — run before every commit.
 *
 * Two independent checks, because either alone is insufficient:
 *
 *   1. **Pattern scan.** Recognises the credential shapes used by the services
 *      this repo touches. Catches a key pasted into a file or a doc.
 *   2. **Known-value scan.** Reads the values out of `~/.pi/agent/secrets/*.env`
 *      and looks for those exact strings. This catches a secret that matches no
 *      pattern at all, which is the case a pattern scan cannot help with.
 *
 * Wired into `npm test` so it is automatic rather than something to remember.
 * Scanning tracked files and the working tree (not just the diff) is deliberate:
 * a secret committed three commits ago is still leaked.
 *
 *   node tools/secret-scan.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PATTERNS = [
	{ name: "OpenAI-style key", re: /\bsk-[A-Za-z0-9_-]{20,}/ },
	{ name: "Anthropic key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
	{ name: "GitHub token", re: /\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/ },
	{ name: "Slack token", re: /\bxox[bpas]-[0-9A-Za-z-]{10,}/ },
	{ name: "AWS access key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
	{ name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
	{ name: "Private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
	{ name: "Bearer token literal", re: /Bearer\s+[A-Za-z0-9._-]{30,}/ },
	{ name: "Assigned secret", re: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'][A-Za-z0-9_\-./+]{16,}["']/i },
];

/** Values from local secret files, so an unpatterned key is still caught. */
function knownSecrets() {
	const dir = join(homedir(), ".pi", "agent", "secrets");
	const found = [];
	if (!existsSync(dir)) return found;
	for (const entry of readdirSync(dir)) {
		if (!entry.endsWith(".env")) continue;
		let body;
		try {
			body = readFileSync(join(dir, entry), "utf8");
		} catch {
			continue;
		}
		for (const match of body.matchAll(/^\s*(?:export\s+)?[A-Z0-9_]+\s*=\s*"?([^"\n#]{12,})"?/gm)) {
			const value = match[1].trim();
			// Skip obvious non-secrets so the scan does not cry wolf.
			if (!value || /^https?:|^\/|^\$/.test(value)) continue;
			found.push({ source: entry, value });
		}
	}
	return found;
}

const SKIP = /(^|\/)(node_modules|\.git|patches)\//;
const TEXTY = /\.(ts|js|mjs|cjs|json|md|txt|ya?ml|env|sh|toml|cfg|ini)$|(^|\/)(\.gitignore|LICENSE)$/;

function filesUnder(root) {
	const out = [];
	const walk = (dir, depth) => {
		if (depth > 6) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (SKIP.test(full + "/")) continue;
			if (entry.isDirectory()) walk(full, depth + 1);
			else if (TEXTY.test(full)) out.push(full);
		}
	};
	walk(root, 0);
	return out;
}

const root = process.cwd();
const findings = [];

for (const file of filesUnder(root)) {
	let body;
	try {
		body = readFileSync(file, "utf8");
	} catch {
		continue;
	}
	for (const { name, re } of PATTERNS) {
		const match = body.match(re);
		// The scanner's own pattern list is not a secret.
		if (match && !file.endsWith("secret-scan.mjs")) {
			findings.push({ file, why: name, sample: match[0].slice(0, 12) + "…" });
		}
	}
	for (const { source, value } of knownSecrets()) {
		if (body.includes(value)) {
			findings.push({ file, why: `literal value from ${source}`, sample: value.slice(0, 8) + "…" });
		}
	}
}

// Also check what git actually tracks, in case a secret lives in a file type
// the walker skipped.
let tracked = "";
try {
	tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
} catch {
	// Not a git checkout; the filesystem scan already covers this.
}
for (const { source, value } of knownSecrets()) {
	for (const rel of tracked.split("\n").filter(Boolean)) {
		let body;
		try {
			body = readFileSync(join(root, rel), "utf8");
		} catch {
			continue;
		}
		if (body.includes(value)) findings.push({ file: rel, why: `tracked file contains a value from ${source}`, sample: "…" });
	}
}

if (findings.length === 0) {
	console.log("secret-scan: clean (no credential patterns, no known secret values)");
	process.exit(0);
}
console.error("secret-scan: FAILED — do not commit\n");
for (const f of findings) console.error(`  ${f.file}\n    ${f.why} (${f.sample})`);
console.error(
	`\n${findings.length} finding(s). Remove the value, or move it to ~/.pi/agent/secrets/ and read it from there.`,
);
process.exit(1);
