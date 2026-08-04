const fs = require("node:fs");
const path = require("node:path");
const { expect } = require("chai");

/* Google retires models on published dates. A retired id fails at request time with no
   build-time signal, and queryElizaOS turns that failure into a silent fallback to
   ChainGPT with empty reasoning and sources — so the symptom is a degraded answer rather
   than an error anyone sees. This turns it into a test failure instead.

   Vertex retires the 2.5 family on 2026-10-20; the 2.0 family went on 2026-06-01. The
   -latest aliases hot-swap on Google's side and never expire.

   https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions */

const RETIRED_MODEL = /gemini-(?:1\.5|2\.0|2\.5)-[a-z0-9.-]+/g;

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
    for (const key of ["GOOGLE_SMALL_MODEL", "GOOGLE_LARGE_MODEL", "GOOGLE_EMBEDDING_MODEL"]) {
      expect(process.env[key], `${key} missing from .env.oracle.example`).to.be.a("string");
      expect(process.env[key]).to.not.match(RETIRED_MODEL);
    }
  });

  it("should keep the -latest aliases, which do not expire", () => {
    const env = fs.readFileSync(ENV_EXAMPLE, "utf8");

    expect(env).to.include("gemini-flash-latest");
    expect(env).to.include("gemini-pro-latest");
  });
});
