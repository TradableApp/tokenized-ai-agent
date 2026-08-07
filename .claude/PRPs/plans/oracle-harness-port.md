# Oracle harness port — implementation plan (CU-86d3z0r81)

## Requirements restated

Bring the oracle's ElizaOS harness to parity with `sense-ai-core`, porting **everything that is
not X/Telegram account management**, while respecting three things that make the oracle
different: it boots ElizaOS programmatically (no AgentServer), it is driven by on-chain events
through a p-queue at concurrency 5 rather than a chat loop, and its answers are **immutable and
pre-paid** — a degraded answer cannot be retried by the user.

## Why this exists

PR #62 stripped the oracle's social-only code; PR #63 added two Brain providers. **Nothing was
ever ported.** The oracle's plugin descends from the ElizaOS QuickStart template, not from core's,
so core's harness patterns have never existed in it:

| | core | oracle (before this task) |
| --- | --- | --- |
| actions | 6 | 0 |
| providers | 5 | 2 |
| services | 8 | 1 |
| utils | 13 | 0 |
| evaluators | 1 | 0 |

The consequence, observed live on base-testnet: the oracle answered *"What is the latest news on
Bitcoin?"* with 164 characters of MCP tool-call code, encrypted into an immutable MessageFile.
There is nothing between the model and storage.

## Owner decisions already made

- **Skip** rate limiting (`rateLimit`, `accessProvider`, `usageInfoProvider`, `usageTracker`) —
  the oracle is paid per prompt through the escrow; metering free social usage is redundant.
- **Port** `healthCheckService` + `dailySummaryService`.
- **Port** `analyzeFinancialImage`, unhooked — wanted from the dApp later; no intake exists yet.
- **Brain vs plugin split:** anything framework-agnostic goes to `sense-ai-brain`; ElizaOS glue
  stays in the body. The Brain has **zero** `@elizaos/*` dependencies and must keep it that way —
  core's CLAUDE.md records having to prune `drizzle-orm` from the Brain because it "would shadow
  the host copy and split drizzle into two identities"; `@elizaos/core` is far more stateful.
- **Shared `plugin-senseai` package** is the endgame, but **after** the port — extracting from two
  working copies is safer than from one working copy and one empty shell.

---

## Phase 1 — the answer path (fixes the live defect)

### 1.1 Answer selection — ✅ DONE (`7223d4b`)
`selectAnswer` chooses the last **substantive** emission, so a `CALL_MCP_TOOL` payload can no
longer be stored. Mutation-checked against the exact production payload. 299 tests passing.

### 1.2 Synthesis pass (`actionChainHelper`) — MODULE DONE (`22554fa`), WIRING ABANDONED

`synthesizeAnswer` is implemented and green (7 tests): action results in, prose out,
deadline-bounded, degrades to null, zero module-level state.

**CORRECTION — the wiring I originally planned was solving a problem core does not have.**

Core calls `handleChainSynthesis` **from inside its own action handlers**
(`getNewsDetails.ts:14` imports it; line 354 calls it "if this is the last step"), with
`actionResult` already in scope and delivery via `callback`. There is no correlation
problem, because the action that produced the result is the thing that synthesises it.

My plan was to capture results from `ACTION_COMPLETED` instead, because I aimed synthesis at
**`CALL_MCP_TOOL`** — an action from `@elizaos/plugin-mcp` that we do not own, so there is no
handler of ours to hook. That event carries only a `roomId`, which drags in `runProvenance`'s
ambiguity semantics (two prompts in one conversation) and would have needed its own RED tests.

That is the wrong problem, for two reasons:

1. **Core does not synthesise MCP results either.** It keeps raw tool text out of the answer
   with the `messageHandlerTemplate` override (1.3), which constrains the action-selection pass
   so the model emits a brief acknowledgement rather than user-facing tool text.
2. **The oracle only reached for `CALL_MCP_TOOL` because it has no analytical actions of its
   own.** Its `getSentimentAction` was a mock, deleted in #62 and never replaced. Core answers
   the same question with `analyzeAssetSentiment` / `getNewsDetails`, which synthesise
   internally.

**Therefore: do NOT build `runProvenance.recordActionResult`.** `synthesizeAnswer` is not
wasted — it is the function the ported actions will call, from inside their handlers, exactly as
core does. It is simply not wired to a third-party action through an event channel that was
never designed to carry results.

**Revised order:** 1.3 next (it is the actual fix for raw MCP text), then Phase 2 brings the
actions, and synthesis attaches to them the way core does.

### 1.3 `messageHandlerTemplate` override
Constrain the action-selection pass so the model emits a brief acknowledgement, never
user-facing tool text. Cheap, and it reduces how often 1.1/1.2 have to catch anything.

### 1.4 Brain `sanitizeOutboundText` on the final answer
Already exported by the Brain and already used by core. Pure addition.

### 1.5 Startup guard validating required config **by name**
Today a bad address surfaces as `contract runner does not support name resolution`, which never
says which variable. Fail at boot, naming the variable — the same shape as the `setBrainAccessor`
gate in #63. Covers `AUTONOMYS_API_KEY` / `IRYS_PAYMENT_PRIVATE_KEY`, which currently fail only
*after* a user has paid.

### 1.6 Harden the smoke
It has now passed on an **apology** and on a **code block**, because non-empty
`reasoning[]`/`sources[]` satisfies it. Feed both recorded failures in as fixtures and require
rejection; add "answer references the asset asked about".

---

## Phase 2 — analytical capability

- `analyzeAssetSentiment` (the oracle's mock was deleted in #62 and never replaced).
- `getNewsDetails` — then re-instate the `GET_NEWS_DETAILS` instruction in
  `marketIntelligence.ts`. Worth being honest: #63 justified omitting it as avoiding a
  hallucinated tool call, but the real reason was **the action does not exist**.
- `recordActivity` telemetry (shared `daily_activity` table → belongs in the Brain).
- `healthCheckService` / `dailySummaryService` — DB queries + Slack payload building to the
  Brain; Service wrapper and scheduling per body.
- `analyzeFinancialImage` — vision prompt + parsing to the Brain; action unhooked.

## Phase 3 — Brain split + shared plugin (separate task)

Move the framework-agnostic halves into `sense-ai-brain`, then extract the shared
`plugin-senseai`. Also carries [CU-86d3yg0z9](https://app.clickup.com/t/86d3yg0z9): headings and
provider `position` into the Brain, core's provider ordering fix, the short-TTL read memo, and the
`MARKET_INTELLIGENCE_INJECTED` overwrite hazard.

---

## Phase 4 — parity audit (final step, before calling the port done)

Phase 3 extracts a **shared** `plugin-senseai` consumed by both bodies, so every divergence left
behind becomes either a merge conflict or a permanent fork. Parity is therefore not a nicety —
it is the precondition for the packaging step that follows.

Go back over **everything** produced by Phases 1–2 and compare it, file by file, against how
`sense-ai-core` does the same thing. For each difference, three questions in order:

1. **Is it a difference at all**, or did I reimplement something core already solves? (This
   plan's own 1.2 is the cautionary example: I designed an event-capture mechanism for a problem
   core avoids entirely by putting synthesis inside its own actions.)
2. **If it is real, is it FORCED by the oracle's situation?** Only three things genuinely differ:
   programmatic boot with no AgentServer; on-chain events through a p-queue at concurrency 5
   rather than one turn in flight; answers that are immutable and pre-paid so degradation costs
   real money. A divergence that does not trace to one of those is probably not necessary.
3. **If it is forced, can the shared package absorb it** behind a parameter, an injected
   dependency, or a peer-provided hook — rather than two implementations?

Divergences that survive all three must be recorded **in code**, at the point of difference,
with the reason — not in a plan document nobody reads at the call site.

### Known divergences to adjudicate

| divergence | current reason | verdict to reach |
| --- | --- | --- |
| `marketIntelligence` omits core's `GET_NEWS_DETAILS` instruction | #63 justified it as avoiding a hallucinated tool call, but the real reason is **the action does not exist** in the oracle | should disappear in Phase 2; if it does not, say why honestly |
| `BrainService` host-injected accessor vs core's `createBrainContext(runtime)` | the oracle's plugin-sql points at the isolated `oracle_agent` DB, so a runtime-derived context reads the wrong database while looking healthy | likely genuinely forced — confirm and record at the seam |
| `synthesizeAnswer` deadline + null-degrade | paid on-chain path; core's chat user can simply ask again | forced; consider whether core would benefit from it too |
| `runProvenance` run-correlation | core has one turn in flight, the oracle five | forced by concurrency |
| provider `position` set in the oracle, unset in core | core is wrong (news renders before macro) | fix core, do not fork the oracle |
| oracle omits rate limiting | paid per prompt via escrow | forced; owner-confirmed |

### Acceptance for Phase 4
- [ ] Every Phase 1–2 file compared against its core counterpart, with the comparison recorded
- [ ] Each surviving divergence traces to boot model, concurrency, or the pre-paid path — or is removed
- [ ] Each surviving divergence is documented at the call site, not only in this plan
- [ ] A guard test asserts the two bodies compose byte-identical LLM-facing context, enumerating every deliberate exception
- [ ] Anything that should change in **core** rather than the oracle is raised as its own PR (e.g. provider ordering) rather than silently forked

## Sequencing and PR shape

1. **PR A (current branch):** 1.1 + 1.2 (module) + **1.3** + 1.4 — the answer path. 1.3 is the
   real fix for raw MCP text reaching the user, so it leads rather than trails.
2. **PR B:** 1.5 + 1.6 — startup guard + smoke hardening; independently reviewable.
3. **PR C:** Phase 2 analytical actions — these call `synthesizeAnswer` from inside their
   handlers, the way core does, which is what finally makes a tool-using prompt useful.
4. **PR D:** Phase 4 parity audit — findings, plus any core-side PRs it surfaces.
4. Redeploy to base-testnet and re-run the smoke **after PR B**, since only then can the smoke
   judge whether the answer is real.

## Risks

| risk | mitigation |
| --- | --- |
| Synthesis adds latency to a paid path | `withTimeout` + fallback to 1.1 selection |
| Concurrency assumptions from core's chat loop | audit against `runProvenance` run-correlation; test with two in-flight runs in one room |
| Provenance regression | `reasoning[]`/`sources[]` assertions at both unit and `queryElizaOS` level; e2e T-REASON-01 |
| Porting drift (core changes later) | Phase 3 shared package; until then, note every deliberate divergence in code |
| Warm cache stale since 2026-07-10 | separate operational issue; do not let a stale-cache answer be read as a port failure |

## Acceptance

- A `CALL_MCP_TOOL` prompt returns **synthesised prose**, never a payload or acknowledgement.
- `reasoning[]`/`sources[]` unchanged in shape; e2e T-REASON-01 still passes.
- Missing required config fails at **boot**, naming the variable.
- The smoke **fails** on both recorded bad answers and passes on a real one.
- Oracle plugin contains no Telegram/X code; every non-social core capability is either ported or
  has a recorded reason for omission.
- Base-testnet smoke passes on **substance**, not just structure.
