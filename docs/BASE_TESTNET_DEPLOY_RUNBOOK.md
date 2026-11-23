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
| **Tradable Deploy Wallet** | `0x0DEC482E804965F53da3d7094c5E0fd8B3dA9a12` | **Deployed the contracts + token and owns both proxies until the handover**; holds 999.99M ABLE. It does **not** run the oracle on Base Sepolia: there the oracle's signing key and its encryption key both come from the ROFL key service (`oracle/src/oracleKeys.js`; `PRIVATE_KEY` must not be set), and the oracle prints its own address at start-up (`[OracleKeys] mode=rofl … signer=0x…`). The deploy wallet was given the oracle role at deployment. Before the handover the owner moves the role to the oracle's own address and only then removes the deploy wallet's, in the order in [§1.1](#11-moving-the-oracle-role-to-the-rofl-signer-in-this-order). Never publish an encryption key from it. | **Base Sepolia ETH** (owner transactions) | Had **0.0493 ETH** on 2026-07-20. It's the ABLE source if the test wallet ever needs more. |
| **Test / user wallet** — Tradable Test User (MetaMask) | `0x971c5a2058eecEd3D3C177A9bFdA7ddFafDe8057` | **Submits the prompt** — `approve` → `setSpendingLimit` → `initiatePrompt` (3 txs). | **Base Sepolia ETH** (gas ×3) + **ABLE** (prompt fee = **1 ABLE**) | **FUNDED ✅ — 0.0499 ETH + 9,897 ABLE** (no top-up). Export its MetaMask private key for `SMOKE_PRIVATE_KEY` at run time. (Replaces the public hardhat #0 key, whose funds got swept.) |

**Funding status — ALL SORTED (verified 2026-07-20), no top-ups needed:**
- `oasis_testnet` (Sapphire testnet): **88.58 TEST** — deploy gas ~0.02 + rental 5 TEST/hr → ~17 h runway. ✅
- Test wallet `0x971c…8057`: **0.0499 ETH + 9,897 ABLE**. ✅
- Deploy wallet `0x0DEC…9a12`: **0.0493 ETH** for owner transactions. ✅ The oracle's own address (printed at start-up) pays the answer gas and must hold Base Sepolia ETH too.

The **only** run-time input from you: the Test User wallet's **private key** (MetaMask → Account details → Show private key) passed as `SMOKE_PRIVATE_KEY`.

**Do we need the deployment wallet?** Only as the owner (until the handover) and the ABLE treasury. It is not the oracle: the oracle answers from the address the ROFL key service gives it, which is the one that needs Base Sepolia ETH for answer gas. Do not keep the deploy wallet's oracle role for the oracle's sake; it is removed before the handover, and only after the oracle's own address holds the role (§1.1).

### 1.1 Moving the oracle role to the ROFL signer (in this order)

Every other mention in this runbook of removing the deploy wallet's role points here, and the
admin rehearsal's own note about the removal names this order. Do the steps in order, and do not go on from a step that did not check out.
All of them are owner calls or reads on the agent (`EVMAIAgent` above), sent before the
handover: once ownership is with the Safe, only the Safe can add or remove an oracle.

What the contract allows, and why the order matters:

- **Several addresses can hold the role at once.** `addOracle` does not take the role from
  anyone, so the signer can be added while the deploy wallet still holds it, and a prompt in
  flight during the overlap can be answered by either. Adding an address that already holds the
  role grants nothing and emits no `RoleGranted`; removing one that does not hold it revokes
  nothing and emits no `RoleRevoked` (that is how a mistyped address shows). Only on a pair
  upgraded from the single-oracle version: the first `addOracle` also clears that version's
  stored oracle address. A freshly deployed pair has none.
- **Only an address with the role can answer** (`submitAnswer` is oracle only). If the deploy
  wallet's role is removed before the signer's is granted, the agent has no oracle the ROFL
  oracle can answer as: users' prompts are paid (the fee is held by the escrow) and not
  answered. The oracle does not send answers that would be refused: it waits at its role gate
  (`oracle/src/oracleRoleGate.js`), pages "CRITICAL: Oracle Not Authorized" (and hourly "Still
  Not Authorized"), and answers the prompts it kept once the role is granted. Meanwhile users
  can still cancel a prompt and claim the refund once it is an hour old (neither needs the
  oracle). Removing the last oracle is allowed by the contract, so nothing stops this mistake
  but this order.
- **The encryption key publisher.** If the deploy wallet is the agent's
  `oracleEncryptionKeyPublisher` (a key was published from it by hand), removing its role in
  step 5 also withdraws that key, and while it holds the role and the key no other oracle can
  publish a different key (`EncryptionKeyHeldByAnotherOracle`). Today neither changes the order:
  no client reads the key from the agent (the dApp encrypts to the key its build names), and the
  oracle does not publish a key of its own yet. See the `signerIsOracle` row under Lessons
  learned for what the rehearsal then says.

The reads and owner calls below use the Hardhat console on the agent's network, which signs with
the root `PRIVATE_KEY` (the deploy wallet, the same account the admin rehearsal uses):

```bash
bunx hardhat console --network baseSepolia
```

```js
const agent = await ethers.getContractAt("EVMAIAgent", "<agent address>")
```

Before step 2, check the console signs as the owner (an `ENV_FILE` setting overrides the root
`PRIVATE_KEY`): `(await ethers.getSigners())[0].address` must equal `await agent.owner()`.

0. **Find who answers today.** If prompts are being answered on this pair, take the latest
   answer's `submitAnswer` transaction and read its sender. Two cases change what follows:
   - **The sender is the deploy wallet.** The running oracle image is from before the ROFL
     keys: it prints no `[OracleKeys]` line and answers from an operator key. Deploying the
     current image (with no `PRIVATE_KEY` secret; the oracle refuses to start with one) changes
     the address the oracle answers from, and that address is made inside the TEE, so it cannot
     be known or granted in advance. From the moment the new image starts until step 2 is mined
     nothing is answered: prompts sent then wait at the oracle's role gate, or can be refunded
     once an hour old. Do steps 1 to 3 straight after the deploy, at a quiet
     time, then go on with steps 4 and 5 in the same session.
   - **The sender is already the oracle's own address** (`await agent.isOracle("<signer>")`
     prints `true`). Skip step 2: granting again grants nothing and its receipt carries no
     `RoleGranted`. Go on from step 3.
1. **Read the oracle's own address.** From the oracle's start-up line in the machine logs
   (§5): `[OracleKeys] mode=rofl app=… signer=0x… encryptionKey=0x…`. That `signer=` address is
   the one the oracle answers from (made by the ROFL key service; not the deploy wallet). Call
   it `<signer>`. While `<signer>` does not hold the role, the same logs carry "CRITICAL: Oracle
   Not Authorized" naming the `addOracle` call; that is expected until step 2. The
   `encryptionKey=` on that line is the key prompts must be encrypted to: if it differs from the
   key the dApp build names (`VITE_ORACLE_PUBLIC_KEY`) or the smoke test uses
   (`SMOKE_ORACLE_PUBLIC_KEY`), update both before users prompt. A prompt encrypted to another
   key is paid and cannot be answered.
2. **Grant it the role.** `await (await agent.addOracle("<signer>")).wait()` — the receipt
   carries `RoleGranted` for `<signer>` (none if it already held the role; see step 0).
3. **Check it holds the role.** `await agent.isOracle("<signer>")` must print `true`. If it does
   not, stop: do not remove anything.
4. **See one prompt answered by it.** Send one test prompt (the smoke test, §6, is one) and wait
   for its answer. The smoke test prints the sender itself, in its line beginning
   `oracle 0x…: nonces`; that address must be `<signer>`. To read it from the chain instead, take
   `prompts[0].answerTxHash` from `smoke-metrics.json` (not `submitTxHash`, which is the user's
   own prompt; `answerTxHash` is empty when the smoke could not read the answer's transaction)
   and check `(await ethers.provider.getTransaction("<answerTxHash>")).from`. If no answer comes, or it
   came from another address, stop and find out why before going on.
5. **Only then remove the deploy wallet's role.**
   `await (await agent.removeOracle("<deploy wallet>")).wait()` — the receipt carries
   `RoleRevoked`; none means the address was mistyped. Then
   `await agent.isOracle("<deploy wallet>")` must print `false`, and
   `await agent.isOracle("<signer>")` must still print `true`.

Two checks repeat this from outside, and are worth setting:

- **Admin rehearsal:** set `REHEARSAL_ORACLE_ADDRESS=<signer>` and start a forward run only
  after step 3. The forward run records whether that address holds the role, and on a live
  network refuses it if it is the account the script signs with. The confirm phase fails if
  that address's role differs from what the snapshot recorded, and, on a live network, while
  the signing account (the deploy wallet) still holds its own. A resumed run uses the address in
  its snapshot, not the setting: an unconfirmed snapshot taken before step 2 recorded `<signer>`
  without the role, so its confirm phase fails on `oracleAuthorized` once step 2 has landed.
  Move that snapshot aside (keep it: it holds the values from before the rehearsal).
- **e2e stack check (`sense-ai-e2e`, `docs/TESTNET_RUN.md`):** set
  `TESTNET_ORACLE_SIGNER_ADDRESS=<signer>` and `TESTNET_DEPLOY_WALLET_ADDRESS=<deploy wallet>`.
  The wiring probe then asks the agent that the signer holds the role and that the deploy wallet
  does not; an unset one is reported as not checked, never as a pass. It fails on the deploy
  wallet until step 5 is done, so run it after step 5.

### 1.2 Fresh pair, in order

A fresh pair is a new agent and escrow, deployed with `DEPLOY_MODE=fresh`. Do the steps in order,
and do not go on from a step that did not check out. The scripts named below refuse out of order
where they can; the rest of the order is this list. Steps 0, 4, 9a and 10 cover the fee token
when it is SenseToken (from the `sense-contracts` repository); an ordinary token needs only its
address and symbol in step 1.

0. **The fee token, when it is new** (in `sense-contracts`, see its README "Deploying"): its
   `ENV_FILE` sets `TOKEN_NAME`, `TOKEN_SYMBOL`, `INITIAL_SUPPLY` (the whole supply in base units,
   at least one whole token; it is minted once, to the owner, and cannot be undone) and
   `OWNER_ADDRESS`. Run `bun run deploy:testnet` (mainnet: `DEPLOY_MAINNET_CONFIRMED=1 bun run
   deploy:mainnet`); it prints `SenseToken proxy: <address>` and then verifies the source. Commit
   the upgrades manifest it wrote in that repository (`.openzeppelin/base-sepolia.json`, on
   mainnet `.openzeppelin/base.json`): a later upgrade of the token checks its storage layout
   against it. The proxy address is `TOKEN_CONTRACT_ADDRESS` below and `TOKEN_SYMBOL` is
   `EXPECTED_FEE_TOKEN_SYMBOL`.
1. **Settings, in the network's `ENV_FILE`** (for example `.env.base-testnet`):
   `DEPLOY_MODE=fresh`; `AI_AGENT_CONTRACT_ADDRESS` and `AI_AGENT_ESCROW_CONTRACT_ADDRESS` empty;
   `TOKEN_CONTRACT_ADDRESS`; `TREASURY_ADDRESS`; `EXPECTED_FEE_TOKEN_SYMBOL` (the token's symbol);
   `DOMAIN`; the four fees `INITIAL_PROMPT_FEE`, `INITIAL_CANCELLATION_FEE`,
   `INITIAL_METADATA_FEE` and `INITIAL_BRANCH_FEE`, each in wei of the fee token as decimal digits
   only (one token of 18 decimals is `1000000000000000000`; a point, sign, exponent or `0x` is
   refused); and `ORACLE_ADDRESS` only when the oracle's signer is already known (local runs and
   tests). The mode and the two pair addresses are read from `ENV_FILE` alone on every EVM
   network, and for a fresh pair on a live network so is every other setting in this step: the
   deploy refuses when the root `.env` or the shell sets one the file does not (or sets it
   differently), so a value left out of the file cannot come from the root file. `fresh` refuses
   either pair address; `upgrade` needs both and reads none of the other settings. On a live
   network a fresh pair needs `TREASURY_ADDRESS`, `EXPECTED_FEE_TOKEN_SYMBOL`, `DOMAIN` and the
   four fees;
   only a local network falls back to the deploy wallet as treasury and to default fees (1, 0.1,
   0.1 and 0.5 tokens), and takes these settings from the root `.env` as well as the file.
2. **Dry run, then deploy:** first `bun run deploy:base-testnet:dry` (mainnet: `bun run
   deploy:base-mainnet:dry`, which needs no confirm). It runs every check, reads the token (a
   contract at the address, its symbol against `EXPECTED_FEE_TOKEN_SYMBOL`, its decimals) and
   refuses on any difference, prints the plan and sends nothing. The plan names the deploy
   wallet, the token with its symbol and decimals, the treasury, the first oracle, the domain, and
   each fee in wei and in whole tokens. Check every line, the fees above all: no fee is refused
   for its size, so a fee off by a power of ten shows only here. Then `bun run deploy:base-testnet`
   (mainnet: `DEPLOY_MAINNET_CONFIRMED=1 bun run deploy:base-mainnet`), which makes the same checks,
   prints the same plan and sends it. After the deploy it reads the pair back and fails, naming each difference, unless `agent.aiAgentEscrow()` is
   the new escrow, `escrow.evmAIAgent()` the new agent, `escrow.ableToken()` the token,
   `escrow.treasury()` the treasury, the deploy wallet owns both, the first oracle holds the role
   (and, with `ORACLE_ADDRESS` set, the deploy wallet does not), the four fees are the planned
   ones, and `token.symbol()` is `EXPECTED_FEE_TOKEN_SYMBOL`. A failed read-back leaves deployed
   contracts: point nothing at them, fix the setting, deploy again. With no `ORACLE_ADDRESS` the
   deploy wallet is the first oracle (the signer is derived from the agent's address, so it
   cannot exist before the deploy), and the script prints the hand-over commands of step 6.
3. **Record the pair:** in `ENV_FILE` set the two addresses it printed and `DEPLOY_MODE=upgrade`
   (the deploy prints this line whether or not `ORACLE_ADDRESS` was set), so a second run upgrades
   this pair and never deploys another beside it.
4. **List the escrow and the treasury on the fee token** (a token that moves only to or from
   addresses its owner has listed; an ordinary token needs nothing, and the script says so):
   `bun run list-fee-token-exempt:base-testnet`. On a live network it reads the agent, escrow,
   token and `EXPECTED_FEE_TOKEN_SYMBOL` from `ENV_FILE` alone (all four are required) and prints
   the network, agent, escrow and token before it reads anything. It checks that
   `escrow.ableToken()` is the token and that the token's symbol is `EXPECTED_FEE_TOKEN_SYMBOL`,
   lists whichever of the two is not listed, and reads both back. A token whose symbol is `SENSE`
   (a token that keeps a list) but that answers as one with no list is refused, with or without
   `--check`: it is not the token it says it is. When the signer is not
   the token's owner (the Safe owns it on mainnet) it sends nothing and prints the calls as Safe
   Transaction Builder JSON: save it as a file, load it in the owner Safe's Transaction Builder,
   simulate, execute. An account that is the token's owner (a treasury that owns the token) is
   listed again on every run, since the token reads its owner as exempt and a listing by name
   cannot be told apart; on the Safe path it is in the printed batch every time. Then `bun run
   list-fee-token-exempt:base-testnet --check`, which only reads and fails while either is
   unlisted (run it again on run day). It passes an owner-treasury as exempt by ownership and says
   its listing by name cannot be read, so run the listing itself, not only `--check`, before the
   token's ownership moves (step 10).
   On a test network the e2e runner pays its test accounts from a funding account of its own
   (`TESTNET_TREASURY_ADDRESS` in `sense-ai-e2e`), which the script does not list: unless it is the
   token's owner, the owner lists it too with `setTransferExempt(<funding account>, true)`. The
   runner's wiring probe refuses a run while it is not listed.
5. **Start the oracle on the new pair before the dApp moves to it.** Point the oracle's settings
   at the new addresses and deploy it (§3). With no stored cursor for a pair the oracle looks back
   only a few minutes before its first block, so a prompt sent to the new pair long before the
   oracle starts is not seen. If an old pair is still answered, close and drain it first (see
   "Moving prompts to a new agent and escrow" under Lessons learned).
6. **Move the oracle role off the deploy wallet**, in the order of §1.1, with the script. On a live
   network it reads the agent, escrow and token from `ENV_FILE` alone (all three are required) and
   prints them before it reads anything. `ORACLE_ADDRESS` and `ANSWER_TX_HASH` are set in
   `ENV_FILE` too, never typed before the command: Hardhat loads `ENV_FILE` over the shell, so a
   typed value would be replaced by the file's line (the template's empty `ORACLE_ADDRESS=`
   included). The script reads both from `ENV_FILE` alone and refuses, before it reads anything,
   a typed value that is not the file's, one only the root `.env` sets, or an empty one, naming the
   setting and the file and never printing the value:
   - In `ENV_FILE` set `ORACLE_ADDRESS=<signer>` (from the oracle's `[OracleKeys] … signer=`
     start-up line), then `bun run authorize-oracle:base-testnet grant`. It adds that signer and
     checks `isOracle`, refuses an `ORACLE_ADDRESS` that is the signing wallet, and sends nothing
     when the role is held. (Setting it now changes no deploy: the file is in `upgrade` mode since
     step 3, and an upgrade does not use `ORACLE_ADDRESS`; it only refuses one that is not an
     address.)
   - Send one prompt (the smoke test, §6, with the new pair's `SMOKE_*`) and take its answer's
     transaction hash (`answerTxHash` in `smoke-metrics.json`). This is the pair's first prompt:
     a fresh agent counts message ids from 0 (conversation ids from 1), so the smoke prompt takes
     message id 0 and its answer 1. Keep it first: no user's prompt is sent to the pair before the
     dApp points at it (step 9), so id 0 always belongs to this operator prompt.
   - In `ENV_FILE` set `ANSWER_TX_HASH=<answer tx>`, then `bun run authorize-oracle:base-testnet
     retire-deployer`. It removes the deploy wallet's role only when `<signer>` holds the role and
     the hash is a successful `submitAnswer` to this agent sent by `<signer>`; then
     `isOracle(<deploy wallet>)` must be false and `isOracle(<signer>)` still true.
   Both phases are owner calls and refuse once the agent's owner is not the signing wallet: after
   the handover the Safe sends `addOracle` / `removeOracle` itself. On Base mainnet either phase
   needs `DEPLOY_MAINNET_CONFIRMED=1` before it sends.
7. **Never call `migrateOracleRole` on a fresh pair.** It is `reinitializer(2)`
   (`contracts/EVMAIAgent.sol`) and exists only for a pair upgraded from the single-oracle
   version; on a fresh pair it grants nothing and uses up version 2, which a later upgrade's own
   `reinitializer(2)` would then be refused. The deploy script calls it only on an upgrade whose
   agent still stores the old oracle. Never publish an encryption key from the deploy wallet.
8. **Fees:** on a live network there are no default fees: the four `INITIAL_*_FEE` settings are
   required (step 1), shown in step 2's plan and checked by the read-back. Change them with the
   escrow's setters only when they should differ from that. (Only a local network falls back to
   default fees.)
9. **Point everything else at the new pair:** the subgraph (a deployment of its own: its fee
   record is one per subgraph; in `sense-ai-subgraph`, `config/base-testnet.json` or
   `config/base-mainnet.json` takes the agent and escrow addresses and, for each, a `startBlock`
   no later than the block that created it, which Basescan shows as the contract's creation
   transaction, so the events of the deploy itself are indexed; the mainnet deploy refuses the
   file's placeholders), the dApp build's addresses, the smoke test's `SMOKE_*`, and the e2e testnet
   settings.
   9a. **Distribute the fee token** (SenseToken): the token's owner, or the treasury once it is
   listed, sends it to the wallets that will pay, one at a time or in one batch from the Safe. A
   wallet can pay only a listed address or the owner (the escrow, the treasury); it cannot send
   to another wallet.
10. **Hand ownership to the Safe last**, once step 6 is done: after it, only the Safe can list on
    the token (if it owns it), change oracles or fees. When the deploy wallet owns the fee token,
    first move the supply it still holds to the treasury (listed by name in step 4): after the
    handover the old owner is no longer exempt and can send only to a listed address. Then
    `transferOwnership(<Safe>)` from the owner and `acceptOwnership()` from the Safe; the owner's
    exemption moves with it.

**Exempt-list rules.** On a token that keeps a list, a transfer passes when either end is listed.
List the escrow and the treasury by name, the treasury even when it is the token's owner. Every
new escrow needs its own listing, and a new treasury (`setTreasury`, or a Safe that will become
the treasury, as the admin rehearsal does) must be listed before it is set: an unlisted treasury
refuses every fee a user pays straight to it (cancel, branch, rename or delete). The listing
script and its `--check` cover the escrow and the treasury the escrow names now, not the e2e
runner's funding account (step 4).

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

The package scripts are routed through it too: every `rofl:create:*`, `rofl:update:*`,
`rofl:deploy:*` and `logs:*` script runs `expect scripts/oasis-unlock.exp rofl …` rather than
`oasis rofl …` bare, so `bun run rofl:deploy:base-testnet` is equivalent to the wrapper line above
(`test/deployGuard.test.js` pins this). `logs:<env>` passes the account that owns that
deployment's machine (`oasis_testnet` / `oasis_mainnet`): `rofl machine logs` prompts for *that*
account's passphrase, and a wrapper call without `--account` falls back to the shared item and
is refused. Mind the order and what each script bundles:
`rofl:set:<env>` → `rofl:build:<env>` → `rofl update` → `rofl deploy`. `rofl:update:<env>`
re-runs `rofl:set:<env>` first, which re-encrypts every secret and churns the ciphertexts in
`rofl.yaml` — fine for a full sync, noisy for a manifest-only push (A.8 uses the bare wrapper
for that reason). A `rofl update` after editing `compose.<env>.yaml` without a `rofl:build`
pushes the OLD enclave identity; a `rofl:build` without a following `rofl update` deploys the
old one. Commit `rofl.yaml` after the update, not before.

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
- [x] **Nothing to fund** — all three wallets verified funded (2026-07-20): test wallet `0x971c…8057` (0.0499 ETH + 9,897 ABLE), `oasis_testnet` (88.58 TEST), deploy wallet `0x0DEC…9a12` (0.0493 ETH). Just have the Test User's private key ready for `SMOKE_PRIVATE_KEY`.

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
SMOKE_ESCROW_ADDRESS=0x… SMOKE_AGENT_ADDRESS=0x… SMOKE_TOKEN_ADDRESS=0x… \
SMOKE_ORACLE_PUBLIC_KEY=0x04… \
bun run smoke:base-testnet
```
The `base-testnet` table in `oracle/scripts/smoke/env.js` holds only the RPC
(`https://sepolia.base.org`) and chainId (84532). The pair's escrow, agent and token addresses and
the oracle's ECIES public key are **required** by name on every network
(`SMOKE_ESCROW_ADDRESS`, `SMOKE_AGENT_ADDRESS`, `SMOKE_TOKEN_ADDRESS`,
`SMOKE_ORACLE_PUBLIC_KEY`): a pair is deployed fresh, and a committed default would smoke the old
one. Take the key from the oracle's `[OracleKeys] … encryptionKey=` start-up line (a stale key
means prompts land on-chain and are never answered). `SMOKE_ENV=base-mainnet`
(`bun run smoke:base-mainnet`) switches to the mainnet RPC/chainId and requires the same four.

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
6. **Wait for the answer** — polls the on-chain `AnswerMessageAdded(convId, answerMessageId, cid)` event (indexed; **no subgraph needed**) with `eth_getLogs` walked in contiguous windows of at most `SMOKE_LOGS_BLOCK_RANGE` blocks (default 10 — Alchemy's free-tier cap; the public node allows a few hundred), resuming from a refused window rather than re-widening it and logging the node's own error, up to `SMOKE_TIMEOUT_MS` (5 min). The 2026-11-02 run day lost 6/6 smoke verdicts to a single-request `[submitBlock, head]` poll against an Alchemy endpoint while every answer was on-chain within a minute (`scripts/smoke/answerWait.js`).
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

### Restart check (CU-14ym9bvdmju)

Proves that restarting the ROFL oracle machine while a prompt is pending yields exactly one
answer: no duplicate, no lost job. Sequence: **submit → marker → restart → one answer → settle.**

1. **Submit.** Start the smoke with the restart variables set:
   ```bash
   SMOKE_SUBMITTED_FILE=/tmp/smoke-submitted.json \
   SMOKE_TIMEOUT_MS=900000 \
   SMOKE_SETTLE_MS=120000 \
   SMOKE_PRIVATE_KEY=0x… bun run smoke:base-testnet
   ```
   `SMOKE_TIMEOUT_MS` is the answer-wait budget (positive whole number, default 300000; a decimal or
   exponent form such as `300000.5` or `3e5`, accepted before this check existed, is now refused
   at startup). A restart
   costs minutes, so give it more headroom than a plain run.
2. **Marker.** Once every prompt's `initiatePrompt` is mined, the smoke writes
   `SMOKE_SUBMITTED_FILE` (JSON: `env`, `chainId`, `submittedAt`, and per prompt `index`,
   `conversationId`, `promptMessageId`, `answerMessageId`, `submitTxHash`, `submitBlock`; no keys,
   no RPC URL) and prints one line beginning `SMOKE_SUBMITTED_ALL`. The runner watches for the
   file, then restarts the machine. Nothing is written if a prompt fails before its submit is
   mined, so the runner should time out rather than wait forever.
3. **Restart.** `oasis rofl machine restart` for the deployment, while the answers are pending.
4. **One answer.** The smoke waits as usual. Each prompt must receive exactly one
   `AnswerMessageAdded`, and the answer is fetched and judged as in a plain run.
5. **Settle.** With `SMOKE_SETTLE_MS` > 0 the smoke keeps reading the chain for that long after
   the last answer, then catches up to the head. It **fails (exit 1)**, naming the answer ids, if:
   - an answered prompt has anything other than exactly one `AnswerMessageAdded` for its
     `answerMessageId` in the window (two is a duplicate, none means the observer missed it), or
     an unanswered prompt gains one; or
   - the oracle account's nonce rose by more than one per answered prompt (from its nonce at the
     earliest submit block to its nonce at the window's end). A duplicate `submitAnswer` that
     reverts emits no event but still spends a nonce, so only this check sees it. The delta counts
     every transaction from the oracle account, so keep the oracle otherwise idle during the
     window: an unrelated transaction from that account fails the check the same way. The sender
     comes from the run's answer metadata, or, when that read failed, from the answer
     transactions the window observed; with neither, the check fails rather than pass unverified.

   The oracle account is the sender of the answer transactions. If answers come from more than one
   sender, or no sender was recorded, the settle check fails rather than guess.

The metrics file gains a `settle` block (`settleMs`, `durationMs`, `fromBlock`, `endBlock`,
`verdict`, `problems`, `answerEventCounts` per prompt, `oracleNonce` with `before`, `after`,
`delta`, `answered`). It is absent when the window did not run.

**What the oracle does across a restart (verified in `oracle/src/aiAgentOracle.js`):**
- **Stored cursor.** The chain cursor is kept in the oracle's own `oracle_agent` database
  (`oracle_state.oracle_cursors`, see `oracle/src/oracleState/`), saved by `persistCursor` after
  each scanned batch and read once at start-up. It survives a machine restart and a
  `--wipe-storage` deploy. (Before this, it was a file on the volume and a restart lost it.)
- **Cold start.** With no stored cursor, or a database that cannot be read (which also raises an
  alert), the oracle replays `[head − 1800, head]` (six minutes on Base at 200 ms blocks).
  Otherwise it resumes at the stored block + 1.
- **Duplicate guard.** Before sending, the oracle checks `isJobFinalized` and skips finalised
  jobs (`:1405`, and again inside the tx mutex at `:1670`). If that read errors it logs and
  proceeds anyway (`:1414`), which is why the settle check counts nonces as well as events.
- **Failed jobs across the restart.** The retry queue is in the same database
  (`oracle_state.oracle_failed_jobs`), so queued retries survive too. Expect the start-up log line
  `[OracleState] Cursor and failed jobs are kept in: postgres.` and no `No stored cursor found`
  line after a restart.

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
| Rehearsal script aborts `promptFee() is 1e18, expected 2e18` although the tx mined with the new value | The public RPC is load-balanced; the read-back hit a node behind the one that mined the tx | `scripts/admin-rehearsal.js` now reads at `receipt.blockNumber` with retries. Re-run the forward phase to resume: the snapshot in `rehearsal-state/` stays the baseline and records each step as sent (with its hash and nonce) and as done, a step recorded as sent is settled from its receipt when this node has one (its status and event); with no receipt it is forgotten and sent again only if its nonce is still unused and nothing is pending, and refused otherwise (it, or a replacement, may have landed), and a finished set-and-restore pair is never sent again. Run the dry run first: it takes the same path and says which steps it would send and which it would skip. For mainnet admin ops use a dedicated RPC endpoint, not the public one |
| Rehearsal refuses: `... was written by an earlier version of this script, for this pair, and its rehearsal was not confirmed` | A snapshot from before the snapshot had its own folder is in `cache/admin-rehearsal.<network>.json`, for this pair, and was never confirmed; it may be the only record of the values before that rehearsal | Move it to the path the message names (`rehearsal-state/admin-rehearsal.<network>.<agent>.json`) and run the confirm phase, which checks it against the chain and writes it back confirmed; a forward run then starts from the live state. If the confirm phase lists differences, that rehearsal was never returned: set each listed value back to the snapshot's value by hand (ownership through the Safe's own transactions), then run the confirm phase again. If that rehearsal was returned by hand, move the file aside instead. The script only reads `cache/`; it never writes, moves or deletes the file there. A file there that cannot be read, is not JSON or names no pair is refused the same way, since a cut-off write of this pair leaves exactly that: recover what you can of it, then move it aside. One for another pair, and a confirmed one, are reported as warnings and left where they are |
| Rehearsal refuses: `The live state shows what a rehearsal leaves behind ...` | There is no unconfirmed snapshot for this pair (or the last one was confirmed), and the chain shows a rehearsal value: the fee at the rehearsal fee, the Safe as treasury, an ownership offer open, a proxy the Safe owns, or the Safe holding the oracle role | Do not run again until each listed value is back to what it was before the rehearsal; with the snapshot lost, only you know those values. If the snapshot was moved aside by mistake, put it back in `rehearsal-state/` and re-run: a resume does not take its own values for leftovers |
| Rehearsal refuses: `... has N transaction(s) waiting to be mined` | The deploy wallet has a transaction the chain has not mined yet, possibly a rehearsal step | The message gives the latest and pending counts and names any set recorded done whose restore is not, with the call that restores it by hand: its rehearsal value is live meanwhile. Wait for the transaction to be mined, or replace it from this wallet at the nonce the message names (for example 0 value to itself at a higher fee), then run again. The confirm phase refuses the same way, and also while any step is recorded as sent |
| Rehearsal refuses: `[<step>] was sent as <hash>, which landed ..., but its receipt does not show the step` | A step is recorded as sent, its transaction succeeded, and its receipt does not carry the step's event with the expected values: the recorded hash is not the step's transaction, or something else changed the value in it | Running again meets the same record and refuses the same way. Look the transaction up on a block explorer. If the recorded hash is wrong, move the snapshot aside and keep it (it holds the values from before the rehearsal), return any rehearsal value still live to that value by hand, then run again. A resumed run checks only the event here, since the node may have pruned the state at the receipt's block |
| Rehearsal refuses: `... the Safe ... is not on its list` | The escrow's token moves only to or from addresses its owner has listed (a transfer passes when either end is), and the Safe is not listed. While the Safe is the treasury, every fee a user pays straight to the treasury would be refused: the cancellation fee, and the branch and metadata (rename or delete) fees. An answered prompt's fee, which the escrow pays the treasury, still moves while the escrow is listed | Have the token's owner list the Safe, or rehearse with a Safe that is listed, then run again. On a fresh run nothing was sent or written. On a resumed run the restore of every set already done was sent first and every other step held back; the message names each. A resume refuses another Safe, so to rehearse with another Safe after a resumed refusal, move the snapshot aside once those restores are done, if any were sent (keep it: it holds the values from before the rehearsal); a fresh run then starts from the live state. A resumed run whose treasury set has already landed is not stopped by this, and sends the treasury restore as usual |
| Rehearsal refuses: `The snapshot at ... watches the signer ... as the live oracle ...` (forward run) | On a live network, the unconfirmed snapshot a forward run would resume names the deploy wallet as the live oracle, which an earlier version allowed. Its rehearsal can never be confirmed. After the same checks as any run (a pending transaction is refused first), it sends the restore of every set already done, so no rehearsal value is left live, holds every other step, and refuses, naming what it sent and held (the dry run predicts the same). No new step is sent | Return any rehearsal value still live to the snapshot's baseline by hand (ownership through the Safe's own transactions) and keep the snapshot, then move it aside. A fresh forward run starts from the live state, refuses while a rehearsal value is left, and takes `REHEARSAL_ORACLE_ADDRESS` naming the address the oracle answers prompts from |
| Confirm phase fails on a value that was changed on purpose since the rehearsal (or a forward run then says `no ownership offer is open`) | The confirm phase took the ownership back and compared the chain with the snapshot; a value set deliberately afterwards will never match it | Move the snapshot aside and keep it (it holds the values from before the rehearsal). A later forward run starts from the live state |
| Confirm phase fails with `signerIsOracle` | On a live network the deploy wallet still holds the oracle role it was given at deployment, and after the handover only the new owner could remove it | The owner (the deploy wallet, before the handover) moves the role to the oracle's own address and then removes the deploy wallet's, in the order in §1.1 (grant and check the signer, see a prompt answered by it, and only then `agent.removeOracle(<deploy wallet>)`), then runs the confirm phase again. The script never sends either call. If the deploy wallet is the agent's `oracleEncryptionKeyPublisher` (a key was published from it by hand), the note and the refusal say so: removing its role withdraws that key (the agent deletes it when its publisher loses the role). Today no client reads the key from the agent (the dApp encrypts to the key its build names), so nothing else changes, and the real oracle does not publish a key of its own yet (not built). Remove the role all the same; a snapshot that recorded the key then differs on it every time: move it aside and keep it. Never publish an encryption key from the deploy wallet |
| Safe Transaction Builder loads only a thin ERC1967 proxy ABI for a proxy | The **implementation** is Basescan-verified but **not on Sourcify**; the builder only detects implementations through Sourcify | Verify every implementation on Sourcify (exact match) before the real ownership transfer. Fallback: toggle Custom data and paste the raw calldata. Ownership moves in two steps, so what the Safe sends to take ownership is `acceptOwnership()`: selector `0x79ba5097`, no arguments. (The current owner's offer is `transferOwnership(address)`, selector `0xf2fde38b` + 32-byte padded address; the Safe sends that only to offer ownership on, as the rehearsal does to hand it back) |
| Builder does not offer "Use the Implementation ABI?" after pasting an address | The address field validates on blur and the ABI box keeps the previous contract's ABI | Click out of the field; if the ABI box still holds the old ABI, clear it and re-paste the address |
| Builder asks for address-book permission | It is the Safe Apps permission model | Reject. Accepting is harmless and revocable under Settings → Safe Apps |
| Review screen shows `delegate call` to `MultiSendCallOnly` | That is how a Transaction Builder batch is executed | Expected. Simulate (Tenderly) first; only then Send Batch → Execute |
| Basescan API returns `NOTOK` / deprecated | Etherscan V1 endpoints are gone | Use `https://api.etherscan.io/v2/api?chainid=<id>&…` with the Etherscan API key from the root `.env` |

### What the admin rehearsal covers, and what it does not

- It runs against the live pair. Between each set and its restore, users see the rehearsal's values: the prompt fee is the rehearsal fee, and the Safe is the treasury the escrow pays fees to. A run stopped halfway leaves them in place until it is resumed. Run it at a quiet time, and resume a stopped run promptly.
- The Safe's part is to accept ownership of both proxies and offer it back. The fee, treasury and oracle changes are sent from the deploy wallet. The rehearsal does not have the Safe send any other owner call, and it rehearses no upgrade: a passing rehearsal shows the Safe can take and return ownership, not that it can do those. Try them from the Safe separately before relying on it for them.
- On a live network it reports whether the deploy wallet still holds the oracle role, and the confirm phase does not pass while it does. Removing it is the owner's call, made before the handover and only after the oracle's own address holds the role (§1.1). When the deploy wallet also published the encryption key, the note says that removing its role withdraws that key, that nothing reads it today, and that the role is still removed (see the `signerIsOracle` row above).

### Moving prompts to a new agent and escrow: close the old pair first

One oracle answers one pair. Before the oracle is pointed at a new agent and escrow, the owner
closes new paid actions on the old pair with the dApp's prompts switch and lets the prompts
already sent settle; otherwise a prompt sent to the old pair after the oracle has moved is paid
and waits for its one-hour refund.

- The switch is a document every open copy of the dApp listens to, per network and agent
  (`sense-ai-dapp/docs/decisions/0008-remote-prompts-switch.md`). Closing it stops new prompts,
  plans, branches and renames in every open tab without a deploy; cancelling, refunds and
  revoking a plan are never stopped by it.
- Order: a dApp build that hears the switch is live first; then close the old pair; then wait
  until every prompt on it is answered, cancelled or refunded (a prompt can be refunded once it
  is an hour old); only then move the oracle. The oracle keeps answering the old pair until
  then.
- A copy of the dApp built before the switch was added never hears it and can still send a
  prompt to the old pair after it is closed. The wait is for those prompts: skipping it leaves
  them paid with no oracle to answer. A prompt that still arrives after the oracle has moved can
  be refunded by anyone once it is an hour old (`processRefund` on the escrow pays the user who
  sent it), and the operator's procedure has a step for that.
- The owner writes the switch with the operator script in the harness repository, which also
  holds the step-by-step procedure.

### Mainnet pre-flight additions (do before the first mainnet `rofl deploy`)

- [ ] **Refresh the Sapphire-mainnet trust root** (mainnet counterpart of A.1; read-only, no passphrase):
  `oasis rofl trust-root --network mainnet --paratime sapphire` → set `height` + `hash` under
  `deployments.base-mainnet.trust_root` in `rofl.yaml`. Re-verify it after `rofl:build:base-mainnet`
  (the build can rewrite it) and commit `rofl.yaml`.
- [ ] `resources.storage.size` + 2048 ≤ chosen offer storage, with ≥ 1 GiB headroom; confirm the qcow2 size from the built bundle.
- [ ] `--term hour` on the deploy command; ROSE balance read from the ParaTime block covers rental + registration deposit.
- [ ] No stale `machines:` id for the target deployment.
- [ ] Agent **and** escrow implementations verified on Sourcify as well as Basescan.
- [ ] Dedicated RPC endpoint configured for the admin script; rehearse forward + confirm phases against the mainnet Safe with dust values first.
- [ ] `rehearsal-state/` holds the only record of a rehearsal's baseline until the confirm phase passes. It is git-ignored, so `git clean -fdX` and `git clean -fdx` both remove it (without `-d`, neither touches the folder): do not run either in this checkout while a rehearsal is unconfirmed, and copy the snapshot somewhere safe before any cleanup.
- [ ] Treat `rehearsal-state/` as you treat the script: the next run restores whatever baseline the file holds, as owner, without asking. The script keeps it to the running user (folder 0700, file 0600); do not edit it by hand, and never take one from someone else. Run one rehearsal at a time, from one machine.
- [ ] Before the ownership handover, the oracle role is moved to the oracle's own address and the deploy wallet's removed, in the order in §1.1 (never the removal first).
- [ ] Safe threshold and signer set confirmed; Tenderly simulation green before any batch is sent.
- [ ] Wait one heartbeat interval before judging boot; read `machine show` → `net.oasis.error` before reading logs.
- [ ] Payload mirror: `tradable-app-senseai-payloads` applied via Cloud Build on promotion to `prod`; writer key minted and pasted single-line (§9); `payloadMirror.failed` stays 0 across the first heartbeat after the first answered prompt.

## Footguns
- Trust root ~1 yr stale — refresh (A.1) or it light-block loops.
- Cert name `rofl-oracle-base-testnet` — never reuse the social `rofl-<env>` on the shared instance.
- Commit `rofl.yaml` + ALL compose files (`compose.yaml` and the per-env ones). Only the `.orc` is gitignored. `rofl:build:<env>` now runs `scripts/rofl-preflight.sh` first, so a compose carrying placeholder or quoted values cannot be bundled.
- ROFL deploy = `build → update → deploy`, never `restart`/`release`. **Never `oasis rofl machine release`.**
- The oracle's own address (made by the ROFL key service, printed at start-up as `signer=`; not the deploy wallet) needs Base Sepolia ETH for **every answer** — if it runs dry, prompts submit but never get answered (smoke times out → exit 1).
- The oracle's own address must hold the oracle role on the agent: removing the deploy wallet's role before granting the signer's leaves prompts paid and unanswered until the signer is granted it. Follow §1.1.
- Moving the oracle to a new agent and escrow before the old pair has drained leaves prompts paid and unanswered until their one-hour refund: close the old pair with the prompts switch and wait first (see "Moving prompts to a new agent and escrow").
- Testnet TEE lives ~1 h (`playground_short`) — run the smoke promptly after boot.
- Storage math: qcow2 = `storage.size` + 2048 MiB ≤ offer storage, or the app never registers a replica and `machine logs` 404s. Read `machine show` → `net.oasis.error` first.
- `rofl deploy` without `--term hour` rents monthly.
- Nothing in the TEE may depend on a runtime download (the Ollama model pull broke the whole bundle).
- Public load-balanced RPCs serve stale reads; verify at the receipt block.
- Sourcify-verify implementations or the Safe builder cannot decode proxy calls.
