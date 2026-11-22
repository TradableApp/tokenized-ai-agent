const { expect } = require("chai");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

/**
 * The stream server is a network surface inside the TEE, and the machine's logs are kept and
 * readable by its admin. A reader's address, any header it sent (its proof, its origin, its
 * cursor) and the answer id it asked for would link a wallet's activity to a client. So no
 * module under src/stream/ puts any of them in a log line or an error message.
 *
 * Read from the source: these lines sit on refusal and failure paths that a unit test rarely
 * reaches, and one forgotten line is enough. The check looks at the code inside each log call
 * and each `new …Error(` (string literals blanked, `${…}` expressions kept), and fails on a
 * name that carries one of those values. A reader's address is not read anywhere in these
 * modules at all.
 */
const STREAM_DIR = join(__dirname, "..", "src", "stream");

const CALL =
  /\b(?:console\s*\.\s*(?:log|info|warn|error|debug|trace)|new\s+(?:[A-Z][A-Za-z]*)?Error)\s*\(/g;
const FORBIDDEN_IN_CALL =
  /\b(?:answerMessageId|answerId|id|ids|headers?|getHeader|rawHeaders|origin|proof|expectedProof|lastEventId|cursor|url|path|req|request|res|response|socket|address|remoteAddress|remotePort)\b/;
const NEVER_READ = /remoteAddress|remotePort|x-forwarded-for|x-real-ip|forwarded/i;

/** The text from `open` (just after a "(") to its matching ")", quotes respected. */
function argumentsFrom(code, open) {
  let depth = 1;
  let i = open;
  let quote = null;
  while (i < code.length && depth > 0) {
    const c = code[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    i += 1;
  }
  return code.slice(open, i - 1);
}

/** The code of `text` with literal text blanked; a template's `${…}` expressions are kept. */
function codeOnly(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      out += " ";
      i = j + 1;
    } else if (c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== "`") {
        if (text[j] === "\\") j += 2;
        else if (text[j] === "$" && text[j + 1] === "{") {
          let depth = 1;
          let k = j + 2;
          while (k < text.length && depth > 0) {
            if (text[k] === "{") depth += 1;
            else if (text[k] === "}") depth -= 1;
            k += 1;
          }
          out += ` ${text.slice(j + 2, k - 1)} `;
          j = k;
        } else j += 1;
      }
      out += " ";
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

function withoutComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Every log call or error built in `src` whose code names a forbidden value. */
function offenders(src) {
  const code = withoutComments(src);
  const found = [];
  for (const match of code.matchAll(CALL)) {
    const args = argumentsFrom(code, match.index + match[0].length);
    if (FORBIDDEN_IN_CALL.test(codeOnly(args))) found.push(`${match[0]}${args})`);
  }
  return found;
}

function streamModules() {
  return readdirSync(STREAM_DIR)
    .filter((file) => file.endsWith(".js"))
    .map((file) => ({ file, src: readFileSync(join(STREAM_DIR, file), "utf8") }));
}

describe("stream modules log no reader, header or answer id", () => {
  it("covers the server's modules", () => {
    const files = streamModules().map((m) => m.file);
    expect(files).to.include.members(["streamServer.js", "frameBuffer.js", "streamConfig.js"]);
  });

  for (const { file, src } of streamModules()) {
    it(`${file} puts no id, header value or address in a log line or an error`, () => {
      expect(offenders(src)).to.deep.equal([]);
    });

    it(`${file} never reads a reader's network address`, () => {
      expect(withoutComments(src)).to.not.match(NEVER_READ);
    });
  }

  describe("the check itself", () => {
    const cases = [
      ["an interpolated answer id", "console.warn(`[Stream] refused ${answerMessageId}`);", true],
      ["an id passed as an argument", 'console.log("open", id);', true],
      ["a header value", "console.error(`bad ${req.headers.origin}`);", true],
      ["the reader's address", "console.log(req.socket.remoteAddress);", true],
      ["an error built with the proof", "throw new Error(`proof ${proof} refused`);", true],
      ["a TypeError built with the cursor", "throw new TypeError(String(cursor));", true],
      ["an error's message", "console.error(`[Stream] failed (${error.message}).`);", true],
      ["an error's stack", 'console.warn("[Stream] failed", err.stack);', true],
      ["an error built from another's message", "throw new Error(error.message);", true],
      ["plain words", 'console.warn("[Stream] A reader was refused.");', false],
      ["a described error", "console.error(`[Stream] failed (${errorKind(error)}).`);", false],
      ["a count", "console.log(`[Stream] ${count} readers`);", false],
      ["a word inside the text only", 'console.log("the answer id is never logged");', false],
    ];
    for (const [name, line, flagged] of cases) {
      it(`${flagged ? "flags" : "allows"} ${name}`, () => {
        expect(offenders(line)).to.have.length(flagged ? 1 : 0);
      });
    }
  });
});

module.exports = { offenders };
