const { expect } = require("chai");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const { stripCommentLines } = require("./helpers/stripCommentLines");

/**
 * The strip has to be WIRED, and `inboundPrompt.test.js` cannot tell whether it is.
 *
 * That test proves the function works. Deleting the one call site would leave it green, the oracle
 * serving prompts unstripped, and nothing in the suite objecting — a module that is correct and
 * unreachable. So the invariant is stated about the SOURCE, the same way the social surfaces' ingestion
 * boundaries are.
 *
 * A text scan rather than an execution test on purpose. Exercising `handlePrompt` end-to-end means
 * standing up decryption, storage, ethers and ElizaOS, and a stub thin enough to be practical would
 * pass against code that cannot run. What has to hold here is structural: every prompt that enters
 * goes through the strip, and startup resolved it before any of them could.
 */
const SRC = join(__dirname, "..", "src");
const ORACLE = readFileSync(join(SRC, "aiAgentOracle.js"), "utf8");

// The comment stripper is the repo's, not a second one written here.
//
// A stripper local to this file cut each line at the first `//`, which also cut `"https://…"` down to
// `"https:` — the very fault `stripCommentLines` was extracted and unit-tested for after it
// shipped three times. Writing a second stripper meant a second place for the fourth one to
// happen, so this scan uses the shared helper and inherits its cases.
//
// Its contract is LINE-based: comment-only lines go, a trailing comment stays and reads as code.
// That is a loud false positive rather than a silent false negative, and it costs this file
// nothing — every assertion below is about a call shape that no comment here contains. Relative
// order survives because kept lines stay in order, which is all the ordering assertion compares.
const CODE = stripCommentLines(ORACLE);

/**
 * EVERY decrypted payload, and whether its user-written fields reach a prompt.
 *
 * The first version of this file asserted "exactly one place a new prompt is decrypted" and scoped that
 * to `PromptSubmitted`. It passed, and it was wrong: there are FOUR `validatePayload` calls, and one of
 * the others carries a user-written string straight into the conversation history. The guard was
 * checking the site it already knew about — which is the whole failure mode every ingestion boundary in
 * these repos was written to prevent, reproduced in the guard itself.
 *
 * So the types are enumerated with the decision recorded per type, and a new type fails the scan until
 * someone makes that decision explicitly.
 */
const PAYLOADS = [
  {
    type: "PromptSubmitted",
    field: "promptText",
    // The prompt itself. Also becomes the conversation title via `.substring(0, 40)`, already stripped
    // by the time it gets there.
    reachesAPrompt: true,
  },
  {
    type: "RegenerationRequested",
    field: "instructions",
    // Interpolated into a history message — `Please regenerate your previous response. Make it ${...}`
    // — which RECENT_MESSAGES renders at position 100, INSIDE the fence. So a tag here closes the
    // region and puts the rest in the instruction region. 1000 characters allowed; the escape needs
    // about 48.
    reachesAPrompt: true,
  },
  {
    type: "BranchRequested",
    field: "originalTitle",
    // `Branch of ${originalTitle}` → a conversation metadata file. Never composed into a prompt, so a
    // fence tag in it cannot close a region that it is never inside. Rendered in the dApp, where a
    // stray tag is cosmetic rather than an injection.
    reachesAPrompt: false,
  },
  {
    type: "MetadataUpdateRequested",
    field: "title",
    // Conversation metadata only, same as above.
    reachesAPrompt: false,
  },
];

describe("the inbound prompt fence is wired, not merely written", () => {
  it("accounts for every decrypted payload, so a new one cannot arrive unconsidered", () => {
    const found = [...CODE.matchAll(/validatePayload\([^,]*,\s*"([A-Za-z]+)"\)/g)].map((m) => m[1]);
    const declared = PAYLOADS.map((p) => p.type);

    expect(
      found.slice().sort(),
      "a payload type appeared or vanished — decide whether its fields reach a prompt and record it " +
        "in PAYLOADS above",
    ).to.deep.equal(declared.slice().sort());
  });

  it("strips every payload field that reaches a prompt", () => {
    const unstripped = PAYLOADS.filter((p) => p.reachesAPrompt).filter(
      (p) => !new RegExp(`stripInboundPrompt\\(\\s*[\\w.]*\\b${p.field}\\b`).test(CODE),
    );

    expect(
      unstripped.map((p) => `${p.type}.${p.field}`),
      "these reach a prompt without being fence-stripped — a tag in them closes the region they sit in",
    ).to.deep.equal([]);
  });

  it("strips the prompt at that entry", () => {
    expect(CODE, "promptText must be produced by the strip, not read raw off the payload").to.match(
      /const promptText = stripInboundPrompt\(clientPayload\.promptText\)/,
    );
  });

  it("does not also destructure promptText raw, which would shadow the stripped one", () => {
    // The shape this replaced destructured `promptText` with its siblings. Leaving that in place
    // alongside the strip is a redeclaration in some positions and a silent shadow in others, and
    // either way the raw value is the one in scope.
    expect(CODE).to.not.match(/const \{[^}]*\bpromptText\b[^}]*\} = clientPayload/);
  });

  it("resolves the Brain during startup", () => {
    expect(CODE, "initInboundPrompt must be awaited in start()").to.match(
      /await initInboundPrompt\(\)/,
    );
  });

  it("resolves it BEFORE anything that can serve a prompt", () => {
    // Ordering is the whole point of a startup resolve. Placed after the event listeners are attached,
    // a prompt arriving during initialisation would hit the throw instead of being stripped.
    //
    // Scoped to start()'s BODY, which the first version was not — and it failed for the right reason.
    // `await initializeEliza()` appears twice in this file: once in start(), and once as a lazy guard
    // inside the prompt path itself. A whole-file indexOf found the lazy one, 47k characters earlier,
    // and compared against an anchor in a different function. A positional assertion has to be scoped
    // to the sequence it is claiming something about.
    const body = CODE.slice(CODE.indexOf("async function start()"));
    const init = body.indexOf("await initInboundPrompt()");
    const eliza = body.indexOf("await initializeEliza()");

    expect(init, "the init call is missing from start()").to.be.greaterThan(-1);
    expect(eliza, "the anchor this ordering is measured against moved out of start()").to.be.greaterThan(
      -1,
    );
    expect(init, "the fence must resolve before the model is initialised").to.be.lessThan(eliza);
  });
});
