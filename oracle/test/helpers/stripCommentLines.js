// Comment stripper for the plugin scope guard (pluginSenseaiScope.test.js).
//
// Extracted into its own module because it has attracted the SAME fault three times, each a
// false negative in a guard whose entire job is to prevent silent regressions:
//
//   1. `(^|[^:])//.*$` cut inside string literals, so
//      `const s = "a // b"; getService("telegram")` lost the reference. (Copilot, round 1)
//   2. Rewriting it line-based then dropped the WHOLE line that closed a block comment, so
//      `*/ const svc = getService("telegram");` vanished. (self-caught)
//   3. A `startsWith("*")` clause meant for docblock continuation lines also swallowed any
//      expression beginning with `*`, e.g. `  * telegram.getMembersCount(id)`. (claude[bot],
//      round 2)
//
// Three strikes is a design signal, not bad luck: the logic is fiddlier than it looks and it
// was invisible inside the test file. It now has direct unit coverage in
// test/stripCommentLines.test.js, so the next edit has to survive the cases that already bit.
//
// THE RULE: drop comment LINES, never guess at parts of a line.
//
// Block delimiters (`/*`, `*/`) ARE sliced at, because they are explicit and unambiguous.
// `//` is deliberately NOT sliced at, because it cannot be told apart from a `//` inside a
// string literal — which is fault 1 above. The consequence is that a trailing comment such as
// `const x = 1; // telegram` still reads as code and TRIPS the guard. That is a false
// positive: loud, instantly understood, and fixed by moving the note to its own line. A false
// negative is the one outcome a regression guard must never have.
//
// `/*` is honoured only at the START of a trimmed line, for the same reason — a `/*` inside a
// string should not open a phantom comment. A block comment opened mid-line therefore leaves
// its continuation lines looking like code, which again fails loud rather than silent.

/**
 * Removes comment lines from source, preserving any real code that shares a line with a block
 * comment delimiter.
 *
 * @param {string} src
 * @returns {string} the source with comment-only lines removed
 */
function stripCommentLines(src) {
  let inBlock = false;
  const kept = [];

  for (const raw of src.split("\n")) {
    let t = raw.trim();

    // Closing an open block KEEPS whatever follows `*/` on the same line (fault 2).
    if (inBlock) {
      const close = t.indexOf("*/");
      if (close === -1) continue;
      inBlock = false;
      t = t.slice(close + 2).trim();
    }

    // A line that OPENS a block: `/* note */ code` keeps `code`. `while`, not `if`, since one
    // line may open and close several.
    while (t.startsWith("/*")) {
      const close = t.indexOf("*/");
      if (close === -1) {
        inBlock = true;
        t = "";
        break;
      }
      t = t.slice(close + 2).trim();
    }

    // No `startsWith("*")` clause here — that was fault 3, and it is unnecessary: `/**` sets
    // inBlock above, so docblock interiors are already dropped by the block tracking.
    if (t === "" || t.startsWith("//")) continue;
    kept.push(t);
  }

  return kept.join("\n");
}

module.exports = { stripCommentLines };
