import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetConfigCache } from "../../src/config.js";

// GHSA-46jr-4wx8-v453: validating oversized array inputs can exhaust
// memory. The SDK fix only applies when `maxToolInputElements` is set,
// so buildServer() must configure it. Free-form bodies (e.g. a deploy
// request's update list) stay far below the cap in legitimate use.

let CLIENT: import("@modelcontextprotocol/client").Client;
let SERVER: ReturnType<typeof import("../../src/server.js").buildServer>;
let MAX: number;

beforeAll(async () => {
  process.env.ACTION1_BASE_URL = "https://127.0.0.1:1/api/3.0";
  process.env.ACTION1_CLIENT_ID = "client-id-test";
  process.env.ACTION1_CLIENT_SECRET = "client-secret-test";
  process.env.ACTION1_ORG_ID = "00000000-0000-0000-0000-000000000001";
  resetConfigCache();
  const mod = await import("../../src/server.js");
  MAX = mod.MAX_TOOL_INPUT_ELEMENTS;
  const { Client } = await import("@modelcontextprotocol/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/server");
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  SERVER = mod.buildServer();
  await SERVER.server.connect(serverTx);
  CLIENT = new Client({ name: "input-limit-test", version: "0.0.0" });
  await CLIENT.connect(clientTx);
});

afterAll(async () => {
  await CLIENT?.close();
  await SERVER?.server.close();
});

async function callWithArray(n: number): Promise<string> {
  try {
    const res = await CLIENT.callTool({
      name: "action1_create_organization",
      arguments: { body: { items: new Array(n).fill(0) } },
    });
    return JSON.stringify(res.content);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe("tools/call input element cap", () => {
  it("is configured to a finite, generous value", () => {
    expect(Number.isFinite(MAX)).toBe(true);
    expect(MAX).toBeGreaterThanOrEqual(10_000);
  });

  it("rejects arguments with more elements than the cap", async () => {
    expect(await callWithArray(MAX + 1)).toMatch(/more than the maximum/);
  });

  it("accepts arguments below the cap", async () => {
    expect(await callWithArray(1_000)).not.toMatch(/more than the maximum/);
  });
});
