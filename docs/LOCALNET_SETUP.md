# SenseAI Local Development Setup

End-to-end guide for running the full SenseAI stack on a local Hardhat node. Covers all four repos:

| Repo | Role |
|---|---|
| `able-contracts` | AbleToken ERC-20 payment token |
| `tokenized-ai-agent` | Smart contracts (EVMAIAgent + Escrow) and oracle |
| `sense-ai-subgraph` | The Graph indexer for on-chain events |
| `sense-ai-dapp` | React/Vite frontend |

---

## Prerequisites

- Node.js v24+, npm
- Docker Desktop (for the local Graph node)
- An AI API key — at minimum `GOOGLE_GENERATIVE_AI_API_KEY` for the oracle's ElizaOS brain
- Browser wallet (MetaMask or equivalent)

---

## Repo paths (adjust to your machine)

Throughout this guide these paths are assumed:

```
WORK_DIR=/Volumes/T7\ Touch/Work/Tradable/Web\ and\ App\ Development
```

---

## Terminal layout

Open **four terminals** and keep them in these directories:

| Tab | Directory | Purpose |
|---|---|---|
| **Tab 1** | `tokenized-ai-agent/` | Hardhat node + contract commands |
| **Tab 2** | `tokenized-ai-agent/oracle/` | Oracle process |
| **Tab 3** | `sense-ai-subgraph/` | Local Graph node + subgraph deploy |
| **Tab 4** | `sense-ai-dapp/` | dApp dev server |

---

## Phase 1 — Blockchain

### Step 1 — Start the Hardhat node (Tab 1)

```bash
npx hardhat node
```

Hardhat prints 20 pre-funded accounts. **Copy the private keys for Account #0 and Account #1.**

```
Account #0: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
Private Key: 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

Account #1: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
Private Key: 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
```

These keys are **deterministic** — the same every time on a fresh node. **Never use them on any real network.**

Leave this terminal running.

---

### Step 2 — Fill in `.env.base-localnet` (Tab 1, new shell)

Open `tokenized-ai-agent/.env.base-localnet` and set:

```sh
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
USER_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
DOMAIN=localhost
# Leave PUBLIC_KEY and contract addresses blank for now
```

---

## Phase 2 — Deploy contracts

### Step 3 — Deploy AbleToken (Tab 1)

The `able-contracts/.env.localnet` already has the Hardhat account #0 keys pre-filled. Verify it has `INITIAL_SUPPLY` set (check against `.env.example` — it should be `1000000000000000000000000000`).

```bash
cd $WORK_DIR/able-contracts
npm run compile
npm run deploy:localnet
```

> The script pauses for **60 seconds** then attempts Etherscan verification, which will fail on localnet — this is normal and harmless.

Output:
```
✅ AbleToken proxy deployed to: 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
```

Copy the proxy address. This is your `TOKEN_CONTRACT_ADDRESS`.

---

### Step 4 — Compile and deploy oracle contracts (Tab 1)

```bash
cd $WORK_DIR/tokenized-ai-agent
npm run compile
npm run deploy:base-localnet
```

Output:
```
✅ EVMAIAgent proxy deployed to:        0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9
✅ EVMAIAgentEscrow proxy deployed to:  0x5FC8d32690cc91D4c39d9d3abcBD16989F875707
✅ Link successful.
```

These addresses are deterministic — they will always be the same on a fresh Hardhat node as long as AbleToken is deployed first.

---

### Step 5 — Derive the oracle public key (Tab 1)

```bash
cd $WORK_DIR/tokenized-ai-agent
ENV_FILE=.env.base-localnet node scripts/getPublicKey.js
```

Output:
```
🔑 EVM Address:             0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
🔷 Uncompressed Public Key: 0x04<128 hex chars>
```

Copy the **Uncompressed Public Key** (starts with `0x04`, 132 chars total). Paste it into **three places**:

1. `tokenized-ai-agent/.env.base-localnet` → `PUBLIC_KEY=0x04...`
2. `oracle/.env.oracle.base-localnet` → `PUBLIC_KEY=0x04...`
3. `sense-ai-dapp/.env.localnet` → `VITE_ORACLE_PUBLIC_KEY=0x04...`

---

### Step 6 — Fill in all env files with deployed addresses

**`tokenized-ai-agent/.env.base-localnet`:**
```sh
TOKEN_CONTRACT_ADDRESS=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
AI_AGENT_CONTRACT_ADDRESS=0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9
AI_AGENT_ESCROW_CONTRACT_ADDRESS=0x5FC8d32690cc91D4c39d9d3abcBD16989F875707
```

**`oracle/.env.oracle.base-localnet`** — copy keys and addresses:
```sh
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
PUBLIC_KEY=0x04<from Step 5>
IRYS_PAYMENT_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
TOKEN_CONTRACT_ADDRESS=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
AI_AGENT_CONTRACT_ADDRESS=0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9
AI_AGENT_ESCROW_CONTRACT_ADDRESS=0x5FC8d32690cc91D4c39d9d3abcBD16989F875707
# Add at least one AI key:
GOOGLE_GENERATIVE_AI_API_KEY=<your key>
```

**`sense-ai-dapp/.env.localnet`** — add contract addresses and Graph URL:
```sh
VITE_TOKEN_CONTRACT_ADDRESS=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
VITE_AGENT_CONTRACT_ADDRESS=0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9
VITE_ESCROW_CONTRACT_ADDRESS=0x5FC8d32690cc91D4c39d9d3abcBD16989F875707
VITE_THE_GRAPH_API_URL=http://localhost:8000/subgraphs/name/sense-ai
```

---

### Step 7 — Transfer ABLE tokens to the user wallet (Tab 1)

Account #0 holds the full initial token supply. Account #1 needs tokens to pay for prompts (default prompt fee is 1 ABLE):

```bash
cd $WORK_DIR/tokenized-ai-agent
npx hardhat console --network localnet
```

Inside the console:

```js
const token = await ethers.getContractAt("AbleToken", "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512")
const [owner] = await ethers.getSigners()
await token.transfer("0x70997970C51812dc3A010C7d01b50e0d17dc79C8", ethers.parseEther("100"))
// Verify balance
const bal = await token.balanceOf("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")
console.log(ethers.formatEther(bal)) // Should print 100.0
.exit
```

---

## Phase 3 — Sync ABIs and deploy The Graph subgraph

### Step 8 — Sync ABIs to the subgraph (Tab 3)

The subgraph needs ABIs that match the contracts you just compiled:

```bash
cp $WORK_DIR/tokenized-ai-agent/artifacts/contracts/EVMAIAgent.sol/EVMAIAgent.json \
   $WORK_DIR/sense-ai-subgraph/abis/

cp $WORK_DIR/tokenized-ai-agent/artifacts/contracts/EVMAIAgentEscrow.sol/EVMAIAgentEscrow.json \
   $WORK_DIR/sense-ai-subgraph/abis/
```

---

### Step 9 — Start the local Graph node (Tab 3)

```bash
cd $WORK_DIR/sense-ai-subgraph
docker-compose up
```

Wait until you see this line in the Docker output (takes ~30 seconds):

```
graph-node_1  | INFO Starting JSON-RPC admin server
```

Leave this running.

---

### Step 10 — Deploy the subgraph to the local node (Tab 3, new shell)

```bash
cd $WORK_DIR/sense-ai-subgraph

# Create the subgraph slot — only needed once per fresh Graph node
npm run create-local

# Prepare, codegen, build, and deploy in one command
npm run deploy-local
```

When prompted for a **version label**, enter anything (e.g. `v0.0.1`).

Successful output ends with:

```
✔ Deploy to Graph node ✓
Subgraph endpoints:
Queries (HTTP): http://localhost:8000/subgraphs/name/sense-ai
```

> If you restart Docker (wiping the Graph node), run `create-local` again before `deploy-local`.

---

## Phase 4 — Oracle and dApp

### Step 11 — Start the oracle (Tab 2)

```bash
cd $WORK_DIR/tokenized-ai-agent/oracle
npm run start:base-localnet
```

Watch for these two lines immediately:

```
[Sentry] Initialized for environment: localnet
Starting Node.js ROFL Oracle Service...
```

The oracle will then begin polling the Hardhat node for events.

---

### Step 12 — Start the dApp (Tab 4)

```bash
cd $WORK_DIR/sense-ai-dapp
bun run dev
```

Open **http://localhost:3002** in Chrome.

---

## Phase 5 — Browser wallet setup

### Step 13 — Add the Hardhat network to MetaMask

**Settings → Networks → Add Network → Add a network manually:**

| Field | Value |
|---|---|
| Network name | `Hardhat Localnet` |
| RPC URL | `http://127.0.0.1:8545` |
| Chain ID | `31337` |
| Currency symbol | `ETH` |

### Step 14 — Import Account #1

**MetaMask → Import Account** → paste the Account #1 private key:

```
0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
```

Switch to this account and connect it to the dApp at **http://localhost:3002**.

### Step 15 — Add ABLE token to your wallet view

**MetaMask → Import Token** → paste the token address:

```
0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
```

You should see a balance of **100.0 ABLE**.

---

## Phase 6 — End-to-end test

### Step 16 — Set a spending allowance

In the dApp's spending allowance UI:

1. Enter an amount to approve (e.g. `10` ABLE)
2. Set an expiry date (~1 month from now)
3. Confirm both transactions in MetaMask (token approval + `setSpendingLimit`)

### Step 17 — Send a prompt

Type a test message and submit. Switch to **Tab 2** (oracle) and watch the event being processed:

```
[EVENT] Processing PromptSubmitted for convId: 1 in block X
[Crypto] Resolving session key for conversation: 1...
```

After the oracle completes, the dApp should display the AI response.

### Step 18 — Verify conversation history via The Graph

Open the dApp's conversation history view. Entries should appear, populated by the local subgraph at `http://localhost:8000/subgraphs/name/sense-ai`. You can also query it directly in a browser:

```
http://localhost:8000/subgraphs/name/sense-ai/graphql
```

---

## Phase 7 — Sentry verification

### Step 19 — Verify dApp Sentry init

Open **DevTools → Network** and filter by `sentry.io`. On page load, Sentry sends a session envelope — you should see a POST to `https://o4511248324558848.ingest.us.sentry.io/...`.

### Step 20 — Trigger a test error

In **DevTools → Console**:

```js
Sentry.captureException(new Error('localnet smoke test'))
```

Go to **sentry.io → sense-ai-dapp project → Issues**. The error should appear within seconds tagged `environment: localnet`.

### Step 21 — Verify oracle Sentry capture

Any startup errors or connection failures from the oracle (e.g. Irys/Autonomys storage failing on localnet) will appear in **sentry.io → tokenized-ai-oracle project → Issues** tagged `environment: localnet`.

### Step 22 — Verify the sensitive data scrubber

Click any oracle event in Sentry. Expand the **Extra**, **Contexts**, and **Request** sections. Confirm none of these appear as values:

`privateKey` · `encryptedPayload` · `roflEncryptedKey` · `mnemonic` · `AI_AGENT_PRIVATE_KEY`

---

## Phase 8 — Playwright E2E tests

With all services running (Hardhat, oracle, Graph node, dApp), the automated test suite can be run against the live localnet stack.

The full test plan is documented in [E2E_TEST_PLAN.md](./E2E_TEST_PLAN.md). Tests live in `sense-ai-dapp/e2e/`.

### Pre-conditions

All of the following must be running before executing any tests:

- Tab 1: Hardhat node (`npx hardhat node`)
- Tab 2: Oracle (`npm run start:base-localnet`)
- Tab 3: Graph node (`docker-compose up`) + subgraph deployed
- Tab 4: dApp dev server (`bun run dev`)

### Step 23 — Run the smoke suite first

The smoke suite checks infrastructure reachability and basic app load. It must pass before running anything else.

```bash
cd $WORK_DIR/sense-ai-dapp
bun run test:e2e:smoke
```

Expected: **13 tests pass**. If any fail, check the relevant service is running before proceeding.

### Step 24 — Run the auth suite

Tests the full wallet connect → signature → session key flow using the injected mock wallet (no MetaMask required).

```bash
bun run test:e2e:auth
```

Expected: **12 tests pass**. This suite must be green before any other suite, since all other fixtures depend on the auth flow.

### Step 25 — Run remaining suites in dependency order

```bash
bun run test:e2e --project=plan       # Spending limit set/update/cancel
bun run test:e2e --project=chat       # Prompt submit, oracle response, cancel
bun run test:e2e --project=security   # ECIES encryption, no plaintext leaks
bun run test:e2e --project=history    # Conversation list, search, rename, delete
bun run test:e2e --project=refunds    # Stuck payments, refund eligibility
bun run test:e2e --project=graph      # The Graph data layer
bun run test:e2e --project=sentry     # Sentry init and error capture
```

### Step 26 — Run the full regression suite

Once all individual suites pass, run the full regression to confirm nothing conflicts:

```bash
bun run test:e2e
```

### Useful commands

```bash
bun run test:e2e:ui        # Open Playwright's interactive UI for debugging
bun run test:e2e:report    # Open the HTML test report from the last run
```

### Beta readiness gate

All **P0 tests** (40 total) must pass before promoting to testnet. P0 tests are marked in [E2E_TEST_PLAN.md](./E2E_TEST_PLAN.md). Run the full regression and check for any P0 failures before merging the `phase4-sentry` PRs.

---

## Restarting the stack

When you restart the Hardhat node, all chain state is wiped. Re-run Steps 3–7 to redeploy contracts. Contract addresses remain the same (deterministic) so the env files, subgraph config, and dApp config do not need updating.

If you also restart Docker (wiping the Graph node), re-run Steps 9–10 (`docker-compose up` + `create-local` + `deploy-local`).

---

## Notes

- **`scripts/interact.js`** is not compatible with the current ECIES encryption — it uses the legacy `eth-crypto` format. Use the dApp UI for end-to-end prompt testing.
- **Irys/Autonomys storage** will fail on localnet (no funded devnet wallet). These failures are captured by Sentry, which is useful for testing error capture.
- **Slack alerts** are filtered to `mainnet`/`testnet` environments. Localnet events appear in the Sentry dashboard only.
- **The Graph on localnet** is optional for Sentry testing but required for conversation history to display in the dApp.
