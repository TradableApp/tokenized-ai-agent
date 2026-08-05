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

/** Every .ts file under the given roots, recursively, excluding tests and build output. */
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
      } else if (entry.name.endsWith(".ts")) {
        out.push(full);
      }
    }
  };
  for (const r of roots) if (fs.existsSync(r)) walk(r);
  return out;
}

const rel = f => path.relative(PLUGINS_ROOT, f);

describe("oracle ElizaOS plugins stay oracle-scoped", () => {
  it("registers no Telegram-coupled code", () => {
    // Comments are stripped first: this guard's own rationale, and any note explaining WHY
    // Telegram handling belongs in sense-ai-core, is documentation — not a coupling.
    const offenders = sourcesUnder(pluginDirs()).filter(f => {
      const code = fs
        .readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      return /telegram/i.test(code);
    });

    expect(
      offenders.map(rel),
      `These files reference Telegram inside the ON-CHAIN ORACLE, which has no Telegram ` +
        `service — they are leftovers from the sense-ai-core fork and cannot fire here. ` +
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
        `code that looks load-bearing. (If a plugin ever genuinely needs a module named ` +
        `plugin.ts, make it referenced — the problem is dead template code, not the filename.)`,
    ).to.deep.equal([]);
  });
});
