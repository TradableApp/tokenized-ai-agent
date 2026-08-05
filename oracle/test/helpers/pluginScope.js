const fs = require("node:fs");
const path = require("node:path");

// Plugin-tree discovery for the scope guard (pluginSenseaiScope.test.js).
//
// Extracted for the same reason stripCommentLines was: the guard's correctness depends on this
// walk seeing the right files, and "I checked it once by hand" is what allowed three separate
// false negatives to ship in the stripper. Directory walking has the same shape of quiet
// failure — a wrong extension list or a wrong skip list scans fewer files and still reports
// success. Unit-tested in test/pluginScope.test.js against fixtures on disk.

/** Default root: the oracle's ElizaOS plugins tree. Overridable so the walk can be tested. */
const PLUGINS_ROOT = path.resolve(__dirname, "../../src/elizaos/plugins");

// The tree is TypeScript today, but the guard promises to cover "every plugin directory", and
// a plugin shipping a plain .js helper (or a committed compiled file) must not be invisible.
const SOURCE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

// Directories whose contents are not the plugin's shipped source. `__tests__` is this repo's
// convention, but the next oracle-only plugin may be scaffolded with any common alternative,
// and a test may legitimately name a social platform while mocking one. Build output and
// dependencies are excluded for the obvious reason: they are not source.
//
// Trade-off, recorded because it is deliberate: Telegram-coupled code hidden inside a test
// directory is not caught. Test files do not ship in the answer path, and the alternative
// reintroduces false positives on legitimate mocks.
const SKIP_DIRS = ["__tests__", "test", "tests", "spec", "__mocks__", "dist", "node_modules"];

/** Every plugin directory under `root`. Returns [] when the root does not exist. */
function pluginDirs(root = PLUGINS_ROOT) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => path.join(root, e.name));
}

/** Every source file under the given roots, recursively, excluding tests and build output. */
function sourcesUnder(roots) {
  const out = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.includes(entry.name)) continue;
        walk(full);
      } else if (SOURCE_EXT.some(ext => entry.name.endsWith(ext))) {
        out.push(full);
      }
    }
  };
  for (const r of roots) if (fs.existsSync(r)) walk(r);
  return out;
}

module.exports = { PLUGINS_ROOT, SOURCE_EXT, SKIP_DIRS, pluginDirs, sourcesUnder };
