# Local patches

## `pi-subagents-extension-tools.patch`

**Problem.** pi-subagents builds each child's tool allowlist by intersecting the
agent's declared tools with *host builtin* tools:

```ts
const PI_BUILTIN_TOOL_NAMES = new Set(["read","bash","powershell","edit","write","grep","find","ls"]);
pi.getAllTools().filter(t => t.sourceInfo?.source === "builtin"
  || (t.sourceInfo?.source === "auto" && PI_BUILTIN_TOOL_NAMES.has(t.name)))
```

Any tool registered by an *extension* therefore fails the filter and is dropped
before the child is launched. The runner reports it as:

```
[pi-subagents] Agent 'web-researcher': host runtime tool availability omitted
  [web_search, fetch_content, get_search_content].
  Effective tool allowlist: [read, write, contact_supervisor]
```

This breaks the documented behaviour of `subagentOnlyExtensions`, which states
that *"the registered name survives the strict allowlist"* — it cannot, because
the name is removed upstream of the child, before the extension is ever loaded.

**Fix.** Admit extension-provided tools to the same set. This is safe because pi
applies `--tools` as a plain name filter (`isAllowedTool` in
`core/agent-session.js`), so an allowlist entry with no matching registered tool
is inert rather than an error. A name only becomes usable if the child actually
loads the extension that registers it, so the patch grants nothing that the
child could not already have had.

**Apply.**

```sh
./apply.sh
```

Re-run after any `pi-subagents` update, which overwrites `src/`.
