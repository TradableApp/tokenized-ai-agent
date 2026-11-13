// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { IEVMAIAgentEscrow } from "./interfaces/IEVMAIAgentEscrow.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Structs } from "./libraries/Structs.sol";

/**
 * @title EVM AI Agent Contract
 * @author Tradable
 * @notice This contract is an on-chain registry for a decentralized AI agent, managing conversation
 *         and message ownership. It emits events for off-chain indexers to track interaction history.
 *         Content is stored off-chain and referenced by Content IDs (CIDs).
 * @dev It is upgradeable using the UUPS proxy pattern.
 */
contract EVMAIAgent is
  Initializable,
  OwnableUpgradeable,
  AccessControlUpgradeable,
  UUPSUpgradeable
{
  // --- Constants ---

  /// @notice The role an address must hold to submit answers. Several addresses can hold it.
  bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

  // --- State Variables ---

  /// @dev The single oracle address of the version before roles. It authorizes nothing now; it
  ///      is kept because its slot cannot move, and `migrateOracleRole` reads it once.
  /// @custom:oz-renamed-from oracle
  address internal _legacyOracle;
  /// @notice The associated escrow contract that handles all payments.
  IEVMAIAgentEscrow public aiAgentEscrow;
  /// @notice The domain used for off-chain SIWE validation.
  string public domain;

  /// @notice A counter to ensure each conversation gets a unique ID.
  uint256 public conversationIdCounter;
  /// @notice A counter to ensure each message and each agent-job trigger gets a unique ID.
  uint256 public messageIdCounter;
  /// @notice A counter to ensure each autonomous agent job gets a unique ID.
  uint256 public jobIdCounter;
  /// @notice Unused. Trigger IDs are drawn from `messageIdCounter`; the slot is kept so the
  ///         storage layout of deployed proxies is unchanged.
  /// @dev The getter is frozen at whatever it held when a proxy was upgraded (zero on a fresh
  ///      deployment). Do not read it to count or predict trigger IDs; read `messageIdCounter`.
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
  /// @notice For a pending regeneration, the prompt it locked, stored as `promptMessageId + 1`
  ///         so that zero means "this answer is not a pending regeneration".
  mapping(uint256 => uint256) private _regenerationLockOf;
  /// @notice How many requests for the oracle this contract has recorded: prompts, regenerations,
  ///         agent jobs, metadata updates and branches. Request numbers start at 1.
  /// @dev A request number is a position in this log, not an identity: it carries no link to a
  ///      particular event. Agent jobs are counted although nothing consumes them yet.
  ///      Several request numbers can share one block. A reader must handle every request event
  ///      in a recorded block before treating the numbers that point at it as handled, and need
  ///      query a block only once however many numbers point at it.
  uint256 public requestCount;
  /// @notice The block in which request `n` was recorded, so its event can be found by querying
  ///         that block alone. Zero for a number that has not been issued.
  mapping(uint256 => uint256) public requestBlock;

  /// @notice The public key clients encrypt a prompt's session key to, shared by all oracles.
  bytes public oracleEncryptionKey;

  // New state variables go directly above this line, never between existing ones: the proxy's
  // storage follows declaration order, and `__gap` at the end of the contract shrinks by the
  // slots each addition takes. `test/StorageLayout.test.js` pins the order.

  // --- Events ---

  // TEE Trigger Events
  /**
   * @notice Emitted when a new user prompt is submitted. This is the primary trigger for the TEE.
   * @param user The address of the user initiating the prompt.
   * @param conversationId The ID of the conversation this prompt belongs to.
   * @param promptMessageId The unique ID for the user's prompt message.
   * @param answerMessageId The pre-reserved unique ID for the AI's future answer.
   * @param encryptedPayload The encrypted data for the TEE.
   * @param roflEncryptedKey The session key, encrypted for the ROFL worker.
   */
  event PromptSubmitted(
    address indexed user,
    uint256 indexed conversationId,
    uint256 indexed promptMessageId,
    uint256 answerMessageId,
    bytes encryptedPayload,
    bytes roflEncryptedKey
  );

  /**
   * @notice Emitted when a new agent job is submitted. This is a trigger for the TEE.
   * @param user The address of the user for whom the job is running.
   * @param jobId The ID of the parent job.
   * @param triggerId The unique ID for this specific job trigger.
   * @param encryptedPayload The encrypted job data for the TEE.
   * @param roflEncryptedKey The session key, encrypted for the ROFL worker.
   */
  event AgentJobSubmitted(
    address indexed user,
    uint256 indexed jobId,
    uint256 indexed triggerId,
    bytes encryptedPayload,
    bytes roflEncryptedKey
  );

  /**
   * @notice Emitted when a user requests the TEE to regenerate an answer.
   * @param user The address of the user requesting the regeneration.
   * @param conversationId The ID of the conversation.
   * @param promptMessageId The ID of the user's original prompt.
   * @param originalAnswerMessageId The ID of the AI answer to regenerate.
   * @param answerMessageId The pre-reserved ID for the new answer.
   * @param encryptedPayload The encrypted instructions for the TEE.
   * @param roflEncryptedKey The session key, encrypted for the ROFL worker.
   */
  event RegenerationRequested(
    address indexed user,
    uint256 indexed conversationId,
    uint256 indexed promptMessageId,
    uint256 originalAnswerMessageId,
    uint256 answerMessageId,
    bytes encryptedPayload,
    bytes roflEncryptedKey
  );

  /**
   * @notice Emitted when a user requests the TEE to branch a conversation.
   * @param user The address of the user initiating the branch.
   * @param originalConversationId The ID of the conversation being branched from.
   * @param branchPointMessageId The ID of the message where the branch occurs.
   * @param newConversationId The pre-reserved ID for the new branched conversation.
   * @param encryptedPayload The encrypted context for the TEE.
   * @param roflEncryptedKey The session key, encrypted for the ROFL worker.
   */
  event BranchRequested( // solhint-disable-line gas-indexed-events
    address indexed user,
    uint256 indexed originalConversationId,
    uint256 branchPointMessageId,
    uint256 newConversationId,
    bytes encryptedPayload,
    bytes roflEncryptedKey
  );

  /**
   * @notice Emitted when a user successfully cancels a pending prompt. This instructs the TEE to halt processing.
   * @param user The address of the user who cancelled.
   * @param answerMessageId The ID of the answer that was cancelled.
   */
  event PromptCancelled(address indexed user, uint256 indexed answerMessageId);

  /**
   * @notice Emitted when a prompt's escrow is refunded after the refund timeout.
   * @dev Distinct from `PromptCancelled` so an indexer never mistakes a timeout refund for a user
   *      cancellation, which carries a fee.
   * @param user The address of the user whose escrow was refunded.
   * @param answerMessageId The ID of the answer that will no longer be produced.
   */
  event PromptRefunded(address indexed user, uint256 indexed answerMessageId);

  /**
   * @notice Emitted when a user requests a metadata update. This instructs the TEE to update decentralised storage.
   * @param user The address of the user requesting the update.
   * @param conversationId The ID of the conversation being updated.
   * @param encryptedPayload The encrypted update instructions.
   * @param roflEncryptedKey The session key, encrypted for the ROFL worker.
   */
  event MetadataUpdateRequested(
    address indexed user,
    uint256 indexed conversationId,
    bytes encryptedPayload,
    bytes roflEncryptedKey
  );

  // Graph Historical Record Events
  /**
   * @notice Emitted when a new conversation is started.
   * @param user The address of the user who started the conversation.
   * @param conversationId The ID of the new conversation.
   * @param conversationCID The CID of the immutable conversation data file.
   * @param metadataCID The CID of the mutable metadata file.
   */
  event ConversationAdded(
    address indexed user,
    uint256 indexed conversationId,
    string conversationCID,
    string metadataCID
  );
  /**
   * @notice Emitted when a new conversation is forked from an existing one.
   * @param user The address of the user who created the branch.
   * @param newConversationId The ID of the newly created conversation.
   * @param originalConversationId The ID of the conversation it was branched from.
   * @param branchPointMessageId The ID of the message where the branch occurred.
   * @param conversationCID The CID of the new immutable conversation data file.
   * @param metadataCID The CID of the new mutable metadata file.
   */
  event ConversationBranched( // solhint-disable-line gas-indexed-events
    address indexed user,
    uint256 indexed newConversationId,
    uint256 originalConversationId,
    uint256 branchPointMessageId,
    string conversationCID,
    string metadataCID
  );

  /**
   * @notice Emitted when a user adds a new prompt to a conversation.
   * @param conversationId The ID of the parent conversation.
   * @param messageId The ID of the new prompt message.
   * @param messageCID The CID of the message file.
   */
  event PromptMessageAdded(
    uint256 indexed conversationId,
    uint256 indexed messageId,
    string messageCID
  );

  /**
   * @notice Emitted when the oracle submits an answer to a prompt.
   * @param conversationId The ID of the parent conversation.
   * @param messageId The ID of the new answer message.
   * @param messageCID The CID of the message file.
   */
  event AnswerMessageAdded(
    uint256 indexed conversationId,
    uint256 indexed messageId,
    string messageCID
  );

  /**
   * @notice Emitted with a prompt to provide keywords for off-chain search indexing.
   * @param messageId The ID of the message to be indexed.
   * @param searchDeltaCID The CID of the search index delta file.
   */
  event SearchIndexDeltaAdded(uint256 indexed messageId, string searchDeltaCID);

  /**
   * @notice Emitted when a conversation's metadata CID is updated by the TEE.
   * @param conversationId The ID of the conversation that was updated.
   * @param newConversationMetadataCID The CID of the new metadata file.
   */
  event ConversationMetadataUpdated(
    uint256 indexed conversationId,
    string newConversationMetadataCID
  );

  // Admin Events
  /**
   * @notice Emitted when the linked escrow contract address is updated.
   * @param newAIAgentEscrow The address of the new escrow contract.
   */
  event AgentEscrowUpdated(address indexed newAIAgentEscrow);

  /**
   * @notice Emitted when the key clients encrypt a prompt's session key to is published.
   * @param newKey The secp256k1 public key, compressed or uncompressed.
   */
  event OracleEncryptionKeyUpdated(bytes newKey);

  // --- Errors ---

  // Admin and Setup Errors
  /// @notice Reverts if an address parameter is the zero address.
  error ZeroAddress();
  /// @notice Reverts if an attempt is made to set the escrow address more than once.
  error AgentEscrowAlreadySet();
  /// @notice Reverts if the bytes offered as the encryption key are not a secp256k1 public key.
  error InvalidEncryptionKey();

  // Access Control Errors
  /// @notice Reverts if a function is called by an unauthorized user.
  error Unauthorized();
  /// @notice Reverts if a function is called by an address that does not hold the oracle role.
  error UnauthorizedOracle();
  /// @notice Reverts if a function is called by an address other than the linked escrow contract.
  error NotAIAgentEscrow();

  // Input Validation Errors
  /// @notice Reverts if the oracle attempts to answer a prompt that does not exist.
  error InvalidPromptMessageId();
  /// @notice Reverts if the oracle submits an answer without providing a CID for the answer message.
  error AnswerCIDRequired();

  // State Machine Errors
  /// @notice Reverts if an answer or cancellation is submitted for an already-answered job.
  error JobAlreadyFinalized();
  /// @notice Reverts if a regeneration is requested for a prompt that already has one pending.
  error RegenerationAlreadyPending();

  // --- Initialization ---

  /**
   * @notice Locks the implementation contract so that only a proxy can be initialized.
   * @dev Without this anyone could initialize the bare implementation and own it.
   * @custom:oz-upgrades-unsafe-allow constructor
   */
  constructor() {
    _disableInitializers();
  }

  /**
   * @notice Sets up the AI Agent smart contract.
   * @param _domain The domain used for off-chain SIWE validation.
   * @param _oracle The first address authorized as an oracle (announced by `RoleGranted`).
   * @param _initialOwner The address that will have ownership of this contract.
   */
  function initialize(
    string memory _domain,
    address _oracle,
    address _initialOwner
  ) public initializer {
    if (_oracle == address(0) || _initialOwner == address(0)) {
      revert ZeroAddress();
    }
    __Ownable_init(_initialOwner);
    __AccessControl_init();
    __UUPSUpgradeable_init();
    domain = _domain;
    _grantRole(ORACLE_ROLE, _oracle);

    // Initialize counters to start from 1 to avoid Zero ID Problem when creating new entities
    conversationIdCounter = 1;
    jobIdCounter = 1;
  }

  // --- Modifiers ---

  /**
   * @notice Checks that the caller holds the oracle role.
   */
  modifier onlyOracle() {
    if (!hasRole(ORACLE_ROLE, msg.sender)) {
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
   * @notice Authorizes an address to submit answers as an oracle.
   * @dev Owner only. Several oracles can be authorized at once, so a rotation is add, cut over,
   *      remove, and a prompt in flight during the overlap can be answered by either. Nobody
   *      holds `DEFAULT_ADMIN_ROLE`, so this and `removeOracle` are the only ways the set of
   *      oracles changes, apart from an oracle giving up its own role with `renounceRole`.
   *      Emits `RoleGranted`; adding an address that is already an oracle changes nothing.
   *      The first add also retires the previous version's stored oracle address: from then on
   *      the owner's explicit choices are the whole set.
   * @param _oracle The address to authorize.
   */
  function addOracle(address _oracle) external onlyOwner {
    if (_oracle == address(0)) {
      revert ZeroAddress();
    }
    _retireLegacyOracle();
    _grantRole(ORACLE_ROLE, _oracle);
  }

  /**
   * @notice Withdraws an address's authorization to submit answers.
   * @dev Owner only. Removing the last oracle is allowed, for a compromised key: prompts then
   *      wait for a new oracle or for their timeout refund. Emits `RoleRevoked`. An address
   *      that is not an oracle changes nothing and emits nothing, as adding an existing oracle
   *      does: both calls can be repeated or simulated on their own, and the absence of
   *      `RoleRevoked` is how a mistyped address shows. Removing the
   *      previous version's stored oracle before it was migrated retires it, so the migration
   *      cannot grant it afterwards.
   * @param _oracle The address to remove.
   */
  function removeOracle(address _oracle) external onlyOwner {
    if (_oracle == address(0)) {
      revert ZeroAddress();
    }
    if (_oracle == _legacyOracle) {
      _legacyOracle = address(0);
    }
    _revokeRole(ORACLE_ROLE, _oracle);
  }

  /**
   * @notice Publishes the public key that clients encrypt a prompt's session key to.
   * @dev Owner only. The key is shared by every authorized oracle, so there is one value and not
   *      one per oracle. Clients read it from here, so a change reaches them without a rebuild.
   * @param _newKey A secp256k1 public key: 33 bytes compressed or 65 bytes uncompressed.
   */
  function setOracleEncryptionKey(bytes calldata _newKey) external onlyOwner {
    bool isCompressed = _newKey.length == 33 && (_newKey[0] == 0x02 || _newKey[0] == 0x03);
    bool isUncompressed = _newKey.length == 65 && _newKey[0] == 0x04;
    if (!isCompressed && !isUncompressed) {
      revert InvalidEncryptionKey();
    }
    oracleEncryptionKey = _newKey;
    emit OracleEncryptionKeyUpdated(_newKey);
  }

  /**
   * @notice Carries the single oracle of the previous version over to the oracle role.
   * @dev Runs once, in the same transaction as the upgrade from the single-oracle version
   *      (`upgradeToAndCall`), so the proxy is never left upgraded with no oracle. Owner only,
   *      which in that transaction is the account upgrading. On a proxy deployed fresh there
   *      is no stored oracle and nothing is granted. If the owner has already added an oracle,
   *      or removed the stored one, the stored address has been retired and nothing is granted
   *      either, so a late migration can never bring back an oracle the owner has moved on from.
   */
  function migrateOracleRole() external reinitializer(2) onlyOwner {
    __AccessControl_init();
    address legacyOracle = _legacyOracle;
    if (legacyOracle != address(0)) {
      _legacyOracle = address(0);
      _grantRole(ORACLE_ROLE, legacyOracle);
    }
  }

  /**
   * @notice Forgets the previous version's single oracle address once the owner manages the set.
   * @dev After this, `migrateOracleRole` has nothing to grant.
   */
  function _retireLegacyOracle() private {
    if (_legacyOracle != address(0)) {
      _legacyOracle = address(0);
    }
  }

  /**
   * @notice Tells whether an address is authorized to submit answers.
   * @param _account The address to check.
   * @return isAuthorized True if the address holds the oracle role.
   */
  function isOracle(address _account) external view returns (bool isAuthorized) {
    return hasRole(ORACLE_ROLE, _account);
  }

  // --- Core Functions ---

  /**
   * @notice Atomically reserves a new conversation ID for an upcoming action.
   * @dev This can only be called by the trusted escrow contract.
   * @return newConversationId The newly reserved conversation ID.
   */
  function reserveConversationId() external onlyAIAgentEscrow returns (uint256) {
    uint256 newConversationId = conversationIdCounter;
    ++conversationIdCounter;
    return newConversationId;
  }

  /**
   * @notice Atomically reserves a new job ID for an upcoming action.
   * @dev This can only be called by the trusted escrow contract.
   * @return newJobId The newly reserved job ID.
   */
  function reserveJobId() external onlyAIAgentEscrow returns (uint256) {
    uint256 newJobId = jobIdCounter;
    ++jobIdCounter;
    return newJobId;
  }

  /**
   * @notice Atomically reserves a new message ID for an upcoming action.
   * @dev This can only be called by the trusted escrow contract to prevent ID griefing.
   *      It ensures that every ID retrieved is unique and the counter is immediately updated.
   * @return newMessageId The newly reserved message ID.
   */
  function reserveMessageId() external onlyAIAgentEscrow returns (uint256) {
    uint256 newMessageId = messageIdCounter;
    ++messageIdCounter;
    return newMessageId;
  }

  /**
   * @notice Atomically reserves a new trigger ID for an upcoming agent job.
   * @dev This can only be called by the trusted escrow contract. Trigger IDs are drawn from the
   *      message ID counter: an agent job uses the same escrow record and finalization flag as a
   *      prompt, so the two must share one ID space or one could overwrite the other.
   * @return newTriggerId The newly reserved trigger ID.
   */
  function reserveTriggerId() external onlyAIAgentEscrow returns (uint256) {
    uint256 newTriggerId = messageIdCounter;
    ++messageIdCounter;
    return newTriggerId;
  }

  /**
   * @notice Records a new user prompt after IDs have been reserved and payment secured.
   * @dev This function can only be called by the linked `EVMAIAgentEscrow` contract.
   * @param _user The address of the user who initiated the prompt.
   * @param _conversationId The ID of the conversation. If this was a newly reserved ID, ownership is assigned.
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
  ) external onlyAIAgentEscrow {
    if (conversationToOwner[_conversationId] == address(0)) {
      conversationToOwner[_conversationId] = _user;
    } else if (conversationToOwner[_conversationId] != _user) {
      revert Unauthorized();
    }

    messageToConversation[_promptMessageId] = _conversationId;
    _recordRequest();
    emit PromptSubmitted(
      _user,
      _conversationId,
      _promptMessageId,
      _answerMessageId,
      _encryptedPayload,
      _roflEncryptedKey
    );
  }

  /**
   * @notice Records a user's request to regenerate an answer after payment is secured.
   * @dev This function can only be called by the linked `EVMAIAgentEscrow` contract. It places a
   *      lock on the original prompt to prevent multiple simultaneous regenerations. The user must
   *      own the named conversation and the named prompt; the answer is filed under the named
   *      conversation.
   * @param _user The address of the user requesting the regeneration.
   * @param _conversationId The ID of the conversation this regeneration belongs to (the answer is
   *        filed here). May be a branch of the conversation the prompt was first asked in.
   * @param _promptMessageId The ID of the user's prompt being regenerated.
   * @param _originalAnswerMessageId The ID of the AI answer to regenerate from.
   * @param _answerMessageId The unique, pre-reserved ID for the future answer.
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
  ) external onlyAIAgentEscrow {
    // The caller must own BOTH the conversation they name and the prompt they name. Message ids
    // are shared by all conversations, so without the second check a caller could lock another
    // user's prompt and have an answer filed in that user's conversation. The two conversations
    // may differ: a branch reuses the ids of the messages it inherited, so a regeneration made
    // inside a branch names the branch and a prompt that still belongs to the original. An id
    // nobody has used maps to conversation 0, which has no owner.
    if (
      conversationToOwner[_conversationId] != _user ||
      conversationToOwner[messageToConversation[_promptMessageId]] != _user
    ) {
      revert Unauthorized();
    }
    if (isRegenerationPending[_promptMessageId]) {
      revert RegenerationAlreadyPending();
    }

    isRegenerationPending[_promptMessageId] = true;
    _regenerationLockOf[_answerMessageId] = _promptMessageId + 1;
    // The answer belongs to the conversation the regeneration was asked in, which `submitAnswer`
    // reads back; otherwise a regeneration made inside a branch would be filed under the original.
    messageToConversation[_answerMessageId] = _conversationId;

    _recordRequest();
    emit RegenerationRequested(
      _user,
      _conversationId,
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
   * @param _user The address of the user for whom the job is being run.
   * @param _jobId The ID of the parent job. If this was a newly reserved ID, ownership is assigned.
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
  ) external onlyAIAgentEscrow {
    if (jobToOwner[_jobId] == address(0)) {
      jobToOwner[_jobId] = _user;
    } else if (jobToOwner[_jobId] != _user) {
      revert Unauthorized();
    }

    triggerToJob[_triggerId] = _jobId;
    _recordRequest();
    emit AgentJobSubmitted(_user, _jobId, _triggerId, _encryptedPayload, _roflEncryptedKey);
  }

  /**
   * @notice Submits the final answer and all related decentralised storage CIDs for a prompt.
   * @dev Called by the oracle from within its TEE. The answer ID was pre-reserved.
   * @param _promptMessageId The ID of the user's prompt being answered.
   * @param _answerMessageId The pre-reserved ID that must be used for this answer message.
   * @param _cids A struct containing all the decentralised storage CIDs for the relevant files.
   */
  function submitAnswer(
    uint256 _promptMessageId,
    uint256 _answerMessageId,
    Structs.CidBundle calldata _cids
  ) external onlyOracle {
    if (isJobFinalized[_answerMessageId]) {
      revert JobAlreadyFinalized();
    }

    if (bytes(_cids.answerMessageCID).length == 0) {
      revert AnswerCIDRequired();
    }

    // A regeneration recorded its conversation when it was requested. A first answer has none
    // yet (nor has a regeneration requested before that was recorded): it takes its prompt's.
    uint256 conversationId = messageToConversation[_answerMessageId];
    if (conversationId == 0) {
      conversationId = messageToConversation[_promptMessageId];
    }

    if (conversationToOwner[conversationId] == address(0)) {
      revert InvalidPromptMessageId();
    }

    isJobFinalized[_answerMessageId] = true;
    address user = conversationToOwner[conversationId];

    if (bytes(_cids.conversationCID).length > 0) {
      emit ConversationAdded(user, conversationId, _cids.conversationCID, _cids.metadataCID);
    }

    if (bytes(_cids.promptMessageCID).length > 0) {
      emit PromptMessageAdded(conversationId, _promptMessageId, _cids.promptMessageCID);
      emit SearchIndexDeltaAdded(_promptMessageId, _cids.searchDeltaCID);
    } else {
      bool released = _releaseRegenerationLock(_answerMessageId);
      if (!released && isRegenerationPending[_promptMessageId]) {
        // A regeneration requested before the lock was tracked by answer ID: unlock the prompt
        // the oracle names, as before.
        isRegenerationPending[_promptMessageId] = false;
      }
    }

    messageToConversation[_answerMessageId] = conversationId;
    emit AnswerMessageAdded(conversationId, _answerMessageId, _cids.answerMessageCID);
    aiAgentEscrow.finalizePayment(_answerMessageId);
  }

  /**
   * @notice Records a user's request to update a conversation's metadata.
   * @dev This function can only be called by the linked `EVMAIAgentEscrow` contract after charging a fee.
   * @param _user The address of the user requesting the update.
   * @param _conversationId The ID of the conversation to update.
   * @param _encryptedPayload The encrypted ABI-encoded update instructions (e.g., new title).
   * @param _roflEncryptedKey The session key, encrypted for the ROFL worker.
   */
  function submitMetadataUpdate(
    address _user,
    uint256 _conversationId,
    bytes calldata _encryptedPayload,
    bytes calldata _roflEncryptedKey
  ) external onlyAIAgentEscrow {
    if (conversationToOwner[_conversationId] != _user) {
      revert Unauthorized();
    }

    _recordRequest();
    emit MetadataUpdateRequested(_user, _conversationId, _encryptedPayload, _roflEncryptedKey);
  }

  /**
   * @notice Reveals the new metadata CID after the TEE has updated decentralised storage.
   * @dev This function can only be called by the authorized oracle.
   * @param _conversationId The ID of the conversation that was updated.
   * @param _newConversationMetadataCID The decentralised storage CID of the new metadata file.
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
  ) external onlyAIAgentEscrow {
    if (conversationToOwner[_originalConversationId] != _user) {
      revert Unauthorized();
    }
    conversationToOwner[_newConversationId] = _user;

    _recordRequest();
    emit BranchRequested(
      _user,
      _originalConversationId,
      _branchPointMessageId,
      _newConversationId,
      _encryptedPayload,
      _roflEncryptedKey
    );
  }

  /**
   * @notice Submits the final CIDs for a newly branched conversation.
   * @dev Called by the oracle. Uses the pre-reserved newConversationId.
   * @param _user The address of the user who initiated the branch.
   * @param _originalConversationId The ID of the conversation that was branched from.
   * @param _branchPointMessageId The ID of the message where the branch occurs.
   * @param _newConversationId The pre-reserved ID for the new conversation.
   * @param _conversationCID The decentralised storage CID for the new branched conversation's data.
   * @param _metadataCID The decentralised storage CID for the new branched conversation's metadata.
   */
  function submitBranch(
    address _user,
    uint256 _originalConversationId,
    uint256 _branchPointMessageId,
    uint256 _newConversationId,
    string calldata _conversationCID,
    string calldata _metadataCID
  ) external onlyOracle {
    if (conversationToOwner[_newConversationId] != _user) {
      revert Unauthorized();
    }

    emit ConversationBranched(
      _user,
      _newConversationId,
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
   * @param _user The address of the user who cancelled.
   * @param _answerMessageId The ID of the answer that was cancelled.
   */
  function recordCancellation(address _user, uint256 _answerMessageId) external onlyAIAgentEscrow {
    if (isJobFinalized[_answerMessageId]) {
      revert JobAlreadyFinalized();
    }

    isJobFinalized[_answerMessageId] = true;
    _releaseRegenerationLock(_answerMessageId);
    emit PromptCancelled(_user, _answerMessageId);
  }

  /**
   * @notice Records that a prompt's escrow was refunded after the refund timeout.
   * @dev This function can only be called by the linked `EVMAIAgentEscrow` contract. It finalizes
   *      the job so the oracle skips it before spending anything and a late answer is refused here.
   *      It never reverts for an already finalized job: the escrow returns the user's funds in the
   *      same transaction, and agent-side state must not be able to block a refund.
   *      The escrow is authoritative for which user owns a job; `_user` is taken on its word,
   *      as in `recordCancellation`.
   * @param _user The address of the user whose escrow was refunded.
   * @param _answerMessageId The ID of the answer that will no longer be produced.
   */
  function recordRefund(address _user, uint256 _answerMessageId) external onlyAIAgentEscrow {
    if (isJobFinalized[_answerMessageId]) {
      return;
    }

    isJobFinalized[_answerMessageId] = true;
    _releaseRegenerationLock(_answerMessageId);
    emit PromptRefunded(_user, _answerMessageId);
  }

  /**
   * @notice Unlocks the prompt a regeneration was holding, when that regeneration ends.
   * @dev A no-op for an ordinary prompt, and for a regeneration requested before this mapping
   *      existed.
   * @param _answerMessageId The answer ID of the job that ended.
   * @return released True if the job was a tracked regeneration and its prompt was unlocked.
   */
  function _releaseRegenerationLock(uint256 _answerMessageId) private returns (bool released) {
    uint256 lockedPromptPlusOne = _regenerationLockOf[_answerMessageId];
    if (lockedPromptPlusOne == 0) {
      return false;
    }

    delete _regenerationLockOf[_answerMessageId];
    isRegenerationPending[lockedPromptPlusOne - 1] = false;
    return true;
  }

  /**
   * @notice Counts a request for the oracle and records the block it arrived in.
   * @dev Called once by every function that emits an event the oracle must act on. The oracle
   *      reads `requestCount` to learn whether there is new work and `requestBlock` to fetch the
   *      event from exactly that block, instead of scanning block ranges.
   */
  function _recordRequest() private {
    uint256 requestNumber = requestCount + 1;
    requestCount = requestNumber;
    requestBlock[requestNumber] = block.number;
  }

  // --- Upgradability ---

  /**
   * @notice This internal function is part of the UUPS upgrade mechanism and is restricted to the owner.
   * @dev Authorizes an upgrade to a new implementation contract.
   * @param newImplementation The address of the new implementation contract.
   */
  function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
    // solhint-disable-previous-line no-empty-blocks
    // Intentionally left blank. The onlyOwner modifier provides the necessary access control.
  }

  uint256[33] private __gap;
}
