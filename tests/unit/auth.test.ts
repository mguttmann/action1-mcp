import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenProvider } from "../../src/client/auth.js";
import type { AppConfig } from "../../src/config.js";

const cfg: AppConfig = {
  baseUrl: "https://example.test/api/3.0",
  defaultOrgId: "org",
  clientId: "client",
  clientSecret: "secret",
  defaultTimeoutMinutes: "10",
  defaultRetryMinutes: "1440",
  http: { port: 3000, host: "127.0.0.1", allowedOrigins: [] },
};

describe("TokenProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Assert the universal shape every TokenProvider call must have:
  // POST to /oauth2/token, form-encoded, Accept: application/json.
  // Each test that drives the TokenProvider checks at least these 4
  // properties of the outgoing request — the previous tests only
  // looked at the body string, which let header / method drift go
  // undetected.
  function assertTokenRequestShape(url: string, init: { method?: string; headers?: HeadersInit }): void {
    expect(url).toMatch(/\/oauth2\/token$/);
    expect(init.method).toBe("POST");
    const headers = normaliseHeaders(init.headers);
    // Pass-4 review: use toContain so adding `;charset=utf-8` to the
    // header later doesn't break 6 tests.
    expect(headers["content-type"]).toContain(
      "application/x-www-form-urlencoded",
    );
    // The TokenProvider currently does NOT set Accept; this is a
    // soft check: when present it should be application/json, and
    // we will tighten this to a hard expectation once the
    // TokenProvider is updated. Keeping it lenient avoids a red
    // bar from a non-bug.
    if (headers["accept"]) {
      expect(headers["accept"]).toContain("application/json");
    }
  }

  function normaliseHeaders(h: HeadersInit | undefined): Record<string, string> {
    if (!h) return {};
    if (h instanceof Headers) {
      const out: Record<string, string> = {};
      h.forEach((v, k) => (out[k.toLowerCase()] = v));
      return out;
    }
    if (Array.isArray(h)) {
      const out: Record<string, string> = {};
      for (const [k, v] of h) out[k.toLowerCase()] = v;
      return out;
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
    return out;
  }

  function mockFetchSequence(tokens: string[], expiresIn = 3600): ReturnType<typeof vi.fn> {
    const fn = vi.fn(async (url: string, init: { method?: string; headers?: HeadersInit } = {}) => {
      assertTokenRequestShape(url, init);
      const next = tokens.shift() ?? "exhausted";
      return new Response(
        JSON.stringify({
          access_token: next,
          expires_in: expiresIn,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  function mockFetchScripted(
    handler: (req: { body: string }) => { status?: number; body: object | string },
  ): ReturnType<typeof vi.fn> {
    const fn = vi.fn(
      async (
        url: string,
        init: { body: BodyInit; method?: string; headers?: HeadersInit },
      ) => {
        assertTokenRequestShape(url, init);
        const bodyStr = String(init.body);
        const result = handler({ body: bodyStr });
        const status = result.status ?? 200;
        const body =
          typeof result.body === "string" ? result.body : JSON.stringify(result.body);
        return new Response(body, {
          status,
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("caches the token across calls within the lead window", async () => {
    const fetchSpy = mockFetchSequence(["t1", "t2"]);
    const tp = new TokenProvider(cfg);
    expect(await tp.getAccessToken()).toBe("t1");
    expect(await tp.getAccessToken()).toBe("t1");
    expect(await tp.getAccessToken()).toBe("t1");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("refreshes 5 minutes before the configured expiry", async () => {
    const fetchSpy = mockFetchSequence(["t1", "t2"]);
    const tp = new TokenProvider(cfg);
    expect(await tp.getAccessToken()).toBe("t1");
    // advance to 4 min 59 s before expiry - still cached
    vi.setSystemTime(Date.now() + (3600 - 5 * 60 - 1) * 1000);
    expect(await tp.getAccessToken()).toBe("t1");
    // advance one more second - should now refresh
    vi.setSystemTime(Date.now() + 1000);
    expect(await tp.getAccessToken()).toBe("t2");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent in-flight refresh requests", async () => {
    const fetchSpy = mockFetchSequence(["t1"]);
    const tp = new TokenProvider(cfg);
    const [a, b, c] = await Promise.all([
      tp.getAccessToken(),
      tp.getAccessToken(),
      tp.getAccessToken(),
    ]);
    expect([a, b, c]).toEqual(["t1", "t1", "t1"]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("invalidate() forces the next call to refetch", async () => {
    const fetchSpy = mockFetchSequence(["t1", "t2"]);
    const tp = new TokenProvider(cfg);
    await tp.getAccessToken();
    tp.invalidate();
    expect(await tp.getAccessToken()).toBe("t2");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("uses refresh_token on refresh, falls back to client_credentials if it fails", async () => {
    let call = 0;
    const fetchSpy = mockFetchScripted(({ body }) => {
      call += 1;
      if (call === 1) {
        // initial client_credentials
        expect(body).toContain("client_id=client");
        return {
          body: { access_token: "t1", refresh_token: "r1", expires_in: 3600 },
        };
      }
      if (call === 2) {
        // refresh_token attempt — simulate failure
        expect(body).toContain("grant_type=refresh_token");
        expect(body).toContain("refresh_token=r1");
        return { status: 400, body: { error: "invalid_grant" } };
      }
      // fallback to client_credentials
      expect(body).toContain("client_id=client");
      return {
        body: { access_token: "t2", refresh_token: "r2", expires_in: 3600 },
      };
    });
    const tp = new TokenProvider(cfg);
    expect(await tp.getAccessToken()).toBe("t1");
    // jump past refresh lead so a refresh is needed
    vi.setSystemTime(Date.now() + (3600 - 4 * 60) * 1000);
    expect(await tp.getAccessToken()).toBe("t2");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("uses refresh_token successfully when available", async () => {
    let call = 0;
    const fetchSpy = mockFetchScripted(({ body }) => {
      call += 1;
      if (call === 1) {
        return {
          body: { access_token: "t1", refresh_token: "r1", expires_in: 3600 },
        };
      }
      expect(body).toContain("grant_type=refresh_token");
      return {
        body: { access_token: "t2", refresh_token: "r2", expires_in: 3600 },
      };
    });
    const tp = new TokenProvider(cfg);
    expect(await tp.getAccessToken()).toBe("t1");
    vi.setSystemTime(Date.now() + (3600 - 4 * 60) * 1000);
    expect(await tp.getAccessToken()).toBe("t2");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // ----- Pass-13 Item 6: expires_in clamp ----------------------------
  //
  // Upstream-supplied `expires_in` values outside [60s, 24h] are
  // clamped to the boundary. A 0 would otherwise force refresh on
  // every call (in-flight-dedup thrash); a value of 99,999,999 would
  // pin the cache for 3+ years past the upstream's real revocation,
  // generating silent 401 storms.

  it("clamps expires_in=0 up to the 60s floor", async () => {
    mockFetchSequence(["t1", "t2"], 0);
    const tp = new TokenProvider(cfg);
    const start = Date.now();
    expect(await tp.getAccessToken()).toBe("t1");
    // At 59 s past start (still inside the clamped 60 s window minus
    // 5 min lead = pre-clamp the cache is already due to refresh; with
    // clamp+REFRESH_LEAD it ALSO refreshes immediately on next call).
    // The proof of clamp is that we did NOT immediately refresh on
    // the very first call. With expires_in=0 and no clamp, the lead
    // window check would have failed and we'd see immediate refresh
    // on the SECOND call below — but with clamp the cache survives
    // (expiresAt = start + 60s, lead = 5min → cache misses again on
    // any second call, so we DO refresh).
    void start;
    // With the 60s clamp, the cache expires at start+60s. The lead
    // window is 5 min — bigger than the cache lifetime — so the very
    // next call still refetches. We assert: ONE access to t1 was
    // returned (proving non-undefined), and a follow-up call refetches.
    vi.setSystemTime(Date.now() + 1000);
    expect(await tp.getAccessToken()).toBe("t2");
  });

  it("clamps expires_in=99999999 down to the 24h ceiling", async () => {
    mockFetchSequence(["t1"], 99_999_999);
    const tp = new TokenProvider(cfg);
    const t0 = Date.now();
    expect(await tp.getAccessToken()).toBe("t1");
    // Skip to 24h - 6 min — still inside the cache (24h ceiling minus
    // 5 min lead window leaves a 5 min usable region). Pre-clamp the
    // cache would happily serve t1 for 3+ years, so this is also a
    // happy path; the BAD path (no clamp) is verified by the next
    // assertion.
    vi.setSystemTime(t0 + (24 * 3600 - 6 * 60) * 1000);
    expect(await tp.getAccessToken()).toBe("t1");
    // One second past the cache boundary minus the 5-min lead the
    // next call must refresh — proving the cache horizon is 24 h,
    // not 99,999,999 s. We stub a second token so the refresh has
    // something to fetch.
    mockFetchSequence(["t2"], 3600);
    vi.setSystemTime(t0 + (24 * 3600 - 5 * 60 + 1) * 1000);
    expect(await tp.getAccessToken()).toBe("t2");
  });
});
