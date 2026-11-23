# Tokenized AI Agent

[![CI](https://img.shields.io/github/actions/workflow/status/TradableApp/tokenized-ai-agent/ci.yml?branch=main&label=CI)](https://github.com/TradableApp/tokenized-ai-agent/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/TradableApp/tokenized-ai-agent.svg)](./LICENSE)
[![Built with Oasis ROFL](https://img.shields.io/badge/built%20with-oasis%20rofl-7a00ff.svg)](https://docs.oasis.io/build/rofl/)

> **Enterprise-Grade AI Oracle:** Connects EVM smart contracts on Base to confidential off-chain AI inference via Oasis ROFL (TEE).

This repository contains the core infrastructure for the **SenseAI** agent. It bridges on-chain user prompts with off-chain LLMs, storing encrypted conversation history on **Autonomys** (Auto Drive) and indexing events via **The Graph**.

SenseAI runs on Base. The escrow takes whichever ERC-20 fee token it is initialised with: SenseAI's is `SenseToken` from the [`sense-contracts`](https://github.com/TradableApp/sense-contracts) repository, a token that moves only to or from addresses its owner has listed. `AbleToken`, an ordinary ERC-20, is the other token the code supports. The `Sapphire*` contracts are a community example for Oasis Sapphire, kept in parity with their own idioms.

---

## ⚙️ Architecture

```text
User (dApp)
  │
  ▼
Smart Contract (Base) ◄─── Payment & Verification ───┐
  │                                                  │
  │ (Event: PromptSubmitted)                         │ (Tx: submitAnswer)
  ▼                                                  │
Oracle Node (Oasis ROFL / TEE) ──────────────────────┘
  │
  ├─► Decrypts Session Key (Private)
  ├─► Queries AI Model (Gemini/ChainGPT)
  ├─► Encrypts History & Metadata
  └─► Uploads to Autonomys (Auto Drive)
```

1.  **Smart Contracts:** Handle ERC-20 payments, ID reservation, and emit events.
2.  **Oracle (ROFL):** Listens to events, performs verifiable inference inside an Intel TDX enclave, and manages encryption keys.
3.  **Storage:** Encrypted conversation history is stored on Autonomys (Irys/Arweave when `STORAGE_PROVIDER=irys`), with an optional public GCS bucket as a read cache.
4.  **Indexing:** The Graph indexes the contract events to reconstruct chat history for the UI.

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** (v24+) and **Bun**
- **Docker** (Required for local Oracle testing and ROFL builds)
- **Oasis CLI** (For deploying to the ROFL network)
- **Wallets:**
  - EVM private key for deploying and owning the contracts (Base Sepolia/Mainnet)
  - Storage credentials, as the oracle's start-up check requires them: with `STORAGE_PROVIDER` unset (the default) or any value but `irys`, both `AUTONOMYS_API_KEY` and `IRYS_PAYMENT_PRIVATE_KEY` (uploads go to Autonomys; the Irys key keeps older Arweave ids readable); with `STORAGE_PROVIDER=irys`, `IRYS_PAYMENT_PRIVATE_KEY` alone. Neither is asked for with `USE_MOCK_STORAGE=true` or `LOCAL_IPFS_API_URL` set (`oracle/src/startupConfig.js`)

### 1. Installation

```bash
git clone https://github.com/TradableApp/tokenized-ai-agent.git
cd tokenized-ai-agent
bun install
cd oracle && bun install && cd ..
```

### 2. Environment Configuration

This project uses a robust environment loading system. You need to configure **Contract** secrets and **Oracle** secrets.

**Root `.env` (Contracts & RPCs):**

```bash
cp .env.example .env
# Edit .env:
# - PRIVATE_KEY: Your deployer wallet
# - BASE_SEPOLIA_TESTNET_RPC: Your RPC URL
# - ETHERSCAN_API_KEY: For verification
```

**Oracle `.env.oracle.base-testnet` (AI & Storage):**

```bash
cp oracle/.env.oracle.example oracle/.env.oracle.base-testnet
# Edit oracle/.env.oracle.base-testnet:
# - PRIVATE_KEY: leave unset. On every network but a local one the oracle's signing key and
#   its encryption key are made by the ROFL key service inside the TEE, and the oracle refuses
#   to start when PRIVATE_KEY is set (oracle/src/oracleKeys.js, oracle/src/startupConfig.js)
# - AUTONOMYS_API_KEY and IRYS_PAYMENT_PRIVATE_KEY: storage. Both are required while
#   STORAGE_PROVIDER is unset (the default) or anything but irys; with STORAGE_PROVIDER=irys only
#   IRYS_PAYMENT_PRIVATE_KEY is (oracle/src/startupConfig.js)
# - AI_PROVIDER: "Gemini" or "ChainGPT" (optional bypass; unset = full routing hierarchy)
```

---

## 🧪 Local Development (Fast Loop)

> **Full step-by-step guide:** [docs/LOCALNET_SETUP.md](docs/LOCALNET_SETUP.md) — covers all four SenseAI repos end-to-end including The Graph, Sentry verification, and browser wallet setup.


This workflow allows you to test the Contracts and Oracle on your machine using a local blockchain and the frontend dApp.

### 1. Start Local Blockchain

```bash
bunx hardhat node
```

Hardhat prints 20 funded test accounts. **Copy the private keys for Account #0 (oracle/deployer) and Account #1 (user)** — you will need them in the steps below.

### 2. Configure Environment Keys

Fill in `tokenized-ai-agent/.env.base-localnet` with the Account #0 and Account #1 private keys from the Hardhat output, and `DEPLOY_MODE=fresh` with `AI_AGENT_CONTRACT_ADDRESS` and `AI_AGENT_ESCROW_CONTRACT_ADDRESS` empty. On a local network the oracle signs and decrypts with `PRIVATE_KEY`, so its public key can be derived from it:

```bash
ENV_FILE=.env.base-localnet node scripts/getPublicKey.js
```

Copy the printed `Uncompressed Public Key` (starts with `0x04`) into `sense-ai-dapp/.env.localnet` → `VITE_ORACLE_PUBLIC_KEY`.

### 3. Deploy a Fee Token

The escrow takes whichever ERC-20 it is initialised with. Deploy one to Hardhat first, either `SenseToken`:

```bash
cd ../sense-contracts
bun run deploy:localnet
```

(it reads `sense-contracts/.env.localnet`: `TOKEN_NAME`, `TOKEN_SYMBOL`, `INITIAL_SUPPLY` in wei and `OWNER_ADDRESS`, which receives the whole supply; make Account #0 the owner so it can fund Account #1 and send the listing below)

or `AbleToken`:

```bash
cd ../able-contracts
bun run deploy:localnet
```

Copy the printed token proxy address into `tokenized-ai-agent/.env.base-localnet` → `TOKEN_CONTRACT_ADDRESS`.

### 4. Compile and Deploy Contracts

Open a new terminal:

```bash
bun run compile
bun run deploy:base-localnet
```

Copy the printed `EVMAIAgent` and `EVMAIAgentEscrow` proxy addresses into:
- `tokenized-ai-agent/.env.base-localnet` → `AI_AGENT_CONTRACT_ADDRESS`, `AI_AGENT_ESCROW_CONTRACT_ADDRESS`
- `oracle/.env.oracle.base-localnet` → same fields, plus the token address and `PRIVATE_KEY` (Account #0) from Step 2 (the oracle reads no public key setting)
- `sense-ai-dapp/.env.localnet` → `VITE_AGENT_CONTRACT_ADDRESS`, `VITE_ESCROW_CONTRACT_ADDRESS`, `VITE_TOKEN_CONTRACT_ADDRESS`, and `VITE_FEE_TOKEN` (`SENSE` or `ABLE`, the token from Step 3; the dApp's build and dev server stop without it)

Then set `DEPLOY_MODE=upgrade` in `.env.base-localnet`, so a second run upgrades this pair. With `SenseToken`, list the escrow and the treasury on it: `bun run list-fee-token-exempt:base-localnet`. It sends the listing when the signer is the token's owner (the token deploy's `OWNER_ADDRESS`) and otherwise prints the calls for the owner to send. With no `TREASURY_ADDRESS` a local deploy makes the deploy wallet the treasury; a treasury that is the token's owner is listed by name all the same, so it stays listed when ownership moves. `AbleToken` keeps no list and needs nothing.

### 5. Run Local Oracle

Open a third terminal:

```bash
cd oracle && bun run start:base-localnet
```

You should see `[Sentry] Initialized for environment: localnet` followed by the oracle starting its event polling loop.

### 6. Test with dApp

The system is now ready. To test the end-to-end flow (encryption, payment, AI response), run the **SenseAI dApp** locally.

1. Navigate to the `sense-ai-dapp` repository and run `bun run dev`.
2. Add the Hardhat network to your browser wallet (RPC `http://127.0.0.1:8545`, Chain ID `31337`).
3. Import Account #1 using its private key from Step 1.
4. Connect to the dApp and set a spending allowance.
5. Send a message — the Oracle terminal should process the event immediately.

---

## 🌐 Testnet Deployment (Base Sepolia)

### 1. Deploy Contracts

A fresh pair on a live network follows one ordered list, [the runbook's "Fresh pair, in order"](docs/BASE_TESTNET_DEPLOY_RUNBOOK.md#12-fresh-pair-in-order); in short:

1. In `.env.base-testnet`: `DEPLOY_MODE=fresh` with both pair addresses empty, the token, treasury, expected symbol, domain, and the four fees `INITIAL_PROMPT_FEE`, `INITIAL_CANCELLATION_FEE`, `INITIAL_METADATA_FEE`, `INITIAL_BRANCH_FEE` in whole wei. The deploy refuses on a live network while any fee is unset; only a local network has default fees.
2. Dry run, which reads everything and sends nothing, then deploy:

```bash
bun run deploy:base-testnet:dry
bun run deploy:base-testnet
```

3. Record the printed pair and `DEPLOY_MODE=upgrade` in the env file, list the escrow and treasury on the fee token, start the oracle, move the oracle role, and point the rest at the pair, as the runbook orders them.

_Addresses of a deployed pair are filled on deploy day; none is committed here._

> `DEPLOY_MODE` in the env file says what the deploy does: `fresh` deploys a new pair and refuses
> while either `AI_AGENT_CONTRACT_ADDRESS` or `AI_AGENT_ESCROW_CONTRACT_ADDRESS` is set;
> `upgrade` upgrades the pair both name and refuses unless both are set. The mode and the two
> addresses are read from the env file alone, and so, for a fresh pair on a live network, are the
> token, treasury, oracle, expected symbol, the four `INITIAL_*_FEE` (whole numbers of wei) and
> the domain. The token is checked and the plan, fees included, is printed before anything is
> sent; `deploy:base-testnet:dry` / `deploy:base-mainnet:dry` print that plan and send nothing.
> A fresh pair is read back after the deploy; the
> oracle hand-over (`authorize-oracle:<network>`, whose `ORACLE_ADDRESS` and `ANSWER_TX_HASH`
> are set in the env file, never typed before the command) and the fee token listing
> (`list-fee-token-exempt:<network>`) follow, in the order of
> [the runbook's "Fresh pair, in order"](docs/BASE_TESTNET_DEPLOY_RUNBOOK.md#12-fresh-pair-in-order).

> **Base mainnet** uses the same script with `.env.base-mainnet`, but `deploy:base-mainnet` refuses
> to run while any of `TOKEN_CONTRACT_ADDRESS`, `AI_AGENT_CONTRACT_ADDRESS`,
> `AI_AGENT_ESCROW_CONTRACT_ADDRESS`, `TREASURY_ADDRESS` is a placeholder, and unless
> `DEPLOY_MAINNET_CONFIRMED=1` is exported (exactly `1`, mirroring `REHEARSAL_MAINNET_CONFIRMED`
> for the admin rehearsal): `DEPLOY_MAINNET_CONFIRMED=1 bun run deploy:base-mainnet`. Testnet,
> localnet and Sapphire deploys are unaffected.

### 2. The Oracle's Keys

On a deployed network the oracle's signing key and its encryption key are both made by the ROFL key service inside the TEE (`oracle/src/oracleKeys.js`); no person holds either, so the oracle cannot be run with them outside the TEE. Once it runs in ROFL (below), it prints them at start-up:

```text
[OracleKeys] mode=rofl app=… signer=0x… encryptionKey=0x…
```

- `encryptionKey=` is the key prompts are encrypted to: put it in `sense-ai-dapp/.env.testnet` → `VITE_ORACLE_PUBLIC_KEY`.
- `signer=` is the address the oracle answers from. It needs Base Sepolia ETH for answer gas and the oracle role on the agent: the owner grants it with `authorize-oracle:base-testnet grant` and retires the deploy wallet's role after one answer, in the order of [the runbook's "Fresh pair, in order"](docs/BASE_TESTNET_DEPLOY_RUNBOOK.md#12-fresh-pair-in-order).

---

## 🛡️ Oasis ROFL Deployment (TEE)

Package the Oracle into a TEE container for verifiable execution. The ROFL app is registered on Oasis Sapphire (where ROFL apps live; `rofl.yaml`), and the oracle inside it serves the contracts on Base.

### 1. Create ROFL Account

**Important:** ROFL requires `secp256k1` keys. Do not use the default Oasis wallet type.

```bash
oasis wallet create rofl_admin --file.algorithm secp256k1-bip44
oasis rofl create --network testnet --deployment base-testnet --account rofl_admin
```

### 2. Build & Push Image

The ROFL network pulls the code from a container registry.

```bash
bun run image:build:base-testnet
bun run image:push:base-testnet
```

### 3. Build ROFL Bundle

Creates the canonical `.orc` file containing the TEE policy.

```bash
bun run rofl:build:base-testnet
```

### 4. Update Secrets & Deploy

Injects your `.env` variables securely into the TEE and launches the machine.

```bash
# Encrypts and sets secrets on-chain
bun run rofl:set:base-testnet
bun run rofl:update:base-testnet

# Deploys the machine instance
bun run rofl:deploy:base-testnet
```

---

## 📦 Production Release Workflow

For Base mainnet releases, use the interactive script to manage versioning and tagging safely.

```bash
bun run release:base-mainnet
```

This script will:

1.  Prompt for a new version number (e.g., `0.2.0`).
2.  Update `rofl.yaml`.
3.  Build and Push the Docker image with the new tag.

After running the release script, proceed with manual deployment to ensure safety:

```bash
bun run rofl:build:base-mainnet
bun run rofl:update:base-mainnet
bun run rofl:deploy:base-mainnet
```

The `:mainnet` scripts without `base-` are the Sapphire community example's.

---

## 📂 Repository Structure

- `contracts/`: Solidity smart contracts: `EVMAIAgent` and `EVMAIAgentEscrow` (Base), the `Sapphire*` community example, and test mocks. No fee token lives here.
- `oracle/`: Node.js application that runs inside the TEE.
  - `src/aiAgentOracle.js`: Main event listener and logic loop.
  - `src/storage/`: Autonomys, Irys/Arweave and local IPFS storage, and the GCS mirror.
- `scripts/`: Deployment and utility scripts.
- `rofl.yaml`: Oasis ROFL configuration file.

## 🧪 Use

This repository is designed for use in real-world integrations. It may be forked and adapted by other teams integrating token-gated AI agents using their own ERC-20 tokens.

## 🙏 Credits

- Built with Oasis ROFL
- Inspired by demo-rofl-chatbot

## 📜 License

Licensed under the Apache 2.0 License.
