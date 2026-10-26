import { describe, expect, it, vi } from "vitest";
import {
  RETRY_AFTER_CEILING_MS,
  isTransientNetworkError,
  withRetry,
} from "../../src/client/retry.js";

describe("isTransientNetworkError", () => {
  it("matches direct error.code values", () => {
    expect(isTransientNetworkError({ code: "ECONNRESET" })).toBe(true);
    expect(isTransientNetworkError({ code: "ENOTFOUND" })).toBe(true);
    expect(isTransientNetworkError({ code: "EAI_AGAIN" })).toBe(true);
    expect(isTransientNetworkError({ code: "EBUSY" })).toBe(false);
  });

  it("matches nested error.cause.code values", () => {
    expect(isTransientNetworkError({ cause: { code: "UND_ERR_CONNECT_TIMEOUT" } })).toBe(true);
  });

  it("rejects non-objects and missing codes", () => {
    expect(isTransientNetworkError(null)).toBe(false);
    expect(isTransientNetworkError(undefined)).toBe(false);
    expect(isTransientNetworkError("string-error")).toBe(false);
    expect(isTransientNetworkError({})).toBe(false);
  });
});

describe("withRetry", () => {
  it("succeeds on the first attempt without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const out = await withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 2,
      retryOn: () => true,
    });
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on transient errors and eventually succeeds", async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("transient");
      return "ok";
    });
    const onRetry = vi.fn();
    const out = await withRetry(fn, {
      maxAttempts: 5,
      baseDelayMs: 1,
      maxDelayMs: 2,
      retryOn: () => true,
      onRetry,
    });
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    // One retry per failed attempt, numbered from 1.
    expect(onRetry.mock.calls.map((c) => c[1] as number)).toEqual([1, 2]);
  });

  it("stops retrying after maxAttempts and rethrows the last error", async () => {
    const fn = vi.fn(async () => {
      throw new Error("permanent");
    });
    const onRetry = vi.fn();
    await expect(
      withRetry(fn, {
        maxAttempts: 2,
        baseDelayMs: 1,
        maxDelayMs: 2,
        retryOn: () => true,
        onRetry,
      }),
    ).rejects.toThrow("permanent");
    expect(fn).toHaveBeenCalledTimes(2);
    // The last attempt throws at once: no retry is announced and no
    // backoff is slept after it.
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(expect.anything(), 1, expect.any(Number));
  });

  it("does not retry when retryOn returns false", async () => {
    const fn = vi.fn(async () => {
      throw new Error("non-retryable");
    });
    const onRetry = vi.fn();
    await expect(
      withRetry(fn, {
        maxAttempts: 5,
        baseDelayMs: 1,
        maxDelayMs: 2,
        retryOn: () => false,
        onRetry,
      }),
    ).rejects.toThrow("non-retryable");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("aborts mid-flight when the signal fires", async () => {
    const ctrl = new AbortController();
    const fn = vi.fn(async () => {
      throw new Error("transient");
    });
    setTimeout(() => ctrl.abort(), 5);
    await expect(
      withRetry(fn, {
        maxAttempts: 10,
        baseDelayMs: 100,
        maxDelayMs: 100,
        retryOn: () => true,
        signal: ctrl.signal,
      }),
    ).rejects.toThrow(/Aborted/i);
  });

  it("honours retryAfterMs from the error over the exponential schedule", async () => {
    const onRetry = vi.fn();
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error("rate-limited") as Error & { retryAfterMs: number };
        err.retryAfterMs = 7;
        throw err;
      }
      return "ok";
    });
    const out = await withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 999,
      maxDelayMs: 9999,
      retryOn: () => true,
      onRetry,
    });
    expect(out).toBe("ok");
    expect(onRetry).toHaveBeenCalledWith(expect.anything(), 1, 7);
  });

  it("applies ±25% jitter on the exponential schedule (no thundering herd)", async () => {
    // Run the retry loop a few times, capture the computed delays,
    // and assert that:
    //   1. every delay lies inside the [0.75x, 1.25x] window around
    //      the deterministic exponential schedule;
    //   2. the *set* of observed delays is not all-identical (i.e.
    //      jitter actually fires - would catch a stale spec where
    //      someone removed the randomness).
    const baseDelayMs = 100;
    const expected = baseDelayMs; // attempt 1 → baseDelayMs * 2^0
    const observed: number[] = [];
    for (let trial = 0; trial < 20; trial++) {
      const onRetry = vi.fn((_e, _a, delay: number) => {
        observed.push(delay);
      });
      let attempts = 0;
      const fn = vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient");
        return "ok";
      });
      await withRetry(fn, {
        maxAttempts: 2,
        baseDelayMs,
        maxDelayMs: baseDelayMs * 10,
        retryOn: () => true,
        onRetry,
      });
    }
    // bounds
    for (const d of observed) {
      expect(d).toBeGreaterThanOrEqual(expected * 0.75 - 1e-9);
      expect(d).toBeLessThanOrEqual(expected * 1.25 + 1e-9);
    }
    // dispersion - extremely unlikely to all collide
    const unique = new Set(observed);
    expect(unique.size).toBeGreaterThan(1);
  });

  // ----- Retry-After ceiling ----------------------------
  //
  // A hostile or buggy upstream that sends `Retry-After: 86400` would
  // otherwise stall the retry loop for 24 h. We cap at
  // RETRY_AFTER_CEILING_MS (60 s) - past that the exponential schedule
  // with jitter is a safer fallback. Cap is exposed so the test can
  // pin the constant; if it ever ticks up to 120 s we want a deliberate
  // test edit, not a silent regression.

  it("clamps absurd Retry-After to the 60s ceiling and warns once", async () => {
    const onRetry = vi.fn();
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error("rate-limited") as Error & { retryAfterMs: number };
        // 24 h in ms - pre-fix this would sleep for ~86,400,000ms.
        err.retryAfterMs = 86_400_000;
        throw err;
      }
      return "ok";
    });
    vi.useFakeTimers();
    try {
      const p = withRetry(fn, {
        maxAttempts: 2,
        baseDelayMs: 999,
        maxDelayMs: 9999,
        retryOn: () => true,
        onRetry,
      });
      // Drain the clamped 60 s sleep on the fake clock instead of
      // burning a real wall-clock minute per test run.
      await vi.runAllTimersAsync();
      await p;
    } finally {
      vi.useRealTimers();
    }
    expect(onRetry).toHaveBeenCalledWith(expect.anything(), 1, RETRY_AFTER_CEILING_MS);
  });

  it("passes through reasonable Retry-After values untouched (below the ceiling)", async () => {
    const onRetry = vi.fn();
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error("rate-limited") as Error & { retryAfterMs: number };
        err.retryAfterMs = 5_000; // 5 s - well below the cap
        throw err;
      }
      return "ok";
    });
    vi.useFakeTimers();
    try {
      const p = withRetry(fn, {
        maxAttempts: 2,
        baseDelayMs: 999,
        maxDelayMs: 9999,
        retryOn: () => true,
        onRetry,
      });
      await vi.runAllTimersAsync();
      await p;
    } finally {
      vi.useRealTimers();
    }
    expect(onRetry).toHaveBeenCalledWith(expect.anything(), 1, 5_000);
  });

  it("does not jitter server-provided Retry-After values", async () => {
    const onRetry = vi.fn();
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error("rate-limited") as Error & { retryAfterMs: number };
        err.retryAfterMs = 250;
        throw err;
      }
      return "ok";
    });
    await withRetry(fn, {
      maxAttempts: 2,
      baseDelayMs: 100,
      maxDelayMs: 999,
      retryOn: () => true,
      onRetry,
    });
    expect(onRetry).toHaveBeenCalledWith(expect.anything(), 1, 250);
  });
});
