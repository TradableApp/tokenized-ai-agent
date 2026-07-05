# PR Review: #40 — Feat(oracle): __E2E_DROP__ sentinel + orphaned-conversation backstop [CU-86d3bawhh]
**Reviewed**: 2026-06-14 · **Author**: GarrickBrown · **Branch**: feat/e2e-drop-sentinel_CU-86d3bawhh → main
**Decision**: APPROVE with comments (fixes applied)

## Bot-comment triage
| # | Bot | Verdict | Reply summary | Propagation |
|---|-----|---------|---------------|-------------|
| aiAgentOracle.js:1046 redundant getNetwork | claude[bot] | AGREE | Hoisted chainId to one fetch, shared by guard + init block (commit a017704) | none |
| shouldInitializeConversation undefined arg | claude[bot] | AGREE (doc route, not throw) | Tightened JSDoc (REQUIRED on orphan path) + pinned behaviour (a017704) | none |
| missing undefined-arg test | claude[bot] | AGREE | Added the test (a017704) | none |

Copilot: quota-blocked.

## Own findings
### CRITICAL / HIGH / MEDIUM / LOW
None beyond the bot findings (all addressed). The `__E2E_DROP__` early-return is correctly MOCK_AI-gated (prod-safe) and exits before any storage/AI work; the backstop reuses the existing `queryTransactionByTags` key-file pattern and only runs the lookup on the rare orphan-risk path.

## Propagation follow-ups
None.

## Validation
| Check | Result |
|---|---|
| oracle suite (bun run test) | Pass (171) |
| solhint | Pass |
| e2e (cancel resend-after-cancel, refunds stuck-prompt) | Pass on fresh stacks |
| CI (CI/Analyze/CodeQL/claude-review) | Pass (re-running after fix push) |

## Files reviewed
Modified: oracle/src/aiAgentOracle.js, oracle/test/aiAgentOracle.test.js.
