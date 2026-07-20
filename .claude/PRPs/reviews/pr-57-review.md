# PR Review: #57 — Base-testnet post-deploy smoke/canary script
**Reviewed**: 2026-07-12 · **Author**: Garrick · **Branch**: test/oracle-base-testnet-smoke_CU-86d3dwme6 → main
**Decision**: APPROVE (fixes applied)

## Bot-comment triage
| # | Bot | Verdict | Reply summary | Propagation |
|---|-----|---------|---------------|-------------|
| smoke.js:204 | claude[bot] | AGREE 🔴 (fixed c1c48e3) | Fixed eth_getLogs range: public Base Sepolia RPC caps at ~2000 blocks; the [head-5000,head] window would reject every poll → always time out. Now anchors fromBlock=rc.blockNumber, advances each poll | none |
| smoke.js:105 | claude[bot] | AGREE 🟡 (fixed c1c48e3) | fetchEncrypted now throws a clear "unexpected JSON shape" error instead of passing raw JSON to aesGcmDecrypt (misleading GCM error) | none |

Copilot: quota-blocked — no review.

## Own findings
### CRITICAL/HIGH/MEDIUM/LOW: None beyond the bot's two (both fixed).
Test-only tooling. Crypto boundaries round-trip-verified against the oracle's src/ecies.js; flow matches the mapped prod path (approve→setSpendingLimit→initiatePrompt→AnswerMessageAdded→fetch→decrypt→assert reasoning/sources). BigInt/allowance math correct; named-arg event parsing robust.

## Validation
| Check | Result |
|---|---|
| node --check (syntax) | Pass |
| prettier | clean |
| crypto round-trip self-test | Pass (ECIES + AES wire-compatible with oracle) |
| loads/requires resolve | Pass |
| contract/event/storage paths | exercised only against the live deployment |
| mergeable | to re-confirm on c1c48e3 |

## Files reviewed
- Added: oracle/scripts/base-testnet-smoke.js
- Modified: oracle/package.json (smoke:base-testnet script)
