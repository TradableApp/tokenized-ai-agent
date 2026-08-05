const { execFileSync } = require("node:child_process");

const { expect } = require("chai");

// Brain pin guard — CU-86d3ud1va (epic CU-86d3dwme6).
//
// `@tradableapp/sense-ai-brain` is the ONE analytical powerhouse both bodies share: this
// oracle and sense-ai-core. It is vendored as a git submodule, which means each body pins
// its own commit — and on 2026-07-27 the two had silently drifted apart (this repo on
// 20a356c, core on 2271455, Brain main on 18f3008). Nothing failed. Divergent pins are how
// "no re-fork" dies quietly: the two bodies keep compiling while running different Brains,
// and shared logic starts behaving differently in each.
//
// So the pin is asserted against a constant that lives in this file. Bumping the Brain then
// REQUIRES editing a test, which puts the new SHA in the diff where a reviewer sees it — and
// makes the matching bump in the other body an explicit, comparable step rather than
// something remembered.
//
// Scope, stated honestly: this catches an unreviewed pin move within THIS repo (e.g. a
// `git submodule update --remote` committed by accident). It cannot compare against
// sense-ai-core, because CI checks out only this repo and its submodules — the sibling is
// not present. Keeping the two constants equal is a review step, documented in
// docs/BRAIN_PIN.md.
//
// Asserted against the GITLINK in the INDEX (`git ls-files -s`), not the checked-out working
// tree, so it is meaningful even when the submodule was not checked out recursively (CI
// without `--recursive` would otherwise read an empty directory and prove nothing).
//
// The index rather than `ls-tree HEAD` deliberately: after a fresh CI checkout the two are
// identical, but locally the index is what is about to BE committed — so a staged bump is
// validated before it lands, instead of the guard reporting the previous commit's pin.

const EXPECTED_BRAIN_SHA = "18f30084e0505e468f18c18a607e06db8b0ded41";
const SUBMODULE_PATH = "oracle/packages/sense-ai-brain";
const CANONICAL_BRAIN_URL = "https://github.com/TradableApp/sense-ai-brain";

// Repo root, resolved ONCE at load so the test works regardless of the cwd mocha was invoked
// from. Deliberately at module scope rather than per call: it avoids forking a second
// subprocess for every git() call, and if this fails (not inside a git repo) the file fails
// loudly at load — which is the honest signal, since a guard that reads git cannot function
// there at all. Buried inside git(), the same failure would surface mid-assertion as a
// confusing "Command failed".
const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

/** git() but returning "" instead of throwing, for reads whose ABSENCE is itself a finding. */
function gitOrEmpty(args) {
  try {
    return git(args);
  } catch {
    return "";
  }
}

describe("sense-ai-brain submodule pin", () => {
  it("pins the reviewed Brain commit", () => {
    // `160000 <sha> 0\t<path>` — 160000 is git's mode for a gitlink, 0 the merge stage.
    const entry = git(["ls-files", "-s", "--", SUBMODULE_PATH]).trim();

    // An empty result means the submodule is not in the tree at all. Assert it explicitly:
    // a bare regex match on "" would otherwise throw something unreadable, and a guard that
    // fails obscurely gets deleted rather than fixed.
    expect(entry, `no git entry for ${SUBMODULE_PATH} — was the submodule removed or moved?`).to
      .not.be.empty;

    const match = /^160000 ([0-9a-f]{40}) 0\t/.exec(entry);
    expect(match, `expected a gitlink (mode 160000) at ${SUBMODULE_PATH}, got: ${entry}`).to.not.be
      .null;

    expect(
      match[1],
      `The Brain pin moved without updating this test.\n` +
        `  expected ${EXPECTED_BRAIN_SHA}\n` +
        `  found    ${match[1]}\n` +
        `If the bump is intentional: update EXPECTED_BRAIN_SHA here AND make the same bump in ` +
        `sense-ai-core (packages/sense-ai-brain) in the same change, so the two bodies keep ` +
        `sharing one Brain. See docs/BRAIN_PIN.md.`,
    ).to.equal(EXPECTED_BRAIN_SHA);
  });

  it("points at the canonical Brain repo, not a fork", () => {
    // The most literal form of the re-fork this architecture exists to prevent: repoint the
    // submodule at a personal fork, and the two bodies diverge permanently while every test
    // that only checks the SHA still passes.
    // gitOrEmpty, not git: `git config` EXITS NON-ZERO when the key is absent, so a renamed or
    // deleted submodule section would throw a raw "Command failed" and this message — the whole
    // point of the test — would never print. Absence is a finding here, not an error.
    const url = gitOrEmpty([
      "config",
      "--file",
      ".gitmodules",
      `submodule.${SUBMODULE_PATH}.url`,
    ]).trim();

    expect(
      url,
      `The Brain submodule must track the canonical repo — got ${url ? `"${url}"` : "no entry at all"}. ` +
        `An empty result means the submodule section was renamed or removed from .gitmodules; a ` +
        `different URL means it points at a fork, which would let this body's Brain diverge from ` +
        `sense-ai-core's permanently.`,
    ).to.equal(CANONICAL_BRAIN_URL);
  });
});
