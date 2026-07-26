# PR Review: #58 — Chore(Oracle): Base-testnet ROFL deploy — isolated agent DB, plugin-sql migration, Gemini model fix

**Reviewed**: 2026-07-26 · **Author**: GarrickBrown · **Branch**: `chore/oracle-base-testnet-deploy_CU-86d3dwme6` → `main`
**Mode**: trigger-bot + fix (up to 3 rounds) · **Decision**: APPROVE (fixes applied)
**ClickUp**: EPIC CU-86d3dwme6 (Oracle Brain migration, *in development*) — this PR delivers **Phase 5** ("Deploy: testnet ROFL first → mainnet"). Sibling `CU-86d33q07r` closed on this work.

## Scope check against the epic

| Epic requirement | Status |
|---|---|
| Oracle adopts Cloud SQL (retire PGLite) | ✅ dedicated `oracle_agent` DB; PGLite now only a localnet/e2e fallback |
| One warm cache — oracle **reads** per prompt, no inline TEE fetch | ✅ `brainContext` unchanged in that respect; read-only |
| Brain populates real `reasoning[]`/`sources[]` (closes CU-86d3cfa41) | ✅ proven by exit-0 smoke: `reasoning=1 sources=6` |
| **Preserve** `MOCK_AI` + `__E2E_*__` sentinels (e2e depends on them) | ✅ verified — all sentinel tests pass (delay/drop/reasoning + MOCK_AI wiring) |
| Testnet first, mainnet later (trust-root footgun) | ✅ base-mainnet env scaffolded only; no mainnet deploy |

## Bot-comment triage — Round 1 (run `30224199739`, completed/success)

| # | Bot | Finding | Verdict | Resolution |
|---|-----|---------|---------|------------|
| 1 | claude[bot] | `brainContext.js:71` — `bootstrapPostgresFromEnv` unconditionally stamps `process.env.POSTGRES_URL`, clobbering the agent-DB url | **AGREE** | `writeEnv: false` option + brainContext opts out — `e6a5d0a` |
| 2 | claude[bot] | `agentSchemaMigrator.js:58` — migration adapter never closed → leaked pool | **DISAGREE** | Pushed back with source evidence; not implemented |
| 3 | claude[bot] | `aiAgentOracle.js:173` — catch silently falls back to PGLite on real misconfiguration | **AGREE (corrected guard)** | Now fatal, gated on new shared `isPostgresConfigured()` — `e6a5d0a` |
| 4 | claude[bot] | `rofl-set-secrets.sh:117` — `awk -F'#'` truncates secrets containing `#` | **AGREE** | Strips only whitespace-preceded ` # ` + `pipefail` — `e6a5d0a` |

### Why #2 was pushed back (evidence)

The bot's premise — "the migration adapter is separate from the runtime adapter" — does not hold for the installed `@elizaos/plugin-sql`:

- `dist/node/index.node.js:21110` — `managerKey = "default"`, reassigned only when `ENABLE_DATA_ISOLATION=true` (not set here)
- `:21124` — `fullManagerKey = "default:pg"` — **not** url- or agentId-derived
- `:21125-21142` — that key indexes a **global singleton** map; on a hit the cached manager is returned and `config.postgresUrl` is **ignored**
- `:15774` — `PgDatabaseAdapter.close()` → `this.manager.close()` — closes the *shared* manager

Therefore the runtime **reuses** the migrator's manager (no second pool, nothing orphaned), and `close()` would tear down the pool the runtime is about to reuse, forcing a reconnect through the `isClosed()` → recreate path — which re-reads `process.env.POSTGRES_URL` and would have partially re-armed finding #1.

**Load-bearing corollary:** because the manager is keyed `"default:pg"` and first-caller-wins, running the migrator *before* `new ElizaOS()` is what guarantees the agent runtime lands on `oracle_agent`. Revisit on a plugin-sql upgrade — if `managerKey` becomes url-derived, finding #2 becomes correct.

## Own findings

### HIGH
None.

### MEDIUM
1. **`secret_exists` block-bounding was wrong** (`scripts/rofl-set-secrets.sh:181`) — reset only on a column-0 key, but sibling deployments are 2-space indented, so the scan ran past the target deployment. A secret present **only** in another deployment reported as existing. Proven with a synthetic manifest (old awk → `true` for a mainnet-only key while scanning base-testnet; fixed → empty). Impact was benign (spurious no-op `rm`), but the script's two block scanners disagreed — `list_onchain_secret_names` already bounded correctly. **Fixed `aa6481a`.**
2. **Duplicated Postgres-configured check** — `brainContext` had copy-pasted the base-keys + cert-pairs test that `postgresBootstrap` owns. Consolidated into the exported `isPostgresConfigured()` so the two cannot drift. **Fixed `e6a5d0a`.**

### LOW (accepted / not changed)
3. **PART 4 purge is destructive with no dry-run** — any on-chain secret not in the KEEP set is removed, so a secret added out-of-band is silently deleted on the next `rofl:set`. This is the intended "env files are the single source of truth" design and externally-managed Cloud-SQL keys are protected, so accepted as-is. A `--dry-run` flag would be a reasonable future affordance.
4. **ollama pinned by tag, not digest** (`ollama/ollama:0.9.6`) — a tag is mutable, so the TEE image isn't byte-reproducible. Already tracked as sibling subtask **CU-86d3t1137** ("slim CPU-only ollama + digest pin for mainnet"), so deliberately out of scope here.
5. **`compose.yaml` is a tracked build artifact** — `rofl:build:<env>` does `cp compose.<env>.yaml compose.yaml`, so the tracked file is whatever env was last built and the tree goes dirty after every build. Excluded from this PR deliberately; `.gitignore`-ing it is a candidate follow-up.

## Propagation follow-ups

- **Toolchain alignment epic** — `oracle`'s `"lint": "eslint ."` is rotten (no eslint config exists anywhere in the repo) and CI gates **no** JS lint/format/typecheck. 92 files fail `prettier --check` repo-wide. Recommendation: standardise JS/TS on **Biome** (matching `sense-ai-core`/`sense-ai-brain`), keep solhint+prettier for Solidity, add the org-mandated `Lint`/`Typecheck` steps. Tracked for Omni-FI as Task 1.43/1.44; Tradable equivalent still to be raised.
- **`sense-ai-core` agent-DB equity** — move core's agent tables to a dedicated DB so `senseai` becomes a pure shared cache (symmetry with this PR; mainnet-risky).
- **`OLLAMA_API_ENDPOINT` vs `OLLAMA_URL`** — the ollama ElizaOS plugin is gated on `OLLAMA_API_ENDPOINT`, which is never set (only `OLLAMA_URL`). Non-blocking: ElizaOS uses Google GenAI; ollama serves only intent classification + the final local fallback.

## Validation

| Check | Result |
|---|---|
| Oracle tests | ✅ **203 passing** (201 → +2 for `writeEnv`) |
| Contracts compile / test / solhint | ✅ via CI (untouched by this PR) |
| CI (GitHub) | ✅ SUCCESS on the fix commit |
| CodeQL / Analyze | ✅ SUCCESS |
| Shell syntax (`rofl-set-secrets.sh`) | ✅ parses clean |
| `#`-in-secret behaviour | ✅ `p@ss#word  # comment` → `p@ss#word` |
| `secret_exists` scoping | ✅ synthetic probe: no cross-deployment leak |
| Sentinel preservation (epic AC) | ✅ delay/drop/reasoning + MOCK_AI wiring tests pass |
| Mergeable | ✅ MERGEABLE (needs approval; zero overlap with merged #57) |
| Real-world | ✅ clean TEE boot + end-to-end **exit-0** smoke |

## Files reviewed

**Added**: `oracle/src/agentSchemaMigrator.js`, `oracle/test/agentSchemaMigrator.test.js`, `.claude/PRPs/plans/brain-powerhouse-two-bodies.md`, `.claude/PRPs/plans/oracle-base-testnet-deploy-runbook.md`, `.claude/PRPs/reviews/pr-56-review.md`, `.claude/PRPs/reviews/pr-57-review.md`
**Modified**: `oracle/src/aiAgentOracle.js`, `oracle/src/brainContext.js`, `oracle/src/postgresBootstrap.js`, `oracle/test/postgresBootstrap.test.js`, `oracle/test/aiAgentOracle.test.js`, `oracle/.env.oracle.example`, `oracle/.env.oracle.base-localnet.example`, `Dockerfile.oracle`, `package.json`, `rofl.yaml`, `scripts/rofl-set-secrets.sh`, `scripts/rofl-init-cloud-sql.sh`
