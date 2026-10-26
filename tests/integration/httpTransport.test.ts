import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config.js";
import { createHttpApp, type HttpAppDeps } from "../../src/http.js";
import { parseTrustProxy } from "../../src/index.js";
import { getLogLevel, log, setLogLevel } from "../../src/utils/logger.js";
import { SERVER_VERSION } from "../../src/server.js";

// These tests run the REAL production Express app (createHttpApp, the
// same factory `--http` uses) on an ephemeral loopback port. Requests go
// through node:http so the Host header can be set freely, which is what
// a DNS-rebinding page effectively does.

const TOKEN = "test-token-0123456789abcdef";

function makeCfg(http: Partial<AppConfig["http"]> = {}): AppConfig {
  return {
    baseUrl: "https://127.0.0.1:1/api/3.0",
    defaultOrgId: "00000000-0000-0000-0000-000000000001",
    clientId: "dummy",
    clientSecret: "dummy",
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
      token: TOKEN,
      allowNoAuth: false,
      trustProxy: false,
      ...http,
    },
  };
}

let live: Server | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (live) {
    const s = live;
    live = undefined;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

async function start(cfg: AppConfig, deps: HttpAppDeps = {}): Promise<number> {
  const app = createHttpApp(cfg, deps);
  live = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  return (live.address() as AddressInfo).port;
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

function send(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "POST",
        path: opts.path ?? "/mcp",
        headers: { host: `127.0.0.1:${port}`, ...opts.headers },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const TOOLS_LIST = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

function mcpHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-11-25",
    authorization: `Bearer ${TOKEN}`,
    ...extra,
  };
}

describe("startup refusals", () => {
  it("refuses to start without MCP_HTTP_TOKEN, even on loopback", () => {
    expect(() => createHttpApp(makeCfg({ token: undefined }))).toThrow(/MCP_HTTP_TOKEN/);
  });

  it("refuses MCP_HTTP_ALLOW_NO_AUTH on a non-loopback bind", () => {
    expect(() =>
      createHttpApp(
        makeCfg({
          token: undefined,
          allowNoAuth: true,
          host: "10.0.0.5",
        }),
      ),
    ).toThrow(/loopback/);
  });

  it("refuses a wildcard bind without MCP_HTTP_ALLOWED_HOSTS", () => {
    expect(() => createHttpApp(makeCfg({ host: "0.0.0.0" }))).toThrow(/MCP_HTTP_ALLOWED_HOSTS/);
    expect(() => createHttpApp(makeCfg({ host: "::" }))).toThrow(/MCP_HTTP_ALLOWED_HOSTS/);
  });

  it("starts tokenless on loopback with the explicit opt-out and warns loudly", () => {
    const warn = vi.spyOn(log, "warn");
    expect(() => createHttpApp(makeCfg({ token: undefined, allowNoAuth: true }))).not.toThrow();
    expect(warn).toHaveBeenCalledWith("http_auth_disabled", expect.anything());
  });
});

describe("DNS-rebinding defence (Host and Origin)", () => {
  it("rejects a foreign Host header with 403, even with a valid token", async () => {
    const port = await start(makeCfg());
    const r = await send(port, {
      headers: mcpHeaders({ host: `rebind.attacker.example:${port}` }),
      body: TOOLS_LIST,
    });
    expect(r.status).toBe(403);
    expect(r.text).toMatch(/Host/);
  });

  it("rejects a foreign Host header on the tokenless loopback opt-out (the original exploit)", async () => {
    const port = await start(makeCfg({ token: undefined, allowNoAuth: true }));
    const r = await send(port, {
      headers: mcpHeaders({
        host: `rebind.attacker.example:${port}`,
        origin: `http://rebind.attacker.example:${port}`,
      }),
      body: TOOLS_LIST,
    });
    expect(r.status).toBe(403);
  });

  it("rejects a cross-origin Origin header with 403, even with a valid token", async () => {
    const port = await start(makeCfg());
    const r = await send(port, {
      headers: mcpHeaders({ origin: "https://evil.example" }),
      body: TOOLS_LIST,
    });
    expect(r.status).toBe(403);
    expect(r.text).toMatch(/Origin/);
  });

  it("rejects an opaque Origin: null", async () => {
    const port = await start(makeCfg());
    const r = await send(port, { headers: mcpHeaders({ origin: "null" }), body: TOOLS_LIST });
    expect(r.status).toBe(403);
  });

  it("accepts loopback Origins and loopback Host spellings", async () => {
    const port = await start(makeCfg());
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, "localhost"]) {
      const r = await send(port, {
        headers: mcpHeaders({ host, origin: "http://localhost:6274" }),
        body: TOOLS_LIST,
      });
      expect(r.status, host).toBe(200);
    }
  });

  it("with MCP_HTTP_ALLOWED_ORIGINS set, only the listed Origins pass", async () => {
    const port = await start(makeCfg({ allowedOrigins: ["https://app.example"] }));
    const ok = await send(port, {
      headers: mcpHeaders({ origin: "https://app.example" }),
      body: TOOLS_LIST,
    });
    expect(ok.status).toBe(200);
    const bad = await send(port, {
      headers: mcpHeaders({ origin: "http://localhost:6274" }),
      body: TOOLS_LIST,
    });
    expect(bad.status).toBe(403);
  });

  it("serves an allowed external Host on a wildcard bind with a token (200)", async () => {
    const port = await start(makeCfg({ host: "0.0.0.0", allowedHosts: ["mcp.example.com"] }));
    const r = await send(port, {
      headers: mcpHeaders({ host: "mcp.example.com" }),
      body: TOOLS_LIST,
    });
    expect(r.status).toBe(200);
    const json = JSON.parse(r.text) as { result: { tools: unknown[] } };
    expect(json.result.tools.length).toBeGreaterThan(0);
    const other = await send(port, {
      headers: mcpHeaders({ host: "other.example.com" }),
      body: TOOLS_LIST,
    });
    expect(other.status).toBe(403);
  });

  it("accepts the bind address itself as Host", async () => {
    const port = await start(makeCfg({ host: "192.0.2.10" }));
    const r = await send(port, {
      headers: mcpHeaders({ host: `192.0.2.10:${port}` }),
      body: TOOLS_LIST,
    });
    expect(r.status).toBe(200);
  });
});

describe("Bearer auth", () => {
  it("missing token -> 401", async () => {
    const port = await start(makeCfg());
    const headers = mcpHeaders();
    delete headers.authorization;
    const r = await send(port, { headers, body: TOOLS_LIST });
    expect(r.status).toBe(401);
  });

  it("wrong token -> 401", async () => {
    const port = await start(makeCfg());
    const r = await send(port, {
      headers: mcpHeaders({ authorization: "Bearer wrong-token-0123456789abcdef" }),
      body: TOOLS_LIST,
    });
    expect(r.status).toBe(401);
  });

  it("valid token -> 200 tools/list", async () => {
    const port = await start(makeCfg());
    const r = await send(port, { headers: mcpHeaders(), body: TOOLS_LIST });
    expect(r.status).toBe(200);
  });
});

describe("rate limit", () => {
  it("runs before auth: unauthenticated guesses hit 429 once the bucket is spent", async () => {
    const port = await start(makeCfg(), { rateLimit: { max: 2, windowMs: 60_000 } });
    const bad = mcpHeaders({ authorization: "Bearer guess-guess-guess-guess-1" });
    expect((await send(port, { headers: bad, body: TOOLS_LIST })).status).toBe(401);
    expect((await send(port, { headers: bad, body: TOOLS_LIST })).status).toBe(401);
    const third = await send(port, { headers: mcpHeaders(), body: TOOLS_LIST });
    expect(third.status).toBe(429);
    expect(third.headers["retry-after"]).toBeDefined();
  });

  it("TRUST_PROXY=false ignores X-Forwarded-For (one bucket per socket peer)", async () => {
    const port = await start(makeCfg({ trustProxy: false }), {
      rateLimit: { max: 1, windowMs: 60_000 },
    });
    const a = await send(port, {
      headers: mcpHeaders({ "x-forwarded-for": "203.0.113.1" }),
      body: TOOLS_LIST,
    });
    const b = await send(port, {
      headers: mcpHeaders({ "x-forwarded-for": "203.0.113.2" }),
      body: TOOLS_LIST,
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(429);
  });

  it("TRUST_PROXY=loopback buckets by the forwarded client address", async () => {
    const port = await start(makeCfg({ trustProxy: "loopback" }), {
      rateLimit: { max: 1, windowMs: 60_000 },
    });
    const a = await send(port, {
      headers: mcpHeaders({ "x-forwarded-for": "203.0.113.1" }),
      body: TOOLS_LIST,
    });
    const b = await send(port, {
      headers: mcpHeaders({ "x-forwarded-for": "203.0.113.2" }),
      body: TOOLS_LIST,
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});

describe("routes and error responses", () => {
  it.each(["GET", "DELETE"])("%s /mcp -> 405 with Allow: POST", async (method) => {
    const port = await start(makeCfg());
    const r = await send(port, { method, headers: mcpHeaders() });
    expect(r.status).toBe(405);
    expect(r.headers.allow).toBe("POST");
  });

  it("/healthz reports the server version", async () => {
    const port = await start(makeCfg());
    const r = await send(port, { method: "GET", path: "/healthz" });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({
      ok: true,
      service: "action1-mcp-server",
      version: SERVER_VERSION,
    });
  });

  it("a handler failure returns a generic 500 with a correlation id, details only in the log", async () => {
    const errors = vi.spyOn(log, "error");
    const port = await start(makeCfg(), {
      serverFactory: () => {
        throw new Error("internal detail /srv/secret/path");
      },
    });
    const r = await send(port, { headers: mcpHeaders(), body: TOOLS_LIST });
    expect(r.status).toBe(500);
    expect(r.text).not.toMatch(/secret|internal detail/);
    const body = JSON.parse(r.text) as {
      error: { message: string; data: { correlation_id: string } };
    };
    const id = body.error.data.correlation_id;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(errors).toHaveBeenCalledWith(
      "http_request_handler_failed",
      expect.objectContaining({
        correlation_id: id,
        error: expect.stringMatching(/internal detail/) as unknown,
      }),
    );
  });

  it("malformed JSON -> 400 JSON-RPC parse error without stack trace", async () => {
    const port = await start(makeCfg());
    const r = await send(port, { headers: mcpHeaders(), body: "{not json" });
    expect(r.status).toBe(400);
    expect(r.text).not.toMatch(/at .*\.js|SyntaxError/);
    expect(JSON.parse(r.text)).toMatchObject({ error: { code: -32700 } });
  });

  it("the body parser only runs on /mcp (POST /unknown with bad JSON -> 404)", async () => {
    const port = await start(makeCfg());
    const r = await send(port, {
      path: "/unknown",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(r.status).toBe(404);
  });

  it("logging/setLevel from an HTTP client does not change the process log level", async () => {
    const before = getLogLevel();
    const port = await start(makeCfg());
    const target = before === "debug" ? "error" : "debug";
    const r = await send(port, {
      headers: mcpHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "logging/setLevel",
        params: { level: target },
      }),
    });
    expect(r.status).toBe(200);
    expect(getLogLevel()).toBe(before);
    setLogLevel(before);
  });
});

describe("parseTrustProxy - env-to-Express mapping", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["false", false],
    ["true", true],
    ["loopback", "loopback"],
    ["2", 2],
    ["10.0.0.0/8", "10.0.0.0/8"],
    ["10.0.0.1,10.0.0.2", "10.0.0.1,10.0.0.2"],
    ["  true  ", true],
    ["\t\tloopback\n", "loopback"],
  ])("%j -> %j", (raw, expected) => {
    expect(parseTrustProxy(raw)).toBe(expected);
  });
});
