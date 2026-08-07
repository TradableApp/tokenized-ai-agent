/**
 * Corrective nudges appended to a generation prompt on retry (attempt > 1) when
 * the LLM's previous output was rejected as a template/meta leak by
 * `sanitizeOutboundText`. Shared across the `generateSanitized`-wrapped paths so
 * every retry uses the same instruction. See utils/generateSanitized.ts.
 */

/**
 * XML-expecting paths (Telegram action synthesis via actionChainHelper). The
 * model must KEEP its `<response>` wrapper — only the `<text>` content field has
 * to be clean — so we never tell an XML path to drop the XML we parse.
 */
export const XML_RETRY_NUDGE =
  "\n\nIMPORTANT: Your previous response was rejected — the <text> field contained stray tags or commentary about the task instead of the message itself. Respond again in the exact same XML format, but put ONLY the final message inside the <text> tag. No nested tags, no meta-commentary, no explanation.";

/** Plain-text paths (broadcast Writer) — forbid XML entirely. */
export const PLAIN_RETRY_NUDGE =
  "\n\nIMPORTANT: Your previous output was rejected because it contained XML tags or commentary about the task. Output ONLY the final post text as plain text — no XML tags, no <post>/<response> tags, no explanation.";
