const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { needsOracleRoleMigration } = require("../scripts/deploy");

/**
 * Oracle authorization is a role that several addresses can hold at once (ADR-0006).
 *
 * With a single oracle address, replacing the oracle is one swap: a prompt in flight at that
 * moment can no longer be answered by the oracle that holds its work, and is orphaned until its
 * refund. With a role, a rotation is add → cut over → remove, and during the overlap either
 * oracle can answer, so nothing in flight is lost.
 *
 * Only the owner adds or removes an oracle. The contract also holds the public key that
 * prompts' session keys are encrypted to, so a client reads it from chain and a rotation reaches
 * every client. An oracle publishes that key itself, with a signature made by the key, so the
 * owner never handles it; the key is withdrawn when the oracle that published it leaves.
 */
describe("Oracle role — several oracles can be authorized at once", function () {
  const INITIAL_ALLOWANCE = ethers.parseEther("100");
  const PROMPT_FEE = ethers.parseEther("10");
  const CANCELLATION_FEE = ethers.parseEther("1");
  const METADATA_FEE = ethers.parseEther("0.5");
  const BRANCH_FEE = ethers.parseEther("2");
  const MOCK_CID = "QmXg9j4f8zYf8t7f8zYf8t7f8zYf8t7f8zYf8t7f8zYf8t7";
  const CID_BUNDLE = {
    conversationCID: MOCK_CID,
    metadataCID: MOCK_CID,
    promptMessageCID: MOCK_CID,
    answerMessageCID: MOCK_CID,
    searchDeltaCID: MOCK_CID,
  };
  const ORACLE_ROLE = ethers.id("ORACLE_ROLE");
  const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
  // secp256k1 public keys of a throwaway private key, in both encodings a client may hold.
  const THROWAWAY_KEY = new ethers.SigningKey(ethers.id("oracle-role-test-encryption-key"));
  const COMPRESSED_KEY = THROWAWAY_KEY.compressedPublicKey;
  const UNCOMPRESSED_KEY = THROWAWAY_KEY.publicKey;
  const OTHER_KEY = new ethers.SigningKey(ethers.id("oracle-role-test-other-encryption-key"));
  const KEY_PROOF_DOMAIN = "SenseAI oracle encryption key v1";

  /**
   * The signature an oracle sends with the key it publishes: made by the key itself, over the
   * chain, the agent, the publishing oracle and the key, as an EIP-191 personal message.
   */
  async function keyProof(signingKey, aiAgent, sender, overrides = {}) {
    const { chainId } = await ethers.provider.getNetwork();
    const statement = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256", "address", "address", "bytes32"],
        [
          KEY_PROOF_DOMAIN,
          overrides.chainId ?? chainId,
          overrides.agent ?? (await aiAgent.getAddress()),
          sender.address,
          ethers.keccak256(overrides.publicKey ?? signingKey.publicKey),
        ],
      ),
    );
    return signingKey.sign(ethers.hashMessage(ethers.getBytes(statement))).serialized;
  }

  describe("EVMAIAgent", function () {
    async function deployFixture() {
      const [deployer, user, oracle, secondOracle, treasury, stranger] = await ethers.getSigners();

      const token = await (await ethers.getContractFactory("MockAbleToken")).deploy();
      await token.waitForDeployment();
      await token.mint(user.address, INITIAL_ALLOWANCE);

      const aiAgent = await upgrades.deployProxy(
        await ethers.getContractFactory("EVMAIAgent"),
        ["example.com", oracle.address, deployer.address],
        { initializer: "initialize", kind: "uups" },
      );
      await aiAgent.waitForDeployment();

      const escrow = await upgrades.deployProxy(
        await ethers.getContractFactory("EVMAIAgentEscrow"),
        [
          await token.getAddress(),
          await aiAgent.getAddress(),
          treasury.address,
          deployer.address,
          PROMPT_FEE,
          CANCELLATION_FEE,
          METADATA_FEE,
          BRANCH_FEE,
        ],
        { initializer: "initialize", kind: "uups" },
      );
      await escrow.waitForDeployment();

      await aiAgent.connect(deployer).setAgentEscrow(await escrow.getAddress());
      await token.connect(user).approve(await escrow.getAddress(), INITIAL_ALLOWANCE);
      await escrow.connect(user).setSpendingLimit(INITIAL_ALLOWANCE, (await time.latest()) + 7200);

      return { aiAgent, escrow, token, deployer, user, oracle, secondOracle, stranger };
    }

    /** Submits a prompt and returns the ids the oracle needs to answer it. */
    async function submitPrompt(aiAgent, escrow, user) {
      const receipt = await (await escrow.connect(user).initiatePrompt(0, "0x", "0x")).wait();
      const topic = aiAgent.interface.getEvent("PromptSubmitted").topicHash;
      const log = receipt.logs.find((l) => l.topics[0] === topic);
      if (!log) throw new Error("PromptSubmitted not found in the initiatePrompt receipt");
      const { promptMessageId, answerMessageId } = aiAgent.interface.parseLog(log).args;
      return { promptMessageId, answerMessageId };
    }

    describe("who holds the role", function () {
      it("the oracle named at deployment holds the role, announced by RoleGranted", async function () {
        const { aiAgent, deployer, oracle } = await loadFixture(deployFixture);

        expect(await aiAgent.ORACLE_ROLE()).to.equal(ORACLE_ROLE);
        expect(await aiAgent.isOracle(oracle.address)).to.equal(true);
        expect(await aiAgent.hasRole(ORACLE_ROLE, oracle.address)).to.equal(true);
        await expect(aiAgent.deploymentTransaction())
          .to.emit(aiAgent, "RoleGranted")
          .withArgs(ORACLE_ROLE, oracle.address, deployer.address);
      });

      it("nobody holds the admin role, so grantRole and revokeRole are closed to everyone", async function () {
        const { aiAgent, deployer, oracle, stranger } = await loadFixture(deployFixture);

        expect(await aiAgent.hasRole(DEFAULT_ADMIN_ROLE, deployer.address)).to.equal(false);
        await expect(
          aiAgent.connect(deployer).grantRole(ORACLE_ROLE, stranger.address),
        ).to.be.revertedWithCustomError(aiAgent, "AccessControlUnauthorizedAccount");
        await expect(
          aiAgent.connect(deployer).revokeRole(ORACLE_ROLE, oracle.address),
        ).to.be.revertedWithCustomError(aiAgent, "AccessControlUnauthorizedAccount");
        await expect(
          aiAgent.connect(deployer).grantRole(DEFAULT_ADMIN_ROLE, deployer.address),
        ).to.be.revertedWithCustomError(aiAgent, "AccessControlUnauthorizedAccount");
      });
    });

    describe("adding and removing an oracle", function () {
      it("the owner adds an oracle, announced by RoleGranted", async function () {
        const { aiAgent, deployer, secondOracle } = await loadFixture(deployFixture);

        await expect(aiAgent.connect(deployer).addOracle(secondOracle.address))
          .to.emit(aiAgent, "RoleGranted")
          .withArgs(ORACLE_ROLE, secondOracle.address, deployer.address);

        expect(await aiAgent.isOracle(secondOracle.address)).to.equal(true);
      });

      it("the owner removes an oracle, announced by RoleRevoked", async function () {
        const { aiAgent, deployer, oracle } = await loadFixture(deployFixture);

        await expect(aiAgent.connect(deployer).removeOracle(oracle.address))
          .to.emit(aiAgent, "RoleRevoked")
          .withArgs(ORACLE_ROLE, oracle.address, deployer.address);

        expect(await aiAgent.isOracle(oracle.address)).to.equal(false);
      });

      it("only the owner can add or remove, and an oracle cannot add another", async function () {
        const { aiAgent, oracle, secondOracle, stranger } = await loadFixture(deployFixture);

        await expect(
          aiAgent.connect(stranger).addOracle(stranger.address),
        ).to.be.revertedWithCustomError(aiAgent, "OwnableUnauthorizedAccount");
        await expect(
          aiAgent.connect(oracle).addOracle(secondOracle.address),
        ).to.be.revertedWithCustomError(aiAgent, "OwnableUnauthorizedAccount");
        await expect(
          aiAgent.connect(stranger).removeOracle(oracle.address),
        ).to.be.revertedWithCustomError(aiAgent, "OwnableUnauthorizedAccount");
      });

      it("refuses the zero address", async function () {
        const { aiAgent, deployer } = await loadFixture(deployFixture);

        await expect(
          aiAgent.connect(deployer).addOracle(ethers.ZeroAddress),
        ).to.be.revertedWithCustomError(aiAgent, "ZeroAddress");
        await expect(
          aiAgent.connect(deployer).removeOracle(ethers.ZeroAddress),
        ).to.be.revertedWithCustomError(aiAgent, "ZeroAddress");
      });

      it("removing an address that is not an oracle changes nothing and announces nothing", async function () {
        const { aiAgent, deployer, oracle, stranger } = await loadFixture(deployFixture);

        await expect(aiAgent.connect(deployer).removeOracle(stranger.address)).to.not.emit(
          aiAgent,
          "RoleRevoked",
        );
        expect(await aiAgent.isOracle(oracle.address)).to.equal(true);
      });
    });

    describe("what cannot change the set of oracles", function () {
      it("an oracle can give up its own role, and nobody can give it up for it", async function () {
        const { aiAgent, oracle, stranger } = await loadFixture(deployFixture);

        await expect(
          aiAgent.connect(stranger).renounceRole(ORACLE_ROLE, oracle.address),
        ).to.be.revertedWithCustomError(aiAgent, "AccessControlBadConfirmation");
        await aiAgent.connect(oracle).renounceRole(ORACLE_ROLE, oracle.address);

        expect(await aiAgent.isOracle(oracle.address)).to.equal(false);
      });

      it("a new owner inherits the power to add and remove, and the old owner loses it", async function () {
        const { aiAgent, deployer, oracle, secondOracle, stranger } =
          await loadFixture(deployFixture);

        await aiAgent.connect(deployer).transferOwnership(stranger.address);

        expect(await aiAgent.isOracle(oracle.address)).to.equal(true);
        await expect(
          aiAgent.connect(deployer).addOracle(secondOracle.address),
        ).to.be.revertedWithCustomError(aiAgent, "OwnableUnauthorizedAccount");
        await aiAgent.connect(stranger).addOracle(secondOracle.address);
        expect(await aiAgent.isOracle(secondOracle.address)).to.equal(true);
      });

      it("the implementation contracts cannot be initialized directly", async function () {
        const { aiAgent, escrow, stranger } = await loadFixture(deployFixture);
        const agentImplementation = await ethers.getContractAt(
          "EVMAIAgent",
          await upgrades.erc1967.getImplementationAddress(await aiAgent.getAddress()),
        );
        const escrowImplementation = await ethers.getContractAt(
          "EVMAIAgentEscrow",
          await upgrades.erc1967.getImplementationAddress(await escrow.getAddress()),
        );

        await expect(
          agentImplementation
            .connect(stranger)
            .initialize("example.com", stranger.address, stranger.address),
        ).to.be.revertedWithCustomError(agentImplementation, "InvalidInitialization");
        await expect(
          escrowImplementation
            .connect(stranger)
            .initialize(
              stranger.address,
              stranger.address,
              stranger.address,
              stranger.address,
              PROMPT_FEE,
              CANCELLATION_FEE,
              METADATA_FEE,
              BRANCH_FEE,
            ),
        ).to.be.revertedWithCustomError(escrowImplementation, "InvalidInitialization");
      });
    });

    describe("what the role gates", function () {
      it("an address without the role cannot answer", async function () {
        const { aiAgent, escrow, user, stranger } = await loadFixture(deployFixture);
        const { promptMessageId, answerMessageId } = await submitPrompt(aiAgent, escrow, user);

        await expect(
          aiAgent.connect(stranger).submitAnswer(promptMessageId, answerMessageId, CID_BUNDLE),
        ).to.be.revertedWithCustomError(aiAgent, "UnauthorizedOracle");
      });

      it("the escrow's oracle-only entry point follows the same role", async function () {
        const { aiAgent, escrow, deployer, user, secondOracle, stranger } =
          await loadFixture(deployFixture);
        await aiAgent.connect(deployer).addOracle(secondOracle.address);

        await expect(
          escrow.connect(stranger).initiateAgentJob(user.address, 0, "0x", "0x"),
        ).to.be.revertedWithCustomError(escrow, "NotOracle");
        await expect(
          escrow.connect(secondOracle).initiateAgentJob(user.address, 0, "0x", "0x"),
        ).to.emit(aiAgent, "AgentJobSubmitted");
      });
    });

    describe("rotation with an overlap", function () {
      it("a prompt in flight when a second oracle is added can be answered by the new oracle", async function () {
        const { aiAgent, escrow, deployer, user, secondOracle } = await loadFixture(deployFixture);
        const { promptMessageId, answerMessageId } = await submitPrompt(aiAgent, escrow, user);

        await aiAgent.connect(deployer).addOracle(secondOracle.address);

        await expect(
          aiAgent.connect(secondOracle).submitAnswer(promptMessageId, answerMessageId, CID_BUNDLE),
        ).to.emit(aiAgent, "AnswerMessageAdded");
      });

      it("during the overlap the old oracle can still answer what it holds", async function () {
        const { aiAgent, escrow, deployer, user, oracle, secondOracle } =
          await loadFixture(deployFixture);
        const { promptMessageId, answerMessageId } = await submitPrompt(aiAgent, escrow, user);

        await aiAgent.connect(deployer).addOracle(secondOracle.address);

        await expect(
          aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, CID_BUNDLE),
        ).to.emit(aiAgent, "AnswerMessageAdded");
      });

      it("after the old oracle is removed it is refused and the new one carries on", async function () {
        const { aiAgent, escrow, deployer, user, oracle, secondOracle } =
          await loadFixture(deployFixture);
        await aiAgent.connect(deployer).addOracle(secondOracle.address);
        await aiAgent.connect(deployer).removeOracle(oracle.address);
        const { promptMessageId, answerMessageId } = await submitPrompt(aiAgent, escrow, user);

        await expect(
          aiAgent.connect(oracle).submitAnswer(promptMessageId, answerMessageId, CID_BUNDLE),
        ).to.be.revertedWithCustomError(aiAgent, "UnauthorizedOracle");
        await expect(
          aiAgent.connect(secondOracle).submitAnswer(promptMessageId, answerMessageId, CID_BUNDLE),
        ).to.emit(aiAgent, "AnswerMessageAdded");
      });

      it("removing the only oracle wedges nothing: the user's prompt is still refundable", async function () {
        const { aiAgent, escrow, deployer, user, oracle, stranger } =
          await loadFixture(deployFixture);
        const { answerMessageId } = await submitPrompt(aiAgent, escrow, user);
        await aiAgent.connect(deployer).removeOracle(oracle.address);
        await time.increase(Number(await escrow.REFUND_TIMEOUT()) + 1);

        await expect(escrow.connect(stranger).processRefund(answerMessageId))
          .to.emit(escrow, "PaymentRefunded")
          .withArgs(answerMessageId);
      });
    });

    describe("the encryption key clients read from chain", function () {
      /** Publishes `signingKey`'s public key as `sender`, with a valid proof. */
      async function publish(aiAgent, sender, signingKey = THROWAWAY_KEY) {
        return aiAgent
          .connect(sender)
          .setOracleEncryptionKey(
            signingKey.publicKey,
            await keyProof(signingKey, aiAgent, sender),
          );
      }

      it("is empty, with no publisher, until an oracle publishes one", async function () {
        const { aiAgent } = await loadFixture(deployFixture);

        expect(await aiAgent.oracleEncryptionKey()).to.equal("0x");
        expect(await aiAgent.oracleEncryptionKeyPublisher()).to.equal(ethers.ZeroAddress);
      });

      it("an oracle publishes a key it holds, announced with the oracle and the key", async function () {
        const { aiAgent, oracle } = await loadFixture(deployFixture);

        await expect(publish(aiAgent, oracle))
          .to.emit(aiAgent, "OracleEncryptionKeyUpdated")
          .withArgs(oracle.address, UNCOMPRESSED_KEY);

        expect(await aiAgent.oracleEncryptionKey()).to.equal(UNCOMPRESSED_KEY);
        expect(await aiAgent.oracleEncryptionKeyPublisher()).to.equal(oracle.address);
      });

      it("only an oracle can publish: the owner and a stranger are refused", async function () {
        const { aiAgent, deployer, stranger } = await loadFixture(deployFixture);

        for (const sender of [deployer, stranger]) {
          await expect(publish(aiAgent, sender)).to.be.revertedWithCustomError(
            aiAgent,
            "UnauthorizedOracle",
          );
        }
        expect(await aiAgent.oracleEncryptionKey()).to.equal("0x");
      });

      it("refuses a key whose proof was not made by that key", async function () {
        const { aiAgent, oracle } = await loadFixture(deployFixture);
        // OTHER_KEY signs a statement about THROWAWAY_KEY's public key.
        const proof = await keyProof(OTHER_KEY, aiAgent, oracle, { publicKey: UNCOMPRESSED_KEY });

        await expect(
          aiAgent.connect(oracle).setOracleEncryptionKey(UNCOMPRESSED_KEY, proof),
        ).to.be.revertedWithCustomError(aiAgent, "InvalidEncryptionKeyProof");
      });

      it("refuses a proof made for another oracle, another agent or another chain", async function () {
        const { aiAgent, oracle, secondOracle, stranger } = await loadFixture(deployFixture);
        const { chainId } = await ethers.provider.getNetwork();
        const proofs = [
          await keyProof(THROWAWAY_KEY, aiAgent, secondOracle),
          await keyProof(THROWAWAY_KEY, aiAgent, oracle, { agent: stranger.address }),
          await keyProof(THROWAWAY_KEY, aiAgent, oracle, { chainId: chainId + 1n }),
        ];

        for (const proof of proofs) {
          await expect(
            aiAgent.connect(oracle).setOracleEncryptionKey(UNCOMPRESSED_KEY, proof),
          ).to.be.revertedWithCustomError(aiAgent, "InvalidEncryptionKeyProof");
        }
      });

      it("refuses a proof that is not a signature at all", async function () {
        const { aiAgent, oracle } = await loadFixture(deployFixture);
        const valid = await keyProof(THROWAWAY_KEY, aiAgent, oracle);
        // Empty, one byte short, and a full-length signature whose `s` is zero.
        const zeroS = ethers.concat([ethers.dataSlice(valid, 0, 32), ethers.ZeroHash, "0x1b"]);

        for (const proof of ["0x", ethers.dataSlice(valid, 0, 64), zeroS]) {
          await expect(
            aiAgent.connect(oracle).setOracleEncryptionKey(UNCOMPRESSED_KEY, proof),
          ).to.be.revertedWithCustomError(aiAgent, "InvalidEncryptionKeyProof");
        }
      });

      it("refuses bytes that are not an uncompressed secp256k1 public key", async function () {
        const { aiAgent, oracle } = await loadFixture(deployFixture);
        const proof = await keyProof(THROWAWAY_KEY, aiAgent, oracle);
        const wrongLength = ethers.dataSlice(UNCOMPRESSED_KEY, 0, 64);
        const wrongPrefix = "0x02" + UNCOMPRESSED_KEY.slice(4);

        // The compressed form is refused too: the proof is checked against the full point.
        for (const badKey of ["0x", wrongLength, wrongPrefix, COMPRESSED_KEY]) {
          await expect(
            aiAgent.connect(oracle).setOracleEncryptionKey(badKey, proof),
          ).to.be.revertedWithCustomError(aiAgent, "InvalidEncryptionKey");
        }
      });

      it("publishing the key that is already there changes nothing and announces nothing", async function () {
        const { aiAgent, deployer, oracle, secondOracle } = await loadFixture(deployFixture);
        await aiAgent.connect(deployer).addOracle(secondOracle.address);
        await publish(aiAgent, oracle);

        // The publisher again, and a second oracle that holds the same key (a replica).
        for (const sender of [oracle, secondOracle]) {
          await expect(publish(aiAgent, sender)).to.not.emit(aiAgent, "OracleEncryptionKeyUpdated");
        }
        expect(await aiAgent.oracleEncryptionKeyPublisher()).to.equal(oracle.address);
      });

      it("the publisher can replace its own key", async function () {
        const { aiAgent, oracle } = await loadFixture(deployFixture);
        await publish(aiAgent, oracle);

        await expect(publish(aiAgent, oracle, OTHER_KEY))
          .to.emit(aiAgent, "OracleEncryptionKeyUpdated")
          .withArgs(oracle.address, OTHER_KEY.publicKey);
        expect(await aiAgent.oracleEncryptionKey()).to.equal(OTHER_KEY.publicKey);
      });

      it("another oracle cannot replace a key its publisher still stands behind", async function () {
        const { aiAgent, deployer, oracle, secondOracle } = await loadFixture(deployFixture);
        await aiAgent.connect(deployer).addOracle(secondOracle.address);
        await publish(aiAgent, oracle);

        await expect(publish(aiAgent, secondOracle, OTHER_KEY))
          .to.be.revertedWithCustomError(aiAgent, "EncryptionKeyHeldByAnotherOracle")
          .withArgs(oracle.address);
        expect(await aiAgent.oracleEncryptionKey()).to.equal(UNCOMPRESSED_KEY);
      });

      it("removing the publisher withdraws its key, and another oracle can then publish", async function () {
        const { aiAgent, deployer, oracle, secondOracle } = await loadFixture(deployFixture);
        await aiAgent.connect(deployer).addOracle(secondOracle.address);
        await publish(aiAgent, oracle);

        await expect(aiAgent.connect(deployer).removeOracle(oracle.address))
          .to.emit(aiAgent, "OracleEncryptionKeyUpdated")
          .withArgs(ethers.ZeroAddress, "0x");
        expect(await aiAgent.oracleEncryptionKey()).to.equal("0x");
        expect(await aiAgent.oracleEncryptionKeyPublisher()).to.equal(ethers.ZeroAddress);

        await expect(publish(aiAgent, secondOracle, OTHER_KEY))
          .to.emit(aiAgent, "OracleEncryptionKeyUpdated")
          .withArgs(secondOracle.address, OTHER_KEY.publicKey);
      });

      it("a publisher that gives up its role withdraws its key too", async function () {
        const { aiAgent, oracle } = await loadFixture(deployFixture);
        await publish(aiAgent, oracle);

        await expect(aiAgent.connect(oracle).renounceRole(ORACLE_ROLE, oracle.address))
          .to.emit(aiAgent, "OracleEncryptionKeyUpdated")
          .withArgs(ethers.ZeroAddress, "0x");
        expect(await aiAgent.oracleEncryptionKey()).to.equal("0x");
      });

      it("removing an oracle that did not publish the key leaves the key alone", async function () {
        const { aiAgent, deployer, oracle, secondOracle, stranger } =
          await loadFixture(deployFixture);
        await aiAgent.connect(deployer).addOracle(secondOracle.address);
        await publish(aiAgent, oracle);

        // An oracle that is not the publisher, then an address that is not an oracle at all.
        for (const account of [secondOracle, stranger]) {
          await expect(aiAgent.connect(deployer).removeOracle(account.address)).to.not.emit(
            aiAgent,
            "OracleEncryptionKeyUpdated",
          );
        }
        expect(await aiAgent.oracleEncryptionKey()).to.equal(UNCOMPRESSED_KEY);
        expect(await aiAgent.oracleEncryptionKeyPublisher()).to.equal(oracle.address);
      });

      it("a prompt paid for before the publisher was removed is still refundable", async function () {
        const { aiAgent, escrow, deployer, user, oracle, stranger } =
          await loadFixture(deployFixture);
        await publish(aiAgent, oracle);
        const { answerMessageId } = await submitPrompt(aiAgent, escrow, user);
        await aiAgent.connect(deployer).removeOracle(oracle.address);
        await time.increase(Number(await escrow.REFUND_TIMEOUT()) + 1);

        await expect(escrow.connect(stranger).processRefund(answerMessageId))
          .to.emit(escrow, "PaymentRefunded")
          .withArgs(answerMessageId);
      });
    });

    describe("a proxy upgraded from the single-oracle version", function () {
      // The real agent cannot be put back into its pre-role state on demand, so a test-only
      // agent writes the legacy single-oracle slot the way the deployed proxy holds it.
      async function legacyStateFixture() {
        const [deployer, user, initialOracle, legacyOracle, stranger] = await ethers.getSigners();
        const aiAgent = await upgrades.deployProxy(
          await ethers.getContractFactory("EVMAIAgentLegacyOracleHarness"),
          ["example.com", initialOracle.address, deployer.address],
          { initializer: "initialize", kind: "uups" },
        );
        await aiAgent.waitForDeployment();
        await aiAgent.connect(deployer).removeOracle(initialOracle.address);
        await aiAgent.seedLegacyOracle(legacyOracle.address);
        return { aiAgent, deployer, user, legacyOracle, stranger };
      }

      it("the migration gives the role to the oracle the old version stored", async function () {
        const { aiAgent, deployer, legacyOracle } = await loadFixture(legacyStateFixture);
        expect(await aiAgent.isOracle(legacyOracle.address)).to.equal(false);

        await expect(aiAgent.connect(deployer).migrateOracleRole())
          .to.emit(aiAgent, "RoleGranted")
          .withArgs(ORACLE_ROLE, legacyOracle.address, deployer.address);

        expect(await aiAgent.isOracle(legacyOracle.address)).to.equal(true);
      });

      it("runs once, and only for the owner", async function () {
        const { aiAgent, deployer, stranger } = await loadFixture(legacyStateFixture);

        await expect(aiAgent.connect(stranger).migrateOracleRole()).to.be.revertedWithCustomError(
          aiAgent,
          "OwnableUnauthorizedAccount",
        );
        await aiAgent.connect(deployer).migrateOracleRole();
        await expect(aiAgent.connect(deployer).migrateOracleRole()).to.be.revertedWithCustomError(
          aiAgent,
          "InvalidInitialization",
        );
      });

      it("the migration leaves a published key and its publisher alone", async function () {
        // Deployed directly: this test needs the initial oracle to keep its role.
        const [deployer, , initialOracle, legacyOracle] = await ethers.getSigners();
        const aiAgent = await upgrades.deployProxy(
          await ethers.getContractFactory("EVMAIAgentLegacyOracleHarness"),
          ["example.com", initialOracle.address, deployer.address],
          { initializer: "initialize", kind: "uups" },
        );
        await aiAgent.waitForDeployment();
        await aiAgent
          .connect(initialOracle)
          .setOracleEncryptionKey(
            UNCOMPRESSED_KEY,
            await keyProof(THROWAWAY_KEY, aiAgent, initialOracle),
          );
        await aiAgent.seedLegacyOracle(legacyOracle.address);

        const migration = aiAgent.connect(deployer).migrateOracleRole();

        await expect(migration).to.emit(aiAgent, "RoleGranted");
        await expect(migration).to.not.emit(aiAgent, "OracleEncryptionKeyUpdated");
        expect(await aiAgent.oracleEncryptionKey()).to.equal(UNCOMPRESSED_KEY);
        expect(await aiAgent.oracleEncryptionKeyPublisher()).to.equal(initialOracle.address);
      });

      it("the deploy script asks for the migration only while the legacy address is stored", async function () {
        const { aiAgent, deployer } = await loadFixture(legacyStateFixture);
        const proxyAddress = await aiAgent.getAddress();
        // Deployed directly: loading a second fixture would roll the first one back.
        const fresh = await deployFixture();

        expect(await needsOracleRoleMigration(ethers.provider, proxyAddress)).to.equal(true);
        await aiAgent.connect(deployer).migrateOracleRole();
        expect(await needsOracleRoleMigration(ethers.provider, proxyAddress)).to.equal(false);
        expect(
          await needsOracleRoleMigration(ethers.provider, await fresh.aiAgent.getAddress()),
        ).to.equal(false);
      });

      it("once the owner has added an oracle, a late migration cannot bring the stored one back", async function () {
        const { aiAgent, deployer, legacyOracle, stranger } = await loadFixture(legacyStateFixture);

        await aiAgent.connect(deployer).addOracle(stranger.address);

        expect(
          await needsOracleRoleMigration(ethers.provider, await aiAgent.getAddress()),
        ).to.equal(false);
        await expect(aiAgent.connect(deployer).migrateOracleRole()).to.not.emit(
          aiAgent,
          "RoleGranted",
        );
        expect(await aiAgent.isOracle(legacyOracle.address)).to.equal(false);
      });

      it("removing the stored oracle itself retires it", async function () {
        const { aiAgent, deployer, legacyOracle } = await loadFixture(legacyStateFixture);

        await aiAgent.connect(deployer).removeOracle(legacyOracle.address);
        await aiAgent.connect(deployer).migrateOracleRole();

        expect(await aiAgent.isOracle(legacyOracle.address)).to.equal(false);
      });

      it("removing some other address, or the zero address, leaves the stored oracle to be migrated", async function () {
        const { aiAgent, deployer, legacyOracle, stranger } = await loadFixture(legacyStateFixture);

        await aiAgent.connect(deployer).removeOracle(stranger.address);
        await expect(
          aiAgent.connect(deployer).removeOracle(ethers.ZeroAddress),
        ).to.be.revertedWithCustomError(aiAgent, "ZeroAddress");
        await aiAgent.connect(deployer).migrateOracleRole();

        expect(await aiAgent.isOracle(legacyOracle.address)).to.equal(true);
      });

      it("on a fresh deployment there is nothing to migrate and no role is granted", async function () {
        const { aiAgent, deployer } = await loadFixture(deployFixture);

        await expect(aiAgent.connect(deployer).migrateOracleRole()).to.not.emit(
          aiAgent,
          "RoleGranted",
        );
      });
    });
  });

  describe("SapphireAIAgent", function () {
    const ROFL_APP_ID = ethers.zeroPadBytes("0x00", 21);

    // Adding an oracle on Sapphire is the ROFL app registering itself from inside its TEE, which
    // the Hardhat network cannot attest. A test-only agent adds one directly so the rest of the
    // role behaviour can be exercised.
    async function deployFixture() {
      const [deployer, user, oracle, secondOracle, stranger] = await ethers.getSigners();
      const aiAgent = await (
        await ethers.getContractFactory("SapphireAIAgentOracleHarness")
      ).deploy("example.com", ROFL_APP_ID, oracle.address, deployer.address);
      await aiAgent.waitForDeployment();
      const mockEscrow = await (
        await ethers.getContractFactory("MockSapphireAIAgentEscrow")
      ).deploy(await aiAgent.getAddress());
      await mockEscrow.waitForDeployment();
      await aiAgent.connect(deployer).setAgentEscrow(await mockEscrow.getAddress());
      return { aiAgent, mockEscrow, deployer, user, oracle, secondOracle, stranger };
    }

    const CONVERSATION_ID = 1;
    const PROMPT_MESSAGE_ID = 0;
    const ANSWER_MESSAGE_ID = 1;

    async function submitPrompt(mockEscrow, user) {
      // The agent accepts a new conversation only under an id it has handed out, as the escrow does.
      await mockEscrow.callReserveConversationId();
      await mockEscrow
        .connect(user)
        .callSubmitPrompt(
          user.address,
          CONVERSATION_ID,
          PROMPT_MESSAGE_ID,
          ANSWER_MESSAGE_ID,
          "payload",
        );
    }

    it("the oracle named at deployment holds the role, announced by RoleGranted", async function () {
      const { aiAgent, deployer, oracle } = await loadFixture(deployFixture);

      expect(await aiAgent.isOracle(oracle.address)).to.equal(true);
      await expect(aiAgent.deploymentTransaction())
        .to.emit(aiAgent, "RoleGranted")
        .withArgs(ORACLE_ROLE, oracle.address, deployer.address);
    });

    it("nobody holds the admin role, so grantRole is closed to everyone", async function () {
      const { aiAgent, deployer, stranger } = await loadFixture(deployFixture);

      expect(await aiAgent.hasRole(DEFAULT_ADMIN_ROLE, deployer.address)).to.equal(false);
      await expect(
        aiAgent.connect(deployer).grantRole(ORACLE_ROLE, stranger.address),
      ).to.be.revertedWithCustomError(aiAgent, "AccessControlUnauthorizedAccount");
    });

    it("an oracle can only be added from inside the ROFL app's TEE", async function () {
      const { aiAgent, deployer, stranger } = await loadFixture(deployFixture);

      // The attestation check has no custom error on a non-Sapphire network; it just reverts.
      await expect(aiAgent.connect(stranger).addOracle(stranger.address)).to.be.reverted;
      await expect(aiAgent.connect(deployer).addOracle(stranger.address)).to.be.reverted;
    });

    it("the owner removes an oracle, and nobody else can", async function () {
      const { aiAgent, deployer, oracle, stranger } = await loadFixture(deployFixture);

      await expect(
        aiAgent.connect(stranger).removeOracle(oracle.address),
      ).to.be.revertedWithCustomError(aiAgent, "OwnableUnauthorizedAccount");
      await expect(aiAgent.connect(deployer).removeOracle(oracle.address))
        .to.emit(aiAgent, "RoleRevoked")
        .withArgs(ORACLE_ROLE, oracle.address, deployer.address);
      expect(await aiAgent.isOracle(oracle.address)).to.equal(false);
      await expect(
        aiAgent.connect(deployer).removeOracle(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(aiAgent, "ZeroAddress");
      await expect(aiAgent.connect(deployer).removeOracle(stranger.address)).to.not.emit(
        aiAgent,
        "RoleRevoked",
      );
    });

    it("an address without the role cannot answer", async function () {
      const { aiAgent, mockEscrow, user, stranger } = await loadFixture(deployFixture);
      await submitPrompt(mockEscrow, user);

      await expect(
        aiAgent.connect(stranger).submitAnswer(PROMPT_MESSAGE_ID, ANSWER_MESSAGE_ID, CID_BUNDLE),
      ).to.be.revertedWithCustomError(aiAgent, "UnauthorizedOracle");
    });

    it("a prompt in flight when a second oracle is added can be answered by the new oracle", async function () {
      const { aiAgent, mockEscrow, user, secondOracle } = await loadFixture(deployFixture);
      await submitPrompt(mockEscrow, user);

      await aiAgent.addOracleForTest(secondOracle.address);

      await expect(
        aiAgent
          .connect(secondOracle)
          .submitAnswer(PROMPT_MESSAGE_ID, ANSWER_MESSAGE_ID, CID_BUNDLE),
      ).to.emit(aiAgent, "AnswerMessageAdded");
    });

    it("after the old oracle is removed it is refused and the new one carries on", async function () {
      const { aiAgent, mockEscrow, deployer, user, oracle, secondOracle } =
        await loadFixture(deployFixture);
      await aiAgent.addOracleForTest(secondOracle.address);
      await aiAgent.connect(deployer).removeOracle(oracle.address);
      await submitPrompt(mockEscrow, user);

      await expect(
        aiAgent.connect(oracle).submitAnswer(PROMPT_MESSAGE_ID, ANSWER_MESSAGE_ID, CID_BUNDLE),
      ).to.be.revertedWithCustomError(aiAgent, "UnauthorizedOracle");
      await expect(
        aiAgent
          .connect(secondOracle)
          .submitAnswer(PROMPT_MESSAGE_ID, ANSWER_MESSAGE_ID, CID_BUNDLE),
      ).to.emit(aiAgent, "AnswerMessageAdded");
    });

    it("the encryption key can only be published from inside the ROFL app's TEE", async function () {
      const { aiAgent, deployer, stranger } = await loadFixture(deployFixture);

      // The attestation check has no custom error on a non-Sapphire network; it just reverts.
      await expect(aiAgent.connect(stranger).setOracleEncryptionKey(COMPRESSED_KEY)).to.be.reverted;
      await expect(aiAgent.connect(deployer).setOracleEncryptionKey(COMPRESSED_KEY)).to.be.reverted;
      expect(await aiAgent.oracleEncryptionKey()).to.equal("0x");
    });

    it("a published key is checked, stored and announced", async function () {
      const { aiAgent, stranger } = await loadFixture(deployFixture);

      await expect(aiAgent.setOracleEncryptionKeyForTest("0x1234")).to.be.revertedWithCustomError(
        aiAgent,
        "InvalidEncryptionKey",
      );
      // The event names who published, as the EVM agent's does: one event shape for both.
      await expect(aiAgent.connect(stranger).setOracleEncryptionKeyForTest(COMPRESSED_KEY))
        .to.emit(aiAgent, "OracleEncryptionKeyUpdated")
        .withArgs(stranger.address, COMPRESSED_KEY);
      expect(await aiAgent.oracleEncryptionKey()).to.equal(COMPRESSED_KEY);
    });
  });
});
