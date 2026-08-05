const fs = require("node:fs");
const path = require("node:path");

const { expect } = require("chai");

const { stripCommentLines } = require("./helpers/stripCommentLines");
const { PLUGINS_ROOT, pluginDirs, sourcesUnder } = require("./helpers/pluginScope");

// Oracle plugin scope guard — CU-86d3ud1va (epic CU-86d3dwme6).
//
// This oracle's plugin-senseai began as a COPY of sense-ai-core's plugin and then drifted.
// The audit (2026-08-05) found that every single thing it registers is Telegram-coupled and
// therefore inert here:
//
//   actions     showMenu, handleMenuCallback, launchApp, analyzeFinancialImage, rateLimitAction
//   providers   accessProvider      — `if (source !== "telegram") return` (does nothing here)
//               imageDetectionProvider — Telegram image-upload flow
//   services    rateLimit           — "Manages rate limits for Telegram users", in-memory Map
//   evaluators  usageTracker        — validate() requires source === "telegram"
//   init        calls bot.telegram.setMyDescription/setMyCommands on a Telegram service that
//               does not exist in the TEE
//
// Two consequences worth stating, because they are easy to get wrong later:
//
// 1. Deleting all of it is BEHAVIOUR-PRESERVING for the answer path. None of it can fire
//    without a Telegram service, so the plugin contributes nothing to the oracle today.
// 2. The oracle's analytical action (getSentimentAction) was not merely a mock — it was
//    UNREACHABLE. Its only caller was handleMenuCallback, a Telegram inline-keyboard handler.
//    So the replacement must be registered as a first-class action, not hidden behind a menu.
//
// Access control is NOT lost by removing accessProvider: the oracle is $ABLE/escrow-bounded,
// enforced on-chain by EVMAIAgentEscrow before a prompt is ever emitted. The plan doc's claim
// that accessProvider was the escrow-bounded gate is wrong — it is a Telegram quota gate.
//
// Target shape (why this guard is phrased as "stay oracle-scoped" rather than "be empty"):
// the oracle keeps ElizaOS as its harness and plugin-senseai as the thin wrapper, with
// @tradableapp/sense-ai-brain supplying the analysis. sense-ai-core is the mirror image — the
// same harness plus its Telegram and X plugins, which are its alone. Oracle-only plugins are
// expected here in future, so these guards deliberately scan EVERY plugin directory: a rule
// that only covered plugin-senseai would exempt each new plugin from the day it is created.
//
// Sequenced as two changes: this one DELETES the fork (behaviour-preserving, per note 1
// above), and the next adds the Brain-backed providers and a first-class analytical action —
// which is when the "consumes the shared Brain" assertion joins this file. It is deliberately
// absent here rather than landing knowingly-red on main.

const rel = f => path.relative(PLUGINS_ROOT, f);

/**
 * The files to scan, with the guard's own premise asserted first.
 *
 * `pluginDirs()` returns [] when PLUGINS_ROOT is absent — after a directory move, a rename, or
 * a checkout that did not materialise the tree. That cascades to `sourcesUnder([]) === []`, and
 * `expect([]).to.deep.equal([])` PASSES. The guard would report green having scanned exactly
 * zero files, which is the worst failure mode available to a regression guard: CI stays green
 * while the invariant it exists to enforce is entirely unenforced.
 *
 * Raised independently by both review bots, which is a fair signal it is not a corner case.
 * Silence is not success — if this cannot find the tree, it must say so instead of passing.
 */
function scanTargets() {
  // Root passed EXPLICITLY rather than leaning on the helper's default: the guard states which
  // tree it guards, and a probe that overrides PLUGINS_ROOT then actually exercises this code
  // path. Relying on the default silently decoupled the two during extraction.
  const dirs = pluginDirs(PLUGINS_ROOT);
  expect(
    dirs.length,
    `No plugin directories found under ${PLUGINS_ROOT}. The guard cannot run, so it must FAIL ` +
      `rather than pass having scanned nothing. Check whether the plugins tree moved or was ` +
      `renamed, and update PLUGINS_ROOT to match.`,
  ).to.be.greaterThan(0);

  const files = sourcesUnder(dirs);
  expect(
    files.length,
    `Found ${dirs.length} plugin director(ies) under ${PLUGINS_ROOT} but zero source files in ` +
      `them. Either the tree is empty (in which case there is nothing to guard and this check ` +
      `is misconfigured) or SOURCE_EXT no longer matches how plugins are written.`,
  ).to.be.greaterThan(0);

  return files;
}

describe("oracle ElizaOS plugins stay oracle-scoped", () => {
  it("registers no Telegram- or X-coupled code", () => {
    // Comment LINES are dropped first (see stripCommentLines): a note explaining WHY Telegram
    // handling belongs in sense-ai-core is documentation, not coupling. Trailing comments are
    // deliberately NOT stripped — see that function for why failing loud beats failing silent.
    // Telegram AND Twitter/X: the acceptance criterion is "no Telegram/X/social-only code", and
    // sense-ai-core carries plugin-twitter-senseai alongside plugin-telegram-senseai. Matching
    // only "telegram" would let an X-coupled fork land while the guard reported success. "X"
    // itself is not greppable, so "twitter" is the searchable handle for it — every X module in
    // core is named plugin-twitter-senseai / twitter*.
    const offenders = scanTargets().filter(f =>
      /telegram|twitter/i.test(stripCommentLines(fs.readFileSync(f, "utf8"))),
    );

    expect(
      offenders.map(rel),
      `These files reference Telegram or Twitter/X inside the ON-CHAIN ORACLE, which runs neither ` +
        `— they are leftovers from the sense-ai-core fork and cannot fire here. ` +
        `Telegram/X delivery is the Social body's job; this plugin should hold oracle glue and ` +
        `Brain-backed analysis only (CU-86d3ud1va).`,
    ).to.deep.equal([]);
  });

  it("carries no unreferenced quick-starter scaffolding", () => {
    // `src/plugin.ts` is the `elizaos create` template (config schema + sample action /
    // provider / service). Nothing imports it, and template code sitting next to real code
    // reads as load-bearing — someone eventually wires the sample up by mistake. Checked for
    // EVERY plugin, since the next oracle-only plugin will be scaffolded the same way.
    const scaffolds = pluginDirs()
      .map(d => path.join(d, "src", "plugin.ts"))
      .filter(p => fs.existsSync(p))
      .map(p => path.relative(PLUGINS_ROOT, p));

    expect(
      scaffolds,
      `Unreferenced ElizaOS quick-starter scaffolding. Delete it rather than leaving template ` +
        `code that looks load-bearing. NOTE this check is a filename sentinel, not a liveness ` +
        `check — it cannot tell whether anything imports the file. So if a plugin ever genuinely ` +
        `needs a module here, RENAME it (e.g. pluginConfig.ts); wiring up an import will not ` +
        `satisfy this guard.`,
    ).to.deep.equal([]);
  });
});
