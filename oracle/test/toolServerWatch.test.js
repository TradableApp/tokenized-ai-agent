"use strict";

const { expect } = require("chai");
const sinon = require("sinon");

const EXPECTED = { market_data: ["get_simple_price", "get_coins_markets"] };

// Short enough to wait out in a test, long enough to tell "before" from "after".
const CONFIRM_MS = 15;
const LATE_MS = 25;
const ALERT_EVERY_MS = 40;
const CHECK_EVERY_MS = 10;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pastConfirmation = () => wait(CONFIRM_MS * 4);

function connectedServer(overrides = {}) {
  return {
    name: "market_data",
    status: "connected",
    tools: [{ name: "get_simple_price" }, { name: "get_coins_markets" }, { name: "get_id_coins" }],
    ...overrides,
  };
}

/** What the framework told the agent when its service started: fixed from then on. */
function shownToAgent(servers) {
  const mcp = {};
  for (const server of servers) {
    mcp[server.name] = {
      status: server.status,
      tools: Object.fromEntries((server.tools || []).map((tool) => [tool.name, {}])),
    };
  }

  return { data: { mcp } };
}

function makeService({ servers = [connectedServer()], shown, callTool } = {}) {
  const snapshot = shown === undefined ? shownToAgent(servers) : shown;

  return {
    servers,
    getServers() {
      return this.servers;
    },
    getProviderData() {
      return snapshot;
    },
    callTool: callTool || (async () => ({ content: [{ type: "text", text: '{"usd":1}' }] })),
  };
}

function flaggedError(text) {
  return async () => ({ isError: true, content: [{ type: "text", text }] });
}

function makeWatch() {
  const alert = sinon.stub().resolves();
  const log = { log: sinon.spy(), warn: sinon.spy(), error: sinon.spy() };
  // Loaded here so a missing module fails each test, not the whole run.
  const { createToolServerWatch } = require("../src/elizaos/toolServerWatch");
  const watch = createToolServerWatch({
    expectedTools: EXPECTED,
    alert,
    log,
    timing: {
      lateAfterMs: LATE_MS,
      confirmLossAfterMs: CONFIRM_MS,
      alertEveryMs: ALERT_EVERY_MS,
      checkEveryMs: CHECK_EVERY_MS,
    },
  });

  return { watch, alert, log };
}

function printed(spy) {
  return spy
    .getCalls()
    .map((call) => call.args.join(" "))
    .join("\n");
}

function everythingSaid({ alert, log }) {
  const alerts = alert
    .getCalls()
    .map((call) => call.args.join(" "))
    .join("\n");

  return [printed(log.log), printed(log.warn), printed(log.error), alerts].join("\n");
}

describe("the tool server watch", function () {
  describe("at start-up", function () {
    it("says how many tools a connected server offers, and sends no alert", async function () {
      const { watch, alert, log } = makeWatch();
      watch.attach(makeService());

      const problems = await watch.reportAtStartup();

      expect(problems).to.deep.equal([]);
      expect(alert.called).to.equal(false);
      expect(printed(log.log)).to.match(/market_data.*connected.*3 tools/);
    });

    it("alerts when the server is not connected", async function () {
      const { watch, alert } = makeWatch();
      watch.attach(makeService({ servers: [connectedServer({ status: "disconnected" })] }));

      const problems = await watch.reportAtStartup();

      expect(problems).to.have.lengthOf(1);
      expect(alert.calledOnce).to.equal(true);
      expect(alert.firstCall.args[0]).to.match(/^CRITICAL: /);
      expect(alert.firstCall.args[1]).to.include("market_data").and.to.include("disconnected");
    });

    // The framework leaves a server that never connected at "connecting". Read alone that looks
    // like progress.
    it("calls a server left at connecting not connected", async function () {
      const { watch, alert } = makeWatch();
      watch.attach(makeService({ servers: [connectedServer({ status: "connecting" })] }));

      await watch.reportAtStartup();

      expect(alert.firstCall.args[1]).to.include("not connected");
    });

    it("alerts when the server is not there at all", async function () {
      const { watch, alert } = makeWatch();
      watch.attach(makeService({ servers: [] }));

      await watch.reportAtStartup();

      expect(alert.calledOnce).to.equal(true);
      expect(alert.firstCall.args[1]).to.include("market_data");
    });

    it("alerts, naming the tool, when a tool the oracle relies on is not offered", async function () {
      const { watch, alert } = makeWatch();
      watch.attach(
        makeService({ servers: [connectedServer({ tools: [{ name: "get_simple_price" }] })] }),
      );

      await watch.reportAtStartup();

      expect(alert.calledOnce).to.equal(true);
      expect(alert.firstCall.args[1]).to.include("get_coins_markets");
      expect(alert.firstCall.args[1]).to.not.include("get_simple_price,");
    });

    // The framework lists a server as connected, with no tools, when asking it for them failed.
    it("alerts, naming every tool it relies on, when a connected server lists none", async function () {
      const { watch, alert, log } = makeWatch();
      watch.attach(makeService({ servers: [connectedServer({ tools: [] })] }));

      const problems = await watch.reportAtStartup();

      expect(problems).to.have.lengthOf(1);
      expect(alert.firstCall.args[0]).to.match(/^CRITICAL: /);
      expect(alert.firstCall.args[1]).to.include("get_simple_price, get_coins_markets");
      expect(printed(log.log)).to.not.match(/connected, \d+ tools/);
    });

    it("alerts when the framework's tool service did not start", async function () {
      const { watch, alert } = makeWatch();
      watch.attach(null);

      const problems = await watch.reportAtStartup();

      expect(problems).to.have.lengthOf(1);
      expect(alert.calledOnce).to.equal(true);
    });

    // The framework tells the agent which tools exist once, when its service starts. A server
    // that connects after that is connected, and the agent still has no tools.
    it("asks for a restart when a server is connected but the agent was shown no tools", async function () {
      const { watch, alert } = makeWatch();
      watch.attach(makeService({ shown: shownToAgent([connectedServer({ tools: [] })]) }));

      const problems = await watch.reportAtStartup();

      expect(problems).to.have.lengthOf(1);
      expect(alert.firstCall.args[1]).to.include("market_data").and.to.include("restart");
    });

    // The framework leaves a server out of what it shows the agent only when the server was
    // not there when its service started.
    it("asks for a restart when the agent was shown nothing of the server at all", async function () {
      const { watch, alert } = makeWatch();
      watch.attach(makeService({ shown: { data: { mcp: {} } } }));

      await watch.reportAtStartup();

      expect(alert.firstCall.args[1]).to.include("restart");
    });

    it("asks for no restart when it cannot tell what the agent was shown", async function () {
      const { watch, alert } = makeWatch();
      const service = makeService();
      service.getProviderData = () => {
        throw new Error("not available");
      };
      watch.attach(service);

      expect(await watch.reportAtStartup()).to.deep.equal([]);
      expect(alert.called).to.equal(false);
    });

    it("still reports when the alert cannot be sent", async function () {
      const { watch, alert, log } = makeWatch();
      alert.rejects(new Error("no alert channel"));
      watch.attach(makeService({ servers: [] }));

      const problems = await watch.reportAtStartup();

      expect(problems).to.have.lengthOf(1);
      expect(printed(log.error)).to.include("market_data");
    });
  });

  describe("following the framework's tool service", function () {
    it("attaches to the service when the framework has started it, and reports", async function () {
      const { watch, alert, log } = makeWatch();
      const service = makeService();
      const runtime = {
        getServiceLoadPromise: sinon
          .stub()
          .returns(new Promise((resolve) => setTimeout(() => resolve(service), 5))),
      };

      await watch.follow(runtime);
      await service.callTool("market_data", "get_simple_price", {});

      expect(runtime.getServiceLoadPromise.calledOnceWithExactly("mcp")).to.equal(true);
      expect(alert.called).to.equal(false);
      expect(printed(log.log)).to.match(/market_data.*connected.*3 tools/);
      expect(watch.observe().calls.ok).to.equal(1);
    });

    // The service counts as started only after it has tried every server, which can take
    // minutes. Giving up on it would leave tool calls unwatched for the life of the process.
    it("reports a late service, and still attaches when it arrives", async function () {
      const { watch, alert, log } = makeWatch();
      const service = makeService();
      const runtime = {
        getServiceLoadPromise: () =>
          new Promise((resolve) => setTimeout(() => resolve(service), LATE_MS * 3)),
      };

      const followed = watch.follow(runtime);
      await wait(LATE_MS * 2);
      expect(alert.callCount).to.equal(1);
      expect(alert.firstCall.args[1]).to.include("did not start");

      await followed;
      await service.callTool("market_data", "get_simple_price", {});

      expect(watch.observe().calls.ok).to.equal(1);
      expect(alert.callCount).to.equal(1);
      expect(printed(log.warn)).to.match(/late/);
    });

    // With a server down the framework stops offering its tool, so no call fails, and the
    // heartbeat can be off or a quarter of an hour away.
    it("goes on looking at the servers by itself once it is following", async function () {
      const { watch, alert } = makeWatch();
      const service = makeService();
      await watch.follow({ getService: () => service });

      service.servers = [connectedServer({ status: "disconnected" })];
      await wait(CHECK_EVERY_MS * 2 + CONFIRM_MS * 4);
      watch.stop();

      expect(alert.callCount).to.equal(1);
      expect(alert.firstCall.args[0]).to.include("lost");
    });

    // The alert for a late service was seen where warnings are; so must its arrival be.
    it("says at warning level what a late service connected to", async function () {
      const { watch, log } = makeWatch();
      const service = makeService();
      const runtime = {
        getServiceLoadPromise: () =>
          new Promise((resolve) => setTimeout(() => resolve(service), LATE_MS * 3)),
      };

      await watch.follow(runtime);
      watch.stop();

      expect(printed(log.warn)).to.match(/market_data.*connected.*3 tools/);
    });

    it("does not send the same alert twice when a late service then fails", async function () {
      const { watch, alert } = makeWatch();
      const runtime = {
        getServiceLoadPromise: () =>
          new Promise((resolve, reject) =>
            setTimeout(() => reject(new Error("gone")), LATE_MS * 3),
          ),
      };

      await watch.follow(runtime);

      expect(alert.callCount).to.equal(1);
    });

    it("alerts, and does not reject, when the service fails to start", async function () {
      const { watch, alert, log } = makeWatch();
      const runtime = {
        getServiceLoadPromise: () => Promise.reject(new Error("no such service")),
      };

      await watch.follow(runtime);

      expect(alert.calledOnce).to.equal(true);
      expect(printed(log.error)).to.include("failed to start");
    });

    it("does not reject when asking the runtime throws", async function () {
      const { watch, alert } = makeWatch();
      const runtime = {
        getServiceLoadPromise() {
          throw new Error("runtime is gone");
        },
      };

      await watch.follow(runtime);

      expect(alert.calledOnce).to.equal(true);
    });

    it("asks a runtime that cannot be waited on for the service it has", async function () {
      const { watch, alert } = makeWatch();
      const service = makeService();

      await watch.follow({ getService: () => service });
      await service.callTool("market_data", "get_simple_price", {});

      expect(alert.called).to.equal(false);
      expect(watch.observe().calls.ok).to.equal(1);
    });

    it("reports a runtime that has no service", async function () {
      const { watch, alert } = makeWatch();

      await watch.follow({ getService: () => null });

      expect(alert.calledOnce).to.equal(true);
    });
  });

  describe("on a tool call", function () {
    it("passes a good result through and counts it", async function () {
      const { watch } = makeWatch();
      const service = makeService();
      watch.attach(service);

      const result = await service.callTool("market_data", "get_simple_price", { ids: "bitcoin" });

      expect(result.content[0].text).to.equal('{"usd":1}');
      expect(watch.observe().calls).to.deep.equal({ ok: 1, failed: 0, refused: 0, unclear: 0 });
    });

    it("calls the service's own method with the same arguments", async function () {
      const { watch } = makeWatch();
      const callTool = sinon.stub().resolves({ content: [] });
      const service = makeService({ callTool });
      watch.attach(service);

      await service.callTool("market_data", "get_simple_price", { ids: "bitcoin" });

      expect(
        callTool.calledOnceWithExactly("market_data", "get_simple_price", { ids: "bitcoin" }),
      ).to.equal(true);
      expect(callTool.firstCall.thisValue).to.equal(service);
    });

    it("throws when the server could not do its job, so the error never reaches the model as data", async function () {
      const { watch } = makeWatch();
      const service = makeService({ callTool: flaggedError("429 Too Many Requests") });
      watch.attach(service);

      let thrown = null;
      const result = await service
        .callTool("market_data", "get_simple_price", {})
        .catch((error) => {
          thrown = error;
        });

      expect(result).to.equal(undefined);
      expect(thrown).to.be.an("error");
      expect(thrown.name).to.equal("ToolCallFailedError");
      expect(thrown.message).to.include("market_data/get_simple_price");
      expect(thrown.message).to.include("status 429");
      expect(watch.observe().calls).to.deep.equal({ ok: 0, failed: 1, refused: 0, unclear: 0 });
    });

    // A tool's error text can repeat the arguments it was called with, and the model writes
    // those from the user's prompt. The framework prints the message of whatever is thrown.
    it("puts nothing the tool wrote into what it throws, prints or alerts", async function () {
      const said = makeWatch();
      const service = makeService({
        callTool: flaggedError("503 upstream said: no coin called a-users-private-question"),
      });
      said.watch.attach(service);

      const thrown = await service
        .callTool("market_data", "get_simple_price", { ids: "a-users-private-question" })
        .catch((error) => error);

      expect(thrown.message).to.equal("market_data/get_simple_price failed: status 503");
      expect(everythingSaid(said)).to.not.include("a-users-private-question");
      expect(everythingSaid(said)).to.not.include("upstream said");
    });

    // An error with no status is most often the model's own doing: a filter the server could
    // not run. Nothing says the server is at fault, so the model is given it, as before.
    it("hands an error with no status to the model, counted apart and not as a failure", async function () {
      const said = makeWatch();
      const service = makeService({
        callTool: flaggedError("jq: error: a-users-private-question is not defined"),
      });
      said.watch.attach(service);

      const result = await service.callTool("market_data", "get_simple_price", {});

      expect(result.isError).to.equal(true);
      expect(said.watch.observe().calls).to.deep.equal({
        ok: 0,
        failed: 0,
        refused: 0,
        unclear: 1,
      });
      expect(everythingSaid(said)).to.not.include("a-users-private-question");
    });

    // The server's own words for not reaching its provider. They carry no status.
    for (const text of ["Connection error.", "Request timed out."]) {
      it(`throws when the server says "${text}"`, async function () {
        const { watch } = makeWatch();
        const service = makeService({ callTool: flaggedError(text) });
        watch.attach(service);

        const thrown = await service
          .callTool("market_data", "get_simple_price", {})
          .catch((e) => e);

        expect(thrown.message).to.equal("market_data/get_simple_price failed: no connection");
        expect(watch.observe().calls.failed).to.equal(1);
      });
    }

    // The framework lets the model name any property of its tool table, and a server names its
    // own tools. Only a name the server offers is printed.
    it("prints a tool the server does not offer as other", async function () {
      const said = makeWatch();
      const service = makeService({ callTool: flaggedError("503") });
      said.watch.attach(service);

      const thrown = await service
        .callTool("market_data", "a-users-private-question", {})
        .catch((e) => e);

      expect(thrown.message).to.equal("market_data/other failed: status 503");
      expect(everythingSaid(said)).to.not.include("a-users-private-question");
    });

    it("counts a call that got no answer, and throws its own error, not the service's", async function () {
      const said = makeWatch();
      const service = makeService({
        callTool: async () => {
          throw new Error("No connection: a-users-private-question");
        },
      });
      said.watch.attach(service);

      const thrown = await service.callTool("market_data", "get_simple_price", {}).catch((e) => e);

      expect(thrown.name).to.equal("ToolCallFailedError");
      expect(thrown.message).to.equal("market_data/get_simple_price failed: no answer");
      expect(everythingSaid(said)).to.not.include("a-users-private-question");
      expect(said.watch.observe().calls).to.deep.equal({
        ok: 0,
        failed: 1,
        refused: 0,
        unclear: 0,
      });
    });

    // What the framework's own client throws, told apart by its code and never by its text.
    for (const [code, outcome] of [
      [-32001, "timed out"],
      [-32000, "connection closed"],
    ]) {
      it(`says "${outcome}" for a call thrown with code ${code}`, async function () {
        const { watch } = makeWatch();
        const service = makeService({
          callTool: async () => {
            throw Object.assign(new Error("MCP error: a-users-private-question"), { code });
          },
        });
        watch.attach(service);

        const thrown = await service
          .callTool("market_data", "get_simple_price", {})
          .catch((e) => e);

        expect(thrown.message).to.equal(`market_data/get_simple_price failed: ${outcome}`);
        expect(watch.observe().calls.failed).to.equal(1);
      });
    }

    it("counts a call the server threw back as invalid as refused, not failed", async function () {
      const { watch } = makeWatch();
      const service = makeService({
        callTool: async () => {
          throw Object.assign(new Error("MCP error -32602: bad arguments"), { code: -32602 });
        },
      });
      watch.attach(service);

      const thrown = await service.callTool("market_data", "get_simple_price", {}).catch((e) => e);

      expect(thrown.message).to.equal("market_data/get_simple_price failed: invalid request");
      expect(watch.observe().calls).to.deep.equal({ ok: 0, failed: 0, refused: 1, unclear: 0 });
    });

    // "No such coin" is the server working. The model is given the result, as before, and can
    // say so or try another id; throwing would send a good run to another provider.
    for (const status of [400, 404, 422]) {
      it(`hands a ${status} to the model and counts it as refused, not failed`, async function () {
        const { watch, log } = makeWatch();
        const service = makeService({ callTool: flaggedError(`${status} coin not found`) });
        watch.attach(service);

        const result = await service.callTool("market_data", "get_simple_price", {});

        expect(result.isError).to.equal(true);
        expect(watch.observe().calls).to.deep.equal({ ok: 0, failed: 0, refused: 1, unclear: 0 });
        expect(printed(log.log)).to.include(`status ${status}`);
        expect(printed(log.log)).to.not.include("coin not found");
      });
    }

    it("prints one line per call with the server, the tool and the outcome", async function () {
      const { watch, log } = makeWatch();
      const service = makeService();
      watch.attach(service);

      await service.callTool("market_data", "get_simple_price", { ids: "bitcoin" });

      expect(printed(log.log)).to.match(/market_data\/get_simple_price.*ok/);
    });

    it("wraps a service once, however often it is attached", async function () {
      const { watch } = makeWatch();
      const service = makeService();
      watch.attach(service);
      watch.attach(service);
      watch.attach(null);
      watch.attach(service);

      await service.callTool("market_data", "get_simple_price", {});

      expect(watch.observe().calls).to.deep.equal({ ok: 1, failed: 0, refused: 0, unclear: 0 });
    });

    it("keeps watching the service it has when handed nothing", function () {
      const { watch } = makeWatch();
      watch.attach(makeService());
      watch.attach(null);

      expect(watch.observe().servers.market_data.status).to.equal("connected");
    });

    it("says so, and does not throw, when the service cannot be wrapped", function () {
      const { watch, log } = makeWatch();

      expect(() => watch.attach(Object.freeze(makeService()))).to.not.throw();
      expect(printed(log.error)).to.include("could not watch tool calls");
    });
  });

  // A key that stopped working fails every call while the server stays connected and goes on
  // listing its tools. Nothing but the calls shows it.
  describe("when calls keep failing", function () {
    async function failTimes(service, times) {
      for (let i = 0; i < times; i += 1) {
        await service.callTool("market_data", "get_simple_price", {}).catch(() => {});
      }
    }

    function switchableService() {
      const service = makeService();
      service.mode = "failing";
      service.callTool = async function callTool() {
        if (this.mode === "failing") return { isError: true, content: [{ text: "401 bad key" }] };
        if (this.mode === "refusing") return { isError: true, content: [{ text: "404 no coin" }] };

        return { content: [{ type: "text", text: "{}" }] };
      };

      return service;
    }

    it("alerts once after five in a row, naming the outcome and not the tool's words", async function () {
      const { watch, alert } = makeWatch();
      const service = switchableService();
      watch.attach(service);
      await watch.reportAtStartup();

      await failTimes(service, 4);
      expect(alert.called).to.equal(false);
      await failTimes(service, 3);

      expect(alert.callCount).to.equal(1);
      expect(alert.firstCall.args[0]).to.match(/^CRITICAL: /);
      expect(alert.firstCall.args[1]).to.include("status 401").and.to.include("key");
      expect(alert.firstCall.args[1]).to.not.include("bad key");
    });

    it("does not alert for failures with a success between them", async function () {
      const { watch, alert } = makeWatch();
      const service = switchableService();
      watch.attach(service);
      await watch.reportAtStartup();

      await failTimes(service, 4);
      service.mode = "working";
      await service.callTool("market_data", "get_simple_price", {});
      service.mode = "failing";
      await failTimes(service, 4);

      expect(alert.called).to.equal(false);
    });

    // A rate limit that lets one call in three through never fails five times in a row.
    it("alerts when half of the last twenty calls failed, though never five in a row", async function () {
      const { watch, alert } = makeWatch();
      const service = switchableService();
      watch.attach(service);
      await watch.reportAtStartup();

      for (let round = 0; round < 5; round += 1) {
        service.mode = "failing";
        await failTimes(service, 2);
        service.mode = "working";
        await service.callTool("market_data", "get_simple_price", {});
      }

      expect(alert.callCount).to.equal(1);
      expect(alert.firstCall.args[1]).to.include("10 of the last");
    });

    // A refusal is an answer: the server reached its provider and the key was accepted.
    it("takes a refused request as a sign the server is working", async function () {
      const { watch, alert } = makeWatch();
      const service = switchableService();
      watch.attach(service);
      await watch.reportAtStartup();

      await failTimes(service, 4);
      service.mode = "refusing";
      await service.callTool("market_data", "get_simple_price", {});
      service.mode = "failing";
      await failTimes(service, 4);

      expect(alert.called).to.equal(false);
    });

    // A provider that fails, answers once and fails again would otherwise alert every few calls.
    it("says when calls work again, and does not alert again straight away", async function () {
      const { watch, alert, log } = makeWatch();
      const service = switchableService();
      watch.attach(service);
      await watch.reportAtStartup();

      await failTimes(service, 5);
      service.mode = "working";
      await service.callTool("market_data", "get_simple_price", {});
      service.mode = "failing";
      await failTimes(service, 5);

      expect(printed(log.warn)).to.match(/working again/);
      expect(alert.callCount).to.equal(1);
    });

    it("alerts again for a new run of failures once some time has passed", async function () {
      const { watch, alert } = makeWatch();
      const service = switchableService();
      watch.attach(service);
      await watch.reportAtStartup();

      await failTimes(service, 5);
      service.mode = "working";
      await service.callTool("market_data", "get_simple_price", {});
      await wait(ALERT_EVERY_MS * 2);
      service.mode = "failing";
      await failTimes(service, 5);

      expect(alert.callCount).to.equal(2);
    });

    // A key of the wrong kind, or an endpoint that has gone, is refused every time. One refusal
    // is the model's mistake; nothing but refusals is not.
    it("alerts when ten calls are refused and none answered", async function () {
      const { watch, alert } = makeWatch();
      const service = switchableService();
      service.mode = "refusing";
      watch.attach(service);
      await watch.reportAtStartup();

      for (let i = 0; i < 9; i += 1) await service.callTool("market_data", "get_simple_price", {});
      expect(alert.called).to.equal(false);
      await service.callTool("market_data", "get_simple_price", {});

      expect(alert.callCount).to.equal(1);
      expect(alert.firstCall.args[1]).to.include("refused").and.to.include("status 404");
    });

    // Failures between the refusals do not start the count again: still none was answered.
    // The alert must not then say that the last ten calls were all refusals.
    it("counts refusals since a call was last answered, across failures between them", async function () {
      const { watch, alert } = makeWatch();
      const service = switchableService();
      watch.attach(service);
      await watch.reportAtStartup();

      service.mode = "refusing";
      for (let i = 0; i < 5; i += 1) await service.callTool("market_data", "get_simple_price", {});
      service.mode = "failing";
      await failTimes(service, 4);
      service.mode = "refusing";
      for (let i = 0; i < 5; i += 1) await service.callTool("market_data", "get_simple_price", {});

      expect(alert.callCount).to.equal(1);
      expect(alert.firstCall.args[1]).to.include("10 market-data tool calls have been refused");
      expect(alert.firstCall.args[1]).to.include("since one was last answered");
      expect(alert.firstCall.args[1]).to.not.include("The last 10");
    });

    it("does not, when a call was answered among the refusals", async function () {
      const { watch, alert } = makeWatch();
      const service = switchableService();
      watch.attach(service);
      await watch.reportAtStartup();

      service.mode = "refusing";
      for (let i = 0; i < 9; i += 1) await service.callTool("market_data", "get_simple_price", {});
      service.mode = "working";
      await service.callTool("market_data", "get_simple_price", {});
      service.mode = "refusing";
      for (let i = 0; i < 9; i += 1) await service.callTool("market_data", "get_simple_price", {});

      expect(alert.called).to.equal(false);
    });
  });

  describe("observed for the heartbeat", function () {
    it("gives each expected server's state and tool count, and the counts", function () {
      const { watch } = makeWatch();
      watch.attach(makeService());

      expect(watch.observe()).to.deep.equal({
        servers: { market_data: { status: "connected", tools: 3, usable: true } },
        calls: { ok: 0, failed: 0, refused: 0, unclear: 0 },
        rejectedRuns: { toolError: 0, noTool: 0, unreadable: 0 },
      });
    });

    // Only the first of these says the tools are at fault. The other two are the model's.
    it("counts the runs thrown away, by what went wrong", function () {
      const { watch } = makeWatch();
      watch.countRejectedRun("toolError");
      watch.countRejectedRun("toolError");
      watch.countRejectedRun("noTool");
      watch.countRejectedRun("unreadable");
      watch.countRejectedRun("something-else");

      expect(watch.observe().rejectedRuns).to.deep.equal({
        toolError: 3,
        noTool: 1,
        unreadable: 1,
      });
    });

    it("says a server is absent when the service does not list it", function () {
      const { watch } = makeWatch();
      watch.attach(makeService({ servers: [] }));

      expect(watch.observe().servers).to.deep.equal({
        market_data: { status: "absent", tools: 0, usable: false },
      });
    });

    it("never throws, whatever the service does", function () {
      const { watch } = makeWatch();
      watch.attach({
        getServers() {
          throw new Error("service is gone");
        },
        callTool: async () => ({}),
      });

      expect(watch.observe().servers).to.deep.equal({
        market_data: { status: "unknown", tools: 0, usable: false },
      });
    });

    // The heartbeat starts before the agent does. A server that has not been started yet is not
    // a server that was lost.
    it("raises nothing before the start-up report has run", async function () {
      const { watch, alert } = makeWatch();

      const observed = watch.observe();
      await pastConfirmation();

      expect(observed.servers).to.deep.equal({
        market_data: { status: "unknown", tools: 0, usable: false },
      });
      expect(alert.called).to.equal(false);
    });

    it("alerts once when a connected server stays lost, and not again", async function () {
      const { watch, alert } = makeWatch();
      const service = makeService();
      watch.attach(service);
      await watch.reportAtStartup();

      service.servers = [connectedServer({ status: "disconnected" })];
      watch.observe();
      watch.observe();
      expect(alert.called).to.equal(false);
      await pastConfirmation();
      watch.observe();
      await pastConfirmation();

      expect(alert.callCount).to.equal(1);
      expect(alert.firstCall.args[1]).to.include("market_data");
    });

    // The framework drops and re-makes a connection in a couple of seconds. That is not a loss.
    it("does not alert for a server that is back by the second look", async function () {
      const { watch, alert } = makeWatch();
      const service = makeService();
      watch.attach(service);
      await watch.reportAtStartup();

      service.servers = [connectedServer({ status: "disconnected" })];
      watch.observe();
      service.servers = [connectedServer()];
      await pastConfirmation();

      expect(alert.called).to.equal(false);
    });

    // Without this a loss would wait for the next heartbeat, a quarter of an hour away.
    it("looks at the servers when a call fails, without waiting to be observed", async function () {
      const { watch, alert } = makeWatch();
      const service = makeService({
        callTool: async () => {
          throw new Error("No connection");
        },
      });
      watch.attach(service);
      await watch.reportAtStartup();

      service.servers = [connectedServer({ status: "disconnected" })];
      await service.callTool("market_data", "get_simple_price", {}).catch(() => {});
      await pastConfirmation();

      expect(alert.callCount).to.equal(1);
      expect(alert.firstCall.args[0]).to.include("lost");
    });

    // Said at warning level: the machine's logs show warnings and errors, and the alert it
    // follows was seen there.
    it("says so when it is back, and alerts again on the next loss", async function () {
      const { watch, alert, log } = makeWatch();
      const service = makeService();
      watch.attach(service);
      await watch.reportAtStartup();

      service.servers = [connectedServer({ status: "disconnected" })];
      watch.observe();
      await pastConfirmation();
      service.servers = [connectedServer()];
      watch.observe();
      service.servers = [];
      watch.observe();
      await pastConfirmation();

      expect(printed(log.warn)).to.match(/market_data.*connected again/);
      expect(alert.callCount).to.equal(2);
    });

    // A server that connects just after the framework's service started is connected, and the
    // agent was shown none of its tools. The first alert said "not connected"; this is different
    // news, and the fix is different.
    it("alerts again when a server reported at start-up turns out to need a restart", async function () {
      const { watch, alert } = makeWatch();
      const late = connectedServer({ status: "connecting", tools: [] });
      const service = makeService({ servers: [late], shown: shownToAgent([late]) });
      watch.attach(service);
      await watch.reportAtStartup();

      service.servers = [connectedServer()];
      const observed = watch.observe();
      watch.observe();

      expect(alert.callCount).to.equal(2);
      expect(alert.secondCall.args[1]).to.include("restart");
      expect(observed.servers.market_data).to.deep.equal({
        status: "connected",
        tools: 3,
        usable: false,
      });
    });

    it("does not alert a second time for a server that was already reported at start-up", async function () {
      const { watch, alert } = makeWatch();
      watch.attach(makeService({ servers: [] }));
      await watch.reportAtStartup();

      watch.observe();
      await pastConfirmation();
      watch.observe();

      expect(alert.callCount).to.equal(1);
    });
  });
});
