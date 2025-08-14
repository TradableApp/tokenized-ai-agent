const chai = require("chai");
const { expect } = chai;
const { ethers } = require("ethers");
const { initializeOracle, loadContractArtifact } = require("../src/contractUtility");

describe("contractUtility", function () {
  // A correctly formatted fake private key is needed for the Ethers Wallet constructor.
  const FAKE_PRIVATE_KEY = "0x" + "a".repeat(64);
  const FAKE_CONTRACT_ADDRESS = "0x" + "b".repeat(40);

  describe("loadContractArtifact", function () {
    it("should correctly load the ABI for an existing contract", () => {
      // Act: Load a real, compiled contract artifact.
      const artifact = loadContractArtifact("SapphireAIAgent");

      // Assert: Check that the returned object has the expected structure.
      expect(artifact).to.be.an("object");
      expect(artifact).to.have.property("abi");
      expect(artifact.abi).to.be.an("array");
      expect(artifact.abi.length).to.be.greaterThan(0);
    });

    it("should throw an error if the contract artifact does not exist", () => {
      const invalidContractName = "NonExistentContract";
      // Assert: Check that the function throws the specific error message we expect.
      expect(() => loadContractArtifact(invalidContractName)).to.throw(
        `Contract artifacts not found for "${invalidContractName}"`,
      );
    });
  });

  describe("initializeOracle", function () {
    it("should initialize correctly for a Sapphire network by returning wrapped instances", () => {
      // Act: Call the function we are testing.
      const result = initializeOracle("sapphire-testnet", FAKE_PRIVATE_KEY, FAKE_CONTRACT_ADDRESS);

      // Assert: Check that the returned objects are instances of the correct Sapphire-wrapped classes.
      expect(result.isSapphire).to.be.true;
      expect(result.provider).to.be.an.instanceOf(ethers.JsonRpcProvider);
      expect(result.signer).to.be.an.instanceOf(ethers.Wallet);
      expect(result.contract).to.be.an.instanceOf(ethers.Contract);
    });

    it("should initialize correctly for a public EVM network by returning unwrapped instances", () => {
      // Act: Call the function we are testing.
      const result = initializeOracle("baseSepolia", FAKE_PRIVATE_KEY, FAKE_CONTRACT_ADDRESS);

      // Assert: Check that the objects are instances of the standard Ethers classes.
      expect(result.isSapphire).to.be.false;
      expect(result.provider).to.be.an.instanceOf(ethers.JsonRpcProvider);
      expect(result.signer).to.be.an.instanceOf(ethers.Wallet);
      expect(result.contract).to.be.an.instanceOf(ethers.Contract);
    });

    it("should throw an error for a missing private key", () => {
      expect(() => initializeOracle("sapphire-testnet", null, FAKE_CONTRACT_ADDRESS)).to.throw(
        "Missing required env variable: PRIVATE_KEY",
      );
    });

    it("should throw an error for a missing contract address", () => {
      expect(() => initializeOracle("sapphire-testnet", FAKE_PRIVATE_KEY, null)).to.throw(
        "Missing required env variable: AI_AGENT_CONTRACT_ADDRESS",
      );
    });

    it("should throw an error for an unknown network", () => {
      expect(() =>
        initializeOracle("unknown-network", FAKE_PRIVATE_KEY, FAKE_CONTRACT_ADDRESS),
      ).to.throw('RPC URL for network "unknown-network" not found.');
    });
  });
});
