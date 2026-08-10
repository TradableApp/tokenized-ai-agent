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

### 1.5 Startup guard validating required config **by name** — ✅ DONE (PR B)
Today a bad address surfaces as `contract runner does not support name resolution`, which never
says which variable. Fail at boot, naming the variable — the same shape as the `setBrainAccessor`
gate in #63. Covers `AUTONOMYS_API_KEY` / `IRYS_PAYMENT_PRIVATE_KEY`, which currently fail only
*after* a user has paid.

### 1.6 Harden the smoke — ✅ DONE (PR B)
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

## PR C — detailed plan (written 2026-08-10, after the base-testnet run)

### Owner decisions — settled, do not re-litigate

1. **NEVER block a response.** Whatever the answer's quality, it gets stored and shown. An apology
   is a valid answer to store.
2. **Charge for it anyway, for now.** "Store but don't charge" is the better UX and is NOT
   currently possible: `EVMAIAgent.submitAnswer` calls `aiAgentEscrow.finalizePayment` in the same
   transaction, so storing IS charging. Separating them is a contract change with dApp and
   subgraph consumers — a future improvement, explicitly out of scope here.
3. **Prefer shared-package solutions over oracle-local forks** — One Brain, Two Bodies is the
   direction, so when a fix could live in `plugin-senseai` or in the oracle body, it goes in the
   plugin unless something forces otherwise.

**Verified against the merged code — nothing blocks a response today:**

| emitted | stored |
| --- | --- |
| ack + code payload | the ack |
| ONLY a code payload | the payload, with an incident log |
| ONLY raw JSON | the JSON |
| ONLY an apology | **the apology** |
| nothing at all | null → "generated no text" (pre-existing) |

Every quality check added so far is either a *selection* between emissions or a *test-time*
assertion. `assessAnswer` is smoke-only and cannot affect production. **This invariant is now a
constraint on all remaining work: no check may turn an answer into no-answer.**



### Why the oracle ignored its own news — diagnosed, not guessed

Both bodies put the SAME news in front of the model: same `getLatestEnrichedNews` from the Brain,
same `formatNewsTicker`, same 10 rows, same heading. The blocks are byte-identical. **The only
difference is the instruction that follows the block.**

| | core | oracle |
| --- | --- | --- |
| news rows | `getLatestEnrichedNews(ctx, 10)` | same fn, via `BrainService` |
| rendering | `formatNewsTicker` | same |
| heading | `### SOVEREIGN MARKET INTELLIGENCE (Local Ledger)` | identical (asserted by test) |
| **trailing instruction** | **`INSTRUCTIONS: - This is a news article summary ticker. - …execute "GET_NEWS_DETAILS"`** | **nothing** |

The omission was deliberate (#63): pointing a model at an action the oracle does not register
invites a hallucinated tool call on a paid path. That reasoning was sound — but it removed **both**
lines, including *"This is a news article summary ticker"*, which is the line that frames the block
as usable at all.

**The control case proves it.** The same run DID use the macro block — the answer opens with
dominance 58.49% and Fear & Greed 30/100. Why? Because macro's instruction ships **inside the
Brain's formatter**:

```
### MACRO MARKET ENVIRONMENT
- Global Fear & Greed: …
INSTRUCTION: Use this macro context to shape your tone.     ← inside formatMacroEnvironment
```

So the oracle inherited macro's instruction for free, and lost news's instruction because that one
lives in the *provider* — body-local, and omitted here. The model used the block that told it what
to do and ignored the block that did not.

Deprived of framing, and asked for news, it reached for the only tool-shaped affordance it had:
`CALL_MCP_TOOL`. That searched CoinGecko's **SDK documentation** (`query:"news",
language:"python"`) and returned TypeScript. `selectAnswer` then correctly refused the code and
stored the acknowledgement.

**So the answer to "how do we get it to use its 10 sources" is not prompt-tuning.** It is: give it
a sanctioned action for the deep dive, re-instate the instruction now that the action exists, and
let that action synthesise the answer from the results — which is exactly what core does.

### C.1 — Port `getNewsDetails` (the load-bearing change)

Core's action: semantic search over the same warm cache, then `handleChainSynthesis` from inside
its own handler. Port it with the two divergences already established for the oracle
(`withTimeout` on model calls, degrade-never-throw), reusing the ported helper from PR A.

- Reuse `BrainService` rather than `createBrainContext(runtime)` — the oracle's plugin-sql points
  at the isolated `oracle_agent` DB, so a runtime-derived context reads the wrong database while
  looking healthy. (Already recorded as a forced divergence for 2.7.)
- Core's `getNewsDetails` uses `withTimeoutOrNull` around the intent classify and the embedding —
  both already ported.

### C.2 — Re-instate the INSTRUCTIONS block

Only after C.1, so the instruction points at a registered action. Byte-identical to core's,
because Phase 3 extracts this provider into the shared package and any wording delta becomes a
merge conflict.

**Follow-up for 2.7/Phase 3:** move the news instruction INTO `formatNewsTicker`, the way macro's
already is. That is the structural fix — it makes this class of drift impossible rather than merely
tested, and it is the same asymmetry that caused the bug.

### C.3 — Port `analyzeAssetSentiment`

The oracle's mock was deleted in #62 and never replaced. Same synthesis pattern.

### C.4 — Port `recordActivity` telemetry
Shared `daily_activity` table → Brain-side query, ElizaOS wrapper local.

### C.5 — `healthCheckService` / `dailySummaryService`
DB queries + Slack payload building to the Brain; Service wrapper and scheduling per body.

### C.6 — `analyzeFinancialImage`, unhooked
Vision prompt + parsing to the Brain; action registered but no intake.

### C.0 — The N-callback contract, and reducing N to one stored answer

A production `sense-ai-core` Telegram exchange (2026-08-10) showed an acknowledgement followed by
a cited synthesis. **That is one shape, not the contract.** ElizaOS picks the actions at runtime
from the prompt; each action may emit a callback or stay silent, and third-party actions emit on
their own terms. The real contract is **0..N callbacks in a runtime-determined order**:

| | core (chat) | oracle (on-chain) |
| --- | --- | --- |
| N callbacks | N messages — all shown, order is the conversation | must reduce to exactly ONE immutable answer |
| ack-only (no action) | one message | that IS the answer |
| IGNORE (no callback) | nothing sent | `selectAnswer` → null → "generated no text" |
| mechanism | none needed | body-local reduction policy |

Core never has to choose, so it has no reduction rule and needs none. The oracle must choose on
every prompt, which is why `selectAnswer` lives in the BODY and has no core counterpart. **That is
the thing to write down when `plugin-senseai` is extracted**: the plugin promises tagged callbacks;
consumers decide delivery. A shared package that assumed "two messages" would be wrong for both.

#### The reduction rule needs the action tags, which are currently thrown away

Every emitter tags its callback with its origin — `handleChainSynthesis` uses
`actions: [actionResult.data.actionName]`, plugin-mcp uses `["CALL_MCP_TOOL"]`, and so on. But
`aiAgentOracle`'s `onResponse` pushes only `content.text`, discarding the attribution.

That makes "last substantive prose" the only available rule, and it is wrong for a mixed chain.
Concretely: `REPLY, GET_NEWS_DETAILS, CALL_MCP_TOOL` — plugin-mcp's `handleToolResponse` runs a
reasoning prompt and emits **prose**, so MCP's summary arrives last and wins, discarding our
synthesis. In chat that is merely an extra message; here it silently replaces the paid answer.

**C.0 work:** capture `content.actions` alongside the text, and prefer, in order:
1. an emission attributed to one of OUR analytical actions (the synthesis),
2. else the last substantive prose (today's rule),
3. else the last emission (today's fallback, which stays an incident).

#### The real hole: nothing synthesises when a third-party action ends the chain

`handleChainSynthesis` only synthesises at `isLastStep`. If the model orders
`GET_NEWS_DETAILS, CALL_MCP_TOOL`, our action correctly passes its data forward and emits nothing —
and MCP, which never calls our helper, ends the chain. The accumulated results are never
synthesised, so preference rule (1) has nothing to select.

**This is not an argument for keeping MCP away from news.** We do not choose the actions — ElizaOS
does, from the prompt — and a news answer is genuinely *better* with a live price alongside it.
Mixed chains are the desirable case, not the failure case. Which makes this the common path for
exactly the richest answers, not an edge case, and means the earlier "scope MCP away from news"
framing was wrong and is dropped.

The requirement is therefore: **whatever ends the chain, the accumulated results of every action
must be synthesised into one answer.** Two candidate mechanisms, both needing a spike in C.0
before committing:

| | where | pro | wrinkle |
| --- | --- | --- | --- |
| **A. `FINAL_SYNTHESIS` evaluator** | shared plugin | benefits BOTH bodies; survives the Phase 3 extraction; core has the same hole and would gain the fix | `runtime.evaluate` re-composes state as `["RECENT_MESSAGES","EVALUATORS"]`, so accumulated `actionResults` are NOT in the state it hands over — the handler must re-read them via `ACTION_STATE`, and "has anything synthesised yet?" needs a marker that survives that recompose without module-level state (p-queue concurrency 5) |
| **B. body-level at `onComplete`** | oracle only | simplest; C.0 already captures emissions and their action tags, so "nothing synthesised" is known for free | a real fork; leaves core broken; the body would still need the action results, which it does not currently hold |

Verified for A: evaluators receive `callback` and `responses`, and `alwaysRun: true` runs them even
when `didRespond` is false — so an evaluator CAN emit the final answer.

**Take A** — it is the One Brain, Two Bodies answer, and core has this bug too. Resolve the
state-recompose wrinkle while implementing C.1 rather than as a separate spike; if it proves
genuinely awkward, ship C.1 without it and raise it as its own piece of work. Do NOT let this
block the action ports, which are the substance of PR C.

Two consequences worth deciding in PR C rather than discovering in Phase 3:

- **Links.** Core's TG answer carries markdown links to each source. Core already parameterises
  this per body — the X path has `stripUrls` for its link-free policy. The oracle needs an explicit
  choice; default to KEEPING links, since citations are the point on a paid answer and the dApp
  renders markdown.
- **The closing question** ("are you tracking node efficiency…") is core's Proactive Guidance rule.
  Harmless and arguably good for the oracle: conversations support follow-ups via `parentCID`, and
  a follow-up is another prompt. No change.

### C.7 — Prove a synthesis actually happened (redesigned — phrase-matching does not work)

AC 2 says *"the acknowledgement text is never the final stored answer"*. There is no detector, and
the base-testnet run passed green while violating it.

**The obvious detector fails, and the TG transcript is what proves it.** A phrase list built from
the oracle's own acknowledgement — "I am retrieving", "stand by", "analysing current" — was tested
against core's REAL acknowledgement and **misses it entirely**:

```
proposed phrase detector:
   oracle ack caught?  true
   CORE ack caught?    false    <-- would MISS it
```

Acknowledgements are model-generated and phrased freely. Fitting a matcher to the one sample in
hand is the same mistake as the 60-char apology threshold and the "any digit" substance proxy —
both of which had to be redone. A "does the answer mention its sources" heuristic is closer to the
real property but still needs a threshold, and core's ack already scores one incidental hit
("Ethereum", "upgrades"), so that threshold would be fitted to three examples too.

**Use the structural signal instead.** `runProvenance.recordThought` attributes each reasoning step
to the action in flight; steps produced with no action carry no attribution. In the failing run
`reasoning[0].title` was the generic `"Step 1"` — no analytical action ran, which is *exactly* what
made the answer an acknowledgement.

So the assertion is: **for an analytical prompt, at least one `reasoning[]` entry must be attributed
to an analytical action** (`GET_NEWS_DETAILS`, `ANALYZE_ASSET_SENTIMENT`). That tests the cause
rather than the prose, cannot be defeated by rephrasing, and needs no threshold. Keep
source-overlap only as a secondary warning, never as a fatal.

**Lands with C.1–C.3, not before.** Adding it first turns the smoke red without changing the
product; landed together, it has something to prove.

### C.8 — DROPPED: do not gate MCP

Originally "decide whether `CALL_MCP_TOOL` should be reachable for news". That was wrong on both
counts. We do not select actions — ElizaOS does, from the prompt — so "reachable" is not ours to
decide. And a news answer is *better* with a live price beside it, so suppressing the combination
would degrade the product to work around a synthesis bug.

The live run's SDK-doc search was a symptom of C.2's missing instruction (no sanctioned news path,
so the model reached for the only tool it had), not evidence that MCP is harmful. Fixing C.2 and
the multi-action synthesis in C.0 addresses the cause; the MCP tool stays exactly as it is.

### Acceptance for PR C
- [ ] A news prompt returns synthesised prose citing the ticker items, not an acknowledgement
- [ ] AC 1 and AC 2 close on the SECOND base-testnet deploy
- [ ] The smoke FAILS on the recorded acknowledgement from the 2026-08-10 run, added as a fixture
- [ ] Provider text stays byte-identical to core's, asserted by test

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

1. **PR A — [#65](https://github.com/TradableApp/tokenized-ai-agent/pull/65), MERGED `30f8a61`.** 1.1 + 1.2 as
   a faithful `handleChainSynthesis` port (sanitize + retry-on-leak included, so old 1.4 ships
   here) + the plugin CI gate. 1.3 deleted, reason recorded above rather than silently dropped.
2. **PR B — OPEN.** 1.5 + 1.6. `startupConfig.js` refuses to boot on a config that cannot work,
   naming every problem at once; `answerQuality.js` moves the smoke's judgement out of the
   network script so it can be tested against the recorded failures. Verified: the code block,
   the apology and a wrong-asset answer all PASSED the old smoke and all FAIL the new one.
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

## Base-testnet deploy result — 2026-08-10 (after PR A + B + #67)

Deployed to the Sapphire-testnet TEE, oracle listening on Base Sepolia. **Smoke exited 0.**

**THE DECISIVE EVIDENCE — the payload was emitted and rejected, in the same run.** Log timeline
for convId 15:

```
23:05:18  Intermediate response: "Current macro data shows Bitco…"     ← emission 1, prose
23:05:27  MCP tool selection: query="news", language="python"
23:05:28  Intermediate response: "```typescript\nasync function r…"    ← emission 2, THE PAYLOAD
23:05:29  Processing complete signal received                           ← chain finished normally
23:05:34  ✅ Answer submitted
```

Last-writer-wins would have stored the TypeScript block — the exact original defect, reproduced
live. `selectAnswer` chose the prose instead. This is not an inference from the absence of a bug;
the bug's input occurred and was rejected. **1.1 is proven in production.**

**It was not cut short.** `onComplete` fired one second after the payload; the whole run took 47s.
There was no news still coming, because the MCP call never sought news: the model asked CoinGecko's
SDK *documentation* for `query:"news", language:"python"` and got TypeScript back. Waiting longer
would have changed nothing.

**And the news was already in hand.** The 10 items in `sources[]` came from the Brain's
marketIntelligence provider, not from MCP. So the oracle HAD the news in its provider context and
answered without using it — which is precisely the missing synthesis step, not a data gap.

**Confirmed working in production:**
- The startup guard passed inside the TEE — `--- INITIALIZING ORACLE SERVICE ---` is reached
  only after `index.js` validates, so this is live proof of #67.
- **No tool payload was stored.** The original defect is fixed on the real path.
- Provenance intact: `reasoning=2`, `sources=10`.
- Brain connected and contributed: the answer opens with real macro data (BTC dominance 58.49%,
  Fear & Greed 30/100), so the warm cache read works end to end.
- `Storage providers initialized (Arweave + Autonomys)` — confirms the review's finding that an
  unset `STORAGE_PROVIDER` means BOTH providers, which is what the boot guard now encodes.

**What the answer actually was, in full:**
> Current macro data shows Bitcoin dominance holding at 58.49%, with global market sentiment
> sitting in Fear at 30/100. 📉
>
> I am retrieving the latest verifiable on-chain metrics and network updates to analyse the
> signal behind current price action. 🔍

Half of that is substantive macro. The other half is **the acknowledgement** — it promises the
news rather than delivering it, while ten news sources sit unused in `sources[]`. The prompt asked
for the latest news on Bitcoin. So **AC 1 and AC 2 are demonstrably NOT met**, exactly as
predicted: `handleChainSynthesis` is not exported from the plugin index, no analytical action
runs, and nothing synthesises those sources into the answer. **PR C is what closes this.**

### The smoke did not catch it — a real gap in 1.6

Fed the stored answer back through `assessAnswer`: `{"fatal":[],"brain":[]}`. It passes because it
mentions Bitcoin, carries a figure, is not code, and is not an apology.

AC 5 only asked the smoke to reject code-fenced and apology-shaped answers, and it does. But
**AC 2 — "the acknowledgement text is never the final stored answer" — has no detector at all**,
and this run is precisely that violation passing as green. A smoke that reports PASS on an
unmet acceptance criterion is the same class of defect 1.6 was written to fix.

**Add to PR C:** an acknowledgement/stand-by detector — text that *promises* analysis ("I am
retrieving…", "stand by", "analysing current…") rather than delivering it. It belongs with PR C
rather than as a hotfix, because PR C is what makes the acknowledgement stop being the final
answer; adding the assertion first would just turn a passing smoke red without changing the
product. Land them together and the assertion has something to prove.

### Separately: the warm cache is stale, not cold

`sources[]` populated (hence exit 0, not 2), but the items are ~2 weeks old — Zcash's 28 July
upgrade, an Injective npm compromise. Consistent with the standing note that the cache has had no
writes since 2026-07-10. Even once synthesis lands, "latest news" would be answered from stale
news. **Operational issue, tracked separately — do not read it as a port failure.**

### Storage: no change needed, Autonomys is already the write path

`Data uploaded to Autonomys ==> CID: bafkr6i…` — every write in this run went to Autonomys,
including the answer MessageFile. Setting `STORAGE_PROVIDER=autonomys` would NOT select Autonomys:
there is no such branch in `storage.js`, so the value falls into the same else-branch as unset. It
would be a no-op that reads like a selection, which is worse than leaving it empty.

The variable is really a badly-named boolean — "Irys-only, yes or no?" — where empty means
"both initialised, write to Autonomys, keep Irys/Arweave readable for legacy data". Worth renaming
one day; not worth touching before a deploy.

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
