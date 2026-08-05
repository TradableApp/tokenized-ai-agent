const fs = require("node:fs");
const path = require("node:path");

const { expect } = require("chai");

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

// Scoped to the whole plugins tree, not just plugin-senseai. The oracle is expected to grow
// ORACLE-ONLY plugins alongside it (the harness stays ElizaOS; the Brain supplies the
// analysis), and a guard aimed at one directory would leave every future plugin exempt from
// the rule it exists to enforce.
const PLUGINS_ROOT = path.resolve(__dirname, "../src/elizaos/plugins");

/** Every plugin directory under the plugins root. */
function pluginDirs() {
  if (!fs.existsSync(PLUGINS_ROOT)) return [];
  return fs
    .readdirSync(PLUGINS_ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => path.join(PLUGINS_ROOT, e.name));
}

// The tree is TypeScript today, but the guard promises to cover "every plugin directory", and
// a plugin shipping a plain .js helper (or a committed compiled file) must not be invisible to
// it. Cheaper to widen the net now than to discover the hole via a regression.
const SOURCE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/** Every source file under the given roots, recursively, excluding tests and build output. */
function sourcesUnder(roots) {
  const out = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "dist" || entry.name === "node_modules") {
          continue;
        }
        walk(full);
      } else if (SOURCE_EXT.some(ext => entry.name.endsWith(ext))) {
        out.push(full);
      }
    }
  };
  for (const r of roots) if (fs.existsSync(r)) walk(r);
  return out;
}

/**
 * Drops comment LINES, never parts of a line.
 *
 * Stripping is necessary — index.ts legitimately documents why Telegram belongs in
 * sense-ai-core, and that prose must not read as coupling. But the obvious approach, a regex
 * that cuts from `//` to end-of-line, can cut inside a string literal:
 *
 *     const s = "a // b"; runtime.getService("telegram");
 *
 * and would silently swallow the real reference after it — a FALSE NEGATIVE in the exact guard
 * meant to stop Telegram creeping back. (An earlier version guarded `[^:]` so `https://` was
 * safe; that covers URLs, not arbitrary strings.)
 *
 * Working line-at-a-time removes the failure mode rather than narrowing it: a trailing comment
 * like `const x = 1; // telegram` now TRIPS the guard instead of hiding something. That is a
 * false positive — loud, immediately understood, and fixed by moving the note to its own line.
 * A silent miss is the one outcome a regression guard must never have.
 */
function stripCommentLines(src) {
  let inBlock = false;
  return src
    .split("\n")
    .filter(line => {
      const t = line.trim();
      if (inBlock) {
        if (t.includes("*/")) inBlock = false;
        return false;
      }
      if (t.startsWith("/*")) {
        if (!t.includes("*/")) inBlock = true;
        return false;
      }
      return !t.startsWith("//") && !t.startsWith("*");
    })
    .join("\n");
}

const rel = f => path.relative(PLUGINS_ROOT, f);

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
    const offenders = sourcesUnder(pluginDirs()).filter(f =>
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
