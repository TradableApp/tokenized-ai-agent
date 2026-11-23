"use strict";

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

/**
 * The agent runtime builds a logger of its own, which is not the framework's shared logger. When
 * the model's reply cannot be read, the runtime's message service warns with the start of that
 * reply, and other runtime lines carry an error's raw message. The logger is a plain property of
 * the runtime, so the oracle replaces it with one that cleans each line as the shared logger's
 * lines are cleaned: an error's text described, the model's reply and other text fields dropped.
 */
describe("the agent runtime's own logger", function () {
  const load = () => require("../src/elizaos/mutedFrameworkLogs");

  // A logger with the runtime logger's methods that records what it is called with.
  function recordingLogger() {
    const calls = [];
    const logger = { level: "warn", calls };
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal", "success", "log"]) {
      logger[level] = (...args) => calls.push([level, ...args]);
    }
    logger.child = () => recordingLogger();
    return logger;
  }

  const REPLY = "Bitcoin is trading near its high because you asked about my savings";

  it("drops the model's reply from the line it warns with when the reply cannot be read", function () {
    const original = recordingLogger();
    const logger = load().cleanedLogger(original);

    // The framework's own call (DefaultMessageService, @elizaos/core 1.7.2).
    logger.warn(
      { src: "service:message", responsePreview: REPLY.substring(0, 300) },
      "parseKeyValueXml returned null - XML parsing failed",
    );

    expect(original.calls).to.deep.equal([
      ["warn", { src: "service:message" }, "parseKeyValueXml returned null - XML parsing failed"],
    ]);
  });

  it("drops the actions the model chose, and keeps counts and flags", function () {
    const original = recordingLogger();

    load()
      .cleanedLogger(original)
      .warn(
        {
          src: "service:message",
          retries: 1,
          maxRetries: 3,
          hasThought: false,
          hasActions: true,
          actionsValue: ["REPLY", REPLY],
        },
        "Missing required fields (thought or actions), retrying",
      );

    expect(original.calls[0][1]).to.deep.equal({
      src: "service:message",
      retries: 1,
      maxRetries: 3,
      hasThought: false,
      hasActions: true,
    });
  });

  it("describes an error's message: its first line, without quoted values or addresses", function () {
    const original = recordingLogger();

    load()
      .cleanedLogger(original)
      .error(
        {
          src: "agent",
          error:
            'Embedding failed for "what should I buy" at https://rpc.example/v2/aB3dE6gH9jK2mN5pQ8sT\nthe rest of the text',
        },
        "Embedding generation failed",
      );

    expect(original.calls[0][1]).to.deep.equal({
      src: "agent",
      error: "Embedding failed for [value removed] at [address removed]",
    });
  });

  it("prints an error object as its description", function () {
    const original = recordingLogger();

    load()
      .cleanedLogger(original)
      .error(new Error(`model said: "${REPLY}"`));

    expect(original.calls[0]).to.deep.equal(["error", "model said: [value removed]"]);
  });

  it("does not print a line the shared logger does not print", function () {
    const original = recordingLogger();

    load()
      .cleanedLogger(original)
      .error("[WITH-MODEL-RETRY] Failed to parse response: Unexpected token");

    expect(original.calls).to.deep.equal([]);
  });

  it("cleans the lines of a logger made from it", function () {
    const original = recordingLogger();
    let made;
    original.child = () => {
      made = recordingLogger();
      return made;
    };

    load()
      .cleanedLogger(original)
      .child({ namespace: "x" })
      .warn({ responsePreview: REPLY }, "a warning");

    expect(made.calls).to.deep.equal([["warn", {}, "a warning"]]);
  });

  it("keeps the level it was given and is not wrapped twice", function () {
    const { cleanedLogger } = load();
    const once = cleanedLogger(recordingLogger());

    expect(once.level).to.equal("warn");
    expect(cleanedLogger(once)).to.equal(once);
  });

  it("is put on the runtime, and the oracle refuses a runtime where it cannot be", function () {
    const { cleanRuntimeLogger } = load();
    const runtime = { logger: recordingLogger() };

    cleanRuntimeLogger(runtime);
    runtime.logger.warn({ responsePreview: REPLY }, "a warning");

    expect(JSON.stringify(runtime.logger)).to.not.include(REPLY);
    expect(() => cleanRuntimeLogger(undefined)).to.throw(/runtime/);
    expect(() => cleanRuntimeLogger(Object.freeze({ logger: recordingLogger() }))).to.throw(
      /runtime/,
    );
  });

  describe("on a runtime the framework builds", function () {
    this.timeout(60000);

    // A child process, as the framework reads its log level once when it is loaded.
    function printed(lines) {
      const env = { ...process.env, LOG_LEVEL: "info" };
      delete env.ENV_FILE;
      const script = `
        require("./src/aiAgentOracle");
        const { AgentRuntime } = require("@elizaos/core");
        const { cleanRuntimeLogger } = require("./src/elizaos/mutedFrameworkLogs");
        const runtime = new AgentRuntime({ character: { name: "CleanProbe" } });
        cleanRuntimeLogger(runtime);
        ${lines}
      `;
      const result = spawnSync(process.execPath, ["-e", script], {
        cwd: path.resolve(__dirname, ".."),
        env,
        encoding: "utf8",
      });

      expect(result.status, result.stderr).to.equal(0);
      return `${result.stdout}\n${result.stderr}`;
    }

    it("prints neither the model's reply nor an error's raw message", function () {
      const all = printed(`
        runtime.logger.warn(
          { src: "service:message", responsePreview: ${JSON.stringify(REPLY)} },
          "parseKeyValueXml returned null - XML parsing failed",
        );
        runtime.logger.error(
          { src: "agent", error: 'Send failed: "my wallet holds a lot" at https://rpc.example/v2/aB3dE6gH9jK2mN5pQ8sT' },
          "Send handler failed",
        );
      `);

      expect(all).to.include("XML parsing failed");
      expect(all).to.include("Send handler failed");
      expect(all).to.not.include("Bitcoin is trading");
      expect(all).to.not.include("my wallet holds");
      expect(all).to.not.include("aB3dE6gH9jK2mN5pQ8sT");
    });
  });

  // What the replacement relies on, read from the installed framework, so an upgrade that
  // changes it fails here rather than printing again.
  describe("what the framework does, as the replacement relies on it", function () {
    const core = () =>
      fs.readFileSync(
        path.join(
          path.dirname(require.resolve("@elizaos/core/package.json")),
          "dist/node/index.node.js",
        ),
        "utf8",
      );

    it("builds the runtime's logger as a plain property in its constructor", function () {
      const { AgentRuntime } = require("@elizaos/core");
      const runtime = new AgentRuntime({ character: { name: "PropertyProbe" } });
      const descriptor = Object.getOwnPropertyDescriptor(runtime, "logger");

      expect(core()).to.include("this.logger = createLogger({");
      expect(descriptor, "an own property").to.not.equal(undefined);
      expect(descriptor.writable, "writable").to.equal(true);
    });

    it("reads the runtime's logger when it warns that the reply cannot be read", function () {
      expect(core()).to.include(
        'runtime.logger.warn({ src: "service:message", responsePreview: response.substring(0, 300) }',
      );
    });
  });

  it("is put on the oracle's agent before the agent is started", function () {
    const source = fs.readFileSync(path.resolve(__dirname, "../src/aiAgentOracle.js"), "utf8");
    const callback = source.indexOf("startAgents: async (agentIds) => {");
    const cleaned = source.indexOf("cleanRuntimeLogger(elizaOS.getAgent(", callback);
    const started = source.indexOf("await elizaOS.startAgents();", callback);

    expect(callback, "the start callback").to.be.greaterThan(-1);
    expect(cleaned, "the logger is replaced in it").to.be.greaterThan(callback);
    expect(started, "before the agent starts").to.be.greaterThan(cleaned);
  });
});
