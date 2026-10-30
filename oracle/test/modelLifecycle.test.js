const fs = require("node:fs");
const path = require("node:path");
const { expect } = require("chai");

/* Google retires models on published dates. A retired id fails at request time with no
   build-time signal, and queryElizaOS turns that failure into a silent fallback to
   ChainGPT with empty reasoning and sources — so the symptom is a degraded answer rather
   than an error anyone sees. This turns it into a test failure instead.

   Vertex retires the 2.5 family on 2026-10-20; the 2.0 family went on 2026-06-01. The
   -latest aliases never expire but were dropped on 2026-10-30 (CU-14ym9bvnghd): an alias
   lets Google move a slot to a costlier model without a deploy. Every slot is pinned to
   an explicit id — see PINNED_MODELS.

   https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions */

/* Extend this alternation each time a generation reaches its retirement date — the test
   is only worth what this list is kept current at. 1.0 retired 2025-04, 1.5 in 2025-09,
   2.0 on 2026-06-01, 2.5 goes on 2026-10-20, the 3-pro and 3.1-flash-lite previews went
   2026-03-09 and 2026-05-25, and the GA 3.1-flash-lite goes on 2027-05-07. */
/* One source of truth, two derived matchers, because the /g flag is required for one use
   and actively harmful for the other.

   String.prototype.match needs /g to return every offender rather than just the first.
   Chai's .match() calls RegExp.exec, which on a /g regex advances lastIndex and carries
   that state into the next assertion — so a shared global regex silently skips the second
   of two retired values, defeating exactly the half-finished-bump case this guard exists
   to catch. A fresh non-global regex per assertion has no state to leak. */
const RETIRED_MODEL_SOURCE =
  "gemini-(?:(?:1\\.0|1\\.5|2\\.0|2\\.5)-[a-z0-9.-]+|3-pro-preview|3\\.1-flash-lite-preview)";

/* Pinned 2026-10-30 against https://ai.google.dev/gemini-api/docs/deprecations — the
   cheapest stable model per slot with no shutdown date inside twelve months, aligned with
   sense-ai-core:
     gemini-3.5-flash-lite  small + image; stable, none announced (3.1-flash-lite: 2027-05-07)
     gemini-3.8-flash       large; stable, none announced
     gemini-embedding-001   shutdown 2028-05-14; changing it means re-embedding every memory
   Re-check the page when a pin nears twelve months of age. */
const PINNED_MODELS = {
  GOOGLE_SMALL_MODEL: "gemini-3.5-flash-lite",
  SMALL_MODEL: "gemini-3.5-flash-lite",
  GOOGLE_LARGE_MODEL: "gemini-3.8-flash",
  LARGE_MODEL: "gemini-3.8-flash",
  GOOGLE_IMAGE_MODEL: "gemini-3.5-flash-lite",
  IMAGE_MODEL: "gemini-3.5-flash-lite",
  GOOGLE_EMBEDDING_MODEL: "gemini-embedding-001",
  TEXT_EMBEDDING_MODEL: "gemini-embedding-001",
};
const RETIRED_MODEL = new RegExp(RETIRED_MODEL_SOURCE, "g");
const retiredModelMatcher = () => new RegExp(RETIRED_MODEL_SOURCE);

const ENV_EXAMPLE = path.join(__dirname, "..", ".env.oracle.example");

describe("model lifecycle", function () {
  it("should not pin any retired Gemini model in .env.oracle.example", () => {
    const matches = fs.readFileSync(ENV_EXAMPLE, "utf8").match(RETIRED_MODEL);

    expect(matches, `retired models pinned: ${[...new Set(matches || [])].join(", ")}`).to.equal(
      null,
    );
  });

  it("should load model ids from the example that dotenv actually exposes", () => {
    /* The suite runs with DOTENV_CONFIG_PATH=./.env.oracle.example, so these are the
       values every other test runs against — a broken example silently changes them. */
    /* Both sets matter: the template defines GOOGLE_* and bare keys side by side, and
       ElizaOS reads the bare ones. Guarding only one set would let a half-finished bump
       through with the two disagreeing. */
    for (const key of [
      "GOOGLE_SMALL_MODEL",
      "GOOGLE_LARGE_MODEL",
      "GOOGLE_IMAGE_MODEL",
      "GOOGLE_EMBEDDING_MODEL",
      "SMALL_MODEL",
      "LARGE_MODEL",
      "IMAGE_MODEL",
      "TEXT_EMBEDDING_MODEL",
    ]) {
      expect(process.env[key], `${key} missing from .env.oracle.example`).to.be.a("string");
      expect(process.env[key]).to.not.match(retiredModelMatcher());
    }
  });

  it("should pin every model slot to an explicit id, never a -latest alias", () => {
    /* Asserted per KEY through the values dotenv exposes, so a drifted bare key cannot
       hide behind its GOOGLE_* twin still holding the pinned string. */
    for (const [key, model] of Object.entries(PINNED_MODELS)) {
      expect(process.env[key], `${key} should be pinned`).to.equal(model);
    }

    const env = fs.readFileSync(ENV_EXAMPLE, "utf8");
    expect(env, ".env.oracle.example names a -latest alias").to.not.match(
      /=gemini-[a-z-]*-latest/,
    );
  });

  it("should default the character to the pinned large model", () => {
    /* Read as text rather than required: requiring character.js loads dotenv and
       @elizaos/core on import, and the pin is a string literal either way. */
    const character = fs.readFileSync(
      path.join(__dirname, "..", "src", "elizaos", "character.js"),
      "utf8",
    );

    expect(character).to.include(`model: "${PINNED_MODELS.LARGE_MODEL}"`);
    expect(character).to.not.match(/model: "gemini-[a-z-]*-latest"/);
  });
});
