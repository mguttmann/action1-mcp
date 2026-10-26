import { Agent, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config.js";
import { createHttpApp, type HttpAppDeps } from "../../src/http.js";
import { log } from "../../src/utils/logger.js";

// Long-running HTTP mode keeps per-peer state in memory: the rate-limit
// buckets and the throttle of rejection log lines. Both maps are capped
// (src/http.ts, oldest entry evicted first), so a stream of unique peer
// addresses cannot grow the process without bound. This test drives the
// real Express app with more unique peers than the cap and checks the
// eviction from the outside: the first peer's spent bucket and its
// throttled log entry are gone afterwards. The OAuth token cache is the
// other long-lived state; it holds one token for any number of calls.
//
// The behaviour is asserted instead of RSS: process memory is noisy
// under a test runner, an evicted entry is not.

// The cap documented in src/http.ts for both maps.
const MAP_CAP = 10_000;
const TOKEN = "test-token-0123456789abcdef";

function makeCfg(): AppConfig {
  return {
    baseUrl: "https://app.eu.action1.test/api/3.0",
    defaultOrgId: "00000000-0000-0000-0000-000000000001",
    clientId: "client-id-test",
    clientSecret: "client-secret-test",
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
      port: 0,
      host: "127.0.0.1",
      allowedOrigins: [],
      allowedHosts: [],
      token: TOKEN,
      allowNoAuth: false,
      // Peer address from X-Forwarded-For, so one client can stand in
      // for many peers.
      trustProxy: true,
    },
  };
}

let live: Server | undefined;
// Keep-alive sockets let one client stand in for thousands of peers
// without exhausting ephemeral ports. Only the client closes them: the
// test server's keep-alive timeout is off (see start()), so a socket
// that sat idle while a slow batch finished is never closed by the
// server at the moment the agent reuses it (ECONNRESET on a loaded
// machine). Each test gets its own agent, destroyed afterwards.
let agent = new Agent({ keepAlive: true, maxSockets: 32 });

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  agent.destroy();
  agent = new Agent({ keepAlive: true, maxSockets: 32 });
  if (live) {
    const s = live;
    live = undefined;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

async function start(deps: HttpAppDeps = {}): Promise<number> {
  const app = createHttpApp(makeCfg(), deps);
  live = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  // 0 disables the server-side idle timeout (default 5 s); afterEach
  // closes every connection explicitly.
  live.keepAliveTimeout = 0;
  return (live.address() as AddressInfo).port;
}

function post(port: number, headers: Record<string, string>, body = "{}"): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method: "POST", path: "/mcp", agent, headers },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** Unique documentation-range peer address number `n`. */
function peer(n: number): string {
  return `198.18.${Math.floor(n / 250)}.${(n % 250) + 1}`;
}

describe("bounded per-peer state in HTTP mode", () => {
  it("evicts the oldest rate-limit bucket and log throttle entry beyond the cap", async () => {
    const audit = vi.spyOn(log, "audit").mockImplementation(() => undefined);
    const port = await start({ rateLimit: { max: 1, windowMs: 60_000 } });
    // A foreign Host is rejected right after the rate limit, without auth.
    const from = (ip: string) => ({ host: "rebind.example", "x-forwarded-for": ip });
    const first = peer(0);
    const hostRejectedFor = (ip: string) =>
      audit.mock.calls.filter(
        ([event, meta]) =>
          event === "http_host_rejected" && (meta as { remote_ip?: string }).remote_ip === ip,
      ).length;

    expect(await post(port, from(first))).toBe(403);
    expect(await post(port, from(first))).toBe(429);
    expect(hostRejectedFor(first)).toBe(1);

    // More unique peers than either map holds, sent in parallel batches.
    const others = Array.from({ length: MAP_CAP }, (_, i) => peer(i + 1));
    for (let i = 0; i < others.length; i += 200) {
      const statuses = await Promise.all(
        others.slice(i, i + 200).map((ip) => post(port, from(ip))),
      );
      expect(statuses.every((s) => s === 403)).toBe(true);
    }

    // The first peer's spent bucket was evicted: a fresh window again.
    expect(await post(port, from(first))).toBe(403);
    // Its throttle entry was evicted too: the rejection is logged again
    // instead of being counted as suppressed.
    expect(hostRejectedFor(first)).toBe(2);
  }, 120_000);

  it("shares one OAuth token across many HTTP tool calls", async () => {
    let tokenRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/oauth2/token")) {
          tokenRequests += 1;
          return Response.json({ access_token: "tkn", expires_in: 3600 });
        }
        return Response.json({ id: "u1", type: "User" });
      }),
    );
    const port = await start({ rateLimit: { max: 10_000, windowMs: 60_000 } });
    const call = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "action1_get_me", arguments: {} },
    });
    const headers = {
      host: `127.0.0.1:${port}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
      authorization: `Bearer ${TOKEN}`,
    };
    for (let i = 0; i < 5; i++) {
      const statuses = await Promise.all(
        Array.from({ length: 20 }, () => post(port, headers, call)),
      );
      expect(statuses.every((s) => s === 200)).toBe(true);
    }
    expect(tokenRequests).toBe(1);
  }, 60_000);
});
