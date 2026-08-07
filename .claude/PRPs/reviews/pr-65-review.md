# PR Review: #65 — Feat(Oracle): answer path — tool payloads can no longer be the answer

**Reviewed**: 2026-08-07 · **Author**: GarrickBrown · **Branch**: `feat/oracle-answer-synthesis_CU-86d3z0r81` → `main`
**Decision**: APPROVE (fixes applied) · **Task**: [CU-86d3z0r81](https://app.clickup.com/t/86d3z0r81)
**Bot rounds**: 6 completed (`31144285017`, `31145323134`, `31146031084`, `31146663456`, `31147278160`, `31147891087`), all `success` — 19 findings total

## Convergence

| round | findings | production changes | note |
|---|---|---|---|
| 1 | 4 | 3 | latent fence conflict vs `chainSynthesisTemplate` (real, verified) |
| 2 | 3 | 3 | budget re-anchor, `/g` regex state, misleading log |
| 3 | 3 | 3 | unguarded `.substring()` in `onResponse`, widened pattern, incident comment |
| 4 | 3 | 2 | uppercase-object gap; `console.error` detector — 1 declined (parity) |
| 5 | 3 | 1 | raw-JSON payloads — 2 declined/observation |
| 6 | 3 | **0** | 1 already mitigated, 1 premise false (test added), 1 declined (parity) |

Called converged at round 6: zero production changes, and the remaining findings were the same
class already declined twice (core-parity cosmetics). Severity and novelty fell monotonically.

## Bot-comment triage (round 1)

| # | Bot | Verdict | Reply summary | Propagation |
|---|-----|---------|---------------|-------------|
| 3733250821 | claude[bot] | **AGREE** (fixed `da8bdb5`) | 🔴 `looksLikeToolPayload` rejected any text containing a fence, while `chainSynthesisTemplate` instructs the model to fence code — a real answer quoting an API call would be swapped for the acknowledgement. Verified empirically before fixing. Took a different remedy than suggested: `stripped.length < 400` makes the verdict depend on payload *length*; instead strip the code and ask whether prose remains (`MIN_PROSE_CHARS = 24`). | Found a second bug while fixing: `BARE_INVOCATION`'s greedy argument body matched first `{` to last `}`, so one quoted call swallowed all following prose. Now lazy + regression test. |
| 3733251351 | claude[bot] | **PARTIAL** (fixed on the other side) | Same bug, other file. Agreed on the bug; **declined** the "remove the code-block instruction from the template" option — that template is core's verbatim text and Phase 3 extracts it into a package shared with `sense-ai-core`. Absorbed the difference in `answerSelection.js`, which is oracle-only and has no core counterpart. | Reinforces the §2.7 parity rule: divergences belong in oracle-only code, never inside the shared surface. |
| 3733251961 | claude[bot] | **PARTIAL** (fixed `da8bdb5`) | 🟡 Source-inspection assertion was shape-brittle — agreed, removed. **Declined** deleting outright: `generateSanitized` retries once, so worst case is two full deadlines, and nothing else pins that product. Replaced with `SYNTHESIS_TIMEOUT_MS * 2 <= 90_000` (currently exactly at the ceiling). Recorded *why* wiring is not asserted so no one re-adds a source check. | — |
| 3733252838 | claude[bot] | **AGREE** (fixed `da8bdb5`) | 🟡 Integration test only covered the two-emission incident; flipping `prose[last]` → `prose[0]` would keep it green while dropping every synthesis. Added the three-emission fixture. | Added at **both** levels — `answerSelection.test.js` needs its own variant where the synthesis itself contains a fence (the finding-#1 case), which ordering alone would not catch. |

Copilot returned quota-limit stubs on both reviews — no reviewable content.

## Own findings

### CRITICAL / HIGH
None.

### MEDIUM
- **Post-PR-B smoke gate cannot close the substance ACs.** `handleChainSynthesis` is not exported from `plugin-senseai/src/index.ts` and so is absent from the built bundle (`grep -c … dist/index.js` → 0). Correct staging, but the plan's gate between B and C would run against a TEE with no synthesis wired: it proves "no payload stored", not "synthesised prose". AC 1 / AC 2 / AC 6 stay open until a second deploy after PR C. **Plan updated** to say so explicitly.

### LOW
- ClickUp task still lists "Add the messageHandlerTemplate override" as an Action Step — a premise disproven during this work (core has no `templates` key at all). Corrected on the task so it is not re-attempted.
- Action Steps / Acceptance Criteria are description text, not real checklists, so `/merged` has nothing to tick on a four-PR task.

### Acknowledged, not actioned
- `new Promise(async (resolve, reject) => …)` in `queryElizaOS` — **pre-existing**, correctly flagged by the bot. Deferred to PR C, which rewrites that function anyway.

## Acceptance criteria — PR A of four

| # | Criterion | PR A |
|---|---|---|
| 1 | CALL_MCP_TOOL returns synthesised prose, never a payload | Partial — payload half done; prose half is PR C |
| 2 | Acknowledgement is never the final answer | Partial — ordering pinned; ack remains the only prose until analytical actions exist |
| 3 | `reasoning[]` / `sources[]` still populate | Pass |
| 4 | No Telegram/X code; omissions recorded | Pass (incl. 1.3's removal-with-reason) |
| 5 | Smoke fails on code-fenced / apology-shaped answers | PR B |
| 6 | Base-testnet smoke passes on substance | After PR C |
| 7 | Oracle suite green | Pass |

## Validation

| Check | Result |
|---|---|
| Oracle mocha (`bun run test`) | Pass — 304 |
| plugin-senseai (`bun test`) | Pass — 17 (helper 100% funcs / 98.96% lines) |
| Contract suite (root) | Pass — 209 |
| plugin-senseai build | Pass |
| CI / Analyze / CodeQL | Pass |
| Mergeable | `MERGEABLE` / `BLOCKED` — branch protection awaiting an approving review only |
| Root lint (solhint) | Pass |
| `oracle` eslint | Pre-existing failure (resolves into the copied Brain `dist`); not in CI, untouched here |

## Files reviewed

Modified: `oracle/src/aiAgentOracle.js`, `oracle/src/answerSelection.js`, `oracle/test/answerSelection.test.js`, `oracle/test/queryElizaOS.test.js`, `.github/workflows/ci.yml`, `.claude/PRPs/plans/oracle-harness-port.md`
Added: `plugin-senseai/src/utils/{actionChainHelper,withTimeout,retryNudges}.ts`, `plugin-senseai/src/__tests__/{actionChainHelper,withTimeout}.test.ts`
Deleted: `oracle/src/answerSynthesis.js`, `oracle/test/answerSynthesis.test.js` (divergent reimplementation, never wired)
