import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../../src/config.js";

// Prompt-flow test for /run-script-fleetwide. The prompt tells the model to call
// action1_run_script against a group. This test reads the prompt from a
// real server, pulls the tool name and the group arguments it
// prescribes out of the text, and drives exactly that call (preview,
// then execution) against a stubbed upstream.

let CLIENT: import("@modelcontextprotocol/client").Client;
let SERVER: ReturnType<typeof import("../../src/server.js").buildServer>;

beforeAll(async () => {
  process.env.ACTION1_BASE_URL = "https://app.eu.action1.test/api/3.0";
  process.env.ACTION1_CLIENT_ID = "client-id-test";
  process.env.ACTION1_CLIENT_SECRET = "client-secret-test";
  process.env.ACTION1_ORG_ID = "00000000-0000-0000-0000-000000000001";
  resetConfigCache();
  const { buildServer } = await import("../../src/server.js");
  const { Client } = await import("@modelcontextprotocol/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/server");
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  SERVER = buildServer();
  await SERVER.server.connect(serverTx);
  CLIENT = new Client({ name: "fleetwide-flow-test", version: "0.0.0" });
  await CLIENT.connect(clientTx);
}, 30_000);

afterAll(async () => {
  await CLIENT?.close();
  await SERVER?.server.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ACTION1_ALLOW_DESTRUCTIVE;
  resetConfigCache();
});

const GROUP_ID = "0f0e0d0c-0b0a-0908-0706-050403020100";

function stubFetch(postBody: object): ReturnType<typeof vi.fn> {
  const stub = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "tkn", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if ((init.method ?? "GET") === "POST") {
      return new Response(JSON.stringify(postBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "unexpected", url }), { status: 404 });
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

async function promptedCall(scriptText: string): Promise<{
  tool: string;
  args: Record<string, unknown>;
}> {
  const prompt = await CLIENT.getPrompt({
    name: "run-script-fleetwide",
    arguments: { group_query: "Marketing Laptops", script_text: scriptText },
  });
  const text = (prompt.messages[0]!.content as { text: string }).text;
  const step = /Call (action1_\w+) with ([^\n]*)/.exec(text);
  expect(step, "prompt names the tool call").not.toBeNull();
  const tool = step![1]!;
  const callText = step![2]!;
  expect(callText).toContain('target_type="EndpointGroup"');
  expect(callText).toMatch(/os=/);
  expect(callText).toMatch(/dry_run=true/);
  return {
    tool,
    args: { target_type: "EndpointGroup", endpoint_id: GROUP_ID, script_text: scriptText },
  };
}

describe("/run-script-fleetwide prompt flow", () => {
  it.each([
    { os: "windows", script: "Get-Date", path: "/policies/instances/" },
    { os: "macos", script: "sw_vers", path: "/automations/instances/" },
  ])("previews and then executes the prescribed group call (os=$os)", async (c) => {
    const { tool, args } = await promptedCall(c.script);

    const stub = stubFetch({ id: "inst-1" });
    const preview = await CLIENT.callTool({
      name: tool,
      arguments: { ...args, os: c.os, dry_run: true },
    });
    expect(preview.isError).toBeFalsy();
    const would = (preview.structuredContent as { would_send: { path: string; body: unknown } })
      .would_send;
    expect(would.path).toContain(c.path);
    expect((would.body as { endpoints: unknown[] }).endpoints).toEqual([
      { id: GROUP_ID, type: "EndpointGroup" },
    ]);
    expect(stub.mock.calls.filter((x) => !String(x[0]).endsWith("/oauth2/token"))).toHaveLength(0);

    process.env.ACTION1_ALLOW_DESTRUCTIVE = "true";
    resetConfigCache();
    const run = await CLIENT.callTool({
      name: tool,
      arguments: { ...args, os: c.os, dry_run: false, confirm: "YES" },
    });
    expect(run.isError).toBeFalsy();
    expect((run.structuredContent as { instance_id: string }).instance_id).toBe("inst-1");
    const calls = stub.mock.calls.filter((x) => !String(x[0]).endsWith("/oauth2/token"));
    expect(calls).toHaveLength(1);
    expect(String(calls[0]![0])).toContain(c.path);
  });
});
