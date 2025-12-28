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

  function callReserveConversationId() external returns (uint256) {
    return SAPPHIRE_AI_AGENT.reserveConversationId();
  }

  function callReserveJobId() external returns (uint256) {
    return SAPPHIRE_AI_AGENT.reserveJobId();
  }

  function callReserveMessageId() external returns (uint256) {
    return SAPPHIRE_AI_AGENT.reserveMessageId();
  }

  function callReserveTriggerId() external returns (uint256) {
    return SAPPHIRE_AI_AGENT.reserveTriggerId();
  }

  function callSubmitPrompt(
    address _user,
    uint256 _conversationId,
    uint256 _promptMessageId,
    uint256 _answerMessageId,
    string calldata _payload
  ) external {
    SAPPHIRE_AI_AGENT.submitPrompt(
      _user,
      _conversationId,
      _promptMessageId,
      _answerMessageId,
      _payload
    );
  }

  function callSubmitRegenerationRequest(
    address _user,
    uint256 _conversationId,
    uint256 _promptMessageId,
    uint256 _originalAnswerMessageId,
    uint256 _answerMessageId,
    string calldata _payload
  ) external {
    SAPPHIRE_AI_AGENT.submitRegenerationRequest(
      _user,
      _conversationId,
      _promptMessageId,
      _originalAnswerMessageId,
      _answerMessageId,
      _payload
    );
  }

  function callSubmitAgentJob(
    address _user,
    uint256 _jobId,
    uint256 _triggerId,
    string calldata _payload
  ) external {
    SAPPHIRE_AI_AGENT.submitAgentJob(_user, _jobId, _triggerId, _payload);
  }

  function callSubmitMetadataUpdate(
    address _user,
    uint256 _conversationId,
    string calldata _payload
  ) external {
    SAPPHIRE_AI_AGENT.submitMetadataUpdate(_user, _conversationId, _payload);
  }

  function callSubmitBranchRequest(
    address _user,
    uint256 _originalConversationId,
    uint256 _branchPointMessageId,
    uint256 _newConversationId,
    string calldata _payload
  ) external {
    SAPPHIRE_AI_AGENT.submitBranchRequest(
      _user,
      _originalConversationId,
      _branchPointMessageId,
      _newConversationId,
      _payload
    );
  }

  function callRecordCancellation(address _user, uint256 _answerMessageId) external {
    SAPPHIRE_AI_AGENT.recordCancellation(_user, _answerMessageId);
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
