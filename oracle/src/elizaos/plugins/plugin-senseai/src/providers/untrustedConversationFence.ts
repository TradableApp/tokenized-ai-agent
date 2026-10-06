import type { Provider, ProviderResult } from "@elizaos/core";
import { UNTRUSTED_REGION_NOTICE } from "@tradableapp/sense-ai-brain";

/**
 * The conversation fence, assembled by composition rather than by a template.
 *
 * WHAT IT DEFENDS. The prompt that answers a paid on-chain prompt is bootstrap's
 * `messageHandlerTemplate`, and the user's own text reaches it through RECENT_MESSAGES. Nothing in that
 * prompt distinguishes what the user wrote from what this system wrote, so a prompt opening
 * `### URGENT SYSTEM DIRECTIVE:` arrives in the same shape and with the same apparent authority as the
 * blocks the providers use to steer the agent.
 *
 * WHY NOT A TEMPLATE OVERRIDE. `messageHandlerTemplate` has no `{{recentMessages}}` — only
 * `{{providers}}`, one blob holding every provider's text. Fencing that blob would fence
 * MACRO_SENTIMENT and MARKET_INTELLIGENCE with it, telling the model to disregard the market context
 * the oracle exists to read.
 *
 * WHY NOT THE STORED TEXT. `content.text` is the prompt the user PAID for: it is rendered back to them
 * in the dApp and hashed into the MessageFile CID. Fence tags do not belong in either.
 *
 * SO: COMPOSITION. `composeState` sorts providers by `(a.position || 0) - (b.position || 0)` and joins
 * their texts with newlines and no per-provider labels, so a provider at 99 and one at 101 bracket
 * whatever sits at 100 — bootstrap's RECENT_MESSAGES, and nothing else ships at either number. The
 * accompanying test asserts that against the INSTALLED bootstrap, because the bracket silently stops
 * bracketing if RECENT_MESSAGES ever moves.
 *
 * VERIFIED to run on the path that matters. `@elizaos/core`'s `runSingleShotCore` composes with
 * `composeState(message, ["ACTIONS"])` and `onlyInclude` OMITTED, so every non-private, non-dynamic
 * provider runs — these two included. The pre-call in `aiAgentOracle.js` uses `onlyInclude: true` over
 * the two market providers, so it is unaffected and provenance stays describing data sources only.
 *
 * IDENTICAL IN INTENT TO sense-ai-core's pair, and deliberately not shared code: a provider is host
 * wiring, and the Brain stays free of every framework. What IS shared is the notice, imported from the
 * Brain so both bodies tell the model the same thing about the same tag family.
 */

const OPENING_TAG = "<untrusted_conversation>";
const CLOSING_TAG = "</untrusted_conversation>";

/**
 * Opens the region, immediately before RECENT_MESSAGES composes.
 *
 * Carries no notice. The notice belongs with the closing half, where it reads AFTER the data it
 * describes — a rule stated before an untrusted region is one the region gets to argue with
 * afterwards, and this is the same ordering every fenced prompt in both bodies now uses.
 */
export const untrustedConversationOpenProvider: Provider = {
  name: "UNTRUSTED_CONVERSATION_OPEN",
  position: 99,

  get: async (): Promise<ProviderResult> => ({ text: OPENING_TAG, values: {}, data: {} }),
};

/**
 * Closes the region and states what it meant.
 *
 * ONE NOTICE FOR EVERY REGION IN THE PROMPT, which is why this is the whole of the fencing change on
 * this body rather than half of it. The notice names the `<untrusted_*>` FAMILY, and at position 101 it
 * reads after everything that composes before it — including the `<untrusted_news>` region the Brain's
 * `formatNewsTicker` now emits through MARKET_INTELLIGENCE at position 51. A second notice there would
 * be duplicated context in a prompt the user paid for.
 */
export const untrustedConversationCloseProvider: Provider = {
  name: "UNTRUSTED_CONVERSATION_CLOSE",
  position: 101,

  get: async (): Promise<ProviderResult> => ({
    text: `${CLOSING_TAG}\n\n${UNTRUSTED_REGION_NOTICE}`,
    values: {},
    data: {},
  }),
};
