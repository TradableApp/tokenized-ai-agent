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
`rofl:build`, commit `rofl.yaml`. **You** (wallet passphrase + gcloud) = `image:push`,
`rofl:init:cloud-sql`, `rofl:update`, `rofl:deploy`. All `bun run` from the **repo root**.

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
  `compose.yaml` is tracked ON PURPOSE: `rofl:build` copies the per-deployment variant over it, so the committed copy is the last-deployed reference and doubles as the worked example. Its per-env siblings (`compose.base-*.yaml`, `compose.{testnet,mainnet}.yaml`) stay gitignored.
- [ ] **A.8 Push on-chain (you; passphrase):** `! bun run rofl:update:base-testnet`.
- [ ] **A.9 Deploy (you; passphrase):** `! bun run rofl:deploy:base-testnet`. No machine exists → it provisions one; **testnet offer `playground_short` (5 TEST/hr, ~1 h)** — may prompt for `--offer playground_short` + a ROSE top-up; `--replace-machine` if a stale one lingers. ⚠️ **The TEE lives ~1 h — do the boot + smoke checks promptly.**

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
SMOKE_ORACLE_PUBLIC_KEY=0x0416…<the oracle's PUBLIC_KEY from oracle/.env.oracle.base-testnet> \
bun run smoke:base-testnet
```
Defaults cover the RPC (`https://sepolia.base.org`), chainId (84532), and the
escrow/agent/ABLE addresses. Get `SMOKE_ORACLE_PUBLIC_KEY` from the `PUBLIC_KEY` line
in the oracle base-testnet env (it's `0x0416…`, 130 hex; the ECIES key the client
encrypts to — not a secret).

**Exactly what it does, step by step:**
1. **Connect + guard** — connects to Base Sepolia, asserts `chainId == 84532` **before spending** (a wrong RPC can't burn real tokens).
2. **Balances + fee** — reads `promptFee()`, ETH + ABLE balances; hard-fails on zero ETH, warns on low.
3. **Plan setup** — `token.approve(escrow, …)` then `escrow.setSpendingLimit(…, +1 day)` (skips if already active).
4. **Encrypt** — generates a random 32-byte session key, AES-256-GCM-encrypts the prompt payload (`{promptText, isNewConversation, …}`), and ECIES-encrypts the session key to the oracle's `PUBLIC_KEY` (reusing the oracle's own `src/ecies.js` → wire-format guaranteed to match).
5. **Submit** — `escrow.initiatePrompt(0, encryptedPayload, roflEncryptedKey)`; parses `PromptSubmitted` for `answerMessageId`.
6. **Wait for the answer** — polls the on-chain `AnswerMessageAdded(convId, answerMessageId, cid)` event (indexed; **no subgraph needed**), resilient to transient RPC errors, up to `SMOKE_TIMEOUT_MS` (5 min).
7. **Fetch + decrypt** — fetches the answer `MessageFile` from the storage gateway (Autonomys/Irys, 30-s bounded), AES-decrypts it with the session key.
8. **Assert** — prints the answer and checks it.

**What it tests / the pass criteria:**
- **Oracle is alive + wired:** it received the prompt, decrypted it (proves ECIES + the oracle's Base signer works), produced an answer, and submitted it on-chain.
- **Brain is working:** the decrypted answer has non-empty **`reasoning[]`** and **`sources[]`** — populated only from the Brain warm cache (macro + news). This is the CU-86d3cfa41 signal.

**Exit codes (for a scheduled canary):**
| Code | Meaning | Action |
|---|---|---|
| **0** | Pass — answer + Brain reasoning + sources | ✅ done |
| **1** | Oracle broken — no/short answer, timeout, wrong network | page |
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

## Footguns
- Trust root ~1 yr stale — refresh (A.1) or it light-block loops.
- Cert name `rofl-oracle-base-testnet` — never reuse the social `rofl-<env>` on the shared instance.
- Commit `rofl.yaml` + `compose.yaml`; the `.orc` is gitignored. `compose.yaml` is the last-deployed reference (see A.7) — the per-env compose files are the ones that stay out of git.
- ROFL deploy = `build → update → deploy`, never `restart`/`release`. **Never `oasis rofl machine release`.**
- The oracle wallet (`0x0DEC…9a12`) needs Base Sepolia ETH for **every answer** — if it runs dry, prompts submit but never get answered (smoke times out → exit 1).
- Testnet TEE lives ~1 h (`playground_short`) — run the smoke promptly after boot.
