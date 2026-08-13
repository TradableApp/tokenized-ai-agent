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

  it("reads the Brain through its own types, never `as any`", () => {
    // WHY THIS IS A PARITY RULE, not a style preference. core's providers write
    // `formatMacroEnvironment(macroState)`, `macroState.fearGreedClassification` and
    // `formatNewsTicker(latestNews)` bare, because core calls the Brain directly and gets the
    // Brain's types for free. This body goes through BrainService, so whenever that adapter
    // returns `unknown` the copied call sites need casts core does not have — and the standing
    // rule for ported files is to change only what would not work as a straight paste. A cast is
    // not that; it is an under-typed adapter leaking into the copy.
    //
    // It has already happened twice: CU-86d403h5a fixed it for the search boundary, and
    // `getLatestMacro`/`getLatestNews` were left returning `unknown` in the same style, forcing
    // three more casts.
    //
    // THE TYPE CHECKER CANNOT BE RELIED ON HERE. `bun run build` exits 0 on type errors (verified
    // — it only warns that declarations were skipped) and CI runs no `tsc --noEmit` for this
    // plugin, so re-weakening a Brain return to `unknown` and re-adding the casts would pass
    // every check. Until CI gains a typecheck step, this scan is the enforcement.
    //
    // `error as any` is exempt: narrowing an unknown catch binding is unrelated to the Brain
    // boundary, and core does the same thing.
    const offenders = [];
    for (const file of scanTargets()) {
      const src = stripCommentLines(fs.readFileSync(file, "utf8"));
      for (const line of src.split("\n")) {
        if (!/\bas any\b/.test(line)) continue;
        if (/\berror as any\b|\berr as any\b/.test(line)) continue;
        offenders.push(`${rel(file)}: ${line.trim()}`);
      }
    }

    expect(
      offenders,
      `These cast a Brain read with \`as any\`. core writes the same call sites bare, so the cast ` +
        `is an under-typed BrainService leaking into a ported file rather than anything the ` +
        `oracle requires. Type the method in services/brain.ts with the Brain's own exported ` +
        `type (EnrichedNewsRow, GlobalMacroData, AssetSentimentMetrics, NewsSearchHit) instead.`,
    ).to.deep.equal([]);
  });

  it("consumes the shared Brain", () => {
    // Held back from the deletion PR on purpose — it would have landed knowingly-red on main,
    // since that change removed the fork without yet adding the replacement. It joins the file
    // now that the plugin imports @tradableapp/sense-ai-brain for real.
    //
    // This is the positive half of the architecture the other assertions police negatively:
    // "no Telegram/X code" only says what the oracle is NOT. Without this, a plugin that had
    // been gutted and never rewired would pass every other check while doing nothing at all —
    // which was exactly the state main was in between the two PRs.
    // Must match an actual IMPORT, not a mention. A bare /@tradableapp\/sense-ai-brain/ was
    // satisfied by index.ts's own `description` string, which name-drops the package — so the
    // guard passed with every real import stripped out. Caught by mutation-testing it, and it
    // is the exact failure it exists to prevent: a plugin advertising the Brain in prose while
    // importing nothing.
    //
    // Comment lines are dropped first for the same reason: this file's own rationale, and the
    // notes in types/shared-schema.d.ts explaining the packaging, are documentation.
    const BRAIN_IMPORT = /(?:from|import|require)\s*\(?\s*["']@tradableapp\/sense-ai-brain["']/;
    const importers = scanTargets().filter(f =>
      BRAIN_IMPORT.test(stripCommentLines(fs.readFileSync(f, "utf8"))),
    );

    expect(
      importers.map(rel),
      `No file in the oracle's plugins imports @tradableapp/sense-ai-brain. The oracle is meant ` +
        `to leverage the shared Brain exactly as sense-ai-core does — analysis lives in the ` +
        `Brain so BOTH bodies get it. Without that import the plugin is either dead weight or a ` +
        `second implementation, which is the fork this task exists to end (CU-86d3ud1va).`,
    ).to.not.be.empty;
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
