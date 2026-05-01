# SenseAI End-to-End Test Plan

Beta readiness test plan covering the full SenseAI dApp stack on localnet.
Passing all **P0** tests is the gate for testnet deployment.

---

## How to read this document

### Priority levels

| Level | Meaning |
|---|---|
| **P0** | Must pass before testnet deployment. Blocking. |
| **P1** | Should pass. Significant UX or data integrity issue if failing. |
| **P2** | Nice to have. Minor UX issue or edge case. |

### Automation classification

| Tag | Meaning |
|---|---|
| `AUTO` | Playwright handles end-to-end with no manual steps |
| `MOCK-WALLET` | Playwright with mock EIP-1193 provider injected via `addInitScript` |
| `MANUAL` | Requires real wallet interaction (ThirdWeb modal + MetaMask signing) |
| `SKIP-LOCALNET` | Requires testnet infrastructure (Firebase Functions, Arweave, etc.) |

### Localnet known skips

The following features depend on infrastructure not available on localnet and are marked `SKIP-LOCALNET`. They must be tested on testnet before launch:

- **Firebase Firestore** live response streaming (used for real-time AI response display)
- **Firebase Functions** faucet (`requestTestTokens`)
- **Arweave/Autonomys** decentralised storage (conversation history hydration from CIDs)
- **PostHog** user identification (uses Firebase email from ThirdWeb in-app wallets)
- **Firebase App Check** (reCAPTCHA Enterprise — debug token used on localnet)

---

## Test suites

---

### T-INIT — App Initialisation

| ID | Test | Priority | Automation | Notes |
|---|---|---|---|---|
| T-INIT-01 | App loads at `http://localhost:3002` with HTTP 200 | P0 | `AUTO` | |
| T-INIT-02 | Splash screen renders during boot, disappears once ready | P0 | `AUTO` | |
| T-INIT-03 | On first visit, cookie consent banner appears | P1 | `AUTO` | `consentSettings` not in localStorage |
| T-INIT-04 | Accepting consent dismisses the banner | P1 | `AUTO` | Banner gone, `consentSettings` written |
| T-INIT-05 | Rejecting consent dismisses banner without enabling PostHog | P1 | `AUTO` | No PostHog `identify` call |
| T-INIT-06 | Sentry session envelope POSTs to `ingest.sentry.io` within 2s of page load | P0 | `AUTO` | Network intercept |
| T-INIT-07 | No JavaScript errors thrown during initial load | P0 | `AUTO` | Console error listener |
| T-INIT-08 | On app-level Firebase init failure, error screen renders | P2 | `AUTO` | Inject mock failure via env |
| T-INIT-09 | Network offline overlay renders when browser goes offline | P1 | `AUTO` | `page.setOffline(true)` |
| T-INIT-10 | Network overlay disappears when browser comes back online | P1 | `AUTO` | `page.setOffline(false)` |
| T-INIT-11 | PWA web app manifest is served at `/manifest.webmanifest` | P2 | `AUTO` | |
| T-INIT-12 | Service worker registers successfully in browser | P2 | `AUTO` | `navigator.serviceWorker.ready` |

---

### T-AUTH — Wallet Connection and Authentication

| ID | Test | Priority | Automation | Notes |
|---|---|---|---|---|
| T-AUTH-01 | Unauthenticated user is redirected to `/auth` from protected routes | P0 | `AUTO` | Direct navigation to `/`, `/chat`, `/history` |
| T-AUTH-02 | Auth page renders ThirdWeb `ConnectButton` | P0 | `AUTO` | |
| T-AUTH-03 | Mock injected wallet (`window.ethereum`) surfaces as "Injected Wallet" in ThirdWeb connect modal | P0 | `MOCK-WALLET` | Core of Option A |
| T-AUTH-04 | Connecting wallet dismisses connect modal | P0 | `MOCK-WALLET` | |
| T-AUTH-05 | After wallet connect, `SignatureScreen` appears requesting session key signature | P0 | `MOCK-WALLET` | SIGNATURE_MESSAGE shown |
| T-AUTH-06 | Mock wallet auto-signs the session message; spinner replaces button | P0 | `MOCK-WALLET` | `status === 'deriving'` |
| T-AUTH-07 | After successful signature, user is redirected to `/` (Usage Dashboard) | P0 | `MOCK-WALLET` | `status === 'ready'` |
| T-AUTH-08 | `ownerAddress` matches Account #1 address after sign-in | P0 | `MOCK-WALLET` | Visible in nav user component |
| T-AUTH-09 | Rejecting the signature shows error state with retry button | P1 | `MOCK-WALLET` | Mock `signMessage` to reject |
| T-AUTH-10 | Clicking retry re-triggers signature request | P1 | `MOCK-WALLET` | |
| T-AUTH-11 | On page reload with wallet still connected, session auto-reconnects without re-signing | P1 | `MOCK-WALLET` | ThirdWeb auto-connect |
| T-AUTH-12 | Disconnecting wallet resets session to `disconnected`, redirects to `/auth` | P1 | `MOCK-WALLET` | |
| T-AUTH-13 | Wrong network prompt shown if wallet is on a different chain | P1 | `MOCK-WALLET` | Inject wrong `chainId` |

---

### T-PLAN — Spending Plan Management

| ID | Test | Priority | Automation | Notes |
|---|---|---|---|---|
| T-PLAN-01 | New user with no plan sees OnboardingFlow with WarpBackground animation | P0 | `MOCK-WALLET` | `plan === null` state |
| T-PLAN-02 | "Get Started" CTA opens `ManagePlanModal` | P0 | `MOCK-WALLET` | |
| T-PLAN-03 | Token balance displays correctly in plan modal (100 ABLE) | P0 | `MOCK-WALLET` | Reads from contract |
| T-PLAN-04 | Entering spend limit and days validates inputs (positive numbers only) | P1 | `AUTO` | Zod schema enforced |
| T-PLAN-05 | Setting a plan triggers ERC-20 `approve` transaction first | P0 | `MOCK-WALLET` | Mock wallet confirms, tx mined |
| T-PLAN-06 | After approval, `setSpendingLimit` transaction is submitted | P0 | `MOCK-WALLET` | Second tx confirmed |
| T-PLAN-07 | After both transactions confirm, modal closes and dashboard shows plan | P0 | `MOCK-WALLET` | `PlanStatusCard` rendered |
| T-PLAN-08 | PlanStatusCard shows correct allowance, spent amount (0), and expiry date | P0 | `MOCK-WALLET` | Read from contract |
| T-PLAN-09 | ABLE token balance decreases by approved amount after plan set | P1 | `MOCK-WALLET` | |
| T-PLAN-10 | Updating plan triggers new `approve` + `setSpendingLimit` | P1 | `MOCK-WALLET` | Existing plan flow |
| T-PLAN-11 | Cancelling plan triggers `cancelSpendingLimit` and removes plan from dashboard | P1 | `MOCK-WALLET` | Confirm alert dialog |
| T-PLAN-12 | "Request test tokens" faucet button present in plan modal on testnet | P1 | `SKIP-LOCALNET` | Firebase Functions |
| T-PLAN-13 | Insufficient token balance shows appropriate error | P1 | `MOCK-WALLET` | Set balance to 0 |
| T-PLAN-14 | Plan modal rejects `limit` of 0 or negative | P1 | `AUTO` | Client-side validation |
| T-PLAN-15 | Plan modal rejects `days` of 0 | P1 | `AUTO` | Client-side validation |
| T-PLAN-16 | `PriceInfoDialog` info button opens pricing breakdown overlay | P2 | `AUTO` | |
| T-PLAN-17 | Expired plan displays "Expired" status in PlanStatusCard | P1 | `MOCK-WALLET` | Fast-forward time or set past expiry |

---

### T-CHAT — Prompt Submission and Response

| ID | Test | Priority | Automation | Notes |
|---|---|---|---|---|
| T-CHAT-01 | `/chat` route renders prompt input area | P0 | `MOCK-WALLET` | |
| T-CHAT-02 | No active plan shows `ActivatePlanCTA` instead of prompt input | P0 | `MOCK-WALLET` | |
| T-CHAT-03 | Submitting empty prompt is blocked (disabled submit button) | P1 | `AUTO` | |
| T-CHAT-04 | Submitting a prompt triggers ECIES encryption using `VITE_ORACLE_PUBLIC_KEY` | P0 | `MOCK-WALLET` | Verify no plaintext in calldata |
| T-CHAT-05 | `initiatePrompt` transaction is submitted on-chain | P0 | `MOCK-WALLET` | Watch Hardhat node logs |
| T-CHAT-06 | Oracle picks up `PromptSubmitted` event within 5s | P0 | `MANUAL` | Watch oracle logs in Tab 2 |
| T-CHAT-07 | Oracle decrypts session key and processes prompt | P0 | `MANUAL` | Log: `[Crypto] Resolving session key` |
| T-CHAT-08 | Oracle calls AI model and submits encrypted answer on-chain | P0 | `MANUAL` | Log: AI query + `submitAnswer` tx |
| T-CHAT-09 | dApp receives answer and displays it in conversation view | P0 | `MOCK-WALLET` | Poll / Firestore listener |
| T-CHAT-10 | Loading/thinking indicator shown while awaiting oracle response | P1 | `MOCK-WALLET` | `Loader` component visible |
| T-CHAT-11 | Prompt text is NOT readable in plaintext in browser Network tab | P0 | `AUTO` | Intercept `initiatePrompt` calldata |
| T-CHAT-12 | Cancel button available immediately after submission | P1 | `MOCK-WALLET` | Within 3s `CANCELLATION_TIMEOUT_MS` |
| T-CHAT-13 | Cancelling within 3s cancellation window calls `cancelPrompt` | P1 | `MOCK-WALLET` | |
| T-CHAT-14 | Cancelled prompt shows "Cancelled" state in conversation | P1 | `MOCK-WALLET` | |
| T-CHAT-15 | Cancel button disappears after cancellation window expires | P1 | `MOCK-WALLET` | Wait 3s+ |
| T-CHAT-16 | Sending a second prompt in an existing conversation works | P0 | `MOCK-WALLET` | No new conversation created |
| T-CHAT-17 | New conversation created when starting from `/chat` with no active conversation | P0 | `MOCK-WALLET` | |
| T-CHAT-18 | Conversation is persisted to IndexedDB after oracle responds | P0 | `AUTO` | Check `db.conversations` |
| T-CHAT-19 | Spent amount in PlanStatusCard increments after successful prompt | P1 | `MOCK-WALLET` | Re-read contract |
| T-CHAT-20 | Response markdown renders correctly (bold, code blocks, lists) | P1 | `AUTO` | Inject known markdown response |
| T-CHAT-21 | Reasoning/thinking toggle visible if AI returns `<think>` blocks | P2 | `AUTO` | Mock response with thinking |

---

### T-REGEN — Prompt Editing and Regeneration

| ID | Test | Priority | Automation | Notes |
|---|---|---|---|---|
| T-REGEN-01 | Hovering a user message shows action menu (edit, branch) | P1 | `AUTO` | |
| T-REGEN-02 | Editing a user message shows inline edit input | P1 | `AUTO` | |
| T-REGEN-03 | Submitting edited prompt triggers `editUserMessage` in dataService | P1 | `MOCK-WALLET` | Sends new on-chain prompt |
| T-REGEN-04 | Hovering AI message shows regenerate action | P1 | `AUTO` | |
| T-REGEN-05 | Clicking regenerate submits `RegenerationRequested` event on-chain | P1 | `MOCK-WALLET` | |
| T-REGEN-06 | Oracle processes regeneration and submits new answer | P1 | `MANUAL` | Oracle log: `RegenerationRequested` |
| T-REGEN-07 | Regenerated answer replaces previous answer in conversation | P1 | `MOCK-WALLET` | |

---

### T-BRANCH — Conversation Branching

| ID | Test | Priority | Automation | Notes |
|---|---|---|---|---|
| T-BRANCH-01 | "Branch" / Split icon visible on AI messages | P1 | `AUTO` | |
| T-BRANCH-02 | Clicking branch opens confirmation dialog | P1 | `AUTO` | |
| T-BRANCH-03 | Confirming branch calls `branchConversation` which submits `BranchRequested` on-chain | P1 | `MOCK-WALLET` | |
| T-BRANCH-04 | Branch fee deducted from spending allowance | P1 | `MOCK-WALLET` | |
| T-BRANCH-05 | New conversation appears in history with copy of messages up to branch point | P1 | `MOCK-WALLET` | |
| T-BRANCH-06 | Oracle processes branch and responds | P1 | `MANUAL` | |

---

### T-REFUND — Stuck Requests and Refunds

| ID | Test | Priority | Automation | Notes |
|---|---|---|---|---|
| T-REFUND-01 | After 1 hour (`REFUND_TIMEOUT_MS`) with no answer, refund button appears on stuck prompt | P0 | `AUTO` | Mock `Date.now()` or wait |
| T-REFUND-02 | `isRefundEligible` returns false if answered | P0 | `AUTO` | Unit-covered, re-verify via UI |
| T-REFUND-03 | `isRefundEligible` returns false if cancelled | P0 | `AUTO` | |
| T-REFUND-04 | `isRefundEligible` returns false before 1 hour | P0 | `AUTO` | |
| T-REFUND-05 | Clicking refund on eligible stuck prompt calls `cancelAndRefundPrompt` | P0 | `MOCK-WALLET` | |
| T-REFUND-06 | ABLE balance restored after refund (less cancellation fee) | P0 | `MOCK-WALLET` | |
| T-REFUND-07 | Stuck payment detected via `GET_STUCK_PAYMENTS_QUERY` to The Graph | P1 | `AUTO` | Wait for a stuck payment to be indexed |
| T-REFUND-08 | Zombie graph entries (PENDING on graph but COMPLETE on-chain) are filtered out | P1 | `AUTO` | Verify `useStuckRequests` contract double-check |

---

### T-HIST — Conversation History

| ID | Test | Priority | Automation | Notes |
|---|---|---|---|---|
| T-HIST-01 | `/history` renders list of past conversations | P0 | `MOCK-WALLET` | After a prompt has been answered |
| T-HIST-02 | Conversations sorted by `lastMessageCreatedAt` descending | P1 | `AUTO` | |
| T-HIST-03 | Conversation list shows last message preview text | P1 | `AUTO` | |
| T-HIST-04 | Clicking a conversation navigates to `/chat` with that conversation active | P0 | `AUTO` | |
| T-HIST-05 | Searching conversations filters list in real time | P1 | `AUTO` | `searchService` / flexsearch |
| T-HIST-06 | Clearing search restores full list | P1 | `AUTO` | |
| T-HIST-07 | Three-dot menu on conversation shows rename and delete options | P1 | `AUTO` | |
| T-HIST-08 | Renaming a conversation updates IndexedDB and re-renders list | P1 | `AUTO` | `RenameConversationModal` |
| T-HIST-09 | Deleting a conversation shows confirmation dialog | P1 | `AUTO` | |
| T-HIST-10 | Confirming delete removes conversation from list and IndexedDB | P1 | `AUTO` | Soft-delete via CID encoding |
| T-HIST-11 | Deleted conversation does not reappear after sync | P1 | `AUTO` | Re-run sync, verify not restored |
| T-HIST-12 | Empty history state renders `EmptyState` component with CTA | P1 | `AUTO` | |
| T-HIST-13 | "New Chat" button navigates to `/chat` | P1 | `AUTO` | |
| T-HIST-14 | History loads encrypted conversations and decrypts with session key | P0 | `MOCK-WALLET` | Verifies ECIES + AES symmetric decryption chain |
| T-HIST-15 | Conversations from Arweave storage hydrate correctly from CIDs | P0 | `SKIP-LOCALNET` | Requires real Arweave network |

---

### T-DASH — Usage Dashboard

| ID | Test | Priority | Automation | Notes |
|---|---|---|---|---|
| T-DASH-01 | Usage Dashboard (`/`) shows `PlanStatusCard` with correct values | P0 | `MOCK-WALLET` | allowance, spentAmount, expiresAt |
| T-DASH-02 | "Manage Plan" button on PlanStatusCard opens `ManagePlanModal` | P1 | `AUTO` | |
| T-DASH-03 | `RecentActivityCard` shows list of on-chain activity from The Graph | P1 | `MOCK-WALLET` | After at least one prompt |
| T-DASH-04 | Activity amounts display correctly (negative for costs, positive for refunds) | P1 | `AUTO` | |
| T-DASH-05 | `pendingEscrowCount` increments correctly while a prompt is in-flight | P1 | `MOCK-WALLET` | |
| T-DASH-06 | `pendingEscrowCount` decrements after oracle finalises payment | P1 | `MOCK-WALLET` | |

---

### T-GRAPH — The Graph Data Layer

| ID | Test | Priority | Automation | Notes |
|---|---|---|---|---|
| T-GRAPH-01 | Local Graph node GraphQL endpoint responds at `localhost:8000` | P0 | `AUTO` | |
| T-GRAPH-02 | `GET_USER_UPDATES_QUERY` returns conversation after `PromptSubmitted` mined | P0 | `AUTO` | Direct GraphQL query |
| T-GRAPH-03 | `AnswerMessageAdded` event causes `PromptRequest.isAnswered` to become `true` in graph | P0 | `AUTO` | Poll until updated |
| T-GRAPH-04 | `PaymentEscrowed` event creates `Payment` entity in graph | P1 | `AUTO` | |
| T-GRAPH-05 | `PaymentFinalized` event marks `Payment` complete in graph | P1 | `AUTO` | |
| T-GRAPH-06 | `SpendingLimitSet` creates/updates `SpendingLimit` entity | P1 | `AUTO` | |
| T-GRAPH-07 | `SpendingLimitCancelled` removes `SpendingLimit` entity | P1 | `AUTO` | |
| T-GRAPH-08 | `GET_STUCK_PAYMENTS_QUERY` returns PENDING payments after oracle timeout | P1 | `AUTO` | Simulate no oracle response |
| T-GRAPH-09 | `GET_RECENT_ACTIVITY_QUERY` returns activity entries in descending order | P1 | `AUTO` | |
| T-GRAPH-10 | `syncService` fetches Graph updates and writes to IndexedDB | P0 | `MOCK-WALLET` | Verify IndexedDB post-sync |
| T-GRAPH-11 | Subgraph reindexes correctly after `remove-local` + `deploy-local` | P2 | `MANUAL` | Recovery scenario |

---

### T-CRYPT — Encryption and Security

| ID | Test | Priority | Automation | Notes |
|---|---|---|---|---|
| T-CRYPT-01 | `initiatePrompt` calldata contains no plaintext prompt | P0 | `AUTO` | Intercept tx, decode calldata |
| T-CRYPT-02 | `encryptedPayload` parameter in tx calldata is valid hex | P0 | `AUTO` | |
| T-CRYPT-03 | `roflEncryptedKey` in calldata is valid ECIES blob (starts with `0x01`) | P0 | `AUTO` | Version byte check |
| T-CRYPT-04 | Oracle successfully decrypts session key from `roflEncryptedKey` | P0 | `MANUAL` | No decryption error in oracle logs |
| T-CRYPT-05 | Session key derived from wallet signature is deterministic (same key on re-sign) | P0 | `MOCK-WALLET` | Sign twice, compare keys via `page.evaluate` |
| T-CRYPT-06 | Different wallet addresses produce different session keys | P0 | `AUTO` | Unit-covered, verify in E2E context |
| T-CRYPT-07 | No private keys appear in `localStorage` or `sessionStorage` | P0 | `AUTO` | Scan storage after sign-in |
| T-CRYPT-08 | No private keys appear in browser network requests | P0 | `AUTO` | Intercept all XHR/fetch |
| T-CRYPT-09 | Oracle Sentry events contain no `privateKey`, `encryptedPayload`, or `roflEncryptedKey` values | P0 | `MANUAL` | Inspect Sentry dashboard after error |
| T-CRYPT-10 | ABI `PromptSubmitted` event parameter order matches dApp expectation (answerMessageId at index 3) | P0 | `AUTO` | ABI sync test already covers this |

---

### T-SENTRY — Sentry Observability

| ID | Test | Priority | Automation | Notes |
|---|---|---|---|---|
| T-SENT-01 | Sentry session envelope fires on dApp page load | P0 | `AUTO` | Network intercept |
| T-SENT-02 | `Sentry.captureException` via `page.evaluate` produces issue in dashboard | P1 | `AUTO` | Manual dashboard check |
| T-SENT-03 | dApp error boundary (`CrashDisplay`) renders on unhandled React error | P1 | `AUTO` | Throw inside tree |
| T-SENT-04 | Error boundary `componentDidCatch` calls `Sentry.captureException` with component stack | P1 | `AUTO` | Intercept Sentry request payload |
| T-SENT-05 | Oracle logs `[Sentry] Initialized for environment: localnet` on startup | P0 | `MANUAL` | Watch Tab 2 |
| T-SENT-06 | Oracle storage failure (Irys unreachable) captured in Sentry | P1 | `MANUAL` | Inspect Sentry dashboard |
| T-SENT-07 | Sentry events tagged `environment: localnet` for both projects | P0 | `MANUAL` | Inspect dashboard filter |
| T-SENT-08 | `tracesSampleRate` effectively 100% on localnet (traces appear in Performance tab) | P1 | `MANUAL` | Sentry Performance view |
| T-SENT-09 | `beforeSend` scrubber removes sensitive keys from all Sentry events | P0 | `MANUAL` | Inspect event Extra/Contexts |

---

### T-ERR — Error Handling and Resilience

| ID | Test | Priority | Automation | Notes |
|---|---|---|---|---|
| T-ERR-01 | Transaction rejection by wallet shows toast error, not crash | P0 | `MOCK-WALLET` | Mock wallet rejection |
| T-ERR-02 | RPC error during tx shows user-friendly toast | P1 | `MOCK-WALLET` | Simulate RPC failure |
| T-ERR-03 | Expired spending limit prevents prompt submission and shows clear error | P1 | `MOCK-WALLET` | Fast-forward clock or use expired plan |
| T-ERR-04 | Insufficient ABLE balance blocks plan setup with clear message | P1 | `MOCK-WALLET` | Zero-balance account |
| T-ERR-05 | `/error` route renders `Error404` component | P2 | `AUTO` | |
| T-ERR-06 | Unknown route redirects to `/` via `Reroute` | P2 | `AUTO` | Navigate to `/nonexistent` |
| T-ERR-07 | ErrorBoundary renders `CrashDisplay` (418 screen) on unhandled error | P1 | `AUTO` | |
| T-ERR-08 | `CrashDisplay` "Go Back Home" button navigates to `/` | P1 | `AUTO` | |
| T-ERR-09 | Oracle connection loss mid-session — oracle reconnects automatically | P1 | `MANUAL` | Kill Hardhat node, restart |
| T-ERR-10 | Graph node down — dApp degrades gracefully, shows stale data | P1 | `MANUAL` | Kill docker-compose |

---

### T-UI — UI, Layout, and UX

| ID | Test | Priority | Automation | Notes |
|---|---|---|---|---|
| T-UI-01 | Sidebar renders with correct navigation items (Chat, History, Dashboard) | P1 | `AUTO` | |
| T-UI-02 | Mobile navigation bar renders on narrow viewport (< 640px) | P1 | `AUTO` | `page.setViewportSize` |
| T-UI-03 | Theme toggle switches between light and dark mode | P1 | `AUTO` | Class on `<html>` changes |
| T-UI-04 | Theme preference persists on page reload | P1 | `AUTO` | `localStorage` check |
| T-UI-05 | Sidebar collapses on mobile | P2 | `AUTO` | |
| T-UI-06 | All toast notifications disappear after their timeout | P2 | `AUTO` | |
| T-UI-07 | Scroll-to-bottom button appears in chat when scrolled up | P2 | `AUTO` | |
| T-UI-08 | Scroll-to-bottom button scrolls to latest message | P2 | `AUTO` | |
| T-UI-09 | NavUser component shows correct wallet address | P1 | `MOCK-WALLET` | |
| T-UI-10 | `MarketPulse` widget renders in sidebar | P2 | `AUTO` | |

---

### T-LEGAL — Legal Pages

| ID | Test | Priority | Automation | Notes |
|---|---|---|---|---|
| T-LEGAL-01 | `/privacy-policy` renders without errors | P2 | `AUTO` | |
| T-LEGAL-02 | `/terms-and-conditions` renders without errors | P2 | `AUTO` | |
| T-LEGAL-03 | `/website-disclaimer` renders without errors | P2 | `AUTO` | |
| T-LEGAL-04 | Privacy modal opens and closes correctly | P2 | `AUTO` | |
| T-LEGAL-05 | Terms modal opens and closes correctly | P2 | `AUTO` | |
| T-LEGAL-06 | Disclaimer modal opens and closes correctly | P2 | `AUTO` | |

---

### T-PWA — Progressive Web App

| ID | Test | Priority | Automation | Notes |
|---|---|---|---|---|
| T-PWA-01 | Web app manifest served correctly with correct `id`, `name`, `icons` | P2 | `AUTO` | |
| T-PWA-02 | Service worker registers and activates | P2 | `AUTO` | |
| T-PWA-03 | App functions in offline mode after initial load | P2 | `AUTO` | `page.setOffline(true)` after load |

---

### T-PERF — Performance Benchmarks

| ID | Test | Priority | Automation | Notes |
|---|---|---|---|---|
| T-PERF-01 | Initial page load completes in < 5s on localhost | P1 | `AUTO` | `page.waitForLoadState('networkidle')` |
| T-PERF-02 | Time from prompt submission to oracle response < 30s (with AI API available) | P1 | `MANUAL` | Timer from tx confirm to response display |
| T-PERF-03 | Conversation list with 10+ entries loads in < 2s | P2 | `AUTO` | Seed IndexedDB with mock data |
| T-PERF-04 | No memory leaks after 10 consecutive prompt/response cycles | P2 | `MANUAL` | Chrome DevTools heap snapshot |

---

## Beta readiness gate

All **P0** tests must pass before promoting to testnet. Summary of P0 tests:

| Area | P0 count |
|---|---|
| T-INIT | 3 |
| T-AUTH | 4 |
| T-PLAN | 4 |
| T-CHAT | 7 |
| T-GRAPH | 2 |
| T-CRYPT | 7 |
| T-SENTRY | 4 |
| T-ERR | 1 |
| T-HIST | 2 |
| T-DASH | 1 |
| T-REFUND | 5 |
| **Total** | **40** |

---

## Testnet-only test additions

The following must be added to this plan and executed on testnet before mainnet:

- Arweave conversation history hydration from real CIDs
- Firebase Firestore live response streaming (real-time answer display)
- Firebase Functions faucet (`requestTestTokens`) rate limiting
- PostHog user identification and event tracking
- Firebase App Check token validation
- Base Sepolia gas cost verification (actual ETH cost per prompt)
- ThirdWeb in-app wallet (email login) full flow
- Sourcemap resolution in Sentry (minified → original TypeScript lines)

---

## Notes on the mock wallet (Option A)

The Playwright `addInitScript` injects a minimal EIP-1193 provider before page load:

```js
window.ethereum = {
  isMetaMask: true,
  chainId: '0x7a69', // 31337 hex
  networkVersion: '31337',
  selectedAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  request: async ({ method, params }) => {
    if (method === 'eth_requestAccounts') return ['0x70997970...'];
    if (method === 'eth_chainId') return '0x7a69';
    if (method === 'personal_sign') return await signWithHardhatKey(params);
    if (method === 'eth_sendTransaction') return await sendTxToHardhat(params);
    // ... delegate others to a real ethers provider at http://127.0.0.1:8545
  }
};
```

The mock delegates actual transaction signing and sending to a real `ethers.Wallet` backed by Hardhat Account #1's private key against `http://127.0.0.1:8545`. This means all on-chain interactions are real — only the browser wallet modal is bypassed.
