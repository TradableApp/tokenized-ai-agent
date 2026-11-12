// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { EVMAIAgent } from "../EVMAIAgent.sol";

/**
 * @title EVM AI Agent legacy-oracle harness
 * @author Tradable
 * @notice Test-only agent that can be put in the state a proxy holds when it is upgraded from the
 *         single-oracle version: an oracle address in the legacy slot and no role holder.
 * @dev Never deployed outside tests.
 */
contract EVMAIAgentLegacyOracleHarness is EVMAIAgent {
  /**
   * @notice Writes the legacy single-oracle slot, as the previous version's `setOracle` did.
   * @param _oracle The address the previous version would have stored.
   */
  function seedLegacyOracle(address _oracle) external {
    _legacyOracle = _oracle;
  }
}
