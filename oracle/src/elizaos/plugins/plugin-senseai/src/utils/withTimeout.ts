/**
 * Deadline guard for awaited promises.
 *
 * Motivation (CU-86d3n8aew / sense-ai-core#64): a bare `await runtime.useModel(...)`
 * hangs indefinitely when the model endpoint's connection opens but never
 * responds (observed in the ROFL TEE, where the outbound proxy intermittently
 * fails TLS). A `try/catch` does not help — a hang never rejects — so the call
 * sat until ElizaOS's 90s guard swallowed it with no user reply. `withTimeout`
 * converts a hang into a bounded, catchable rejection so callers can degrade.
 */

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Race `promise` against a timeout. Resolves with the promise's value if it
 * settles first; rejects with a {@link TimeoutError} if the deadline passes
 * first. Genuine rejections from `promise` propagate unchanged. The timer is
 * always cleared (success OR failure), so no dangling handle keeps the event
 * loop alive.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * As {@link withTimeout}, but returns `null` instead of throwing on timeout OR
 * on any rejection — for call sites that want to fall back gracefully rather
 * than propagate the failure (e.g. skip a vector search when the embedding
 * model is unreachable and rely on a text-only query instead).
 */
export async function withTimeoutOrNull<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T | null> {
  try {
    return await withTimeout(promise, ms, label);
  } catch {
    return null;
  }
}
