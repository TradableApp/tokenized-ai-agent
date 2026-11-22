const { expect } = require("chai");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

const { stripCommentLines } = require("./helpers/stripCommentLines");

/**
 * What is shown live must be what is stored. `aiAgentOracle.stream.test.js` proves it for the
 * paths it drives; this proves it for every assistant MessageFile the oracle builds, by reading the
 * source: reasoning and sources reach `createMessageFile` only from the stream's record, the model's
 * own reasoning is never read past the stream, and the old mock extras that bypassed it are gone.
 */
const SRC = join(__dirname, "..", "src");
const ORACLE = stripCommentLines(readFileSync(join(SRC, "aiAgentOracle.js"), "utf8"));

/** Each `createMessageFile({ … })` call with its argument text. */
function createMessageFileCalls(code) {
  const calls = [];
  const opener = /createMessageFile\(\{/g;
  let match;
  while ((match = opener.exec(code))) {
    let depth = 1;
    let i = match.index + match[0].length;
    while (depth > 0 && i < code.length) {
      if (code[i] === "{") depth += 1;
      else if (code[i] === "}") depth -= 1;
      i += 1;
    }
    calls.push(code.slice(match.index, i));
  }
  return calls;
}

/** The parameter list and body of a top-level `function name(…) { … }`. */
function functionParts(code, name) {
  const head = new RegExp(`function ${name}\\(([^)]*)\\)\\s*\\{`).exec(code);
  if (!head) return null;
  let depth = 1;
  let i = head.index + head[0].length;
  while (depth > 0 && i < code.length) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}") depth -= 1;
    i += 1;
  }
  return { params: head[1].replace(/\s+/g, " ").trim(), body: code.slice(head.index + head[0].length, i - 1) };
}

describe("stream single source (static)", () => {
  const assistantCalls = createMessageFileCalls(ORACLE).filter((call) => /role:\s*"assistant"/.test(call));

  it("finds every assistant MessageFile the oracle builds", () => {
    // Two in handlePrompt (new and existing conversation) and one in handleRegeneration.
    expect(assistantCalls).to.have.length(3);
  });

  it("gives each assistant MessageFile its reasoning and sources from the stream's record only", () => {
    for (const call of assistantCalls) {
      expect(call, call).to.match(/\.\.\.storedExtras\b/);
      expect(call, call).to.not.match(/\breasoning:/);
      expect(call, call).to.not.match(/\bsources:/);
      expect(call, call).to.not.match(/answer\.(reasoning|sources)/);
      expect(call, call).to.not.match(/realAnswerExtras|mockAnswerExtras/);
    }
  });

  it("builds storedExtras from stream.record() and nothing else", () => {
    const builds = ORACLE.match(/const storedExtras = [^;]+;/g) ?? [];
    expect(builds, "one per handler").to.have.length(2);
    for (const build of builds) {
      expect(build).to.match(/storedExtrasFrom\(\s*stream\.record\(\)/);
    }
  });

  it("never reads the model's reasoning or sources past the stream", () => {
    expect(ORACLE).to.not.match(/answer\.reasoning\b/);
    expect(ORACLE).to.not.match(/answer\.sources\b/);
  });

  it("never takes reasoning or sources out of an answer by destructuring, indexing or spreading it", () => {
    expect(ORACLE).to.not.match(/\{[^{}]*\b(reasoning|sources)\b[^{}]*\}\s*=\s*(await\s+)?answer\b/);
    expect(ORACLE).to.not.match(/answer\s*\[\s*["'`](reasoning|sources)["'`]\s*\]/);
    for (const call of assistantCalls) {
      expect(call, call).to.not.match(/\.\.\.\s*answer\b/);
    }
  });

  it("builds the stored extras only from the record and the duration it is given", () => {
    const parts = functionParts(ORACLE, "storedExtrasFrom");
    expect(parts, "storedExtrasFrom exists").to.not.equal(null);
    expect(parts.params).to.equal("{ reasoning, sources }, reasoningDuration");
    const allowed = new Set(["return", "reasoning", "sources", "reasoningDuration", "length", "undefined"]);
    const names = parts.body.match(/[A-Za-z_$][\w$]*/g) ?? [];
    expect(names.filter((name) => !allowed.has(name))).to.deep.equal([]);
  });

  it("calls storedExtrasFrom only to build storedExtras", () => {
    const calls = ORACLE.match(/storedExtrasFrom\(/g) ?? [];
    // The definition and the two builds checked above.
    expect(calls).to.have.length(3);
  });

  it("has no mock extras that bypass the stream", () => {
    expect(ORACLE).to.not.match(/mockAnswerExtras/);
    expect(ORACLE).to.not.match(/realAnswerExtras/);
  });

  it("sanitises a thought before it is recorded, in the one place thoughts arrive", () => {
    const recordCalls = ORACLE.match(/runProvenance\.recordThought\([^)]*\)/g) ?? [];
    expect(recordCalls).to.have.length(1);
    expect(recordCalls[0]).to.match(/recordThought\(runId, clean, action\)/);
    expect(ORACLE).to.match(/await sanitizeThought\(/);
  });

  it("gives the answer frame the same text binding the stored file gets", () => {
    const answerFrames = ORACLE.match(/stream\.answer\(\{[^}]*\}\)/g) ?? [];
    expect(answerFrames).to.have.length(2);
    for (const frame of answerFrames) {
      expect(frame).to.match(/text:\s*answerText\b/);
      expect(frame).to.match(/answerMessageCID\b/);
    }
  });

  it("keeps the stream modules free of logged ids and keys", () => {
    const dir = join(SRC, "stream");
    for (const file of readdirSync(dir)) {
      const code = stripCommentLines(readFileSync(join(dir, file), "utf8"));
      const logs = code.match(/console\.(log|info|warn|error)\([^;]*;/g) ?? [];
      for (const line of logs) {
        expect(line, `${file}: ${line}`).to.not.match(/answerMessageId|sessionKey|expectedProof|ciphertext|\brun\b|text/);
      }
    }
  });
});
