import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The HTTP transport serves MCP 2026-07-28 (per-request envelope,
// server/discover) next to the 2025 revisions on the same POST /mcp,
// behind the same rate limit, Host/Origin check and bearer token. The
// 2025 path is unchanged (tests/integration/httpTransport.test.ts).

const TOKEN = "modern-http-token-0123456789abcdef";
const ORG = "00000000-0000-0000-0000-000000000001";

let saved: NodeJS.ProcessEnv;
let live: Server | undefined;
const closers: Array<() => Promise<void>> = [];

beforeEach(() => {
  saved = { ...process.env };
  Object.assign(process.env, {
    ACTION1_BASE_URL: "https://app.eu.action1.test/api/3.0",
    ACTION1_CLIENT_ID: "client-id-test",
    ACTION1_CLIENT_SECRET: "client-secret-test",
    ACTION1_ORG_ID: ORG,
  });
  vi.resetModules();
});

afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  if (live) {
    const s = live;
    live = undefined;
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  vi.restoreAllMocks();
});

async function start(): Promise<number> {
  const { resetConfigCache, loadConfig } = await import("../../src/config.js");
  resetConfigCache();
  const { createHttpApp } = await import("../../src/http.js");
  const base = loadConfig();
  const app = createHttpApp({ ...base, http: { ...base.http, host: "127.0.0.1", token: TOKEN } });
  live = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return (live.address() as AddressInfo).port;
}

async function connect(
  port: number,
  mode: "legacy" | { pin: string },
  token = TOKEN,
): Promise<import("@modelcontextprotocol/client").Client> {
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, "User-Agent": "modern-agent/2" } },
  });
  const client = new Client(
    { name: "http-protocol-test", version: "0.0.0" },
    { versionNegotiation: { mode } },
  );
  await client.connect(transport);
  closers.push(() => client.close());
  return client;
}

describe("HTTP serves 2026-07-28 and the 2025 revisions", () => {
  it("a client pinned to 2026-07-28 lists tools and runs a tool with the HTTP caller", async () => {
    const port = await start();
    const client = await connect(port, { pin: "2026-07-28" });
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).toContain("action1_list_organizations");
    const lines: Record<string, unknown>[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      for (const line of String(chunk).split("\n")) {
        if (line.trim()) lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      return true;
    });
    const r = await client.callTool({
      name: "action1_delete_group",
      arguments: { group_id: "g1" },
    });
    expect(r.structuredContent).toMatchObject({ dry_run: true });
    const call = lines.find((l) => l.msg === "tool_call");
    expect(call?.meta).toMatchObject({
      tool: "action1_delete_group",
      outcome: "dry_run",
      caller: { transport: "http", user_agent: "modern-agent/2" },
    });
  });

  it("a 2025-era client still initializes and lists tools", async () => {
    const port = await start();
    const client = await connect(port, "legacy");
    const tools = (await client.listTools()).tools;
    expect(tools.length).toBeGreaterThan(0);
  });

  it("a 2026-07-28 client without the token is rejected with 401", async () => {
    const port = await start();
    await expect(
      connect(port, { pin: "2026-07-28" }, "wrong-token-000000000000"),
    ).rejects.toThrow();
  });
});
