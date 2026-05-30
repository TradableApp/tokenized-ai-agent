# Tokenized AI Agent - Oracle Service (Node.js)

This service listens for on-chain requests from the deployed Oracle smart contract on the Oasis Sapphire network. It queries an AI model (Ollama) for responses, then submits the result back on-chain via the ROFL app and your ERC-20 token payment flow.

---

## 🚀 Getting Started

### 1️⃣ Install dependencies

```bash
cd oracle
bun install
```

---

### 2️⃣ Running the Oracle Service (Testnet / Mainnet)

Make sure `.env.oracle` is configured with your wallet, RPC, and contract address.

```bash
bun run start
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
| `bun run run-localnet`       | Start Oasis Sapphire localnet           |
| `bun run run-localnet-debug` | Start Sapphire localnet with debug logs |
| `bun run test`               | Placeholder for future tests            |

### Running Localnet (Optional)

For local testing with Sapphire:

```bash
bun run run-localnet
```

With debug logging:

```bash
bun run run-localnet-debug
```

---

## 🔐 Environment Variables

Create `.env.oracle` based on `.env.oracle.example`.
