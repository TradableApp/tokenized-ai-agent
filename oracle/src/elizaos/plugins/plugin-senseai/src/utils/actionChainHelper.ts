import {
  type ActionResult,
  composePromptFromState,
  elizaLogger,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  ModelType,
  parseKeyValueXml,
  type State,
} from "@elizaos/core";
import { generateSanitized, sanitizeOutboundText } from "@tradableapp/sense-ai-brain";
import { XML_RETRY_NUDGE } from "./retryNudges";
import { withTimeout } from "./withTimeout";

/**
 * PORTED FROM sense-ai-core `src/plugins/plugin-senseai/src/utils/actionChainHelper.ts`.
 *
 * Keep this file in step with core's copy: Phase 3 (CU-86d3z28xv) extracts both into a shared
 * `plugin-senseai` package, and every un-reconciled difference at that point becomes either a
 * merge conflict or a permanent fork. The template below and the generate/sanitize/parse/fallback
 * sequence are core's, unchanged.
 *
 * THREE deliberate differences, each marked ORACLE DIVERGENCE at its site:
 *   1. `withTimeout` around synthesis (+ the constants it needs) — the ROFL proxy can hang a
 *      connection forever, and this body's prompts are paid for on-chain.
 *   2. Degrade rather than throw — core's chat user can ask again; this body's caller cannot.
 *   3. The else-branch log message — core's describes a state that cannot occur.
 *
 * This header previously said "two", which was wrong: divergence 3 was documented at its site but
 * not counted here. Corrected because Phase 3 reconciles from this list — an undercount is worse
 * than an unreconciled difference, since it tells the extractor to stop looking.
 *
 * KNOWN COSMETIC DRIFT, not behavioural and not yet reconciled: core numbers four of its step
 * comments ("3. Gather providers…", "5. Append…", "6. Compose…", "7. Use generateSanitized…") and
 * two of those comments are absent here entirely. Executable lines were diffed against core to
 * confirm nothing else differs. Restoring them belongs to the 2.7 parity audit (PR D), whose
 * acceptance criteria already require exactly this file-by-file comparison; doing it here would
 * mean editing a file this change does not otherwise touch.
 */

// Mirrored exactly from core replyTemplate, with just ONE addition:
// The {{actionResults}} block to hold our combined data.
const chainSynthesisTemplate = `
# Task: Generate dialog for the character {{agentName}}.

{{providers}}

# Action Results Data:
{{actionResultsData}}

# Instructions: Write the next message for {{agentName}}.
"thought" should be a short description of what the agent is thinking about and how it is interpreting the Action Results Data to answer the user.
"text" should be the next message for {{agentName}} which they will send to the conversation.

IMPORTANT CODE BLOCK FORMATTING RULES:
- If {{agentName}} includes code examples, snippets, or multi-line code in the response, ALWAYS wrap the code with \`\`\` fenced code blocks (specify the language if known, e.g., \`\`\`python).
- ONLY use fenced code blocks for actual code. Do NOT wrap non-code text, instructions, or single words in fenced code blocks.
- If including inline code (short single words or function names), use single backticks (\`) as appropriate.
- This ensures the user sees clearly formatted and copyable code when relevant.

Do NOT include any thinking, reasoning, or <think> sections in your response.
Go directly to the XML response format without any preamble or explanation.

Respond using XML format like this:
<response>
    <thought>Your thought here</thought>
    <text>Your message here</text>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.
`;

/**
 * ORACLE DIVERGENCE 1 — deadline.
 *
 * Core awaits `runtime.useModel` bare. In the ROFL TEE the outbound proxy intermittently opens a
 * connection that never responds, and a hang never rejects, so a bare await strands the turn. Core
 * already ships `withTimeout` for exactly this failure (see utils/withTimeout.ts, CU-86d3n8aew);
 * it simply has not applied it to synthesis yet. The oracle must, because its prompts are paid for
 * on-chain and the answer is immutable — a stranded turn is money spent for nothing.
 *
 * This is an improvement to offer BACK to core at the 2.7 parity audit, not a fork to keep.
 *
 * ON THE VALUE. Core's withTimeout doc says a hung call "sat until ElizaOS's 90s guard swallowed
 * it". That 90s is NOT verifiable in the installed @elizaos/core — the only 90000 in the bundle
 * is LangSmith's tracing client timeout. Do not size this against that number.
 *
 * The bound that is real, and contractual, is REFUND_TIMEOUT = 1 hour in both
 * SapphireAIAgentEscrow and EVMAIAgentEscrow: past it the user can reclaim the payment, so an
 * answer arriving later is worthless. Two attempts at 45s is 90s against an hour — roughly a 40x
 * margin, even with five prompts draining the queue concurrently. The value is chosen for how
 * long a paying user should wait, not to squeeze under a ceiling.
 */
export const SYNTHESIS_TIMEOUT_MS = 45_000;

/** `generateSanitized` retries once on a leak, so the worst case is two full deadlines. */
export const SYNTHESIS_MAX_ATTEMPTS = 2;

/** Shown when every attempt leaked, errored, or timed out. Silence is the worse failure. */
const FALLBACK_TEXT = "Still gathering my readings on this. Try again in a few minutes.";

export async function handleChainSynthesis(
  runtime: IAgentRuntime,
  message: Memory,
  actionResult: ActionResult,
  state?: State,
  options?: HandlerOptions,
  callback?: HandlerCallback,
  responses?: Memory[]
): Promise<void> {
  const plan = options?.actionPlan;

  // 1. Check if we are at the end of the action chain
  const isLastStep = !plan || plan.currentStep === plan.totalSteps;

  if (!isLastStep) {
    elizaLogger.info(
      `[ChainHelper] ${actionResult.data?.actionName || "UNKNOWN_ACTION"} is step ${plan?.currentStep}/${plan?.totalSteps}. Passing data forward.`
    );

    // We let the action finish quietly, passing its data to the next action via ActionResult
    return;
  }
  elizaLogger.info(
    `[ChainHelper] ${actionResult.data?.actionName || "UNKNOWN_ACTION"} is the final step. Synthesizing final response...`
  );

  // RE-COMPOSE STATE (Following the exact replyAction pattern)
  // This ensures the freshest bio, rules, and facts are pulled into {{providers}}
  const allProviders: string[] = [];
  if (responses) {
    for (const res of responses) {
      const providers = res.content?.providers;
      if (providers && providers.length > 0) {
        allProviders.push(...providers);
      }
    }
  }

  state = await runtime.composeState(message, [
    ...(allProviders ?? []),
    "RECENT_MESSAGES",
    "ACTION_STATE",
  ]);

  // Append the current actionResult to state.data.actionResults
  state.data = {
    ...state.data,
    actionResults: [...(state.data?.actionResults ?? []), actionResult],
  };

  // Stringify the accumulated action results so the template can render them via {{actionResultsData}}
  state.actionResultsData = JSON.stringify(state.data.actionResults, null, 2);

  const basePrompt = composePromptFromState({
    state,
    template: chainSynthesisTemplate,
  });

  // Use generateSanitized to wrap generation with retry-on-leak.
  // The sanitize function captures and returns the thought as context.
  // Because we need both thought and text, we store thought in a closure.
  //
  // Everything below is per-call. The oracle drains prompts through a p-queue at concurrency 5
  // while core has one turn in flight, so module-level state here would interleave one user's
  // answer into another's immutable, already-paid-for MessageFile.
  let capturedThought: string = "";
  let text: string;
  let sanitizedText: string | null = null;

  // ORACLE DIVERGENCE 2 — degrade, never throw.
  //
  // Core lets a model failure propagate; its chat user can simply ask again. The oracle's caller
  // has already charged the user on-chain and cannot retry on their behalf, so every failure path
  // has to end in a delivered answer.
  try {
    sanitizedText = await generateSanitized(
      async (attempt) => {
        const promptWithNudge = attempt > 1 ? `${basePrompt}${XML_RETRY_NUDGE}` : basePrompt;
        return await withTimeout(
          runtime.useModel(ModelType.TEXT_LARGE, { prompt: promptWithNudge }),
          SYNTHESIS_TIMEOUT_MS,
          `chain synthesis attempt ${attempt}`
        );
      },
      (raw) => {
        const parsedXml = parseKeyValueXml(raw ?? "");
        const textValue = parsedXml?.text;
        const t = typeof textValue === "string" ? textValue : "";
        const result = sanitizeOutboundText(t); // returns null on leak/empty → triggers retry
        // Capture the thought ONLY from the attempt whose text passed sanitization,
        // so the logged thought trail matches the message actually used (not a
        // discarded leaking attempt).
        if (result) {
          const thoughtValue = parsedXml?.thought;
          capturedThought = typeof thoughtValue === "string" ? thoughtValue : capturedThought;
        }
        return result;
      },
      SYNTHESIS_MAX_ATTEMPTS
    );
  } catch (error) {
    elizaLogger.error(
      `[ChainHelper] Synthesis failed: ${error instanceof Error ? error.message : String(error)}. Using fallback message.`
    );
  }

  const thought = capturedThought;
  if (!sanitizedText) {
    // Replace with safe fallback if all retries leaked or were empty
    text = FALLBACK_TEXT;
    elizaLogger.warn(
      "[ChainHelper] Generation was rejected after 2 attempts (template/meta leak or empty). Using fallback message."
    );
  } else {
    text = sanitizedText;
  }

  // Send the final response via callback
  if (callback && text) {
    elizaLogger.info(`[ChainHelper] Synthesis complete. Sending response.`);

    await callback({
      text,
      source: message.content.source,
      thought, // Log the thought process for debugging/memory
      // Tag it for your usage/billing evaluator  <- core's comment, restored verbatim.
      //
      // On THIS body the tag carries a second load core does not have: `selectAnswer` uses it to
      // prefer our synthesis over a later third-party emission (see oracle/src/answerSelection.js,
      // CU-86d3z0r81). Renaming the action without updating SYNTHESIS_ACTIONS silently turns
      // attribution off, which is why oracle/test/synthesisActions.test.js enforces the pairing.
      actions: [actionResult.data?.actionName || "UNKNOWN_ACTION"] as string[],
    });
  } else {
    // ORACLE DIVERGENCE 3 — the else-branch message (text only, no behaviour). Core logs
    // "Failed to parse XML response or text was
    // empty" here, which cannot be true: `text` is either FALLBACK_TEXT (a non-empty constant) or
    // `sanitizedText`, which sanitizeOutboundText only returns when non-empty. So this branch is
    // reachable only when no callback was supplied, and core's message would send a future
    // debugger hunting a parse failure that never happened. Fixing the message rather than
    // copying a wrong one; queued as a core-side PR for the 2.7 parity audit.
    elizaLogger.warn(`[ChainHelper] No callback supplied — synthesised response dropped.`);
  }
}
