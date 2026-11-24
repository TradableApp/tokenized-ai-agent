/**
 * A one-line description of an error that is safe to log.
 *
 * The plugin runs in the oracle's TEE and logs to the same place, and an error from a request
 * can carry the request's address, access key included. The oracle describes errors with
 * `oracle/src/errorDescription.js`, which also knows the secret parts of every configured
 * address; the host hands that describer to the plugin at start-up (`setErrorDescriber`), so both
 * describe an error the same way. The plugin does not import it: its bundle carries none of the
 * oracle's modules, and a bundled copy would hold its own, separately loaded, list of secrets.
 *
 * Until the host has handed one over, or when the one handed over throws, an error is described
 * by its kind alone (its code, or its name), which can never carry an address.
 */
export type ErrorDescriber = (error: unknown) => string;

let describer: ErrorDescriber | null = null;

/** Host injection point, called once at oracle start-up; `null` clears it (tests). */
export function setErrorDescriber(next: ErrorDescriber | null): void {
  describer = next;
}

export function describeError(error: unknown): string {
  if (describer) {
    try {
      return describer(error);
    } catch {
      // A describer that fails says nothing about the error; its kind is still safe to log.
    }
  }
  return errorKind(error);
}

// A code or name as a log line can carry it: one short word, never an address.
const KIND = /^[A-Za-z0-9_.-]{1,64}$/;

/** The error's code, or its name where it has none, or "Error". It never throws. */
function errorKind(error: unknown): string {
  for (const property of ["code", "name"]) {
    let value: unknown;
    try {
      value = (error as Record<string, unknown> | null | undefined)?.[property];
    } catch {
      value = undefined;
    }
    if ((typeof value === "string" || typeof value === "number") && KIND.test(String(value))) {
      return String(value);
    }
  }
  return "Error";
}
