// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { Structs } from "../libraries/Structs.sol";

/**
 * @title IEVMAIAgent Interface
 * @dev Defines the external functions for the EVMAIAgent contract, ensuring interoperability
 *      with the escrow contract, the TEE oracle, and other system components.
 */
interface IEVMAIAgent {
  /**
   * @notice Returns the address of the currently authorized oracle.
   * @dev This is the single source of truth for the oracle's address in the system.
   * @return oracleAddress The address of the TEE oracle.
   */
  function oracle() external view returns (address);

  /**
   * @notice Atomically reserves a new conversation ID.
   * @return newConversationId The newly reserved conversation ID.
   */
  function reserveConversationId() external returns (uint256);

  /**
   * @notice Atomically reserves a new job ID.
   * @return newJobId The newly reserved job ID.
   */
  function reserveJobId() external returns (uint256);

  /**
   * @notice Atomically reserves a new message ID.
   * @return newMessageId The newly reserved message ID.
   */
  function reserveMessageId() external returns (uint256);

  /**
   * @notice Atomically reserves a new trigger ID for an agent job.
   * @return newTriggerId The newly reserved trigger ID.
   */
  function reserveTriggerId() external returns (uint256);

  /**
   * @notice Submits a new prompt after payment has been secured.
   * @param _user The address of the user who initiated the prompt.
   * @param _conversationId The ID of the conversation. If 0, a new conversation will be created.
   * @param _promptMessageId The unique, pre-reserved ID for this prompt message.
   * @param _answerMessageId The unique, pre-reserved ID for the future answer.
   * @param _encryptedPayload The encrypted prompt data for the TEE.
   * @param _roflEncryptedKey The session key, encrypted for the ROFL worker.
   */
  function submitPrompt(
    address _user,
    uint256 _conversationId,
    uint256 _promptMessageId,
    uint256 _answerMessageId,
    bytes calldata _encryptedPayload,
    bytes calldata _roflEncryptedKey
  ) external;

  /**
   * @notice Submits a request to regenerate a previous answer.
   * @param _user The address of the user requesting the regeneration.
   * @param _conversationId The ID of the conversation this regeneration belongs to.
   * @param _promptMessageId The ID of the user's prompt being regenerated.
   * @param _originalAnswerMessageId The ID of the AI answer to regenerate from.
   * @param _answerMessageId The unique, pre-reserved ID for the new answer.
   * @param _encryptedPayload The encrypted instructions for the TEE.
   * @param _roflEncryptedKey The session key, encrypted for the ROFL worker.
   */
  function submitRegenerationRequest(
    address _user,
    uint256 _conversationId,
    uint256 _promptMessageId,
    uint256 _originalAnswerMessageId,
    uint256 _answerMessageId,
    bytes calldata _encryptedPayload,
    bytes calldata _roflEncryptedKey
  ) external;

  /**
   * @notice Submits a new autonomous agent job.
   * @param _user The address of the user for whom the job is being run.
   * @param _jobId The ID of the parent job. If 0, a new job will be created.
   * @param _triggerId The unique identifier for this specific job trigger.
   * @param _encryptedPayload The encrypted job data for the TEE.
   * @param _roflEncryptedKey The session key, encrypted for the ROFL worker.
   */
  function submitAgentJob(
    address _user,
    uint256 _jobId,
    uint256 _triggerId,
    bytes calldata _encryptedPayload,
    bytes calldata _roflEncryptedKey
  ) external;

  /**
   * @notice Submits the final answer and all related Arweave CIDs for a prompt.
   * @dev This function is called by the TEE oracle.
   * @param _promptMessageId The ID of the user's prompt being answered.
   * @param _answerMessageId The pre-reserved ID that must be used for this answer message.
   * @param _cids A struct containing all the Arweave CIDs for the relevant files.
   */
  function submitAnswer(
    uint256 _promptMessageId,
    uint256 _answerMessageId,
    Structs.CidBundle calldata _cids
  ) external;

  /**
   * @notice Records a user's request to update a conversation's metadata.
   * @param _user The address of the user requesting the update.
   * @param _conversationId The ID of the conversation to update.
   * @param _encryptedPayload The encrypted update instructions for the TEE.
   * @param _roflEncryptedKey The session key, encrypted for the ROFL worker.
   */
  function submitMetadataUpdate(
    address _user,
    uint256 _conversationId,
    bytes calldata _encryptedPayload,
    bytes calldata _roflEncryptedKey
  ) external;

  /**
   * @notice Reveals the new metadata CID after the TEE has updated Arweave.
   * @dev This function is called by the TEE oracle.
   * @param _conversationId The ID of the conversation that was updated.
   * @param _newConversationMetadataCID The Arweave CID of the new metadata file.
   */
  function submitConversationMetadata(
    uint256 _conversationId,
    string calldata _newConversationMetadataCID
  ) external;

  /**
   * @notice Records a user's request to branch a conversation.
   * @param _user The address of the user who is branching the conversation.
   * @param _originalConversationId The ID of the conversation being branched from.
   * @param _branchPointMessageId The ID of the message where the branch occurs.
   * @param _newConversationId The pre-reserved ID for the new branched conversation.
   * @param _encryptedPayload The encrypted context from the client.
   * @param _roflEncryptedKey The session key, encrypted for the ROFL worker.
   */
  function submitBranchRequest(
    address _user,
    uint256 _originalConversationId,
    uint256 _branchPointMessageId,
    uint256 _newConversationId,
    bytes calldata _encryptedPayload,
    bytes calldata _roflEncryptedKey
  ) external;

  /**
   * @notice Submits the final CIDs for a newly branched conversation.
   * @dev This function is called by the TEE oracle.
   * @param _user The address of the user who initiated the branch.
   * @param _originalConversationId The ID of the conversation that was branched from.
   * @param _branchPointMessageId The ID of the message where the branch occurs.
   * @param _newConversationId The pre-reserved ID for the new conversation.
   * @param _conversationCID The Arweave CID for the new branched conversation's data.
   * @param _metadataCID The Arweave CID for the new branched conversation's metadata.
   */
  function submitBranch(
    address _user,
    uint256 _originalConversationId,
    uint256 _branchPointMessageId,
    uint256 _newConversationId,
    string calldata _conversationCID,
    string calldata _metadataCID
  ) external;

  /**
   * @notice Records that a prompt was cancelled by the user.
   * @param _user The address of the user who cancelled.
   * @param _answerMessageId The ID of the answer that was cancelled.
   */
  function recordCancellation(address _user, uint256 _answerMessageId) external;
}
