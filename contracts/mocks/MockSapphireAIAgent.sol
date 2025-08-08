// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { ISapphireAIAgent } from "../../contracts/interfaces/ISapphireAIAgent.sol";
import { ISapphireAIAgentEscrow } from "../../contracts/interfaces/ISapphireAIAgentEscrow.sol";

// A mock contract to simulate the SapphireAIAgent for testing the escrow.
contract MockSapphireAIAgent is ISapphireAIAgent {
  uint256 private _promptIdCounter; // Make it private to force use of the getter
  event PromptSubmitted(uint256 promptId, address user);

  // This view function is essential for the escrow contract.
  function promptIdCounter() external view override returns (uint256) {
    return _promptIdCounter;
  }

  // This function is called by the escrow. It increments the counter.
  function submitPrompt(
    uint256 _promptId,
    address _user,
    string calldata // _prompt
  ) external override {
    _promptIdCounter++;
    emit PromptSubmitted(_promptId, _user);
  }

  // A helper for the test suite to simulate the agent calling back to finalize payment.
  function callFinalizePayment(address _escrow, uint256 _promptId) external {
    ISapphireAIAgentEscrow(_escrow).finalizePayment(_promptId);
  }
}
