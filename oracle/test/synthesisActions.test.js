const fs = require("node:fs");
const path = require("node:path");

const { expect } = require("chai");

const { SYNTHESIS_ACTION_NAMES } = require("../src/answerSelection");

// Synthesis-attribution guard — CU-86d3z0r81.
//
// THE GAP THIS CLOSES. `selectAnswer` prefers an emission tagged with one of our synthesis
// actions over a later third-party one, and the tag is a STRING matched across a module
// boundary that no compiler spans: `answerSelection.js` is CommonJS on the host, the actions are
// TypeScript inside an ESM plugin bundle. `"GET_NEWS_DETAILS"` is written in three places —
// the action's `name`, the `actionName` it returns in `data`, and the set here — and nothing
// links them.
//
// Rename any one of them and every test still passes, because the tests hardcode the same
// string. What changes is production: attribution stops matching, "last substantive prose"
// takes over, and plugin-mcp's summary silently replaces our synthesis on a paid answer. That
// is the ORIGINAL DEFECT, restored, presenting identically.
//
// WHY A SOURCE SCAN RATHER THAN AN IMPORT. The obvious fix is to export the names from the
// plugin barrel and import them here. It would work, and it was the review's suggestion, but it
// would make the host's answer-selection module depend on the built plugin bundle — pulling
// ElizaOS, the Brain and their transitive deps into the one module on the answer path that is
// currently a pure function with a two-line require. The scan buys the same protection against
// a rename at none of that cost.
//
// BOTH DIRECTIONS ARE CHECKED, and the second is the one that matters more:
//   forward  — every name in the set is emitted by some action  (catches a rename, and catches
//              a speculative entry for an action that does not exist)
//   backward — every action that calls handleChainSynthesis has its name in the set  (catches
//              the porting PR that adds an action and forgets the set, which is how the next
//              analytical action would silently lose its attribution)

const PLUGIN_SRC = path.resolve(
  __dirname,
  "../src/elizaos/plugins/plugin-senseai/src",
);
const ACTIONS_DIR = path.join(PLUGIN_SRC, "actions");

/** `actionName: "FOO"` — how handleChainSynthesis learns what to tag the callback with. */
const ACTION_NAME_RE = /actionName:\s*"([A-Z0-9_]+)"/g;

/**
 * A scan that finds nothing proves nothing. If the actions directory is ever moved or renamed,
 * both assertions below would pass vacuously and the guard would report success while protecting
 * exactly zero call sites.
 *
 * The MISSING-DIRECTORY case is checked before `readdirSync` rather than after, because
 * `readdirSync` throws `ENOENT` synchronously — so a guard placed after it never runs in the one
 * situation it was written for, and the suite reports a raw scandir error instead of the reason.
 */
function actionFiles() {
  expect(
    fs.existsSync(ACTIONS_DIR),
    `${ACTIONS_DIR} does not exist. The plugin layout changed or this guard is pointed at the ` +
      `wrong directory — it cannot protect anything from here, and must not pass by finding ` +
      `nothing.`,
  ).to.equal(true);

  const files = fs
    .readdirSync(ACTIONS_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .map((f) => path.join(ACTIONS_DIR, f));

  expect(
    files.length,
    `No action sources found under ${ACTIONS_DIR}. The directory exists but holds no .ts files, ` +
      `so this guard is protecting zero call sites — it cannot pass by finding nothing.`,
  ).to.be.greaterThan(0);

  return files;
}

/** Every distinct `actionName` emitted by an action that runs the synthesis helper. */
function emittedSynthesisNames() {
  const names = new Map(); // name -> file it came from

  for (const file of actionFiles()) {
    const src = fs.readFileSync(file, "utf8");
    // Only actions that actually synthesise are in scope. An action that returns an
    // ActionResult without calling the helper never reaches selectAnswer's attribution path.
    if (!src.includes("handleChainSynthesis")) continue;

    const found = [...src.matchAll(ACTION_NAME_RE)].map(([, name]) => name);

    // THE VACUUM CHECK, and the reason this guard is not merely a regex.
    //
    // ACTION_NAME_RE only matches an INLINE literal — `actionName: "FOO"`. An action that
    // hoisted its name into a constant (`actionName: ACTION_NAME`) would yield no match, and the
    // backward assertion below would then pass on an empty `unlisted` while attribution was
    // silently broken in production. A guard that reports success by seeing nothing is worse
    // than no guard.
    //
    // So a file that synthesises but exposes no inline name is a FAILURE, not a skip. That turns
    // the regex's one blind spot from silent into loud, which a comment asking the next author to
    // remember the convention could never do.
    expect(
      found.length,
      `${path.basename(file)} calls handleChainSynthesis but no inline \`actionName: "NAME"\` ` +
        `was found in it. This guard can only read inline string literals, so a hoisted constant ` +
        `would make it pass by finding nothing while attribution silently broke. Either inline ` +
        `the name, or widen ACTION_NAME_RE here — do not leave it unmatched.`,
    ).to.be.greaterThan(0);

    for (const name of found) {
      names.set(name, path.basename(file));
    }
  }

  return names;
}

describe("synthesis attribution stays wired", () => {
  it("every name in SYNTHESIS_ACTIONS is emitted by a registered action", () => {
    const emitted = emittedSynthesisNames();
    const unbacked = SYNTHESIS_ACTION_NAMES.filter((name) => !emitted.has(name));

    expect(
      unbacked,
      `These names are in SYNTHESIS_ACTION_NAMES but no action emits them as ` +
        `\`actionName\`, so they can never match. Either the action was renamed — in which case ` +
        `attribution is now OFF and plugin-mcp's prose will silently win on a paid answer — or ` +
        `the entry is speculative and belongs in the PR that ports the action. ` +
        `Emitted today: ${JSON.stringify([...emitted.keys()])}`,
    ).to.deep.equal([]);
  });

  it("every synthesising action has its name in SYNTHESIS_ACTIONS", () => {
    // The direction that catches the NEXT port. An action that calls handleChainSynthesis is
    // producing our final prose by definition; if its name is missing here, its answer competes
    // on recency alone and loses to any third-party emission the model happens to order later.
    const emitted = emittedSynthesisNames();
    const unlisted = [...emitted.entries()].filter(([name]) => !SYNTHESIS_ACTION_NAMES.includes(name));

    expect(
      unlisted.map(([name, file]) => `${name} (${file})`),
      `These actions run handleChainSynthesis — so their emission IS the answer — but are not ` +
        `listed in SYNTHESIS_ACTIONS in src/answerSelection.js. Their synthesis will lose to a ` +
        `later third-party emission, which is the defect CU-86d3z0r81 exists to fix. Add the ` +
        `name in the same commit as the action.`,
    ).to.deep.equal([]);
  });
});
