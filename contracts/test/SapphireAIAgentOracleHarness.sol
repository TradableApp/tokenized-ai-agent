// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { SapphireAIAgent } from "../SapphireAIAgent.sol";

/**
 * @title Sapphire AI Agent oracle harness
 * @author Tradable
 * @notice Test-only agent that can authorize an oracle and publish the encryption key without a
 *         TEE attestation, which a non-Sapphire test network cannot produce.
 * @dev Never deployed outside tests.
 */
contract SapphireAIAgentOracleHarness is SapphireAIAgent {
  /**
   * @notice Deploys the agent under test with the same arguments as the real one.
   * @param _domain The domain used for off-chain SIWE validation.
   * @param _roflAppID The attested ROFL app that is allowed to call addOracle().
   * @param _initialOracle The first address authorized as an oracle.
   * @param _initialOwner The address that will have ownership of this contract.
   */
  constructor(
    string memory _domain,
    bytes21 _roflAppID,
    address _initialOracle,
    address _initialOwner
  ) SapphireAIAgent(_domain, _roflAppID, _initialOracle, _initialOwner) {}

  /**
   * @notice Authorizes an oracle the way `addOracle` does from inside the TEE.
   * @param _oracle The address to authorize.
   */
  function addOracleForTest(address _oracle) external {
    _grantRole(ORACLE_ROLE, _oracle);
  }

  /**
   * @notice Publishes the encryption key the way `setOracleEncryptionKey` does from inside the TEE.
   * @param _newKey A secp256k1 public key: 33 bytes compressed or 65 bytes uncompressed.
   */
  function setOracleEncryptionKeyForTest(bytes calldata _newKey) external {
    _setOracleEncryptionKey(_newKey);
  }
}
