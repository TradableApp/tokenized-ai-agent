# Tokenized AI Agent - Oracle Service (Node.js)

This service runs inside an Oasis ROFL TEE and listens for prompts paid to the agent and escrow contracts on Base. It routes each prompt to an AI tier (Tradable assistant, ElizaOS/Gemini, ChainGPT, direct Gemini fallback), stores the encrypted answer, and submits it on-chain, which releases the prompt's payment from the escrow. The Sapphire networks (`start:localnet`, `start:testnet`, `start:mainnet`, `run-localnet`) serve the Sapphire community example.

---

## 🚀 Getting Started

### 1️⃣ Install dependencies

```bash
cd oracle
bun install
```

---

### 2️⃣ Running the Oracle Service (Testnet / Mainnet)

Each network has its own env file (`.env.oracle.<network>`). On a deployed network the oracle's keys come from the ROFL key service inside the TEE and `PRIVATE_KEY` must not be set; only a local network uses `PRIVATE_KEY`.

```bash
bun run start:base-localnet   # local Hardhat node
bun run start:base-testnet    # Base Sepolia (inside ROFL)
bun run start:base-mainnet    # Base mainnet (inside ROFL)
```

Or for hot-reloading during development:

```bash
bun run dev
```

---

## 🔧 Useful Scripts

| Command                      | Purpose                                 |
| ---------------------------- | --------------------------------------- |
| `bun run lint`               | Lint the code with ESLint               |
| `bun run clean`              | Clean `node_modules`                    |
| `bun run run-localnet`       | Start Oasis Sapphire localnet (community example) |
| `bun run run-localnet-debug` | Start Sapphire localnet with debug logs |
| `bun run test`               | Run the oracle test suite (mocha, with `.env.oracle.example`) |
| `bun run coverage`           | Test coverage (nyc)                     |

### Running Localnet (Optional)

For local testing of the Sapphire community example:

```bash
bun run run-localnet
```

With debug logging:

```bash
bun run run-localnet-debug
```

---

## 🔐 Environment Variables

Create `.env.oracle.<network>` based on `.env.oracle.example`.
