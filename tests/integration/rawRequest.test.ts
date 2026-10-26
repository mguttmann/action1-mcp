import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../../src/config.js";

let buildServer: typeof import("../../src/server.js").buildServer;
let SERVER: ReturnType<typeof import("../../src/server.js").buildServer>;
let CLIENT: import("@modelcontextprotocol/client").Client;

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
  CLIENT = new Client({ name: "raw-test", version: "0.0.0" });
  await CLIENT.connect(clientTx);
}, 30_000);

afterAll(async () => {
  if (CLIENT) await CLIENT.close();
  if (SERVER?.server) await SERVER.server.close();
});

afterEach(() => {
  delete process.env.ACTION1_ALLOW_DESTRUCTIVE;
  delete process.env.ACTION1_ALLOW_ACCOUNT_OPS;
  resetConfigCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stub(routes: { match: (u: string) => boolean; body: object }[]): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string) => {
    if (url.endsWith("/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "tkn", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    for (const r of routes) {
      if (r.match(url)) {
        return new Response(JSON.stringify(r.body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ error: "no route", url }), {
      status: 599,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("action1_raw_request", () => {
  it("GET runs free (no confirm) and returns the upstream body", async () => {
    stub([{ match: (u) => u.endsWith("/me"), body: { user: { email: "a@b.c" } } }]);
    const result = await CLIENT.callTool({
      name: "action1_raw_request",
      arguments: { method: "GET", path: "/me" },
    });
    expect(result.isError ?? false).toBe(false);
    const sc = result.structuredContent as { user?: { email: string } };
    expect(sc.user?.email).toBe("a@b.c");
  });

  it("POST defaults to a dry_run preview and makes no upstream call", async () => {
    const s = stub([]);
    const result = await CLIENT.callTool({
      name: "action1_raw_request",
      arguments: { method: "POST", path: "/organizations", body: { name: "x" } },
    });
    expect(result.isError ?? false).toBe(false);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.dry_run).toBe(true);
    expect(sc.tool).toBe("action1_raw_request");
    const nonToken = s.mock.calls.filter((c) => !String(c[0]).endsWith("/oauth2/token"));
    expect(nonToken.length).toBe(0);
  });

  it("POST with confirm but no env is refused", async () => {
    stub([]);
    const result = await CLIENT.callTool({
      name: "action1_raw_request",
      arguments: {
        method: "POST",
        path: "/organizations",
        body: { name: "x" },
        dry_run: false,
        confirm: "YES",
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]!.text;
    expect(text).toContain("ACTION1_ALLOW_DESTRUCTIVE");
  });

  it("rejects a path that does not start with /", async () => {
    stub([]);
    const result = await CLIENT.callTool({
      name: "action1_raw_request",
      arguments: { method: "GET", path: "me" },
    });
    expect(result.isError).toBe(true);
  });

  it("a raw write is an account operation: refused without ACTION1_ALLOW_ACCOUNT_OPS, no upstream call", async () => {
    process.env.ACTION1_ALLOW_DESTRUCTIVE = "true";
    resetConfigCache();
    const s = stub([{ match: (u) => u.endsWith("/endpoints/groups/x"), body: { id: "g" } }]);
    const result = await CLIENT.callTool({
      name: "action1_raw_request",
      arguments: {
        method: "POST",
        path: "/endpoints/groups/x",
        body: { name: "x" },
        dry_run: false,
        confirm: "YES",
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toContain("ACTION1_ALLOW_ACCOUNT_OPS");
    const nonToken = s.mock.calls.filter((c) => !String(c[0]).endsWith("/oauth2/token"));
    expect(nonToken.length).toBe(0);
  });

  it("POST with env + account ops + confirm + dry_run=false reaches the upstream and returns its body", async () => {
    process.env.ACTION1_ALLOW_DESTRUCTIVE = "true";
    process.env.ACTION1_ALLOW_ACCOUNT_OPS = "true";
    resetConfigCache();
    const s = stub([{ match: (u) => u.endsWith("/organizations"), body: { id: "new-org-1" } }]);
    const result = await CLIENT.callTool({
      name: "action1_raw_request",
      arguments: {
        method: "POST",
        path: "/organizations",
        body: { name: "x" },
        dry_run: false,
        confirm: "YES",
      },
    });
    expect(result.isError ?? false).toBe(false);
    const sc = result.structuredContent as { id?: string };
    expect(sc.id).toBe("new-org-1");
    const nonToken = s.mock.calls.filter((c) => !String(c[0]).endsWith("/oauth2/token"));
    expect(nonToken.length).toBe(1);
  });

  it("dry_run preview redacts a secret-shaped value in the body", async () => {
    stub([]);
    const result = await CLIENT.callTool({
      name: "action1_raw_request",
      arguments: { method: "POST", path: "/x", body: { client_secret: "supersecretvalue123" } },
    });
    expect(result.isError ?? false).toBe(false);
    const sc = result.structuredContent as { would_send?: { body?: Record<string, unknown> } };
    const text = (result.content as { text: string }[])[0]!.text;
    expect(sc.would_send?.body?.client_secret).toBe("[REDACTED]");
    expect(text).not.toContain("supersecretvalue123");
  });

  it.each([
    ["GET", "/../x"],
    ["GET", "/endpoints/managed/org/%2e%2e"],
    ["DELETE", "/roles/R1/users/.."],
    ["DELETE", "/roles/R1/users/"],
  ])(
    "rejects %s %j (dot segment or empty segment) without any request, even as a dry run",
    async (method, path) => {
      const s = stub([{ match: () => true, body: { ok: true } }]);
      const result = await CLIENT.callTool({
        name: "action1_raw_request",
        arguments: { method, path },
      });
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0]!.text).toContain("Refusing request");
      const nonToken = s.mock.calls.filter((c) => !String(c[0]).endsWith("/oauth2/token"));
      expect(nonToken.length).toBe(0);
    },
  );

  it("an executed POST that gets a 502 is sent exactly once", async () => {
    process.env.ACTION1_ALLOW_DESTRUCTIVE = "true";
    process.env.ACTION1_ALLOW_ACCOUNT_OPS = "true";
    resetConfigCache();
    const s = stub([]); // every API route answers 599
    const result = await CLIENT.callTool({
      name: "action1_raw_request",
      arguments: {
        method: "POST",
        path: "/organizations",
        body: { name: "x" },
        dry_run: false,
        confirm: "YES",
      },
    });
    expect(result.isError).toBe(true);
    const nonToken = s.mock.calls.filter((c) => !String(c[0]).endsWith("/oauth2/token"));
    expect(nonToken.length).toBe(1);
  });
});
