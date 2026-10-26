import { afterEach, describe, expect, it, vi } from "vitest";
import { Action1Client, assertSafeApiPath } from "../../src/client/action1Client.js";
import { Action1ApiError, Action1TimeoutError } from "../../src/client/errors.js";
import type { AppConfig } from "../../src/config.js";

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
  requestTimeoutMs: 60_000,
  tokenTimeoutMs: 15_000,
  http: {
    port: 0,
    host: "127.0.0.1",
    allowedOrigins: [],
    allowedHosts: [],
    token: undefined,
    allowNoAuth: false,
    trustProxy: false,
  },
};

const FAST = { baseDelayMs: 1, maxDelayMs: 2 };

type Step = { status: number; body?: string; headers?: Record<string, string> } | Error;

function tokenResponse(): Response {
  return new Response(JSON.stringify({ access_token: "tkn", expires_in: 3600 }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Scripted upstream: token endpoint always answers, API calls consume `steps`. */
function upstream(steps: Step[]): { calls: { method: string; url: string }[] } {
  const calls: { method: string; url: string }[] = [];
  const queue = [...steps];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith("/oauth2/token")) return tokenResponse();
      calls.push({ method: init.method ?? "GET", url });
      const step = queue.shift() ?? { status: 200, body: "{}" };
      if (step instanceof Error) throw step;
      return new Response(step.body ?? "{}", {
        status: step.status,
        headers: { "Content-Type": "application/json", ...(step.headers ?? {}) },
      });
    }),
  );
  return { calls };
}

function netError(code: string): Error {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(code), { code }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("retry policy by method", () => {
  it.each(["POST", "PATCH", "PUT", "DELETE"] as const)(
    "%s is sent exactly once on 502 and the error says it was not retried",
    async (method) => {
      const { calls } = upstream([{ status: 502 }, { status: 200 }]);
      const client = new Action1Client(cfg);
      const err = await client
        .request("/x", { method, body: method === "DELETE" ? undefined : {}, retry: FAST })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Action1ApiError);
      expect((err as Action1ApiError).status).toBe(502);
      expect((err as Error).message).toMatch(/not retried/i);
      expect(calls).toHaveLength(1);
    },
  );

  it("POST is sent exactly once on ECONNRESET (may have reached the server)", async () => {
    const { calls } = upstream([netError("ECONNRESET"), { status: 200 }]);
    const client = new Action1Client(cfg);
    await expect(client.request("/x", { method: "POST", body: {}, retry: FAST })).rejects.toThrow(
      /not retried/i,
    );
    expect(calls).toHaveLength(1);
  });

  it.each(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"])(
    "POST is retried on %s (failed before the request was sent)",
    async (code) => {
      const { calls } = upstream([netError(code), { status: 200, body: '{"ok":true}' }]);
      const client = new Action1Client(cfg);
      const out = await client.request<{ ok: boolean }>("/x", {
        method: "POST",
        body: {},
        retry: FAST,
      });
      expect(out.ok).toBe(true);
      expect(calls).toHaveLength(2);
    },
  );

  it("POST is retried on 429 (rate limiter rejected it before processing)", async () => {
    const { calls } = upstream([
      { status: 429, headers: { "Retry-After": "0" } },
      { status: 200, body: '{"ok":true}' },
    ]);
    const client = new Action1Client(cfg);
    const out = await client.request<{ ok: boolean }>("/x", {
      method: "POST",
      body: {},
      retry: FAST,
    });
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("GET keeps retrying 5xx and ECONNRESET", async () => {
    const { calls } = upstream([
      { status: 502 },
      netError("ECONNRESET"),
      { status: 200, body: '{"ok":true}' },
    ]);
    const client = new Action1Client(cfg);
    const out = await client.request<{ ok: boolean }>("/x", { retry: FAST });
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it("GET retries undici header/body timeouts", async () => {
    const { calls } = upstream([
      netError("UND_ERR_HEADERS_TIMEOUT"),
      netError("UND_ERR_BODY_TIMEOUT"),
      { status: 200, body: '{"ok":true}' },
    ]);
    const client = new Action1Client(cfg);
    await client.request("/x", { retry: FAST });
    expect(calls).toHaveLength(3);
  });

  it("retry:false still disables retries for GET", async () => {
    const { calls } = upstream([{ status: 502 }, { status: 200 }]);
    const client = new Action1Client(cfg);
    await expect(client.request("/x", { retry: false })).rejects.toBeInstanceOf(Action1ApiError);
    expect(calls).toHaveLength(1);
  });
});

describe("request timeout", () => {
  function hangingFetch(): { apiCalls: () => number } {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit = {}) => {
        if (url.endsWith("/oauth2/token")) return Promise.resolve(tokenResponse());
        n += 1;
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error), {
            once: true,
          });
        });
      }),
    );
    return { apiCalls: () => n };
  }

  it("aborts a hanging upstream after ACTION1_REQUEST_TIMEOUT_MS with Action1TimeoutError", async () => {
    const { apiCalls } = hangingFetch();
    const client = new Action1Client({ ...cfg, requestTimeoutMs: 50 });
    const started = Date.now();
    const err = await client.request("/x", { retry: FAST }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Action1TimeoutError);
    expect((err as Error).message).toMatch(/timed out after 50 ms/);
    expect((err as Error).message).toContain("ACTION1_REQUEST_TIMEOUT_MS");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(apiCalls()).toBe(1);
  });

  it("a timed-out POST warns that it may have been processed", async () => {
    hangingFetch();
    const client = new Action1Client({ ...cfg, requestTimeoutMs: 50 });
    await expect(client.request("/x", { method: "POST", body: {} })).rejects.toThrow(
      /may already have been processed/,
    );
  });

  it("caller cancellation still surfaces as AbortError, not as a timeout", async () => {
    hangingFetch();
    const client = new Action1Client({ ...cfg, requestTimeoutMs: 60_000 });
    const ac = new AbortController();
    const p = client.request("/x", { signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    const err = await p.catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(Action1TimeoutError);
    expect((err as Error).name).toBe("AbortError");
  });

  it("does not wait on a hanging token endpoint past the request timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit = {}) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error), {
              once: true,
            });
          }),
      ),
    );
    const client = new Action1Client({ ...cfg, requestTimeoutMs: 50, tokenTimeoutMs: 10_000 });
    const started = Date.now();
    await expect(client.request("/x")).rejects.toBeInstanceOf(Action1TimeoutError);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("path safety", () => {
  it.each([
    ["/roles/R1/users/..", "dot segment"],
    ["/roles/R1/users/.", "dot segment"],
    ["/roles/R1/users/%2e%2e", "encoded dot segment"],
    ["/roles/R1/users/.%2E", "mixed encoded dot segment"],
    ["/../x", "leading dot segment"],
    ["/roles//users", "empty segment"],
    ["/roles/R1/", "trailing empty segment"],
    ["/roles/a%2Fb", "encoded slash in a segment"],
    ["/roles/a\\..\\b", "backslash"],
    ["/roles/R1/users/.\n.", "newline that URL parsing would strip"],
    ["//evil.com/x", "empty segment"],
  ])("rejects %j (%s) without any network call", async (path) => {
    const { calls } = upstream([{ status: 200 }]);
    const client = new Action1Client(cfg);
    await expect(client.request(path, { retry: false })).rejects.toThrow(/Refusing request/);
    expect(() => assertSafeApiPath(path)).toThrow(/Refusing request/);
    expect(calls).toHaveLength(0);
  });

  it.each(["/x/a.b", "/x/..a", "/x/v1.2.3", "/endpoints/managed/org?fields=*", "/@evil.com/x"])(
    "accepts the legitimate path %j and keeps it under the API base",
    async (path) => {
      const { calls } = upstream([{ status: 200 }]);
      const client = new Action1Client(cfg);
      await client.request(path, { retry: false });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url.startsWith("https://example.test/api/3.0/")).toBe(true);
    },
  );
});
