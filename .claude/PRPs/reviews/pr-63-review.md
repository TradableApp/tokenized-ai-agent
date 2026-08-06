# PR Review: #63 — Oracle Brain providers + run-correlated provenance

**Reviewed**: 2026-08-06 · **Author**: GarrickBrown · **Branch**: `feat/oracle-brain-providers_CU-86d3ud1va` → `main`
**Task**: CU-86d3ud1va · **Decision**: APPROVE (5 bot rounds, converged)
**Final**: `6e26b34` · 19 files, +2052/−27 · **289 passing / 0 failing** · CI + CodeQL green

## Summary

Moves market context out of hand-built prompt concatenation into ElizaOS providers (`MACRO_SENTIMENT`, `MARKET_INTELLIGENCE`) backed by a host-injected `BrainService`, and rebuilds provenance so `sources[]`/`reasoning[]` describe what the run actually composed and emitted rather than what the oracle happened to fetch alongside it.

## Bot-comment triage — 5 rounds, 28 findings

| Round | Findings | Accepted | Pushed back | Notable |
|---|---|---|---|---|
| 1 | 5 | 5 | 0 | initial pass |
| 2 | 6 | 5 | 1 | **parser read the wrong provider path — `sources` would have been `[]` on every live answer** |
| 3 | 7 | 6 | 1 | **handler-flag "fix" claimed in round 2 was never committed**; heading drift vs core |
| 4 | 7 | 7 | 0 | **stale action attribution — wrong titles in immutable storage** |
| 5 | 4 | 2 | 2 | **false-green test**; fail-fast on broken build |

### Bugs that would have shipped

1. **`sourcesFromState` read `.latestNews` instead of `.data.latestNews`** — `state.data.providers[name]` holds the provider's *whole* result. Would have returned `[]` on every live answer: a silent regression from the list the dApp already renders, on a paid path. Unit tests missed it because the stub was authored to match the parser's assumption.
2. **Provider ordering inverted** — `composeState` sorts by `(a.position || 0)`, so an unset position sorts to `0`, ahead of `MACRO_SENTIMENT` at 50. News rendered before the macro framing it belongs under. (Core still has this — tracked.)
3. **Stale action attribution** — `soleRunIn` blocked *new* attribution when a room turned ambiguous, but an action attributed while the room was solo was never cleared, so later thoughts inherited a finished action. Wrong attribution that looks right, in a paid-for MessageFile.
4. **Heading drift** — oracle said `(Warm Cache)`, core says `(Local Ledger)`, for the same shared table.
5. **`BrainService` built its own `pg.Pool`** — no TLS, no timeouts, raw Pool where the Brain requires a drizzle instance. Rearchitected as a host-injected adapter; bundle 2.04 MB → 0.50 MB.

### Pushed back on (with evidence)

- **`paths` requires `baseUrl`** — false since TS 4.1; repo is on 5.9.3. Verified empirically: removing `paths` breaks declaration generation, restoring it fixes it.
- **Leading newline in the news template** — core opens identically; removing it would *create* divergence.
- **Add a dedup guard to `MACRO_SENTIMENT`** — the stated harm cannot occur (`composeState` keys text by provider name, one entry each), core has no such guard so it would create divergence, and the existing guard can *drop* context: a fresh `EMPTY` overwrites the cached result and `orderedTexts` skips empty strings. Logged against CU-86d3yg0z9 as a hazard in **both** bodies.

## Test-quality issues found by review, not by the suite

- Circular test: stub authored to match the parser's wrong assumption.
- Vacuous guard: matched a bare package name satisfied by the file's own description string.
- Vacuous scope guard: `pluginDirs()` → `[]` made the assertion pass having scanned nothing.
- Vacuous leak test: `loadOracle` per call gave a fresh singleton — **proven** by mutating `finish()` and watching the old test still pass.
- False green: stub emitted `ACTION_STARTED` but never `ACTION_COMPLETED`, and the assertion only checked `.description`.

## Validation

| Check | Result |
|---|---|
| Oracle suite | 289 passing / 0 failing |
| CI | pass |
| CodeQL / Analyze | pass |
| Lint | pass |
| Mergeable | MERGEABLE (blocked only by a stale `CHANGES_REQUESTED` whose points are all closed) |
| Base-testnet smoke | **not re-run** — see below |

## Outstanding

- **Stale blocking review** — `claude[bot]` CHANGES_REQUESTED from round 4; every point closed in `cabc170`. Dismissal was denied by the permission classifier; needs admin action.
- **CU-86d3yg0z9** — move headings/positions into the Brain, fix core's ordering, short-TTL memo for the duplicate warm-cache reads, and the `MARKET_INTELLIGENCE_INJECTED` overwrite hazard.
- **CU-86d3ydvxq** — model-cited attribution (deferred).
- **Phase D** — on-demand fetch with write-through on a cache miss, as its own PR.
- **Base-testnet smoke has not been re-run against this branch.** Every provider/provenance assertion here is unit-level; the shape of `state.data.providers` was verified by reading `@elizaos/core` 1.7.2's compiled source, not by observing a live run. That is the one gap review cannot close.
