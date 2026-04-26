# ABI Diff Report

**Date:** 2026-04-25  
**Branch:** tests-tokenized  
**Compiler:** solc 0.8.24 (evmVersion: paris)

## Sources compared

| Source | Path |
|--------|------|
| Compiled artifact | `artifacts/contracts/EVMAIAgent.sol/EVMAIAgent.json` |
| Compiled artifact | `artifacts/contracts/EVMAIAgentEscrow.sol/EVMAIAgentEscrow.json` |
| dApp ABI | `../sense-ai-dapp/src/lib/abi/EVMAIAgent.json` |
| dApp ABI | `../sense-ai-dapp/src/lib/abi/EVMAIAgentEscrow.json` |
| Subgraph ABI | `../sense-ai-subgraph/abis/EVMAIAgent.json` |
| Subgraph ABI | `../sense-ai-subgraph/abis/EVMAIAgentEscrow.json` |

## Result: NO DIFFERENCES FOUND

### EVMAIAgent

**Events (17):** all identical across compiled / dApp / subgraph

| Event | Status |
|-------|--------|
| AgentEscrowUpdated | OK |
| AgentJobSubmitted | OK |
| AnswerMessageAdded | OK |
| BranchRequested | OK |
| ConversationAdded | OK |
| ConversationBranched | OK |
| ConversationMetadataUpdated | OK |
| Initialized | OK |
| MetadataUpdateRequested | OK |
| OracleUpdated | OK |
| OwnershipTransferred | OK |
| PromptCancelled | OK |
| PromptMessageAdded | OK |
| **PromptSubmitted** | **OK** — param[3] `answerMessageId` (non-indexed) matches in all three |
| RegenerationRequested | OK |
| SearchIndexDeltaAdded | OK |
| Upgraded | OK |

**Functions:** all identical across compiled / dApp / subgraph

### EVMAIAgentEscrow

**Events:** all identical across compiled / dApp / subgraph

**Functions:** all identical across compiled / dApp / subgraph

## Key invariant verified

`PromptSubmitted` event parameter order is consistent in all three ABIs:

```
[0] address indexed  user
[1] uint256 indexed  conversationId
[2] uint256 indexed  promptMessageId
[3] uint256          answerMessageId  ← universal linking key, NON-INDEXED
[4] bytes            encryptedPayload
[5] bytes            roflEncryptedKey
```

`answerMessageId` at index 3 is confirmed non-indexed in the compiled artifact, the dApp ABI, and the subgraph ABI.
