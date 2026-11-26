"use strict";

const { ethers } = require("ethers");
const { expect } = require("chai");
const sinon = require("sinon");
const proxyquire = require("proxyquire").noCallThru();
const core = require("@elizaos/core");

const { withTestKeys } = require("./helpers/oracleTestKeys");
const { initInboundPrompt } = require("../src/inboundPrompt");
const { clearConversationRoom } = require("../src/elizaos/conversationRoom");
const { oracleStatePlugin } = require("../src/oracleState/schema");

// The agent framework's real schema, on plugin-sql's embedded Postgres in memory (no server, no
// network): the framework's runtime with plugin-bootstrap, as the oracle runs it, and a stand-in
// for the model. What a prompt leaves in the database, and what the start-up sweep removes, are
// read back from the tables themselves, so the foreign keys the clear relies on are exercised.

const AGENT_ID = core.stringToUuid("senseai-agent-under-test");
const DEPLOYMENT = { chainId: 84532n, agent: "0x000000000000000000000000000000000000c0de" };
const OWNER = "0x00000000000000000000000000000000000000a1";
const OTHER_OWNER = "0x00000000000000000000000000000000000000b2";
const EMBEDDING = Array.from({ length: 384 }, () => 0.1);

// The reflection step's answer: one new fact and a relationship between the agent and the owner.
const REFLECTION = `<response>
<thought>The user asks about the market.</thought>
<facts><fact><claim>The user holds a position they did not name</claim><type>fact</type><in_bio>false</in_bio><already_known>false</already_known></fact></facts>
<relationships><relationship><sourceEntityId>SenseAI</sourceEntityId><targetEntityId>User</targetEntityId><tags>dm_interaction</tags></relationship></relationships>
</response>`;
const ANSWER = `<response><thought>Answering the user.</thought><actions>REPLY</actions><providers></providers><text>An answer.</text></response>`;

/** The model the runtime is given: a fixed answer, the reflection above, and an embedding. */
function modelsPlugin(prompts) {
  const text = async (_runtime, params) => {
    const prompt = params?.prompt ?? "";
    prompts.push(prompt);
    return prompt.includes("Extract Facts and Relationships") ? REFLECTION : ANSWER;
  };
  return {
    name: "test-models",
    description: "A stand-in for the model",
    models: {
      [core.ModelType.TEXT_SMALL]: text,
      [core.ModelType.TEXT_LARGE]: text,
      [core.ModelType.TEXT_EMBEDDING]: async () => EMBEDDING,
    },
  };
}

const rowsOf = (result) => result?.rows ?? result ?? [];

describe("the agent database on the framework's real schema", function () {
  this.timeout(60000);

  let sqlPlugin;
  let adapter;
  let runtime;
  let db;
  const prompts = [];

  async function count(query) {
    return Number(rowsOf(await db.execute(query))[0].n);
  }

  /** Every row the framework keeps that is not the agent's own. */
  async function leftInTheDatabase() {
    const agent = `'${AGENT_ID}'::uuid`;
    return {
      rooms: await count(`SELECT count(*) AS n FROM rooms WHERE id <> ${agent}`),
      memories: await count(`SELECT count(*) AS n FROM memories`),
      embeddings: await count(`SELECT count(*) AS n FROM embeddings`),
      logs: await count(`SELECT count(*) AS n FROM logs`),
      participants: await count(`SELECT count(*) AS n FROM participants WHERE room_id <> ${agent}`),
      components: await count(`SELECT count(*) AS n FROM components`),
      entities: await count(`SELECT count(*) AS n FROM entities WHERE id <> ${agent}`),
      relationships: await count(`SELECT count(*) AS n FROM relationships`),
      reflectionMarkers: await count(
        `SELECT count(*) AS n FROM cache WHERE key LIKE '%-reflection-last-processed'`,
      ),
    };
  }
  const nothingLeft = {
    rooms: 0,
    memories: 0,
    embeddings: 0,
    logs: 0,
    participants: 0,
    components: 0,
    entities: 0,
    relationships: 0,
    reflectionMarkers: 0,
  };

  before(async () => {
    await initInboundPrompt();
    sqlPlugin = await import("@elizaos/plugin-sql");
    const bootstrap = await import("@elizaos/plugin-bootstrap");

    adapter = sqlPlugin.createDatabaseAdapter({ dataDir: "memory://" }, AGENT_ID);
    await adapter.init();
    db = adapter.getDatabase();
    const migrations = new sqlPlugin.DatabaseMigrationService();
    await migrations.initializeWithDatabase(db);
    migrations.discoverAndRegisterPluginSchemas([sqlPlugin.default, oracleStatePlugin]);
    await migrations.runAllPluginMigrations();

    runtime = new core.AgentRuntime({
      agentId: AGENT_ID,
      character: { name: "SenseAI", bio: "An agent for market questions." },
      adapter,
      plugins: [modelsPlugin(prompts), bootstrap.bootstrapPlugin],
    });
    await runtime.initialize({ skipMigrations: true });
  });

  after(async () => {
    await runtime?.stop().catch(() => {});
    await adapter?.close().catch(() => {});
  });

  /** The oracle, answering through the runtime above. */
  function loadOracle() {
    process.env.PRIVATE_KEY = ethers.Wallet.createRandom().privateKey;
    class ElizaOS {
      constructor() {
        this.framework = new core.ElizaOS();
      }
      async addAgents() {
        return [AGENT_ID];
      }
      async startAgents() {}
      getAgent() {
        return runtime;
      }
      handleMessage(_agentId, message, options) {
        return this.framework.handleMessage(runtime, message, options);
      }
    }
    const quiet = { info() {}, log() {}, error() {}, warn() {}, debug() {} };
    const oracle = withTestKeys(
      proxyquire("../src/aiAgentOracle", {
        "@elizaos/core": { ...core, ElizaOS, setAllowedEnvVars() {}, elizaLogger: quiet },
        "./elizaos/plugins/plugin-senseai/dist/index.js": { default: {}, setErrorDescriber: () => {} },
        "./elizaos/character.js": {},
      }),
    );
    oracle.initForTest({
      provider: { getNetwork: sinon.stub().resolves({ chainId: DEPLOYMENT.chainId }) },
      contract: { target: DEPLOYMENT.agent },
      isSapphire: false,
    });
    return oracle;
  }

  const withPast = (content) => [
    ...Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `earlier turn ${i}`,
      createdAt: 1000 + i,
    })),
    { role: "user", content },
  ];

  // The framework's embedding queue works every 100 ms; what it was given would be written after
  // the run.
  const queueWorked = () => new Promise((resolve) => setTimeout(resolve, 800));

  describe("a prompt answered through the oracle", () => {
    let oracle;
    let unhandled;
    const onUnhandled = (reason) => unhandled.push(reason);

    before(async () => {
      sinon.stub(console, "log");
      sinon.stub(console, "warn");
      oracle = loadOracle();
      // The oracle starts the agent, and empties the database, at its first prompt.
      await oracle.queryElizaOS([{ role: "user", content: "a first question" }], "1", OWNER);
      await queueWorked();
      sinon.restore();
    });

    beforeEach(() => {
      unhandled = [];
      process.on("unhandledRejection", onUnhandled);
      sinon.stub(console, "log");
      sinon.stub(console, "warn");
    });

    afterEach(() => {
      process.off("unhandledRejection", onUnhandled);
      sinon.restore();
    });

    it("is answered, and leaves nothing of the conversation in the database", async () => {
      prompts.length = 0;

      const answer = await oracle.queryElizaOS(withPast("How is the market?"), "7", OWNER);
      await queueWorked();

      expect(answer.text).to.equal("An answer.");
      expect(unhandled, "unhandled rejections").to.deep.equal([]);
      expect(
        prompts.some((prompt) => prompt.includes("Extract Facts and Relationships")),
        "the reflection step was asked",
      ).to.equal(false);
      expect(await leftInTheDatabase()).to.deep.equal(nothingLeft);
    });

    it("reads nothing of another owner's conversation that is in the database at the time", async () => {
      // Another owner's run, in flight: its room, its owner and the agent in it, and a message.
      const otherRoom = core.stringToUuid("another owner's room");
      const otherEntity = core.stringToUuid("another owner's entity");
      await runtime.ensureConnection({
        entityId: otherEntity,
        roomId: otherRoom,
        userName: OTHER_OWNER,
        name: "User",
        source: "onchain",
        channelId: "9",
        type: core.ChannelType.DM,
        worldId: core.stringToUuid("onchain-world"),
      });
      await runtime.createMemory(
        {
          id: core.stringToUuid("another owner's message"),
          entityId: otherEntity,
          agentId: AGENT_ID,
          roomId: otherRoom,
          content: { text: "SECRET-OF-ANOTHER-OWNER", source: "onchain" },
        },
        "messages",
      );
      const read = [];
      const getMemoriesByRoomIds = adapter.getMemoriesByRoomIds.bind(adapter);
      sinon.stub(adapter, "getMemoriesByRoomIds").callsFake(async (params) => {
        const memories = await getMemoriesByRoomIds(params);
        read.push(...memories.map((memory) => memory.content?.text));
        return memories;
      });

      const answer = await oracle.queryElizaOS(withPast("And now?"), "7", OWNER);

      expect(answer.text).to.equal("An answer.");
      expect(read).to.not.include("SECRET-OF-ANOTHER-OWNER");
      expect(prompts.join("\n")).to.not.include("SECRET-OF-ANOTHER-OWNER");
      await runtime.deleteRoom(otherRoom);
      await adapter.deleteEntity(otherEntity);
    });
  });

  describe("the clear and the start-up sweep", () => {
    const agent = () => `'${AGENT_ID}'::uuid`;
    const contract = "0x000000000000000000000000000000000000c0de";

    async function seedOracleState() {
      await db.execute(
        `INSERT INTO oracle_state.oracle_cursors (chain_id, contract_address, last_processed_block) VALUES (84532, '${contract}', 7) ON CONFLICT DO NOTHING`,
      );
      await db.execute(
        `INSERT INTO oracle_state.oracle_failed_jobs (chain_id, contract_address, transaction_hash, log_index, event_name, block_number, next_attempt_at) VALUES (84532, '${contract}', '0x${"ab".repeat(32)}', 0, 'PromptSubmitted', 7, now())`,
      );
      await db.execute(
        `INSERT INTO oracle_state.oracle_metadata_updates (chain_id, contract_address, conversation_id, block_number, log_index) VALUES (84532, '${contract}', '7', 7, 0) ON CONFLICT DO NOTHING`,
      );
    }

    /** A room as a run leaves it: owner, messages with an embedding, a fact, a log, a component. */
    async function seedRoom({ roomId, entityId, worldId, owner, text }) {
      await runtime.ensureConnection({
        entityId,
        roomId,
        userName: owner,
        name: "User",
        source: "onchain",
        channelId: "7",
        type: core.ChannelType.DM,
        worldId,
      });
      await runtime.createMemory(
        {
          id: core.stringToUuid(`${roomId} message`),
          entityId,
          agentId: AGENT_ID,
          roomId,
          content: { text, source: "onchain" },
          embedding: EMBEDDING,
        },
        "messages",
      );
      await runtime.createMemory(
        {
          id: core.stringToUuid(`${roomId} fact`),
          entityId: AGENT_ID,
          agentId: AGENT_ID,
          roomId,
          content: { text: `a fact drawn from ${text}` },
        },
        "facts",
      );
      await db.execute(
        `INSERT INTO logs (entity_id, room_id, type, body) VALUES ('${AGENT_ID}'::uuid, '${roomId}'::uuid, 'useModel:TEXT_LARGE', '{"prompt": "${text}"}'::jsonb)`,
      );
      await runtime.createComponent({
        id: core.stringToUuid(`${roomId} component`),
        entityId,
        agentId: AGENT_ID,
        roomId,
        worldId,
        sourceEntityId: AGENT_ID,
        type: "profile",
        data: { note: text },
        createdAt: Date.now(),
      });
    }

    async function inRoom(roomId) {
      const room = `'${roomId}'::uuid`;
      return {
        room: await count(`SELECT count(*) AS n FROM rooms WHERE id = ${room}`),
        memories: await count(`SELECT count(*) AS n FROM memories WHERE room_id = ${room}`),
        embeddings: await count(
          `SELECT count(*) AS n FROM embeddings e JOIN memories m ON m.id = e.memory_id WHERE m.room_id = ${room}`,
        ),
        logs: await count(`SELECT count(*) AS n FROM logs WHERE room_id = ${room}`),
        participants: await count(`SELECT count(*) AS n FROM participants WHERE room_id = ${room}`),
        components: await count(`SELECT count(*) AS n FROM components WHERE room_id = ${room}`),
      };
    }
    const emptyRoom = { room: 0, memories: 0, embeddings: 0, logs: 0, participants: 0, components: 0 };

    it("the clear removes a room and everything of it, the owner's entity included", async () => {
      const roomId = core.stringToUuid("senseai-conversation:v1:84532:room-under-test");
      const entityId = core.stringToUuid("senseai-conversation:v1:84532:room-under-test:owner");
      await seedRoom({
        roomId,
        entityId,
        worldId: core.stringToUuid("onchain-world"),
        owner: OWNER,
        text: "a question",
      });
      expect((await inRoom(roomId)).embeddings, "the seed holds an embedding").to.equal(1);

      const failed = await clearConversationRoom(runtime, { roomId, entityId }, "after the run");

      expect(failed).to.deep.equal([]);
      expect(await inRoom(roomId)).to.deep.equal(emptyRoom);
      expect(await count(`SELECT count(*) AS n FROM entities WHERE id = '${entityId}'::uuid`)).to.equal(0);
    });

    it("the sweep removes what earlier builds left, and leaves the agent's own rows and the oracle's state", async () => {
      await seedOracleState();
      // An earlier build's room: named for the conversation number alone, in a world of its own,
      // with the owner's entity named for the wallet, a relationship and a reflection marker; and
      // a model call's record under the agent's own room.
      const oldRoom = core.stringToUuid("7");
      const oldEntity = core.stringToUuid(OWNER);
      await seedRoom({ roomId: oldRoom, entityId: oldEntity, worldId: oldRoom, owner: OWNER, text: "an old question" });
      await runtime.createRelationship({
        sourceEntityId: AGENT_ID,
        targetEntityId: oldEntity,
        tags: ["dm_interaction"],
        metadata: { interactions: 3 },
      });
      await runtime.setCache(`${oldRoom}-reflection-last-processed`, "a message id");
      await db.execute(
        `INSERT INTO logs (entity_id, room_id, type, body) VALUES (${agent()}, ${agent()}, 'useModel:TEXT_SMALL', '{"prompt": "an old prompt"}'::jsonb)`,
      );
      const cursorsBefore = await count(`SELECT count(*) AS n FROM oracle_state.oracle_cursors`);
      const jobsBefore = await count(`SELECT count(*) AS n FROM oracle_state.oracle_failed_jobs`);
      const metadataBefore = await count(
        `SELECT count(*) AS n FROM oracle_state.oracle_metadata_updates`,
      );

      // Read here, so the prompt tests above run whatever this module holds.
      const { sweepAgentMemory } = require("../src/elizaos/agentMemory");
      await sweepAgentMemory(runtime);

      expect(await inRoom(oldRoom)).to.deep.equal(emptyRoom);
      expect(await leftInTheDatabase()).to.deep.equal(nothingLeft);
      expect(await count(`SELECT count(*) AS n FROM worlds WHERE id <> ${agent()}`), "worlds").to.equal(0);
      expect(await count(`SELECT count(*) AS n FROM rooms WHERE id = ${agent()}`), "agent's room").to.equal(1);
      expect(await count(`SELECT count(*) AS n FROM worlds WHERE id = ${agent()}`), "agent's world").to.equal(1);
      expect(await count(`SELECT count(*) AS n FROM entities WHERE id = ${agent()}`), "agent's entity").to.equal(1);
      expect(await count(`SELECT count(*) AS n FROM agents WHERE id = ${agent()}`), "the agent").to.equal(1);
      expect(cursorsBefore).to.equal(1);
      expect(jobsBefore).to.equal(1);
      expect(await count(`SELECT count(*) AS n FROM oracle_state.oracle_cursors`), "cursor").to.equal(1);
      expect(await count(`SELECT count(*) AS n FROM oracle_state.oracle_failed_jobs`), "failed jobs").to.equal(1);
      expect(metadataBefore).to.equal(1);
      expect(
        await count(`SELECT count(*) AS n FROM oracle_state.oracle_metadata_updates`),
        "metadata positions",
      ).to.equal(1);
    });
  });
});
