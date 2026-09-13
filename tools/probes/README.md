# Investigative probes

These are the scripts that established the engine findings in the top-level
README. They are kept because each one answers a question that is expensive to
re-derive, and because several conclusions are counter-intuitive enough to be
worth re-checking rather than trusting.

Run with `node <script>.mjs`. Each drives system Chrome over raw CDP and cleans
up its own temporary profile.

| Script | Question it answers |
| --- | --- |
| `probe.mjs` | Which engines answer over plain HTTP, with no browser at all? |
| `cdp.mjs` | Does driving Chrome over CDP change the outcome per engine? |
| `matrix.mjs` | Is Google's block headless-detection or profile-reputation? |
| `g2.mjs` | Does headful mode, `gbv=1` or `udm=14` get past Google? |
| `final.mjs` | Does a SOCS consent cookie, or DuckDuckGo with a clean UA, help? |
| `real.mjs` | Does the real Chrome profile unblock Google? |
| `extract.mjs` | Is Google's SERP extractable with durable selectors? |
| `rate.mjs` | How many Google queries sustain before a soft block? |
| `cookies.mjs` | Can Chrome's cookie store be read directly? (No — Keychain.) |
| `phase0.mjs` | Is Google's trust carried by auth cookies, or by history? |
| `phase0b.mjs` | Can a blank profile be bootstrapped by injecting cookies? |
Five probes ran during the investigation but are **not in this checkout**:
`organic.mjs`, `organic2.mjs`, `isolate.mjs`, `discriminate.mjs`, `cooldown.mjs`.
They produced the `NID`+`SOCS` minimal-set result and the cooldown result quoted in
the top-level README, and those conclusions therefore cannot be re-run from here —
only the conclusions survive.

Two methodology notes worth keeping:

- **Always run a control in the same window.** Interleave a known-good profile with
  the condition under test, because Google's throttling is partly time-varying.
  The removed `discriminate.mjs` and `cooldown.mjs` probes did this for the
  cookie-age question. Without a control it is
  impossible to tell a cookie effect from an IP effect.
- **Cookie checks must read the live jar** (`Network.getCookies`), not the
  SQLite file. Chrome flushes lazily, so a file read reports an empty jar on a
  profile that demonstrably has cookies.

