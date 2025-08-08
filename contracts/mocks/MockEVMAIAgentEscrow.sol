// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { IEVMAIAgent } from "../../contracts/interfaces/IEVMAIAgent.sol";

// A mock contract to simulate the EVMAIAgentEscrow for testing the agent.
contract MockEVMAIAgentEscrow {
  IEVMAIAgent public immutable EVM_AI_AGENT;

  // State variables to record calls for test assertions.
  uint256 public lastFinalizedPromptId;
  uint256 public finalizePaymentCallCount;
  event PaymentFinalized(uint256 promptId);

  // Simplified constructor for mock purposes.
  constructor(address _agentAddress) {
    EVM_AI_AGENT = IEVMAIAgent(_agentAddress);
  }

  // This function simulates the real escrow calling the agent.
  function callSubmitPrompt(
    uint256 _promptId,
    address _user,
    bytes calldata _encryptedContent,
    bytes calldata _userEncryptedKey,
    bytes calldata _roflEncryptedKey
  ) external {
    EVM_AI_AGENT.submitPrompt(
      _promptId,
      _user,
      _encryptedContent,
      _userEncryptedKey,
      _roflEncryptedKey
    );
  }

  // This function now records the call so we can make assertions in our tests.
  function finalizePayment(uint256 _promptId) external {
    lastFinalizedPromptId = _promptId;
    finalizePaymentCallCount++;
    emit PaymentFinalized(_promptId);
  }
}
