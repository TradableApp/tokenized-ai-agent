// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { IEVMAIAgentEscrow } from "./interfaces/IEVMAIAgentEscrow.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title EVM AI Agent Contract
 * @dev This contract acts as an on-chain registry for a decentralized AI agent system.
 *      It manages ownership of conversations and messages, emitting events that allow
 *      off-chain indexers (like The Graph) to build a queryable history of interactions.
 *      Content is stored off-chain (e.g., on Arweave) and referenced by Content IDs (CIDs).
 *      It is upgradeable using the UUPS proxy pattern.
 */
contract EVMAIAgent is Initializable, OwnableUpgradeable, UUPSUpgradeable {
  // --- State Variables ---

  /// @notice The TEE-based oracle address authorized to submit answers.
  address public oracle;
  /// @notice The attested application ID of the ROFL TEE allowed to manage the oracle address.
  bytes21 public roflAppID;
  /// @notice The associated escrow contract that handles all payments.
  IEVMAIAgentEscrow public aiAgentEscrow;
  /// @notice The domain used for off-chain SIWE validation.
  string public domain;

  /// @notice A counter to ensure each conversation gets a unique ID.
  uint256 public conversationIdCounter;
  /// @notice A counter to ensure each message gets a unique ID.
  uint256 public messageIdCounter;
  /// @notice A counter to ensure each autonomous agent job gets a unique ID.
  uint256 public jobIdCounter;
  /// @notice A counter to ensure each job trigger gets a unique ID.
  uint256 public triggerIdCounter;

  /// @notice Maps a conversation ID to the owner's address for on-chain ownership verification.
  mapping(uint256 => address) public conversationToOwner;
  /// @notice Maps a job ID to the owner's address for on-chain ownership verification.
  mapping(uint256 => address) public jobToOwner;
  /// @notice Maps a message ID to its parent conversation ID for relational integrity checks.
  mapping(uint256 => uint256) public messageToConversation;
  /// @notice Maps a trigger ID to its parent job ID for relational integrity checks.
  mapping(uint256 => uint256) public triggerToJob;
  /// @notice Tracks whether an escrowed job (by its answer/trigger ID) has been completed or cancelled.
  mapping(uint256 => bool) public isJobFinalized;
  /// @notice Tracks whether a prompt message is currently pending a regeneration response.
  mapping(uint256 => bool) public isRegenerationPending;

  // --- Events ---

  // TEE Trigger Events
  /// @notice Emitted when a new user prompt is submitted. This is the primary trigger for the TEE.
  event PromptSubmitted(
    address indexed user,
    uint256 indexed promptMessageId,
    uint256 answerMessageId,
    uint256 conversationId,
    bytes encryptedPayload,
    bytes roflEncryptedKey
  );
  /// @notice Emitted when a new agent job is submitted. This is a trigger for the TEE.
  event AgentJobSubmitted(
    address indexed user,
    uint256 indexed triggerId,
    uint256 jobId,
    bytes encryptedPayload,
    bytes roflEncryptedKey
  );
  /// @notice Emitted when a user requests the TEE to regenerate an answer.
  event RegenerationRequested(
    address indexed user,
    uint256 indexed promptMessageId,
    uint256 originalAnswerMessageId,
    uint256 answerMessageId,
    bytes encryptedPayload,
    bytes roflEncryptedKey
  );
  /// @notice Emitted when a user requests the TEE to branch a conversation.
  event BranchRequested(
    address indexed user,
    uint256 indexed originalConversationId,
    uint256 branchPointMessageId
  );
  /// @notice Emitted when a user successfully cancels a pending prompt. This instructs the TEE to halt processing.
  event PromptCancelled(address indexed user, uint256 indexed answerMessageId);
  /// @notice Emitted when a user requests a metadata update. This instructs the TEE to update Arweave.
  event MetadataUpdateRequested(
    address indexed user,
    uint256 indexed conversationId,
    bytes encryptedPayload,
    bytes roflEncryptedKey
  );

  // Graph Historical Record Events
  /// @notice Emitted when a new conversation is started.
  event ConversationAdded(
    address indexed user,
    uint256 indexed conversationId,
    string conversationCID,
    string metadataCID
  );
  /// @notice Emitted when a new conversation is forked from an existing one.
  event ConversationBranched(
    address indexed user,
    uint256 indexed conversationId,
    uint256 originalConversationId,
    uint256 branchPointMessageId,
    string conversationCID,
    string metadataCID
  );
  /// @notice Emitted when a user adds a new prompt to a conversation.
  event PromptMessageAdded(
    uint256 indexed conversationId,
    uint256 indexed messageId,
    string messageCID
  );
  /// @notice Emitted when the oracle submits an answer to a prompt.
  event AnswerMessageAdded(
    uint256 indexed conversationId,
    uint256 indexed messageId,
    string messageCID
  );
  /// @notice Emitted with a prompt to provide keywords for off-chain search indexing.
  event SearchIndexDeltaAdded(uint256 indexed messageId, string searchDeltaCID);
  /// @notice Emitted when a conversation's metadata CID is updated by the TEE.
  event ConversationMetadataUpdated(
    uint256 indexed conversationId,
    string newConversationMetadataCID
  );

  // Admin Events
  /// @notice Emitted when the linked escrow contract address is updated.
  event AgentEscrowUpdated(address indexed newAIAgentEscrow);
  /// @notice Emitted when the oracle address is updated by a TEE.
  event OracleUpdated(address indexed newOracle);

  // --- Errors ---

  /// @notice Reverts if an address parameter is the zero address.
  error ZeroAddress();
  /// @notice Reverts if an attempt is made to set the escrow address more than once.
  error AgentEscrowAlreadySet();
  /// @notice Reverts if a function is called by an unauthorized user.
  error Unauthorized();
  /// @notice Reverts if a function is called by an address that is not the authorized oracle.
  error UnauthorizedOracle();
  /// @notice Reverts if a function is called by an address other than the linked escrow contract.
  error NotAIAgentEscrow();
  /// @notice Reverts if the oracle attempts to answer a prompt for the wrong user.
  error InvalidPromptMessageId();
  /// @notice Reverts if an answer or cancellation is submitted for an already-answered job.
  error JobAlreadyFinalized();
  /// @notice Reverts if a regeneration is requested for a prompt that already has one pending.
  error RegenerationAlreadyPending();

  // --- Initialization ---

  /**
   * @notice Sets up the AI Agent smart contract.
   * @param _domain The domain used for off-chain SIWE validation.
   * @param _roflAppID The attested ROFL app that is allowed to call setOracle().
   * @param _oracle The initial TEE oracle address for accessing prompts.
   * @param _initialOwner The address that will have ownership of this contract.
   */
  function initialize(
    string memory _domain,
    bytes21 _roflAppID,
    address _oracle,
    address _initialOwner
  ) public initializer {
    if (_oracle == address(0) || _initialOwner == address(0)) {
      revert ZeroAddress();
    }
    __Ownable_init(_initialOwner);
    __UUPSUpgradeable_init();
    domain = _domain;
    roflAppID = _roflAppID;
    oracle = _oracle;
  }

  // --- Modifiers ---

  /**
   * @notice Checks whether the transaction was signed by the oracle's private key.
   */
  modifier onlyOracle() {
    if (msg.sender != oracle) {
      revert UnauthorizedOracle();
    }
    _;
  }

  /**
   * @notice Checks that the caller is the registered EVMAIAgentEscrow contract.
   */
  modifier onlyAIAgentEscrow() {
    if (msg.sender != address(aiAgentEscrow)) {
      revert NotAIAgentEscrow();
    }
    _;
  }

  /**
   * @notice Checks whether the transaction was signed by the ROFL's app key inside a TEE.
   * @dev Placeholder: This check requires a Sapphire precompile and cannot be performed on-chain here.
   * @param _appId The application ID of the ROFL instance.
   */
  modifier onlyTEE(bytes21 _appId) {
    // TODO: A robust mechanism for TEE attestation on a standard EVM chain requires
    // further research (e.g., via light client or message bridge to Sapphire).
    _;
  }

  // --- Administrative Functions ---

  /**
   * @notice Sets the address of the AgentEscrow contract.
   * @dev This can only be called once by the owner to complete the deployment linking.
   * @param _newAIAgentEscrow The address of the deployed EVMAIAgentEscrow contract.
   */
  function setAgentEscrow(address _newAIAgentEscrow) external onlyOwner {
    if (_newAIAgentEscrow == address(0)) {
      revert ZeroAddress();
    }
    if (address(aiAgentEscrow) != address(0)) {
      revert AgentEscrowAlreadySet();
    }
    aiAgentEscrow = IEVMAIAgentEscrow(_newAIAgentEscrow);
    emit AgentEscrowUpdated(_newAIAgentEscrow);
  }

  /**
   * @notice Sets the oracle address that will be allowed to read prompts and submit answers.
   * @dev This setter can only be called from within an authorized ROFL TEE.
   * @param _newOracle The new address for the oracle.
   */
  function setOracle(address _newOracle) external onlyTEE(roflAppID) {
    if (_newOracle == address(0)) {
      revert ZeroAddress();
    }
    oracle = _newOracle;
    emit OracleUpdated(_newOracle);
  }

  // --- Core Functions ---

  /**
   * @notice Atomically reserves a new message ID for an upcoming action.
   * @dev This can only be called by the trusted escrow contract to prevent ID griefing.
   *      It ensures that every ID retrieved is unique and the counter is immediately updated.
   * @return The newly reserved message ID.
   */
  function reserveMessageId() external onlyAIAgentEscrow returns (uint256) {
    uint256 newMessageId = messageIdCounter;
    messageIdCounter++;
    return newMessageId;
  }

  /**
   * @notice Atomically reserves a new trigger ID for an upcoming agent job.
   * @dev This can only be called by the trusted escrow contract.
   * @return The newly reserved trigger ID.
   */
  function reserveNewTriggerId() external onlyAIAgentEscrow returns (uint256) {
    uint256 newTriggerId = triggerIdCounter;
    triggerIdCounter++;
    return newTriggerId;
  }

  /**
   * @notice Records a new user prompt after IDs have been reserved and payment secured.
   * @dev This function can only be called by the linked `EVMAIAgentEscrow` contract.
   * @param _promptMessageId The unique, pre-reserved ID for this prompt message.
   * @param _answerMessageId The unique, pre-reserved ID for the future answer.
   * @param _conversationId The ID of the conversation. If 0, a new conversation will be created.
   * @param _user The address of the user who initiated the prompt.
   * @param _encryptedPayload The encrypted prompt data for the TEE.
   * @param _roflEncryptedKey The session key, encrypted for the ROFL worker.
   * @return conversationId The ID of the relevant conversation (either existing or newly created).
   */
  function submitPrompt(
    uint256 _promptMessageId,
    uint256 _answerMessageId,
    uint256 _conversationId,
    address _user,
    bytes calldata _encryptedPayload,
    bytes calldata _roflEncryptedKey
  ) external onlyAIAgentEscrow returns (uint256 conversationId) {
    conversationId = _conversationId;

    if (conversationId == 0) {
      conversationId = conversationIdCounter++;
      conversationToOwner[conversationId] = _user;
    } else {
      if (conversationToOwner[conversationId] != _user) {
        revert Unauthorized();
      }
    }

    messageToConversation[_promptMessageId] = conversationId;
    emit PromptSubmitted(
      _user,
      _promptMessageId,
      _answerMessageId,
      conversationId,
      _encryptedPayload,
      _roflEncryptedKey
    );
  }

  /**
   * @notice Records a user's request to regenerate an answer after payment is secured.
   * @dev This function can only be called by the linked `EVMAIAgentEscrow` contract. It places a
   *      lock on the original prompt to prevent multiple simultaneous regenerations.
   * @param _user The address of the user requesting the regeneration.
   * @param _promptMessageId The ID of the user's prompt being regenerated.
   * @param _originalAnswerMessageId The ID of the AI answer to regenerate from.
   * @param _answerMessageId The unique, pre-reserved ID for the future answer.
   * @param _encryptedPayload The encrypted instructions for the TEE.
   * @param _roflEncryptedKey The session key, encrypted for the ROFL worker.
   */
  function submitRegenerationRequest(
    address _user,
    uint256 _promptMessageId,
    uint256 _originalAnswerMessageId,
    uint256 _answerMessageId,
    bytes calldata _encryptedPayload,
    bytes calldata _roflEncryptedKey
  ) external onlyAIAgentEscrow {
    if (isRegenerationPending[_promptMessageId]) {
      revert RegenerationAlreadyPending();
    }

    isRegenerationPending[_promptMessageId] = true;

    emit RegenerationRequested(
      _user,
      _promptMessageId,
      _originalAnswerMessageId,
      _answerMessageId,
      _encryptedPayload,
      _roflEncryptedKey
    );
  }

  /**
   * @notice Records a new autonomous agent job after payment has been secured by the escrow contract.
   * @dev This function can only be called by the linked `EVMAIAgentEscrow` contract.
   * @param _triggerId The unique identifier for this specific job trigger.
   * @param _jobId The ID of the parent job. If 0, a new job will be created.
   * @param _user The address of the user for whom the job is being run.
   * @param _encryptedPayload The encrypted job data for the TEE.
   * @param _roflEncryptedKey The session key, encrypted for the ROFL worker.
   * @return jobId The ID of the relevant job (either existing or newly created).
   */
  function submitAgentJob(
    uint256 _triggerId,
    uint256 _jobId,
    address _user,
    bytes calldata _encryptedPayload,
    bytes calldata _roflEncryptedKey
  ) external onlyAIAgentEscrow returns (uint256 jobId) {
    jobId = _jobId;

    if (jobId == 0) {
      jobId = jobIdCounter++;
      jobToOwner[jobId] = _user;
    } else {
      if (jobToOwner[jobId] != _user) {
        revert Unauthorized();
      }
    }

    triggerToJob[_triggerId] = jobId;
    emit AgentJobSubmitted(_user, _triggerId, jobId, _encryptedPayload, _roflEncryptedKey);
  }

  /**
   * @notice Submits the final answer and all related Arweave CIDs for a prompt.
   * @dev Called by the oracle from within its TEE. The answer ID was pre-reserved.
   * @param _promptMessageId The ID of the user's prompt being answered.
   * @param _answerMessageId The pre-reserved ID that must be used for this answer message.
   * @param _conversationCID The Arweave CID for the conversation file (only for the first message).
   * @param _metadataCID The Arweave CID for the conversation metadata file (only for the first message).
   * @param _promptMessageCID The Arweave CID for the user's prompt message file.
   * @param _answerMessageCID The Arweave CID for the AI's answer message file.
   * @param _searchDeltaCID The Arweave CID for the prompt's search index keywords.
   */
  function submitAnswer(
    uint256 _promptMessageId,
    uint256 _answerMessageId,
    string calldata _conversationCID,
    string calldata _metadataCID,
    string calldata _promptMessageCID,
    string calldata _answerMessageCID,
    string calldata _searchDeltaCID
  ) external onlyOracle {
    if (isJobFinalized[_answerMessageId]) {
      revert JobAlreadyFinalized();
    }

    uint256 conversationId = messageToConversation[_promptMessageId];

    if (conversationToOwner[conversationId] == address(0)) {
      revert InvalidPromptMessageId();
    }

    isJobFinalized[_answerMessageId] = true;
    address user = conversationToOwner[conversationId];

    if (bytes(_conversationCID).length > 0) {
      emit ConversationAdded(user, conversationId, _conversationCID, _metadataCID);
    }
    if (bytes(_promptMessageCID).length > 0) {
      emit PromptMessageAdded(conversationId, _promptMessageId, _promptMessageCID);
      emit SearchIndexDeltaAdded(_promptMessageId, _searchDeltaCID);
    }

    messageToConversation[_answerMessageId] = conversationId;
    emit AnswerMessageAdded(conversationId, _answerMessageId, _answerMessageCID);
    aiAgentEscrow.finalizePayment(_answerMessageId);
  }

  /**
   * @notice Records a user's request to update a conversation's metadata.
   * @dev This function can only be called by the linked `EVMAIAgentEscrow` contract after charging a fee.
   * @param _conversationId The ID of the conversation to update.
   * @param _user The address of the user requesting the update.
   * @param _encryptedPayload The encrypted ABI-encoded update instructions (e.g., new title).
   * @param _roflEncryptedKey The session key, encrypted for the ROFL worker.
   */
  function submitMetadataUpdate(
    uint256 _conversationId,
    address _user,
    bytes calldata _encryptedPayload,
    bytes calldata _roflEncryptedKey
  ) external onlyAIAgentEscrow {
    if (conversationToOwner[_conversationId] != _user) {
      revert Unauthorized();
    }

    emit MetadataUpdateRequested(_user, _conversationId, _encryptedPayload, _roflEncryptedKey);
  }

  /**
   * @notice Reveals the new metadata CID after the TEE has updated Arweave.
   * @dev This function can only be called by the authorized oracle.
   * @param _conversationId The ID of the conversation that was updated.
   * @param _newConversationMetadataCID The Arweave CID of the new metadata file.
   */
  function submitConversationMetadata(
    uint256 _conversationId,
    string calldata _newConversationMetadataCID
  ) external onlyOracle {
    emit ConversationMetadataUpdated(_conversationId, _newConversationMetadataCID);
  }

  /**
   * @notice Records a user's request to branch a conversation after the fee is paid.
   * @dev This function can only be called by the linked `EVMAIAgentEscrow` contract.
   * @param _user The address of the user who is branching the conversation.
   * @param _originalConversationId The ID of the conversation being branched from.
   * @param _branchPointMessageId The ID of the message where the branch occurs.
   */
  function submitBranchRequest(
    address _user,
    uint256 _originalConversationId,
    uint256 _branchPointMessageId
  ) external onlyAIAgentEscrow {
    if (conversationToOwner[_originalConversationId] != _user) {
      revert Unauthorized();
    }

    emit BranchRequested(_user, _originalConversationId, _branchPointMessageId);
  }

  /**
   * @notice Submits the final CIDs for a newly branched conversation.
   * @dev Called by the oracle after processing a `BranchRequested` event and uploading files to Arweave.
   *      This function emits the `ConversationBranched` event that The Graph ingests.
   * @param _user The address of the user who initiated the branch.
   * @param _originalConversationId The ID of the conversation that was branched from.
   * @param _branchPointMessageId The ID of the message where the branch occurred.
   * @param _conversationCID The Arweave CID for the new branched conversation's data.
   * @param _metadataCID The Arweave CID for the new branched conversation's metadata.
   * @return conversationId The ID of the newly created conversation.
   */
  function submitBranch(
    address _user,
    uint256 _originalConversationId,
    uint256 _branchPointMessageId,
    string calldata _conversationCID,
    string calldata _metadataCID
  ) external onlyOracle returns (uint256 conversationId) {
    if (conversationToOwner[_originalConversationId] != _user) {
      revert Unauthorized();
    }

    conversationId = conversationIdCounter++;
    conversationToOwner[conversationId] = _user;

    emit ConversationBranched(
      _user,
      conversationId,
      _originalConversationId,
      _branchPointMessageId,
      _conversationCID,
      _metadataCID
    );
  }

  /**
   * @notice Records that a prompt was cancelled by the user.
   * @dev This function can only be called by the linked `EVMAIAgentEscrow` contract.
   *      It sets the answered flag to prevent the oracle from submitting a late answer.
   * @param _answerMessageId The ID of the answer that was cancelled.
   * @param _user The address of the user who cancelled.
   */
  function recordCancellation(uint256 _answerMessageId, address _user) external onlyAIAgentEscrow {
    if (isJobFinalized[_answerMessageId]) {
      revert JobAlreadyFinalized();
    }

    isJobFinalized[_answerMessageId] = true;
    emit PromptCancelled(_user, _answerMessageId);
  }

  // --- Upgradability ---

  /**
   * @dev Authorizes an upgrade to a new implementation contract.
   *      This internal function is part of the UUPS upgrade mechanism and is restricted to the owner.
   * @param _newImplementation The address of the new implementation contract.
   */
  function _authorizeUpgrade(address _newImplementation) internal override onlyOwner {
    // solhint-disable-previous-line no-empty-blocks
    // Intentionally left blank. The onlyOwner modifier provides the necessary access control.
  }

  uint256[34] private __gap;
}
