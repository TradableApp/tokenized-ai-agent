const { expect } = require("chai");
const { spawnSync } = require("child_process");
const path = require("path");

// The oracle used to build its wallet and contract while the module was being loaded, from
// PRIVATE_KEY. Its keys now arrive later (from the ROFL key service on a deployed network), so
// loading the module must need no key and touch no network.
describe("loading the oracle module", function () {
  this.timeout(60000);

  it("needs no PRIVATE_KEY and builds nothing until it is configured", () => {
    const env = { ...process.env, NETWORK_NAME: "baseSepolia" };
    delete env.PRIVATE_KEY;
    delete env.ENV_FILE;
    const script = `
      delete process.env.PRIVATE_KEY;
      const contractUtility = require("./src/contractUtility");
      let built = 0;
      contractUtility.initializeOracle = () => { built += 1; throw new Error("built at load"); };
      const oracle = require("./src/aiAgentOracle");
      if (typeof oracle.configure !== "function") { console.error("no configure"); process.exit(2); }
      if (built !== 0) { console.error("the wallet and contract were built at load"); process.exit(3); }
      oracle.getSessionKey("0x", "0x01", null).then(
        () => { console.error("decrypted without keys"); process.exit(4); },
        (error) => process.exit(error.message === "The oracle has not been given its keys" ? 0 : 5),
      );
    `;

    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: path.resolve(__dirname, ".."),
      env,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).to.equal(0);
  });
});
