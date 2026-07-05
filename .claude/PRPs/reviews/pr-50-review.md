# PR Review: #50 — Chore(Oracle): Phase 3 — ElizaOS 1.7.2 + version alignment + multi-stage Docker image [CU-86d3dwme6]
**Reviewed**: 2026-07-05 · **Author**: GarrickBrown · **Branch**: feat/oracle-phase3-reconcile_CU-86d3dwme6 → main
**Decision**: APPROVE (fixes applied) — approval to clipboard once CI confirms on 5c46872

## Bot-comment triage
| # | Bot | Verdict | Reply summary | Commit |
|---|-----|---------|---------------|--------|
| 1 | Copilot (npm install not reproducible) | AGREE | Builder now copies bun.lock and installs with `bun install --frozen-lockfile --production` (bun.lock is the repo-canonical lockfile; no package-lock exists) | 5c46872 |
| 2 | Copilot (zod resolutions disagree with bump) | AGREE | Fixed with #3 — pin removed, range → ^4.3.5 | 5c46872 |
| 3 | claude[bot] 🔴 (stale resolutions no-ops the bump; violates core@1.7.2's ^4.3.5) | AGREE | Sharpest catch: resolutions REMOVED, plugin + oracle root declare ^4.3.5, resolves 4.4.3, plugin dist rebuilt. Residual 4.1.13 lockfile strings = transitive RANGE declarations under plugin-ollama/openai, satisfied by 4.4.3. Brain's ^4.2.1 range includes 4.4.3 | 5c46872 |
| 4 | claude[bot] note (ci.yml prepare:brain "before Docker build" redundant) | PARTIAL | Corrected mechanism in PR comment: ci.yml has no Docker step — prepare:brain feeds the oracle INSTALL (bun copies the path dep, dist must pre-exist). Still load-bearing; stays | — |

## Own findings
None beyond the above. claude[bot] independently verified the stage-2 symlink-target alignment and the hoisting of stripped sub-package deps — matches my Phase-2/3 design notes.

## Validation
| Check | Result |
|---|---|
| bun run test (oracle) | Pass (192/192) on zod 4.4.3 + ElizaOS 1.7.2 |
| docker build (full, clean store) | Pass — 1.43GB, frozen-lockfile install |
| In-container smokes | Pass (brainContext + brain dist + plugin dist resolve in the runner) |
| Mergeable | MERGEABLE (BLOCKED = required review) |

## Files reviewed
- Modified: Dockerfile.oracle (multi-stage), oracle/package.json + bun.lock, plugin package.json + bun.lock (zod unpin), root package.json scripts, scripts/release-mainnet.sh
