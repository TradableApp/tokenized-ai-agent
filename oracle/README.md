# Tokenized AI Agent - Oracle Service (Node.js)

This service listens for on-chain requests from the deployed Oracle smart contract on the Oasis Sapphire network. It queries an AI model (Ollama) for responses, then submits the result back on-chain via the ROFL app and your ERC-20 token payment flow.

---

## 🚀 Getting Started

### 1️⃣ Install dependencies

```bash
cd oracle
npm install
```

---

### 2️⃣ Running the Oracle Service (Testnet / Mainnet)

Make sure `.env.oracle` is configured with your wallet, RPC, and contract address.

```bash
npm run start
```

Or for hot-reloading during development:

```bash
npm run dev
```

---

## 🔧 Useful Scripts

| Command                      | Purpose                                 |
| ---------------------------- | --------------------------------------- |
| `npm run lint`               | Lint the code with ESLint               |
| `npm run clean`              | Clean `node_modules`                    |
| `npm run run-localnet`       | Start Oasis Sapphire localnet           |
| `npm run run-localnet-debug` | Start Sapphire localnet with debug logs |
| `npm run test`               | Placeholder for future tests            |

### Running Localnet (Optional)

For local testing with Sapphire:

```bash
npm run run-localnet
```

With debug logging:

```bash
npm run run-localnet-debug
```

---

## 🔐 Environment Variables

Create `.env.oracle` based on `.env.oracle.example`.

---

## 📄 License

Apache 2.0

---

## 🧹 Credits

- Built for Oasis ROFL integration
- Inspired by Oasis `demo-rofl-chatbot` project
