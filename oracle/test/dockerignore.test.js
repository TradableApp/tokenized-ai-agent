const chai = require("chai");
const fs = require("node:fs");
const path = require("node:path");
const { expect } = chai;

// Guards the root `.dockerignore`, which keeps environment files out of the build context of
// `Dockerfile.oracle`. The Dockerfile copies whole directories (the shared schema, the Brain,
// `oracle/src`), and a `.dockerignore` pattern without a leading `**/` matches at the root of
// the context only, so an env file is excluded at any depth only by the `**/` forms.

const REPO_ROOT = path.join(__dirname, "..", "..");
const lines = (file) =>
  fs
    .readFileSync(path.join(REPO_ROOT, file), "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

describe(".dockerignore", function () {
  it("excludes an env file at any depth of the build context", function () {
    const patterns = lines(".dockerignore");
    expect(patterns).to.include("**/.env");
    expect(patterns).to.include("**/.env.*");
  });

  it("lets no env file back in with an exception", function () {
    const exceptions = lines(".dockerignore").filter((l) => l.startsWith("!"));
    expect(exceptions.filter((l) => /\.env/.test(l))).to.deep.equal([]);
  });

  it("is not relied on to drop an env file the Dockerfile copies by name", function () {
    const copies = lines("Dockerfile.oracle").filter((l) => /^COPY\s/i.test(l) && !/--from=/i.test(l));
    expect(copies).to.not.be.empty;
    expect(copies.filter((l) => /\.env/.test(l))).to.deep.equal([]);
  });
});
