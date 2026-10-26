import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import { redactSecretKeys } from "../../src/utils/logger.js";

// Successful responses: values under credential-shaped keys
// (client_secret, password, access_token, api_key, ...) are masked in
// tool results and resource reads, at any depth. Free text such as
// script output is not inspected (docs/SECURITY.md).

const ORG = "00000000-0000-0000-0000-000000000001";
const UPSTREAM = {
  name: "idp-setting",
  value: {
    client_secret: "SECRET-ONE",
    password: "SECRET-TWO",
    nested: [{ access_token: "SECRET-THREE", refresh_token: "SECRET-FOUR", label: "keep-me" }],
  },
};

describe("redactSecretKeys", () => {
  it("masks credential-shaped keys at any depth and keeps everything else", () => {
    let deep: unknown = { api_key: "SECRET-DEEP" };
    for (let i = 0; i < 20; i++) deep = { level: deep };
    const out = JSON.stringify(redactSecretKeys({ ...UPSTREAM, deep }));
    for (const s of ["SECRET-ONE", "SECRET-TWO", "SECRET-THREE", "SECRET-FOUR", "SECRET-DEEP"]) {
      expect(out).not.toContain(s);
    }
    expect(out).toContain("keep-me");
    expect(out).toContain("idp-setting");
    expect(out).not.toContain("[truncated]");
  });

  it("leaves strings (script output) unchanged", () => {
    expect(redactSecretKeys("password=hunter2")).toBe("password=hunter2");
  });
});

let saved: NodeJS.ProcessEnv;
let open: { close: () => Promise<void> } | undefined;

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
  await open?.close();
  open = undefined;
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function connect(): Promise<Client> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = url.endsWith("/oauth2/token")
        ? { access_token: "tkn", expires_in: 3600 }
        : url.endsWith("/me")
          ? { id: "u1", api_key: "SECRET-ME" }
          : UPSTREAM;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  const { resetConfigCache } = await import("../../src/config.js");
  resetConfigCache();
  const { buildServer } = await import("../../src/server.js");
  const { Client } = await import("@modelcontextprotocol/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/server");
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const built = buildServer();
  await built.server.connect(serverTx);
  const client = new Client({ name: "secret-test", version: "0.0.0" });
  await client.connect(clientTx);
  open = {
    close: async () => {
      await client.close();
      await built.server.close();
    },
  };
  return client;
}

describe("success responses", () => {
  it("a tool result masks credential-shaped keys in text and structured content", async () => {
    const client = await connect();
    const r = await client.callTool({
      name: "action1_raw_request",
      arguments: { method: "GET", path: "/settings/all/s1" },
    });
    const all = JSON.stringify(r.content) + JSON.stringify(r.structuredContent ?? {});
    for (const s of ["SECRET-ONE", "SECRET-TWO", "SECRET-THREE", "SECRET-FOUR"]) {
      expect(all).not.toContain(s);
    }
    expect(all).toContain("keep-me");
  });

  it("a resource read masks credential-shaped keys", async () => {
    const client = await connect();
    const me = await client.readResource({ uri: "action1://me" });
    expect(JSON.stringify(me.contents)).not.toContain("SECRET-ME");
  });
});
