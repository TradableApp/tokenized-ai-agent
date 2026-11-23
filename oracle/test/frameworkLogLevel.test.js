const { expect } = require("chai");
const { spawnSync } = require("child_process");
const path = require("path");

/**
 * The agent runtime the oracle starts has a logger of its own, which writes to the console
 * directly and is not the framework's shared logger. The oracle cleans both (runtimeLogger.test.js
 * for the runtime's), and also holds the framework at warning level, since information and debug
 * lines can carry a query's text, its bound values and a peer: warnings and errors are still
 * printed.
 */
describe("the framework's log level", () => {
  // Read in each test, so the oracle tests below run whether or not this module loads.
  const heldFrameworkLogLevel = (level) =>
    require("../src/elizaos/frameworkLogLevel").heldFrameworkLogLevel(level);
  const holdFrameworkLogLevel = (env) =>
    require("../src/elizaos/frameworkLogLevel").holdFrameworkLogLevel(env);

  it("is warn when nothing, or anything looser than warn, is set", () => {
    for (const level of [undefined, "", "info", "debug", "trace", "verbose", "log", "progress"]) {
      expect(heldFrameworkLogLevel(level), String(level)).to.equal("warn");
    }
  });

  it("keeps a level the operator set that is at least as strict, in any case", () => {
    for (const level of ["warn", "error", "fatal", "alert", "ERROR", "Warn"]) {
      expect(heldFrameworkLogLevel(level)).to.equal(level);
    }
  });

  // The framework reads a level it does not know as information.
  it("is warn for a level the framework does not know", () => {
    for (const level of ["silent", "none", " error", "error ", "50"]) {
      expect(heldFrameworkLogLevel(level), JSON.stringify(level)).to.equal("warn");
    }
  });

  it("is set in the environment it is given", () => {
    const env = { LOG_LEVEL: "debug" };

    holdFrameworkLogLevel(env);

    expect(env.LOG_LEVEL).to.equal("warn");
  });

  describe("in the oracle", function () {
    this.timeout(60000);

    /** What the runtime's logger prints at each level, built after the oracle module loads. */
    function runtimeLines(logLevel) {
      const env = { ...process.env, LOG_LEVEL: logLevel };
      delete env.ENV_FILE;
      const script = `
        require("./src/aiAgentOracle");
        const { AgentRuntime, elizaLogger } = require("@elizaos/core");
        const runtime = new AgentRuntime({ character: { name: "LevelProbe" } });
        if (runtime.logger === elizaLogger) { console.error("SAME_LOGGER"); }
        runtime.logger.debug("PROBE_DEBUG_LINE");
        runtime.logger.info("PROBE_INFO_LINE");
        runtime.logger.warn("PROBE_WARN_LINE");
        runtime.logger.error("PROBE_ERROR_LINE");
      `;

      const result = spawnSync(process.execPath, ["-e", script], {
        cwd: path.resolve(__dirname, ".."),
        env,
        encoding: "utf8",
      });

      expect(result.status, result.stderr).to.equal(0);
      return { stdout: result.stdout, all: `${result.stdout}\n${result.stderr}` };
    }

    it("is a logger of the runtime's own, not the shared one the oracle cleans", () => {
      expect(runtimeLines("").all).to.not.include("SAME_LOGGER");
    });

    it("prints no information or debug line from the runtime, and its warnings", () => {
      for (const level of ["", "info", "debug"]) {
        const { stdout, all } = runtimeLines(level);

        expect(stdout, level).to.not.include("PROBE_INFO_LINE");
        expect(all, level).to.not.include("PROBE_INFO_LINE");
        expect(all, level).to.not.include("PROBE_DEBUG_LINE");
        expect(all, level).to.include("PROBE_WARN_LINE");
        expect(all, level).to.include("PROBE_ERROR_LINE");
      }
    });

    it("never loosens a stricter level the operator set", () => {
      const { all } = runtimeLines("error");

      expect(all).to.not.include("PROBE_WARN_LINE");
      expect(all).to.include("PROBE_ERROR_LINE");
    });
  });
});
