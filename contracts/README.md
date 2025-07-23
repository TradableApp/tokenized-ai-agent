# ChatBot Smart Contracts (Hardhat)

> This directory contains the `ChatBot.sol` contract and Hardhat deployment/testing utilities for the production implementation of our tokenized AI Agent.

---

## 🚀 Deployment (Sapphire Localnet / Testnet / Mainnet)

### Compile Contracts

```bash
npx hardhat compile
```

### Deploy

**For Testnet:**

```bash
ENV_FILE=.env.testnet npx hardhat run scripts/deploy.js --network sapphire-testnet
```

**For Mainnet:**

```bash
ENV_FILE=.env.mainnet npx hardhat run scripts/deploy.js --network sapphire
```

---

## 🛠 Interact with Deployed Contract (Hardhat Console)

```bash
npx hardhat console --network sapphire-testnet

> const chatBot = await ethers.getContractAt("ChatBot", "DEPLOYED_ADDRESS")
> await chatBot.appendPrompt("hello")
> await chatBot.getPrompts("0x", YOUR_ADDRESS)
```

---

## ✅ Testing

```bash
npx hardhat test
```
