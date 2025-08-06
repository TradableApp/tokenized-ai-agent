# Tokenized AI Agent

[![License](https://img.shields.io/github/license/TradableApp/tokenized-ai-agent.svg)](./LICENSE)
[![Built with Oasis ROFL](https://img.shields.io/badge/built%20with-oasis%20rofl-7a00ff.svg)](https://docs.oasis.io/build/rofl/)

> Token-gated AI agent using Oasis ROFL. This repo connects an ERC-20 token to off-chain logic execution via a secure enclave (TDX), enabling trusted AI inference and verifiable on-chain payments.

---

## 🧠 Overview

This repository provides a production-ready integration between an on-chain ERC-20 token and Oasis ROFL, enabling:

- Token-gated access to AI inference
- Secure off-chain execution inside a TEE (Intel TDX)
- Verifiable responses posted back to your smart contract
- Deferred payment only when valid results are delivered

---

## ⚙️ Architecture

```text
User ➔ Smart Contract (ERC-20 gated) ➔ ROFL App (TEE) ➔ External AI (GCP/LLM)
                                       ⮑ signed result + payment
```

1. User sends a query on-chain
2. ROFL app reads query, performs inference using external AI
3. ROFL app submits a signed result back on-chain
4. Smart contract verifies TEE origin and pulls payment using ERC-20 token

---

## 🚀 Getting Started

### 1. Clone the repo

```bash
git clone https://github.com/TradableApp/tokenized-ai-agent.git
cd tokenized-ai-agent
```

### 2. Install dependencies

```bash
npm install
```

---

### 🧪 Local Development (Using Localnet)

This setup is for rapid development and testing on your local machine. It uses a local Sapphire blockchain and a local Ollama AI server, both running in Docker.

#### Prerequisites

Make sure you have [Docker](https://www.docker.com/products/docker-desktop/) installed and running.

#### 1. Start Background Services

You will need three separate terminals for this step.

**Terminal 1: Start Sapphire Localnet**

```bash
cd ./oracle
npm run run-localnet
```

Wait for the output to show a list of "Available Accounts" and their private keys. You will need these in the next step.

**Terminal 2: Start Ollama AI Server**

```bash
docker run -d -v ollama:/root/.ollama -p 11434:11434 --name ollama ollama/ollama
```

Then load the model:

```bash
docker exec ollama ollama pull deepseek-r1:1.5b
```

#### 2. Set Up Local Environment Variables

```bash
cp ./.env.example ./.env.localnet
cp ./oracle/.env.oracle.example ./oracle/.env.oracle.localnet
```

Then edit the equivalent environment files:

- In `./.env.localnet`, update:
  - `PRIVATE_KEY`: Use one of the private keys from the Sapphire localnet output (e.g. account 0)
  - `USER_PRIVATE_KEY`: Use a different private key (e.g. account 1) to simulate a user
  - `ORACLE_CONTRACT_ADDRESS`: Leave this blank for now

- In `./oracle/.env.oracle.localnet`, update:
  - `PRIVATE_KEY`: Use one of the private keys from the Sapphire localnet output (e.g. account 0)
  - `OLLAMA_URL`: Set to `http://localhost:11434`
  - `ORACLE_CONTRACT_ADDRESS`: Leave this blank for now

#### 3. Deploy Contracts to Localnet

```bash
npm run compile
npm run deploy:localnet
```

After deployment, update your `ORACLE_CONTRACT_ADDRESS` in `.env.localnet` and `oracle/.env.oracle.localnet` to the `AIAgent deployed to` in the deploy output.

#### 4. Run the Oracle

```bash
cd ./oracle
npm run start:localnet
```

**Terminal 3: Interact with the smart contract**

#### 5. Send a Prompt to Test

Use the pre-written script in a third terminal to test the flow:

```bash
ENV_FILE=.env.localnet npx hardhat run scripts/send-prompt.js --network sapphire-localnet
```

You should see the Oracle terminal log confirm it received a prompt, queried the AI, and submitted the response on-chain.

---

## 🔬 ROFL Deployment

### 1. Prerequisites

Before you can deploy to a live network (Testnet or Mainnet), you must complete these one-time setup steps.

#### a. Create a Wallet Account

Use `secp256k1-bip44` for compatibility with smart contracts. Create a separate account for each network.

```bash
# For Testnet
oasis wallet create YOUR_TESTNET_ACCOUNT --file.algorithm secp256k1-bip44
```

**Note:** Replace `YOUR_TESTNET_ACCOUNT` with a lowercase identifier (e.g. `your_testnet_account`). Oasis account names must begin with a lowercase letter or number and contain only lowercase letters, numbers, and underscores.

Confirm with:

```bash
oasis wallet list
```

Fund the generated address with TEST tokens via [Oasis Testnet Faucet](https://faucet.testnet.oasis.io/).

After funding, you can confirm your balance on the [Oasis Testnet Explorer](https://testnet.explorer.oasis.io/?network=testnet) by searching for your wallet's ethereum address (0x...).

#### b. Export the private key

```bash
oasis wallet export YOUR_TESTNET_ACCOUNT
```

#### c. Set Up Environment Variables

This project uses a series of `.env` files to manage secrets for different environments.

```bash
# Create the files from their examples
cp .env.example .env.testnet
cp ./oracle/.env.oracle.example ./oracle/.env.oracle.testnet
```

Note: The `PRIVATE_KEY` should be the `Derived secret key` from your `oasis wallet export` output, prefixed with `0x`.

#### d. Deploy Your Smart Contract

Compile the contracts:

```bash
npm run compile
```

Deploy your contract to the target network. The deployment script reads from `.env.*`.

```bash
npm run deploy:testnet
```

After deployment, update your `ORACLE_CONTRACT_ADDRESS` in `.env` and `./oracle/.env.oracle.testnet` to the `AIAgent deployed to` in the deploy output.

#### e. Confirm Deployment (Optional)

After deployment, you can verify the contract exists and the Oracle address is correct:

1. Visit [Oasis Testnet Explorer](https://testnet.explorer.oasis.io/?network=testnet)
2. Search for your deployed ORACLE_CONTRACT_ADDRESS
3. Confirm:
   - The contract exists at the address
   - The deployer address matches your funded wallet

To inspect the contract via Hardhat console:

```bash
npx hardhat console --network sapphire-testnet
```

```javascript
const { Wallet } = require("ethers");
const signer = new Wallet(process.env.PRIVATE_KEY, ethers.provider);
const SapphireAIAgent = await ethers.getContractAt(
  "SapphireAIAgent",
  process.env.ORACLE_CONTRACT_ADDRESS,
  signer,
);
await SapphireAIAgent.oracle(); // Should return your wallet address
```

#### f. Create the ROFL App

Create the ROFL app on-chain. This is a one-time transaction that reserves a unique ID for your application. This command will update your `rofl.yaml` filewith `deployments`.

```bash
oasis rofl create --network testnet --deployment testnet --account YOUR_TESTNET_ACCOUNT
```

---

## ⚗️ Testnet Deployment Workflow

Follow these steps to deploy to the Sapphire Testnet.

### 1. Build and Push the Docker Image

The ROFL provider needs to download your application's image from a public container registry. This step builds the image locally and pushes it.

```bash
npm run image:build:testnet
npm run image:push:testnet
```

### 2. Build the ROFL Bundle

This command packages your application configuration (`compose.yaml`) and TEE metadata into a secure `.orc` bundle.

```bash
npm run rofl:build:testnet
```

### 3. Set ROFL Secrets

Secrets are encrypted and only accessible within the ROFL TEE at runtime. To populate them from your local environment, run:

```bash
npm run rofl:set:testnet
```

This script reads from your `oracle/.env.oracle` and `oracle/.env.oracle.testnet` files, merges them, and sets each secret using `oasis rofl secret set`.

> Note: Be sure you’ve configured `PRIVATE_KEY`, `ORACLE_CONTRACT_ADDRESS`, and other secrets in the relevant `.env` files before setting.

### 4. Update On-Chain Configuration

This critical step encrypts your ROFL secrets and registers them on-chain along with the cryptographic identity of the code you just built.

```bash
npm run rofl:update:testnet
```

⚠️ You’ll be prompted to unlock your wallet and confirm the transaction.

### 5. Deploy the Machine

This command finds an available provider on the ROFL marketplace and instructs them to start a TEE machine running your application.

```bash
npm run rofl:deploy:testnet
```

### 6. Monitor the Deployment

After deploying, you can check the status and view live logs from your application running inside the TEE.

```bash
# Check the status (wait for it to become 'running')
oasis rofl machine show --deployment testnet

# Stream live logs
oasis rofl machine logs --deployment testnet
```

## 🛡 Production (Mainnet) Release Workflow

The mainnet release process is designed to be safe and deliberate, with manual checkpoints.

---

In production, use the `--scheme cri` flag to avoid container manipulation attacks:

```bash
oasis rofl create --network sapphire --deployment mainnet --account YOUR_MAINNET_ACCOUNT --scheme cri
```

**Note:** Replace `YOUR_MAINNET_ACCOUNT` with your actual Oasis account name (following the same naming rules as above).

Make sure production wallets and trust roots are documented and stored securely in a team-accessible password manager or secure vault. Do **not** store private keys in Git.

---

### 1. Prepare Release Assets

This is the primary command to start a new release. It is an interactive script that will:

- Prompt you to enter the new version number (e.g., 0.2.0).
- Update the `version:` field in `rofl.yaml`.
- Build the Docker image with a version-specific tag (e.g., `ghcr.io/tradableapp/tokenized-ai-agent:0.2.0`).
- Push the versioned image to the container registry.
- Print the next steps for you to follow.

```bash
npm run release:mainnet
```

### 2. Commit the Version Bump

After the release script succeeds, your `rofl.yaml` file will be modified. You should commit this change to your repository.

```bash
git add rofl.yaml
git commit -m "chore: Release ROFL v0.2.0"
```

### 3. Manually Build, Update, and Deploy

These steps are kept manual for mainnet to allow you to review the output and transaction details at each critical stage.

```bash
# Build the mainnet ROFL bundle
npm run rofl:build:mainnet

# Update the on-chain secrets and enclave IDs
npm run rofl:update:mainnet

# Deploy to a mainnet provider
npm run rofl:deploy:mainnet
```

## 📜 License

Licensed under the Apache 2.0 License.

## 🙏 Credits

- Built with Oasis ROFL
- Inspired by demo-rofl-chatbot

## 🧪 Use

This repository is designed for use in real-world integrations. It may be forked and adapted by other teams integrating token-gated AI agents using their own ERC-20 tokens.
