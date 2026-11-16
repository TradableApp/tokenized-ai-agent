const { expect } = require("chai");

const {
  requestSecretsIn,
  refreshRequestSecrets,
  withoutRequestSecrets,
} = require("../src/requestSecrets");

const PATH_KEY = "aB3dE6gH9jK2mN5pQ8sT";
const QUERY_KEY = "q7Wx2Zr9";

describe("request secrets", () => {
  afterEach(() => refreshRequestSecrets(process.env));

  describe("what is taken from the configuration", () => {
    it("is every long path segment, query value and password of an address", () => {
      const secrets = requestSecretsIn({
        BASE_SEPOLIA_TESTNET_RPC: `https://base.example/v2/${PATH_KEY}?dkey=${QUERY_KEY}`,
        POSTGRES_URL: "postgres://oracle:pg-Pass-123@10.0.0.5:5432/oracle_agent",
      });

      expect(secrets).to.include(PATH_KEY);
      expect(secrets).to.include(QUERY_KEY);
      expect(secrets).to.include("pg-Pass-123");
    });

    // A short segment is a route, not a key, and removing "/v2" or "rpc" from every line would
    // blank ordinary text.
    it("is not a short path segment, a host or a value that is no address", () => {
      const secrets = requestSecretsIn({
        BASE_SEPOLIA_TESTNET_RPC: `https://base.example/v2/rpc/${PATH_KEY}`,
        NETWORK_NAME: "baseSepolia",
        AI_AGENT_CONTRACT_ADDRESS: "0x4a0C7e5807f9174499a8F56F2C69c61b39a4c64D",
        EMPTY: "",
      });

      expect(secrets).to.deep.equal([PATH_KEY]);
    });

    it("reads a value with spaces around it, and ignores one that cannot be parsed", () => {
      expect(
        requestSecretsIn({ A: `  https://h.example/${PATH_KEY}  `, B: "https://" }),
      ).to.deep.equal([PATH_KEY]);
    });
  });

  describe("removal", () => {
    it("takes a secret out of text that has no scheme in front of it", () => {
      refreshRequestSecrets({ RPC: `https://base.example/v2/${PATH_KEY}?dkey=${QUERY_KEY}` });

      expect(withoutRequestSecrets(`POST /v2/${PATH_KEY}`)).to.equal("POST /v2/[REDACTED]");
      expect(withoutRequestSecrets(`?dkey=${QUERY_KEY}&x=1`)).to.equal("?dkey=[REDACTED]&x=1");
    });

    it("takes it out in its percent-encoded form too", () => {
      refreshRequestSecrets({ RPC: "https://base.example/v2/x?token=ab+cd/ef==gh" });

      expect(withoutRequestSecrets("token=ab%2Bcd%2Fef%3D%3Dgh")).to.equal("token=[REDACTED]");
    });

    it("leaves text alone when nothing is configured, and returns non-text as it is", () => {
      refreshRequestSecrets({});

      expect(withoutRequestSecrets(`POST /v2/${PATH_KEY}`)).to.equal(`POST /v2/${PATH_KEY}`);
      expect(withoutRequestSecrets(42)).to.equal(42);
    });

    it("treats a secret as text, not as a pattern", () => {
      refreshRequestSecrets({ RPC: "https://base.example/v2/x?token=a.c$[z]{2}(q)+" });

      expect(withoutRequestSecrets("abc$[z]{2}(q)+ and a.c$[z]{2}(q)+")).to.equal(
        "abc$[z]{2}(q)+ and [REDACTED]",
      );
    });
  });
});
