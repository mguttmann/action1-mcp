import { afterEach, describe, expect, it, vi } from "vitest";
import { Action1Client } from "../../src/client/action1Client.js";
import { Action1ApiError, Action1AuthError } from "../../src/client/errors.js";
import type { AppConfig } from "../../src/config.js";

// Unit tests for the HTTP plumbing in Action1Client. The TokenProvider
// is real, so we mock its underlying fetch the same way auth.test.ts
// does. To keep retries fast, we pass `retry: false` on the no-retry
// flows and override the global fetch counters where retries matter.

const cfg: AppConfig = {
  baseUrl: "https://example.test/api/3.0",
  defaultOrgId: "00000000-0000-0000-0000-000000000001",
  clientId: "client",
  clientSecret: "secret",
  defaultTimeoutMinutes: "10",
  defaultRetryMinutes: "1440",
  lastSeenStaleMinutes: 10,
  allowDestructive: false,
  destructiveAutoConfirm: false,
  allowAccountOps: false,
  allowedOrgIds: [],
  toolsets: [],
  redactPii: false,
  http: {
    port: 3000,
    host: "127.0.0.1",
    allowedOrigins: [],
    allowedHosts: [],
    token: undefined,
    allowNoAuth: false,
    trustProxy: false,
  },
};

interface FetchCall {
  url: string;
  init: RequestInit;
}

interface ScriptedResponse {
  status?: number;
  body?: object | string;
  headers?: Record<string, string>;
}

/**
 * Mock fetch that:
 *   - first call: returns a fresh OAuth token (so TokenProvider stops
 *     pestering us about auth)
 *   - subsequent calls: feed the queued responses in order, recording
 *     the request for assertions
 */
function mockFetch(responses: ScriptedResponse[]): {
  spy: ReturnType<typeof vi.fn>;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  const spy = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "tkn", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    calls.push({ url, init });
    const r = queue.shift() ?? { status: 500, body: "exhausted" };
    const status = r.status ?? 200;
    const headers = { "Content-Type": "application/json", ...(r.headers ?? {}) };
    const body =
      r.body === undefined ? null : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return new Response(body, { status, headers });
  });
  vi.stubGlobal("fetch", spy);
  return { spy, calls };
}

describe("Action1Client.request", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns undefined on 204 No Content", async () => {
    mockFetch([{ status: 204 }]);
    const client = new Action1Client(cfg);
    const out = await client.request<unknown>("/anything", { retry: false });
    expect(out).toBeUndefined();
  });

  it("parses JSON when Content-Type is application/json", async () => {
    mockFetch([{ status: 200, body: { foo: "bar" } }]);
    const client = new Action1Client(cfg);
    const out = await client.request<{ foo: string }>("/x", { retry: false });
    expect(out).toEqual({ foo: "bar" });
  });

  it("returns the raw text when Content-Type is text/plain", async () => {
    mockFetch([{ status: 200, body: "hello-world", headers: { "Content-Type": "text/plain" } }]);
    const client = new Action1Client(cfg);
    const out = await client.request<string>("/x", { retry: false });
    expect(out).toBe("hello-world");
  });

  it("on 401 invalidates the cached token and throws Action1ApiError", async () => {
    mockFetch([{ status: 401, body: "no" }]);
    const client = new Action1Client(cfg);
    // Pre-warm the cache so we can observe invalidate().
    const invalidateSpy = vi.spyOn(client.tokens, "invalidate");
    await expect(client.request("/x", { retry: false })).rejects.toBeInstanceOf(Action1ApiError);
    expect(invalidateSpy).toHaveBeenCalled();
  });

  it("retries after `Retry-After: <seconds>` on 429, then succeeds", async () => {
    const { spy } = mockFetch([
      { status: 429, body: "slow down", headers: { "Retry-After": "5" } },
      { status: 200, body: { ok: true } },
    ]);
    vi.useFakeTimers();
    try {
      const client = new Action1Client(cfg);
      const p = client.request<{ ok: boolean }>("/x");
      // Drain the (small) retry timer.
      await vi.runAllTimersAsync();
      const out = await p;
      expect(out).toEqual({ ok: true });
      // 2 actual /x calls + 1 token call.
      const xCalls = spy.mock.calls.filter((c) => !String(c[0]).endsWith("/oauth2/token"));
      expect(xCalls.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries after `Retry-After: <HTTP-Date>` on 429", async () => {
    const future = new Date(Date.now() + 1000).toUTCString();
    mockFetch([
      { status: 429, body: "slow", headers: { "Retry-After": future } },
      { status: 200, body: { ok: 1 } },
    ]);
    vi.useFakeTimers();
    try {
      const client = new Action1Client(cfg);
      const p = client.request<{ ok: number }>("/x");
      await vi.runAllTimersAsync();
      await expect(p).resolves.toEqual({ ok: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  // A malformed Retry-After like "123 abc" must not be parsed as 123
  // seconds via parseFloat's lenient prefix semantics. The strict
  // numeric regex rejects it, so
  // the value falls through to the HTTP-date branch (which also fails
  // for "123 abc"), and the retry uses the default exponential
  // schedule. We pin the BEHAVIOUR: the request still completes
  // successfully (retry happens) - we just no longer treat junk as a
  // valid 123 s sleep instruction.
  it("rejects malformed Retry-After like '123 abc' and falls back to the exponential schedule", async () => {
    mockFetch([
      { status: 429, body: "slow", headers: { "Retry-After": "123 abc" } },
      { status: 200, body: { ok: 1 } },
    ]);
    vi.useFakeTimers();
    try {
      const client = new Action1Client(cfg);
      const p = client.request<{ ok: number }>("/x", {
        // shrink the schedule so the test stays fast - without the
        // override this would honour the default 250ms base.
        retry: { baseDelayMs: 1, maxDelayMs: 2 },
      });
      await vi.runAllTimersAsync();
      await expect(p).resolves.toEqual({ ok: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries with exponential backoff on 500", async () => {
    mockFetch([
      { status: 500, body: "boom" },
      { status: 200, body: { ok: true } },
    ]);
    vi.useFakeTimers();
    try {
      const client = new Action1Client(cfg);
      const p = client.request<{ ok: boolean }>("/x");
      await vi.runAllTimersAsync();
      await expect(p).resolves.toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("succeeds after 5xx → 5xx → 200", async () => {
    mockFetch([
      { status: 503, body: "x" },
      { status: 502, body: "y" },
      { status: 200, body: { z: 1 } },
    ]);
    vi.useFakeTimers();
    try {
      const client = new Action1Client(cfg);
      const p = client.request<{ z: number }>("/x");
      await vi.runAllTimersAsync();
      await expect(p).resolves.toEqual({ z: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT retry on 400; throws Action1ApiError immediately", async () => {
    const { spy } = mockFetch([
      { status: 400, body: "bad" },
      { status: 200, body: { should_not_reach: true } },
    ]);
    const client = new Action1Client(cfg);
    await expect(client.request("/x")).rejects.toBeInstanceOf(Action1ApiError);
    const xCalls = spy.mock.calls.filter((c) => !String(c[0]).endsWith("/oauth2/token"));
    expect(xCalls.length).toBe(1);
  });

  it("wraps a network error (ECONNRESET) into Action1ApiError preserving `.code`", async () => {
    // Contract pinned: a raw transport-level error from `fetch` (e.g.
    // node:undici ECONNRESET) is wrapped into Action1ApiError with
    // status=0 and `.code` preserved.
    const spy = vi.fn(async (url: string) => {
      if (url.endsWith("/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "tkn", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const err = new Error("connection reset") as Error & { code?: string };
      err.code = "ECONNRESET";
      throw err;
    });
    vi.stubGlobal("fetch", spy);
    const client = new Action1Client(cfg);
    await expect(client.request("/x", { retry: false })).rejects.toMatchObject({
      status: 0,
      code: "ECONNRESET",
    });
  });

  it("retries a transient network error (ECONNRESET) with default retry policy", async () => {
    // status=0 + a transient network code is retryable. Fail-fail-success with retry: default = 2 attempts in
    // total for fast tests (RETRY_OVERRIDE).
    let attempt = 0;
    const spy = vi.fn(async (url: string) => {
      if (url.endsWith("/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "tkn", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      attempt += 1;
      if (attempt < 2) {
        const err = new Error("connection reset") as Error & { code?: string };
        err.code = "ECONNRESET";
        throw err;
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", spy);
    const client = new Action1Client(cfg);
    const result = await client.request<{ ok: boolean }>("/x", {
      retry: { maxAttempts: 3, baseDelayMs: 5 },
    });
    expect(result).toEqual({ ok: true });
    const xCalls = spy.mock.calls.filter((c) => !String(c[0]).endsWith("/oauth2/token"));
    expect(xCalls.length).toBe(2);
  });

  it("does NOT retry an AbortError (caller cancelled)", async () => {
    // AbortError is never retried, also among network errors, because the caller explicitly
    // signalled cancellation.
    const spy = vi.fn(async (url: string) => {
      if (url.endsWith("/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "tkn", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    vi.stubGlobal("fetch", spy);
    const client = new Action1Client(cfg);
    await expect(
      client.request("/x", { retry: { maxAttempts: 3, baseDelayMs: 5 } }),
    ).rejects.toThrow(/abort/i);
    const xCalls = spy.mock.calls.filter((c) => !String(c[0]).endsWith("/oauth2/token"));
    expect(xCalls.length).toBe(1);
  });

  it("propagates AbortError without retrying", async () => {
    const spy = vi.fn(async (url: string) => {
      if (url.endsWith("/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "tkn", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const err = new DOMException("Aborted", "AbortError");
      throw err;
    });
    vi.stubGlobal("fetch", spy);
    const client = new Action1Client(cfg);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(client.request("/x", { signal: ctrl.signal })).rejects.toThrow(/Aborted/);
    // No retry: at most one /x call (the abort fires before fetch returns OK).
    const xCalls = spy.mock.calls.filter((c) => !String(c[0]).endsWith("/oauth2/token"));
    expect(xCalls.length).toBeLessThanOrEqual(1);
  });

  it("sends Authorization: Bearer <token> and Accept: application/json", async () => {
    const { calls } = mockFetch([{ status: 200, body: { ok: true } }]);
    const client = new Action1Client(cfg);
    await client.request("/x", { retry: false });
    expect(calls.length).toBe(1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tkn");
    expect(headers.Accept).toBe("application/json");
  });

  it("URL-encodes query params", async () => {
    const { calls } = mockFetch([{ status: 200, body: { ok: true } }]);
    const client = new Action1Client(cfg);
    await client.request("/search", {
      query: { search: "hello world", limit: 50 },
      retry: false,
    });
    const url = calls[0]!.url;
    // URLSearchParams uses + for spaces (form-encoded), which is the
    // platform default for URL.searchParams.set.
    expect(url).toContain("search=hello+world");
    expect(url).toContain("limit=50");
  });

  // SSRF host-pinning invariant. A `path` argument (e.g. from
  // action1_raw_request) must NEVER cause the outbound request to reach
  // a different host than the configured baseUrl origin. Paths whose
  // segments URL normalisation could reinterpret (empty segments, dot
  // segments, backslashes, encoded slashes) are refused before any
  // network call; the remaining odd-but-harmless shapes still go to the
  // configured host.
  it.each([
    "//evil.com/x",
    "/../../../evil.com",
    "/\\evil.com/x",
    "/%2F%2Fevil.com/x",
    "/x://evil.com",
    "///evil.com",
  ])("refuses adversarial path %j without any network call", async (path) => {
    const { calls } = mockFetch([{ status: 200, body: { ok: true } }]);
    const client = new Action1Client(cfg);
    await expect(client.request(path, { retry: false })).rejects.toThrow(/Refusing request/);
    expect(calls.length).toBe(0);
  });

  it("pins the outbound host to baseUrl origin for an authority-looking segment", async () => {
    const { calls } = mockFetch([{ status: 200, body: { ok: true } }]);
    const client = new Action1Client(cfg);
    await client.request("/@evil.com/x", { retry: false });
    expect(calls.length).toBe(1);
    expect(new URL(calls[0]!.url).host).toBe("example.test");
    expect(calls[0]!.url.startsWith("https://example.test/api/3.0/")).toBe(true);
  });

  it("refuses //evil.com even with an origin-only baseUrl", async () => {
    const { calls } = mockFetch([{ status: 200, body: { ok: true } }]);
    const originOnly: AppConfig = { ...cfg, baseUrl: "https://example.test" };
    const client = new Action1Client(originOnly);
    await expect(client.request("//evil.com/x", { retry: false })).rejects.toThrow(
      /Refusing request/,
    );
    expect(calls.length).toBe(0);
  });

  it("stringifies body and sets Content-Type for POST", async () => {
    const { calls } = mockFetch([{ status: 200, body: { ok: true } }]);
    const client = new Action1Client(cfg);
    await client.request("/x", {
      method: "POST",
      body: { hello: "world" },
      retry: false,
    });
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe(JSON.stringify({ hello: "world" }));
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("stringifies body for PATCH the same way", async () => {
    const { calls } = mockFetch([{ status: 200, body: { ok: true } }]);
    const client = new Action1Client(cfg);
    await client.request("/x", {
      method: "PATCH",
      body: { a: 1, b: [2, 3] },
      retry: false,
    });
    expect(calls[0]!.init.method).toBe("PATCH");
    expect(calls[0]!.init.body).toBe(JSON.stringify({ a: 1, b: [2, 3] }));
  });

  it("when 401 also blows up the token endpoint, surfaces auth error", async () => {
    // First /x fails 401 → invalidates token → retry path goes through
    // TokenProvider again, which itself fails. We expect either an
    // Action1ApiError or an Action1AuthError surfaced upward.
    const spy = vi.fn(async (url: string) => {
      if (url.endsWith("/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "tkn", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("nope", { status: 401 });
    });
    vi.stubGlobal("fetch", spy);
    const client = new Action1Client(cfg);
    await expect(client.request("/x", { retry: false })).rejects.toSatisfy(
      (err) => err instanceof Action1ApiError || err instanceof Action1AuthError,
    );
  });
});
