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

    // An ordinary setting is not a secret. Collected, "mainnet" or "require" would be removed
    // from every line that says them: a network name, a stack frame, an environment tag.
    it("is not an ordinary query value, a short password or a number", () => {
      expect(
        requestSecretsIn({
          A: "https://h.example/v1?network=mainnet&sslmode=require&schema=public",
          B: "postgres://user:x@127.0.0.1:5432/db",
          C: "postgres://user:postgres@127.0.0.1:5432/db",
          SENTRY_DSN: "https://publickey@o1.ingest.example/4507000000000000",
        }),
      ).to.deep.equal([]);
    });

    it("is a query value whose name says it is a credential, even a short one", () => {
      for (const name of ["key", "apikey", "api_key", "dkey", "token", "access_token", "secret"]) {
        expect(
          requestSecretsIn({ A: `https://h.example/v1?${name}=${QUERY_KEY}` }),
          name,
        ).to.include(QUERY_KEY);
      }
    });

    it("is a long value in any part of an address: user name, fragment, bare query, host label", () => {
      const secrets = requestSecretsIn({
        A: `https://${PATH_KEY}1@h.example/`,
        B: `https://h.example/#${PATH_KEY}2`,
        C: `https://h.example/v1?${PATH_KEY}3`,
        D: `https://${PATH_KEY}4.h.example/`,
      });

      expect(secrets).to.include.members([1, 2, 3].map((n) => `${PATH_KEY}${n}`));
      expect(secrets).to.include(`${PATH_KEY}4`.toLowerCase());
    });

    it("reads a quoted value and each address of a list", () => {
      expect(requestSecretsIn({ A: `"https://h.example/${PATH_KEY}"` })).to.deep.equal([PATH_KEY]);
      expect(
        requestSecretsIn({ A: `https://a.example/${PATH_KEY}1,https://b.example/${PATH_KEY}2` }),
      ).to.have.members([`${PATH_KEY}1`, `${PATH_KEY}2`]);
    });

    it("is the value of a setting named as a credential, when it is long enough to be one", () => {
      const secrets = requestSecretsIn({
        POSTGRES_PASSWORD: "a-Long-Db-Password-1",
        AUTONOMYS_API_KEY: "autonomysKey0123456789",
        SLACK_ACCESS_TOKEN: "xoxb-not-a-real-token",
        SOME_SECRET: "short",
        POSTGRES_USER: "senseai-oracle-user",
      });

      expect(secrets).to.have.members([
        "a-Long-Db-Password-1",
        "autonomysKey0123456789",
        "xoxb-not-a-real-token",
      ]);
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

    // The host of an address is read in lower case, whatever case it was written in.
    it("takes a secret out whatever case it is written in", () => {
      refreshRequestSecrets({ RPC: `https://${PATH_KEY}.rpc.example/` });

      expect(withoutRequestSecrets(`host ${PATH_KEY} refused`)).to.equal("host [REDACTED] refused");
      expect(withoutRequestSecrets(`host ${PATH_KEY.toUpperCase()} refused`)).to.equal(
        "host [REDACTED] refused",
      );
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
