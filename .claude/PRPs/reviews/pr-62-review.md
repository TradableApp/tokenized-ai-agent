# PR Review: #62 — Refactor(Oracle): delete the social-only plugin fork

**Reviewed**: 2026-08-05 · **Author**: GarrickBrown · **Branch**: `refactor/oracle-thin-brain-wrapper_CU-86d3ud1va` → `main`
**Decision**: APPROVE (fixes applied) · **Task**: CU-86d3ud1va (epic CU-86d3dwme6)

## Bot-comment triage

| # | Bot | Verdict | Reply summary | Propagation |
|---|-----|---------|---------------|-------------|
| 1 | Copilot | AGREE (most valuable) | Comment-stripping regex `(^\|[^:])//.*$` could cut inside a string literal and **silently hide** a Telegram reference. Fixed line-based (`905d38b`) rather than with the suggested state machine: drops comment LINES only, so the failure mode is removed rather than narrowed, and a trailing comment now fails **loud** instead of silent. Proven: old regex leaves `const evade = "a ` and misses; new one flags. | none — single guard |
| 2 | claude[bot] | AGREE | Scan collected only `.ts`, so a plain-JS helper was invisible to a guard promising "every plugin directory". Widened to `.ts/.tsx/.js/.jsx/.mjs/.cjs` (`905d38b`). Proven by planting `legacyHelper.js`. | none |
| 3 | claude[bot] | AGREE | Scaffolding message said "make it referenced", which the check cannot satisfy — it is a filename sentinel, not a liveness check. Now says **rename**, and states the limitation plainly (`905d38b`). | none |

Tally: **3 agreed / elaborated, 0 pushed back, 0 partial.** All replied in-thread.

## Own findings

### CRITICAL
None.

### HIGH
None.

### MEDIUM — fixed in `e3e92e7`
- **Guard was weaker than its own acceptance criterion.** AC reads "no Telegram/**X**/social-only code"; the guard matched `/telegram/i` only. sense-ai-core carries `plugin-twitter-senseai`, so an X-coupled fork could have landed while the guard reported success. Now `/telegram|twitter/i`, proven by planting a twitter reference. Test renamed to state what it checks.

### LOW — noted, not fixed
- **CI never builds the plugin.** The workflow runs `prepare:brain` → `cd oracle && bun install` → `cd oracle && bun run test`; there is no plugin build step. Tests pass because `aiAgentOracle.test.js` stubs the dist via `proxyquire.noCallThru()` (`"./elizaos/plugins/plugin-senseai/dist/index.js": { default: {} }`). Consequence: **a broken plugin build would not be caught by CI**. Verified locally instead (build + plain-Node require). Pre-existing, not introduced here.
- **`cd oracle && bun run lint` fails** once the Brain dist exists — eslint walks into `packages/sense-ai-brain/dist`, which has no config. CI never runs oracle lint (it lints only the contracts root, before `prepare:brain`), so this is latent and pre-existing.

## Acceptance-criteria mapping

| AC | Status |
|---|---|
| No TODO/mock data in any oracle plugin action; `getSentimentAction` returns real Brain analysis | **Partial** — the mock is deleted; the Brain-backed replacement is part 2 |
| plugin-senseai imports the Brain and contains **no Telegram/X/social-only code** | **Half** — no Telegram/X ✅ (guarded); imports the Brain ❌ (part 2) |
| Uncached-asset prompt returns real analysis within the timeout | Not started (Phase D) |
| Periodic fetching remains core's job only | Holds — oracle schedules nothing |
| Shared logic in the Brain, no duplication | Advanced — 2,576 duplicated lines removed |
| Base-testnet smoke green | Not started (Phase E) |

The third guard assertion (*consumes the shared Brain*) is deliberately **held back** to part 2 rather than landing knowingly-red on `main`.

## Verified rather than assumed

- The dist is **gitignored and untracked** (0 tracked files) — no stale build ships the deleted code.
- **No dangling references** to the deleted modules anywhere in `oracle/src` (only build output and this PR's own comments match).
- Plugin builds; plain `node` can `require("./dist/index.js")` as `aiAgentOracle.js:20` does, returning `name=senseai` with empty arrays.

## Validation

| Check | Result |
|---|---|
| Oracle test suite | **Pass** — 221 passing / 0 failing |
| Scope guards, RED before / GREEN after | **Pass** — both, plus 3 mutation proofs |
| Plugin build + plain-Node require | **Pass** |
| CI / Analyze / CodeQL | **Pass** |
| Mergeability | **MERGEABLE / CLEAN** |
| Oracle lint | **Skipped** — pre-existing failure, not run by CI (see LOW) |

## Files reviewed

Deleted (16): 5 actions, 2 providers, `rateLimit` service, `usageTracker` evaluator, `getSentimentAction`, `plugin.ts`, and 3 `__tests__` files.
Modified: `plugin-senseai/src/index.ts` (→ registration shell).
Added: `oracle/test/pluginSenseaiScope.test.js`.
