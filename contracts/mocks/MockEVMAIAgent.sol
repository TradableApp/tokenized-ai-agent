// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { IEVMAIAgentEscrow } from "../../contracts/interfaces/IEVMAIAgentEscrow.sol";
import { IEVMAIAgent } from "../../contracts/interfaces/IEVMAIAgent.sol";
import { Structs } from "../libraries/Structs.sol";

contract MockEVMAIAgent is IEVMAIAgent {
  uint256 private _messageIdCounter;
  uint256 private _triggerIdCounter;

  // State variables to record the last call for testing
  uint256 public lastPromptMessageId;
  uint256 public lastAnswerMessageId;
  uint256 public lastConversationId;
  address public lastUser;
  uint256 public lastOriginalAnswerMessageId;
  uint256 public lastTriggerId;
  uint256 public lastJobId;
  uint256 public lastOriginalConversationId;
  uint256 public lastBranchPointMessageId;

  event PromptSubmitted(uint256 promptMessageId, uint256 answerMessageId, address user);
  event RegenerationSubmitted(uint256 promptMessageId, uint256 answerMessageId, address user);
  event AgentJobSubmitted(uint256 triggerId, uint256 jobId, address user);
  event MetadataUpdateSubmitted(uint256 conversationId, address user);
  event BranchRequestSubmitted(uint256 originalConversationId, uint256 branchPointMessageId);
  event CancellationRecorded(uint256 answerMessageId, address user);
  event AnswerSubmitted(uint256 promptMessageId, uint256 answerMessageId);

  function reserveMessageId() external override returns (uint256) {
    uint256 id = _messageIdCounter;
    _messageIdCounter++;
    return id;
  }

  function reserveTriggerId() external override returns (uint256) {
    uint256 id = _triggerIdCounter;
    _triggerIdCounter++;
    return id;
  }

  function submitPrompt(
    uint256 _promptMessageId,
    uint256 _answerMessageId,
    uint256 _conversationId,
    address _user,
    bytes calldata, // _encryptedPayload
    bytes calldata // _roflEncryptedKey
  ) external override {
    lastPromptMessageId = _promptMessageId;
    lastAnswerMessageId = _answerMessageId;
    lastConversationId = _conversationId;
    lastUser = _user;
    emit PromptSubmitted(_promptMessageId, _answerMessageId, _user);
  }

  function submitAnswer(
    uint256 _promptMessageId,
    uint256 _answerMessageId,
    Structs.CidBundle calldata /* _cids */
  ) external override {
    lastPromptMessageId = _promptMessageId;
    lastAnswerMessageId = _answerMessageId;
    emit AnswerSubmitted(_promptMessageId, _answerMessageId);
  }

  function submitRegenerationRequest(
    address _user,
    uint256 _promptMessageId,
    uint256 _originalAnswerMessageId,
    uint256 _answerMessageId,
    bytes calldata, // _encryptedPayload
    bytes calldata // _roflEncryptedKey
  ) external override {
    lastUser = _user;
    lastPromptMessageId = _promptMessageId;
    lastOriginalAnswerMessageId = _originalAnswerMessageId;
    lastAnswerMessageId = _answerMessageId;
    emit RegenerationSubmitted(_promptMessageId, _answerMessageId, _user);
  }

  function submitAgentJob(
    uint256 _triggerId,
    uint256 _jobId,
    address _user,
    bytes calldata, // _encryptedPayload
    bytes calldata // _roflEncryptedKey
  ) external override {
    lastTriggerId = _triggerId;
    lastJobId = _jobId;
    lastUser = _user;
    emit AgentJobSubmitted(_triggerId, _jobId, _user);
  }

  function submitMetadataUpdate(
    uint256 _conversationId,
    address _user,
    bytes calldata, // _encryptedPayload
    bytes calldata // _roflEncryptedKey
  ) external override {
    lastConversationId = _conversationId;
    lastUser = _user;
    emit MetadataUpdateSubmitted(_conversationId, _user);
  }

  function submitBranchRequest(
    address _user,
    uint256 _originalConversationId,
    uint256 _branchPointMessageId
  ) external override {
    lastUser = _user;
    lastOriginalConversationId = _originalConversationId;
    lastBranchPointMessageId = _branchPointMessageId;
    emit BranchRequestSubmitted(_originalConversationId, _branchPointMessageId);
  }

  function recordCancellation(uint256 _answerMessageId, address _user) external override {
    lastAnswerMessageId = _answerMessageId;
    lastUser = _user;
    emit CancellationRecorded(_answerMessageId, _user);
  }

  // A helper for the test suite to simulate the agent calling back to finalize payment.
  function callFinalizePayment(address _escrow, uint256 _escrowId) external {
    IEVMAIAgentEscrow(_escrow).finalizePayment(_escrowId);
  }
}
