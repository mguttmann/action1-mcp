import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetLoggerThrottleForTests,
  getLogLevel,
  log,
  setLogLevel,
} from "../../src/utils/logger.js";

// Finding 5.6 — bound stderr footprint for the logger.
// Two concerns:
//   (a) per-entry meta caps so a 1 000-row dump can't bloat one
//       record into the megabytes;
//   (b) per-minute throughput cap with 1/10 sampling so a 1 000-
//       endpoint sweep on DEBUG can't drown the parent process.

function captureStderr(): { restore: () => void; lines: string[] } {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  const spy = vi.fn((chunk: string | Uint8Array) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    for (const line of text.split("\n")) {
      if (line.length > 0) lines.push(line);
    }
    return true;
  });
  process.stderr.write = spy as unknown as typeof process.stderr.write;
  return {
    restore: () => {
      process.stderr.write = original;
    },
    lines,
  };
}

describe("logger — meta-size cap (finding 5.6)", () => {
  let originalLevel: ReturnType<typeof getLogLevel>;
  beforeEach(() => {
    originalLevel = getLogLevel();
    setLogLevel("debug");
    __resetLoggerThrottleForTests();
  });
  afterEach(() => {
    setLogLevel(originalLevel);
    __resetLoggerThrottleForTests();
  });

  it("truncates meta payloads larger than the soft cap", () => {
    const cap = captureStderr();
    try {
      const huge = { dump: "x".repeat(20 * 1024) }; // 20 KB
      log.info("big_meta_event", huge);
    } finally {
      cap.restore();
    }
    expect(cap.lines).toHaveLength(1);
    const record = JSON.parse(cap.lines[0]!) as { meta: Record<string, unknown> };
    expect(record.meta.__truncated).toBe(true);
    expect(typeof record.meta.__original_size_bytes).toBe("number");
    expect(record.meta.__original_size_bytes).toBeGreaterThan(8 * 1024);
    // The preserved prefix is bounded.
    expect(typeof record.meta.payload_prefix).toBe("string");
    expect((record.meta.payload_prefix as string).length).toBeLessThanOrEqual(4 * 1024);
  });

  it("leaves small meta payloads untouched", () => {
    const cap = captureStderr();
    try {
      log.info("small_meta_event", { id: 1, kind: "x" });
    } finally {
      cap.restore();
    }
    const record = JSON.parse(cap.lines[0]!) as { meta: Record<string, unknown> };
    expect(record.meta.__truncated).toBeUndefined();
    expect(record.meta.id).toBe(1);
    expect(record.meta.kind).toBe("x");
  });
});

describe("logger — throughput throttle (finding 5.6)", () => {
  let originalLevel: ReturnType<typeof getLogLevel>;
  beforeEach(() => {
    originalLevel = getLogLevel();
    setLogLevel("debug");
    __resetLoggerThrottleForTests();
    // Freeze wall-clock so the throttle window never rolls forward
    // during the test. Without fake timers the loop below — 2 000
    // sequential log calls plus JSON.stringify on every record — can
    // exceed 60 s on a slow CI runner, the 60 s sliding window rolls,
    // the second batch is treated as a fresh budget, and all 2 000
    // entries fly through (assertion `< 1_200` then fails).
    // logger.ts reads `Date.now()` directly (verified via
    // grep — see `emit` and `shouldEmitUnderThrottle`), which
    // vi.useFakeTimers stubs by default, so freezing the system time
    // is sufficient.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T00:00:00Z"));
  });
  afterEach(() => {
    setLogLevel(originalLevel);
    __resetLoggerThrottleForTests();
    vi.useRealTimers();
  });

  it("samples down to ~10% once the per-minute budget is exceeded", () => {
    const cap = captureStderr();
    try {
      // 1 000 entries fit under the budget and all pass through.
      // The next 1 000 are sampled at 1/10 + at most one
      // logger_throttled summary.
      for (let i = 0; i < 2_000; i++) {
        log.info("tick", { i });
      }
    } finally {
      cap.restore();
    }
    // First 1 000 entries: full passthrough.
    // Next 1 000 entries: ~100 sampled survivors.
    // Plus at most 1 logger_throttled summary in that period.
    expect(cap.lines.length).toBeGreaterThan(1_000);
    expect(cap.lines.length).toBeLessThan(1_200);
    const throttledSummary = cap.lines.filter((l) => l.includes("logger_throttled"));
    expect(throttledSummary.length).toBeGreaterThanOrEqual(1);
    // The summary record carries the throttling parameters.
    const summary = JSON.parse(throttledSummary[0]!) as {
      msg: string;
      meta: Record<string, unknown>;
    };
    expect(summary.msg).toBe("logger_throttled");
    expect(summary.meta.limit_per_window).toBe(1_000);
    expect(summary.meta.sample_divisor).toBe(10);
  });
});
