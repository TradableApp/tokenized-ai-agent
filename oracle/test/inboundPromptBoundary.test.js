const { expect } = require("chai");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

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

/** Comment TEXT removed, line numbering kept, so a comment is neither evidence nor a hiding place. */
function codeOnly(text) {
  let inBlock = false;

  return text
    .split("\n")
    .map((line) => {
      if (inBlock) {
        const close = line.indexOf("*/");
        if (close === -1) return "";
        inBlock = false;

        return " ".repeat(close + 2) + line.slice(close + 2);
      }

      const open = line.indexOf("/*");
      if (open !== -1 && line.indexOf("*/", open) === -1) {
        inBlock = true;

        return line.slice(0, open);
      }

      const lineComment = line.indexOf("//");

      return lineComment === -1 ? line : line.slice(0, lineComment);
    })
    .join("\n");
}

const CODE = codeOnly(ORACLE);

describe("the inbound prompt fence is wired, not merely written", () => {
  it("has exactly one place a new prompt is decrypted and validated", () => {
    // The scan below assumes one entry. If a second appears, this fails FIRST and names the
    // assumption, rather than the next assertion silently checking only the site it knew about.
    const entries = CODE.match(/validatePayload\([^)]*"PromptSubmitted"\)/g) ?? [];

    expect(
      entries.length,
      "a second prompt entry point appeared — it needs the strip too, and this scan needs widening",
    ).to.equal(1);
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
