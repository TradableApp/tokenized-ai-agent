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

### 1.2 Synthesis pass (`actionChainHelper`) — ✅ DONE as a faithful port (`8d6adfe`)

First cut (`22554fa`) was green on 7 tests but was a reimplementation on both counts — wiring
**and** module. Both corrections below. Shipped instead:

- `utils/actionChainHelper.ts` — core's template, `generateSanitized` retry-on-leak,
  `sanitizeOutboundText`, `parseKeyValueXml`, safe fallback, `isLastStep` gate.
- `utils/withTimeout.ts`, `utils/retryNudges.ts` — byte-identical copies of core's, so the Phase 3
  extraction has nothing to reconcile.
- `answerSynthesis.js` + its 7 tests deleted; they were never wired to anything.
- **CI gap closed:** the plugin had no tests and CI ran none, so its providers and utils shipped
  uncovered and Phase 2's actions would have too. `Test (plugin-senseai)` now gates them.

17 plugin tests (100% funcs / 98.96% lines on the helper) + 299 oracle mocha tests.

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

**SECOND CORRECTION — the module itself was also a reimplementation, not a port.**

Reading `actionChainHelper.ts` properly, `synthesizeAnswer` as first written diverged on six
counts, none of them forced:

| core `handleChainSynthesis` | my first `synthesizeAnswer` |
| --- | --- |
| `composePromptFromState` + `chainSynthesisTemplate`, so `{{providers}}` is in the prompt | hand-rolled string; **no providers at all** |
| `generateSanitized(..., 2)` — retry on leak with `XML_RETRY_NUDGE` | single attempt |
| `sanitizeOutboundText` gates the text | nothing |
| `parseKeyValueXml` | hand-rolled `/<text>([\s\S]*?)<\/text>/` |
| safe fallback message on total failure | returns `null` |
| `isLastStep` gate via `options.actionPlan` | absent |

Dropping `{{providers}}` is the serious one: it synthesises without the market-intelligence and
Brain context the providers exist to supply, which is most of why the answer is worth paying for.

**1.2 is therefore re-scoped to a faithful port of `handleChainSynthesis`**, carrying the template,
`generateSanitized` + `sanitizeOutboundText`, `parseKeyValueXml`, the fallback string, and the
`isLastStep` gate. Only two additions survive, both traceable to a real difference:

- **deadline** — the paid path cannot hang; core's chat user can simply ask again. (Offer this back
  to core at 2.7; it would likely benefit too.)
- **per-call state only** — p-queue concurrency 5 vs core's one turn in flight.

`generateSanitized` and `sanitizeOutboundText` are already exported by the Brain the oracle
depends on (verified against the installed package), so this is a port, not new code.

**Revised order:** 1.2 (re-scoped) next, then Phase 2 brings the actions, and synthesis attaches to
them the way core does. 1.3 is deleted; 1.4 ships inside 1.2.

### 1.3 `messageHandlerTemplate` override — ❌ REMOVED, IT WAS A FABRICATION

I wrote 1.3 as "port core's `messageHandlerTemplate` override". **Core has no such override.**
`character.ts` has no `templates` key at all; the only template overrides anywhere in core are
Twitter-specific (`postTweetTemplate`, `quoteTweetTemplate`, `replyTweetTemplate`,
`twitterActionTemplate`), read as `runtime.character.templates?.X || default` — i.e. defaults that
core never sets. Nor does core's `system` prompt say anything about tool output.

Building 1.3 would have created a divergence and labelled it a port. This is the second time the
same mistake nearly landed (see 1.2), which is why the audit moved to 2.7.

**What core actually relies on** — two things, neither of them a template:
1. `@elizaos/plugin-mcp` already synthesises. Its `handleToolResponse` runs a reasoning prompt over
   the raw tool output and emits **prose**; raw output is never passed to the callback.
2. Core is a chat body. Every callback is its own message, so there is no "which emission is THE
   answer" decision to get wrong.

Only (2) fails for the oracle — it must collapse N emissions into ONE immutable, pre-paid stored
answer. That is the "immutable pre-paid answers" difference, and `selectAnswer` (1.1) is the
oracle's forced response to it. It has no core counterpart because core has no such problem.
**Record it as a forced divergence at 2.7, do not look for something to port.**

### 1.4 `sanitizeOutboundText` — folded into 1.2, not a separate step
Core does **not** sanitize "the final answer" as a discrete pass. `sanitizeOutboundText` is called
from *inside* `handleChainSynthesis` (and `broadcastService`), wrapped in `generateSanitized` so a
leak triggers a **retry with a nudge** rather than a rejection. Bolting it on as a standalone
post-filter would be yet another invented difference. It ships as part of 1.2's port.

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

### 2.7 Parity audit — the FINAL step of Phase 2, and the gate on Phase 3

Phase 3 extracts a **shared** `plugin-senseai` consumed by both bodies, so every divergence left
behind at that point becomes either a merge conflict or a permanent fork — and an unreconciled
divergence extracted into the shared package is worse than one left in a body, because it becomes
the shared contract. Parity is therefore not a follow-up to the extraction; it is its
**precondition**, and it belongs here, before Phase 3 begins.

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
| `synthesizeAnswer` deadline | paid on-chain path; core's chat user can simply ask again | forced; offer it back to core, which would likely benefit |
| `selectAnswer` has no core counterpart | core is a chat body — each callback is its own message, so there is no single stored answer to choose | forced by the immutable pre-paid answer; **do not** hunt for something to port (see 1.3) |
| `runProvenance` run-correlation | core has one turn in flight, the oracle five | forced by concurrency |
| provider `position` set in the oracle, unset in core | core is wrong (news renders before macro) | fix core, do not fork the oracle |
| oracle omits rate limiting | paid per prompt via escrow | forced; owner-confirmed |

### Core-side PR list (raise in `sense-ai-core`, then inherit — do NOT fix in the fork first)

Accumulated during PR #65's review rounds. Each is a case where the oracle's copy is *correct
because it matches core*, and the improvement belongs upstream so both bodies move together.

| item | file | why upstream |
| --- | --- | --- |
| apply `withTimeout` to synthesis | `utils/actionChainHelper.ts` | core already ships the util for this exact ROFL hang and simply has not used it here |
| move `actionResultsData` into `state.values` | `utils/actionChainHelper.ts` | top-level assignment relies on `composePromptFromState` interpolating off `state`; undocumented in `@elizaos/core` types |
| drop `?? []` on `allProviders` | `utils/actionChainHelper.ts` | `const … = []`, only pushed into — can never be nullish |
| drop `&& text` from the callback guard | `utils/actionChainHelper.ts` | `text` is always `FALLBACK_TEXT` or a non-empty sanitised string |
| fix the else-branch log message | `utils/actionChainHelper.ts` | **already diverged in the oracle** — core's "failed to parse XML or text was empty" describes an impossible state and would mislead a debugger; the only one of these worth forking ahead of core |
| correct the "ElizaOS 90s guard" claim | `utils/withTimeout.ts` | not verifiable in the installed `@elizaos/core`; the only `90000` is LangSmith's tracing client timeout |

The first four are inert-but-untidy: fixing them in the oracle first is exactly how two copies drift,
which is what 2.7 exists to prevent.

### Acceptance for 2.7 (and the entry gate for Phase 3)
- [ ] Every Phase 1–2 file compared against its core counterpart, with the comparison recorded
- [ ] Each surviving divergence traces to boot model, concurrency, or the pre-paid path — or is removed
- [ ] Each surviving divergence is documented at the call site, not only in this plan
- [ ] A guard test asserts the two bodies compose byte-identical LLM-facing context, enumerating every deliberate exception
- [ ] Anything that should change in **core** rather than the oracle is raised as its own PR (e.g. provider ordering) rather than silently forked
- [ ] **Phase 3 does not start until the above are all true** — extraction from two reconciled copies, never from two drifting ones

---

## Phase 3 — Brain split + shared plugin (separate task, gated on 2.7)

Move the framework-agnostic halves into `sense-ai-brain`, then extract the shared
`plugin-senseai`. Also carries [CU-86d3yg0z9](https://app.clickup.com/t/86d3yg0z9): headings and
provider `position` into the Brain, core's provider ordering fix, the short-TTL read memo, and the
`MARKET_INTELLIGENCE_INJECTED` overwrite hazard.

Entry condition: the 2.7 acceptance list above is complete. Every divergence 2.7 confirmed as
**forced** must be carried into the extraction deliberately — as a parameter, an injected
dependency, or a peer-provided hook — rather than discovered mid-extraction and resolved by
whichever body happens to be ported first.

## Sequencing and PR shape

**Each PR gets its own branch off `main`. Do not carry the next phase onto the open branch** — I
started Phase 2 on PR A's branch before catching it, which would have merged A and C as one
unreviewable change.

1. **PR A — [#65](https://github.com/TradableApp/tokenized-ai-agent/pull/65), OPEN.** 1.1 + 1.2 as
   a faithful `handleChainSynthesis` port (sanitize + retry-on-leak included, so old 1.4 ships
   here) + the plugin CI gate. 1.3 deleted, reason recorded above rather than silently dropped.
2. **PR B:** 1.5 + 1.6 — startup guard + smoke hardening; independently reviewable.
3. **Redeploy to base-testnet and re-run the smoke — after PR B, before PR C.** Only the hardened
   smoke can judge whether an answer is *real* rather than merely well-shaped; running it before
   1.6 is what let an apology and a code block both pass. This is a gate, not a trailing step.

   **But it cannot close the substance ACs, and a green run here must not be read as if it did.**
   `handleChainSynthesis` is not exported from `plugin-senseai/src/index.ts`, so it is not in the
   built bundle (`grep -c handleChainSynthesis dist/index.js` → 0) — by design, since Phase 2's
   actions are what call it. The TEE at this point is running `selectAnswer` with no synthesis
   wired, so this deploy proves **"no payload is ever stored"** and nothing more. AC 1
   ("returns synthesised prose") and AC 2 ("the acknowledgement is never the final answer") stay
   open until a **second deploy after PR C**.
6. **Second base-testnet deploy + smoke, after PR C** — the one that actually closes AC 1, AC 2
   and AC 6.
4. **PR C:** Phase 2 analytical actions — these call `handleChainSynthesis` from inside their
   handlers, the way core does, which is what finally makes a tool-using prompt useful.
5. **PR D:** 2.7 parity audit — findings, the at-the-call-site documentation, the guard test, plus
   any core-side PRs it surfaces (starting with applying `withTimeout` to core's own synthesis).
   Merging this is what unblocks Phase 3.

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
