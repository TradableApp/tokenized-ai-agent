import { describe, expect, it } from "bun:test";
import { TimeoutError, withTimeout, withTimeoutOrNull } from "../utils/withTimeout";

const resolveAfter = <T>(value: T, ms: number): Promise<T> =>
  new Promise((r) => setTimeout(() => r(value), ms));
const hang = <T>(): Promise<T> => new Promise(() => {});

describe("withTimeout", () => {
  it("resolves with the value when the promise settles before the deadline", async () => {
    const result = await withTimeout(resolveAfter("ok", 5), 50, "fast");
    expect(result).toBe("ok");
  });

  it("rejects with a TimeoutError when the promise hangs past the deadline", async () => {
    let caught: unknown;
    try {
      await withTimeout(hang(), 20, "news-embedding");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TimeoutError);
    expect((caught as Error).message).toContain("news-embedding");
  });

  it("does not wait for the full deadline when the promise resolves quickly", async () => {
    const start = Date.now();
    await withTimeout(resolveAfter("quick", 5), 500, "fast");
    // Must return ~immediately after the 5ms resolve, not linger to 500ms —
    // proves the timeout timer is cleared on success (no dangling handle).
    expect(Date.now() - start).toBeLessThan(200);
  });

  it("propagates a genuine rejection (not a timeout) unchanged", async () => {
    const boom = Promise.reject(new Error("upstream failure"));
    let caught: unknown;
    try {
      await withTimeout(boom, 50, "fast");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("upstream failure");
    expect(caught).not.toBeInstanceOf(TimeoutError);
  });
});

describe("withTimeoutOrNull", () => {
  it("returns the value on success", async () => {
    expect(await withTimeoutOrNull(resolveAfter(42, 5), 50, "fast")).toBe(42);
  });

  it("returns null on timeout instead of throwing", async () => {
    expect(await withTimeoutOrNull(hang(), 20, "news-embedding")).toBeNull();
  });

  it("returns null on a genuine rejection too (graceful degradation)", async () => {
    expect(await withTimeoutOrNull(Promise.reject(new Error("x")), 50, "fast")).toBeNull();
  });
});
