const crypto = require("crypto");
const { expect } = require("chai");

const contract = require("../src/stream/streamContract");
const { encryptSymmetrically } = require("../src/stream/frameCrypto");
const { decryptFrame } = require("./helpers/frameDecrypt");

// The interface the oracle and the dApp both build from (live reasoning streaming, contract
// version 1). The dApp has its own copy of these rules; the shared test vectors below are what
// keep the two byte-for-byte equal, so they must never be edited on one side only.
//
// One vector per frame type, each with the fixed key, its own fixed IV and a fixed plaintext.
// The dApp holds the same data in `src/lib/liveReasoning/vector.testdata.ts`, and both repos pin
// the same SHA-256 of it (STREAM_VECTORS_SHA256). The hash is of the canonical form: JSON with
// the keys of every object sorted (JavaScript's default sort, by UTF-16 code unit), arrays kept in
// order, no whitespace, strings and numbers as JSON.stringify writes them; SHA-256 of its UTF-8,
// in lower-case hex (`canonicalJson` below; the dApp's is the same function). If a vector changes
// here, update the hash here, then copy the vectors and the same hash into the dApp: a change on
// one side only fails that side's pin, or leaves the two hashes different.

const STREAM_VECTORS = {
  keyHex: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  proof: {
    answerMessageId: "42",
    proof: "zmsj4OksK8D2N9JMs__j2qRCsgSGomdTiRR9Dl6UUb4",
    proofHex: "ce6b23e0e92c2bc0f637d24cb3ffe3daa442b20486a2675389147d0e5e9451be",
  },
  frames: [
    {
      type: "step",
      ivHex: "a0a1a2a3a4a5a6a7a8a9aaab",
      plaintext:
        "{\"v\":1,\"answerMessageId\":\"42\",\"run\":\"0123456789abcdef\",\"seq\":1,\"replica\":\"deadbeef\",\"type\":\"step\",\"data\":{\"attempt\":1,\"title\":\"Reading market context\",\"description\":\"Checked recent sentiment for BTC.\"}}",
      frame:
        "oKGio6Slpqeoqaqr.nToKD3/6Lp0DC/SkYgiNuwPfOHf3/iZOpiwStF2HV3OnGGXFjRJiD2yoMf4+QrqYJXgiLQTyNlwyO3p8nkGpksbZ9QNZxoXCzsCbfe6qrt+obYmI57XgCotXBLjC7ijkragJz2La7rmkoCQx8fyIRVQkQ5TvGblIRruywZZv0B+gcNQWvSWgelYrle5mavK55q3IE8ry1q6ZqM6W3a5EX693cZOMSAN+52lARwvyxIQUQ5PsIhXLUPbrG1wy9j8xW0RsizSSlc+OIA1DLZj99YCZs7Q2y6k2OjY=",
    },
  ],
};

const STREAM_VECTORS_SHA256 = "e09ee75f9b768d739b145956a61e8702919f33040d70ff50a9ce9195dca3deba";

/** The canonical form the pinned hash is taken of (defined identically in the dApp). */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const vectorKey = () => Buffer.from(STREAM_VECTORS.keyHex, "hex");
const stepVector = () => STREAM_VECTORS.frames.find((v) => v.type === "step");

const isAttempt = (n) => Number.isInteger(n) && n >= 1 && n <= contract.LIMITS.maxAttempts;
const isText = (text, max) => typeof text === "string" && text.length >= 1 && text.length <= max;
const isWebUrl = (url) => {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
};

/** Whether a decoded frame meets the contract: identities, its type's data and its size. */
function meetsContract(frame) {
  const { LIMITS } = contract;
  contract.buildFrame(frame); // throws on a bad identity or type
  const { data } = frame;
  const bytes = Buffer.byteLength(JSON.stringify(frame), "utf-8");
  switch (frame.type) {
    case "reset":
      return frame.seq === 0 && contract.RESET_REASONS.includes(data.reason) && bytes <= LIMITS.framePlaintextBytes;
    case "step":
      return (
        isAttempt(data.attempt) &&
        isText(data.title, LIMITS.stepTitleChars) &&
        isText(data.description, LIMITS.stepDescriptionChars) &&
        bytes <= LIMITS.framePlaintextBytes
      );
    case "attempt":
      return isAttempt(data.attempt) && data.attempt >= 2 && bytes <= LIMITS.framePlaintextBytes;
    case "sources":
      return (
        isAttempt(data.attempt) &&
        data.sources.length <= LIMITS.maxSourcesPerFrame &&
        data.sources.every(
          (s) => isText(s.title, LIMITS.sourceTitleChars) && isText(s.url, LIMITS.sourceUrlChars) && isWebUrl(s.url),
        ) &&
        bytes <= LIMITS.framePlaintextBytes
      );
    case "answer":
      return (
        Buffer.byteLength(data.text, "utf-8") <= LIMITS.answerTextBytes &&
        contract.isAnswerCid(data.answerMessageCID) &&
        (data.reasoningDuration === undefined || Number.isFinite(data.reasoningDuration)) &&
        bytes <= LIMITS.answerFramePlaintextBytes
      );
    case "done":
      return contract.DONE_OUTCOMES.includes(data.outcome) && bytes <= LIMITS.framePlaintextBytes;
    default:
      return false;
  }
}

describe("stream contract (version 1)", () => {
  describe("shared test vectors", () => {
    it("holds one vector for every frame type the contract defines, each with its own IV", () => {
      const types = STREAM_VECTORS.frames.map((v) => v.type);
      const ivs = STREAM_VECTORS.frames.map((v) => v.ivHex);

      expect([...types].sort()).to.deep.equal(Object.values(contract.FRAME_TYPES).sort());
      expect(new Set(ivs).size).to.equal(ivs.length);
    });

    it("pins the SHA-256 of the canonical vector data, the same hash the dApp pins", () => {
      const digest = crypto.createHash("sha256").update(canonicalJson(STREAM_VECTORS), "utf-8").digest("hex");

      expect(digest).to.equal(STREAM_VECTORS_SHA256);
    });

    it("serialises canonically: keys sorted at every level, arrays in order, no whitespace", () => {
      expect(canonicalJson({ b: 1, a: [{ d: 2.5, c: "é\n" }, null, true] })).to.equal(
        '{"a":[{"c":"é\\n","d":2.5},null,true],"b":1}',
      );
    });

    it("builds the step vector's plaintext, key order included, from the frame fields", () => {
      const frame = contract.buildFrame({
        answerMessageId: "42",
        run: "0123456789abcdef",
        seq: 1,
        replica: "deadbeef",
        type: "step",
        data: { attempt: 1, title: "Reading market context", description: "Checked recent sentiment for BTC." },
      });

      expect(JSON.stringify(frame)).to.equal(stepVector().plaintext);
    });

    for (const type of Object.values(contract.FRAME_TYPES)) {
      describe(`the ${type} vector`, () => {
        const vector = () => STREAM_VECTORS.frames.find((v) => v.type === type);

        it("exists", () => {
          expect(vector(), type).to.not.equal(undefined);
        });

        it("rebuilds its plaintext, key order included, through the frame builder", () => {
          const parsed = JSON.parse(vector().plaintext);

          expect(parsed.type).to.equal(type);
          expect(JSON.stringify(contract.buildFrame(parsed))).to.equal(vector().plaintext);
        });

        it("encrypts its plaintext to its frame, byte for byte, with the fixed key and IV", () => {
          const iv = Buffer.from(vector().ivHex, "hex");

          const sealed = contract.encryptFrame(JSON.parse(vector().plaintext), vectorKey(), () => iv);

          expect(sealed).to.equal(vector().frame);
        });

        it("decrypts its frame to its plaintext, and the frame meets the contract", () => {
          const frame = decryptFrame(vector().frame, vectorKey());

          expect(JSON.stringify(frame)).to.equal(vector().plaintext);
          expect(meetsContract(frame)).to.equal(true);
          expect(vector().frame.length).to.be.at.most(contract.MAX_SEALED_FRAME_CHARS);
        });
      });
    }

    it("gives the vectors' proof for answer 42", () => {
      const { proof: expected, proofHex, answerMessageId } = STREAM_VECTORS.proof;
      const proof = contract.streamProof(vectorKey(), answerMessageId);

      expect(proof).to.equal(expected);
      expect(proof).to.have.length(43);
      expect(Buffer.from(proof, "base64url").toString("hex")).to.equal(proofHex);
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
      expect(contract.streamProof(vectorKey(), "43")).to.not.equal(STREAM_VECTORS.proof.proof);
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
        answerFramePlaintextBytes: 6 * 64 * 1024 + 1024,
        answerCidChars: 128,
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

  describe("frame sizes and content ids", () => {
    const AUTONOMYS = `bafkr6i${"a".repeat(52)}`;

    it("accepts the content ids the storage paths produce, up to the limit, and nothing else", () => {
      const good = [
        AUTONOMYS, // Autonomys Auto Drive: 59
        `bafybei${"b".repeat(52)}`, // local IPFS, CIDv1 base32: 59
        "A".repeat(43), // legacy Arweave id
        `${"a_-".repeat(14)}Zz`, // legacy Irys id: 44
        `mock_${"0".repeat(20)}`, // mock storage
        "x".repeat(128),
      ];
      const bad = ["", "x".repeat(129), "bafy.x", "bafy/x", "bafy x", "bafyé", "a+b", "a=b", null, 42];

      for (const cid of good) expect(contract.isAnswerCid(cid), cid).to.equal(true);
      for (const cid of bad) expect(contract.isAnswerCid(cid), String(cid)).to.equal(false);
      expect(contract.LIMITS.answerCidChars).to.equal(128);
      expect(contract.ANSWER_CID_PATTERN.test("x".repeat(128))).to.equal(true);
    });

    it("gives the answer frame room for the largest answer it may carry", () => {
      // The largest legal answer frame: every identity at its longest, 64 KiB of text that JSON
      // writes six bytes per byte, the longest content id and the longest finite duration.
      const worst = contract.buildFrame({
        answerMessageId: "9".repeat(78),
        run: "f".repeat(16),
        seq: Number.MAX_SAFE_INTEGER,
        replica: "r".repeat(32),
        type: "answer",
        data: {
          text: "\x01".repeat(contract.LIMITS.answerTextBytes),
          answerMessageCID: "A".repeat(contract.LIMITS.answerCidChars),
          reasoningDuration: -2.2250738585072014e-308,
        },
      });
      const bytes = Buffer.byteLength(JSON.stringify(worst), "utf-8");

      expect(bytes).to.equal(393645);
      expect(bytes).to.be.at.most(contract.LIMITS.answerFramePlaintextBytes);
      expect(contract.LIMITS.framePlaintextBytes).to.be.below(contract.LIMITS.answerFramePlaintextBytes);
    });

    it("counts a sealed frame's characters exactly as the encryptor writes them", () => {
      for (const n of [0, 1, 2, 3, 100, 16 * 1024]) {
        const sealed = encryptSymmetrically("x".repeat(n), vectorKey());
        // JSON.stringify of a string adds its two quotes.
        expect(sealed.length, String(n)).to.equal(contract.sealedFrameChars(n + 2));
      }
      expect(contract.MAX_SEALED_FRAME_CHARS).to.equal(
        contract.sealedFrameChars(contract.LIMITS.answerFramePlaintextBytes),
      );
      expect(contract.MAX_SEALED_FRAME_CHARS).to.equal(525693);
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
    expect(expected).to.equal(STREAM_VECTORS.proof.proof);
  });
});
