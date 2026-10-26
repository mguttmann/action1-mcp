import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../../src/config.js";

let buildServer: typeof import("../../src/server.js").buildServer;
let SERVER: ReturnType<typeof import("../../src/server.js").buildServer>;
let CLIENT: import("@modelcontextprotocol/client").Client;

const ENDPOINT_UUID = "11111111-2222-3333-4444-555555555555";
const GROUP_ID = "Patch_Ring0_Pilot_macOS_1779687913115";

beforeAll(async () => {
  process.env.ACTION1_BASE_URL = "https://app.eu.action1.test/api/3.0";
  process.env.ACTION1_CLIENT_ID = "client-id-test";
  process.env.ACTION1_CLIENT_SECRET = "client-secret-test";
  process.env.ACTION1_ORG_ID = "00000000-0000-0000-0000-000000000001";
  resetConfigCache();
  buildServer = (await import("../../src/server.js")).buildServer;
  const { Client } = await import("@modelcontextprotocol/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/server");
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  SERVER = buildServer();
  await SERVER.server.connect(serverTx);
  CLIENT = new Client({ name: "groups-test", version: "0.0.0" });
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

function stubNoNetwork(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string) => {
    if (url.endsWith("/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "tkn", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "no route", url }), {
      status: 599,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("group membership tools", () => {
  it("add dry_run preview emits the POST array body and makes no upstream call", async () => {
    const stub = stubNoNetwork();
    const result = await CLIENT.callTool({
      name: "action1_add_endpoint_to_group",
      arguments: { group_id: GROUP_ID, endpoint_id: ENDPOINT_UUID, dry_run: true },
    });
    expect(result.isError ?? false).toBe(false);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.dry_run).toBe(true);
    expect(sc.tool).toBe("action1_add_endpoint_to_group");
    const would = sc.would_send as { method: string; path: string; body: unknown[] };
    expect(would.method).toBe("POST");
    expect(would.path).toContain(`/endpoints/groups/`);
    expect(would.path).toContain(`/${GROUP_ID}/contents`);
    expect(would.body).toEqual([
      { method: "POST", data: { endpoint_id: ENDPOINT_UUID, type: "Endpoint" } },
    ]);
    const nonToken = stub.mock.calls.filter((c) => !String(c[0]).endsWith("/oauth2/token"));
    expect(nonToken.length).toBe(0);
  });

  it("remove dry_run preview emits the DELETE array body", async () => {
    stubNoNetwork();
    const result = await CLIENT.callTool({
      name: "action1_remove_endpoint_from_group",
      arguments: { group_id: GROUP_ID, endpoint_id: ENDPOINT_UUID, dry_run: true },
    });
    expect(result.isError ?? false).toBe(false);
    const sc = result.structuredContent as Record<string, unknown>;
    const would = sc.would_send as { method: string; body: unknown[] };
    expect(would.method).toBe("POST");
    expect(would.body).toEqual([{ method: "DELETE", endpoint_id: ENDPOINT_UUID }]);
  });

  it("rejects a non-UUID endpoint_id", async () => {
    stubNoNetwork();
    const result = await CLIENT.callTool({
      name: "action1_remove_endpoint_from_group",
      arguments: { group_id: GROUP_ID, endpoint_id: "../etc/passwd", dry_run: true },
    });
    expect(result.isError).toBe(true);
  });

  it("tools/list exposes add+remove and NOT modify_group_membership", async () => {
    const list = await CLIENT.listTools();
    const names = list.tools.map((t) => t.name);
    expect(names).toContain("action1_add_endpoint_to_group");
    expect(names).toContain("action1_remove_endpoint_from_group");
    expect(names).not.toContain("action1_modify_group_membership");
  });
});
