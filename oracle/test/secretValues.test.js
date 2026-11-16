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

      expect(lines).to.deep.equal([{ method: "log", args: ["identity", "key=[REDACTED]"] }]);
    });

    it("removes it from an error's message and stack", () => {
      registerSecretValue(KEY);
      const { target, lines } = capture();

      target.error("failed:", new Error(`bad key ${KEY}`));

      const printed = lines[0].args[1];
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
