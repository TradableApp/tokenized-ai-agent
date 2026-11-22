const { expect } = require("chai");
const sinon = require("sinon");

const {
  describeError,
  describedText,
  withoutQueryDetail,
  MAX_RAW_INPUT,
  MAX_DESCRIBED_LENGTH,
} = require("../src/errorDescription");
const { withoutNetworkPeers } = require("../src/networkPeers");

/**
 * The describer runs on the oracle's event loop, on error messages of any length, some of them
 * echoing input the oracle did not write. Its cost is bounded by construction: the raw text is
 * cut to MAX_RAW_INPUT before any pattern runs, and no pattern it runs can backtrack over a long
 * run. These pin both: the length every pattern is handed, and adversarial inputs.
 */
describe("the describer's cost is bounded", () => {
  afterEach(() => sinon.restore());

  /** The longest string any pattern was run on while `fn` ran. */
  function longestPatternInput(fn) {
    let longest = 0;
    const note = (text) => {
      longest = Math.max(longest, String(text).length);
    };
    for (const method of ["replace", "replaceAll", "split", "match", "matchAll", "search"]) {
      const original = String.prototype[method];
      sinon.replace(String.prototype, method, function patternCall(...args) {
        if (args[0] instanceof RegExp) note(this);
        return original.apply(this, args);
      });
    }
    for (const method of ["test", "exec"]) {
      const original = RegExp.prototype[method];
      sinon.replace(RegExp.prototype, method, function patternCall(text) {
        note(text);
        return original.call(this, text);
      });
    }
    fn();
    sinon.restore();
    return longest;
  }

  it("bounds the raw input well above the cap", () => {
    expect(MAX_RAW_INPUT).to.be.at.least(MAX_DESCRIBED_LENGTH * 4);
  });

  it("hands no pattern more than the bound, whatever the message's length", () => {
    const huge = `${"connect ECONNREFUSED 192.0.2.10:5432 ".repeat(30000)}\nparams: x`;

    const longest = longestPatternInput(() => {
      describeError(new Error(huge));
      describeError(Object.assign(new Error(huge), { code: "23505" }));
      describedText(huge);
    });

    expect(longest).to.be.at.most(MAX_RAW_INPUT);
  });

  const adversarial = [
    ["100,000 spaces with no params", `x${" ".repeat(100000)}y`, "x"],
    ["100,000 params without the colon", "params ".repeat(100000), "params params"],
    ["a long run that almost makes an address", "a:/".repeat(100000), "a:/a:/"],
    ["a long run that almost makes hex", `0x${"0x".repeat(100000)}`, "0x0x"],
    ["a long run that almost makes a JWT", "eyJ-".repeat(100000), "eyJ-eyJ-"],
    ["a long run that almost makes an IPv4 address", "1.".repeat(100000), "1.1."],
    ["a long run that almost makes an IPv6 address", "[::".repeat(100000), "["],
    ["a long run that almost makes a host and port", "a.a.".repeat(100000), "a.a."],
    ["a long run of TLS labels with no colon", `Host${" ".repeat(100000)}x`, "Host"],
  ];

  for (const [shape, text, start] of adversarial) {
    it(`describes ${shape} at once, capped`, () => {
      // A run as long as the bound, ended by a space so nothing of it is cut: every pattern
      // runs over all of it.
      const fullRun = `${text.slice(0, MAX_RAW_INPUT - 1)} `;
      const started = Date.now();

      const described = describedText(text);
      const describedRun = describedText(fullRun);

      expect(described.length).to.be.at.most(MAX_DESCRIBED_LENGTH);
      expect(describedRun.length).to.be.at.most(MAX_DESCRIBED_LENGTH);
      expect(describedRun.startsWith(start), describedRun.slice(0, 40)).to.equal(true);
      // Secondary, and generous: the bound above is what holds the cost.
      expect(Date.now() - started).to.be.below(2000);
    });
  }

  it("drops a failed query's detail with no pattern over the whole text", () => {
    const text = `x${" ".repeat(100000)}`;

    const longest = longestPatternInput(() => withoutQueryDetail(text));

    expect(longest).to.equal(0);
    expect(withoutQueryDetail("insert failed  params: a, b")).to.equal("insert failed");
    expect(withoutQueryDetail("Error: Failed query: select 1\nparams: x")).to.equal(
      "Error: Failed query",
    );
    expect(withoutQueryDetail("no detail here")).to.equal("no detail here");
  });

  it("removes network peers from long text in linear time", () => {
    const started = Date.now();

    withoutNetworkPeers(
      `Host${" ".repeat(100000)} port${" ".repeat(100000)} server at${" ".repeat(100000)}`,
    );

    expect(Date.now() - started).to.be.below(2000);
  });

  // The raw bound falls inside a word: what is left of it must not survive, since a prefix of a
  // key is still a key. The text before it shrinks when cleaned, so the remainder would reach the
  // output if it were kept.
  it("drops the token the raw bound falls in", () => {
    const key = "Kq7Lm2Np9Rs4Tv6Wx8Yz3Ab5Cd7Ef9Gh";
    const lead = `https://h.example/${"a".repeat(MAX_RAW_INPUT - 40)}`;
    for (let shift = 0; shift < 20; shift += 1) {
      const text = `${lead}${"b".repeat(shift)} ${key} tail`;

      const described = describedText(text);

      expect(described, String(shift)).to.not.include(key.slice(0, 6));
      expect(described).to.match(/^\[address removed\]/);
    }
  });
});
