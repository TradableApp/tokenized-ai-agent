# Plan: Oracle Brain Migration — extract the SenseAI "Brain" into a shared package and wire it into the on-chain oracle

**Status:** PLANNED — awaiting confirmation. Investigation done 2026-06-21 (3 cross-repo audits).
**Repos:** new `sense-ai-brain` (shared package, git submodule) · `sense-ai-core` (source / Social body) · `tokenized-ai-agent/oracle` (target / Oracle body) · `sense-ai-shared-schema` (existing shared submodule — the template).
**ClickUp epic:** CU-86d3dwme6. **Sequencing:** this precedes the oracle's multi-stage Dockerfile (CU-… ) — the migration balloons the oracle image, which is when multi-stage earns its keep.

## Problem / why
"One Brain, Two Bodies": the **Social body** (`sense-ai-core`, TG/X) has the full analytical SenseAI; the **Oracle body** (`tokenized-ai-agent/oracle`, the ROFL TEE that answers dApp prompts) runs a **stale, stubbed ElizaOS** — its `plugin-senseai` is a QuickStart template (`QUICK_ACTION` hello-world, `QUICK_PROVIDER` placeholder, mocked models), and `queryAIModel`/`queryElizaOS` inject **no analytical context** (raw history → model). The dApp's SenseAI therefore has none of the social agent's "super powers." Copy-migrating again just resets the **drift clock** (the oracle already forked an old sense-ai-core and went stale). Fix the root cause: a **shared Brain**.

## Architecture decision (the crux)
**Extract the analytical Brain into a framework-agnostic shared library `@tradableapp/sense-ai-brain`, consumed by both bodies via the git-submodule + `file:` path pattern already proven by `sense-ai-shared-schema`.** NOT a second fork into the oracle, and NOT a single ElizaOS plugin both load.

- **Why framework-agnostic lib (not an ElizaOS plugin):** the bodies diverge — `sense-ai-core` is Bun + ESM + full ElizaOS runtime (rooms/memory/actions); the oracle is Node + CommonJS, uses ElizaOS only for inference, is stateless per prompt, and has version skew (`@elizaos/core` 1.7.2 vs 1.7.0; `plugin-mcp` ~1.8.2 vs 1.7.0). A library whose core logic has **no `@elizaos` imports** (takes a minimal `BrainContext` = `{ db, getSetting, logger }`) sidesteps all of that. Each body adds a **thin adapter** (an ElizaOS provider in core; an oracle provider in the oracle).
- ADR-0001 (tokenized-ai-agent/docs/decisions) to be written in Phase 0 capturing this.

### Brain vs Social boundary (from the sense-ai-core audit)
**MOVE to `sense-ai-brain` (portable, ~60%, low ElizaOS coupling):**
- `SentimentService`, `MarketNewsService` (refactor off `IAgentRuntime` task-workers → `BrainContext`)
- All sentiment adapters (`ISentimentAdapter`: Santiment, CMC-macro, CFGI) + news adapters (`INewsAdapter`: CoinDesk, CoinGecko, CryptoPanic, CryptoRank)
- The DATA logic of `marketIntelligenceProvider` + `macroSentimentProvider` (read-only DB queries)
- Pure utils: `sanitizeOutboundText`, `generateSanitized`
- Types: `AssetSentimentMetrics`, `GlobalMacroData`, `NewsItem`, etc.

**STAYS in sense-ai-core (Social, ~40%):** `BroadcastService`, `RateLimitService` (TG UX), `TelegramUxService`, `DailySummaryService` (Slack), `accessProvider`, `imageDetectionProvider`, `usageInfoProvider`, `handleMenuCallback`/`showMenu`/`launchApp`, `actionChainHelper`, `telegramUtils`, `usageTracker` evaluator, the kill-switch flags.

**MIXED (split):** the analytical actions (`analyzeAssetSentiment`, `getNewsDetails`, `analyzeFinancialImage`) — Brain provides the data fetch; the LLM **synthesis** stays per-body (core uses `actionChainHelper`; the oracle synthesizes in `queryElizaOS`). Likewise `RateLimitService` → split `QuotaManager` (Brain/portable) from the Telegram denial-message UX (stays).

### The shared cache (key design point)
The Brain caches sentiment/news/macro into **`sense-ai-shared-schema` tables in the shared Cloud SQL Postgres**. Decision: **one warm cache.** The Social body's existing background loops keep it warm; the **oracle READS the warm cache per prompt** (fast, no duplicate Santiment/CMC API spend, no slow inline fetch in the TEE). The Brain's services expose `read-cache; fetch-if-stale`, but the oracle path should be **read-only** for latency. (Open question for Phase 2: who owns the fetch loops if the social body is down — likely a small always-on fetcher, or the oracle triggers a bounded refresh.)

## Gaps to reconcile (from the cross-repo audit)
| Gap | core | oracle | Resolution |
|---|---|---|---|
| Runtime | Bun (build+run) | Node ≥24 (run) | Brain ships **ESM `.js` + `.d.ts`** (no Bun runtime dep), `engines.node ≥20` |
| Module fmt | ESM | CommonJS root + ESM plugins | Brain is ESM; oracle consumes via `import()` (already does for its ESM plugin dist) |
| ElizaOS | core 1.7.2 / mcp ~1.8.2 | core 1.7.0 / mcp 1.7.0 | Brain core has **no `@elizaos` import**; `@elizaos/core` only an *optional* peer in the thin adapters. Bump oracle 1.7.0→1.7.2 in Phase 3. |
| **DB** | **Cloud SQL** (postgresBootstrap + mTLS) | **PGLite** (`PGLITE_DATA_DIR`) | **Oracle must adopt the shared Cloud SQL** for Brain data — reuse `sense-ai-core`'s `postgresBootstrap.ts` + `rofl-init-cloud-sql.sh` cert pattern (already solved). Oracle's own ElizaOS plugin-sql can stay PGLite for inference memory if needed, but Brain reads Cloud SQL. |
| Secrets | `.env.*` → ROFL secret set (secrets/config split) | `.env.oracle.*` → ROFL | Brain reads config via an injected `getSetting`/secrets interface (body-agnostic), NOT `process.env` directly |
| Zod | skewed (4.4.x/4.2.x/4.1.x) | 4.2.x | Brain pins one Zod; bodies align via `resolutions` |

## Oracle wiring (from the oracle audit)
- **Injection point:** `oracle/src/aiAgentOracle.js` → `queryElizaOS()` (~L652–660), just before `elizaOS.handleMessage`. Add an **oracle Brain provider** that reads the warm cache and injects sentiment/macro/news context (system-prompt augmentation or a registered provider).
- **Reasoning + sources:** the answer `MessageFile` already has `reasoning[]`/`sources[]`/`reasoningDuration` fields (currently empty/mock). The Brain analysis **populates them for real** — this also closes the long-open Area-6 gap (**CU-86d3cfa41**).
- **Preserve oracle-body-only code unchanged:** ecies decrypt/encrypt, ROFL attestation/submit (`roflUtility.js`), on-chain submit (`contractUtility.js`), block cursor, payload validation, storage, the `txMutex`.
- **Preserve the E2E hooks:** `MOCK_AI` + `__E2E_DELAY_MS__`/`__E2E_DROP__`/`__E2E_REASONING__` sentinels must keep working (the e2e suite depends on them). Real Brain context only flows on the non-mock path.

## Phased plan
- **Phase 0 — scaffold the shared package.** Create `sense-ai-brain` repo (mirror `sense-ai-shared-schema`: submodule of `sense-ai-shared-schema`, `file:` deps, ESM build to `dist` + types). Write ADR-0001 (shared-brain decision). No behaviour change.
- **Phase 1 — extract Brain from sense-ai-core (prove the Social body still works).** Move the portable services/adapters/provider-data into the package, refactor off `IAgentRuntime` → `BrainContext`. `sense-ai-core`'s `plugin-senseai` becomes a thin wrapper importing from the package. **Validate: sense-ai-core builds + its existing tests/CI pass + a local boot.** This is the de-risk: the social body is unchanged in behaviour. Coordinate with the other Claude instance (it's changing sense-ai-core *packaging*, not capability code — migrate from a pinned, stable `main`).
  - **Typecheck strategy:** `sense-ai-brain` currently enforces a **strict, clean `tsc --noEmit`** (0 errors) — which is exactly the *end state* sense-ai-core is working toward (Issue #50 / CU-86d3hayha: burn down 457 grandfathered errors under a **baseline gate** `scripts/typecheck-baseline.sh` + `.tsc-baseline.txt` that fails only on NEW errors). Aim to extract the Brain **clean** and keep the strict gate — the portable code (sentiment/news/adapters) is NOT the twitter-utils hot spots that hold most of core's 457, so it should carry little debt; fix what it does carry during extraction. Only if the extracted subset proves too dirty to fix inline, port core's baseline gate to the brain and burn it down. `bun run build` must precede typecheck if any intra-package import resolves through built `dist/` (core's ordering note).
- **Phase 2 — wire Brain into the oracle.** Oracle adopts Cloud SQL (postgresBootstrap + cert pattern) for Brain reads; add the oracle Brain provider at the injection point; populate real reasoning/sources; keep MOCK_AI/sentinels. **Validate full-stack via the e2e suite** (localnet mock path stays green; add a real-Brain integration test against a seeded cache).
- **Phase 3 — reconcile + harden.** Bump oracle ElizaOS 1.7.0→1.7.2, align Zod, dedupe. Then the **oracle multi-stage Dockerfile** (now the image is heavy; mirror sense-ai-core's once it lands).
- **Phase 4 — deploy.** Testnet ROFL first (boot + answer-quality check), then mainnet. (Trust-root refresh footgun per sense-ai-core CLAUDE.md.)

## Risks / footguns
- **Cloud SQL from the oracle TEE** is new for the oracle — but the pattern is solved in sense-ai-core; reuse `rofl-init-cloud-sql` + `postgresBootstrap`.
- **Latency:** never do slow API fetches inline per prompt in the TEE — read the warm cache only.
- **ElizaOS coupling leakage:** the Brain core must stay `@elizaos`-free or the version skew/Bun problems return.
- **Drift, again:** the whole point — once shared, do NOT re-fork. Both bodies track the package.
- **Cost:** one warm cache, not two — don't double-pay Santiment/CMC.
- **dApp-specific future features:** scope them as oracle-body additions (NOT in the shared Brain) unless genuinely shared.

## Out of scope / deliverables
- **Out of scope now:** the oracle multi-stage Dockerfile (Phase 3+), any new dApp-specific analytical features (future), the sense-ai-core multi-stage Dockerfile (other instance).
- **Deliverables:** `sense-ai-brain` package repo; ADR-0001 (shared-brain); refactored `sense-ai-core/plugin-senseai`; oracle Brain provider + Cloud SQL adoption + real reasoning/sources; e2e coverage of the real-Brain path; then Dockerfile + testnet/mainnet.

## Coordination
- The other Claude instance is finishing `sense-ai-core`'s multi-stage Dockerfile (packaging only). Our Phase 1 reads sense-ai-core's *capability* code — no conflict. Migrate from a **pinned, stable sense-ai-core `main`**. Their Dockerfile is a prerequisite for the oracle's (Phase 3 mirrors it).
