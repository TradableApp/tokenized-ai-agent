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
  - `CONTRACT_ADDRESS`: Leave this blank for now

- In `./oracle/.env.oracle.localnet`, update:
  - `PRIVATE_KEY`: Use one of the private keys from the Sapphire localnet output (e.g. account 0)
  - `OLLAMA_URL`: Set to `http://localhost:11434`
  - `CONTRACT_ADDRESS`: Leave this blank for now

#### 3. Deploy Contracts to Localnet

```bash
npm run compile
npm run deploy:localnet
```

After deployment, update your `CONTRACT_ADDRESS` in `.env.localnet` and `oracle/.env.oracle.localnet` to the `ChatBot deployed to` in the deploy output.

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

## 🔬 ROFL Setup

### ⚗️ Testnet Deployment

This section assumes you're deploying to Oasis Sapphire testnet using the ROFL CLI.

#### 1. Create a wallet account

Use `secp256k1-bip44` for compatibility with smart contracts:

```bash
oasis wallet create YOUR_TESTNET_ACCOUNT --file.algorithm secp256k1-bip44
```

**Note:** Replace `YOUR_TESTNET_ACCOUNT` with a lowercase identifier (e.g. `your_testnet_account`). Oasis account names must begin with a lowercase letter or number and contain only lowercase letters, numbers, and underscores.

Confirm with:

```bash
oasis wallet list
```

Fund the generated address with TEST tokens via [Oasis Testnet Faucet](https://faucet.testnet.oasis.io/).

After funding, you can confirm your balance on the [Oasis Testnet Explorer](https://testnet.explorer.oasis.io/?network=testnet) by searching for your wallet's ethereum address (0x...).

#### 2. Export the private key

```bash
oasis wallet export YOUR_TESTNET_ACCOUNT
```

---

### 3. Set up environment variables

Copy the example env files and populate them with your secrets:

```bash
cp .env.example .env
cp .env.rofl.example .env.rofl
cp ./oracle/.env.oracle.example ./oracle/.env.oracle
```

Note: The `PRIVATE_KEY` should be the `Derived secret key` from your `oasis wallet export` output, prefixed with `0x`.

#### 4. Deploy Smart Contracts

Compile the contracts:

```bash
npm run compile
```

Deploy to testnet:

```bash
npm run deploy
```

After deployment, update your `CONTRACT_ADDRESS` in `.env` and `./oracle/.env.oracle` to the `ChatBot deployed to` in the deploy output.

#### 4a. Confirm Deployment (Optional)

After deployment, you can verify the contract exists and the Oracle address is correct:

1. Visit [Oasis Testnet Explorer](https://testnet.explorer.oasis.io/?network=testnet)
2. Search for your deployed CONTRACT_ADDRESS
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
const ChatBot = await ethers.getContractAt("ChatBot", process.env.CONTRACT_ADDRESS, signer);
await ChatBot.oracle(); // Should return your wallet address
```

#### 5. Create the ROFL app

```bash
oasis rofl create --network testnet --account YOUR_TESTNET_ACCOUNT
```

This command updates `rofl.yaml` with `deployments`.

#### 6. Build the ROFL container

```bash
oasis rofl build
```

#### 7. Deploy to testnet

```bash
oasis rofl deploy --network testnet --account YOUR_TESTNET_ACCOUNT --show-offers
```

---

### 🛡 Production Deployment Notes

In production, use the `--scheme cri` flag to avoid container manipulation attacks:

```bash
oasis rofl deploy --network sapphire --account YOUR_MAINNET_ACCOUNT --scheme cri
```

**Note:** Replace `YOUR_MAINNET_ACCOUNT` with your actual Oasis account name (following the same naming rules as above).

Make sure production wallets and trust roots are documented and stored securely in a team-accessible password manager or secure vault. Do **not** store private keys in Git.

---

## 🔐 ROFL Secrets

Set API keys or service credentials securely using ROFL secrets:

```bash
oasis rofl secret set OPENAI_KEY ./openai.key
```

Secrets are encrypted and only accessible within the ROFL TEE at runtime.

---

## 📜 License

Licensed under the [Apache 2.0 License](./LICENSE).

---

## 🙏 Credits

- Built with [Oasis ROFL](https://docs.oasis.io/build/rofl/)
- Inspired by [demo-rofl-chatbot](https://github.com/oasisprotocol/demo-rofl-chatbot)

---

## 🧪 Use

This repository is designed for use in real-world integrations. It may be forked and adapted by other teams integrating token-gated AI agents using their own ERC-20 tokens.
