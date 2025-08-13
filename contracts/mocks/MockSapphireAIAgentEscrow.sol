// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { ISapphireAIAgent } from "../../contracts/interfaces/ISapphireAIAgent.sol";

// A mock contract to simulate the SapphireAIAgentEscrow for testing.
contract MockSapphireAIAgentEscrow {
  ISapphireAIAgent public immutable AI_AGENT;

  uint256 public lastFinalizedPromptId;
  uint256 public finalizePaymentCallCount;
  event PaymentFinalized(uint256 promptId);

  constructor(address _agentAddress) {
    AI_AGENT = ISapphireAIAgent(_agentAddress);
  }

  // A helper function for our tests to simulate the escrow calling the agent.
  function callSubmitPrompt(uint256 _promptId, address _user, string calldata _prompt) external {
    AI_AGENT.submitPrompt(_promptId, _user, _prompt);
  }

  function callStoreCancellation(uint256 _promptId, address _user) external {
    AI_AGENT.storeCancellation(_promptId, _user);
  }

  // This function now records the call for better testing.
  function finalizePayment(uint256 _promptId) external {
    lastFinalizedPromptId = _promptId;
    finalizePaymentCallCount++;
    emit PaymentFinalized(_promptId);
  }
}
