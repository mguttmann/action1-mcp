import { describe, expect, it } from "vitest";
import { redact, redactString } from "../../src/utils/logger.js";

// Cross-check the logger's redact pipeline so secrets never escape into
// the structured-log line. Tests both positive (must redact) and
// negative (must NOT redact false positives).

describe("redactString — value-pattern matrix", () => {
  it("redacts a Bearer token but keeps the surrounding label", () => {
    const out = redactString("Authorization: Bearer abc123def456");
    expect(out).not.toContain("abc123def456");
    expect(out).toContain("Authorization");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts api-key-* style identifiers", () => {
    const out = redactString("client_id=api-key-AbCd123@action1.com");
    expect(out).not.toContain("api-key-AbCd123@action1.com");
    expect(out).toContain("client_id=");
  });

  it("redacts sk-* secrets but keeps shorter sk-prefixed terms", () => {
    expect(redactString("sk-foobar1234567890abcdef")).toContain("[REDACTED]");
    expect(redactString("ski-resort 1234")).toBe("ski-resort 1234");
  });

  it("redacts a bare JWT (no Bearer prefix)", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.signaturesignaturesignature";
    const out = redactString(`{"access_token":"${jwt}"}`);
    expect(out).not.toContain(jwt);
    expect(out).toContain("[REDACTED]");
  });

  it("redacts URL-embedded basic-auth credentials", () => {
    const out = redactString("https://alice:hunter2@example.com/path");
    expect(out).not.toContain("alice:hunter2");
    expect(out).toContain("[REDACTED]");
    // The non-credential tail of the URL is preserved.
    expect(out).toContain("example.com/path");
  });

  it("redacts client_secret value in a JSON-style body", () => {
    const out = redactString('{"client_secret":"32hex_a_b_c_d_e_f_secret"}');
    expect(out).not.toContain("32hex_a_b_c_d_e_f_secret");
    expect(out).toContain("[REDACTED]");
    // The field name itself is preserved for debug-readability.
    expect(out).toContain("client_secret");
  });

  it("redacts refresh_token value in a form-encoded body", () => {
    const out = redactString("client_id=public&refresh_token=secret-token-value");
    expect(out).not.toContain("secret-token-value");
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("refresh_token=");
  });

  it("does NOT redact short version-strings like 1.2.3", () => {
    expect(redactString("v1.2.3-rc.5")).toBe("v1.2.3-rc.5");
  });

  it("redacts Cookie header value in a raw header-string", () => {
    const out = redactString("Cookie: session=abc123-very-secret; ga=GA1.2.x");
    expect(out).not.toContain("abc123-very-secret");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts Set-Cookie value in a JSON-shaped body", () => {
    const out = redactString('{"set-cookie":"sid=2f8e9-secret-value"}');
    expect(out).not.toContain("2f8e9-secret-value");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts x-action1-token header-shape values", () => {
    const out = redactString("x-action1-token: super-secret-tenant-token-abcd");
    expect(out).not.toContain("super-secret-tenant-token-abcd");
    expect(out).toContain("[REDACTED]");
  });
});

describe("redact — extended key-patterns (cookie / x-action1-token / bare token)", () => {
  it("redacts a bare `token` key", () => {
    const out = redact({ token: "raw-bearer-shaped-secret" }) as Record<string, unknown>;
    expect(out.token).toBe("[REDACTED]");
  });

  it("redacts `x-action1-token` key in nested object", () => {
    const out = redact({
      headers: { "x-action1-token": "tenant-secret-abc" },
    }) as Record<string, unknown>;
    const headers = out.headers as Record<string, unknown>;
    expect(headers["x-action1-token"]).toBe("[REDACTED]");
  });

  it("redacts cookie and set-cookie keys", () => {
    const out = redact({
      cookie: "session=abc",
      "set-cookie": "sid=def",
      "x-other": "ok",
    }) as Record<string, unknown>;
    expect(out.cookie).toBe("[REDACTED]");
    expect(out["set-cookie"]).toBe("[REDACTED]");
    expect(out["x-other"]).toBe("ok");
  });

  it("regression: access_token / refresh_token still redacted by specific key", () => {
    // The new bare `^token$` pattern must not steal the more-specific
    // access_token / refresh_token classification — both still match
    // their own patterns earlier in the order.
    const out = redact({
      access_token: "at_xxx",
      refresh_token: "rt_xxx",
    }) as Record<string, unknown>;
    expect(out.access_token).toBe("[REDACTED]");
    expect(out.refresh_token).toBe("[REDACTED]");
  });

  it("regression: id_token redacted (new explicit pattern)", () => {
    const out = redact({ id_token: "header.payload.signature" }) as Record<string, unknown>;
    expect(out.id_token).toBe("[REDACTED]");
  });
});

describe("redact — robustness against pathological inputs", () => {
  it("does not crash on a circular reference", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a: Record<string, any> = { secret: "should-be-redacted" };
    a.loop = a;
    const out = redact(a) as Record<string, unknown>;
    // Top-level redaction still works.
    expect((out as Record<string, unknown>).secret).toBeDefined();
    // The cycle is broken — JSON.stringify(out) must succeed.
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("renders a Buffer as a length-bounded placeholder, not a 28-key object", () => {
    const buf = Buffer.from("hello world this is 28 bytes");
    const out = redact(buf);
    expect(typeof out).toBe("string");
    expect(out).toMatch(/^\[binary \d+B\]$/);
    // The raw bytes never appear in the output.
    expect(out).not.toContain("hello");
  });

  it("renders a Uint8Array the same way", () => {
    const u8 = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const out = redact(u8);
    expect(typeof out).toBe("string");
    expect(out).toMatch(/^\[binary 8B\]$/);
  });
});

describe("redact — key-pattern matrix on objects", () => {
  it("redacts client_secret value, keeps grant_type", () => {
    const out = redact({ client_secret: "supersecret", grant_type: "client_credentials" });
    expect(out).toEqual({ client_secret: "[REDACTED]", grant_type: "client_credentials" });
  });

  it("redacts password / authorization / access_token", () => {
    const out = redact({
      password: "horse-correct-staple",
      authorization: "Bearer xyz",
      access_token: "at_123",
      not_a_secret: "ok",
    });
    expect((out as Record<string, unknown>).password).toBe("[REDACTED]");
    expect((out as Record<string, unknown>).authorization).toBe("[REDACTED]");
    expect((out as Record<string, unknown>).access_token).toBe("[REDACTED]");
    expect((out as Record<string, unknown>).not_a_secret).toBe("ok");
  });

  it("does NOT redact client_id (it is not a secret)", () => {
    const out = redact({ client_id: "api-key-AbCd@action1.com" });
    // The KEY isn't redacted, but the VALUE pattern still kicks in for
    // api-key-* identifiers — that's intentional defence-in-depth.
    expect(out).toEqual({ client_id: "[REDACTED]" });
  });

  it("recurses into nested objects", () => {
    const out = redact({ outer: { inner: { client_secret: "x" } } });
    expect(
      (
        ((out as Record<string, unknown>).outer as Record<string, unknown>).inner as Record<
          string,
          unknown
        >
      ).client_secret,
    ).toBe("[REDACTED]");
  });

  it("recurses into arrays", () => {
    const out = redact([{ password: "p1" }, { password: "p2" }]) as Array<Record<string, unknown>>;
    expect(out[0]?.password).toBe("[REDACTED]");
    expect(out[1]?.password).toBe("[REDACTED]");
  });

  it("truncates pathological depth instead of stack-overflowing", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const root: Record<string, any> = {};
    let cur = root;
    for (let i = 0; i < 50; i++) {
      cur.next = {};
      cur = cur.next;
    }
    cur.password = "deep-secret";
    const out = redact(root);
    // We don't care exactly what the truncation looks like — just that
    // the deep secret never makes it back out as plain text.
    expect(JSON.stringify(out)).not.toContain("deep-secret");
  });
});
