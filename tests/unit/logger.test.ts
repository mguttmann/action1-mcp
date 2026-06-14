import { describe, expect, it } from "vitest";
import { getLogLevel, redact, redactString, setLogLevel } from "../../src/utils/logger.js";

describe("redactString", () => {
  it("masks Bearer tokens", () => {
    expect(redactString("Authorization: Bearer abc123.def-456_X+Y/Z=")).toBe(
      "Authorization: [REDACTED]",
    );
  });
  it("masks api-key prefixes", () => {
    expect(redactString("client_id=api-key-DEADBEEF-1234@example.com")).toBe(
      "client_id=[REDACTED]",
    );
  });
});

describe("redact (objects)", () => {
  it("scrubs sensitive keys recursively", () => {
    const input = {
      Authorization: "Bearer xxx",
      access_token: "yyy",
      ClientSecret: "shh",
      nested: {
        refresh_token: "rr",
        ok: "fine",
      },
      list: [{ password: "p", value: 1 }],
    };
    const out = redact(input) as Record<string, unknown>;
    expect(out.Authorization).toBe("[REDACTED]");
    expect(out.access_token).toBe("[REDACTED]");
    expect(out.ClientSecret).toBe("[REDACTED]");
    const nested = out.nested as Record<string, unknown>;
    expect(nested.refresh_token).toBe("[REDACTED]");
    expect(nested.ok).toBe("fine");
    const list = out.list as { password: unknown; value: unknown }[];
    expect(list[0]!.password).toBe("[REDACTED]");
    expect(list[0]!.value).toBe(1);
  });

  it("handles Error instances", () => {
    const err = new Error("Bearer leak.token here");
    const out = redact(err) as { message: string };
    expect(out.message).toContain("[REDACTED]");
    expect(out.message).not.toContain("leak.token");
  });

  it("returns primitives unchanged", () => {
    expect(redact(1)).toBe(1);
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBe(null);
  });
});

describe("setLogLevel / getLogLevel", () => {
  it("accepts MCP syslog levels and roundtrips", () => {
    const original = getLogLevel();
    try {
      setLogLevel("debug");
      expect(getLogLevel()).toBe("debug");
      setLogLevel("warning");
      expect(getLogLevel()).toBe("warning");
      setLogLevel("critical");
      expect(getLogLevel()).toBe("critical");
    } finally {
      setLogLevel(original);
    }
  });

  it("silently ignores unknown levels (future SDK enum-loosening)", () => {
    const original = getLogLevel();
    try {
      setLogLevel("info");
      // Unknown level: no-op, current level stays as-is. Implementation
      // emits a `log.warn("unknown_log_level", …)` for observability,
      // but the API contract is "do not throw" so a future MCP SDK that
      // introduces a level we don't know about cannot crash the handler.
      expect(() => setLogLevel("loud" as never)).not.toThrow();
      expect(getLogLevel()).toBe("info");
    } finally {
      setLogLevel(original);
    }
  });
});
