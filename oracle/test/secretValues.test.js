const { expect } = require("chai");

const {
  registerSecretValue,
  redactSecrets,
  wrapConsole,
  forgetSecretValuesForTest,
} = require("../src/secretValues");

const KEY = "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

describe("secret values", () => {
  afterEach(() => forgetSecretValuesForTest());

  it("leaves text alone while nothing is registered", () => {
    expect(redactSecrets(`key ${KEY}`)).to.equal(`key ${KEY}`);
  });

  it("removes a registered value written in either case, with or without 0x", () => {
    registerSecretValue(`0x${KEY}`);

    expect(redactSecrets(`a ${KEY} b`)).to.equal("a [REDACTED] b");
    expect(redactSecrets(`a 0x${KEY.toUpperCase()} b`)).to.equal("a 0x[REDACTED] b");
  });

  it("registers bytes as their hex", () => {
    registerSecretValue(new Uint8Array(Buffer.from(KEY, "hex")));

    expect(redactSecrets(KEY)).to.equal("[REDACTED]");
  });

  it("refuses a value too short to be a key, which would blank ordinary text", () => {
    expect(() => registerSecretValue("abcd")).to.throw(/at least 32/);
  });

  it("removes the key in its base64 and byte-list forms from text", () => {
    const bytes = Buffer.from(KEY, "hex");
    registerSecretValue(KEY);

    expect(redactSecrets(`a ${bytes.toString("base64")} b`)).to.equal("a [REDACTED] b");
    expect(redactSecrets(`[${Array.from(bytes).join(", ")}]`)).to.equal("[[REDACTED]]");
    expect(redactSecrets(`<Buffer ${KEY.match(/../g).join(" ")}>`)).to.equal("<Buffer [REDACTED]>");
  });

  it("returns what is not a string as it is", () => {
    registerSecretValue(KEY);
    const object = { a: 1 };

    expect(redactSecrets(object)).to.equal(object);
    expect(redactSecrets(undefined)).to.equal(undefined);
  });

  describe("the console wrapper", () => {
    function capture() {
      const lines = [];
      const target = {};
      for (const method of ["log", "info", "warn", "error", "debug"]) {
        target[method] = (...args) => lines.push({ method, args });
      }
      wrapConsole(target);

      return { target, lines };
    }

    it("removes a registered value from a string argument", () => {
      registerSecretValue(KEY);
      const { target, lines } = capture();

      target.log("identity", `key=${KEY}`);

      expect(lines).to.deep.equal([{ method: "log", args: ["identity key=[REDACTED]"] }]);
    });

    it("removes it from an error's message and stack", () => {
      registerSecretValue(KEY);
      const { target, lines } = capture();

      target.error("failed:", new Error(`bad key ${KEY}`));

      const printed = lines[0].args[0];
      expect(printed).to.be.a("string");
      expect(printed).to.include("bad key [REDACTED]");
      expect(printed).to.not.include(KEY);
    });

    it("removes it from inside an object", () => {
      registerSecretValue(KEY);
      const { target, lines } = capture();

      target.warn({ nested: { value: `0x${KEY}` } });

      expect(JSON.stringify(lines[0].args)).to.not.include(KEY);
    });

    it("passes an object without the value through untouched", () => {
      registerSecretValue(KEY);
      const { target, lines } = capture();
      const harmless = { block: 12 };

      target.info(harmless);

      expect(lines[0].args[0]).to.equal(harmless);
    });

    it("removes a value put together by the format string", () => {
      registerSecretValue(KEY);
      const { target, lines } = capture();

      target.log("%s%s", KEY.slice(0, 32), KEY.slice(32));

      expect(lines[0].args).to.deep.equal(["[REDACTED]"]);
    });

    it("removes the key shown as bytes, as a buffer or in base64", () => {
      const bytes = Buffer.from(KEY, "hex");
      registerSecretValue(KEY);
      const { target, lines } = capture();

      target.log("buffer", bytes);
      target.log("bytes", new Uint8Array(bytes));
      target.log("base64", bytes.toString("base64"));
      target.log({ nested: [new Uint8Array(bytes)] });

      const printed = JSON.stringify(lines);
      expect(printed).to.not.include(bytes.toString("base64"));
      expect(printed).to.not.include(Array.from(bytes).join(", "));
      expect(printed).to.not.include(KEY.match(/../g).join(" "));
      expect(printed.match(/\[REDACTED\]/g)).to.have.length(4);
    });

    it("covers console.dir as well", () => {
      registerSecretValue(KEY);
      const lines = [];
      const target = { dir: (...args) => lines.push(args), log() {} };
      wrapConsole(target);

      target.dir({ key: KEY }, { depth: null });

      expect(JSON.stringify(lines)).to.not.include(KEY);
      expect(lines[0][1], "the caller's options are passed on").to.deep.equal({ depth: null });
    });

    it("wraps a console once, however often it is asked", () => {
      registerSecretValue(KEY);
      const { target, lines } = capture();
      wrapConsole(target);

      target.log(KEY);

      expect(lines).to.have.length(1);
      expect(lines[0].args).to.deep.equal(["[REDACTED]"]);
    });
  });
});
