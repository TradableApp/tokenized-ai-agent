# Tokenized AI Agent

[![License](https://img.shields.io/github/license/TradableApp/tokenized-ai-agent.svg)](./LICENSE)
[![Built with Oasis ROFL](https://img.shields.io/badge/built%20with-oasis%20rofl-7a00ff.svg)](https://docs.oasis.io/build/rofl/)

> Token-gated AI agent using Oasis ROFL. This repo connects an ERC-20 token to off-chain logic execution via a secure enclave (TDX), enabling trusted AI inference and verifiable on-chain payments.

---

## 🧠 Overview

This repository provides a production-ready integration between an on-chain ERC-20 token and Oasis ROFL, enabling:

- Token-gated access to AI inference
- Secure off-chain execution inside a TEE (Intel TDX)
- Verifiable responses posted back to a smart contract
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

### 4. Build and deploy the smart contract

```bash
npx hardhat compile
npx hardhat run scripts/deploy.js --network sapphireTestnet
```

### 5. Build the ROFL app

```bash
oasis rofl build
oasis rofl create
oasis rofl deploy --show-offers
```

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
