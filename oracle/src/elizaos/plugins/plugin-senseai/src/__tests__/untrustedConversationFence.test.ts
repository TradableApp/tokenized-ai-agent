import { describe, expect, it } from "bun:test";

import bootstrap from "@elizaos/plugin-bootstrap";
import { UNTRUSTED_REGION_NOTICE } from "@tradableapp/sense-ai-brain";

import { senseAIPlugin } from "../index";
import {
  untrustedConversationCloseProvider,
  untrustedConversationOpenProvider,
} from "../providers/untrustedConversationFence";

/**
 * The conversation fence, for the on-chain body.
 *
 * WHY A PROVIDER PAIR AND NOT A TEMPLATE. The prompt that answers a paid prompt is bootstrap's
 * `messageHandlerTemplate`, and it has no `{{recentMessages}}` — only `{{providers}}`, one blob holding
 * every provider's text. Overriding the template to fence that blob would fence MACRO_SENTIMENT and
 * MARKET_INTELLIGENCE too, telling the model to disregard the market context it was built to read.
 *
 * Fencing the STORED text is equally out: `content.text` is the user's paid prompt, rendered back to
 * them in the dApp and hashed into the MessageFile CID.
 *
 * So the fence is assembled by composition instead. `composeState` sorts providers by
 * `(a.position || 0) - (b.position || 0)` and joins their texts with newlines and NO per-provider
 * labels, so a provider at 99 and one at 101 bracket whatever sits at 100 — which is bootstrap's
 * RECENT_MESSAGES. Nothing else ships at either number.
 *
 * ONE NOTICE COVERS EVERY REGION, and that is what makes this the whole of the change rather than half
 * of it. The Brain's `formatNewsTicker` now emits `<untrusted_news>`, and MARKET_INTELLIGENCE renders
 * it at position 51 — ahead of the closing provider. So the notice at 101 reads after both the news
 * region and the conversation region, which is also the ordering the notice needs to carry weight.
 * Without that, the pin bump would put fence tags into a PAID prompt with nothing explaining them.
 */
describe("the untrusted conversation fence", () => {
  it("brackets position 100 from either side", () => {
    expect(untrustedConversationOpenProvider.position).toBe(99);
    expect(untrustedConversationCloseProvider.position).toBe(101);
  });

  it("runs in the default composition, which is the only one that builds the answer prompt", () => {
    // `composeState` filters on `!p.private && !p.dynamic` when no explicit include list is given.
    // Either flag set on either provider removes half the fence and leaves the other half in the
    // prompt as a dangling tag — worse than no fence, because the model sees an unclosed region.
    for (const provider of [untrustedConversationOpenProvider, untrustedConversationCloseProvider]) {
      expect(provider.private ?? false, `${provider.name} must not be private`).toBe(false);
      expect(provider.dynamic ?? false, `${provider.name} must not be dynamic`).toBe(false);
    }
  });

  it("opens and closes the same region", async () => {
    const open = await untrustedConversationOpenProvider.get({} as never, {} as never, {} as never);
    const close = await untrustedConversationCloseProvider.get(
      {} as never,
      {} as never,
      {} as never,
    );

    expect(open.text).toContain("<untrusted_conversation>");
    expect(close.text).toContain("</untrusted_conversation>");
  });

  it("states the Brain's notice verbatim, in the CLOSING half", () => {
    // In the closing half because the notice has to read AFTER the data it describes: a rule stated
    // before an untrusted region is one the region gets to argue with afterwards.
    return untrustedConversationCloseProvider
      .get({} as never, {} as never, {} as never)
      .then((close) => {
        expect(close.text).toContain(UNTRUSTED_REGION_NOTICE);
      });
  });

  it("is registered on the plugin, or it never runs at all", () => {
    const names = (senseAIPlugin.providers ?? []).map((p) => p.name);

    expect(names).toContain("UNTRUSTED_CONVERSATION_OPEN");
    expect(names).toContain("UNTRUSTED_CONVERSATION_CLOSE");
  });

  /**
   * THE ASSUMPTION, checked against the INSTALLED bootstrap rather than described in a comment.
   *
   * Positions 99 and 101 only bracket the conversation while RECENT_MESSAGES is at 100. An ElizaOS
   * bump that moves it leaves both halves of the fence in the prompt around nothing, and the failure is
   * silent: the tags are still there, the notice is still there, and the conversation is outside them.
   */
  it("still has RECENT_MESSAGES at 100, with nothing else between 99 and 101", () => {
    const providers = bootstrap.providers ?? [];
    const recent = providers.find((p) => p.name === "RECENT_MESSAGES");

    expect(recent, "RECENT_MESSAGES is gone from bootstrap entirely").toBeDefined();
    expect(recent?.position, "RECENT_MESSAGES moved — the bracket no longer brackets it").toBe(100);

    const intruders = providers
      .filter((p) => (p.position ?? 0) > 99 && (p.position ?? 0) < 101)
      .map((p) => p.name)
      .filter((name) => name !== "RECENT_MESSAGES");

    expect(intruders, "something else now composes inside the fence").toEqual([]);
  });
});
