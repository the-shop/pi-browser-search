# pi-browser-search

Headless-browser web search for the [pi](https://github.com/the-shop/pi-the-shop) coding agent.
No API keys — Chrome does the searching and the scraping.

Replaces `web_search` from `pi-web-access` (this fork's own tools carry the `ts_` prefix; the incumbent's did not).

## Status: working

`ts_web_search`, `ts_fetch_content` and `ts_get_search_content` are implemented and
verified end to end against live browsers.

| Engine | Spec share | Measured state |
| --- | --- | --- |
| Google | 70% | ✅ working — trust imported from two anonymous cookies; wrapped result links are resolved to real destinations |
| DuckDuckGo | 20% | ✅ working — 10 relevant results per query |
| Bing | 10% | ❌ decoy SERP — 0% relevant under every profile tested, including the real one |

A typical 10-probe search returns in ~22s and delivers a Google/DuckDuckGo mix.
Bing is detected and reported as degraded rather than silently absorbed, so the
achieved mix is roughly **Google 78 / DuckDuckGo 22** on this host: the 7/2/1
allocation still spends one probe per call on Bing, and the gate zeroes its
share once the decoy is detected.

### Install

```sh
pi install git:github.com/the-shop/pi-browser-search
```

Requires Chrome. Override its location with `PI_BROWSER_SEARCH_CHROME` if it is
not in the usual place. On first search the extension bootstraps a dedicated
browser profile (see "Google trust" below). Each process uses its own
`$PI_CODING_AGENT_DIR/browser-search/profile-<pid>`, seeded with the two
anonymous cookies from `.../browser-search/profile`, pruned after 3 days and
removed at shutdown. It is never your own browser's profile.

See "Engine findings" below.

## Design

One `ts_web_search` call fans out into **at least 10 probes**: the verbatim query,
a quoted variant, explanatory and practical reformulations, issue-signal probes,
`site:`-scoped source mining, recency-restricted and terminology variants.

Engines are assigned by **smooth weighted round-robin** (nginx's algorithm), not
random sampling — so 10 probes lands exactly 7/2/1 rather than clustering, and
the engines interleave instead of arriving in bursts. Probes that constrain their
own eligibility (`filetype:`) have those constraints honoured first.

With `depth: "deep"`, a second wave adds `site:` probes on the domains discovered
in wave 1 (up to 3). Terminology drift and page-2 deepening are not tiered by depth;
they are wave-1 strategies.

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

### Google trust

Google refuses `/search` from a cold profile and returns its `/sorry`
interstitial. Measured behaviour, which is why the bootstrap looks the way it
does:

- A fresh profile that visits google.com and accepts consent gets `NID` and
  `SOCS` issued — and is still refused.
- A cooldown does not help: still refused after 5 minutes, with a known-good
  profile passing at the same moment, so it is not IP throttling.
- The minimal working set is exactly **`NID` + `SOCS`**; `AEC` is irrelevant.

So the dedicated profile inherits trust by importing those two cookies from a
browser profile Google already trusts. Both are **anonymous** — `NID` is a
browser identity cookie and `SOCS` records a consent choice. Neither grants
account access, and stripping every authentication cookie was measured to make
no difference, so the authenticated session is deliberately out of scope. The
source profile is opened read-only; nothing is written back. If no source is
available the tool proceeds without Google and says so.

### Google's encrypted result redirects

Google wraps outbound result links in `/goto?url=CAES...`. The payload is an
encrypted protobuf that decodes to no URL, and an in-page `fetch` is blocked by
CORS, so the destination can only be learned by letting Chrome follow it.

Resolution is deferred until **after ranking**: a 10-probe wave yields well over
a hundred wrapped hits, while ranking only needs the displayed host and title.
Only the results actually returned are followed. A merge pass then recombines
evidence, because until destinations are known a wrapped Google hit and a
DuckDuckGo hit for the same page look like two different results — which would
hide exactly the cross-engine agreement the ranker is built around.

## Layout

```
src/browser/     cdp.ts (dependency-free CDP client), chrome.ts (lifecycle),
                 profile.ts (trust import + bootstrap)
src/engines/     google.ts, duckduckgo.ts, bing.ts, schedule.ts, execute.ts,
                 resolve.ts (encrypted redirect resolution)
src/search/      expand.ts (probe fan-out), normalize.ts, rank.ts, relevance.ts
src/content/     extract.ts (readability-style page scraping)
src/store.ts     session content store behind ts_get_search_content
tools/           unit.ts, registration.ts, e2e.ts, gate.ts, probes/
```

Runs on Node 22+ with no browser-automation or HTTP dependencies: CDP over the
built-in `WebSocket`, `node:sqlite` for the cookie store, and `typebox` for the
tool schemas. The
extension never opens, reads or modifies your own Chrome profile. The dev tools
under `tools/` do read it, read-only, to import the two anonymous cookies.

## Tests

```sh
npm install         # provides `typebox` (pi also ships a copy)
npm test            # secret scan + unit checks + registration checks, no browser needed
npm run test:e2e    # full pipeline against live browsers
```

`npm test` is browserless by design, so it stays runnable on a loaded host.

## Usage

```sh
npm run gate        # scheduler + live engine acceptance gate
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

  **Bing is therefore unusable from this machine.** Its 10% share is still spent
  on it every call (`src/engines/schedule.ts`); the degraded report is what keeps
  that visible until the share is actually redistributed.

**DuckDuckGo.** Reliable via the no-JS endpoints. Needs a UA without the
`HeadlessChrome` token (or it returns a duck CAPTCHA); GET only, since POST
trips its anomaly page; result links arrive wrapped in `uddg=` and must be
unwrapped.

## Licence

MIT
