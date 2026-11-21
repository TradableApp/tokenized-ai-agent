const crypto = require("crypto");
const { expect } = require("chai");

const contract = require("../src/stream/streamContract");
const { encryptSymmetrically } = require("../src/stream/frameCrypto");
const { decryptFrame } = require("./helpers/frameDecrypt");

// The interface the oracle and the dApp both build from (live reasoning streaming, contract
// version 1). The dApp has its own copy of these rules; the shared test vector below is what
// keeps the two byte-for-byte equal, so it must never be edited on one side only.

const VECTOR = {
  keyHex: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  ivHex: "a0a1a2a3a4a5a6a7a8a9aaab",
  plaintext:
    '{"v":1,"answerMessageId":"42","run":"0123456789abcdef","seq":1,"replica":"deadbeef","type":"step","data":{"attempt":1,"title":"Reading market context","description":"Checked recent sentiment for BTC."}}',
  frame:
    "oKGio6Slpqeoqaqr.nToKD3/6Lp0DC/SkYgiNuwPfOHf3/iZOpiwStF2HV3OnGGXFjRJiD2yoMf4+QrqYJXgiLQTyNlwyO3p8nkGpksbZ9QNZxoXCzsCbfe6qrt+obYmI57XgCotXBLjC7ijkragJz2La7rmkoCQx8fyIRVQkQ5TvGblIRruywZZv0B+gcNQWvSWgelYrle5mavK55q3IE8ry1q6ZqM6W3a5EX693cZOMSAN+52lARwvyxIQUQ5PsIhXLUPbrG1wy9j8xW0RsizSSlc+OIA1DLZj99YCZs7Q2y6k2OjY=",
  proof: "zmsj4OksK8D2N9JMs__j2qRCsgSGomdTiRR9Dl6UUb4",
  proofHex: "ce6b23e0e92c2bc0f637d24cb3ffe3daa442b20486a2675389147d0e5e9451be",
};

const vectorKey = () => Buffer.from(VECTOR.keyHex, "hex");
const vectorIv = () => Buffer.from(VECTOR.ivHex, "hex");

describe("stream contract (version 1)", () => {
  describe("shared test vector", () => {
    it("builds the vector's plaintext, key order included, from the frame fields", () => {
      const frame = contract.buildFrame({
        answerMessageId: "42",
        run: "0123456789abcdef",
        seq: 1,
        replica: "deadbeef",
        type: "step",
        data: { attempt: 1, title: "Reading market context", description: "Checked recent sentiment for BTC." },
      });

      expect(JSON.stringify(frame)).to.equal(VECTOR.plaintext);
    });

    it("encrypts the plaintext to the vector's frame with the vector's key and IV", () => {
      const frame = JSON.parse(VECTOR.plaintext);

      const ciphertext = contract.encryptFrame(frame, vectorKey(), () => vectorIv());

      expect(ciphertext).to.equal(VECTOR.frame);
    });

    it("decrypts the vector's frame back to the plaintext", () => {
      expect(JSON.stringify(decryptFrame(VECTOR.frame, vectorKey()))).to.equal(VECTOR.plaintext);
    });

    it("gives the vector's proof for answer 42", () => {
      const proof = contract.streamProof(vectorKey(), "42");

      expect(proof).to.equal(VECTOR.proof);
      expect(proof).to.have.length(43);
      expect(Buffer.from(proof, "base64url").toString("hex")).to.equal(VECTOR.proofHex);
      expect(contract.PROOF_PATTERN.test(proof)).to.equal(true);
    });
  });

  describe("frame encryption", () => {
    it("uses the answer files' format: base64 IV, a dot, base64 ciphertext with the tag appended", () => {
      const ciphertext = encryptSymmetrically({ a: 1 }, vectorKey());
      const [iv, body] = ciphertext.split(".");

      expect(Buffer.from(iv, "base64")).to.have.length(12);
      // {"a":1} is 7 bytes; GCM adds no padding, then a 16-byte tag.
      expect(Buffer.from(body, "base64")).to.have.length(7 + 16);
    });

    it("draws a fresh IV for every frame by default", () => {
      const a = contract.encryptFrame({ a: 1 }, vectorKey());
      const b = contract.encryptFrame({ a: 1 }, vectorKey());

      expect(a.split(".")[0]).to.not.equal(b.split(".")[0]);
    });

    it("refuses an IV source that does not give 12 bytes, rather than encrypting with it", () => {
      expect(() => encryptSymmetrically({ a: 1 }, vectorKey(), () => Buffer.alloc(8))).to.throw(
        /12-byte IV/,
      );
    });
  });

  describe("proof of key", () => {
    it("differs per answer id, so one answer's proof opens no other", () => {
      expect(contract.streamProof(vectorKey(), "43")).to.not.equal(VECTOR.proof);
    });

    it("refuses an answer id that is not the canonical decimal form", () => {
      for (const bad of ["042", "-1", "", "4 2", "0x2a", 42]) {
        expect(() => contract.streamProof(vectorKey(), bad), String(bad)).to.throw(TypeError);
      }
    });

    it("refuses a key that is not 32 bytes", () => {
      expect(() => contract.streamProof(Buffer.alloc(16), "42")).to.throw(TypeError);
      expect(() => contract.streamProof("not a key", "42")).to.throw(TypeError);
    });
  });

  describe("identities", () => {
    it("accepts canonical uint256 decimal answer ids only", () => {
      const good = ["0", "1", "42", "9".repeat(78)];
      const bad = ["00", "01", "9".repeat(79), "-0", "1e3", " 1", "1 ", "", null, undefined, 1];

      for (const id of good) expect(contract.isAnswerMessageId(id), id).to.equal(true);
      for (const id of bad) expect(contract.isAnswerMessageId(id), String(id)).to.equal(false);
    });

    it("makes run ids of 16 lower-case hex characters, new each time", () => {
      const a = contract.newRunId();
      const b = contract.newRunId();

      expect(a).to.match(/^[0-9a-f]{16}$/);
      expect(contract.RUN_PATTERN.test(a)).to.equal(true);
      expect(a).to.not.equal(b);
    });

    it("takes the replica from ORACLE_REPLICA_ID when it is valid, otherwise 8 random hex", () => {
      expect(contract.resolveReplicaId({ ORACLE_REPLICA_ID: "tee-a1" })).to.equal("tee-a1");
      expect(contract.resolveReplicaId({})).to.match(/^[0-9a-f]{8}$/);
      expect(contract.resolveReplicaId({ ORACLE_REPLICA_ID: "" })).to.match(/^[0-9a-f]{8}$/);
    });

    it("refuses an ORACLE_REPLICA_ID outside 1-32 of [a-z0-9-]", () => {
      for (const bad of ["UPPER", "a_b", "x".repeat(33), "a b"]) {
        expect(() => contract.resolveReplicaId({ ORACLE_REPLICA_ID: bad }), bad).to.throw(
          /ORACLE_REPLICA_ID/,
        );
      }
    });

    it("never repeats the refused value in the message", () => {
      try {
        contract.resolveReplicaId({ ORACLE_REPLICA_ID: "SECRET_LOOKING" });
        expect.fail("should have thrown");
      } catch (error) {
        expect(error.message).to.not.include("SECRET_LOOKING");
      }
    });

    it("writes and reads the SSE event id as <run>.<seq>", () => {
      expect(contract.sseEventId("0123456789abcdef", 7)).to.equal("0123456789abcdef.7");
      expect(contract.parseSseEventId("0123456789abcdef.7")).to.deep.equal({
        run: "0123456789abcdef",
        seq: 7,
      });
      for (const bad of ["7", "0123456789abcdef", "0123456789abcdef.-1", "0123456789abcdef.07", "x.1", "", null]) {
        expect(contract.parseSseEventId(bad), String(bad)).to.equal(null);
      }
    });
  });

  describe("frame vocabulary and limits", () => {
    it("names the six frame types, the reset reasons and the done outcomes", () => {
      expect(Object.values(contract.FRAME_TYPES)).to.have.members([
        "reset",
        "sources",
        "step",
        "attempt",
        "answer",
        "done",
      ]);
      expect(contract.RESET_REASONS).to.have.members(["start", "retry"]);
      expect(contract.DONE_OUTCOMES).to.have.members(["answered", "abandoned", "interrupted"]);
      expect(contract.SSE_EVENT_NAME).to.equal("frame");
      expect(contract.STREAM_CONTRACT_VERSION).to.equal(1);
    });

    it("holds the limits the dApp also enforces", () => {
      expect(contract.LIMITS).to.deep.equal({
        maxSourcesPerFrame: 20,
        sourceTitleChars: 300,
        sourceUrlChars: 2048,
        stepTitleChars: 120,
        stepDescriptionChars: 4000,
        maxStepsPerAttempt: 64,
        maxAttempts: 4,
        answerTextBytes: 64 * 1024,
        framePlaintextBytes: 16 * 1024,
      });
      expect(Object.isFrozen(contract.LIMITS)).to.equal(true);
    });

    it("refuses to build a frame of an unknown type or with a bad identity", () => {
      const base = { answerMessageId: "1", run: "0123456789abcdef", seq: 0, replica: "r1", type: "reset", data: { reason: "start" } };

      expect(() => contract.buildFrame({ ...base, type: "token" })).to.throw(TypeError);
      expect(() => contract.buildFrame({ ...base, answerMessageId: "01" })).to.throw(TypeError);
      expect(() => contract.buildFrame({ ...base, run: "XYZ" })).to.throw(TypeError);
      expect(() => contract.buildFrame({ ...base, seq: -1 })).to.throw(TypeError);
      expect(() => contract.buildFrame({ ...base, seq: 1.5 })).to.throw(TypeError);
      expect(() => contract.buildFrame({ ...base, replica: "Bad Replica" })).to.throw(TypeError);
    });
  });

  describe("sink", () => {
    it("names the three synchronous sink methods", () => {
      expect(contract.SINK_METHODS).to.deep.equal(["open", "frame", "close"]);
    });

    it("offers a no-op sink that accepts every call and returns nothing", () => {
      const { noopSink } = contract;
      expect(contract.isSink(noopSink)).to.equal(true);
      expect(noopSink.open("1", { run: "0123456789abcdef", replica: "r", expectedProof: "x" })).to.equal(undefined);
      expect(noopSink.frame("1", { run: "0123456789abcdef", seq: 0, ciphertext: "a.b" })).to.equal(undefined);
      expect(noopSink.close("1", { run: "0123456789abcdef", outcome: "answered" })).to.equal(undefined);
      expect(Object.isFrozen(noopSink)).to.equal(true);
    });

    it("tells a sink from something that lacks a method", () => {
      expect(contract.isSink({ open() {}, frame() {} })).to.equal(false);
      expect(contract.isSink(null)).to.equal(false);
      expect(contract.isSink({ open() {}, frame() {}, close() {} })).to.equal(true);
    });
  });

  it("keeps the vector's HMAC equal to Node's own computation (guards the vector itself)", () => {
    const expected = crypto.createHmac("sha256", vectorKey()).update("senseai-stream:42").digest("base64url");
    expect(expected).to.equal(VECTOR.proof);
  });
});
