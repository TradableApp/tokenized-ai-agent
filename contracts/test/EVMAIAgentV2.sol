// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { EVMAIAgent } from "../../contracts/EVMAIAgent.sol";

/**
 * @title EVMAIAgentV2
 * @dev A dummy V2 contract for testing the upgradeability of EVMAIAgent.
 * It inherits from the original contract and adds a new `version` function.
 * This pattern is used to test the UUPS upgrade mechanism.
 */
contract EVMAIAgentV2 is EVMAIAgent {
  /**
   * @notice Returns the version of this contract.
   * @return A string representing the version number.
   */
  function version() public pure returns (string memory) {
    return "2.0";
  }
}
