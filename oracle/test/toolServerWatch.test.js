"use strict";

const { expect } = require("chai");
const sinon = require("sinon");

const EXPECTED = { market_data: ["get_simple_price", "get_coins_markets"] };

function connectedServer(overrides = {}) {
  return {
    name: "market_data",
    status: "connected",
    tools: [{ name: "get_simple_price" }, { name: "get_coins_markets" }, { name: "get_id_coins" }],
    ...overrides,
  };
}

function makeService({ servers = [connectedServer()], callTool } = {}) {
  return {
    servers,
    getServers() {
      return this.servers;
    },
    callTool: callTool || (async () => ({ content: [{ type: "text", text: '{"usd":1}' }] })),
  };
}

function makeWatch() {
  const alert = sinon.stub().resolves();
  const log = { log: sinon.spy(), warn: sinon.spy(), error: sinon.spy() };
  // Loaded here so a missing module fails each test, not the whole run.
  const { createToolServerWatch } = require("../src/elizaos/toolServerWatch");
  const watch = createToolServerWatch({ expectedTools: EXPECTED, alert, log });

  return { watch, alert, log };
}

function printed(spy) {
  return spy
    .getCalls()
    .map((call) => call.args.join(" "))
    .join("\n");
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

    it("alerts when the framework's tool service is not running", async function () {
      const { watch, alert } = makeWatch();
      watch.attach(null);

      const problems = await watch.reportAtStartup();

      expect(problems).to.have.lengthOf(1);
      expect(alert.calledOnce).to.equal(true);
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

  describe("on a tool call", function () {
    it("passes a good result through and counts it", async function () {
      const { watch } = makeWatch();
      const service = makeService();
      watch.attach(service);

      const result = await service.callTool("market_data", "get_simple_price", { ids: "bitcoin" });

      expect(result.content[0].text).to.equal('{"usd":1}');
      expect(watch.observe().calls).to.deep.equal({ ok: 1, failed: 0 });
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

    it("throws when the result is flagged as an error, so the text never reaches the model", async function () {
      const { watch } = makeWatch();
      const service = makeService({
        callTool: async () => ({
          isError: true,
          content: [{ type: "text", text: "429 Too Many Requests" }],
        }),
      });
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
      expect(thrown.message).to.include("429 Too Many Requests");
      expect(watch.observe().calls).to.deep.equal({ ok: 0, failed: 1 });
    });

    it("counts a call that throws, and lets the same error through", async function () {
      const { watch } = makeWatch();
      const failure = new Error("No connection: market_data");
      const service = makeService({
        callTool: async () => {
          throw failure;
        },
      });
      watch.attach(service);

      const thrown = await service.callTool("market_data", "get_simple_price", {}).catch((e) => e);

      expect(thrown).to.equal(failure);
      expect(watch.observe().calls).to.deep.equal({ ok: 0, failed: 1 });
    });

    it("prints one line per call with the server, the tool and the outcome", async function () {
      const { watch, log } = makeWatch();
      const service = makeService();
      watch.attach(service);

      await service.callTool("market_data", "get_simple_price", { ids: "bitcoin" });

      expect(printed(log.log)).to.match(/market_data\/get_simple_price.*ok/);
    });

    it("never prints the arguments of a call", async function () {
      const { watch, log } = makeWatch();
      const service = makeService({
        callTool: async () => ({ isError: true, content: [{ type: "text", text: "bad request" }] }),
      });
      watch.attach(service);

      await service
        .callTool("market_data", "get_simple_price", { ids: "a-users-private-question" })
        .catch(() => {});

      const everything = [printed(log.log), printed(log.warn), printed(log.error)].join("\n");
      expect(everything).to.not.include("a-users-private-question");
      expect(printed(log.warn)).to.match(/market_data\/get_simple_price.*failed/);
    });

    it("keeps a long error text short", async function () {
      const { watch } = makeWatch();
      const service = makeService({
        callTool: async () => ({
          isError: true,
          content: [{ type: "text", text: "x".repeat(5000) }],
        }),
      });
      watch.attach(service);

      const thrown = await service.callTool("market_data", "get_simple_price", {}).catch((e) => e);

      expect(thrown.message.length).to.be.below(400);
    });

    it("wraps a service once, however often it is attached", async function () {
      const { watch } = makeWatch();
      const service = makeService();
      watch.attach(service);
      watch.attach(service);

      await service.callTool("market_data", "get_simple_price", {});

      expect(watch.observe().calls).to.deep.equal({ ok: 1, failed: 0 });
    });
  });

  describe("observed for the heartbeat", function () {
    it("gives each expected server's state and tool count, and the call counts", function () {
      const { watch } = makeWatch();
      watch.attach(makeService());

      expect(watch.observe()).to.deep.equal({
        servers: { market_data: { status: "connected", tools: 3 } },
        calls: { ok: 0, failed: 0 },
      });
    });

    it("says a server is absent when the service does not list it", function () {
      const { watch } = makeWatch();
      watch.attach(makeService({ servers: [] }));

      expect(watch.observe().servers).to.deep.equal({
        market_data: { status: "absent", tools: 0 },
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
        market_data: { status: "unknown", tools: 0 },
      });
    });

    // The heartbeat starts before the agent does. A server that has not been started yet is not
    // a server that was lost.
    it("raises nothing before the start-up report has run", function () {
      const { watch, alert } = makeWatch();

      const observed = watch.observe();

      expect(observed.servers).to.deep.equal({ market_data: { status: "unknown", tools: 0 } });
      expect(alert.called).to.equal(false);
    });

    it("alerts once when a connected server stops being connected, and not again", async function () {
      const { watch, alert } = makeWatch();
      const service = makeService();
      watch.attach(service);
      await watch.reportAtStartup();

      service.servers = [connectedServer({ status: "disconnected" })];
      watch.observe();
      watch.observe();
      watch.observe();

      expect(alert.callCount).to.equal(1);
      expect(alert.firstCall.args[1]).to.include("market_data");
    });

    it("says so when it is back, and alerts again on the next loss", async function () {
      const { watch, alert, log } = makeWatch();
      const service = makeService();
      watch.attach(service);
      await watch.reportAtStartup();

      service.servers = [connectedServer({ status: "disconnected" })];
      watch.observe();
      service.servers = [connectedServer()];
      watch.observe();
      service.servers = [];
      watch.observe();

      expect(printed(log.log)).to.match(/market_data.*connected again/);
      expect(alert.callCount).to.equal(2);
    });

    it("does not alert a second time for a server that was already reported at start-up", async function () {
      const { watch, alert } = makeWatch();
      watch.attach(makeService({ servers: [] }));
      await watch.reportAtStartup();

      watch.observe();
      watch.observe();

      expect(alert.callCount).to.equal(1);
    });
  });

  describe("finding the framework's tool service", function () {
    const { startedToolService } = require("../src/elizaos/toolServerWatch");

    it("waits for the service the framework is still starting", async function () {
      const service = makeService();
      const runtime = {
        getServiceLoadPromise: sinon
          .stub()
          .returns(new Promise((resolve) => setTimeout(() => resolve(service), 5))),
        getService: () => null,
      };

      expect(await startedToolService(runtime)).to.equal(service);
      expect(runtime.getServiceLoadPromise.calledOnceWithExactly("mcp")).to.equal(true);
    });

    it("gives up, with nothing, on a service that never starts", async function () {
      const runtime = { getServiceLoadPromise: () => new Promise(() => {}) };

      expect(await startedToolService(runtime, { timeoutMs: 10 })).to.equal(null);
    });

    it("gives nothing when the service failed to start", async function () {
      const runtime = { getServiceLoadPromise: () => Promise.reject(new Error("no such service")) };

      expect(await startedToolService(runtime)).to.equal(null);
    });

    it("asks a runtime that cannot be waited on for the service it has", async function () {
      const service = makeService();

      expect(await startedToolService({ getService: () => service })).to.equal(service);
      expect(await startedToolService({ getService: () => null })).to.equal(null);
      expect(await startedToolService(null)).to.equal(null);
    });
  });
});
