#!/usr/bin/env node
/**
 * Base-Sepolia post-deploy SMOKE TEST for the Brain-migrated oracle (CU-86d3dwme6).
 *
 * Exercises the exact production path — approve → activate plan → initiatePrompt →
 * wait for the on-chain answer → fetch + decrypt it — and asserts the deployed
 * oracle produced a Brain-enriched answer (`reasoning[]` + `sources[]` populated).
 * Structural assertions only (the LLM answer is non-deterministic). Doubles as a
 * re-runnable canary against the live deployment.
 *
 * Reuses the oracle's own ECIES module (src/ecies.js) so the session-key wire
 * format is guaranteed to match what the oracle decrypts with. The AES-256-GCM
 * `base64(iv).base64(ct+tag)` format mirrors the dApp's src/lib/crypto.ts.
 *
 * Discovers the answer via the on-chain `AnswerMessageAdded(convId, msgId, cid)`
 * event (msgId = answerMessageId, indexed) — NO subgraph dependency.
 *
 * Usage (env-driven; keep the private key in a gitignored env, never commit it):
 *   SMOKE_PRIVATE_KEY=0x... \
 *   SMOKE_ORACLE_PUBLIC_KEY=04... \
 *   node scripts/base-testnet-smoke.js
 *
 * Optional overrides (sensible Base-Sepolia defaults below):
 *   SMOKE_RPC_URL, SMOKE_CHAIN_ID, SMOKE_ESCROW_ADDRESS, SMOKE_AGENT_ADDRESS,
 *   SMOKE_TOKEN_ADDRESS, SMOKE_PROMPT, SMOKE_TIMEOUT_MS, SMOKE_POLL_MS,
 *   SMOKE_FETCH_TIMEOUT_MS
 *
 * Exit codes (for scheduled-canary alerting):
 *   0 = pass (oracle answered, Brain reasoning + sources present)
 *   1 = oracle broken (no/short answer, timeout, wrong network, error)
 *   2 = oracle healthy but Brain warm cache is cold (reasoning/sources empty)
 */
const crypto = require("node:crypto");
const { ethers } = require("ethers");
const { eciesEncrypt } = require("../src/ecies");
const { assessAnswer } = require("../src/answerQuality");

// ── Config ────────────────────────────────────────────────────────────────
const RPC_URL = process.env.SMOKE_RPC_URL || "https://sepolia.base.org";
const PRIVATE_KEY = process.env.SMOKE_PRIVATE_KEY;
const ORACLE_PUBLIC_KEY = process.env.SMOKE_ORACLE_PUBLIC_KEY; // uncompressed 04-prefixed
const ESCROW_ADDRESS =
  process.env.SMOKE_ESCROW_ADDRESS || "0x36ec08471F2b995024967204D7542713cFaf5Fa4";
const AGENT_ADDRESS =
  process.env.SMOKE_AGENT_ADDRESS || "0x4a0C7e5807f9174499a8F56F2C69c61b39a4c64D";
const TOKEN_ADDRESS =
  process.env.SMOKE_TOKEN_ADDRESS || "0xD77FF82e661C3838a59ea78bbF31F8c4c2BD8A80";
const PROMPT = process.env.SMOKE_PROMPT || "What is the latest news on Bitcoin?";

/**
 * The asset the answer must actually be about — the check that catches a fluent, well-sourced
 * answer on the wrong subject, which structure alone never can.
 *
 * Defaults to Bitcoin ONLY when the default prompt is in use. If someone overrides SMOKE_PROMPT
 * and we kept asserting "Bitcoin", the smoke would fail on a correct answer to the question that
 * was actually asked — and a smoke that cries wolf is one that gets muted. Override SMOKE_ASSET
 * alongside SMOKE_PROMPT to keep the check; leave it unset to skip it.
 */
// ABSENT AND EMPTY MEAN DIFFERENT THINGS, because in a compose file they are different things:
// `SMOKE_ASSET=` is an empty string in process.env, not an absent key, while `# SMOKE_ASSET=` is
// absent. An operator adding the former to switch the check off would, under a plain `||`, get
// "Bitcoin" back — the variable would look set and do nothing.
const SMOKE_ASSET =
  "SMOKE_ASSET" in process.env
    ? process.env.SMOKE_ASSET.trim() || undefined // set-but-empty = deliberately disabled
    : process.env.SMOKE_PROMPT
      ? undefined // custom prompt, no asset stated — cannot know what to assert
      : "Bitcoin"; // default prompt asks about Bitcoin
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 300_000);
const POLL_MS = Number(process.env.SMOKE_POLL_MS || 6_000);
const FETCH_TIMEOUT_MS = Number(process.env.SMOKE_FETCH_TIMEOUT_MS || 30_000);

// ── Minimal ABIs ──────────────────────────────────────────────────────────
const ESCROW_ABI = [
  "function promptFee() view returns (uint256)",
  "function spendingLimits(address) view returns (uint256 allowance, uint256 spent, uint256 expiresAt)",
  "function setSpendingLimit(uint256 allowance, uint256 expiresAt)",
  "function initiatePrompt(uint256 conversationId, bytes encryptedPayload, bytes roflEncryptedKey)",
];
const AGENT_ABI = [
  "event PromptSubmitted(address indexed user, uint256 indexed conversationId, uint256 indexed promptMessageId, uint256 answerMessageId, bytes encryptedPayload, bytes roflEncryptedKey)",
  "event AnswerMessageAdded(uint256 indexed conversationId, uint256 indexed messageId, string messageCID)",
  "function isJobFinalized(uint256 answerMessageId) view returns (bool)",
];
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

// ── Crypto (mirrors dApp src/lib/crypto.ts format) ─────────────────────────
function aesGcmEncrypt(keyBytes, obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBytes, iv);
  const ct = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(obj), "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${Buffer.concat([ct, tag]).toString("base64")}`;
}
function aesGcmDecrypt(keyBytes, str) {
  const [ivB64, dataB64] = str.split(".");
  const iv = Buffer.from(ivB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const tag = data.subarray(data.length - 16);
  const ct = data.subarray(0, data.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyBytes, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8"));
}

// ── Storage gateway (mirrors dApp syncService.getStorageProvider) ──────────
function gatewayUrl(cid) {
  // Prefix-only match: AutoDrive CIDv1 base32 length can shift with codec/hash
  // changes, so don't hard-code the char count. Irys (43-44 base64url) can't
  // collide with a bafkr6i-prefixed base32 CID, so it's still a safe guard below.
  if (/^bafkr6i/.test(cid)) return `https://gateway.autonomys.xyz/file/${cid}`; // Autonomys
  if (/^[A-Za-z0-9_-]{43,44}$/.test(cid)) return `https://gateway.irys.xyz/${cid}`; // Irys/Arweave
  if (/^bafy/.test(cid) && process.env.SMOKE_STORAGE_GATEWAY_URL)
    return `${process.env.SMOKE_STORAGE_GATEWAY_URL}${cid}`; // IPFS/localnet
  throw new Error(`Unrecognised CID format: ${cid}`);
}
async function fetchEncrypted(cid) {
  // Bound the whole fetch (headers AND body read) with an AbortSignal — the outer
  // TIMEOUT_MS only guards the event poll, so a slow/hung gateway here would
  // otherwise hang the process indefinitely. clearTimeout in finally, after
  // .text(), so the signal stays live through the body stream too.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(gatewayUrl(cid), { signal: ctrl.signal });
    if (!res.ok) throw new Error(`storage fetch ${res.status} for ${cid}`);
    const text = (await res.text()).trim();
    // Stored value is the encrypted MessageFile string (`iv.ct`). Some providers
    // wrap it in JSON — unwrap if so, and fail LOUDLY on an unexpected shape rather
    // than passing raw JSON to aesGcmDecrypt (which would throw a misleading GCM
    // auth-tag error instead of a clear storage-format error).
    if (text.startsWith("{")) {
      const j = JSON.parse(text);
      const inner = j.encryptedContent ?? j.content ?? j.data;
      if (inner == null)
        throw new Error(
          `storage file has unexpected JSON shape, keys: ${Object.keys(j).join(", ")}`,
        );
      return inner;
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

async function main() {
  if (!PRIVATE_KEY) throw new Error("SMOKE_PRIVATE_KEY is required");
  if (!ORACLE_PUBLIC_KEY)
    throw new Error(
      "SMOKE_ORACLE_PUBLIC_KEY is required (the oracle's uncompressed 04-prefixed ECIES pubkey)",
    );

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const net = await provider.getNetwork();
  log(`\n── Base-testnet oracle smoke test ──`);
  log(`chain=${net.chainId} wallet=${wallet.address}`);
  log(`escrow=${ESCROW_ADDRESS} agent=${AGENT_ADDRESS} token=${TOKEN_ADDRESS}`);
  // Guard the chain BEFORE any approve/spend — a wrong SMOKE_RPC_URL (e.g. Base
  // mainnet) would otherwise approve real tokens + burn real gas before failing.
  const EXPECTED_CHAIN_ID = BigInt(process.env.SMOKE_CHAIN_ID || 84532); // Base Sepolia
  if (net.chainId !== EXPECTED_CHAIN_ID)
    throw new Error(
      `wrong network: expected chainId ${EXPECTED_CHAIN_ID} (Base Sepolia), got ${net.chainId} — check SMOKE_RPC_URL / SMOKE_CHAIN_ID`,
    );

  const escrow = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, wallet);
  const agent = new ethers.Contract(AGENT_ADDRESS, AGENT_ABI, provider);
  const token = new ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, wallet);

  // 1. Balances + fee
  const [dec, sym, bal, ethBal, fee] = await Promise.all([
    token.decimals(),
    token.symbol(),
    token.balanceOf(wallet.address),
    provider.getBalance(wallet.address),
    escrow.promptFee(),
  ]);
  const fmt = (v) => ethers.formatUnits(v, dec);
  log(
    `balances: ${ethers.formatEther(ethBal)} ETH · ${fmt(bal)} ${sym} · promptFee=${fmt(fee)} ${sym}`,
  );
  if (bal < fee) throw new Error(`insufficient ${sym}: have ${fmt(bal)}, prompt costs ${fmt(fee)}`);
  // Gas guard: without ETH the approve/setSpendingLimit/initiatePrompt txs fail
  // with a raw INSUFFICIENT_FUNDS that looks like a contract bug. Hard-fail on
  // zero; warn (not block) on low — Base Sepolia gas is cheap/variable and the
  // test wallet is intentionally small + toppable, so don't false-block it.
  if (ethBal === 0n)
    throw new Error("no ETH for gas — fund the wallet with Base Sepolia ETH before running");
  if (ethBal < ethers.parseEther("0.001"))
    log(
      `⚠️  low ETH for gas (${ethers.formatEther(ethBal)}) — top up if a tx fails with INSUFFICIENT_FUNDS`,
    );

  // 2. Plan: approve + setSpendingLimit (headroom for a few prompts)
  const allowance = fee > 0n ? fee * 5n : ethers.parseUnits("10", dec);
  const capped = allowance > bal ? bal : allowance;
  const curAllow = await token.allowance(wallet.address, ESCROW_ADDRESS);
  if (curAllow < capped) {
    log(`approve ${fmt(capped)} ${sym} → escrow...`);
    await (await token.approve(ESCROW_ADDRESS, capped)).wait();
  }
  const plan = await escrow.spendingLimits(wallet.address);
  const now = Math.floor(Date.now() / 1000);
  const planLive = plan.allowance - plan.spent >= fee && Number(plan.expiresAt) > now;
  if (!planLive) {
    log(`setSpendingLimit(${fmt(capped)}, +1d)...`);
    await (await escrow.setSpendingLimit(capped, now + 86400)).wait();
  } else {
    log(`plan already active (allowance=${fmt(plan.allowance)}, spent=${fmt(plan.spent)})`);
  }

  // 3. Encrypt payload + session key (random one-shot session key; the oracle
  //    recovers it from roflEncryptedKey via ECIES, then encrypts the answer with it)
  const sessionKey = crypto.randomBytes(32);
  const payload = {
    promptText: PROMPT,
    isNewConversation: true,
    previousMessageId: null,
    previousMessageCID: null,
  };
  const aesString = aesGcmEncrypt(sessionKey, payload);
  const encryptedPayload = "0x" + Buffer.from(aesString, "utf8").toString("hex");
  // eciesEncrypt returns a Buffer (0x01|ephemPubKey|nonce|GCM); ethers v6 accepts
  // a Uint8Array/Buffer directly for the `bytes` param.
  const roflEncryptedKey = await eciesEncrypt(ORACLE_PUBLIC_KEY, sessionKey);

  // 4. initiatePrompt (conversationId 0 = new)
  log(`\ninitiatePrompt("${PROMPT}")...`);
  const rc = await (await escrow.initiatePrompt(0, encryptedPayload, roflEncryptedKey)).wait();
  let answerMessageId, conversationId;
  for (const lg of rc.logs) {
    try {
      const p = agent.interface.parseLog(lg);
      if (p && p.name === "PromptSubmitted") {
        answerMessageId = p.args.answerMessageId;
        conversationId = p.args.conversationId;
        break;
      }
    } catch {
      /* not an agent log */
    }
  }
  if (answerMessageId === undefined) throw new Error("PromptSubmitted not found in receipt logs");
  log(
    `submitted: conversationId=${conversationId} answerMessageId=${answerMessageId} (tx ${rc.hash})`,
  );

  // 5. Wait for the on-chain answer CID (AnswerMessageAdded, indexed by messageId)
  log(`waiting up to ${TIMEOUT_MS / 1000}s for the oracle's answer...`);
  const deadline = Date.now() + TIMEOUT_MS;
  let messageCID;
  const filter = agent.filters.AnswerMessageAdded(conversationId, answerMessageId);
  // Anchor the scan at the initiatePrompt tx block and advance it each poll. The
  // public Base Sepolia RPC caps eth_getLogs at ~2000 blocks, so a fixed
  // [head-5000, head] range would be rejected every iteration. Advancing
  // fromBlock keeps each window to ~POLL_MS/blocktime blocks (contiguous, no gap,
  // no re-scan). The answer event always lands after rc.blockNumber.
  let fromBlock = rc.blockNumber;
  while (Date.now() < deadline) {
    try {
      const head = await provider.getBlockNumber();
      if (head >= fromBlock) {
        const evts = await agent.queryFilter(filter, fromBlock, head);
        if (evts.length) {
          messageCID = evts[evts.length - 1].args.messageCID;
          break;
        }
        fromBlock = head + 1;
      }
      // Informational only — a transient failure here must not abort the poll.
      try {
        if (await agent.isJobFinalized(answerMessageId))
          log(`  job finalized; awaiting AnswerMessageAdded...`);
      } catch {
        /* ignore — status log only */
      }
    } catch (e) {
      // Load-bearing RPC calls (getBlockNumber/queryFilter): a transient blip or
      // rate-limit must not fail the run — log and retry on the next poll.
      log(`  transient RPC error (${e?.shortMessage || e?.message || e}) — retrying...`);
    }
    await sleep(POLL_MS);
  }
  if (!messageCID)
    throw new Error(
      `TIMEOUT: no AnswerMessageAdded for answerMessageId=${answerMessageId} within ${TIMEOUT_MS / 1000}s`,
    );
  log(`answer CID: ${messageCID}`);

  // 6. Fetch + decrypt the answer MessageFile
  const encryptedAnswer = await fetchEncrypted(messageCID);
  const answer = aesGcmDecrypt(sessionKey, encryptedAnswer);

  // 7. Assert Brain-enriched answer
  const reasoning = Array.isArray(answer.reasoning) ? answer.reasoning : [];
  const sources = Array.isArray(answer.sources) ? answer.sources : [];
  log(`\n── answer ──`);
  log(
    `role=${answer.role} contentLen=${(answer.content || "").length} reasoning=${reasoning.length} sources=${sources.length}`,
  );
  log(
    `content: ${(answer.content || "").slice(0, 400)}${(answer.content || "").length > 400 ? "…" : ""}`,
  );
  if (reasoning.length) log(`reasoning[0]: ${JSON.stringify(reasoning[0]).slice(0, 200)}`);
  if (sources.length)
    log(
      `sources: ${sources
        .map((s) => s.title)
        .slice(0, 5)
        .join(" · ")}`,
    );

  // Split oracle-health from cache-warmth so a scheduled canary can alert
  // differently: exit 1 = oracle broken (page), exit 2 = oracle healthy but the
  // Brain warm cache is cold (seed it — not an oracle failure), exit 0 = full pass.
  //
  // THE JUDGEMENT LIVES IN answerQuality.js, not here. This block used to assert structure only
  // — role, length, reasoning/sources non-empty — and every one of those was TRUE for both
  // recorded production failures, because the Brain populates reasoning and sources regardless
  // of what the model actually said. The smoke reported PASS on a fenced TypeScript snippet and
  // on an apology. A module can be tested against those fixtures; this script, which needs a
  // funded wallet and a live TEE, cannot.
  const { fatal, brain } = assessAnswer(answer, { asset: SMOKE_ASSET });

  if (fatal.length) {
    log(`\n❌ SMOKE FAIL (oracle broken):\n - ${fatal.join("\n - ")}`);
    process.exit(1);
  }
  if (brain.length) {
    log(
      `\n⚠️  SMOKE PARTIAL (oracle healthy, Brain cache cold — exit 2):\n - ${brain.join("\n - ")}`,
    );
    log(
      `(The social testnet body keeps the warm cache populated; seed market_news/macro rows if cold, then re-run. NOT an oracle failure.)`,
    );
    process.exit(2);
  }
  log(`\n✅ SMOKE PASS — deployed oracle answered with Brain-enriched reasoning + sources.`);
}

main().catch((e) => {
  console.error(`\n❌ SMOKE ERROR: ${e?.stack || e}`);
  process.exit(1);
});
