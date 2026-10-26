import { createHash } from "node:crypto";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/client";

// Audit trail of guarded calls and HTTP rejections, end to end:
// - destructive_executed is written right before the state-changing
//   request and never when a pre-flight check aborts the call;
// - it names the caller (stdio, or the HTTP peer, user agent and a token
//   id) and carries the SHA-256 of the body that was sent;
// - audit events do not depend on ACTION1_LOG_LEVEL;
// - the HTTP transport logs 401, 403 and 429 rejections.

const ORG = "00000000-0000-0000-0000-000000000001";
const EP = "00000000-0000-4000-8000-0000000000e1";
const TOKEN = "audit-test-token-0123456789abcdef";
const BASE = {
  ACTION1_BASE_URL: "https://app.eu.action1.test/api/3.0",
  ACTION1_CLIENT_ID: "client-id-test",
  ACTION1_CLIENT_SECRET: "client-secret-test",
  ACTION1_ORG_ID: ORG,
};
const MANAGED = [
  "ACTION1_ALLOW_DESTRUCTIVE",
  "ACTION1_DESTRUCTIVE_AUTO_CONFIRM",
  "ACTION1_ALLOW_ACCOUNT_OPS",
  "ACTION1_ALLOWED_ORG_IDS",
  "ACTION1_LOG_LEVEL",
];

let saved: NodeJS.ProcessEnv;
let open: { close: () => Promise<void> } | undefined;

beforeEach(() => {
  saved = { ...process.env };
  for (const k of MANAGED) delete process.env[k];
  Object.assign(process.env, BASE);
  vi.resetModules();
});

afterEach(async () => {
  await open?.close();
  open = undefined;
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function connect(env: Record<string, string> = {}): Promise<Client> {
  Object.assign(process.env, env);
  const { resetConfigCache } = await import("../../src/config.js");
  resetConfigCache();
  const { buildServer } = await import("../../src/server.js");
  const { Client } = await import("@modelcontextprotocol/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/server");
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const built = buildServer();
  await built.server.connect(serverTx);
  const client = new Client({ name: "audit-test", version: "0.0.0" });
  await client.connect(clientTx);
  open = {
    close: async () => {
      await client.close();
      await built.server.close();
    },
  };
  return client;
}

interface Call {
  method: string;
  url: string;
  body: string | undefined;
}

function stubFetch(route: (url: string, init?: RequestInit) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/oauth2/token")) {
        return json({ access_token: "tkn", expires_in: 3600 });
      }
      calls.push({
        method: init?.method ?? "GET",
        url,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return route(url, init);
    }),
  );
  return calls;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function captureLogs(): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim()) lines.push(JSON.parse(line) as Record<string, unknown>);
    }
    return true;
  });
  return lines;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const metaOf = (l: Record<string, unknown> | undefined): Record<string, unknown> =>
  (l?.meta ?? {}) as Record<string, unknown>;

describe("destructive_executed is written only for a request that is sent", () => {
  it("a reboot aborted by the connectivity check logs no destructive_executed and sends no POST", async () => {
    const stale = new Date(Date.now() - 60 * 60_000).toISOString();
    const calls = stubFetch((url) =>
      url.endsWith(`/endpoints/managed/${ORG}/${EP}`)
        ? json({ id: EP, status: "Connected", last_seen: stale, OS: "Windows 11" })
        : json({ id: "inst-1" }),
    );
    const client = await connect({ ACTION1_ALLOW_DESTRUCTIVE: "true" });
    const logs = captureLogs();
    const r = await client.callTool({
      name: "action1_reboot_endpoint",
      arguments: { endpoint_id: EP, dry_run: false, confirm: "YES" },
    });
    expect(r.isError).toBe(true);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(logs.filter((l) => l.msg === "destructive_executed")).toEqual([]);
  });

  it("carries the stdio caller and the SHA-256 of the body actually sent", async () => {
    const calls = stubFetch(() => json({ id: "inst-1" }));
    const client = await connect({ ACTION1_ALLOW_DESTRUCTIVE: "true" });
    const logs = captureLogs();
    const r = await client.callTool({
      name: "action1_reboot_endpoint",
      arguments: { endpoint_id: EP, dry_run: false, confirm: "YES", skip_connectivity_check: true },
    });
    expect(r.isError ?? false).toBe(false);
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toBeDefined();
    const executed = logs.filter((l) => l.msg === "destructive_executed");
    expect(executed).toHaveLength(1);
    expect(metaOf(executed[0])).toMatchObject({
      tool: "action1_reboot_endpoint",
      method: "POST",
      path: `/policies/instances/${ORG}`,
      org: ORG,
      caller: { transport: "stdio" },
      body_sha256: sha256(post!.body!),
    });
    const toolCall = logs.find((l) => l.msg === "tool_call");
    expect(metaOf(toolCall).caller).toEqual({ transport: "stdio" });
    // The audit line comes before the tool_call line of the same request.
    expect(logs.indexOf(executed[0]!)).toBeLessThan(logs.indexOf(toolCall!));
    expect(executed[0]!.request_id).toBe(toolCall!.request_id);
  });

  it("a body-less mutation reports body_sha256 null", async () => {
    stubFetch(() => json({ ok: true }));
    const client = await connect({ ACTION1_ALLOW_DESTRUCTIVE: "true" });
    const logs = captureLogs();
    await client.callTool({
      name: "action1_delete_group",
      arguments: { group_id: "g1", dry_run: false, confirm: "YES" },
    });
    const executed = logs.find((l) => l.msg === "destructive_executed");
    expect(metaOf(executed)).toMatchObject({ method: "DELETE", body_sha256: null });
  });
});

describe("audit events do not depend on ACTION1_LOG_LEVEL", () => {
  it("destructive_refused and destructive_executed are written with ACTION1_LOG_LEVEL=error", async () => {
    stubFetch(() => json({ ok: true }));
    const client = await connect({ ACTION1_ALLOW_DESTRUCTIVE: "true", ACTION1_LOG_LEVEL: "error" });
    const logs = captureLogs();
    await client.callTool({
      name: "action1_delete_group",
      arguments: { group_id: "g1", dry_run: false },
    });
    await client.callTool({
      name: "action1_delete_group",
      arguments: { group_id: "g1", dry_run: false, confirm: "YES" },
    });
    expect(logs.map((l) => l.msg)).toEqual(["destructive_refused", "destructive_executed"]);
    // Ordinary lines below the level stay suppressed.
    expect(logs.find((l) => l.msg === "tool_call")).toBeUndefined();
  });
});

// ---- HTTP -----------------------------------------------------------------

let live: Server | undefined;

afterEach(async () => {
  if (live) {
    const s = live;
    live = undefined;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

async function startHttp(
  env: Record<string, string> = {},
  rateLimit?: { max: number; windowMs: number },
): Promise<number> {
  Object.assign(process.env, env);
  const { resetConfigCache, loadConfig } = await import("../../src/config.js");
  resetConfigCache();
  const { createHttpApp } = await import("../../src/http.js");
  const base = loadConfig();
  const app = createHttpApp(
    { ...base, http: { ...base.http, host: "127.0.0.1", token: TOKEN } },
    rateLimit ? { rateLimit } : {},
  );
  live = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return (live.address() as AddressInfo).port;
}

function post(port: number, body: unknown, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
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
          ...headers,
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

const DELETE_CALL = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: "action1_delete_group",
    arguments: { group_id: "g1", dry_run: false, confirm: "YES" },
  },
};

describe("HTTP caller identity", () => {
  it("destructive_executed and tool_call name the peer, user agent and token id, never the token", async () => {
    stubFetch(() => json({ ok: true }));
    const port = await startHttp({ ACTION1_ALLOW_DESTRUCTIVE: "true" });
    const logs = captureLogs();
    const status = await post(port, DELETE_CALL, {
      authorization: `Bearer ${TOKEN}`,
      "user-agent": "audit-agent/1.0",
    });
    expect(status).toBe(200);
    const executed = logs.find((l) => l.msg === "destructive_executed");
    const caller = metaOf(executed).caller as Record<string, unknown>;
    expect(caller).toMatchObject({
      transport: "http",
      user_agent: "audit-agent/1.0",
      token_id: sha256(TOKEN).slice(0, 12),
    });
    expect(String(caller.remote_ip)).toMatch(/127\.0\.0\.1/);
    expect(metaOf(logs.find((l) => l.msg === "tool_call")).caller).toEqual(caller);
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });
});

describe("HTTP rejections are logged", () => {
  it("401 (missing and invalid token), 403 (Host, Origin) and 429 each write an audit line without the token", async () => {
    const port = await startHttp({ ACTION1_LOG_LEVEL: "error" }, { max: 4, windowMs: 60_000 });
    const logs = captureLogs();
    const list = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    expect(await post(port, list, {})).toBe(401);
    expect(await post(port, list, { authorization: "Bearer wrong-token-guess-000000" })).toBe(401);
    expect(await post(port, list, { authorization: `Bearer ${TOKEN}`, host: "evil.example" })).toBe(
      403,
    );
    expect(
      await post(port, list, { authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" }),
    ).toBe(403);
    expect(await post(port, list, { authorization: `Bearer ${TOKEN}` })).toBe(429);
    const events = logs.filter((l) => String(l.msg).startsWith("http_"));
    expect(events.map((e) => [e.msg, metaOf(e).reason ?? null])).toEqual([
      ["http_auth_failed", "missing"],
      ["http_auth_failed", "invalid"],
      ["http_host_rejected", null],
      ["http_origin_rejected", null],
      ["http_rate_limited", null],
    ]);
    for (const e of events) {
      expect(String(metaOf(e).remote_ip)).toMatch(/127\.0\.0\.1/);
    }
    expect(JSON.stringify(logs)).not.toContain("wrong-token-guess");
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });

  it("repeated rejections from one peer are throttled to one line per window with a count", async () => {
    const port = await startHttp({}, { max: 1000, windowMs: 60_000 });
    const logs = captureLogs();
    const list = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    for (let i = 0; i < 5; i++) {
      expect(await post(port, list, { authorization: "Bearer nope-nope-nope-nope" })).toBe(401);
    }
    const events = logs.filter((l) => l.msg === "http_auth_failed");
    expect(events).toHaveLength(1);
  });
});
