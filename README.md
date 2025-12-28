# Tokenized AI Agent

[![License](https://img.shields.io/github/license/TradableApp/tokenized-ai-agent.svg)](./LICENSE)
[![Built with Oasis ROFL](https://img.shields.io/badge/built%20with-oasis%20rofl-7a00ff.svg)](https://docs.oasis.io/build/rofl/)

> **Enterprise-Grade AI Oracle:** Connects EVM smart contracts (Base, Ethereum) to confidential off-chain AI inference via Oasis ROFL (TEE).

This repository contains the core infrastructure for the **SenseAI** agent. It bridges on-chain user prompts with off-chain LLMs, storing encrypted conversation history on **Arweave** (via Irys) and indexing events via **The Graph**.

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
  ├─► Queries AI Model (DeepSeek/ChainGPT)
  ├─► Encrypts History & Metadata
  └─► Uploads to Arweave (via Irys)
```

1.  **Smart Contracts:** Handle ERC-20 payments, ID reservation, and emit events.
2.  **Oracle (ROFL):** Listens to events, performs verifiable inference inside an Intel TDX enclave, and manages encryption keys.
3.  **Storage:** Encrypted conversation history is stored permanently on Arweave.
4.  **Indexing:** The Graph indexes the contract events to reconstruct chat history for the UI.

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** (v18+)
- **Docker** (Required for local Oracle testing and ROFL builds)
- **Oasis CLI** (For deploying to the ROFL network)
- **Wallets:**
  - EVM Private Key (Base Sepolia/Mainnet)
  - Irys/Arweave Private Key (For storage costs)

### 1. Installation

```bash
git clone https://github.com/TradableApp/tokenized-ai-agent.git
cd tokenized-ai-agent
npm install
cd oracle && npm install && cd ..
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
# - PRIVATE_KEY: Same as above (or the specific Oracle wallet)
# - IRYS_PAYMENT_PRIVATE_KEY: Wallet with funds for Arweave uploads
# - AI_PROVIDER: "DeepSeek" or "ChainGPT"
# - OLLAMA_URL: http://host.docker.internal:11434 (if running local AI)
```

---

## 🧪 Local Development (Fast Loop)

This workflow allows you to test the Contracts and Oracle on your machine using a local blockchain and the frontend dApp.

### 1. Start Local Blockchain

```bash
npx hardhat node
```

### 2. Deploy Contracts

Open a new terminal:

```bash
# Deploys to localhost (Hardhat Network)
npm run deploy:base-localnet
```

_Note: Copy the deployed contract addresses into your `oracle/.env.oracle.base-localnet` file._

### 3. Run Local Oracle

Open a third terminal. This runs the Oracle logic directly in Node.js:

```bash
# Runs the oracle script pointing to localnet
npm run start:base-localnet
```

### 4. Test with dApp

The system is now ready. To test the end-to-end flow (encryption, payment, AI response), run the **SenseAI dApp** locally.

1.  Navigate to the `sense-ai-dapp` repository.
2.  Run `npm run dev:localnet`.
3.  Connect your wallet (ensure it's imported from Hardhat).
4.  Send a message. You should see the Oracle terminal processing the event immediately.

---

## 🌐 Testnet Deployment (Base Sepolia)

### 1. Deploy Contracts

Deploy the upgradable proxies to Base Sepolia:

```bash
npm run deploy:base-testnet
```

_Copy the `EVMAIAgent` and `EVMAIAgentEscrow` addresses into `oracle/.env.oracle.base-testnet`._

### 2. Initialize Oracle Identity

The TEE needs a Public Key derived from its Private Key to enable encryption.

```bash
ENV_FILE=oracle/.env.oracle.base-testnet node scripts/getPublicKey.js
# Copy the output PUBLIC_KEY back into your .env file
```

### 3. Test Oracle Locally

Before deploying to the TEE, run the oracle on your machine to ensure it connects to Base Sepolia and Irys correctly.

```bash
npm run start:base-testnet
```

_If you see `✅ Oracle is running...`, you are ready for ROFL deployment._

---

## 🛡️ Oasis ROFL Deployment (TEE)

Once the logic is verified, package the Oracle into a TEE container for verifiable execution on the Oasis Sapphire network.

### 1. Create ROFL Account

**Important:** ROFL requires `secp256k1` keys. Do not use the default Oasis wallet type.

```bash
oasis wallet create rofl_admin --file.algorithm secp256k1-bip44
oasis rofl create --network testnet --deployment base-testnet --account rofl_admin
```

### 2. Build & Push Image

The ROFL network pulls the code from a container registry.

```bash
npm run image:build:base-testnet
npm run image:push:base-testnet
```

### 3. Build ROFL Bundle

Creates the canonical `.orc` file containing the TEE policy.

```bash
npm run rofl:build:base-testnet
```

### 4. Update Secrets & Deploy

Injects your `.env` variables securely into the TEE and launches the machine.

```bash
# Encrypts and sets secrets on-chain
npm run rofl:set:base-testnet
npm run rofl:update:base-testnet

# Deploys the machine instance
npm run rofl:deploy:base-testnet
```

---

## 📦 Production Release Workflow

For Mainnet releases, use the interactive script to manage versioning and tagging safely.

```bash
npm run release:mainnet
```

This script will:

1.  Prompt for a new version number (e.g., `0.2.0`).
2.  Update `rofl.yaml`.
3.  Build and Push the Docker image with the new tag.

After running the release script, proceed with manual deployment to ensure safety:

```bash
npm run rofl:build:mainnet
npm run rofl:update:mainnet
npm run rofl:deploy:mainnet
```

---

## 📂 Repository Structure

- `contracts/`: Solidity smart contracts (Agent, Escrow, Token).
- `oracle/`: Node.js application that runs inside the TEE.
  - `src/aiAgentOracle.js`: Main event listener and logic loop.
  - `src/storage/`: Irys/Arweave upload logic.
- `scripts/`: Deployment and utility scripts.
- `rofl.yaml`: Oasis ROFL configuration file.

## 🧪 Use

This repository is designed for use in real-world integrations. It may be forked and adapted by other teams integrating token-gated AI agents using their own ERC-20 tokens.

## 🙏 Credits

- Built with Oasis ROFL
- Inspired by demo-rofl-chatbot

## 📜 License

Licensed under the Apache 2.0 License.
