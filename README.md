# pi-browser-search

Headless-browser web search for the [pi](https://github.com/the-shop/pi-the-shop) coding agent.
No API keys — Chrome does the searching and the scraping.

Replaces `web_search` from `pi-web-access`.

## Status: core verified, engine availability blocked on this machine

The browser layer, engine adapters, weighted scheduler and relevance gate all
work and pass `tools/gate.ts`. Two of the three engines are currently
**degraded from this machine**, and the tool reports that honestly rather than
returning a degraded mix as if it satisfied the request.

| Engine | Spec share | Measured state |
| --- | --- | --- |
| DuckDuckGo | 20% | ✅ working — 10 relevant results per query |
| Google | 70% | ⚠️ blocked without a trusted `NID`+`SOCS` pair; works with one (verified 12/12) |
| Bing | 10% | ❌ decoy SERP — 0% relevant under every profile tested, including the real one |

The practical ceiling from this machine is therefore **Google 70 / DuckDuckGo 30**,
with Bing's share redistributed — see "Engine findings".

See "Engine findings" below.

## Design

One `web_search` call fans out into **at least 10 probes**: the verbatim query,
a quoted variant, explanatory and practical reformulations, issue-signal probes,
`site:`-scoped source mining, recency-restricted and terminology variants.

Engines are assigned by **smooth weighted round-robin** (nginx's algorithm), not
random sampling — so 10 probes lands exactly 7/2/1 rather than clustering, and
the engines interleave instead of arriving in bursts. Probes that constrain their
own eligibility (`filetype:`) have those constraints honoured first.

A second wave fires when precision is weak: page 2 of the best probes, `site:`
probes on the domains discovered in wave 1, and terminology drift.

Results are ranked primarily by **cross-engine corroboration**, then probe
support, position, domain authority and freshness, with a max-two-per-domain
diversity cap.

### Two failure modes designed around

Both were found by measurement, not assumption:

1. **Google's block page returns HTTP 200 with a valid document.** Success is
   therefore detected structurally (result-container counts), never by status.
2. **Bing returns a complete, well-formed SERP of entirely unrelated results** —
   a "postgres index bloat" query returned German trade listings, Italian
   name-day greetings and a Spanish dictionary entry. A structural check cannot
   catch this. `src/search/relevance.ts` scores query-term coverage and condemns
   an engine whose output is consistently off-target.

An engine that fails either check is **reported as degraded**, and every
response states the *achieved* engine mix rather than the requested one.

## Layout

```
src/browser/     cdp.ts (dependency-free CDP client), chrome.ts (lifecycle),
                 profile.ts (trust bootstrap)
src/engines/     google.ts, duckduckgo.ts, bing.ts, schedule.ts, execute.ts
src/search/      relevance.ts (decoy-SERP detector)
tools/           gate.ts (acceptance gate), dump.ts / diag-*.ts (debugging)
```

Runs on Node 22+ using only built-ins (`WebSocket`, `fetch`, `node:sqlite`). The
user's own Chrome profile is never opened, read or modified.

## Usage

```sh
npm run gate        # acceptance gate
node --experimental-strip-types tools/dump.ts duckduckgo "your query"
```

## Engine findings

Recorded so the next person does not have to rediscover them.

**Google.** `/search` from a cold profile redirects to `/sorry`. Not IP type
(the address is residential and unflagged), not headless detection (headful is
blocked too), and not fixable by UA stripping, `--disable-blink-features=AutomationControlled`,
SOCS/CONSENT injection, `udm=14`, `gbv=1`, or a warm-up visit. The minimal
working set is exactly the anonymous **`NID` + `SOCS`** pair — `AEC` is
irrelevant. A freshly minted `NID` is **not** trusted, and does not become
trusted after a cooldown (verified to 5 minutes with a passing control). So the
lane cannot bootstrap itself; it needs a pre-aged pair.

**Bing.** Serves a decoy SERP: HTTP 200, ordinary `li.b_algo` containers,
plausible titles and links — all unrelated to the query. Consistent across
`mkt`/`setlang`/`ensearch`/`cc` variants, and stable over time, so it is a bot
tarpit rather than a locale bug.

  Tested against profile trust directly (`tools/probe-bing-trust.ts`), because
  trust is what fixes Google:

  | Profile | Hits | Relevant |
  | --- | --- | --- |
  | fresh | 10 | 0% |
  | fresh + injected `NID`/`SOCS` | 10 | 0% |
  | full real Chrome profile | 10 | 0% |

  So Bing is **not** trust-dependent and the Google fix does not help it. A
  "postgres index bloat" query returned Arabic news about a phone's green dot,
  Italian Speedtest pages and Taiwanese gaming-forum threads. Extracted text
  also arrives with characters stripped (`Speedtest` → `Speedte t`), which is
  consistent with deliberate obfuscation rather than a parsing fault.

  **Bing is therefore unusable from this machine**, and its 10% share should be
  redistributed rather than silently reported as satisfied.

**DuckDuckGo.** Reliable via the no-JS endpoints. Needs a UA without the
`HeadlessChrome` token (or it returns a duck CAPTCHA); GET only, since POST
trips its anomaly page; result links arrive wrapped in `uddg=` and must be
unwrapped.

## Licence

MIT
