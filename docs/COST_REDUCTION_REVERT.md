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

---

## TL;DR — full revert

```bash
# sense-ai-core AND tokenized-ai-agent/oracle
SANTIMENT_ENABLED=true            # or unset entirely
SANTIMENT_API_KEY=<restore>       # re-subscribe first
COINGECKO_NEWS_ENABLED=true       # or unset entirely

# sense-ai-core only — unset ALL of these to restore the previous cadence
TWITTER_ACTIVE_BLOCKS
TWITTER_BUDGET_DAILY_POST  TWITTER_BUDGET_DAILY_REPLY_MENTION  TWITTER_BUDGET_DAILY_READ_MENTIONS
TWITTER_BUDGET_DAILY_REPLY_TIMELINE  TWITTER_BUDGET_DAILY_QUOTE_TIMELINE
TWITTER_BUDGET_DAILY_REPLY_DISCOVERY  TWITTER_BUDGET_DAILY_QUOTE_DISCOVERY
TWITTER_BUDGET_DAILY_LIKE  TWITTER_BUDGET_DAILY_LIKE_DISCOVERY
TWITTER_BUDGET_DAILY_RETWEET  TWITTER_BUDGET_DAILY_FOLLOW
TWITTER_BUDGET_DAILY_READ_TIMELINE  TWITTER_BUDGET_DAILY_READ_DISCOVERY
TWITTER_ENABLE_DISCOVERY  TWITTER_TIMELINE_ENABLE  TWITTER_ENABLE_ACTIONS
X_DAILY_BUDGET_USD  X_MONTHLY_BUDGET_USD
```

Then redeploy. **No code revert is required** — every flag defaults to the previous behaviour when
unset.

---

## 1. Santiment

**Applied:** `SANTIMENT_ENABLED=false` in `sense-ai-core` and `tokenized-ai-agent/oracle`.

**Mechanism.** `santimentAdapter.ts` reads `SANTIMENT_ENABLED !== "false"` in its constructor;
`sentimentEngine.ts:511` skips any adapter whose `enabled` is false. The adapter and its
registration are untouched — nothing was deleted.

**What actually changes.** Sentiment does not error or disappear; it degrades to `cfgiAdapter`,
which still supplies per-asset `fetchAssetMetrics`. But the fallback carries **2 fields**
(`cfgi_fear_greed_score`, `cfgi_fear_greed_tier`) against Santiment's ~50 on-chain/social metrics,
and CFGI returns a single current point where Santiment returns a time series. Broadcasts keep
their cadence and voice; they lose MVRV, dev activity, whale flows and social volume.

`cmcMacroAdapter` supplies `fetchMacroMetrics` only, so it covers the macro path but cannot
substitute on the per-asset path.

**Cached data survives.** `RETENTION_DAYS = 365`, and CFGI rows *insert* alongside Santiment rows
rather than overwriting them (different `recordedAt`). Historical Santiment metrics remain in
`senseai.sentiment_history` for a year.

**But they stop being read after ~23h.** Every read is `ORDER BY recordedAt DESC LIMIT 1`
(`sentimentEngine.ts:455`, `:481`, `:547`) and `CACHE_TTL_MS` is 23h, so once the daily
`syncTopAssets` writes a CFGI-only row it becomes the newest and reads return two fields. This is
expected, not a fault.

**Revert:** `SANTIMENT_ENABLED=true` (or unset) + restore `SANTIMENT_API_KEY`. Re-subscribe first —
a live adapter with a dead key throws 401s and rate-limit errors into the agent loop.

`SANTIMENT_TIER` (`"FREE" | "PRO"`, default `PRO`) controls the free-tier 30-day offset. If you
return on a cheaper plan, set `SANTIMENT_TIER=FREE`.

---

## 2. CoinGecko news

**Applied:** `COINGECKO_NEWS_ENABLED=false`. **`COINGECKO_API_KEY` stays set.**

**Why the key stays.** `/v3/news` is Analyst-and-above, so it dies on Basic — but the key is shared
with price lookups:

```js
// sense-ai-core/src/character.ts:96-98  ·  oracle/src/elizaos/character.js:58-60
COINGECKO_PRO_API_KEY: process.env.COINGECKO_API_KEY || "",
COINGECKO_ENVIRONMENT: process.env.COINGECKO_API_KEY ? "pro" : "demo",
```

Unsetting the key would silently demote **price** to the demo tier. Use the news flag instead:
`coinGeckoAdapter.ts:28` reads `COINGECKO_NEWS_ENABLED !== "false"` and `marketNewsEngine.ts:81`
skips disabled adapters, so only the news fetch stops.

**What still works.** News continues from CoinDesk, CryptoPanic and CryptoRank (3 of 4 adapters).
CoinGecko price data is unaffected.

**Revert:** `COINGECKO_NEWS_ENABLED=true` (or unset) **and** re-upgrade the plan to Analyst. The
flag alone is not enough — on Basic the endpoint 4xxs.

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

- [ ] Sentiment section renders; no 401 / rate-limit errors in the agent loop
- [ ] News flowing from CoinDesk, CryptoPanic, CryptoRank
- [ ] CoinGecko price resolves at `pro`; news skipped with the expected warning when disabled
- [ ] Exactly one X post per day, inside the LUNCH window
- [ ] Telegram broadcast cadence unchanged
- [ ] Daily summary `costUsd` tracking under budget

Testnet ROFL leases (`playground_short`) last ~1h, so have the checks ready before deploying.
Successful heartbeats log at INFO, which `oasis rofl machine logs` does not surface — query
Cloud SQL rather than inferring health from log silence.
