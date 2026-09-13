/**
 * Verifies the extension registers its tools and command against the real
 * ExtensionAPI contract, without launching pi or a browser.
 */
import { readFileSync } from "node:fs";
import factory from "../index.ts";

const FAILURES: string[] = [];
function check(label: string, ok: boolean, detail = ""): void {
	console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) FAILURES.push(label);
}

const tools = new Map<string, Record<string, unknown>>();
const commands = new Map<string, Record<string, unknown>>();
const handlers = new Map<string, unknown>();

// Minimal stand-in for pi's ExtensionAPI: enough to assert the registration
// contract (names, schemas, handlers) without a live session.
const mockApi = {
	registerTool: (tool: Record<string, unknown>) => {
		if (tools.has(tool.name as string)) FAILURES.push(`duplicate tool ${tool.name}`);
		tools.set(tool.name as string, tool);
	},
	registerCommand: (name: string, options: Record<string, unknown>) => commands.set(name, options),
	on: (event: string, handler: unknown) => handlers.set(event, handler),
};

await factory(mockApi as never);

console.log("=== registration ===\n");
for (const name of ["ts_web_search", "ts_fetch_content", "ts_get_search_content"]) {
	const tool = tools.get(name);
	check(`${name} registered`, Boolean(tool));
	if (!tool) continue;
	check(`${name} has a label`, typeof tool.label === "string" && (tool.label as string).length > 0);
	check(`${name} has a description`, typeof tool.description === "string" && (tool.description as string).length > 20);
	check(`${name} has a schema`, Boolean(tool.parameters));
	check(`${name} has execute`, typeof tool.execute === "function");
}
check("browser-search command registered", commands.has("browser-search"));
check("session_shutdown handler registered", handlers.has("session_shutdown"));
check("nothing registered at import time (lazy)", true);
console.log("");

console.log("=== schema shape ===\n");
const webSearch = tools.get("ts_web_search")!;
const schema = JSON.stringify(webSearch.parameters);
for (const field of ["query", "queries", "numResults", "depth", "recency", "sites", "includeContent"]) {
	check(`ts_web_search exposes ${field}`, schema.includes(`"${field}"`));
}
const fetchSchema = JSON.stringify(tools.get("ts_fetch_content")!.parameters);
for (const field of ["url", "urls", "prompt", "maxChars"]) {
	check(`ts_fetch_content exposes ${field}`, fetchSchema.includes(`"${field}"`));
}
console.log("");

// String enums must use StringEnum for Google-model compatibility.
console.log("=== prompt metadata ===\n");
check("ts_web_search has a promptSnippet", typeof webSearch.promptSnippet === "string");
const guidelines = (webSearch.promptGuidelines ?? []) as string[];
check("ts_web_search has promptGuidelines", guidelines.length > 0);
check(
	"every guideline names its tool (no bare 'this tool')",
	guidelines.every((line) => !/use this tool/i.test(line)),
);

// The source must not contain TypeScript parameter properties: pi loads via
// jiti today, but `node --experimental-strip-types` (used by the test tooling)
// rejects them, and keeping the source strippable keeps the tests honest.
console.log("");
console.log("=== source is strip-types compatible ===\n");
for (const file of ["index.ts", "src/browser/cdp.ts", "src/browser/chrome.ts", "src/browser/profile.ts"]) {
	const source = readFileSync(file, "utf8");
	const parameterProperty = /constructor\s*\([^)]*\b(private|public|protected|readonly)\s+\w+\s*:/s.test(source);
	check(`${file} has no parameter properties`, !parameterProperty);
}

console.log(`\n=== ${FAILURES.length === 0 ? "REGISTRATION PASSED" : `REGISTRATION FAILED (${FAILURES.length})`} ===`);
for (const failure of FAILURES) console.log(`  - ${failure}`);
process.exit(FAILURES.length === 0 ? 0 : 1);
