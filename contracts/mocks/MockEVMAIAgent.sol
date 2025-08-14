// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { IEVMAIAgentEscrow } from "../../contracts/interfaces/IEVMAIAgentEscrow.sol";
import { IEVMAIAgent } from "../../contracts/interfaces/IEVMAIAgent.sol";

contract MockEVMAIAgent is IEVMAIAgent {
  uint256 private _promptIdCounter; // Make it private to force use of the getter
  uint256 public lastCancelledPromptId;
  uint256 public cancellationCallCount;

  event PromptSubmitted(uint256 promptId, address user);

  // This view function is essential for the escrow contract to get the next ID.
  function promptIdCounter() external view override returns (uint256) {
    return _promptIdCounter;
  }

  function submitPrompt(
    uint256 _promptId,
    address _user,
    bytes calldata, // _encryptedContent
    bytes calldata, // _userEncryptedKey
    bytes calldata // _roflEncryptedKey
  ) external override {
    _promptIdCounter++;
    emit PromptSubmitted(_promptId, _user);
  }

  // Implementation of the storeCancellation function for the mock.
  function storeCancellation(uint256 _promptId, address /*_user*/) external override {
    lastCancelledPromptId = _promptId;
    cancellationCallCount++;
  }

  // A helper for the test suite to simulate the agent calling back to finalize payment.
  function callFinalizePayment(address _escrow, uint256 _promptId) external {
    IEVMAIAgentEscrow(_escrow).finalizePayment(_promptId);
  }
}
