/**
 * Answer provenance — what the dApp shows beneath an answer.
 *
 * Both shapes are a CONTRACT with sense-ai-dapp. They are written into the encrypted
 * MessageFile by formatters.js, uploaded to decentralised storage, and reach the dApp only via
 * its `...messageData` spread in syncService, where `types.ts` declares them as
 * `sources?: Array<{title, url}>` and `reasoning?: Array<{title, description}>`. They are NOT
 * on-chain and NOT indexed by the subgraph (which carries only `messageCID`), so changing a
 * shape here means changing the dApp in the same breath — and e2e T-REASON-01 asserts both
 * sources' hrefs round-trip.
 *
 * Nothing in this module may throw. Provenance is decoration on an answer the user has already
 * paid for; losing a citation list is a blemish, losing the answer is a refund.
 */

/** The provider whose composed data carries citable material. */
const NEWS_PROVIDER = "MARKET_INTELLIGENCE";

/**
 * Derives the answer's sources from the state the ElizaOS run actually composed.
 *
 * Reads `state.data.providers[NEWS_PROVIDER]`, which is ElizaOS's own provider-results cache
 * ("keyed by provider name"), so the list reflects what was genuinely put in front of the model
 * rather than a list the oracle happened to fetch alongside it.
 *
 * Honest naming caveat: this is *composed context*, not *cited* sources. Proving the answer
 * used a given item requires model-emitted citations, tracked separately (CU-86d3ydvxq).
 *
 * @param {object} [state] composed ElizaOS state
 * @returns {Array<{title: string, url: string}>}
 */
function sourcesFromState(state) {
  // NOTE THE `.data`. ElizaOS stores each provider's ENTIRE result under
  // `state.data.providers[name]`, not just its data field:
  //
  //     const providerData = await Promise.all(providersToGet.map(async (provider) => {
  //       const result = await provider.get(this, message, cachedState);
  //       return { ...result, providerName: provider.name };
  //     }));
  //     …
  //     data: { ...cachedState.data, providers: currentProviderResults }
  //
  // (@elizaos/core 1.7.2, dist/node/index.node.js — AgentRuntime.composeState.)
  //
  // So the entry is `{ text, values, data, providerName }` and the payload is one level deeper.
  // An earlier version read `.latestNews` directly, which is always undefined — sources would
  // have been [] on every live answer, a silent regression from the list the dApp already
  // rendered. Unit tests did not catch it because the stub was authored to match the wrong
  // assumption; this comment exists so the next ElizaOS upgrade can re-verify against a cited
  // location rather than a belief.
  const rows = state?.data?.providers?.[NEWS_PROVIDER]?.data?.latestNews;
  if (!Array.isArray(rows)) return [];

  const seen = new Set();
  const sources = [];

  for (const row of rows) {
    const title = typeof row?.title === "string" ? row.title.trim() : "";
    const url = typeof row?.url === "string" ? row.url.trim() : "";

    // The dApp renders these as links: an entry without both is a broken row, not a source.
    if (!title || !url) continue;

    // Adjacent adapters can surface the same article. The same link twice reads as a padded
    // citation count to someone paying per prompt.
    if (seen.has(url)) continue;

    seen.add(url);
    sources.push({ title, url });
  }

  return sources;
}

/**
 * Shapes the runtime's thoughts into the dApp's reasoning steps.
 *
 * Titled by the ACTION that produced each thought where one is attributed. The previous
 * "Step 1 / Step 2 / …" carried no information — it numbered the disclosure without saying
 * what happened, which is most of the reason to expand it. The numbered form remains only as
 * the fallback, because a thought with no attributed action is still worth showing.
 *
 * Accepts either `{ thought, action }` objects or bare strings: `aiAgentOracle` pushes
 * `content.thought` (a string) today, and the helper must not force every call site to change
 * in the same commit.
 *
 * @param {Array<{thought?: string, action?: string}|string>} [thoughts]
 * @returns {Array<{title: string, description: string}>}
 */
function reasoningFromThoughts(thoughts) {
  if (!Array.isArray(thoughts)) return [];

  const steps = [];

  for (const entry of thoughts) {
    const isString = typeof entry === "string";
    const description = (isString ? entry : entry?.thought) ?? "";
    const text = typeof description === "string" ? description.trim() : "";
    if (!text) continue;

    const action = !isString && typeof entry?.action === "string" ? entry.action.trim() : "";

    // Numbered against KEPT steps, not the input index, so dropping an empty thought does not
    // leave a gap in what the user sees.
    steps.push({ title: action || `Step ${steps.length + 1}`, description: text });
  }

  return steps;
}

module.exports = { sourcesFromState, reasoningFromThoughts, NEWS_PROVIDER };
