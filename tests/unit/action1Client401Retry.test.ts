import { afterEach, describe, expect, it, vi } from "vitest";
import { Action1Client } from "../../src/client/action1Client.js";
import { Action1ApiError } from "../../src/client/errors.js";
import type { AppConfig } from "../../src/config.js";

// Finding 5.4 — when a request races with a stale upstream token,
// the client must invalidate the cache and re-issue the request
// exactly once before giving up.

const cfg: AppConfig = {
  baseUrl: "https://example.test/api/3.0",
  defaultOrgId: "00000000-0000-0000-0000-000000000001",
  clientId: "client",
  clientSecret: "secret",
  defaultTimeoutMinutes: "10",
  defaultRetryMinutes: "1440",
  http: { port: 3000, host: "127.0.0.1", allowedOrigins: [], token: undefined },
};

interface ScriptedResponse {
  status?: number;
  body?: object | string;
}

function makeMockFetch(responses: ScriptedResponse[]) {
  const queue = [...responses];
  const calls: { url: string; init: RequestInit }[] = [];
  const tokens = ["tok-A", "tok-B", "tok-C", "tok-D"];
  const spy = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/oauth2/token")) {
      const next = tokens.shift() ?? "tok-X";
      return new Response(
        JSON.stringify({ access_token: next, expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    calls.push({ url, init });
    const r = queue.shift() ?? { status: 500, body: "exhausted" };
    const status = r.status ?? 200;
    const body =
      r.body === undefined
        ? null
        : typeof r.body === "string"
          ? r.body
          : JSON.stringify(r.body);
    return new Response(body, {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", spy);
  return { spy, calls };
}

describe("Action1Client — auto-retry on 401 (finding 5.4)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("on 401 invalidates the token and re-issues the request once with the refreshed token", async () => {
    const { calls } = makeMockFetch([
      { status: 401, body: "stale" },
      { status: 200, body: { ok: true } },
    ]);
    const client = new Action1Client(cfg);
    const invalidateSpy = vi.spyOn(client.tokens, "invalidate");

    const out = await client.request<{ ok: boolean }>("/x", { retry: false });

    expect(out).toEqual({ ok: true });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    // Both /x calls present.
    expect(calls[0]!.url).toMatch(/\/x$/);
    expect(calls[1]!.url).toMatch(/\/x$/);
    // Second call carries the *refreshed* token, not the stale one.
    const h0 = calls[0]!.init.headers as Record<string, string>;
    const h1 = calls[1]!.init.headers as Record<string, string>;
    expect(h0.Authorization).toBe("Bearer tok-A");
    expect(h1.Authorization).toBe("Bearer tok-B");
  });

  it("does not loop endlessly when the retry also returns 401", async () => {
    // Two 401s in a row: first triggers the auto-retry, second
    // surfaces the auth error to the caller.
    const { calls } = makeMockFetch([
      { status: 401, body: "stale-1" },
      { status: 401, body: "stale-2" },
    ]);
    const client = new Action1Client(cfg);

    await expect(client.request("/x", { retry: false })).rejects.toBeInstanceOf(
      Action1ApiError,
    );
    // Exactly 2 calls — no third attempt, no infinite loop.
    expect(calls).toHaveLength(2);
  });
});
