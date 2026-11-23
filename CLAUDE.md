# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

AI agent with ROFL (Runtime OFf-chain Logic) running on Oasis Sapphire (confidential EVM) and Base chains. Enables trusted, confidential off-chain computation for tokenized AI agent logic.

> `simple-tokenized-ai-agent` is archived — this is the active repo.

## Two-Layer Project Structure

This repo is **two separate Node.js packages** with different concerns:

- **Root** (`package.json`): Hardhat project — Solidity contracts, deployment scripts, tests
- **`oracle/`** (`oracle/package.json`): Node.js oracle service — event listener, AI routing, storage, off-chain logic

Always `cd oracle/` and run `bun install` separately when working on oracle code. Contract ABI artifacts (from `bun run compile` at root) are consumed by the oracle via `../../artifacts/contracts/`.

## Shared schema submodule

The oracle reads/writes to a shared GCP Cloud SQL Postgres instance with `sense-ai-core`. Table definitions + migrations live in [`TradableApp/sense-ai-shared-schema`](https://github.com/TradableApp/sense-ai-shared-schema), pulled in here as a git submodule at `packages/shared-schema/`.

```bash
# First clone:
git clone --recurse-submodules https://github.com/TradableApp/tokenized-ai-agent

# After a regular clone:
git submodule update --init --recursive

# Pulling latest schema updates:
git submodule update --remote packages/shared-schema
git add packages/shared-schema && git commit -m "chore: bump sense-ai-shared-schema to <version>"
```

Imported in oracle code as `import { ... } from "@tradableapp/sense-ai-shared-schema"` (path-based dependency at `oracle/package.json` → `"../packages/shared-schema"`). Phase 3 of the v0.3.0 SenseAI plan introduces the actual adapter swap; this submodule lands now so both apps stay in lockstep on table shape and migration history.

## Scripts

### Contracts (run from root)
| Command | Purpose |
|---------|---------|
| `bun run compile` | Compile Solidity contracts (required before starting oracle) |
| `bun run test` | Run contract test suite |
| `bun run coverage` | Coverage report |
| `bun run lint` | Lint code |
| `bun run format` | Format code |
| `bun run deploy:localnet` | Deploy to local Hardhat network |
| `bun run deploy:testnet` | Deploy to Oasis Sapphire testnet |
| `bun run deploy:mainnet` | Deploy to Oasis Sapphire mainnet |
| `bun run deploy:base-localnet` | Deploy to local Base network |
| `bun run deploy:base-testnet` | Deploy to Base testnet |
| `bun run deploy:base-mainnet` | Deploy to Base mainnet (`DEPLOY_MAINNET_CONFIRMED=1`) |
| `bun run deploy:base-testnet:dry` / `deploy:base-mainnet:dry` | `DRY_RUN=1`: a fresh deploy's checks, token read and printed plan (each fee in wei and whole tokens), and nothing sent; no mainnet confirm needed. An upgrade has no dry run |
| `ORACLE_ADDRESS=0x… bun run authorize-oracle:base-testnet grant` | After a fresh deploy whose first oracle is the deploy wallet: adds the oracle's own signer and checks `isOracle`. Sends nothing when the role is held; refuses an `ORACLE_ADDRESS` that is the signing wallet. On a live network the agent, escrow and token come from `ENV_FILE` alone and are printed before anything is read |
| `ORACLE_ADDRESS=0x… ANSWER_TX_HASH=0x… bun run authorize-oracle:base-testnet retire-deployer` | Removes the deploy wallet's oracle role, only when `ORACLE_ADDRESS` holds the role and `ANSWER_TX_HASH` is a successful `submitAnswer` to the agent sent by it; then checks both. Both phases refuse once the agent's owner is not the signer (the Safe's path is named). `:base-localnet` and `:base-mainnet` exist too; on mainnet a send needs `DEPLOY_MAINNET_CONFIRMED=1` |
| `bun run list-fee-token-exempt:base-testnet [--check]` | Lists the escrow and the treasury the escrow names on a fee token that keeps a list (`setTransferExempt`), only those not listed, after checking `escrow.ableToken()` is `TOKEN_CONTRACT_ADDRESS` and the token's symbol is `EXPECTED_FEE_TOKEN_SYMBOL` (required on a live network, where the agent, escrow, token and symbol come from `ENV_FILE` alone and are printed first); reads both back. When the signer is not the token's owner it sends nothing and prints the calls as Safe Transaction Builder JSON. `--check` only reads and fails while either is unlisted. An ordinary token needs nothing; a token whose symbol is `SENSE` that answers as one with no list is refused. `:base-localnet` and `:base-mainnet` exist too |
| `bun run rehearse:base-testnet:dry` | Admin rehearsal dry run on Base testnet: takes the same path as the live run (snapshot, leftover check, resume decisions and refusals), simulates only the owner calls the live run would send, says which it would skip, and sends and writes nothing (needs `REHEARSAL_SAFE_ADDRESS`; optional `REHEARSAL_PROMPT_FEE` in whole tokens, default 2) |
| `bun run rehearse:base-testnet` | Admin rehearsal forward phase: fee/treasury/oracle set-and-restore, then ownership of both proxies offered to the Safe; prints the four Safe transactions (accept both, then offer both back). Before a run that will make the Safe the treasury it asks the escrow's token whether the Safe is on its list (`isTransferExempt`). An ordinary token is recognised only by a revert whose data is exactly `0x`, or that has no data and whose message is the node's bare `execution reverted`; a no, a revert with a reason or data, or any other answer is a refusal. The refusal names the payments an unlisted treasury stops: the fees a user pays straight to the treasury (cancel, branch, rename or delete); a resumed run's refusal says that rehearsing with another Safe needs the snapshot moved aside, since a resume refuses another Safe. A fresh run refuses before anything is sent or written; a resumed run first sends the restore of every set already done, holds back every other step, and ends non-zero naming what it sent and what it held back. On every network but `hardhat`, `localhost` and `localnet` it says whether the signer holds the oracle role, and how the owner removes it (it never removes it; when the signer is the encryption key publisher it says that removing the role withdraws that key, that no client reads the key from the agent today and the oracle does not publish its own yet, that the role is still removed, and that a key must never be published from the deploy wallet), and refuses a `REHEARSAL_ORACLE_ADDRESS` that is the signer, and an unconfirmed snapshot to resume whose oracle is the signer (after the pending-transaction check it sends only the restores of sets already done, holds every other step and ends non-zero naming both). The snapshot is `rehearsal-state/admin-rehearsal.<network>.<agent>.json` (git-ignored, outside the cache `hardhat clean` empties, written to a temporary file and renamed); it records each step as sent and as done, so a re-run resumes without repeating a finished pair, settles a step left as sent from its receipt and event when the node has one (with none, forgets it only if its recorded nonce is unused and nothing is pending), and refuses rather than guesses where the chain and the records disagree, on another rehearsal fee or Safe, or while the wallet has a transaction pending. With no unconfirmed snapshot it refuses a live state that shows rehearsal leftovers. A snapshot earlier versions left in `cache/` is only read: an unconfirmed one of this pair, or one that cannot be read, is not JSON or names no pair, is refused until moved by hand. The folder (0700, file 0600) is as sensitive as the script: the next run restores what it holds. Messages say "move it aside", never delete |
| `bun run rehearse:base-testnet:confirm` | Accepts the ownership the Safe offered back, then verifies ownership, fees, treasury and oracle match the pre-rehearsal snapshot and that no offer is left open. The snapshot records the pair, network and chain it was read from and the Safe: one from another pair, network or chain is refused (a forward dry run refuses it too), and a version 1 snapshot moved into `rehearsal-state/` is checked and written back as version 2, one this phase has passed is not reused as a baseline, the phase does not pass while the Safe still holds the oracle role the rehearsal gave it, nor, on a live network, while the signer holds the oracle role (only the new owner could remove it after the handover), and, on a live network, a snapshot whose live oracle is the signer (an earlier version allowed it) is refused once the ownership offered back has been accepted, and its refusal says to move the snapshot aside when a value differs because it was changed on purpose since, and it refuses while the wallet has a transaction pending, while any step is recorded as sent, or when the forward run did not record both ownership offers done. It has no dry run: `DRY_RUN=1` with it is refused |
| `bun run rehearse:base-mainnet[:dry|:confirm]` | Same three phases against Base mainnet; the forward and confirm phases both send transactions and refuse unless `REHEARSAL_MAINNET_CONFIRMED=1` is set explicitly (the dry run needs no flag) |

### Oracle (run from `oracle/`)
| Command | Purpose |
|---------|---------|
| `bun test` | Run oracle test suite |
| `bun run test -- --grep "pattern"` | Run a single matching test |
| `bun run coverage` | Oracle coverage (nyc) |
| `bun run start:localnet` | Start oracle against local Hardhat network |
| `bun run start:testnet` | Start oracle against Sapphire testnet |
| `bun run start:mainnet` | Start oracle against Sapphire mainnet |
| `bun run start:base-testnet` | Start oracle against Base testnet |
| `bun run start:base-mainnet` | Start oracle against Base mainnet |
| `bun run dev` | Start with nodemon (hot reload) |
| `bun run run-localnet` | Pull and run Sapphire localnet Docker image |

Oracle tests use `.env.oracle.example` by default: `DOTENV_CONFIG_PATH=./.env.oracle.example mocha ...`

### ROFL — Sapphire (run from root)
| Command | Purpose |
|---------|---------|
| `bun run rofl:create:testnet` | Create ROFL app on Sapphire testnet |
| `bun run image:build:testnet` | Build ROFL Docker image (testnet) |
| `bun run image:push:testnet` | Push ROFL image to registry (testnet) |
| `bun run rofl:set:testnet` | Set ROFL app config (testnet) |
| `bun run rofl:build:testnet` | Build ROFL bundle (testnet) |
| `bun run rofl:update:testnet` | Update ROFL bundle on chain (testnet) |
| `bun run rofl:deploy:testnet` | Full ROFL deploy workflow (testnet) |
| `bun run rofl:create:mainnet` | Create ROFL app on Sapphire mainnet |
| `bun run release:mainnet` | Release ROFL image (mainnet) |
| `bun run rofl:set:mainnet` | Set ROFL app config (mainnet) |
| `bun run rofl:build:mainnet` | Build ROFL bundle (mainnet) |
| `bun run rofl:update:mainnet` | Update ROFL bundle on chain (mainnet) |
| `bun run rofl:deploy:mainnet` | Full ROFL deploy workflow (mainnet) |

### ROFL — Base (run from root)
| Command | Purpose |
|---------|---------|
| `bun run rofl:create:base-testnet` | Create ROFL app on Base testnet |
| `bun run rofl:deploy:base-testnet` | Full ROFL deploy workflow (Base testnet) |
| `bun run rofl:create:base-mainnet` | Create ROFL app on Base mainnet |
| `bun run rofl:deploy:base-mainnet` | Full ROFL deploy workflow (Base mainnet) |
| `bun run rofl:init:cloud-sql:sepolia-on-mainnet` | Verification run: Cloud SQL cert for the `base-mainnet` app on the testnet instance |
| `bun run rofl:set:sepolia-on-mainnet` | Verification run: push `base-testnet` config/secrets to the `base-mainnet` app |
| `bun run rofl:build:sepolia-on-mainnet` | Verification run: bundle the `base-testnet` compose for the `base-mainnet` app |
| `bun run rofl:update:sepolia-on-mainnet` | Verification run: set + commit the manifest for the `base-mainnet` app |
| `bun run oasis:unlock <oasis args…>` | Run any `oasis` command non-interactively — passphrase from the macOS Keychain item `oasis-passphrase-<account>`; use it for every `rofl update` / `rofl deploy` instead of asking for the passphrase (runbook § Non-interactive Oasis CLI) |

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

- **Sapphire**: The chain's TEE encrypts all calldata at the protocol level. Event payloads arrive as encrypted strings. The oracle decrypts them with the session key carried in the event payload.
- **Base (EVM)**: No protocol-level encryption. The oracle uses ECIES (`eth-crypto`) to decrypt an asymmetrically encrypted session key, then AES-256-GCM to decrypt the conversation payload client-side.

`contractUtility.js:initializeOracle()` detects which mode applies by checking the network name and wraps the ethers provider/signer with Sapphire helpers when needed.

### The Oracle's Own Keys (`oracle/src/oracleKeys.js`)

The oracle has two keys: one signs its transactions, the other decrypts the session key of each prompt. Where they come from follows from `NETWORK_NAME` alone, with no setting to choose:

- **A local network** (`base-localnet`, `sapphire-localnet`): both are `PRIVATE_KEY`.
- **Every other network**: both are made by the ROFL key service (`POST /rofl/v1/keys/generate` on the appd socket), under two key ids that hold the chain id and the agent address. The same app and id always give the same key, so nothing is stored. `PRIVATE_KEY` must not be set there: `startupConfig.js` refuses to start if it is. If the key service does not answer, the oracle waits, alerts after two minutes and then hourly, and uses no other key.

`index.js` obtains the keys, then calls `configure(keys)` on `aiAgentOracle.js`, then `start()`. Nothing is built while the module loads. The rest of the oracle receives a `decryptor` (`publicKey`, `decrypt`, `proveKey`) and never the key itself. The key ids are pinned by `oracle/test/oracleKeys.test.js`; changing one changes the oracle's address and its encryption key.

Both keys are registered with `oracle/src/secretValues.js` when obtained, and removed by value from everything the console prints and everything sent to Sentry. A new call to the appd socket that returns key material must go through the quiet request helper in `roflUtility.js`, which never repeats an answer.

### Oracle Event Flow (`oracle/src/aiAgentOracle.js`)

The main 1940-line orchestration file. High-level flow on each contract event:

1. Event lands in `pollEvents()` → pushed to `p-queue` (concurrency 5)
2. `handleAndRecord()` wraps each handler — catches validation errors to silently drop malicious payloads, queues retryable failures in the state store for retry. It never saves the chain cursor — the scan loops do, once a whole batch is handled
3. Handler (`handlePrompt`, `handleRegeneration`, `handleBranch`, `handleMetadataUpdate`) decrypts payload, validates via Zod (`payloadValidator.js`)
4. `reconstructHistory()` fetches prior messages from decentralized storage using the linked-list `parentCID` chain; raw encrypted strings are cached in LRU cache (100k items, 24h TTL) to avoid redundant fetches
5. `queryAIModel()` routes to the AI tier (see below)
6. Response is encrypted and new storage files created via `formatters.js`, uploaded to Autonomys or Irys
7. Oracle submits response transaction; on Sapphire via `roflUtility.js:submitTx()` (ROFL appd socket), on EVM via normal ethers signer

Sequential transaction submission is enforced by `txMutex` (async-mutex) to prevent nonce collisions.

**Errors in logs, alerts and reports.** The error ethers throws for a failed request carries the request's address in its message, and a provider's address holds the account's access key. So in the files `oracle/test/describedErrorsGuard.test.js` reads (`aiAgentOracle.js`, `eventPoller.js`, `oracleRoleGate.js` and the three `oracleState/` modules) an error caught in a `catch` block, a `.catch` callback or a `.then` rejection handler (an arrow or a `function`) is never handed whole, nor spread (`{ ...error }`), to the console, a logger (`this.logger`, `elizaLogger` included), `process.stderr.write`, an alert or a thrown error, and no sink is itself the callback (`.catch(console.error)`, `.catch(this.logger.error)`, `.then(ok, console.error)`); the guard does not see an error copied to another name, a destructured parameter, a named handler defined elsewhere (`.then(task, task)`) or a sink it does not list, and `Sentry.captureException(error)` is deliberately not a sink because the Sentry scrubber covers it; only a bare rethrow, or `cause:` in a thrown error, passes it on to code that branches on it. The guard reads no other module. `describeError(error)` gives the line of text (`code: shortMessage`, addresses removed, then ` (cause: KIND)` when the error has a cause: its code or name, never its message) and `describedError(error)` gives an Error object with that message, the original frames and code, and the original's name with addresses removed (`oracle/src/errorDescription.js`). A payload that decrypts but does not parse is reported by kind only: a parse error's message quotes the start of the user's text. Two things are kept on purpose: a revert's data (the contract's answer, read from the chain) and a host and path written without a scheme, which is not taken for an address; the secret parts of configured addresses are removed from it by value. `sendAlert` and the Sentry scrubber remove addresses from all text they are given as well, so a missed call site cannot send one out. The stored `last_error` of a failed retry is the description too. A provider request that got no usable answer while an event was being handled (`isTransientProviderError` in `oracle/src/errors.js`: ethers `SERVER_ERROR`, `TIMEOUT`, `NETWORK_ERROR`, `UNKNOWN_ERROR`, `NONCE_EXPIRED`, `REPLACEMENT_UNDERPRICED`, and a `CALL_EXCEPTION` with no revert data whose JSON-RPC error message does not speak of a revert) queues the event for retry; it is never the fatal branch. When that happens on the first `isJobFinalized` read of a prompt or regeneration, the handler stops there, before any model or storage spend. A start-up that fails is printed, reported and ends the process (`oracle/src/index.js`). A request described in parts has no address to find (a span named `POST /v2/<key>`, a query string), so two more things hold: Sentry records nothing about the oracle's own outgoing requests (no span, no breadcrumb, no trace header; `outgoingRequestIntegrations` in `oracle/src/sentryInit.js`), and the secret parts of every configured address (a long path segment, a query value, a password) are removed by value wherever text is scrubbed (`oracle/src/requestSecrets.js`, applied by `withoutAddresses`). `oracle/test/sentryOutgoingRequests.test.js` runs the real SDK against such an address and reads what would be sent.

**Oracle role.** Every submission needs the oracle role on the agent (`isOracle(address)`; the owner grants it with `addOracle`). The oracle never exits for want of it (`oracle/src/oracleRoleGate.js`). At start-up on EVM it pages once ("CRITICAL: Oracle Not Authorized", naming the `addOracle` call) and carries on booting, heartbeat included; every step that would answer a prompt (`handleAndRecord`, the poll loop, the catch-up scan, the retry pass) waits at the gate. While running, a refused submission is confirmed with `isOracle` before the role is treated as lost: revert data naming `UnauthorizedOracle`, or a revert at mining time that carries no reason (`lostOracleRole`). The event is then queued for retry instead of dropped, and a retry that hits the missing role is not counted as a failed attempt. While waiting it asks the chain every 30 s, pages again each hour ("CRITICAL: Oracle Still Not Authorized"), and sends "Oracle is authorized again" when it resumes. On Sapphire the ROFL app registers itself at start-up, so a role lost while running needs a restart. Prompts older than the refund timeout are still refunded by the escrow. Start-up settles where to resume from before the first wait, and with no stored cursor it stores that block at once, so prompts submitted during a wait are scanned however long the wait lasts. That also holds across a restart during the wait, provided the store accepted the write and the chain is older than the look-back.

**Encryption key on chain (EVM agent).** `oracleEncryptionKey()` is the key clients encrypt a prompt's session key to, and `oracleEncryptionKeyPublisher()` is the oracle that published it. Only an address with the oracle role can publish, through `setOracleEncryptionKey(key, proof)`: the key is 65 bytes uncompressed and the proof is a signature made by that key over a fixed domain string, the chain id, the agent address, the sender and the key (EIP-191), so the only key that can be published is one whose holder signed for an address with the oracle role. The proof says who holds the key, not where it was made: the owner still decides which addresses are oracles. A key can be published when none is, or replaced by its own publisher; another oracle's key cannot be replaced, and publishing the key already there, with a valid proof, is a no-op for any oracle. When the publisher loses the role (`removeOracle` or `renounceRole`) the key is withdrawn and `OracleEncryptionKeyUpdated(address(0), "")` is emitted: removing the publishing oracle leaves clients with no key until another oracle publishes. The oracle does not call the setter yet; that is a later change. On Sapphire the setter stays TEE-only with no proof, and only the event shape matches.

### AI Routing Hierarchy

`classifyIntent()` (`oracle/src/geminiDirect.js`) classifies the intent with a direct Gemini small-model call (JSON-constrained; any failure routes to MARKET), then dispatches:

1. **TRADABLE path** — `queryTradableAssistant()` calls the 1st-party Firebase Callable (SenseAI backend)
2. **ELIZAOS path** — `queryElizaOS()` uses the ElizaOS character + senseai plugin defined in `oracle/src/elizaos/`
3. **ChainGPT fallback** — `queryChainGPT()` if primary paths fail
4. **Direct Gemini final fallback** — `queryGeminiDirect()` calls Gemini without the agent runtime if ChainGPT also fails (a different failure domain from the ElizaOS path, which fronts Gemini through plugin-google-genai)

**Market-data tool server (`oracle/src/elizaos/coingeckoToolServer.js`).** The ElizaOS path gets CoinGecko data through an MCP server the oracle starts as a child process. It is the dependency `@coingecko/coingecko-mcp` at one exact version, so it is in `bun.lock` and in the image, and the oracle's own node runs the package's entry file from `node_modules`: nothing is fetched from a registry at run time. The version is 2.5.0 on purpose. It offers fixed tools (`get_simple_price`, `get_coins_markets`, …), each a read from CoinGecko; releases from 3.0.0 replace them with one tool that runs code written by the model in a Deno runtime the image does not have. Two things in 2.5.0 stay off: its own code tool (off unless an option asks for it; it would send the model's code and the CoinGecko key to a third party) and the documentation search (turned off with `--no-tools=docs`; it would send text chosen by the model to a third party). `oracle/test/coingeckoToolServer.test.js` starts the installed server and holds all of this, along with the rule that every tool server in the character is started by node from an installed package. To move the pin: change the version in `package.json` and in that test, run the test, and read what the new release changed. The child is given its CoinGecko key and environment name, `PATH`, and the MCP library's own defaults (`HOME`, `USER`, `SHELL`, `TERM`, `LOGNAME`); none of the oracle's secrets. A missing package stops the oracle at start-up. With no `COINGECKO_API_KEY` the server starts and every call fails for want of a key.

**Agent settings (`oracle/src/elizaos/agentSettings.js`).** The agent framework copies environment variables into the character's settings when the agent is added, and writes the character to the agent database when the agent starts. With no list it copies every variable. `AGENT_ENV_ALLOW_LIST` is that list, set before `addAgents` by `startAgentWithCleanSettings` and in no other way: model names and the framework's own tuning values, and a test refuses a name that looks like a credential or a service address. The framework's plugins read settings through the runtime and never from the environment, so what the list keeps out and a plugin still needs is handed to the runtime as its own settings, which it keeps in memory and does not store: `agentForFramework` takes the tool servers (`mcp`) out of the character and passes them, with `POSTGRES_URL` and `PGLITE_DATA_DIR` for the database plugin, as the agent's `settings` in `addAgents`. The character keeps an empty `mcp` block in their place: on a start the framework puts stored settings under the character's own and the tool plugin looks in the character before the runtime, so a name left out would let a stored block choose the command the oracle runs. Tests build the framework's runtime and check that both are found, neither is in the character, and a stored block does not override. A plugin of ours that needs a credential reads it from the environment itself. `startAgentWithCleanSettings` is the only place the oracle adds and starts its agent, and it owns the order: clean, set the list, add, start, clean again. Tests call it with stand-ins, so a step that is skipped or moved fails a test. The clean (`cleanStoredAgentSettings`) so runs twice, before the agent is added and after it has started, and removes from every row of `agents` any stored value whose name is not on the list, any stored tool servers, and any setting under a name the character does not define itself (the framework reads a stored setting ahead of the one handed to the runtime). The framework merges stored values back in on every start, so not copying is not enough; the clean before the start keeps what an earlier build stored out of the running agent, and the one after removes what the start itself wrote. Rotate a credential an earlier build stored once a start-up line shows the clean ran. A failed clean is alerted with the kind of error only and does not stop the oracle. The clean waits for its alert for at most ten seconds: only the first clean of an old row has anything to report, so a start that stops soon after must not leave before the alert is out, but the clean runs before the oracle starts on its events and must not hold them up. Where no agent database is configured it says so and does nothing. To give the framework a new setting, add its name to the list; never add a credential. A new framework plugin that reads a setting with no environment fallback gets it through `agentForFramework`.

**Tool server watch (`oracle/src/elizaos/toolServerWatch.js`).** The framework's MCP service connects the character's tool servers and calls their tools, and on its own tells the oracle nothing it can act on. `initializeEliza` points the watch at the agent after the agents start (`follow`) and does not wait for it: the service counts as started only after it has tried every server, which can take minutes. A service not started after three minutes is alerted as missing, and is still attached to when it arrives. When the service has started the watch prints `[ToolServer] <server> connected, N tools`, and sends `CRITICAL: Market-data tool server unavailable` when a server is not connected, does not offer a tool the answers rely on (`oracle/src/elizaos/marketDataTools.js`), or connected only after the agent was shown its tools (the framework builds that list once; the alert says to restart). The oracle still starts, because only some answers need these tools. It wraps the service's tool call and sorts each call into one of four outcomes. `ok`. `failed`, which is thrown as `ToolCallFailedError` so the error is never handed to the model as data: any status but the three below, the server's own words for not reaching its provider, and a call that threw. `refused` (400, 404, 422, or thrown back as invalid): the request was wrong and not the server, and the model is given the result as before. `unclear`: an error with no status, most often a filter the model wrote that the server could not run; the model is given it too. If the service cannot be wrapped at all, the watch sends `CRITICAL: Market-data tool calls are not being watched`. Every call prints one line with the server, the tool and the outcome. Nothing a tool or the model wrote is printed, thrown or alerted by the watch: the model writes a call's arguments from the user's prompt, and a tool's error text can repeat them. An outcome is worded by the watch, and a tool's name is printed only when the server offers a tool of that name. The MCP plugin's own lines that carry the model's arguments, its reasoning or a tool's output are hidden by `oracle/src/elizaos/mutedFrameworkLogs.js`; that covers the plugin, which uses the framework's shared logger, and not the agent runtime's own logger. `queryElizaOS` prints the length of each emission, not its opening. Alerts about calls, at most one in ten minutes: `CRITICAL: Market-data tool calls are failing` after five failed calls in a row or ten of the last twenty (a key that stopped working fails every call while the server stays connected), and `CRITICAL: Market-data tool calls are being refused` after ten refusals since a call was last answered (a key of the wrong kind). A server that was fine and no longer is sends `CRITICAL: Market-data tool server lost` once, after a second look 30 seconds later, again if what is wrong with it changes, and its return is printed at warning level. The watch looks at the servers every minute, after every failed call, and on every heartbeat. The heartbeat carries `toolServers`: each server's `status`, `tools` and `usable` (false for a connected server the agent cannot use), cumulative `calls: { ok, failed, refused, unclear }`, and `rejectedRuns: { toolError, noTool, unreadable }`. When a tool step fails, the MCP plugin replies with an apology (`toolError`), or says it has no tool (`noTool`), or asks the user to repeat the request because the model's choice could not be read (`unreadable`); `toolFailureKind` (`oracle/src/answerSelection.js`) recognises each by the thought sent with it. Such a reply is never the stored answer and its thought is kept out of the stored reasoning. A run that has one is rejected by `queryElizaOS` with `UnansweredToolFailureError` and counted in `rejectedRuns`, unless a synthesis of ours answered, or the plugin wrote from a tool's result after the last failure; a plain reply after the failure does not count, because the framework's closing reply is written from the failed step. `queryAIModel` then answers with the direct Gemini call and does not ask ChainGPT, which keeps its own record of the conversation outside the TEE. `COINGECKO_API_KEY` is required at start-up on every network that is not local, and the example file's placeholder counts as missing.

### Decentralized Storage Layer (`oracle/src/formatters.js`)

Conversation data is stored on Autonomys (`@autonomys/auto-drive`) with Irys as fallback. File types:

- `ConversationFile` — created once per conversation, stores metadata
- `MessageFile` — one per message; contains `parentCID` linking to prior message (linked-list for history reconstruction)
- `ConversationMetadataFile` — updated on metadata changes
- `SearchIndexDeltaFile` — keyword delta for client-side search; keywords generated by `generateKeywords()` (stopword-stripped)

### State Persistence

The chain cursor and the failed-job queue live behind one store (`oracle/src/oracleState/`):

- **Postgres** — tables `oracle_state.oracle_cursors` and `oracle_state.oracle_failed_jobs` in the oracle's own `oracle_agent` database, created at boot by the same plugin-sql migration that creates the agent tables (`agentSchemaMigrator.js`). Survives a restart and a `--wipe-storage` deploy.
- **Files** (`oracle-state.json`, `failed-jobs.json`) — only where no Postgres is configured (localnet, e2e).

The cursor only moves forward, except through the reorg rewind. A failed job is a pointer to the event (tx hash + log index); the retry re-reads the receipt. Retries are claimed under a 15-minute lease, back off exponentially (base 30s, doubles per attempt), and after 10 attempts the job is kept on record as `exhausted` with a CRITICAL alert. If the database cannot be read at start-up the oracle retries for about a minute, then falls back to a 1,800-block lookback and alerts. If the migration cannot create the tables the oracle does not boot. Failures it absorbs while running (cursor writes, queue reads, a poll loop stuck on one range) alert once when they last and once on recovery (`oracleState/outageTracker.js`).

## Environment Files

Two sets of env files, one per layer:

| Level | Files |
|-------|-------|
| Root (contracts/deployment) | `.env`, `.env.localnet`, `.env.testnet`, `.env.mainnet`, `.env.base-localnet`, `.env.base-testnet`, `.env.base-mainnet` |
| Oracle | `oracle/.env.oracle`, `oracle/.env.oracle.base-mainnet`, `oracle/.env.oracle.base-testnet` |

Oracle tests use `oracle/.env.oracle.example` (committed, safe values).

`scripts/deploy.js` on an EVM network reads `DEPLOY_MODE` (`fresh` or `upgrade`, required) and the two pair addresses from the `ENV_FILE` alone, and refuses when the root `.env` or the shell sets one the file does not: `fresh` refuses either pair address, `upgrade` needs both. A fresh pair on a live network also reads `TOKEN_CONTRACT_ADDRESS`, `TREASURY_ADDRESS`, `ORACLE_ADDRESS`, `EXPECTED_FEE_TOKEN_SYMBOL`, the four `INITIAL_*_FEE` and `DOMAIN` from the file alone (`FRESH_LIVE_FILE_ONLY_VARS`), and needs the treasury, the symbol, `DOMAIN` and the four fees; an upgrade reads none of them, and a local network keeps the merged environment (the e2e bring-up writes only the mode, the pair, the token and the symbol to its file). Each fee is a whole number of wei in decimal digits, on every network. `ORACLE_ADDRESS`, when set, is the first oracle instead of the deploy wallet. A refused value is described by its shape, never printed. Before the first proxy a fresh deploy reads the token (code, symbol, decimals) and prints the plan with each fee in wei and whole tokens; afterwards it reads the pair back (links, token, treasury, owners, oracle role, fees, symbol) and fails naming each difference. The order of a fresh pair is in the runbook's "Fresh pair, in order".

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
| `sense-contracts` | `SenseToken` is the fee token the escrow is deployed with where SenseAI is paid in SENSE. It moves only when the sender or the recipient is exempt, so the escrow and the treasury must both be on its exempt list |

### The Universal Key: `answerMessageId`

`answerMessageId` is the single ID that links all four layers:
- **Contract**: returned as param index 3 of `PromptSubmitted`; used by `Escrow.finalizePayment(answerMessageId)` and `Escrow.cancelPrompt(answerMessageId)`
- **Subgraph**: `PromptRequest.id = answerMessageId`; `Payment.id = answerMessageId` (stored as `escrowId`)
- **dApp**: extracted from the `PromptSubmitted` receipt log at param index 3; used to track response polling

### ABI Sync Chain

When contracts change, keep downstream ABIs in sync:

```bash
# 1. Compile contracts (root of this repo)
bun run compile

# 2. Sync ABI artifacts to dApp
cd ../sense-ai-dapp && bun run sync-contracts

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

- `CANCELLATION_TIMEOUT = 3 seconds` — how long after a prompt the user must wait before cancelling it; an earlier cancel reverts with `PromptNotCancellableYet`
- `REFUND_TIMEOUT = 1 hour` — how long a prompt must stay unanswered before anyone can have its fee refunded; an earlier refund reverts with `PromptNotRefundableYet`

## Contract Test Suite

Phase 2 tests (153 passing) cover the full prompt lifecycle, spending limits, cancellation, refunds, and cross-contract flows. Key continuity contracts encoded as tests:

- `PromptSubmitted` param order guard — verifies `answerMessageId` is at index 3
- `answerMessageId` lifecycle — `initiatePrompt()` → `PromptSubmitted` → `finalizePayment(answerMessageId)` succeeds and emits `PaymentFinalized` with the same ID
- SpendingLimit flow — `setSpendingLimit()` → `spendingLimits(user)` returns correct struct → `initiatePrompt()` deducts correctly → `cancelSpendingLimit()` removes it
- CidBundle field-order guard — verifies struct field order matches oracle's assembly
- ABI diff check — import ABI JSON and verify `PromptSubmitted` has correct param count, types, and index positions
- SENSE as the fee token (`test/SenseToken.escrowLifecycle.test.js`) — the escrow and agent run against the SENSE token itself, a dev dependency pinned to a commit of `sense-contracts` and compiled through `contracts/test/SenseTokenImport.sol`. It is compiled against this repository's OpenZeppelin version, so it proves the transfer rule against the escrow's movements, not the deployed bytecode. Covers prompt, answer, cancel, refund, metadata update and branch, and what each unlisted address or a paused token stops. When the token changes, move the pin in `package.json` to the new commit and run the suite

### Ownership

All four contracts hold ownership in two steps (`Ownable2StepUpgradeable` on the EVM pair, `Ownable2Step` on the Sapphire pair): `transferOwnership(next)` only offers it and emits `OwnershipTransferStarted`; the owner changes when `next` calls `acceptOwnership()`. Until then the old owner keeps every owner power, and `pendingOwner()` names who was offered. An address that cannot send a transaction therefore never becomes the owner. `renounceOwnership()` reverts with `OwnershipCannotBeRenounced`. A handover to a Safe is two transactions from two parties: the transfer from the current owner, then `acceptOwnership` from the Safe; it is done only when `owner()` is the Safe and `pendingOwner()` is zero. The owner and the pending owner live in OpenZeppelin's own storage namespaces, so an existing proxy takes this version with its owner and state kept and no offer open: `test/TwoStepOwnership.test.js` deploys the one-step implementations from `test/fixtures/one-step-ownership-implementations.json` (the compiled contracts at `fa4762a`) behind a proxy and upgrades them.

## Key Notes

- `deploy:mainnet` and all mainnet ROFL commands are irreversible — confirm before running
- Run `bun run compile` at root before starting the oracle; it loads ABI artifacts from `../../artifacts/contracts/`
- ROFL requires Oasis CLI tooling and Docker for image build/push
- Confidential compute: on Sapphire, sensitive agent data remains encrypted via TEE; on Base, AES-256-GCM is applied client-side in the oracle
- ABI artifacts from this repo are consumed by `sense-ai-dapp` via its `sync-contracts` script and by `sense-ai-subgraph/abis/` manually
- `REPORT_GAS=true bunx hardhat test` enables gas reporter for contract tests
- **SapphireAIAgent is Oasis grant-only** — the dApp has no Sapphire support; mainnet will be Base EVM only. Sapphire differences from EVMAIAgent are intentional per-ecosystem implementations.

## MCP Tools

Tradable ClickUp MCP is available in this project for task management.
