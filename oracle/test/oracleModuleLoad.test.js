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
      const oracle = require("./src/aiAgentOracle");
      if (typeof oracle.configure !== "function") { console.error("no configure"); process.exit(2); }
      if (process.env.PRIVATE_KEY) { console.error("PRIVATE_KEY came back"); process.exit(3); }
      process.exit(0);
    `;

    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: path.resolve(__dirname, ".."),
      env,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).to.equal(0);
  });
});
