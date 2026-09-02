# Cost-reduction revert runbook — Santiment, CoinGecko news, X API

**Ticket:** CU-86d44ewwa · **Applied:** 2026-08-24 · **Scope:** `sense-ai-core`, `tokenized-ai-agent` (`oracle/`)

Three subscriptions were reduced together to stretch runway to the Oasis Milestone 3 and Aurora
payments. Every change is **environment-only** except one additive, default-off code change. This
document exists so the change can be reversed at mainnet without re-deriving anything.

| Item | Before | After | Saving |
|---|---|---|---|
| Santiment | A$297/mo | cancelled | A$297/mo |
| CoinGecko | Analyst US$129/mo | Basic US$35/mo | US$94/mo |
| X API | ~US$100/mo | <US$10/mo | ~US$90/mo |

> **This file and `sense-ai-core/docs/cost-reduction-revert.md` are near-identical copies, and
> they have already diverged.** Which matters, because drift between two records of the same
> config is the failure this whole ticket exists to fix.
>
> | Section | Authoritative copy | Why |
> |---|---|---|
> | §1 Santiment, §1b staleness gates | **either** — both bodies construct `SentimentEngine` | the flags genuinely apply in both |
> | §2 CoinGecko news | **either**, but the *applied* change is core-only | the oracle runs no news adapters (see §2) |
> | §3 X API | **`sense-ai-core`** | the oracle never posts to X; core's copy additionally carries the X Premium ↔ `TWITTER_MAX_TWEET_LENGTH` dependency and the mainnet budget deviations, which have no oracle equivalent |
> | Deploy/verification checklist | **per repo** | different build paths and different guards |
>
> When editing a shared section, edit both. When editing §3, edit core's only.

---

## TL;DR — full revert

```bash
# NB: these are SHELL commands. Pasting them into a session sets variables in that subshell only —
# to persist, edit the .env file itself (set the value, or DELETE the line where `unset` is shown).
#
# WHICH FILES. sense-ai-core: .env.testnet / .env.mainnet (and .env for local).
# tokenized-ai-agent: oracle/.env.oracle.base-testnet AND oracle/.env.oracle.base-mainnet
# (oracle/.env.oracle is the local default; .env.oracle.base-localnet is localnet only).
# Apply to EVERY environment whose key you are cancelling — missing one leaves a live
# adapter holding a dead key, which is the 401 case this runbook exists to avoid.
# The oracle instantiates SentimentEngine, so the sentiment flags genuinely apply in both.
SANTIMENT_ENABLED=true            # or unset entirely
SANTIMENT_API_KEY='<paste-key>'   # re-subscribe FIRST
# PER ENVIRONMENT — the order of operations below is testnet-first, so this is the
# first value you will touch. Getting it wrong towards MAX on a FREE plan requests
# data the plan does not serve; wrong towards FREE on mainnet silently backdates
# analysis by 32 days.
SANTIMENT_TIER=FREE               # .env and .env.testnet
# SANTIMENT_TIER=MAX              # .env.mainnet. NB: the code casts `as "FREE" | "PRO"`
                                  # and MAX is in neither — it works only because the
                                  # offset check is === "FREE". See §1.
unset SENTIMENT_MAX_STALE_DAYS    # restores the 45-day default

# sense-ai-core ONLY — the oracle never runs the news adapters (see §2), so setting
# this in the oracle env is a no-op.
# ⚠️  DO NOT — this flag has had NO READER since the CU-86d44xyev news rebuild, and CoinGecko
# is no longer a news source in any form. Re-upgrading to Analyst to pair with it costs
# US$94/mo and returns nothing. See the warning at the top of §2.
# COINGECKO_NEWS_ENABLED=true     # inert — kept commented as the historical record

# sense-ai-core only — restore the previous cadence.
# In a shell/deploy script these are real commands; in a .env file, DELETE the matching lines.
unset TWITTER_ACTIVE_BLOCKS
unset TWITTER_BUDGET_DAILY_POST TWITTER_BUDGET_DAILY_REPLY_MENTION TWITTER_BUDGET_DAILY_READ_MENTIONS
unset TWITTER_BUDGET_DAILY_REPLY_TIMELINE TWITTER_BUDGET_DAILY_QUOTE_TIMELINE
unset TWITTER_BUDGET_DAILY_REPLY_DISCOVERY TWITTER_BUDGET_DAILY_QUOTE_DISCOVERY
unset TWITTER_BUDGET_DAILY_LIKE TWITTER_BUDGET_DAILY_LIKE_DISCOVERY
unset TWITTER_BUDGET_DAILY_RETWEET TWITTER_BUDGET_DAILY_FOLLOW
unset TWITTER_BUDGET_DAILY_READ_TIMELINE TWITTER_BUDGET_DAILY_READ_DISCOVERY
unset TWITTER_ENABLE_DISCOVERY TWITTER_TIMELINE_ENABLE TWITTER_ENABLE_ACTIONS
unset X_DAILY_BUDGET_USD X_MONTHLY_BUDGET_USD
```

Then redeploy. **No code revert is required** — every flag defaults to the previous behaviour when
unset.

---

## 1. Santiment

**Applied:** `SANTIMENT_ENABLED=false` in `sense-ai-core` and `tokenized-ai-agent/oracle`.

**Mechanism.** `santimentAdapter.ts` reads `SANTIMENT_ENABLED !== "false"` in its constructor;
`sentimentEngine.ts`, the per-asset adapter loop (`if (!adapter.enabled || !adapter.fetchAssetMetrics) continue`) skips any adapter whose `enabled` is false. The adapter and its
registration are untouched — nothing was deleted.

**What actually changes — read this with §1b.** In *code*, sentiment degrades to `cfgiAdapter`,
which does supply per-asset `fetchAssetMetrics`. In *practice it does not*, because
`CFGI_ENABLED=false` with **no API key** in `.env`, `.env.testnet` and `.env.mainnet`. So there is
**no per-asset sentiment adapter at all** once Santiment is off — every lookup falls into the
stale-data path, which is why the gates in §1b exist. Do not read this paragraph and stop.

Were CFGI enabled, the fallback would still be thin: **2 fields**
(`cfgi_fear_greed_score`, `cfgi_fear_greed_tier`) against Santiment's ~50 on-chain/social metrics,
and a single current point where Santiment returns a time series. Broadcasts keep their cadence
and voice either way; they lose MVRV, dev activity, whale flows and social volume.

`cmcMacroAdapter` supplies `fetchMacroMetrics` only, so it covers the macro path but cannot
substitute on the per-asset path.

**Cached data survives.** `RETENTION_DAYS = 365`, and CFGI rows *insert* alongside Santiment rows
rather than overwriting them (different `recordedAt`). Historical Santiment metrics remain in
`senseai.sentiment_history` for a year.

**But they stop being read after ~23h.** Every read is `ORDER BY recordedAt DESC LIMIT 1`
(`sentimentEngine.ts` — the cache probe, the backfill probe and the stale fallback (all `ORDER BY recordedAt DESC LIMIT 1`)) and `CACHE_TTL_MS` is 23h, so once the daily
`syncTopAssets` writes a CFGI-only row it becomes the newest and reads return two fields. This is
expected, not a fault.

**Revert:** `SANTIMENT_ENABLED=true` (or unset) + restore `SANTIMENT_API_KEY`. Re-subscribe first —
a live adapter with a dead key throws 401s and rate-limit errors into the agent loop.

**`SANTIMENT_TIER` matters more than it looks.** `santimentAdapter.ts` applies
`offsetDays = tier === "FREE" ? 32 : 0`, so `FREE` deliberately fetches data ~32 days old. At the
time of writing `.env` and `.env.testnet` are `FREE` while `.env.mainnet` is `MAX`. This used to be a footgun: the cast was `as "FREE" | "PRO"` while `.env.mainnet` ran `MAX`, so the
union was untrue and a future tier-conditional branch would have mis-handled mainnet. **Fixed in
sense-ai-brain #17** — `SANTIMENT_TIER` is now a real union (`FREE | PRO | MAX`) parsed by
`parseSantimentTier`, which also strips quotes (docker-compose does not) and never falls back to
`FREE`. Set this to match
whatever plan you actually return on: get it wrong towards `FREE` and you silently pull month-old
data on mainnet.


### Where these variables live in the env files

`scripts/rofl-set-secrets.sh` splits each `.env.<env>` on the line
`# === 📄 ORC BUNDLE CONFIGURATION (PLAINTEXT) ===`:

| section | treatment |
|---|---|
| **above** the delimiter | encrypted and pushed on-chain via `oasis rofl secret set` |
| **below** the delimiter | plaintext, emitted verbatim into `docker-compose.<env>.yaml` |

Every flag in this runbook — `SANTIMENT_ENABLED`, `SANTIMENT_TIER`,
`SENTIMENT_MAX_STALE_DAYS`, `COINGECKO_NEWS_ENABLED`, `TWITTER_ACTIVE_BLOCKS`, all
`TWITTER_BUDGET_DAILY_*` and `X_*_BUDGET_USD` — is **config, below the delimiter**. Only the API
keys belong above it. Putting a config flag in the secrets section encrypts it on-chain for no
reason and makes changing it a redeploy rather than an edit.

Two rules for the config section:

- **Never quote values.** docker-compose passes quotes through verbatim, so `SANTIMENT_TIER="MAX"`
  arrives as five characters including the quotes. The script's own preflight documents this as a
  failure that has happened.
- **An empty value is omitted from compose entirely** (`elif [ -n "$REMAINDER" ]`), so the
  application default applies. That is why `TWITTER_ACTIVE_BLOCKS=` and
  `SENTIMENT_MAX_STALE_DAYS=` ship blank: the keys are present and documented, and setting them is
  a one-line edit rather than a code change.

---

## 1b. Sentiment staleness gates (added with this change)

Disabling Santiment exposed a sharper problem than a thinner sentiment line.

`cfgiAdapter` and `santimentAdapter` are the **only** adapters implementing `fetchAssetMetrics`
(`cmcMacroAdapter` is macro-only), and `CFGI_ENABLED=false` with **no API key** in `.env`,
`.env.testnet` and `.env.mainnet`. So with Santiment off there is **no per-asset sentiment adapter
at all** — `anyAdapterSuccess` stays false and every lookup falls into the stale-data branch,
which returned the newest `sentiment_history` row at **any** age. Retention is 365 days, and
`_dataTimestamp` is written in three places and read by nothing.

Left alone, broadcasts would have quoted year-old MVRV and dev activity as current market
analysis. Two gates were added:

| gate | what it does |
|---|---|
| `shouldTriggerTopAssetsSync` | The boot integrity check judged **presence** (`btcData.length === 0`), so a deployment returning after weeks idle saw rows, called itself healthy and never refreshed. It now judges **age**, with a 2-day grace so an ordinary boot does not re-sync the Top 25 and burn compute units. |
| `isStaleDataServable` + `SENTIMENT_MAX_STALE_DAYS` | The stale fallback refuses data past a maximum age and omits sentiment instead of reporting it as current. |

> **PREREQUISITE — these gates ship in `sense-ai-brain`, not in either body.** They landed in
> `sense-ai-brain` PR #17. Both bodies consume the Brain as a **path dependency copied into
> `node_modules` at install time**, so a body only has them once its submodule pointer is bumped
> **and** `bun install --force` has run there. Until then `SENTIMENT_MAX_STALE_DAYS` is a silent
> no-op and the 365-day stale-data exposure is still open.
>
> Check before relying on it:
> ```bash
> git -C <body>/packages/sense-ai-brain log -1 --oneline        # or oracle/packages/...
> grep -c isStaleDataServable node_modules/@tradableapp/sense-ai-brain/dist/index.js
> ```
> The second command is the one that matters — a bumped submodule with stale `node_modules` is
> the documented trap in the Brain's own CLAUDE.md, and it reports a false green.

**Default is 45 days, deliberately generous.** Testnet and dev run `SANTIMENT_TIER=FREE`, whose
hardcoded 32-day offset means freshly-fetched data there is *already* ~32 days old — a tighter
default would reject rows the moment they were written. The goal is not freshness; it is stopping
the 365-day worst case from reaching a broadcast. `0` means never serve stale data.

**Revert:** unset `SENTIMENT_MAX_STALE_DAYS` to restore the 45-day default. The gates themselves
should stay — they are correct regardless of whether Santiment is enabled, and with Santiment back
on the stale path is rarely reached anyway.

---

## 2. CoinGecko news

> ### ⚠️ §2 IS SUPERSEDED — `COINGECKO_NEWS_ENABLED` NO LONGER HAS A READER
>
> The news pipeline was rebuilt under **CU-86d44xyev**, after this runbook was written. All four
> per-provider adapters were replaced by a single `rssAggregatorAdapter.ts` reading ~8 RSS feeds
> (CoinDesk, The Block, Bankless, The Defiant, Protos, Decrypt, Cointelegraph, …). **CoinGecko is
> not a news source any more, in any form.**
>
> Verified 2026-09-01 — zero readers in `sense-ai-brain/src`, `sense-ai-core/src`,
> `oracle/src`, **or either installed `@tradableapp/sense-ai-brain/dist`**:
>
> | key | readers |
> |---|---|
> | `COINGECKO_NEWS_ENABLED` | **0** |
> | `COINGECKO_NEWS_FETCH_INTERVAL` | **0** |
> | `CRYPTOPANIC_ENABLED` · `CRYPTOPANIC_API_KEY` · `CRYPTOPANIC_FETCH_INTERVAL` | **0** |
> | `CRYPTORANK_ENABLED` · `CRYPTORANK_API_KEY` | **0** |
> | `SANTIMENT_ENABLED` | 4 source files + dist — **§1 is still live** |
>
> **What this means for the revert, and why it matters in money.** Following §2 as written —
> "upgrade the plan to Analyst FIRST, then set `COINGECKO_NEWS_ENABLED=true`" — would put
> **US$94/mo back on the CoinGecko bill and return no news whatsoever**, because the flag is
> inert and the adapter is gone. Do not do it. To add a source now, add a feed to
> `rssAggregatorAdapter.ts`; `/v3/news` is not involved.
>
> **`COINGECKO_API_KEY` still matters** and must stay set — it drives price via
> `COINGECKO_ENVIRONMENT: key ? "pro" : "demo"`, which is unchanged and unrelated to news.
>
> The seven dead keys are still present in the env files and composes. Harmless, but they read as
> live configuration; removing them is a separate change (the two `.env.*` files are gitignored,
> so it cannot be done from a PR alone). The two dead API keys are still valid credentials at the
> vendors and should be revoked there rather than merely deleted locally.
>
> §2 below is kept as the historical record of what was applied on 2026-08-24.


**Applied:** `COINGECKO_NEWS_ENABLED=false` **in `sense-ai-core` only**. **`COINGECKO_API_KEY`
stays set** in both.

**Scope, precisely.** The oracle never runs the news adapters — `brainContext.js` instantiates
only `SentimentEngine` and reads pre-enriched rows via `getLatestEnrichedNews()`, which is a plain
Postgres `SELECT` from `market_news` and touches no adapter and no flag. Setting
`COINGECKO_NEWS_ENABLED` in the oracle env is therefore a **no-op**. The sentiment flags are
different: the oracle does construct `SentimentEngine`, so `SANTIMENT_ENABLED` and
`SENTIMENT_MAX_STALE_DAYS` apply in both bodies.

**Why the key stays.** `/v3/news` is Analyst-and-above, so it dies on Basic — but the key is shared
with price lookups:

```js
// sense-ai-core/src/character.ts:96-98  ·  oracle/src/elizaos/character.js:58-60
COINGECKO_PRO_API_KEY: process.env.COINGECKO_API_KEY || "",
COINGECKO_ENVIRONMENT: process.env.COINGECKO_API_KEY ? "pro" : "demo",
```

**`COINGECKO_PRO_API_KEY` is NOT an env var you set — setting it changes nothing at runtime.** The
snippet above is the trap: `COINGECKO_PRO_API_KEY` is the name of the *ElizaOS setting*, and it is
populated from `process.env.COINGECKO_API_KEY`. **No code path that runs** reads
`process.env.COINGECKO_PRO_API_KEY`.

**Where it came from.** `oracle/src/aiAgentOracle.js:384-388` holds a commented-out
`plugin-coingecko` loader that *did* read it:

```js
// We use the @elizaos/plugin-mcp to connect to Coingecko MCP server instead
// ...(process.env.COINGECKO_API_KEY?.trim() &&
// process.env.COINGECKO_PRO_API_KEY?.trim()
//   ? ['@elizaos/plugin-coingecko']
//   : []),
```

That code does not run. It is almost certainly why the env var was set in the first place: the
plugin was replaced with the MCP approach, the check was commented out, and the env entry
survived. Recorded so a reader tracing only `character.js:58` does not conclude they have missed a
consumer — and so the var is not re-added if anyone un-comments that loader, which would need only
`COINGECKO_API_KEY` anyway.

A stray `COINGECKO_PRO_API_KEY=` line is sitting in `oracle/.env.oracle.base-mainnet` right now.
That file is **gitignored and not in this repo**, so you will not find it in a fresh clone — look
on the deploy machine. base-mainnet is not provisioned, so the line is inert. Delete it when
base-mainnet is provisioned rather than copying it forward, and set only `COINGECKO_API_KEY`.

Unsetting the key would silently demote **price** to the demo tier. Use the news flag instead:
`sense-ai-brain`'s `coinGeckoAdapter.ts` constructor reads `COINGECKO_NEWS_ENABLED !== "false"`, and
its `marketNewsEngine.ts` adapter loop (`if (!adapter.enabled) continue`) skips disabled adapters,
so only the news fetch stops. **Neither file exists in this repo** — they live in the Brain, which
this repo consumes as a submodule, so do not go looking for them here.

**What still works.** News continues from CoinDesk, CryptoPanic and CryptoRank (3 of 4 adapters).
CoinGecko price data is unaffected.

**Revert — order matters here too.** **Upgrade the plan to Analyst FIRST, then set
`COINGECKO_NEWS_ENABLED=true`** (or unset it). Same rule as §1: a live adapter with a dead
entitlement means 4xx errors in the news fetch loop, just as a live Santiment adapter with a dead
key means 401s. The flag alone is not enough either way — on Basic the `/v3/news` endpoint 4xxs
regardless of the flag.

---

## 3. X API

**Cost model** (`plugin-twitter-senseai/src/utils/costCalculator.ts`):

| action | cost |
|---|---|
| post **with URL** | **$0.200** |
| post without URL | $0.015 |
| reply / quote / like / follow / retweet | $0.015 |
| read — posts tier | $0.005 **per resource returned** |
| read — users tier | $0.010 per resource |
| read — owned tier (mentions, me) | $0.001 per resource |

Two things worth remembering: reads bill **per resource returned**, so an empty mention poll costs
nothing and polling frequency is nearly free; and mentions bill at the cheap *owned* tier, so the
daily post dominates spend.

### Applied settings (`sense-ai-core` only)

| variable | default | applied |
|---|---|---|
| `TWITTER_ACTIVE_BLOCKS` | unset (all 6 blocks) | `LUNCH` |
| `TWITTER_BUDGET_DAILY_POST` | 10 | `1` |
| `TWITTER_BUDGET_DAILY_REPLY_MENTION` | 20 | `5` |
| `TWITTER_BUDGET_DAILY_READ_MENTIONS` | 200 | `30` |
| `TWITTER_BUDGET_DAILY_REPLY_TIMELINE` | 6 | `0` |
| `TWITTER_BUDGET_DAILY_QUOTE_TIMELINE` | 2 | `0` |
| `TWITTER_BUDGET_DAILY_REPLY_DISCOVERY` | 4 | `0` |
| `TWITTER_BUDGET_DAILY_QUOTE_DISCOVERY` | 2 | `0` |
| `TWITTER_BUDGET_DAILY_LIKE` | 8 | `0` |
| `TWITTER_BUDGET_DAILY_LIKE_DISCOVERY` | 4 | `0` |
| `TWITTER_BUDGET_DAILY_RETWEET` | 3 | `0` |
| `TWITTER_BUDGET_DAILY_FOLLOW` | 2 | `0` |
| `TWITTER_BUDGET_DAILY_READ_TIMELINE` | 100 | `0` |
| `TWITTER_BUDGET_DAILY_READ_DISCOVERY` | 30 | `0` |
| `TWITTER_ENABLE_DISCOVERY` | true | `false` |
| `TWITTER_TIMELINE_ENABLE` | true | `false` |
| `TWITTER_ENABLE_ACTIONS` | true | `false` |
| `X_DAILY_BUDGET_USD` | 3.25 | `0.32` |
| `X_MONTHLY_BUDGET_USD` | 100 | `10` |

`TWITTER_AUTO_RESPOND_MENTIONS` stays **true** — replying to direct @mentions is the one
interaction retained.

**URL behaviour is unchanged.** `deriveRequiresUrl` remains impact-gated (score ≥8 always, 6–7 at
50%). No functionality was altered here.

### Why `TWITTER_ACTIVE_BLOCKS` exists

`BroadcastService` picks whichever block the current UTC hour falls into, and `getSchedules()` was
a hardcoded list. Capping posts at 1/day alone would hand the day's only post to **EARLY_BIRD
(04:00 UTC, "overnight market action check")** and starve the LUNCH deep-dive every day.

LUNCH (12:00–15:00 UTC) is the `isDeepDive` block — the only thread-capable pillar
(`TwitterChannel.ts:141`), standalone where AFTERNOON/EVENING depend on a Telegram anchor via
`getDependentAnchor`, and it lands at US market open.

The flag is **Twitter-scoped**: Telegram cadence is untouched. Unset means all blocks. An empty or
entirely-unrecognised value falls back to all blocks and logs a warning — silencing broadcasts via
a typo would be an outage that reads as normal quiet. To stop posting, use the
`BROADCASTS_LIVE` / `X_ENGAGEMENT_LIVE` kill switches.

**Revert:** unset `TWITTER_ACTIVE_BLOCKS` and every `TWITTER_BUDGET_DAILY_*` / `X_*_BUDGET_USD`
override. Defaults restore the previous cadence. The code change is additive and default-off, so
it can stay.

---

## 4. Phase 0 warm-run state — REVERTED 2026-08-25

The Phase 0 warm run temporarily changed `sense-ai-core/.env.testnet` so testnet could pull
current data. **This has already been reverted** — recorded here because the same swap will be
needed if the warm run is ever repeated, and because the on-chain half is easy to miss.

| variable | before | during warm run | revert to |
|---|---|---|---|
| `SANTIMENT_TIER` | `FREE` | `MAX` | `FREE` |
| `SANTIMENT_API_KEY` | the testnet key | **the mainnet key** | the testnet key |

**Why the key was swapped.** The testnet key is on the free plan. Probed directly against the
Santiment API with `mvrv_usd_z_score`: at the current window it returned 0 points and *"Both `from`
and `to` parameters are outside the allowed interval"* — identical to an unauthenticated request —
while the mainnet key returned data. `MAX` removes the 32-day offset, so a free key at `MAX` asks
for a window it cannot serve and every paid metric comes back empty.

**The on-chain half is the part that is easy to miss.** The mainnet key is pushed as an encrypted
ROFL secret into the *testnet* app, so reverting the file alone leaves it there — you must re-run
`rofl:set:testnet` to overwrite it. That was done on 2026-08-25; the testnet and mainnet key
fingerprints were confirmed to differ again afterwards.

### Deploy ordering footgun (cost one wrong-tier deploy)

`rofl:build` bundles `docker-compose.<env>.yaml` into the ORC, but the script that regenerates
that file from `.env.<env>` (`scripts/rofl-set-secrets.sh`) runs **inside `rofl:update`**, not
before the build. So this order silently ships the PREVIOUS config:

```
rofl:build → rofl:update → rofl:deploy      # WRONG: ORC has stale compose
rofl:set   → rofl:build  → rofl:update → rofl:deploy   # correct
```

The first Phase 0 deploy hit exactly this: `.env.testnet` said `MAX`, the bundled compose said
`FREE`, and the run fetched with the free-tier 32-day offset. **Verify before deploying:**

```bash
grep SANTIMENT_TIER docker-compose.yaml     # this is what actually ships
```

---

## Order of operations (why it mattered)

1. Deploy core testnet **as-is** to warm `senseai.sentiment_history` while the Santiment
   subscription was still live (365-day retention preserves it for mainnet).
2. Deploy the disables and verify on a fresh testnet TEE, querying an asset with **no** cached
   sentiment so the CFGI path is genuinely exercised rather than masked by a warm cache.
3. **Only then** cancel Santiment and downgrade CoinGecko.

Reversing 2 and 3 would leave a live adapter holding a dead key, throwing 401s and rate-limit
errors into the agent loop. On the way back, apply the same rule: **re-subscribe before
re-enabling.**

---

## Verification checklist (either direction)

- [ ] **`bun run rofl:build:<env>` passes its preflight.** `scripts/rofl-preflight.sh` refuses to
      build an ORC bundle whose plaintext block holds a placeholder or a quoted value. It refuses
      quoted values *because* docker-compose does not strip the quotes: `SANTIMENT_TIER="MAX"`
      reaches the container as the five characters `"MAX"`, an exact comparison fails, and the
      FREE-tier branch is taken silently. That is a §1 setting, so this is the failure mode of
      this very runbook, not a hypothetical. It also now refuses a compose with **no ORC marker**
      at all, which previously passed as clean because the scan never opened.
      This repo has been gated since the compose-validation work; `sense-ai-core` was not gated
      until CU-86d44ewwa and now mirrors it, sharing the same `rofl-config-patterns.sh` shape.
- [ ] **Brain gates actually live** — `SENTIMENT_MAX_STALE_DAYS` is a silent no-op until the
      submodule is bumped AND `bun install --force` has run. Check the INSTALLED dist, not the
      submodule log, because a bumped submodule with stale `node_modules` reports a false green:
      `grep -c isStaleDataServable node_modules/@tradableapp/sense-ai-brain/dist/index.js`
- [ ] Sentiment section renders; no 401 / rate-limit errors in the agent loop
      (NB: this passes even with 365-day-old data if the gates above are not live — check both)
- [ ] News flowing from CoinDesk, CryptoPanic, CryptoRank
- [ ] CoinGecko price resolves at `pro`; news skipped with the expected warning when disabled
- [ ] Exactly one X post per day, inside the LUNCH window.
      **Not verifiable under `SENSEAI_BROADCAST_DEBUG_MODE=MOCK_ALL`/`LIVE_ALL`** — those modes
      deliberately ignore `TWITTER_ACTIVE_BLOCKS` and run every pillar. Use `OFF` or
      `MOCK_CURRENT` for this check.
- [ ] Telegram broadcast cadence unchanged
- [ ] Daily summary `costUsd` tracking under budget

Testnet ROFL leases (`playground_short`) last ~1h, so have the checks ready before deploying.
Successful heartbeats log at INFO, which `oasis rofl machine logs` does not surface — query
Cloud SQL rather than inferring health from log silence.
