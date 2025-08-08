// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { IEVMAIAgentEscrow } from "../../contracts/interfaces/IEVMAIAgentEscrow.sol";
import { IEVMAIAgent } from "../../contracts/interfaces/IEVMAIAgent.sol";

// A mock contract to simulate the EVMAIAgent for testing the escrow.
contract MockEVMAIAgent is IEVMAIAgent {
  uint256 private _promptIdCounter;

  event PromptSubmitted(uint256 promptId, address user);

  // This view function is essential for the escrow contract to get the next ID.
  function promptIdCounter() external view returns (uint256) {
    return _promptIdCounter;
  }

  function submitPrompt(
    uint256 _promptId,
    address _user,
    bytes calldata, // _encryptedContent
    bytes calldata, // _userEncryptedKey
    bytes calldata // _roflEncryptedKey
  ) external {
    _promptIdCounter++;
    emit PromptSubmitted(_promptId, _user);
  }

  // A helper for the test suite to simulate the agent calling back to finalize payment.
  function callFinalizePayment(address _escrow, uint256 _promptId) external {
    IEVMAIAgentEscrow(_escrow).finalizePayment(_promptId);
  }
}
