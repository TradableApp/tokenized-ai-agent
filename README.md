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

### 3. Set up environment variables

Copy the example env files and populate them with your secrets:

```bash
cp .env.example .env
cp .env.rofl.example .env.rofl
```

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

Fund the generated address with TEST tokens via [Oasis Testnet Faucet](https://faucet.testnet.oasis.io/).

#### 2. Create the ROFL app

```bash
oasis rofl create --network testnet --account YOUR_TESTNET_ACCOUNT
```

This command updates `rofl.yaml` with `deployments`.

#### 3. Build the ROFL container

```bash
oasis rofl build
```

#### 4. Deploy to testnet

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

## 🧹 Credits

- Built with [Oasis ROFL](https://docs.oasis.io/build/rofl/)
- Inspired by [demo-rofl-chatbot](https://github.com/oasisprotocol/demo-rofl-chatbot)

---

## 🧪 Milestone Use

This repository is designed for use in Oasis milestone submissions and real-world integrations. It may be forked and adapted by other teams integrating token-gated AI agents using their own ERC-20 tokens.
