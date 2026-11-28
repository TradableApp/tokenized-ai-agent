// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import { EVMAIAgent } from "../../contracts/EVMAIAgent.sol";
import { EVMAIAgentEscrow } from "../../contracts/EVMAIAgentEscrow.sol";
import { Structs } from "../../contracts/libraries/Structs.sol";
import { MockAbleToken } from "../../contracts/mocks/MockAbleToken.sol";

/// The two cheatcodes the suite needs, declared here so nothing is fetched to run it.
interface Vm {
  function prank(address sender) external;

  function warp(uint256 timestamp) external;
}

/**
 * Drives the escrow as its users, its oracle and its owner do, in any order the fuzzer picks.
 * Every call is wrapped, so a refused call is a step that did nothing. The handler makes one
 * kind of claim of its own: a pending escrow whose waiting time has passed can always be
 * cancelled by its user and refunded by anyone. A refusal there is recorded and fails the run.
 */
contract EscrowHandler {
  Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

  uint256 private constant PENDING = 0;
  uint256 private constant ACTORS = 4;
  uint256 private constant MAX_FEE = 20 ether;

  EVMAIAgent public immutable AGENT;
  EVMAIAgentEscrow public immutable ESCROW;
  MockAbleToken public immutable TOKEN;
  address public immutable OWNER;
  address public immutable ORACLE;

  address[] public actors;

  /// True for an escrow opened by a prompt or a regeneration, which the oracle can answer.
  mapping(uint256 => bool) public isPromptEscrow;
  /// The prompt an answer id belongs to.
  mapping(uint256 => uint256) public promptOf;
  /// An answered (prompt, answer) pair per actor, to regenerate from.
  mapping(address => uint256) public answeredPrompt;
  mapping(address => uint256) public answeredAnswer;
  mapping(address => bool) public hasAnswered;

  /// What each plan must show as spent, kept from the rules alone: a payment adds its fee, a
  /// refund takes the whole payment back off, a cancel takes back all but the fee it kept,
  /// an answer changes nothing, and a new or cancelled plan starts again from zero.
  mapping(address => uint256) public expectedSpent;
  /// What each wallet and the treasury must hold, kept the same way: a payment leaves the
  /// wallet; an answer sends it to the treasury; a cancel sends the fee kept to the treasury
  /// and the rest to the user; a refund sends all of it to the user; a branch or rename fee
  /// goes from the wallet straight to the treasury.
  mapping(address => uint256) public expectedBalance;
  uint256 public expectedTreasury;

  /// Set when a cancel or a refund that must succeed was refused.
  bool public exitRefused;
  bytes public exitRefusedData;
  uint256 public exitRefusedEscrow;

  uint256 public promptsOpened;
  uint256 public cancels;
  uint256 public refunds;
  uint256 public answers;

  constructor(
    EVMAIAgent _agent,
    EVMAIAgentEscrow _escrow,
    MockAbleToken _token,
    address _owner,
    address _oracle,
    address[] memory _actors
  ) {
    AGENT = _agent;
    ESCROW = _escrow;
    TOKEN = _token;
    OWNER = _owner;
    ORACLE = _oracle;
    actors = _actors;
    for (uint256 i = 0; i < _actors.length; ++i) {
      expectedBalance[_actors[i]] = _token.balanceOf(_actors[i]);
    }
  }

  function actorCount() external view returns (uint256) {
    return actors.length;
  }

  function _actor(uint256 seed) private view returns (address) {
    return actors[seed % ACTORS];
  }

  function _status(
    uint256 id
  ) private view returns (address user, uint256 createdAt, uint256 status) {
    EVMAIAgentEscrow.EscrowStatus s;
    (user, , createdAt, s) = ESCROW.escrows(id);
    status = uint256(s);
  }

  function _amount(uint256 id) private view returns (uint256 amount) {
    (, amount, , ) = ESCROW.escrows(id);
  }

  // --- A user's plan ---

  function setLimit(uint256 actorSeed, uint256 allowance, uint256 duration) external {
    address actor = _actor(actorSeed);
    allowance = 1 + (allowance % 200 ether);
    duration = 1 + (duration % 30 days);
    VM.prank(actor);
    try ESCROW.setSpendingLimit(allowance, block.timestamp + duration) {
      expectedSpent[actor] = 0;
    } catch {} // solhint-disable-line no-empty-blocks
  }

  function cancelLimit(uint256 actorSeed) external {
    address actor = _actor(actorSeed);
    VM.prank(actor);
    try ESCROW.cancelSpendingLimit() {
      expectedSpent[actor] = 0;
    } catch {} // solhint-disable-line no-empty-blocks
  }

  // --- Paying actions ---

  function prompt(uint256 actorSeed, bool exactMax) external {
    address actor = _actor(actorSeed);
    uint256 answerId = AGENT.messageIdCounter() + 1;
    uint256 fee = ESCROW.promptFee();
    uint256 maxFee = exactMax ? fee : type(uint256).max;
    VM.prank(actor);
    try ESCROW.initiatePrompt(0, "p", "k", maxFee) {
      expectedSpent[actor] += fee;
      expectedBalance[actor] -= fee;
      isPromptEscrow[answerId] = true;
      promptOf[answerId] = answerId - 1;
      ++promptsOpened;
    } catch {} // solhint-disable-line no-empty-blocks
  }

  function regenerate(uint256 actorSeed) external {
    address actor = _actor(actorSeed);
    if (!hasAnswered[actor]) return;
    uint256 promptId = answeredPrompt[actor];
    uint256 answerId = AGENT.messageIdCounter();
    uint256 conversationId = AGENT.messageToConversation(promptId);
    uint256 fee = ESCROW.promptFee();
    VM.prank(actor);
    try
      ESCROW.initiateRegeneration(
        conversationId,
        promptId,
        answeredAnswer[actor],
        "p",
        "k",
        type(uint256).max
      )
    {
      expectedSpent[actor] += fee;
      expectedBalance[actor] -= fee;
      isPromptEscrow[answerId] = true;
      promptOf[answerId] = promptId;
      ++promptsOpened;
    } catch {} // solhint-disable-line no-empty-blocks
  }

  function agentJob(uint256 actorSeed) external {
    address actor = _actor(actorSeed);
    uint256 fee = ESCROW.promptFee();
    VM.prank(ORACLE);
    try ESCROW.initiateAgentJob(actor, 0, "p", "k") {
      expectedSpent[actor] += fee;
      expectedBalance[actor] -= fee;
    } catch {} // solhint-disable-line no-empty-blocks
  }

  function branch(uint256 actorSeed) external {
    address actor = _actor(actorSeed);
    if (!hasAnswered[actor]) return;
    uint256 conversationId = AGENT.messageToConversation(answeredPrompt[actor]);
    uint256 fee = ESCROW.branchFee();
    VM.prank(actor);
    try ESCROW.initiateBranch(conversationId, answeredAnswer[actor], "p", "k", type(uint256).max) {
      expectedSpent[actor] += fee;
      expectedBalance[actor] -= fee;
      expectedTreasury += fee;
    } catch {} // solhint-disable-line no-empty-blocks
  }

  function rename(uint256 actorSeed) external {
    address actor = _actor(actorSeed);
    if (!hasAnswered[actor]) return;
    uint256 conversationId = AGENT.messageToConversation(answeredPrompt[actor]);
    uint256 fee = ESCROW.metadataUpdateFee();
    VM.prank(actor);
    try ESCROW.initiateMetadataUpdate(conversationId, "p", "k", type(uint256).max) {
      expectedSpent[actor] += fee;
      expectedBalance[actor] -= fee;
      expectedTreasury += fee;
    } catch {} // solhint-disable-line no-empty-blocks
  }

  // --- The three ways an escrow ends ---

  function answer(uint256 idSeed) external {
    uint256 count = AGENT.messageIdCounter();
    if (count == 0) return;
    uint256 id = idSeed % count;
    (address user, , uint256 status) = _status(id);
    if (user == address(0) || status != PENDING || !isPromptEscrow[id]) return;
    Structs.CidBundle memory cids = Structs.CidBundle("c", "m", "p", "a", "s");
    uint256 amount = _amount(id);
    VM.prank(ORACLE);
    try AGENT.submitAnswer(promptOf[id], id, cids) {
      expectedTreasury += amount;
      answeredPrompt[user] = promptOf[id];
      answeredAnswer[user] = id;
      hasAnswered[user] = true;
      ++answers;
    } catch {} // solhint-disable-line no-empty-blocks
  }

  function cancel(uint256 idSeed, bool exactMax) external {
    uint256 count = AGENT.messageIdCounter();
    if (count == 0) return;
    uint256 id = idSeed % count;
    (address user, uint256 createdAt, uint256 status) = _status(id);
    if (user == address(0) || status != PENDING) return;
    bool mustSucceed = block.timestamp >= createdAt + ESCROW.CANCELLATION_TIMEOUT();
    // The cancellation fee is at least the fee charged, so naming it never refuses the cancel.
    uint256 cancellationFee = ESCROW.cancellationFee();
    uint256 maxFee = exactMax ? cancellationFee : type(uint256).max;
    uint256 amount = _amount(id);
    uint256 kept = cancellationFee < amount ? cancellationFee : amount;
    VM.prank(user);
    try ESCROW.cancelPrompt(id, maxFee) {
      expectedSpent[user] -= amount - kept;
      expectedBalance[user] += amount - kept;
      expectedTreasury += kept;
      ++cancels;
    } catch (bytes memory data) {
      if (mustSucceed) _recordRefusal(id, data);
    }
  }

  function refund(uint256 idSeed, uint256 callerSeed) external {
    uint256 count = AGENT.messageIdCounter();
    if (count == 0) return;
    uint256 id = idSeed % count;
    (address user, uint256 createdAt, uint256 status) = _status(id);
    if (user == address(0) || status != PENDING) return;
    bool mustSucceed = block.timestamp >= createdAt + ESCROW.REFUND_TIMEOUT();
    uint256 amount = _amount(id);
    VM.prank(_actor(callerSeed));
    try ESCROW.processRefund(id) {
      expectedSpent[user] -= amount;
      expectedBalance[user] += amount;
      ++refunds;
    } catch (bytes memory data) {
      if (mustSucceed) _recordRefusal(id, data);
    }
  }

  function _recordRefusal(uint256 id, bytes memory data) private {
    exitRefused = true;
    exitRefusedData = data;
    exitRefusedEscrow = id;
  }

  // --- Time and the owner ---

  function warp(uint256 secs) external {
    VM.warp(block.timestamp + 1 + (secs % 2 hours));
  }

  function setFee(uint256 which, uint256 fee) external {
    fee = fee % (MAX_FEE + 1);
    which = which % 4;
    VM.prank(OWNER);
    if (which == 0) ESCROW.setPromptFee(fee);
    else if (which == 1) ESCROW.setCancellationFee(fee);
    else if (which == 2) ESCROW.setBranchFee(fee);
    else ESCROW.setMetadataUpdateFee(fee);
  }
}

contract EscrowInvariantsTest {
  uint256 private constant PENDING = 0;
  uint256 private constant MINTED_EACH = 1_000_000 ether;

  EVMAIAgent private agent;
  EVMAIAgentEscrow private escrow;
  MockAbleToken private token;
  EscrowHandler private handler;

  address private constant OWNER = address(0xA11CE);
  address private constant ORACLE = address(0x04AC1E);
  address private constant TREASURY = address(0x7EA5);
  address[] private actors;

  Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

  function setUp() public {
    token = new MockAbleToken();

    agent = EVMAIAgent(
      address(
        new ERC1967Proxy(
          address(new EVMAIAgent()),
          abi.encodeCall(EVMAIAgent.initialize, ("example.com", ORACLE, OWNER))
        )
      )
    );
    // Fees: prompt 5, cancellation 1, metadata 0.5, branch 2 (whole tokens, 18 decimals).
    escrow = EVMAIAgentEscrow(
      address(
        new ERC1967Proxy(
          address(new EVMAIAgentEscrow()),
          abi.encodeCall(
            EVMAIAgentEscrow.initialize,
            (address(token), address(agent), TREASURY, OWNER, 5 ether, 1 ether, 0.5 ether, 2 ether)
          )
        )
      )
    );
    VM.prank(OWNER);
    agent.setAgentEscrow(address(escrow));

    for (uint256 i = 0; i < 4; ++i) {
      address actor = address(uint160(0x1000 + i));
      actors.push(actor);
      token.mint(actor, MINTED_EACH);
      VM.prank(actor);
      token.approve(address(escrow), type(uint256).max);
    }

    handler = new EscrowHandler(agent, escrow, token, OWNER, ORACLE, actors);
  }

  /// Only the handler is fuzzed; calls made straight to the contracts would mostly be refused.
  function targetContracts() public view returns (address[] memory targets) {
    targets = new address[](1);
    targets[0] = address(handler);
  }

  /// The handler's own wiring, walked once by hand: a prompt, an agent job, an answer, a
  /// regeneration, a cancel and a refund each go through. Without this a handler whose calls
  /// were all refused would leave every invariant true and prove nothing.
  function test_theHandlerReachesEveryPath() public {
    handler.setLimit(0, 100 ether - 1, 30 days - 1); // allowance 100, 30 days
    handler.prompt(0, true); // ids 0 (prompt) and 1 (answer), 5 escrowed
    require(token.balanceOf(address(escrow)) == 5 ether, "prompt was not escrowed");
    handler.answer(1);
    require(handler.answers() == 1, "answer did not go through");
    require(token.balanceOf(TREASURY) == 5 ether, "answer did not pay the treasury");

    handler.regenerate(0); // id 2
    handler.agentJob(0); // id 3
    require(handler.promptsOpened() == 2, "regeneration did not go through");
    require(token.balanceOf(address(escrow)) == 10 ether, "two payments should be pending");

    handler.warp(3); // 4 s on: past the 3 s cancellation wait
    handler.cancel(2, true);
    require(handler.cancels() == 1, "cancel did not go through");
    // The cancel kept 1 of the 5: treasury 5 + 1, and 5 still pending for the agent job.
    require(token.balanceOf(TREASURY) == 6 ether, "cancel fee did not reach the treasury");

    handler.warp(1 hours); // past the refund wait
    handler.refund(3, 1);
    require(handler.refunds() == 1, "refund did not go through");
    require(token.balanceOf(address(escrow)) == 0, "nothing should be pending");
    require(!handler.exitRefused(), "an exit was refused");

    handler.branch(0); // 2 to the treasury
    handler.rename(0); // 0.5 to the treasury
    require(token.balanceOf(TREASURY) == 8.5 ether, "branch and rename fees did not arrive");
  }

  /// The escrow holds exactly the payments that are still pending, no more and no less.
  function invariant_escrowHoldsExactlyThePendingPayments() public view {
    uint256 count = agent.messageIdCounter();
    uint256 pending;
    for (uint256 id = 0; id < count; ++id) {
      (address user, uint256 amount, , EVMAIAgentEscrow.EscrowStatus status) = escrow.escrows(id);
      if (user != address(0) && uint256(status) == PENDING) pending += amount;
    }
    require(token.balanceOf(address(escrow)) == pending, "escrow balance != pending payments");
  }

  /// A user's plan has spent at least what the escrow holds for them, so handing a payment
  /// back never takes the spent amount below zero; and the pending count is the true count.
  function invariant_planCoversPendingAndCountIsTrue() public view {
    uint256 count = agent.messageIdCounter();
    for (uint256 a = 0; a < actors.length; ++a) {
      uint256 pending;
      uint256 pendingCount;
      for (uint256 id = 0; id < count; ++id) {
        (address user, uint256 amount, , EVMAIAgentEscrow.EscrowStatus status) = escrow.escrows(id);
        if (user == actors[a] && uint256(status) == PENDING) {
          pending += amount;
          ++pendingCount;
        }
      }
      (uint256 allowance, uint256 spent, ) = escrow.spendingLimits(actors[a]);
      require(spent >= pending, "plan spent < pending payments");
      require(spent == handler.expectedSpent(actors[a]), "plan spent is not what the rules give");
      require(spent <= allowance || allowance == 0, "plan spent > allowance");
      require(escrow.pendingEscrowCount(actors[a]) == pendingCount, "pending count is wrong");
    }
  }

  /// No token is made or lost: users, the treasury and the escrow hold everything minted, and
  /// each wallet and the treasury hold exactly what the rules give them.
  function invariant_tokensAreConserved() public view {
    uint256 total = token.balanceOf(address(escrow)) + token.balanceOf(TREASURY);
    for (uint256 a = 0; a < actors.length; ++a) total += token.balanceOf(actors[a]);
    require(total == MINTED_EACH * actors.length, "tokens were made or lost");
    require(
      token.balanceOf(TREASURY) == handler.expectedTreasury(),
      "treasury is not what the rules give"
    );
    for (uint256 a = 0; a < actors.length; ++a) {
      require(
        token.balanceOf(actors[a]) == handler.expectedBalance(actors[a]),
        "a wallet is not what the rules give"
      );
    }
    require(token.balanceOf(address(agent)) == 0, "the agent holds tokens");
    require(token.balanceOf(address(handler)) == 0, "the handler holds tokens");
  }

  /// A pending escrow whose waiting time has passed was never refused its cancel or refund.
  function invariant_aDueExitIsNeverRefused() public view {
    require(!handler.exitRefused(), "a cancel or refund that was due was refused");
  }

  /// A fee change is never applied to a payment already escrowed: no pending amount is above
  /// the highest fee the handler can set.
  function invariant_noEscrowAboveTheHighestFee() public view {
    uint256 count = agent.messageIdCounter();
    for (uint256 id = 0; id < count; ++id) {
      (, uint256 amount, , ) = escrow.escrows(id);
      require(amount <= 20 ether, "an escrow is above the highest fee");
    }
  }
}
