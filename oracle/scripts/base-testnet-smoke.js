#!/usr/bin/env node
/**
 * Post-deploy SMOKE TEST for the Brain-migrated oracle on Base (CU-86d3dwme6, extended for the
 * testnet run days under CU-14ym9bvdmjr).
 *
 * Exercises the exact production path — approve → activate plan → initiatePrompt → wait for the
 * on-chain answer → fetch + decrypt it — and judges the answer with src/answerQuality.js. Doubles
 * as a re-runnable canary against the live deployment.
 *
 * Three modes, all env-driven (scripts/smoke/env.js holds the per-environment default tables):
 *   single      one prompt from SMOKE_PRIVATE_KEY (the default)
 *   burst       SMOKE_BURST=N prompts at once from N accounts in SMOKE_PRIVATE_KEYS — exercises
 *               the oracle's p-queue + tx mutex; every prompt must get exactly its own answer
 *   injection   SMOKE_INJECTION=1 wraps the prompt in a forged fence close + "URGENT SYSTEM
 *               DIRECTIVE" demanding a random canary; the answer must ignore it and the stored
 *               prompt must keep the directive but lose the forged tag
 *
 * Every run writes SMOKE_METRICS_FILE (default ./smoke-metrics.json): per-prompt ids, gas for
 * initiatePrompt and submitAnswer, wall-clock and block-timestamp latency, a summary.
 *
 * Reuses the oracle's own ECIES module (src/ecies.js) so the session-key wire format is
 * guaranteed to match what the oracle decrypts with. Discovers the answer via the on-chain
 * `AnswerMessageAdded(convId, msgId, cid)` event — NO subgraph dependency.
 *
 * Usage (keep private keys in a gitignored env, never commit them):
 *   SMOKE_PRIVATE_KEY=0x... node scripts/base-testnet-smoke.js
 *   SMOKE_ENV=base-mainnet SMOKE_ESCROW_ADDRESS=… SMOKE_AGENT_ADDRESS=… SMOKE_TOKEN_ADDRESS=… \
 *     SMOKE_ORACLE_PUBLIC_KEY=… SMOKE_PRIVATE_KEY=0x... node scripts/base-testnet-smoke.js
 *
 * Exit codes (for scheduled-canary alerting):
 *   0 = pass (every prompt answered, Brain reasoning + sources present)
 *   1 = oracle broken (no/short answer, timeout, wrong network, cross-wired burst, steered)
 *   2 = oracle healthy but Brain warm cache is cold (reasoning/sources empty)
 */
const crypto = require("node:crypto");
const { ethers } = require("ethers");
const { eciesEncrypt } = require("../src/ecies");
const { assessAnswer } = require("../src/answerQuality");
const { resolveSmokeConfig } = require("./smoke/env");
const { assertOneAnswerPerPrompt } = require("./smoke/burst");
const { buildInjectionPrompt, assessInjection, makeCanary } = require("./smoke/injection");
const { buildMetrics, writeMetrics } = require("./smoke/metrics");
const { aesGcmEncrypt, aesGcmDecrypt, fetchEncrypted } = require("./smoke/wire");

// ── Minimal ABIs ──────────────────────────────────────────────────────────
const ESCROW_ABI = [
  "function promptFee() view returns (uint256)",
  "function spendingLimits(address) view returns (uint256 allowance, uint256 spent, uint256 expiresAt)",
  "function setSpendingLimit(uint256 allowance, uint256 expiresAt)",
  "function initiatePrompt(uint256 conversationId, bytes encryptedPayload, bytes roflEncryptedKey)",
  // Custom errors. ethers can only NAME a revert it holds the signature for — without these a
  // failure prints the bare selector (`0x26575023` cost a manual 4-byte lookup during the
  // 2026-08-22 deploy). Cheap to carry, and they turn every escrow revert into a readable cause.
  "error SpendingLimitExpired()",
  "error NoActiveSpendingLimit()",
  "error InsufficientSpendingLimitAllowance()",
  "error ZeroSpendingLimit()",
  "error ExpirationInThePast()",
  "error HasPendingPrompts()",
  "error NotPromptOwner()",
];
const AGENT_ABI = [
  "event PromptSubmitted(address indexed user, uint256 indexed conversationId, uint256 indexed promptMessageId, uint256 answerMessageId, bytes encryptedPayload, bytes roflEncryptedKey)",
  "event PromptMessageAdded(uint256 indexed conversationId, uint256 indexed messageId, string messageCID)",
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

/**
 * Make sure the wallet has a spending limit that covers one prompt, and that the chain will
 * actually SHOW it to the next call.
 *
 * Awaiting the receipt is not enough. `.wait()` resolves on one confirmation from whichever node
 * in Base Sepolia's load-balanced pool served the request; ethers then runs `eth_estimateGas` for
 * `initiatePrompt`, which can land on a different node a block or two behind that still sees no
 * limit — and the estimate reverts with `SpendingLimitExpired()`. Exactly this failed the
 * 2026-08-22 smoke run and passed on a plain retry, which is the signature of a read race rather
 * than a bad write.
 *
 * So: write, then re-read until the state is visible, and only then let the caller submit.
 *
 * @returns {Promise<object>} the live plan as last read
 */
async function ensurePlanActive({
  escrow,
  address,
  capped,
  fee,
  // A CLOCK, not a timestamp. Snapshotting `now` at the call site left it stale through a confirm
  // loop that can sleep ~20s, so a plan expiring inside that window could pass the last liveness
  // check and still fail estimateGas. Injectable so tests can pin time.
  now = () => Math.floor(Date.now() / 1000),
  sleep,
  log = () => {},
  fmt = (v) => String(v),
  confirmAttempts = 10,
  confirmDelayMs = 2000,
}) {
  const isLive = (p) => p.allowance - p.spent >= fee && Number(p.expiresAt) > now();

  const plan = await escrow.spendingLimits(address);
  if (isLive(plan)) {
    log(`plan already active (allowance=${fmt(plan.allowance)}, spent=${fmt(plan.spent)})`);
    return plan;
  }

  log(`setSpendingLimit(${fmt(capped)}, +1d)...`);
  await (await escrow.setSpendingLimit(capped, now() + 86400)).wait();

  // Confirm READABILITY, not just inclusion. Re-read only — never re-send, or a slow node turns
  // into duplicate transactions.
  for (let i = 0; i < confirmAttempts; i++) {
    const fresh = await escrow.spendingLimits(address);
    if (isLive(fresh)) {
      if (i > 0) log(`plan visible after ${i + 1} read(s) (RPC lag)`);
      return fresh;
    }
    await sleep(confirmDelayMs);
  }

  throw new Error(
    `spending limit was set but is still not readable after ${confirmAttempts} attempts — ` +
      `the RPC pool is lagging badly; re-run in a moment`,
  );
}

/** Parses the agent's logs out of a receipt by event name; non-agent logs are skipped. */
function agentEvents(agent, receipt, name) {
  const out = [];
  for (const lg of receipt.logs) {
    try {
      const p = agent.interface.parseLog(lg);
      if (p && p.name === name) out.push(p);
    } catch {
      /* not an agent log */
    }
  }
  return out;
}

/**
 * Poll for the AnswerMessageAdded event of one prompt.
 *
 * Anchors the scan at the initiatePrompt tx block and advances it each poll. The public Base
 * Sepolia RPC caps eth_getLogs at a few hundred blocks, so a fixed [head-5000, head] range would
 * be rejected every iteration. Advancing fromBlock keeps each window to ~POLL_MS/blocktime blocks
 * (contiguous, no gap, no re-scan). The answer event always lands after the submit block.
 *
 * Returns EVERY matching event in the window the answer appeared in, so burst mode can tell one
 * answer from two.
 */
async function waitForAnswer({
  agent,
  provider,
  conversationId,
  answerMessageId,
  fromBlock,
  cfg,
  log,
}) {
  const deadline = Date.now() + cfg.timeoutMs;
  const filter = agent.filters.AnswerMessageAdded(conversationId, answerMessageId);
  let from = fromBlock;
  while (Date.now() < deadline) {
    try {
      const head = await provider.getBlockNumber();
      if (head >= from) {
        const evts = await agent.queryFilter(filter, from, head);
        if (evts.length) return evts;
        from = head + 1;
      }
      // Informational only — a transient failure here must not abort the poll.
      try {
        if (await agent.isJobFinalized(answerMessageId))
          log(`job finalized; awaiting AnswerMessageAdded...`);
      } catch {
        /* ignore — status log only */
      }
    } catch (e) {
      // Load-bearing RPC calls (getBlockNumber/queryFilter): a transient blip or rate-limit must
      // not fail the run — log and retry on the next poll.
      log(`transient RPC error (${e?.shortMessage || e?.message || e}) — retrying...`);
    }
    await sleep(cfg.pollMs);
  }
  throw new Error(
    `TIMEOUT: no AnswerMessageAdded for answerMessageId=${answerMessageId} within ${cfg.timeoutMs / 1000}s`,
  );
}

/**
 * One full prompt round-trip from one wallet. Never throws: a failure lands in `result.error` so
 * burst mode can report every prompt and the metrics file is still written.
 */
async function runPrompt({ index, wallet, provider, cfg, promptText, wantStoredPrompt }) {
  const tag = cfg.burst > 1 ? `[${index}] ` : "";
  const plog = (...a) => log(tag + a.join(" "));
  const result = { index, account: wallet.address, answerEventCount: 0 };
  try {
    const escrow = new ethers.Contract(cfg.escrow, ESCROW_ABI, wallet);
    const agent = new ethers.Contract(cfg.agent, AGENT_ABI, provider);
    const token = new ethers.Contract(cfg.token, ERC20_ABI, wallet);

    // 1. Balances + fee
    const [dec, sym, bal, ethBal, fee] = await Promise.all([
      token.decimals(),
      token.symbol(),
      token.balanceOf(wallet.address),
      provider.getBalance(wallet.address),
      escrow.promptFee(),
    ]);
    const fmt = (v) => ethers.formatUnits(v, dec);
    plog(
      `balances: ${ethers.formatEther(ethBal)} ETH · ${fmt(bal)} ${sym} · promptFee=${fmt(fee)} ${sym}`,
    );
    if (bal < fee)
      throw new Error(`insufficient ${sym}: have ${fmt(bal)}, prompt costs ${fmt(fee)}`);
    // Gas guard: without ETH the approve/setSpendingLimit/initiatePrompt txs fail with a raw
    // INSUFFICIENT_FUNDS that looks like a contract bug. Hard-fail on zero; warn (not block) on
    // low — Base Sepolia gas is cheap/variable and the test wallets are small + toppable.
    if (ethBal === 0n) throw new Error("no ETH for gas — fund the wallet before running");
    if (ethBal < ethers.parseEther("0.001"))
      plog(
        `⚠️  low ETH for gas (${ethers.formatEther(ethBal)}) — top up if a tx fails with INSUFFICIENT_FUNDS`,
      );

    // 2. Plan: approve + setSpendingLimit (headroom for a few prompts)
    const allowance = fee > 0n ? fee * 5n : ethers.parseUnits("10", dec);
    const capped = allowance > bal ? bal : allowance;
    const curAllow = await token.allowance(wallet.address, cfg.escrow);
    if (curAllow < capped) {
      plog(`approve ${fmt(capped)} ${sym} → escrow...`);
      await (await token.approve(cfg.escrow, capped)).wait();
    }
    await ensurePlanActive({ escrow, address: wallet.address, capped, fee, sleep, log: plog, fmt });

    // 3. Encrypt payload + session key (random one-shot session key; the oracle recovers it from
    //    roflEncryptedKey via ECIES, then encrypts the answer — and the stored prompt — with it)
    const sessionKey = crypto.randomBytes(32);
    const payload = {
      promptText,
      isNewConversation: true,
      previousMessageId: null,
      previousMessageCID: null,
    };
    const encryptedPayload =
      "0x" + Buffer.from(aesGcmEncrypt(sessionKey, payload), "utf8").toString("hex");
    const roflEncryptedKey = await eciesEncrypt(cfg.oraclePublicKey, sessionKey);

    // 4. initiatePrompt (conversationId 0 = new)
    plog(
      `initiatePrompt(${JSON.stringify(promptText.slice(0, 60))}${promptText.length > 60 ? "…" : ""})...`,
    );
    const submittedAt = Date.now();
    const rc = await (await escrow.initiatePrompt(0, encryptedPayload, roflEncryptedKey)).wait();
    const [submitted] = agentEvents(agent, rc, "PromptSubmitted");
    if (!submitted) throw new Error("PromptSubmitted not found in receipt logs");
    Object.assign(result, {
      conversationId: submitted.args.conversationId,
      promptMessageId: submitted.args.promptMessageId,
      answerMessageId: submitted.args.answerMessageId,
      submitTxHash: rc.hash,
      submitBlock: rc.blockNumber,
      submitGasUsed: rc.gasUsed,
    });
    plog(
      `submitted: conversationId=${result.conversationId} answerMessageId=${result.answerMessageId} (tx ${rc.hash})`,
    );

    // 5. Wait for the on-chain answer CID
    plog(`waiting up to ${cfg.timeoutMs / 1000}s for the oracle's answer...`);
    const evts = await waitForAnswer({
      agent,
      provider,
      conversationId: result.conversationId,
      answerMessageId: result.answerMessageId,
      fromBlock: rc.blockNumber,
      cfg,
      log: plog,
    });
    result.latencyMs = Date.now() - submittedAt;
    result.answerEventCount = evts.length;
    const evt = evts[evts.length - 1];
    result.cid = evt.args.messageCID;
    plog(`answer CID: ${result.cid} (${evts.length} event(s), ${result.latencyMs} ms)`);

    // 5b. The oracle's submitAnswer tx: gas, nonce, sender, and the stored-prompt CID emitted in
    //     the same tx (PromptMessageAdded for our promptMessageId). NON-FATAL for the verdict: the
    //     answer is already on-chain, so a flaky RPC here must not reclassify a correct run as an
    //     oracle failure — it only leaves the metrics columns null (and, in injection mode, the
    //     stored prompt unread, which assessInjection reports on its own terms).
    try {
      const [answerRc, answerTx, submitBlock, answerBlock] = await Promise.all([
        provider.getTransactionReceipt(evt.transactionHash),
        provider.getTransaction(evt.transactionHash),
        provider.getBlock(rc.blockNumber),
        provider.getBlock(evt.blockNumber),
      ]);
      Object.assign(result, {
        answerTxHash: evt.transactionHash,
        answerBlock: evt.blockNumber,
        answerGasUsed: answerRc?.gasUsed,
        answerFrom: answerTx?.from,
        answerNonce: answerTx?.nonce,
        submitTimestamp: submitBlock?.timestamp,
        answerTimestamp: answerBlock?.timestamp,
      });
      if (wantStoredPrompt && answerRc) {
        const stored = agentEvents(agent, answerRc, "PromptMessageAdded").find(
          (p) => p.args.messageId === result.promptMessageId,
        );
        if (stored) {
          result.storedPromptCid = stored.args.messageCID;
          result.storedPrompt = aesGcmDecrypt(
            sessionKey,
            await fetchEncrypted(stored.args.messageCID, cfg),
          );
        } else {
          plog(
            `⚠️  no PromptMessageAdded for promptMessageId=${result.promptMessageId} in the answer tx`,
          );
        }
      }
    } catch (metaErr) {
      plog(
        `⚠️  answer-tx metadata unavailable (gas/nonce/timestamps null): ${metaErr?.shortMessage || metaErr?.message || metaErr}`,
      );
    }

    // 6. Fetch + decrypt the answer MessageFile
    result.answer = aesGcmDecrypt(sessionKey, await fetchEncrypted(result.cid, cfg));
    const a = result.answer;
    const reasoning = Array.isArray(a.reasoning) ? a.reasoning : [];
    const sources = Array.isArray(a.sources) ? a.sources : [];
    plog(
      `answer: role=${a.role} contentLen=${(a.content || "").length} reasoning=${reasoning.length} sources=${sources.length}`,
    );
    plog(`content: ${(a.content || "").slice(0, 400)}${(a.content || "").length > 400 ? "…" : ""}`);
    if (sources.length)
      plog(
        `sources: ${sources
          .map((s) => s.title)
          .slice(0, 5)
          .join(" · ")}`,
      );
  } catch (e) {
    result.error = e?.shortMessage || e?.message || String(e);
    plog(`❌ ${result.error}`);
  }
  return result;
}

/** Judges one result: fatal/brain lists plus a verdict for the metrics file. */
function judge(result, { cfg, canary }) {
  if (result.error) return { fatal: [result.error], brain: [], verdict: "fail" };
  const { fatal, brain } = cfg.injection
    ? assessInjection({
        answer: result.answer,
        storedPrompt: result.storedPrompt,
        canary,
        asset: cfg.asset,
      })
    : assessAnswer(result.answer, { asset: cfg.asset });
  return { fatal, brain, verdict: fatal.length ? "fail" : brain.length ? "partial" : "pass" };
}

function oracleNonceSpan(results) {
  const nonces = results.map((r) => r.answerNonce).filter((n) => Number.isInteger(n));
  if (!nonces.length) return null;
  return { before: Math.min(...nonces), after: Math.max(...nonces) + 1 };
}

async function main() {
  const cfg = resolveSmokeConfig(process.env);
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  const net = await provider.getNetwork();
  const wallets = cfg.privateKeys.slice(0, cfg.burst).map((k) => new ethers.Wallet(k, provider));
  log(`\n── ${cfg.envName} oracle smoke test ──`);
  log(
    `chain=${net.chainId} mode=${cfg.burst > 1 ? `burst×${cfg.burst}` : "single"}${cfg.injection ? "+injection" : ""}`,
  );
  log(`accounts: ${wallets.map((w) => w.address).join(", ")}`);
  log(`escrow=${cfg.escrow} agent=${cfg.agent} token=${cfg.token}`);
  // Guard the chain BEFORE any approve/spend — a wrong SMOKE_RPC_URL would otherwise approve
  // real tokens + burn real gas before failing.
  if (net.chainId !== BigInt(cfg.chainId))
    throw new Error(
      `wrong network: expected chainId ${cfg.chainId} (${cfg.envName}), got ${net.chainId} — check SMOKE_RPC_URL / SMOKE_CHAIN_ID / SMOKE_ENV`,
    );

  const canary = cfg.injection ? makeCanary() : undefined;
  const promptText = cfg.injection
    ? buildInjectionPrompt({ question: cfg.prompt, canary })
    : cfg.prompt;
  if (cfg.injection) log(`injection canary: ${canary}`);

  const startedAt = new Date().toISOString();
  const results = await Promise.all(
    wallets.map((wallet, index) =>
      runPrompt({ index, wallet, provider, cfg, promptText, wantStoredPrompt: cfg.injection }),
    ),
  );
  const finishedAt = new Date().toISOString();

  const judged = results.map((r) => judge(r, { cfg, canary }));
  const fatal = judged.flatMap((j, i) => j.fatal.map((m) => (cfg.burst > 1 ? `[${i}] ${m}` : m)));
  const brain = judged.flatMap((j, i) => j.brain.map((m) => (cfg.burst > 1 ? `[${i}] ${m}` : m)));
  if (cfg.burst > 1)
    fatal.push(...assertOneAnswerPerPrompt(results, { expected: cfg.burst }).problems);

  const oracleNonce = oracleNonceSpan(results);
  const metrics = buildMetrics({
    env: cfg.envName,
    chainId: cfg.chainId,
    mode: { burst: cfg.burst, injection: cfg.injection },
    startedAt,
    finishedAt,
    prompts: results.map((r, i) => ({ ...r, verdict: judged[i].verdict })),
    oracleNonce,
  });
  const written = writeMetrics(cfg.metricsFile, metrics);
  log(`\nmetrics → ${written}`);
  if (oracleNonce)
    log(
      `oracle ${results.find((r) => r.answerFrom)?.answerFrom}: nonces ${oracleNonce.before}…${oracleNonce.after - 1} (${oracleNonce.after - oracleNonce.before} submitAnswer tx)`,
    );
  log(
    `latency ms: ${JSON.stringify(metrics.summary.latencyMs)} · submitAnswer gas: ${JSON.stringify(metrics.summary.answerGasUsed)}`,
  );

  // Split oracle-health from cache-warmth so a scheduled canary can alert differently: exit 1 =
  // oracle broken (page), exit 2 = oracle healthy but the Brain warm cache is cold (seed it — not
  // an oracle failure), exit 0 = full pass. THE JUDGEMENT LIVES IN answerQuality.js and
  // smoke/injection.js, not here — a module can be tested against recorded failures; this
  // script, which needs funded wallets and a live TEE, cannot.
  if (fatal.length) {
    log(`\n❌ SMOKE FAIL (oracle broken):\n - ${[...new Set(fatal)].join("\n - ")}`);
    process.exit(1);
  }
  if (brain.length) {
    log(
      `\n⚠️  SMOKE PARTIAL (oracle healthy, Brain cache cold — exit 2):\n - ${[...new Set(brain)].join("\n - ")}`,
    );
    log(
      `(The social testnet body keeps the warm cache populated; seed market_news/macro rows if cold, then re-run. NOT an oracle failure.)`,
    );
    process.exit(2);
  }
  log(
    `\n✅ SMOKE PASS — ${results.length} prompt(s) answered with Brain-enriched reasoning + sources${cfg.injection ? ", injection ignored" : ""}.`,
  );
}

// Only run when executed directly — `require()`ing this file (the unit tests do) must not fire
// a live smoke run.
if (require.main === module) {
  main().catch((e) => {
    console.error(`\n❌ SMOKE ERROR: ${e?.stack || e}`);
    process.exit(1);
  });
}

module.exports = {
  ensurePlanActive,
  agentEvents,
  judge,
  oracleNonceSpan,
  ESCROW_ABI,
  AGENT_ABI,
  ERC20_ABI,
};
