const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { expect } = require("chai");

const { pluginDirs, sourcesUnder, SKIP_DIRS, SOURCE_EXT } = require("./helpers/pluginScope");

// Direct coverage for the scope guard's tree walk.
//
// The guard is only as good as the set of files it scans, and a walk that quietly scans FEWER
// files still reports success — the same shape of silent failure that let three false
// negatives ship in stripCommentLines, each verified once by hand and then forgotten. So the
// walk gets fixtures rather than a reading of the code.

let root;

/** Writes a file, creating parents. Paths are relative to the fixture root. */
const put = (rel, body = "// fixture\n") => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
};

describe("plugin scope discovery", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-scope-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe("pluginDirs", () => {
    it("returns [] when the root does not exist — the vacuous-pass precondition", () => {
      // This is WHY scanTargets() asserts a non-empty result: [] here used to cascade into a
      // passing guard that had scanned nothing.
      expect(pluginDirs(path.join(root, "definitely-absent"))).to.deep.equal([]);
    });

    it("lists plugin directories and ignores loose files at the root", () => {
      put("plugin-a/src/index.ts");
      put("plugin-b/src/index.ts");
      put("README.md");
      expect(pluginDirs(root).map(d => path.basename(d)).sort()).to.deep.equal([
        "plugin-a",
        "plugin-b",
      ]);
    });
  });

  describe("sourcesUnder", () => {
    it("collects every configured source extension", () => {
      for (const ext of SOURCE_EXT) put(`plugin-a/src/file${ext}`);
      const found = sourcesUnder(pluginDirs(root));
      expect(found.length, `expected one file per extension in ${SOURCE_EXT.join(", ")}`).to.equal(
        SOURCE_EXT.length,
      );
    });

    it("ignores files with unrelated extensions", () => {
      put("plugin-a/src/notes.md");
      put("plugin-a/src/data.json");
      expect(sourcesUnder(pluginDirs(root))).to.deep.equal([]);
    });

    it("recurses into nested directories", () => {
      put("plugin-a/src/deeply/nested/thing.ts");
      expect(sourcesUnder(pluginDirs(root)).map(f => path.basename(f))).to.deep.equal(["thing.ts"]);
    });

    it("skips every directory in SKIP_DIRS", () => {
      put("plugin-a/src/real.ts");
      for (const dir of SKIP_DIRS) put(`plugin-a/src/${dir}/ignored.ts`);
      expect(
        sourcesUnder(pluginDirs(root)).map(f => path.basename(f)),
        `only real.ts should survive; SKIP_DIRS = ${SKIP_DIRS.join(", ")}`,
      ).to.deep.equal(["real.ts"]);
    });

    it("returns [] for roots that do not exist rather than throwing", () => {
      expect(sourcesUnder([path.join(root, "absent")])).to.deep.equal([]);
    });
  });
});
