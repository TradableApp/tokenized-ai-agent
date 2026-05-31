# Sapphire/EVMAIAgent Smart Contracts (Hardhat)

> This directory contains the `SapphireAIAgent.sol` and `EVMAIAgent.sol` contract and Hardhat deployment/testing utilities for the production implementation of our tokenized AI Agent.

---

## 🚀 Deployment (Sapphire Localnet / Testnet / Mainnet)

### Compile Contracts

```bash
bunx hardhat compile
```

### Deploy

**For Testnet:**

```bash
ENV_FILE=.env.testnet bunx hardhat run scripts/deploy.js --network sapphire-testnet
```

**For Mainnet:**

```bash
ENV_FILE=.env.mainnet bunx hardhat run scripts/deploy.js --network sapphire
```

---

## 🛠 Interact with Deployed Contract (Hardhat Console)

```bash
bunx hardhat console --network sapphire-testnet

> const aiAgent = await ethers.getContractAt("SapphireAIAgent", "DEPLOYED_ADDRESS")
> await aiAgent.appendPrompt("hello")
> await aiAgent.getPrompts("0x", YOUR_ADDRESS)
```

---

## ✅ Testing

```bash
bunx hardhat test
```
