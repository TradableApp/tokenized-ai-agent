# Plan: Brain as Shared Powerhouse, Two Equal Bodies

> EPIC **CU-86d3dwme6** (Oracle Brain migration) — continuation.
> Companion docs: [`oracle-brain-migration.md`](./oracle-brain-migration.md) (Phase 1/2 origin),
> [`oracle-base-testnet-deploy-runbook.md`](./oracle-base-testnet-deploy-runbook.md) (Phase 0 mechanics).
> Status: **approved 2026-07-20**, awaiting execution (Phase 0 first).

## Target architecture

`@tradableapp/sense-ai-brain` is the shared analytical **powerhouse** that BOTH bodies
leverage **equally**. Only body-specific glue stays in each repo's `plugin-senseai`.

| Concern | `sense-ai-brain` (Brain) | `sense-ai-core` (Social body) | `tokenized-ai-agent/oracle` (Oracle body) |
|---|---|---|---|
| Sentiment/news/macro engines + formatters | ✅ owns | consumes | consumes |
| Client-driven fetch-on-miss (uncached token → query providers → store) | ✅ owns (`getAssetSentiment`) | consumes | consumes |
| **Periodic/scheduled** fetch + cache warming | — | ✅ only one that schedules | ❌ never schedules |
| Access model | — | rate-limited | $ABLE / escrow-bounded (not rate-limited) |
| Platform glue | — | TG/X actions, broadcast, daily summary | on-chain answer flow, ECIES/AES, ROFL submit |

Guiding rule: **anything analytical/shared lives in the Brain; each body is a thin wrapper.**

## Investigation findings (2026-07-20, 4 parallel audits)

1. **On-demand path already exists in the Brain.** `SentimentEngine.getAssetSentiment(asset)`
   reads the Postgres cache (23h TTL) → on miss/stale resolves symbol→slug → fetches
   Santiment/CMC/CFGI → stores. It does **not** require `ctx.ai`. Only *news enrichment*
   (`MarketNewsEngine.enrichmentCycle` — TLDR + embeddings) needs `ctx.ai`. The oracle
   today calls **only** `getLatestMacro()` + `getLatestEnrichedNews()` — never the
   on-demand path, never creates `MarketNewsEngine`.
2. **Oracle `plugin-senseai` is a divergent old fork.** 5 stale Telegram actions
   (`showMenu`, `launchApp`, `handleMenuCallback`, `rateLimitAction`), a **mock sentiment
   action with hardcoded data**, an in-memory stub rate limiter, and **zero Brain imports**.
   Core's `plugin-senseai` is a proper thin wrapper (the template to follow).
3. **TEE egress is NOT a blocker.** The enclave already calls SendGrid / ChainGPT /
   Autonomys / Irys directly via `fetch()` in production. The `rofl.app` / `tls handshake eof`
   errors were internal-hostname noise, not a general egress block. Client-driven 3rd-party
   fetch is technically viable; the cost is latency-on-miss, provider spend, and a larger
   TEE secret surface (provider keys).
4. **Knowledge RAG:** agentId matches (both derive `stringToUuid("SenseAI")`); retrieval-only
   mode works with `LOAD_DOCS_ON_STARTUP=false` and no `docs/` dir — **but BLOCKED on
   embedding drift**: core uses `gemini-embedding-001` (3072-dim), oracle uses
   `text-embedding-004`. pgvector needs identical dimensions. Keep knowledge in the ElizaOS
   plugin layer, **not** the Brain.

Net: the user's vision is largely a **wiring + secret-provisioning** job (the power already
lives in the Brain), plus gutting the oracle's stale fork. There is also **model drift**
(embedding *and* LLM models differ between bodies) to reconcile.

## Phases

### Phase 0 — Ship & verify the current read-only oracle on base-testnet *(unblocked — first)*
- Cached market-context path works and is **unaffected by the embedding mismatch**
  (`getLatestEnrichedNews` is time-ordered, not vector search).
- Env secrets/config separation is **done** (rofl-set two-section rewrite + all oracle
  `.env.oracle*` reorganised + Postgres wiring). Do not re-plan.
- Run `rofl:set:base-testnet` → `rofl:build` → commit `rofl.yaml` → `rofl:update` →
  `rofl:deploy` → boot check → smoke test (PR #57). Proves real `reasoning[]`/`sources[]`.
- ⚠️ Known caveat: the oracle's `GET_MARKET_SENTIMENT` action still returns **mock** data —
  Phase 0 validates the `brainContext` injection path; the mock action is removed in Phase 1.
- **Complexity: LOW.**

### Phase 1 — Gut the oracle `plugin-senseai` into a thin Brain wrapper
- Delete: the 5 stale Telegram actions, the mock sentiment action, the in-memory rate limiter.
- Keep only oracle glue; import analytical capability from `@tradableapp/sense-ai-brain`
  (mirror core's wrapper). Removes the fork/drift.
- **Complexity: MEDIUM.**

### Phase 2 — Wire client-driven on-demand fetch *(core requirement)*
- On a client prompt about a specific token → `SentimentEngine.getAssetSentiment(asset)` →
  read-cache → **fetch-on-miss → write-through** to the shared cache (benefits both bodies;
  not double-spend).
- Provision adapter keys as **TEE secrets** (Santiment/CMC/CFGI; news adapters if on-demand
  news wanted). Larger secret surface — accepted.
- On-demand *news enrichment* (needs `ctx.ai`): supply a framework-agnostic `ai` shim to
  `BrainContext` backed by the oracle's existing inference — or defer (sentiment/macro first).
- No periodic loops in the oracle; $ABLE-bounded.
- **Complexity: MEDIUM–HIGH.**

### Phase 3 — Model standardization + knowledge RAG *(last; coordinate with the sense-ai-core instance)*
- Standardize the embedding (and reconcile LLM) model across both bodies; re-ingest core's
  docs if the embedding model changes.
- Add `@elizaos/plugin-knowledge` (retrieval-only, `LOAD_DOCS_ON_STARTUP=false`) to the
  oracle → shares core's docs via the common agentId. Knowledge stays an ElizaOS-plugin
  concern, **not** in the Brain.
- **Complexity: MEDIUM** (+ cross-repo coordination).

## Dependencies & risks
- **Cross-instance coordination:** sense-ai-core is actively worked by another instance —
  Phase 3 model standardization and any Brain API additions must target a pinned `main`.
- **Secret surface (Phase 2):** provider API keys enter the TEE (read-only data keys).
- **Cost/latency (Phase 2):** bounded to cache-miss on obscure tokens; write-through
  amortises it. Add a per-prompt fetch timeout so a slow provider never blocks the on-chain
  answer window.
- **Embedding re-ingest (Phase 3):** changing core's embedding model re-embeds its docs.

## Overall complexity: **HIGH** (multi-phase, cross-repo). Phase 0 ships a real milestone
immediately; Phases 1–3 are the "true two-bodies" work.
