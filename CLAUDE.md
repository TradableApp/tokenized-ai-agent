# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

AI agent with ROFL (Runtime OFf-chain Logic) running on Oasis Sapphire (confidential EVM) and Base chains. Enables trusted, confidential off-chain computation for tokenized AI agent logic.

> `simple-tokenized-ai-agent` is archived — this is the active repo.

## Two-Layer Project Structure

This repo is **two separate Node.js packages** with different concerns:

- **Root** (`package.json`): Hardhat project — Solidity contracts, deployment scripts, tests
- **`oracle/`** (`oracle/package.json`): Node.js oracle service — event listener, AI routing, storage, off-chain logic

Always `cd oracle/` and run `npm install` separately when working on oracle code. Contract ABI artifacts (from `npm run compile` at root) are consumed by the oracle via `../../artifacts/contracts/`.

## Scripts

### Contracts (run from root)
| Command | Purpose |
|---------|---------|
| `npm run compile` | Compile Solidity contracts (required before starting oracle) |
| `npm run test` | Run contract test suite |
| `npm run coverage` | Coverage report |
| `npm run lint` | Lint code |
| `npm run format` | Format code |
| `npm run deploy:localnet` | Deploy to local Hardhat network |
| `npm run deploy:testnet` | Deploy to Oasis Sapphire testnet |
| `npm run deploy:mainnet` | Deploy to Oasis Sapphire mainnet |
| `npm run deploy:base-localnet` | Deploy to local Base network |
| `npm run deploy:base-testnet` | Deploy to Base testnet |
| `npm run deploy:base-mainnet` | Deploy to Base mainnet |

### Oracle (run from `oracle/`)
| Command | Purpose |
|---------|---------|
| `npm test` | Run oracle test suite |
| `npm run test -- --grep "pattern"` | Run a single matching test |
| `npm run coverage` | Oracle coverage (nyc) |
| `npm run start:localnet` | Start oracle against local Hardhat network |
| `npm run start:testnet` | Start oracle against Sapphire testnet |
| `npm run start:mainnet` | Start oracle against Sapphire mainnet |
| `npm run start:base-testnet` | Start oracle against Base testnet |
| `npm run start:base-mainnet` | Start oracle against Base mainnet |
| `npm run dev` | Start with nodemon (hot reload) |
| `npm run run-localnet` | Pull and run Sapphire localnet Docker image |

Oracle tests use `.env.oracle.example` by default: `DOTENV_CONFIG_PATH=./.env.oracle.example mocha ...`

### ROFL — Sapphire (run from root)
| Command | Purpose |
|---------|---------|
| `npm run rofl:create:testnet` | Create ROFL app on Sapphire testnet |
| `npm run image:build:testnet` | Build ROFL Docker image (testnet) |
| `npm run image:push:testnet` | Push ROFL image to registry (testnet) |
| `npm run rofl:set:testnet` | Set ROFL app config (testnet) |
| `npm run rofl:build:testnet` | Build ROFL bundle (testnet) |
| `npm run rofl:update:testnet` | Update ROFL bundle on chain (testnet) |
| `npm run rofl:deploy:testnet` | Full ROFL deploy workflow (testnet) |
| `npm run rofl:create:mainnet` | Create ROFL app on Sapphire mainnet |
| `npm run release:mainnet` | Release ROFL image (mainnet) |
| `npm run rofl:set:mainnet` | Set ROFL app config (mainnet) |
| `npm run rofl:build:mainnet` | Build ROFL bundle (mainnet) |
| `npm run rofl:update:mainnet` | Update ROFL bundle on chain (mainnet) |
| `npm run rofl:deploy:mainnet` | Full ROFL deploy workflow (mainnet) |

### ROFL — Base (run from root)
| Command | Purpose |
|---------|---------|
| `npm run rofl:create:base-testnet` | Create ROFL app on Base testnet |
| `npm run rofl:deploy:base-testnet` | Full ROFL deploy workflow (Base testnet) |
| `npm run rofl:create:base-mainnet` | Create ROFL app on Base mainnet |
| `npm run rofl:deploy:base-mainnet` | Full ROFL deploy workflow (Base mainnet) |

## Architecture

### Dual Contract Families

Two parallel contract families exist, one per chain:

| Family | Chain | Contracts |
|--------|-------|-----------|
| Sapphire | Oasis Sapphire | `SapphireAIAgent`, `SapphireAIAgentEscrow` |
| EVM | Base | `EVMAIAgent`, `EVMAIAgentEscrow` |

Both families expose the same event interface (`PromptSubmitted`, `RegenerationRequested`, `BranchRequested`, `MetadataUpdateRequested`) so the oracle handles them identically after initial detection. The key difference is the encryption model (see below). Contracts use OpenZeppelin upgradeable patterns.

### Encryption Model: Sapphire vs EVM

The oracle has two distinct encryption paths, selected automatically by `contractUtility.js`:

- **Sapphire**: The chain's TEE encrypts all calldata at the protocol level. Event payloads arrive as encrypted strings. The oracle decrypts them using the session key derived from `fetchKey()` via the ROFL appd UNIX socket (`/run/rofl-appd.sock`).
- **Base (EVM)**: No protocol-level encryption. The oracle uses ECIES (`eth-crypto`) to decrypt an asymmetrically encrypted session key, then AES-256-GCM to decrypt the conversation payload client-side.

`contractUtility.js:initializeOracle()` detects which mode applies by checking the network name and wraps the ethers provider/signer with Sapphire helpers when needed.

### Oracle Event Flow (`oracle/src/aiAgentOracle.js`)

The main 1940-line orchestration file. High-level flow on each contract event:

1. Event lands in `pollEvents()` → pushed to `p-queue` (concurrency 5)
2. `handleAndRecord()` wraps each handler — catches validation errors to silently drop malicious payloads, records failures to `failed-jobs.json` for retry
3. Handler (`handlePrompt`, `handleRegeneration`, `handleBranch`, `handleMetadataUpdate`) decrypts payload, validates via Zod (`payloadValidator.js`)
4. `reconstructHistory()` fetches prior messages from decentralized storage using the linked-list `parentCID` chain; raw encrypted strings are cached in LRU cache (100k items, 24h TTL) to avoid redundant fetches
5. `queryAIModel()` routes to the AI tier (see below)
6. Response is encrypted and new storage files created via `formatters.js`, uploaded to Autonomys or Irys
7. Oracle submits response transaction; on Sapphire via `roflUtility.js:submitTx()` (ROFL appd socket), on EVM via normal ethers signer

Sequential transaction submission is enforced by `txMutex` (async-mutex) to prevent nonce collisions.

### AI Routing Hierarchy

`routeQueryIntent()` classifies the intent via a local Ollama/DeepSeek call, then dispatches:

1. **TRADABLE path** — `queryTradableAssistant()` calls the 1st-party Firebase Callable (SenseAI backend)
2. **ELIZAOS path** — `queryElizaOS()` uses the ElizaOS character + senseai plugin defined in `oracle/src/elizaos/`
3. **ChainGPT fallback** — `queryChainGPT()` if primary paths fail
4. **Local DeepSeek final fallback** — `queryDeepSeek()` via Ollama if ChainGPT also fails

### Decentralized Storage Layer (`oracle/src/formatters.js`)

Conversation data is stored on Autonomys (`@autonomys/auto-drive`) with Irys as fallback. File types:

- `ConversationFile` — created once per conversation, stores metadata
- `MessageFile` — one per message; contains `parentCID` linking to prior message (linked-list for history reconstruction)
- `ConversationMetadataFile` — updated on metadata changes
- `SearchIndexDeltaFile` — keyword delta for client-side search; keywords generated by `generateKeywords()` (stopword-stripped)

### State Persistence

- `oracle-state.json` — tracks `lastProcessedBlock` to resume polling after restart
- `failed-jobs.json` — retry queue; exponential backoff (base 30s, doubles per attempt, max 10 retries)

## Environment Files

Two sets of env files, one per layer:

| Level | Files |
|-------|-------|
| Root (contracts/deployment) | `.env`, `.env.localnet`, `.env.testnet`, `.env.mainnet`, `.env.base-localnet`, `.env.base-testnet`, `.env.base-mainnet` |
| Oracle | `oracle/.env.oracle`, `oracle/.env.oracle.base-mainnet`, `oracle/.env.oracle.base-testnet` |

Oracle tests use `oracle/.env.oracle.example` (committed, safe values).

## Docker

Oracle is deployed as a Docker container inside a ROFL TEE. Relevant files at root:
- `Dockerfile.oracle` — oracle image definition
- `compose.yaml`, `compose.testnet.yaml`, `compose.mainnet.yaml`, `compose.base-testnet.yaml`, `compose.base-mainnet.yaml` — per-environment Compose files

## Cross-Repo Context

This repo sits at the centre of the SenseAI stack. Three sibling repos depend on it:

| Sibling | Dependency |
|---------|-----------|
| `sense-ai-dapp` | Calls `EVMAIAgentEscrow.initiatePrompt()` for all user writes; parses `PromptSubmitted` event to extract `answerMessageId` at param index 3 (0-based, non-indexed) |
| `sense-ai-subgraph` | Indexes events from both `EVMAIAgent` and `EVMAIAgentEscrow`; ABI files in `sense-ai-subgraph/abis/` must match compiled artifacts |
| `able-contracts` | `AbleToken` is the ERC20 payment token; `EVMAIAgentEscrow` calls `token.transferFrom(user, escrow, amount)` |

### The Universal Key: `answerMessageId`

`answerMessageId` is the single ID that links all four layers:
- **Contract**: returned as param index 3 of `PromptSubmitted`; used by `Escrow.finalizePayment(answerMessageId)` and `Escrow.cancelPrompt(answerMessageId)`
- **Subgraph**: `PromptRequest.id = answerMessageId`; `Payment.id = answerMessageId` (stored as `escrowId`)
- **dApp**: extracted from the `PromptSubmitted` receipt log at param index 3; used to track response polling

### ABI Sync Chain

When contracts change, keep downstream ABIs in sync:

```bash
# 1. Compile contracts (root of this repo)
npm run compile

# 2. Sync ABI artifacts to dApp
cd ../sense-ai-dapp && npm run sync-contracts

# 3. Manually copy updated ABI JSON files to subgraph
cp artifacts/contracts/EVMAIAgent.sol/EVMAIAgent.json ../sense-ai-subgraph/abis/
cp artifacts/contracts/EVMAIAgentEscrow.sol/EVMAIAgentEscrow.json ../sense-ai-subgraph/abis/
```

Any change to event signatures must be reflected in all three downstream consumers before deploying.

### Deployed Addresses (Base Sepolia)

| Contract | Proxy Address |
|----------|--------------|
| EVMAIAgent | `0x4a0C7e5807f9174499a8F56F2C69c61b39a4c64D` |
| EVMAIAgentEscrow | `0x36ec08471F2b995024967204D7542713cFaf5Fa4` |

### Critical Event Signatures

```
PromptSubmitted(
  address indexed user,
  uint256 indexed conversationId,
  uint256 indexed promptMessageId,
  uint256 answerMessageId,      ← param index 3 (non-indexed) — the universal key
  bytes encryptedPayload,
  bytes roflEncryptedKey
)
```

### Constants

- `CANCELLATION_TIMEOUT = 3 seconds` — window during which user can cancel a prompt
- `REFUND_TIMEOUT = 1 hour` — window during which user can claim refund for unanswered prompt

## Contract Test Suite

Phase 2 tests (153 passing) cover the full prompt lifecycle, spending limits, cancellation, refunds, and cross-contract flows. Key continuity contracts encoded as tests:

- `PromptSubmitted` param order guard — verifies `answerMessageId` is at index 3
- `answerMessageId` lifecycle — `initiatePrompt()` → `PromptSubmitted` → `finalizePayment(answerMessageId)` succeeds and emits `PaymentFinalized` with the same ID
- SpendingLimit flow — `setSpendingLimit()` → `spendingLimits(user)` returns correct struct → `initiatePrompt()` deducts correctly → `cancelSpendingLimit()` removes it
- CidBundle field-order guard — verifies struct field order matches oracle's assembly
- ABI diff check — import ABI JSON and verify `PromptSubmitted` has correct param count, types, and index positions

## Key Notes

- `deploy:mainnet` and all mainnet ROFL commands are irreversible — confirm before running
- Run `npm run compile` at root before starting the oracle; it loads ABI artifacts from `../../artifacts/contracts/`
- ROFL requires Oasis CLI tooling and Docker for image build/push
- Confidential compute: on Sapphire, sensitive agent data remains encrypted via TEE; on Base, AES-256-GCM is applied client-side in the oracle
- ABI artifacts from this repo are consumed by `sense-ai-dapp` via its `sync-contracts` script and by `sense-ai-subgraph/abis/` manually
- `REPORT_GAS=true npx hardhat test` enables gas reporter for contract tests
- **SapphireAIAgent is Oasis grant-only** — the dApp has no Sapphire support; mainnet will be Base EVM only. Sapphire differences from EVMAIAgent are intentional per-ecosystem implementations.

## MCP Tools

Tradable ClickUp MCP is available in this project for task management.
