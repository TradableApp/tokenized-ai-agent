// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { IEVMAIAgent } from "../../contracts/interfaces/IEVMAIAgent.sol";

// A mock contract to simulate the EVMAIAgentEscrow for testing the agent.
contract MockEVMAIAgentEscrow {
  IEVMAIAgent public immutable EVM_AI_AGENT;

  uint256 public lastFinalizedEscrowId;
  uint256 public finalizePaymentCallCount;
  event PaymentFinalized(uint256 escrowId);

  error NotEVMAIAgent();

  constructor(address _agentAddress) {
    EVM_AI_AGENT = IEVMAIAgent(_agentAddress);
  }

  // --- Helper functions to simulate calls from the Escrow to the Agent ---

  function callReserveMessageId() external returns (uint256) {
    return EVM_AI_AGENT.reserveMessageId();
  }

  function callReserveTriggerId() external returns (uint256) {
    return EVM_AI_AGENT.reserveTriggerId();
  }

  function callSubmitPrompt(
    uint256 _promptMessageId,
    uint256 _answerMessageId,
    uint256 _conversationId,
    address _user,
    bytes calldata _encryptedPayload,
    bytes calldata _roflEncryptedKey
  ) external {
    EVM_AI_AGENT.submitPrompt(
      _promptMessageId,
      _answerMessageId,
      _conversationId,
      _user,
      _encryptedPayload,
      _roflEncryptedKey
    );
  }

  function callSubmitRegenerationRequest(
    address _user,
    uint256 _promptMessageId,
    uint256 _originalAnswerMessageId,
    uint256 _answerMessageId,
    bytes calldata _encryptedPayload,
    bytes calldata _roflEncryptedKey
  ) external {
    EVM_AI_AGENT.submitRegenerationRequest(
      _user,
      _promptMessageId,
      _originalAnswerMessageId,
      _answerMessageId,
      _encryptedPayload,
      _roflEncryptedKey
    );
  }

  function callSubmitAgentJob(
    uint256 _triggerId,
    uint256 _jobId,
    address _user,
    bytes calldata _encryptedPayload,
    bytes calldata _roflEncryptedKey
  ) external {
    EVM_AI_AGENT.submitAgentJob(_triggerId, _jobId, _user, _encryptedPayload, _roflEncryptedKey);
  }

  function callSubmitMetadataUpdate(
    uint256 _conversationId,
    address _user,
    bytes calldata _encryptedPayload,
    bytes calldata _roflEncryptedKey
  ) external {
    EVM_AI_AGENT.submitMetadataUpdate(_conversationId, _user, _encryptedPayload, _roflEncryptedKey);
  }

  function callSubmitBranchRequest(
    address _user,
    uint256 _originalConversationId,
    uint256 _branchPointMessageId
  ) external {
    EVM_AI_AGENT.submitBranchRequest(_user, _originalConversationId, _branchPointMessageId);
  }

  function callRecordCancellation(uint256 _answerMessageId, address _user) external {
    EVM_AI_AGENT.recordCancellation(_answerMessageId, _user);
  }

  // --- Implementation of the callback from the Agent ---

  function finalizePayment(uint256 _escrowId) external {
    if (msg.sender != address(EVM_AI_AGENT)) {
      revert NotEVMAIAgent();
    }
    lastFinalizedEscrowId = _escrowId;
    finalizePaymentCallCount++;
    emit PaymentFinalized(_escrowId);
  }
}
