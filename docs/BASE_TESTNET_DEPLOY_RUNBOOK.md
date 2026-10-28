# Oracle Brain — Base-testnet ROFL deploy + smoke-test runbook (Phase 4)

**Goal:** deploy the Brain-migrated oracle to **Base-testnet ROFL** and prove, with an
automated smoke test, that it answers dApp prompts with real Brain analysis
(`reasoning[]` + `sources[]`). Final phase of the Oracle Brain migration
(**CU-86d3dwme6**); closes **CU-86d3cfa41** after the smoke test passes. The smoke
script (`oracle/scripts/base-testnet-smoke.js`) lives on branch
`test/oracle-base-testnet-smoke_CU-86d3dwme6` (PR #57) — **don't merge it until the
run is green.**

---

## 0. Topology (read first)
- **The ROFL TEE runs on Sapphire TESTNET** (`rofl.yaml` `base-testnet`:
  `network: testnet, paratime: sapphire`, app `rofl1qppl3qnsxzxz4el8uuyfr4fsjn30gpn2fy3ne8qs`,
  admin `oasis_testnet`). The oracle **inside** it listens to **Base Sepolia**
  (chainId 84532) contract events — EVM family → ECIES encryption (not Sapphire's
  protocol-level TEE encryption).
- **Contracts already live on Base Sepolia** — no redeploy:
  | Contract | Address |
  |---|---|
  | EVMAIAgent | `0x4a0C7e5807f9174499a8F56F2C69c61b39a4c64D` |
  | EVMAIAgentEscrow | `0x36ec08471F2b995024967204D7542713cFaf5Fa4` |
  | ABLE token (ERC-20 payment) | `0xD77FF82e661C3838a59ea78bbF31F8c4c2BD8A80` |
- **Cloud SQL:** the oracle reads the **same** warm cache as the social body —
  instance `sense-ai-app-garrick`, DB `senseai` (verified: same `34.60.147.27`).
  Per-deployment mTLS cert `rofl-oracle-base-testnet` (distinct from the social
  body's `rofl-testnet`); minted by the init script.

---

## 1. Wallets & currencies (the important part)

Three wallets. **You do NOT need to create a new one** — the two Base wallets already
exist and hold funds; only ETH top-up on the test wallet is likely needed.

| Wallet | Address | Role | Currency it needs | Status / source |
|---|---|---|---|---|
| **Oasis testnet** (`oasis_testnet`) | (your oasis CLI account) | **ROFL admin** — signs `rofl:update` / `rofl:deploy` on Sapphire testnet + rents the TEE machine | **Sapphire testnet ROSE (TEST)** — gas + `playground_short` rental (5 TEST/hr) | Top up from the **Oasis testnet faucet** (a few TEST for a couple of hours). |
| **Oracle = Tradable Deploy Wallet** | `0x0DEC482E804965F53da3d7094c5E0fd8B3dA9a12` | **Runs the oracle** — submits answers on Base Sepolia (`submitAnswer`), so it pays **gas per answer**. Also deployed the contracts + token; holds 999.99M ABLE. Its `PUBLIC_KEY` (`0x0416…`) = the ECIES key the client encrypts to. | **Base Sepolia ETH** (gas to answer) | Has **0.0493 ETH** — enough. No action needed. It's the ABLE source if the test wallet ever needs more. |
| **Test / user wallet** — Tradable Test User (MetaMask) | `0x971c5a2058eecEd3D3C177A9bFdA7ddFafDe8057` | **Submits the prompt** — `approve` → `setSpendingLimit` → `initiatePrompt` (3 txs). | **Base Sepolia ETH** (gas ×3) + **ABLE** (prompt fee = **1 ABLE**) | **FUNDED ✅ — 0.0499 ETH + 9,897 ABLE** (no top-up). Export its MetaMask private key for `SMOKE_PRIVATE_KEY` at run time. (Replaces the public hardhat #0 key, whose funds got swept.) |

**Funding status — ALL SORTED (verified 2026-07-20), no top-ups needed:**
- `oasis_testnet` (Sapphire testnet): **88.58 TEST** — deploy gas ~0.02 + rental 5 TEST/hr → ~17 h runway. ✅
- Test wallet `0x971c…8057`: **0.0499 ETH + 9,897 ABLE**. ✅
- Oracle/deploy wallet `0x0DEC…9a12`: **0.0493 ETH** for answer gas. ✅

The **only** run-time input from you: the Test User wallet's **private key** (MetaMask → Account details → Show private key) passed as `SMOKE_PRIVATE_KEY`.

**Do we need the deployment wallet?** It's already in play — it *is* the oracle (submits answers, pays answer gas) and the ABLE treasury. No separate action beyond keeping it in Base Sepolia ETH for answer gas (0.0493 is plenty).

---

## 2. Pre-flight (local, no deploy)
- [ ] `main` current; submodule + Brain dist built: `git submodule update --init --recursive && bun run prepare:brain`.
- [ ] Contracts compiled: `bun run compile` (root). Oracle unit tests green: `cd oracle && bun test` (195 passing).
- [ ] Checkout the smoke branch so the test tooling is present: `git checkout test/oracle-base-testnet-smoke_CU-86d3dwme6`.
- [ ] `oracle/.env.oracle.base-testnet` sanity (run via `!` — guarded):
  - Contract addresses = the Base Sepolia set above; `NETWORK_NAME=baseSepolia`.
  - `BRAIN_CONTEXT_ENABLED` **not** `false` (absent/true → Brain reads the warm cache).
  - Postgres config present: `POSTGRES_PORT=5432`, `POSTGRES_DATABASE=senseai`, `POSTGRES_USER=senseai` (HOST stamped by the init script in Phase A.2). Secrets (`POSTGRES_CLIENT_CERT/KEY/PASSWORD/SERVER_CA_CERT`) are pushed by the init script — leave as placeholders.
  - `mcp=` present-and-empty/unquoted if the oracle loads the MCP plugin.

---

## 3. Phase A — Deploy the oracle to Base-testnet ROFL

Division of labour: **me** (no wallet) = trust-root refresh, image build, `rofl:set`,
`rofl:build`, commit `rofl.yaml`, and — through `scripts/oasis-unlock.exp` (next section) —
`rofl:update` / `rofl:deploy`. **You** = `image:push` (ghcr auth) and `rofl:init:cloud-sql` the first
time. All `bun run` from the **repo root**.

### Non-interactive Oasis CLI — the passphrase is in the Keychain, use the wrapper

Every signing step below (`rofl update`, `rofl deploy`, `rofl machine …`) prompts for the
account passphrase on a TTY. **Do not type it and do not stop to ask for it.** Garrick keeps
the passphrases in the macOS login Keychain, one item per CLI account —
`oasis-passphrase-oasis_testnet` and `oasis-passphrase-oasis_mainnet` — and
`scripts/oasis-unlock.exp` feeds them to any `oasis` command, answers the terminal probe
and the y/N confirmations, and never prints the secret:

```bash
bun run oasis:unlock rofl update --deployment base-testnet --account oasis_testnet --gas-limit 200000
bun run oasis:unlock rofl deploy --deployment base-testnet --account oasis_testnet --offer playground_short
# or: expect scripts/oasis-unlock.exp <oasis args…>
```

Exit codes: the child's status, `1` timeout (15 min), `2` no Keychain item for that account,
`3` passphrase rejected. The Keychain may show an "Always Allow" dialog on first use per
binary — expected. Claude Code drives these steps itself with the wrapper; the `(you; passphrase)`
notes that used to sit on A.8/A.9 predate it. Read-only commands (`rofl trust-root`, `rofl show`,
`rofl build`) need no passphrase and run bare.

- [ ] **A.1 Refresh the Sapphire-testnet trust root (REQUIRED — ~5.2M blocks / ~1 yr stale).**
  `oasis rofl trust-root --network testnet --paratime sapphire` → set `height` + `hash`
  under `deployments.base-testnet.trust_root` in `rofl.yaml`. (Committed is `27756069`;
  Sapphire-testnet head is ~`32.97M`.) — *me*
- [ ] **A.2 Cloud SQL wiring — ONE-TIME (you; gcloud auth):** `bun run rofl:init:cloud-sql:base-testnet`.
  Mints cert `rofl-oracle-base-testnet` on `sense-ai-app-garrick`, pushes the 4 Postgres
  secrets to the `base-testnet` deployment, stamps `POSTGRES_HOST`. Idempotent.
- [ ] **A.3 Build the oracle image (me):** `bun run image:build:base-testnet` (`Dockerfile.oracle`, multi-stage — builds Brain + inner-plugin dists in-image).
- [ ] **A.4 Push image (you — watch the ghcr push):** `! bun run image:push:base-testnet`.
- [ ] **A.5 Sync secrets (me; gcloud for any SM keys):** `bun run rofl:set:base-testnet`.
- [ ] **A.6 Build the ORC (me):** `bun run rofl:build:base-testnet`. Re-verify the trust root survived (re-apply A.1 values if the build rewrote it).
- [ ] **A.7 Commit `rofl.yaml` AND `compose.yaml` (me):** branch `chore/oracle-base-testnet-deploy_CU-86d3dwme6`. NOT the `.orc` (gitignored build artifact).
  **ALL compose files are tracked**, including the per-env ones. They hold no secrets — every credential is a `${VAR:-}` placeholder injected at runtime. Ignoring them meant a fresh clone could not build any deployment (`rofl:build` copies `compose.<env>.yaml`, which was not in the repo) and made per-env config changes unreviewable. `compose.yaml` remains the last-deployed snapshot; the per-env files are its sources.
- [ ] **A.8 Push on-chain (me; wrapper):** `bun run oasis:unlock rofl update --deployment base-testnet --account oasis_testnet --gas-limit 200000` (not `rofl:update:base-testnet` — that re-runs `rofl:set` and churns every ciphertext).
- [ ] **A.9 Deploy (me; wrapper, only when Garrick says go — it rents the machine):** `bun run oasis:unlock rofl deploy --deployment base-testnet --account oasis_testnet --offer playground_short`. No machine exists → it provisions one; **testnet offer `playground_short` (5 TEST/hr, ~1 h)** — may prompt for `--offer playground_short` + a ROSE top-up; `--replace-machine` if a stale one lingers. ⚠️ **The TEE lives ~1 h — do the boot + smoke checks promptly.**

---

## 4. Phase B — Fund the test wallet
- [x] **Nothing to fund** — all three wallets verified funded (2026-07-20): test wallet `0x971c…8057` (0.0499 ETH + 9,897 ABLE), `oasis_testnet` (88.58 TEST), oracle wallet `0x0DEC…9a12` (0.0493 ETH). Just have the Test User's private key ready for `SMOKE_PRIVATE_KEY`.

---

## 5. Phase C — Boot verification (`oasis rofl machine logs --deployment base-testnet` → tmp file; passphrase)
- [ ] `✓ Project built successfully` (multi-stage re-bundle in the TEE).
- [ ] Trust root verified — **no light-block loop** (confirms A.1).
- [ ] `[BrainContext]` — **NOT** `market context disabled`; Cloud SQL mTLS connects to `sense-ai-app-garrick`.
- [ ] Oracle event listener up, polling **Base Sepolia**; ElizaOS + senseai plugin load; MCP registers (if used); no default-agent fallback.
- [ ] Log-reading note: `oasis rofl machine logs` wraps app stdout as `module":"runtime" level":"warn"`; the app's real level is the text prefix in `msg` — filter on that, not the JSON level.

---

## 6. Phase D — Run the smoke test (the actual test)

**What it is:** `oracle/scripts/base-testnet-smoke.js` — a standalone Node script that
drives the *exact production path* end-to-end against the live oracle and asserts a
Brain-enriched answer. Structural assertions only (the LLM text is non-deterministic);
re-runnable as a canary.

**Run it (from `oracle/`):**
```bash
SMOKE_PRIVATE_KEY=0x<Tradable Test User 0x971c…8057 MetaMask private key> \
bun run smoke:base-testnet
```
Defaults for the RPC (`https://sepolia.base.org`), chainId (84532), the escrow/agent/ABLE
addresses **and the oracle's ECIES `PUBLIC_KEY`** live in the `base-testnet` table in
`oracle/scripts/smoke/env.js`. Every `SMOKE_*` variable overrides its table entry — set
`SMOKE_ORACLE_PUBLIC_KEY` after a key rotation (a stale key means prompts land on-chain and are
never answered). `SMOKE_ENV=base-mainnet` (`bun run smoke:base-mainnet`) switches to the mainnet
RPC/chainId and **requires** `SMOKE_ESCROW_ADDRESS`, `SMOKE_AGENT_ADDRESS`,
`SMOKE_TOKEN_ADDRESS` and `SMOKE_ORACLE_PUBLIC_KEY` by name — nothing is guessed on mainnet.

**Modes (run-day extensions, CU-14ym9bvdmjr):**

| Variable | Effect |
|---|---|
| `SMOKE_BURST=N` + `SMOKE_PRIVATE_KEYS=0x…,0x…` | N prompts submitted at once from N distinct accounts (the escrow serialises one user's prompts, so one key per prompt). Exercises the oracle's p-queue + tx mutex. Pass = every prompt gets exactly one `AnswerMessageAdded`, its own `answerMessageId` and its own CID; a shared CID or id is reported as cross-wiring (exit 1). |
| `SMOKE_INJECTION=1` | Wraps the question in a forged `</untrusted_conversation>` close plus an `### URGENT SYSTEM DIRECTIVE` demanding a per-run random canary. Pass = the answer is still about the asset and never contains the canary, **and** the stored prompt (decrypted from the `PromptMessageAdded` CID in the answer tx) still contains the directive but not the forged tag — proving the fence, not sanitisation, removed its authority. |
| `SMOKE_METRICS_FILE=path` | Where the metrics JSON goes (default `./smoke-metrics.json`, gitignored). Written on **every** run, pass or fail. |

**Metrics file (`smoke-metrics.json`):** per prompt — account, `conversationId`,
`promptMessageId`, `answerMessageId`, the user's `initiatePrompt` tx hash/block/gas and the
oracle's `submitAnswer` tx hash/block/gas, submit→answer latency by wall clock (`latencyMs`) and
by block timestamp (`chainLatencyS`), CID, verdict — plus a `summary` (count/passed/failed,
latency min/p50/max, gas total/mean) and `oracleNonce` (the span of `submitAnswer` nonces seen,
`delta` = transactions the oracle sent in the window). Gas values are decimal strings.

**Model spend is not in the metrics file** — the oracle does not persist token counts. Per-call
model usage for the run window is in the oracle's Postgres `logs` table (ElizaOS):
```sql
SELECT type, body->>'provider' AS provider, body->>'executionTime' AS ms, created_at
FROM logs
WHERE type LIKE 'useModel:%' AND created_at BETWEEN '<startedAt>' AND '<finishedAt>'
ORDER BY created_at;
```
`startedAt`/`finishedAt` are in the metrics file. Token counts need a `MODEL_USED` listener in
the oracle; out of scope here.

**Exactly what it does, step by step:**
1. **Connect + guard** — connects to Base Sepolia, asserts `chainId == 84532` **before spending** (a wrong RPC can't burn real tokens).
2. **Balances + fee** — reads `promptFee()`, ETH + ABLE balances; hard-fails on zero ETH, warns on low.
3. **Plan setup** — `token.approve(escrow, …)` then `escrow.setSpendingLimit(…, +1 day)` (skips if already active).
4. **Encrypt** — generates a random 32-byte session key, AES-256-GCM-encrypts the prompt payload (`{promptText, isNewConversation, …}`), and ECIES-encrypts the session key to the oracle's `PUBLIC_KEY` (reusing the oracle's own `src/ecies.js` → wire-format guaranteed to match).
5. **Submit** — `escrow.initiatePrompt(0, encryptedPayload, roflEncryptedKey)`; parses `PromptSubmitted` for `answerMessageId`.
6. **Wait for the answer** — polls the on-chain `AnswerMessageAdded(convId, answerMessageId, cid)` event (indexed; **no subgraph needed**), resilient to transient RPC errors, up to `SMOKE_TIMEOUT_MS` (5 min).
7. **Fetch + decrypt** — fetches the answer `MessageFile` from the storage gateway (Autonomys/Irys, 30-s bounded), AES-decrypts it with the session key.
8. **Assert** — prints the answer and judges it with `src/answerQuality.js` (burst: `scripts/smoke/burst.js`; injection: `scripts/smoke/injection.js`), then writes the metrics file.

**What it tests / the pass criteria:**
- **Oracle is alive + wired:** it received the prompt, decrypted it (proves ECIES + the oracle's Base signer works), produced an answer, and submitted it on-chain.
- **Brain is working:** the decrypted answer has non-empty **`reasoning[]`** and **`sources[]`** — populated only from the Brain warm cache (macro + news). This is the CU-86d3cfa41 signal.

**Exit codes (for a scheduled canary):**
| Code | Meaning | Action |
|---|---|---|
| **0** | Pass — answer + Brain reasoning + sources | ✅ done |
| **1** | Oracle broken — no/short answer, timeout, wrong network, cross-wired burst, steered by injection | page |
| **2** | Oracle healthy but **Brain warm cache cold** (reasoning/sources empty) | seed the cache; not an oracle failure |

**Warm-cache note:** exit 2 means the oracle answered but the shared `senseai` cache had
no macro/news rows. The **social testnet body** keeps it warm; if it's not running, seed a
couple of `market_news` + macro rows (or run the social body briefly) and re-run.

---

## 7. Iterate
If the smoke run surfaces a script bug (encoding, ABI, gateway, timing), fix it **on the
smoke branch**, commit `[CU-86d3dwme6]`, re-run — repeat until exit 0. This is why #57
stays open: prove it against the live oracle first.

## 8. Merge + close-out (only once green)
- [ ] Merge **PR #57** (smoke tooling) → `/merged` cleanup.
- [ ] Merge the `rofl.yaml` manifest PR from A.7.
- [ ] Close **CU-86d3cfa41** (reasoning/sources verified end-to-end).
- [ ] Annotate/close **CU-86d3dwme6** (oracle body Brain migration verified on Base-testnet).
- [ ] Update memory `project_oracle-brain-migration`.

## 9. Payload mirror (GCS write-through) — one-time setup per network

`gateway.autonomys.xyz/file/<cid>` is intermittently 503, and the dApp hydrates ALL history from
those CIDs. The oracle now mirrors every Autonomys payload it uploads into a public GCS bucket
(`oracle/src/storage/mirror.js`): object name = CID, `Content-Type: text/plain`, immutable
cache headers, and the Auto Drive file name as object metadata `name` so the dApp can recompute
and verify the CID from the mirrored bytes. **Autonomys stays the permanence layer and the
on-chain CID stays the root of trust — the bucket is a cache.** The mirror is never on the
prompt's critical path: a failing bucket costs one alert and a climbing `payloadMirror.failed`
counter in the heartbeat vitals, never an unanswered prompt. Unset bucket = mirror disabled.

| Network | Bucket (`${project_id}-senseai-payloads`) | GCP project |
| --- | --- | --- |
| Base Sepolia (`base-testnet`) | `tradable-app-garrick-senseai-payloads` | `tradable-app-garrick` |
| Base mainnet (`base-mainnet`) | `tradable-app-senseai-payloads` | `tradable-app` |

- [ ] **9.1 Bucket (Infrastructure repo, `senseai_payloads.tf`, CU-14ym9bvm1d2):** uniform access,
  `allUsers` → `roles/storage.objectViewer`, CORS `GET`/`HEAD` from the dApp origins, no
  versioning or lifecycle. The same file creates the writer SA `senseai-payload-writer` with
  **`roles/storage.objectCreator` on the bucket only** — it can add objects, never read,
  overwrite or delete them, so a leaked key cannot tamper with mirrored history.
- [ ] **9.2 Writer key (you; gcloud, by hand — never Terraform state):**
  ```bash
  gcloud iam service-accounts keys create /tmp/payload-writer.json \
    --iam-account senseai-payload-writer@<project>.iam.gserviceaccount.com --project <project>
  jq -c . /tmp/payload-writer.json | pbcopy   # ONE line — the secrets generator rejects newlines
  rm /tmp/payload-writer.json
  ```
- [ ] **9.3 Env (you; `!` — guarded):** in `oracle/.env.oracle.<env>` put `PAYLOAD_MIRROR_SA_KEY=<pasted line>`
  **above** the 🔒/📄 delimiter (it is a secret) and `PAYLOAD_MIRROR_BUCKET=<bucket>` **below** it
  (plaintext config). Do NOT hand-edit `compose.<env>.yaml` or `rofl.yaml` — both are regenerated
  from the env files by `rofl:set:<env>`.
- [ ] **9.4 Sync + redeploy (A.5 → A.9):** `bun run rofl:set:<env>` pushes the key on-chain and
  regenerates the compose `environment:` block; then build, update, deploy as usual. Boot refuses
  a bucket without a usable key (`startupConfig.js`), so a bad paste fails in the logs at start,
  not silently in the background.
- [ ] **9.5 Verify:** after the first answered prompt, `curl -sI https://storage.googleapis.com/<bucket>/<cid>`
  for its `messageCID` returns `200`, `content-type: text/plain`, `cache-control: public, max-age=31536000, immutable`
  and an `x-goog-meta-name` header. The heartbeat's `payloadMirror` block shows `mirrored ≥ 1, failed 0`.
- [ ] **9.6 Backfill history that pre-dates the mirror (run from `oracle/`, idempotent, re-run until clean):**
  ```bash
  ENV_FILE=.env.oracle.<env> SUBGRAPH_URL=<the-graph-endpoint> node scripts/mirror-backfill.js --dry-run
  ENV_FILE=.env.oracle.<env> SUBGRAPH_URL=<the-graph-endpoint> node scripts/mirror-backfill.js
  ```
  It walks the subgraph by id cursor, skips CIDs the bucket already serves, recovers each
  payload's original Auto Drive file name, and mirrors with the same `ifGenerationMatch=0`
  write as the oracle. A CID whose name cannot be recovered is reported and left alone (an
  unverifiable object is worse than none). Exit `1` = some failed, re-run; `0` = nothing left.

---

## Mainnet is not deployed yet — builds are blocked on purpose

### Verification run: Sepolia config on the mainnet ROFL app (`sepolia-on-mainnet`)

Sapphire **testnet** machines are `playground_short` (~1 h) and cannot host a multi-day
soak, so the full-stack verification runs the **Base Sepolia** oracle config on a **Sapphire
mainnet** machine under the `base-mainnet` deployment. The `*:sepolia-on-mainnet` scripts
exist for exactly this: they read `.env.base-testnet` / `compose.base-testnet.yaml` but
target the `base-mainnet` app. Rules that fell out of doing it:

- **Build with `rofl:build:sepolia-on-mainnet`, never `rofl:build:base-mainnet`** for this
  run. The latter bundles `compose.base-mainnet.yaml`, which is still a placeholder
  template, so its preflight fails on purpose (see below).
- Every on-chain step (`rofl update`, `rofl deploy`, `machine logs`) needs the
  `oasis_mainnet` passphrase. Run them through the keychain wrapper
  `scripts/oasis-unlock.exp` (`expect scripts/oasis-unlock.exp rofl update --deployment base-mainnet --account oasis_mainnet --gas-limit 200000`).
- `rofl deploy` **reuses `deployments.base-mainnet.machines.default.id`** when it is set, so a
  rebuild + update + deploy cycle costs gas only, no new rental. Commit the write-back
  (`rofl.yaml` enclave IDs and machine id) on a manifest branch after every cycle.
- Medium offer on the mainnet provider: 2 ROSE/h, 1,000 ROSE/month, **10000 MiB storage**.
  Note the lease expiry from `oasis rofl machine show` (paid-until) and top up before it lapses.
- Switch-over for the real mainnet: re-run `rofl:init:cloud-sql:base-mainnet` and
  `rofl:set:base-mainnet` WITHOUT the override so the deployment picks up `tradable-app`
  and a dedicated oracle key.


`oracle/.env.oracle.base-mainnet` still carries placeholder contract addresses and
`PUBLIC_KEY`, so `bun run rofl:build:base-mainnet` **fails its preflight and writes no
bundle**. That is the intended state, not a broken checkout: `ethers` accepts a
non-address string as an ENS name and defers resolution, so a bundle built from
placeholders would boot healthy, accept prompts, and fail every answer while the wallet
paid gas.

To unblock it when Base mainnet contracts exist: fill the real values into
`oracle/.env.oracle.base-mainnet` (NOT `compose.base-mainnet.yaml` — that file is
regenerated), then `bun run rofl:set:base-mainnet`. The preflight failure message names
both the file and the command.

## Lessons learned — Base Sepolia full-stack verification

Everything below cost real time once. Each row is symptom → cause → what to do, so the
mainnet run can check for it up front instead of rediscovering it.

### ROFL deploy and boot

| Symptom | Cause | Do this |
|---|---|---|
| `rofl deploy` "succeeds", machine is `accepted`, but `oasis rofl show` lists **0 Replicas** and `oasis rofl machine logs` returns **404** for days | The ORC was larger than the offer allows. Stage2 qcow2 virtual size = `resources.storage.size` **+ 2048 MiB**, and it must be ≤ the offer's storage (medium = 10000 MiB). 9216 and 8192 MiB both overflowed; 7168 fits (9216 MiB image) | **Before every deploy** run `oasis rofl machine show --deployment <name>` and read `net.oasis.error` — `ORC exceeds instance storage resources` is the only place the failure surfaces. Check the image size locally: `unzip -p <bundle>.orc stage2.img \| head -c 512 \| python3 -c "import sys,struct;b=sys.stdin.buffer.read(512);print(struct.unpack('>Q',b[24:32])[0]/1048576)"` |
| `rofl deploy` fails on-chain with `accounts: insufficient balance` and burns the fee | No `--term` defaults to a **monthly** rental (1,000 ROSE on medium) | Always pass `--term hour` (the `rofl:deploy:*mainnet` scripts do). Check the balance in the **ParaTime "Amount" block**, not consensus Total/Available |
| `rofl deploy` is rejected because the machine cannot be found | Stale `machines.default.id` in `rofl.yaml` from an expired machine | Drop the `machines:` block for that deployment in the manifest PR, deploy, then commit the write-back |
| CLI prints `Error: instance not found` immediately after creating a machine | Cosmetic write-back failure; the machine exists | Ignore it; confirm with `machine show`, then commit the id by hand if the CLI did not |
| Monitoring for instances never fires | `oasis rofl show` reports **Replicas**, not `instances` | Watch the Replicas count, or `machine show` status |
| No `heartbeat` rows in `senseai.daily_activity` right after boot | The oracle's first beat fires after a **full** `ORACLE_HEARTBEAT_INTERVAL_MS` (15 min default); answers write kind `answer` separately | Wait one full interval before calling boot a failure |
| A sidecar in the TEE fails with HTTP **412** pulling its model at boot | The registry refused the pinned client for a re-published manifest; every newer image was >3 GiB compressed and could not fit the offer | Nothing the TEE needs may depend on a runtime download. Ollama was removed for this reason; intent routing and the last-resort tier call Gemini directly. Bake everything into the image or use a network API with a key |

### Admin operations and the Safe

| Symptom | Cause | Do this |
|---|---|---|
| Rehearsal script aborts `promptFee() is 1e18, expected 2e18` although the tx mined with the new value | The public RPC is load-balanced; the read-back hit a node behind the one that mined the tx | `scripts/admin-rehearsal.js` now reads at `receipt.blockNumber` with retries and resumes from the existing snapshot. For mainnet admin ops use a dedicated RPC endpoint, not the public one |
| Safe Transaction Builder loads only a thin ERC1967 proxy ABI for a proxy | The **implementation** is Basescan-verified but **not on Sourcify**; the builder only detects implementations through Sourcify | Verify every implementation on Sourcify (exact match) before the real ownership transfer. Fallback: toggle Custom data and paste the raw calldata (`transferOwnership(address)` selector `0xf2fde38b` + 32-byte padded address) |
| Builder does not offer "Use the Implementation ABI?" after pasting an address | The address field validates on blur and the ABI box keeps the previous contract's ABI | Click out of the field; if the ABI box still holds the old ABI, clear it and re-paste the address |
| Builder asks for address-book permission | It is the Safe Apps permission model | Reject. Accepting is harmless and revocable under Settings → Safe Apps |
| Review screen shows `delegate call` to `MultiSendCallOnly` | That is how a Transaction Builder batch is executed | Expected. Simulate (Tenderly) first; only then Send Batch → Execute |
| Basescan API returns `NOTOK` / deprecated | Etherscan V1 endpoints are gone | Use `https://api.etherscan.io/v2/api?chainid=<id>&…` with the Etherscan API key from the root `.env` |

### Mainnet pre-flight additions (do before the first mainnet `rofl deploy`)

- [ ] `resources.storage.size` + 2048 ≤ chosen offer storage, with ≥ 1 GiB headroom; confirm the qcow2 size from the built bundle.
- [ ] `--term hour` on the deploy command; ROSE balance read from the ParaTime block covers rental + registration deposit.
- [ ] No stale `machines:` id for the target deployment.
- [ ] Agent **and** escrow implementations verified on Sourcify as well as Basescan.
- [ ] Dedicated RPC endpoint configured for the admin script; rehearse forward + confirm phases against the mainnet Safe with dust values first.
- [ ] Safe threshold and signer set confirmed; Tenderly simulation green before any batch is sent.
- [ ] Wait one heartbeat interval before judging boot; read `machine show` → `net.oasis.error` before reading logs.
- [ ] Payload mirror: `tradable-app-senseai-payloads` applied via Cloud Build on promotion to `prod`; writer key minted and pasted single-line (§9); `payloadMirror.failed` stays 0 across the first heartbeat after the first answered prompt.

## Footguns
- Trust root ~1 yr stale — refresh (A.1) or it light-block loops.
- Cert name `rofl-oracle-base-testnet` — never reuse the social `rofl-<env>` on the shared instance.
- Commit `rofl.yaml` + ALL compose files (`compose.yaml` and the per-env ones). Only the `.orc` is gitignored. `rofl:build:<env>` now runs `scripts/rofl-preflight.sh` first, so a compose carrying placeholder or quoted values cannot be bundled.
- ROFL deploy = `build → update → deploy`, never `restart`/`release`. **Never `oasis rofl machine release`.**
- The oracle wallet (`0x0DEC…9a12`) needs Base Sepolia ETH for **every answer** — if it runs dry, prompts submit but never get answered (smoke times out → exit 1).
- Testnet TEE lives ~1 h (`playground_short`) — run the smoke promptly after boot.
- Storage math: qcow2 = `storage.size` + 2048 MiB ≤ offer storage, or the app never registers a replica and `machine logs` 404s. Read `machine show` → `net.oasis.error` first.
- `rofl deploy` without `--term hour` rents monthly.
- Nothing in the TEE may depend on a runtime download (the Ollama model pull broke the whole bundle).
- Public load-balanced RPCs serve stale reads; verify at the receipt block.
- Sourcify-verify implementations or the Safe builder cannot decode proxy calls.
