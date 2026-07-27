# PR Review: #56 — real-Brain integration test against a seeded warm cache
**Reviewed**: 2026-07-12 · **Author**: Garrick · **Branch**: test/oracle-real-brain-integration_CU-86d3dwme6 → main
**Decision**: APPROVE (fixes applied)

## Bot-comment triage
| # | Bot | Verdict | Reply summary | Propagation |
|---|-----|---------|---------------|-------------|
| integration.test.js:57 | claude[bot] | AGREE (fixed 1c1cfca) | Stub now records observedLimits; test asserts macro=1 / news=6 → real regression guard on the read shape | none |
| integration.test.js:35 | claude[bot] | AGREE (fixed 1c1cfca) | Extracted clearPostgresEnv/setFullPostgresEnv → test/helpers/postgresTestEnv.js; applied to BOTH brainContext.test.js + integration test | Applied across both call sites (consistency rule) |
| integration.test.js:89 | claude[bot] | PARTIAL (fixed 1c1cfca) | Added before() guard that throws a clear actionable error on missing Brain dist — deliberately NOT this.skip() (a broken dist in CI must fail, not silently skip) | none |

Copilot: no review (quota limit) — nothing to triage.

## Own findings
### CRITICAL / HIGH / MEDIUM / LOW: None
Test-only PR; no production code changed. After the fixes both test files share one env helper (DRY), the stub asserts query limits, and the suite fails loudly if the Brain dist is absent.

## Validation
| Check | Result |
|---|---|
| brainContext unit + integration | 10/10 pass |
| full oracle suite | 195 passing |
| prettier | clean (3 files) |
| mergeable | to re-confirm after CI on 1c1cfca |

## Files reviewed
- Added: oracle/test/brainContext.integration.test.js, oracle/test/helpers/postgresTestEnv.js
- Modified: oracle/test/brainContext.test.js (uses shared helper)

---
## Rounds 2 & 3 (after re-triggering the label)
**Round 2** (aa741b3) — 3 comments, all applied:
- 🔴 routing fragility → observedRequests guard asserts the WHERE-less read served macro / isNotNull read served news.
- before() incomplete → shape-checks the dist exports.
- tests 2/3 skipped the limit guard → added (corrected the premise: reads ARE issued on the empty path).

**Round 3** (b0e8953) — 2 comments, both applied:
- before() missed getLatestMacro (instance method) → added SentimentEngine.prototype.getLatestMacro check.
- observedRequests order-coupling (informational) → made order-independent via sort(); kills the flake, keeps the misroute guard.

Final: all comments across 3 rounds resolved in-thread. Full oracle suite 195 passing; CI + Analyze + CodeQL green; MERGEABLE. Note: b0e8953 dismissed any prior approval — fresh approval needed.
