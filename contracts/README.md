# AI Agent Smart Contracts (Hardhat)

> `EVMAIAgent.sol` and `EVMAIAgentEscrow.sol` are the agent and escrow SenseAI runs on Base. The escrow takes whichever ERC-20 fee token it is initialised with. `SapphireAIAgent.sol` and `SapphireAIAgentEscrow.sol` are a community example for Oasis Sapphire, kept in parity with their own idioms. `mocks/` and `test/` hold contracts for the tests only.

---

## 🚀 Deployment

### Compile Contracts

```bash
bun run compile
```

### Deploy (Base)

```bash
bun run deploy:base-localnet
bun run deploy:base-testnet
DEPLOY_MAINNET_CONFIRMED=1 bun run deploy:base-mainnet
```

`DEPLOY_MODE` in the env file is `fresh` (a new pair) or `upgrade` (the pair the env file names). A fresh pair on a live network needs the four `INITIAL_*_FEE` settings in whole wei (only a local network has defaults), and `deploy:base-testnet:dry` / `deploy:base-mainnet:dry` run every check and print the plan without sending anything. The order of a fresh pair, including the dry run, the oracle hand-over and the fee token listing, is in [the runbook's "Fresh pair, in order"](../docs/BASE_TESTNET_DEPLOY_RUNBOOK.md#12-fresh-pair-in-order).

### Deploy (Sapphire community example)

```bash
bun run deploy:localnet   # sapphire-localnet
bun run deploy:testnet    # sapphire-testnet
bun run deploy:mainnet    # sapphire
```

---

## 🛠 Interact with Deployed Contract (Hardhat Console)

```bash
bunx hardhat console --network baseSepolia

> const agent = await ethers.getContractAt("EVMAIAgent", "DEPLOYED_ADDRESS")
> await agent.owner()
> await agent.isOracle("ORACLE_ADDRESS")
```

---

## ✅ Testing

```bash
bun run test
```
