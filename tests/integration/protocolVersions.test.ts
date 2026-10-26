import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../../src/config.js";

// Protocol negotiation guard, on the real stdio wiring (startStdio from
// the entry point, with an in-memory transport instead of the process
// pipes). Existing consumers initialize with older MCP protocol
// revisions: the Python `mcp` 1.27.x client used by fastmcp 3.3.x sends
// 2025-11-25, older clients send 2025-06-18. The server must answer
// `initialize` with the same revision and then serve tools/list. The
// legacy handshake is driven with raw JSON-RPC messages so the requested
// protocolVersion is exactly what a real client sends. A 2026-07-28
// client (server/discover, per-request envelope) is served by the same
// process.

type Msg = { id?: number; result?: Record<string, unknown>; error?: unknown };

let startStdio: typeof import("../../src/index.js").startStdio;
let InMemoryTransport: typeof import("@modelcontextprotocol/server").InMemoryTransport;
const closers: Array<() => Promise<void>> = [];

beforeAll(async () => {
  process.env.ACTION1_BASE_URL = "https://127.0.0.1:1/api/3.0";
  process.env.ACTION1_CLIENT_ID = "client-id-test";
  process.env.ACTION1_CLIENT_SECRET = "client-secret-test";
  process.env.ACTION1_ORG_ID = "00000000-0000-0000-0000-000000000001";
  resetConfigCache();
  startStdio = (await import("../../src/index.js")).startStdio;
  InMemoryTransport = (await import("@modelcontextprotocol/server")).InMemoryTransport;
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function handshake(protocolVersion: string): Promise<{ init: Msg; list: Msg }> {
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const handle = startStdio({ transport: serverTx });
  closers.push(() => handle.close());
  const waiting = new Map<number, (m: Msg) => void>();
  clientTx.onmessage = (m) => {
    const msg = m as Msg;
    if (typeof msg.id === "number") waiting.get(msg.id)?.(msg);
  };
  await clientTx.start();
  const send = (id: number, method: string, params: Record<string, unknown>): Promise<Msg> =>
    new Promise((resolve) => {
      waiting.set(id, resolve);
      void clientTx.send({ jsonrpc: "2.0", id, method, params });
    });
  const init = await send(1, "initialize", {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "protocol-test", version: "0.0.0" },
  });
  await clientTx.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const list = await send(2, "tools/list", {});
  return { init, list };
}

describe("initialize negotiates the client's protocol revision", () => {
  for (const version of ["2025-06-18", "2025-11-25"]) {
    it(`accepts ${version} and serves tools/list`, async () => {
      const { init, list } = await handshake(version);
      expect(init.error).toBeUndefined();
      expect(init.result?.protocolVersion).toBe(version);
      expect(list.error).toBeUndefined();
      expect((list.result?.tools as unknown[]).length).toBeGreaterThan(0);
    });
  }
});

describe("protocol revision 2026-07-28", () => {
  async function modernClient(): Promise<import("@modelcontextprotocol/client").Client> {
    const { Client } = await import("@modelcontextprotocol/client");
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const handle = startStdio({ transport: serverTx });
    const client = new Client(
      { name: "modern-test", version: "0.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(clientTx);
    closers.push(async () => {
      await client.close();
      await handle.close();
    });
    return client;
  }

  it("serves tools/list to a client pinned to 2026-07-28", async () => {
    const client = await modernClient();
    const tools = (await client.listTools()).tools;
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.map((t) => t.name)).toContain("action1_list_organizations");
  });

  it("runs a tool call with the server's instrumentation on 2026-07-28", async () => {
    const client = await modernClient();
    const lines: Record<string, unknown>[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      for (const line of String(chunk).split("\n")) {
        if (line.trim()) lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      return true;
    });
    try {
      const r = await client.callTool({
        name: "action1_delete_group",
        arguments: { group_id: "g1" },
      });
      expect(r.isError ?? false).toBe(false);
      expect(r.structuredContent).toMatchObject({ dry_run: true, tool: "action1_delete_group" });
    } finally {
      spy.mockRestore();
    }
    const call = lines.find((l) => l.msg === "tool_call");
    expect(call?.meta).toMatchObject({
      tool: "action1_delete_group",
      outcome: "dry_run",
      caller: { transport: "stdio" },
    });
    expect(lines.find((l) => l.msg === "destructive_dry_run")?.request_id).toBe(call?.request_id);
  });
});
