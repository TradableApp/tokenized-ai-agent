const { ethers } = require("hardhat");

// The first field of the statement a key signs to be published, as the agent contract has it.
// Written out here and not read from the contract, so a change to either fails the tests.
const ENCRYPTION_KEY_PROOF_DOMAIN = "SenseAI oracle encryption key v1";

/**
 * The signature an oracle sends with the encryption key it publishes: made by the key itself,
 * over the chain, the agent, the publishing oracle and the key, as an EIP-191 personal message.
 *
 * @param {import("ethers").SigningKey} signingKey The key that signs.
 * @param {import("ethers").Contract} aiAgent The agent the key is published to.
 * @param {{ address: string }} sender The oracle that will send the transaction.
 * @param {{ chainId?: bigint, agent?: string, publicKey?: string }} [overrides] Values to put in
 *        the statement in place of the true ones, for building a proof that must be refused.
 * @returns {Promise<string>} The 65-byte signature, hex.
 */
async function encryptionKeyProof(signingKey, aiAgent, sender, overrides = {}) {
  const { chainId } = await ethers.provider.getNetwork();
  const statement = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256", "address", "address", "bytes32"],
      [
        ENCRYPTION_KEY_PROOF_DOMAIN,
        overrides.chainId ?? chainId,
        overrides.agent ?? (await aiAgent.getAddress()),
        sender.address,
        ethers.keccak256(overrides.publicKey ?? signingKey.publicKey),
      ],
    ),
  );
  return signingKey.sign(ethers.hashMessage(ethers.getBytes(statement))).serialized;
}

/**
 * Publishes `signingKey`'s public key to the agent as `sender`, with a valid proof.
 * @returns {Promise<import("ethers").ContractTransactionResponse>}
 */
async function publishEncryptionKey(aiAgent, sender, signingKey) {
  return aiAgent
    .connect(sender)
    .setOracleEncryptionKey(
      signingKey.publicKey,
      await encryptionKeyProof(signingKey, aiAgent, sender),
    );
}

module.exports = { ENCRYPTION_KEY_PROOF_DOMAIN, encryptionKeyProof, publishEncryptionKey };
