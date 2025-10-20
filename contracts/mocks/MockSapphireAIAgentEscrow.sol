// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { ISapphireAIAgent } from "../../contracts/interfaces/ISapphireAIAgent.sol";

// A mock contract to simulate the SapphireAIAgentEscrow for testing the agent.
contract MockSapphireAIAgentEscrow {
  ISapphireAIAgent public immutable SAPPHIRE_AI_AGENT;

  uint256 public lastFinalizedEscrowId;
  uint256 public finalizePaymentCallCount;
  event PaymentFinalized(uint256 escrowId);

  error NotSapphireAIAgent();

  constructor(address _agentAddress) {
    SAPPHIRE_AI_AGENT = ISapphireAIAgent(_agentAddress);
  }

  // --- Helper functions to simulate calls from the Escrow to the Agent ---

  function callReserveMessageId() external returns (uint256) {
    return SAPPHIRE_AI_AGENT.reserveMessageId();
  }

  function callReserveTriggerId() external returns (uint256) {
    return SAPPHIRE_AI_AGENT.reserveTriggerId();
  }

  function callSubmitPrompt(
    uint256 _promptMessageId,
    uint256 _answerMessageId,
    uint256 _conversationId,
    address _user,
    string calldata _payload
  ) external {
    SAPPHIRE_AI_AGENT.submitPrompt(
      _promptMessageId,
      _answerMessageId,
      _conversationId,
      _user,
      _payload
    );
  }

  function callSubmitRegenerationRequest(
    address _user,
    uint256 _promptMessageId,
    uint256 _originalAnswerMessageId,
    uint256 _answerMessageId,
    string calldata _payload
  ) external {
    SAPPHIRE_AI_AGENT.submitRegenerationRequest(
      _user,
      _promptMessageId,
      _originalAnswerMessageId,
      _answerMessageId,
      _payload
    );
  }

  function callSubmitAgentJob(
    uint256 _triggerId,
    uint256 _jobId,
    address _user,
    string calldata _payload
  ) external {
    SAPPHIRE_AI_AGENT.submitAgentJob(_triggerId, _jobId, _user, _payload);
  }

  function callSubmitMetadataUpdate(
    uint256 _conversationId,
    address _user,
    string calldata _payload
  ) external {
    SAPPHIRE_AI_AGENT.submitMetadataUpdate(_conversationId, _user, _payload);
  }

  function callSubmitBranchRequest(
    address _user,
    uint256 _originalConversationId,
    uint256 _branchPointMessageId
  ) external {
    SAPPHIRE_AI_AGENT.submitBranchRequest(_user, _originalConversationId, _branchPointMessageId);
  }

  function callRecordCancellation(uint256 _answerMessageId, address _user) external {
    SAPPHIRE_AI_AGENT.recordCancellation(_answerMessageId, _user);
  }

  // --- Implementation of the callback from the Agent ---

  function finalizePayment(uint256 _escrowId) external {
    if (msg.sender != address(SAPPHIRE_AI_AGENT)) {
      revert NotSapphireAIAgent();
    }
    lastFinalizedEscrowId = _escrowId;
    finalizePaymentCallCount++;
    emit PaymentFinalized(_escrowId);
  }
}
