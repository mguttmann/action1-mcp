import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../../src/config.js";

// Client cancellation (notifications/cancelled, which the SDK turns into
// an aborted ctx.mcpReq.signal) must reach every upstream call, not only
// the tools that pass the signal by hand. Driven end to end through an
// MCP client over an in-memory transport with a slow fake upstream.

const ORG = "00000000-0000-0000-0000-000000000001";
const PAGES = 40;
const PAGE_DELAY_MS = 25;

let SERVER: ReturnType<typeof import("../../src/server.js").buildServer>;
let CLIENT: import("@modelcontextprotocol/client").Client;

beforeAll(async () => {
  process.env.ACTION1_BASE_URL = "https://app.eu.action1.test/api/3.0";
  process.env.ACTION1_CLIENT_ID = "client-id-test";
  process.env.ACTION1_CLIENT_SECRET = "client-secret-test";
  process.env.ACTION1_ORG_ID = ORG;
  resetConfigCache();
  const { buildServer } = await import("../../src/server.js");
  const { Client } = await import("@modelcontextprotocol/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/server");
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  SERVER = buildServer();
  await SERVER.server.connect(serverTx);
  CLIENT = new Client({ name: "cancel-test", version: "0.0.0" }, { capabilities: {} });
  await CLIENT.connect(clientTx);
}, 30_000);

afterAll(async () => {
  if (CLIENT) await CLIENT.close();
  if (SERVER?.server) await SERVER.server.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Upstream {
  /** Upstream API requests started (token requests excluded). */
  started: number;
  /** Upstream API requests whose fetch signal was aborted. */
  aborted: number;
}

/**
 * Slow paginated upstream: every list path has PAGES full pages, each
 * answered after PAGE_DELAY_MS unless the fetch signal aborts first.
 */
function slowUpstream(): Upstream {
  const state: Upstream = { started: 0, aborted: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith("/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "tkn", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      state.started += 1;
      const u = new URL(url);
      const limit = Number(u.searchParams.get("limit") ?? "50");
      const from = Number(u.searchParams.get("from") ?? "0");
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          clearTimeout(timer);
          state.aborted += 1;
          reject(new DOMException("Aborted", "AbortError"));
        };
        const timer = setTimeout(() => {
          init.signal?.removeEventListener("abort", onAbort);
          resolve();
        }, PAGE_DELAY_MS);
        init.signal?.addEventListener("abort", onAbort, { once: true });
      });
      const total = PAGES * limit;
      const items = Array.from({ length: Math.min(limit, Math.max(0, total - from)) }, (_, i) => ({
        id: `id-${from + i}`,
        name: `host-${from + i}`,
        status: "Connected",
      }));
      return new Response(JSON.stringify({ items, total_items: total }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return state;
}

async function cancelAfter<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<void> {
  const ac = new AbortController();
  const p = run(ac.signal).catch(() => undefined);
  await sleep(ms);
  ac.abort();
  await p;
}

describe("cancellation reaches the upstream calls of curated tools", () => {
  it("action1_endpoints_summary stops walking pages after the client cancels", async () => {
    const up = slowUpstream();
    await cancelAfter(PAGE_DELAY_MS * 3, (signal) =>
      CLIENT.callTool({ name: "action1_endpoints_summary", arguments: {} }, { signal }),
    );
    // Give a runaway walk time to show itself.
    await sleep(PAGE_DELAY_MS * 8);
    const afterCancel = up.started;
    await sleep(PAGE_DELAY_MS * 4);
    expect(up.started).toBe(afterCancel);
    expect(up.started).toBeLessThan(PAGES);
    expect(up.aborted).toBe(1);
  });

  it("a single-request curated tool aborts its in-flight fetch", async () => {
    const up = slowUpstream();
    await cancelAfter(PAGE_DELAY_MS / 5, (signal) =>
      CLIENT.callTool(
        {
          name: "action1_get_endpoint",
          arguments: { endpoint_id: "00000000-0000-4000-8000-0000000000e1" },
        },
        { signal },
      ),
    );
    await sleep(PAGE_DELAY_MS * 2);
    expect(up.started).toBe(1);
    expect(up.aborted).toBe(1);
  });

  it("a resource read stops walking pages after the client cancels", async () => {
    const up = slowUpstream();
    await cancelAfter(PAGE_DELAY_MS * 3, (signal) =>
      CLIENT.readResource({ uri: "action1://endpoints/default" }, { signal }),
    );
    await sleep(PAGE_DELAY_MS * 8);
    const afterCancel = up.started;
    await sleep(PAGE_DELAY_MS * 4);
    expect(up.started).toBe(afterCancel);
    expect(up.started).toBeLessThan(PAGES);
    expect(up.aborted).toBe(1);
  });
});

describe("closing the HTTP connection aborts the upstream calls", () => {
  it("a client that disconnects mid-walk stops action1_endpoints_summary", async () => {
    const { createHttpApp } = await import("../../src/http.js");
    const { loadConfig } = await import("../../src/config.js");
    const { request } = await import("node:http");
    const token = "cancel-test-token-0123456789";
    const base = loadConfig();
    const app = createHttpApp({ ...base, http: { ...base.http, host: "127.0.0.1", token } });
    const server = await new Promise<import("node:http").Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const port = (server.address() as import("node:net").AddressInfo).port;
      const up = slowUpstream();
      const req = request({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/mcp",
        headers: {
          host: `127.0.0.1:${port}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
          authorization: `Bearer ${token}`,
        },
      });
      req.on("error", () => undefined);
      req.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "action1_endpoints_summary", arguments: {} },
        }),
      );
      await sleep(PAGE_DELAY_MS * 3);
      req.destroy();
      await sleep(PAGE_DELAY_MS * 8);
      const afterClose = up.started;
      await sleep(PAGE_DELAY_MS * 4);
      expect(up.started).toBe(afterClose);
      expect(up.started).toBeLessThan(PAGES);
      expect(up.aborted).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("notifications/cancelled on the stateless 2025 HTTP transport", () => {
  // Each 2025-era POST is served by its own server instance, so a
  // notifications/cancelled that arrives in a second POST cannot reach
  // the call running in the first one. docs/FAQ.md says so; this test
  // holds that statement to the code. Closing the call's own HTTP
  // request is what cancels it (see the test above).
  it("a cancel sent in a separate POST does not stop the running call", async () => {
    const { createHttpApp } = await import("../../src/http.js");
    const { loadConfig } = await import("../../src/config.js");
    const { request } = await import("node:http");
    const token = "cancel-test-token-0123456789";
    const base = loadConfig();
    const app = createHttpApp({ ...base, http: { ...base.http, host: "127.0.0.1", token } });
    const server = await new Promise<import("node:http").Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const port = (server.address() as import("node:net").AddressInfo).port;
      const up = slowUpstream();
      const post = (body: unknown): Promise<{ status: number; text: string }> =>
        new Promise((resolve, reject) => {
          const req = request(
            {
              host: "127.0.0.1",
              port,
              method: "POST",
              path: "/mcp",
              headers: {
                host: `127.0.0.1:${port}`,
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                "mcp-protocol-version": "2025-11-25",
                authorization: `Bearer ${token}`,
              },
            },
            (res) => {
              let text = "";
              res.setEncoding("utf8");
              res.on("data", (c: string) => (text += c));
              res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
            },
          );
          req.on("error", reject);
          req.end(JSON.stringify(body));
        });
      const call = post({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "action1_endpoints_summary", arguments: { response_format: "json" } },
      });
      await sleep(PAGE_DELAY_MS * 3);
      const cancel = await post({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 1, reason: "user pressed stop" },
      });
      expect(cancel.status).toBe(202);
      const startedAtCancel = up.started;
      expect(startedAtCancel).toBeLessThan(PAGES);
      const done = await call;
      expect(done.status).toBe(200);
      const msg = JSON.parse(done.text) as {
        result: { isError?: boolean; structuredContent: { total: number } };
      };
      expect(msg.result.isError ?? false).toBe(false);
      // The walk ran to its end: every page was fetched, none aborted.
      expect(up.started).toBe(PAGES);
      expect(up.aborted).toBe(0);
      expect(msg.result.structuredContent.total).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});
