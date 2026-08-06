const { expect } = require("chai");

const { stripCommentLines } = require("./helpers/stripCommentLines");

// Direct coverage for the plugin scope guard's comment stripper.
//
// Every "hides a real reference" case below is a fault this function ACTUALLY shipped with —
// two found by review bots, one self-caught. They are kept as named tests rather than trusted
// to a reading of the code, because all three looked correct when written.
//
// The token searched for is "telegram" throughout, matching how the guard uses it: what must
// never happen is a Telegram reference disappearing from the stripped output.

const sees = src => /telegram/i.test(stripCommentLines(src));

describe("stripCommentLines", () => {
  describe("must NOT hide real code (false negatives — the faults that shipped)", () => {
    it("keeps a reference after a `//` inside a string literal", () => {
      // Fault 1 (Copilot, round 1): a regex cutting from `//` to end-of-line ate the rest.
      expect(sees(`const s = "a // b"; const c = getService("telegram");`)).to.equal(true);
    });

    it("keeps code that follows a block-comment close on the same line", () => {
      // Fault 2 (self-caught): the whole line was dropped, code included.
      expect(sees(["/*", " note", " */ const svc = getService(\"telegram\");"].join("\n"))).to.equal(
        true,
      );
    });

    it("keeps code that follows a single-line block comment", () => {
      expect(sees(`/* note */ const svc = "telegram";`)).to.equal(true);
    });

    it("keeps an expression line that begins with `*`", () => {
      // Fault 3 (claude[bot], round 2): a startsWith("*") clause aimed at docblock
      // continuation lines swallowed arithmetic continuations too.
      expect(sees(["const fees = baseRate", "  * telegram.getMembersCount(chatId);"].join("\n"))).to.equal(
        true,
      );
    });

    it("keeps a trailing comment's line, on purpose", () => {
      // Not a bug: `//` cannot be distinguished from one inside a string, so trailing comments
      // are left alone and fail LOUD. Asserted so nobody "fixes" it back into fault 1.
      expect(sees(`const x = 1; // telegram belongs in core`)).to.equal(true);
    });
  });

  describe("must strip genuine documentation", () => {
    it("strips a docblock", () => {
      expect(
        sees(["/**", " * Telegram belongs in sense-ai-core.", " */", "const x = 1;"].join("\n")),
      ).to.equal(false);
    });

    it("strips a multi-line docblock including @param lines", () => {
      expect(
        sees(
          ["/**", " * @param telegram the bot handle", " * more prose", " */", "const x = 1;"].join(
            "\n",
          ),
        ),
      ).to.equal(false);
    });

    it("strips a whole-line // comment", () => {
      expect(sees(["// telegram lives in core", "const x = 1;"].join("\n"))).to.equal(false);
    });
  });

  describe("structure", () => {
    it("keeps every line of ordinary code, normalised", () => {
      // The contract is CONTENT, not formatting: the output is only ever regex-searched, so
      // each kept line comes back trimmed. Asserting byte-identical output would be asserting
      // something the guard does not need and the function does not promise.
      const src = ["const a = 1;", "function f() {", "  return a;", "}"].join("\n");
      expect(stripCommentLines(src)).to.equal(
        ["const a = 1;", "function f() {", "return a;", "}"].join("\n"),
      );
    });

    it("handles an unterminated block comment without swallowing the file", () => {
      // Everything after an unclosed `/*` is comment by definition — assert it does not throw
      // and does not resurrect the text as code.
      expect(sees(["/*", "telegram", "still inside"].join("\n"))).to.equal(false);
    });
  });
});
