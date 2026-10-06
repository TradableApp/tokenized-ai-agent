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

  it("does not gate a strip on the field's own truthiness", () => {
    // `field ? strip(field) : field` looks equivalent and is not. `stripInboundPrompt` coerces with
    // `String(text ?? "")`, so the only thing a truthy gate buys is that `""` skips the strip — and
    // skipping it also skips the throw that fires when startup never wired the strip up. That throw
    // is the single signal distinguishing a working strip from a no-op, so narrowing which values
    // reach it narrows the only evidence there is. `!= null` passes `""` through and keeps it.
    const gated = PAYLOADS.filter((p) => p.reachesAPrompt).filter((p) =>
      new RegExp(`\\b${p.field}\\s*\\?\\s*stripInboundPrompt`).test(CODE),
    );

    expect(
      gated.map((p) => `${p.type}.${p.field}`),
      "these gate the strip on truthiness, so an empty value skips the uninitialised-throw too",
    ).to.deep.equal([]);
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

/**
 * THE ANSWER, which the enumeration above is structurally blind to.
 *
 * `PAYLOADS` enumerates decrypted payload FIELDS — text the user sent. The model's own answer is
 * none of them, so every assertion in the block above can be green while the answer reaches storage
 * carrying a tag that closes the fence it will later be replayed inside. That is the same fault this
 * file's own header describes catching one level down ("the guard was checking the site it already
 * knew about"), reproduced in the guard itself: the enumeration is honest about user-written fields
 * and silent about everything else that lands in a fenced region.
 *
 * Stated about the binding rather than the three storage sites it feeds. `answerText` is bound twice
 * — once in the prompt handler, once in the regeneration handler — and those two bindings reach three
 * `createMessageFile({ ..., content: answerText })` calls. Asserting the binding means a fourth
 * storage site added later inherits the strip instead of needing its own assertion, which is the
 * property the inbound side gets from stripping at the entry.
 *
 * `queryChainGPT`'s local `const answerText = (await res.text()).trim()` is deliberately NOT in
 * scope: it is a provider's raw response on its way to becoming `answer.text`, not a value on its
 * way to storage. So the scan keys on `answer.text` specifically.
 */
describe("the stored answer is fence-stripped, not merely the prompt", () => {
  it("binds every answer.text through the strip", () => {
    const bindings = [...CODE.matchAll(/const answerText = (.+?);/g)].map((m) => m[1].trim());
    const fromAnswer = bindings.filter((b) => /\banswer\.text\b/.test(b));

    expect(
      fromAnswer.length,
      "answerText is no longer bound from answer.text — this scan has lost its subject",
    ).to.be.greaterThan(0);

    expect(
      fromAnswer.filter((b) => !/stripStoredAnswer\(/.test(b)),
      "these store the model's answer unstripped; a tag it emits closes the fence its own replay " +
        "sits inside on every later turn, and on-chain storage has no cleanup path",
    ).to.deep.equal([]);
  });

  it("stores only the stripped binding, never answer.text directly", () => {
    // A second storage site that reaches past the binding would be invisible to the assertion above.
    expect(
      CODE,
      "content must come from the stripped answerText binding, not straight off the answer object",
    ).to.not.match(/content:\s*answer\.text\b/);
  });
});
