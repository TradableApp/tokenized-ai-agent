const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

// The Base mainnet compose file is the testnet one with mainnet values: the oracle reads the same
// settings on both networks. A setting only one of them lists is either missing on the other
// (the oracle starts without it) or left over (a key the oracle never reads, which still costs a
// secret slot). Settings that belong to one network alone are named here.
const ROOT = path.join(__dirname, "..");
const TESTNET = "compose.base-testnet.yaml";
const MAINNET = "compose.base-mainnet.yaml";
const ONLY_ON = Object.freeze({ [TESTNET]: [], [MAINNET]: [] });

/** The names in the oracle service's `environment:` list, in order. */
function settingNames(file) {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  const names = [];
  for (const line of text.split("\n")) {
    const match = /^\s+-\s+([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

describe("compose files — Base testnet and Base mainnet list the same settings", function () {
  it("lists each setting once in each file", function () {
    for (const file of [TESTNET, MAINNET]) {
      const names = settingNames(file);
      const repeated = names.filter((name, i) => names.indexOf(name) !== i);
      expect(repeated, file).to.deep.equal([]);
      expect(names.length, file).to.be.greaterThan(0);
    }
  });

  it("lists the same names, apart from those named for one network", function () {
    const testnet = new Set(settingNames(TESTNET));
    const mainnet = new Set(settingNames(MAINNET));
    const onlyTestnet = [...testnet].filter((n) => !mainnet.has(n));
    const onlyMainnet = [...mainnet].filter((n) => !testnet.has(n));
    expect(onlyTestnet.sort(), `only in ${TESTNET}`).to.deep.equal([...ONLY_ON[TESTNET]].sort());
    expect(onlyMainnet.sort(), `only in ${MAINNET}`).to.deep.equal([...ONLY_ON[MAINNET]].sort());
  });

  it("keeps secrets as secrets: a name injected from a ROFL secret on one is injected on the other", function () {
    const injected = (file) =>
      fs
        .readFileSync(path.join(ROOT, file), "utf8")
        .split("\n")
        .map((line) => /^\s+-\s+([A-Za-z_][A-Za-z0-9_]*)=\$\{\1:-\}\s*$/.exec(line))
        .filter(Boolean)
        .map((m) => m[1])
        .sort();
    expect(injected(MAINNET)).to.deep.equal(injected(TESTNET));
  });
});
