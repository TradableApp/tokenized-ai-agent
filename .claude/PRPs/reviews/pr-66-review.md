# PR Review: #66 — Fail at boot, and make the smoke judge substance

**Reviewed**: 2026-08-07 · **Branch**: `feat/oracle-startup-guard-smoke_CU-86d3z0r81` → `main`
**Decision**: APPROVE (fixes applied) · **Task**: [CU-86d3z0r81](https://app.clickup.com/t/86d3z0r81)
**Bot rounds**: 7, all `success` — 20 findings, 18 fixed, 2 declined/documented

## Convergence

| round | findings | severity | production changes |
|---|---|---|---|
| 1 | 2 | 🔴🟡 | 2 — invented storage taxonomy; apology threshold |
| 2 | 2 | 🔴🟡 | 2 — guard ran after the crashing module; digit proxy |
| 3 | 3 | 🔴🟡🟣 | 3 — trimmed-vs-raw validation; curly apostrophe; Sentry ordering |
| 4 | 3 | 🔴🔴🟡 | 3 — ConfigError→Sentry; FILLER apostrophe; test env leak |
| 5 | 3 | 🔴🟡🟡 | 3 — duplicate guard call; placeholder creds; `SMOKE_ASSET=""` |
| 6 | 3 | 🟡×3 | 3 — placeholder message; NETWORK_NAME allowlist; known-limit test |
| 7 | 3 | 🟡×3 | 2 + 1 comment — LOCAL_IPFS bypass; bare placeholder; coupling note |

**Stopped after round 7.** Severity fell monotonically: 🔴s through round 5, none in 6–7, and the
last round's third finding was a request for a comment. Marginal value per round no longer
justified the cost. Every round produced *some* change because the surface kept moving — waiting
for a zero-change round would have been waiting for an asymptote, not a signal.

## Findings that were real bugs, not polish

- **Invented storage taxonomy** (r1) — the guard mapped providers to credentials from a plausible
  guess rather than `storage.js`. A deployment with *no* storage credentials started cleanly, the
  exact failure the module exists to prevent.
- **Guard ran after the module that crashes** (r2) — `aiAgentOracle` constructs an ethers Wallet at
  module scope, so a bad key threw during `require`, before any guard in `start()`. Moved to
  `index.js` ahead of the require.
- **Validated trimmed, consumed raw** (r3) — `contractUtility` passes `process.env` straight into
  `new ethers.Wallet()`/`new ethers.Contract()`. Validating a trimmed copy approved bytes the
  consumer then rejects. Applied to the address too, which had the same hole.
- **ConfigError filed a Sentry incident** (r4) — the guard's *expected* failure mode was routed to
  crash reporting. Every TEE deploy typo would have paged.
- **`NETWORK_NAME` allowlist caught a wrong fixture** (r6) — the suite had been passing
  `base-testnet`; deployed compose files use `baseSepolia`/`base` (the `RPC_URL_MAP` keys).
- **`LOCAL_IPFS_API_URL` bypass** (r7) — `initializeStorage` has three exits, not two; the guard
  refused a localnet-against-real-IPFS config that `storage.js` handles fine.

## Declined / documented rather than fixed

- **Verbose refusal passes the smoke** — documented as a named `KNOWN LIMIT` test. Separating it
  from "thorough answer that declines" needs to judge meaning; every cheap proxy fails real
  answers, and a false smoke failure gets the smoke muted. Phase 2 is the real fix.
- **`requiredStorageCredentials` hand-mirrors `storage.js`** — comment added. Cannot be imported
  like `SUPPORTED_NETWORKS` because the branching is side effects, not data.

## Validation

| Check | Result |
|---|---|
| Oracle mocha | Pass — 344 |
| plugin-senseai | Pass — 17 |
| Contract suite | Pass — 209 |
| CI / Analyze / CodeQL | Pass |
| Mutation check | All 3 recorded failures pass the OLD smoke, fail the new one |

## Deploy scope

`handleChainSynthesis` is still not exported from the plugin index, so the deploy after this PR
proves **"no payload is ever stored"** only. AC 1, 2 and 6 need a second deploy after PR C.
