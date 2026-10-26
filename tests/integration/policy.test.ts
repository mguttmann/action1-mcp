import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/client";

// Server-wide policy end to end, through a real MCP client: toolset
// filter, strict input schemas, org allowlist, the account-operations
// opt-in, and the operational log events (tool_call, destructive_*,
// upstream_retry) with their correlation id.

const ORG = "00000000-0000-0000-0000-000000000001";
const OTHER_ORG = "00000000-0000-0000-0000-0000000000ff";
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
  "ACTION1_TOOLSETS",
  "ACTION1_REDACT_PII",
  "ACTION1_LOG_LEVEL",
];

const baseline = JSON.parse(
  readFileSync(new URL("../fixtures/tools-list.baseline.json", import.meta.url), "utf8"),
) as { tools: { name: string; annotations: { readOnlyHint: boolean } }[] };

let saved: NodeJS.ProcessEnv;
let open: { client: Client; close: () => Promise<void> } | undefined;

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
  const client = new Client({ name: "policy-test", version: "0.0.0" });
  await client.connect(clientTx);
  open = {
    client,
    close: async () => {
      await client.close();
      await built.server.close();
    },
  };
  return client;
}

/** fetch stub: token endpoint plus a router; records every API call. */
function stubFetch(route: (url: string, init?: RequestInit) => Response): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "tkn", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      calls.push(`${init?.method ?? "GET"} ${url}`);
      return route(url, init);
    }),
  );
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function textOf(r: { content?: unknown }): string {
  return (r.content as { text?: string }[] | undefined)?.[0]?.text ?? "";
}

/** Capture the JSON log lines written to stderr. */
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

describe("ACTION1_TOOLSETS", () => {
  it("unset and `all` register every tool, including every baseline tool", async () => {
    let client = await connect();
    const unset = (await client.listTools()).tools.map((t) => t.name).sort();
    for (const b of baseline.tools) expect(unset).toContain(b.name);
    await open?.close();
    open = undefined;
    vi.resetModules();
    client = await connect({ ACTION1_TOOLSETS: "all" });
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(unset);
  });

  it("read registers only readOnlyHint tools", async () => {
    let client = await connect();
    const all = (await client.listTools()).tools;
    await open?.close();
    open = undefined;
    vi.resetModules();
    client = await connect({ ACTION1_TOOLSETS: "read" });
    const { tools } = await client.listTools();
    const expected = all.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name);
    expect(tools.map((t) => t.name).sort()).toEqual(expected.sort());
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((t) => t.annotations?.destructiveHint !== true)).toBe(true);
  });

  it("curated registers no generated tool; curated,read is the intersection", async () => {
    const { GENERATED_TOOL_MANIFEST } = await import("../../src/tools/generated/index.js");
    const generated = new Set(GENERATED_TOOL_MANIFEST.map((t) => t.name));
    let client = await connect({ ACTION1_TOOLSETS: "curated" });
    const curated = (await client.listTools()).tools;
    expect(curated.length).toBeGreaterThan(0);
    expect(curated.some((t) => generated.has(t.name))).toBe(false);
    await open?.close();
    open = undefined;
    vi.resetModules();
    client = await connect({ ACTION1_TOOLSETS: "Curated, READ" });
    const both = (await client.listTools()).tools;
    expect(both.map((t) => t.name).sort()).toEqual(
      curated
        .filter((t) => t.annotations?.readOnlyHint === true)
        .map((t) => t.name)
        .sort(),
    );
  });

  it("an unknown toolset aborts startup", async () => {
    process.env.ACTION1_TOOLSETS = "readonly";
    const { loadConfig, resetConfigCache } = await import("../../src/config.js");
    resetConfigCache();
    expect(() => loadConfig()).toThrow(/ACTION1_TOOLSETS/);
  });
});

describe("strict input schemas", () => {
  it("a misspelled argument is rejected instead of being dropped", async () => {
    const calls = stubFetch(() => json({ items: [] }));
    const client = await connect();
    const r = await client.callTool({
      name: "action1_list_organizations",
      arguments: { response_formatt: "json" },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Unrecognized key/i);
    expect(textOf(r)).toContain("response_formatt");
    expect(calls).toEqual([]);
  });

  it("every input schema is advertised as closed (additionalProperties: false)", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const open = tools.filter(
      (t) => (t.inputSchema as { additionalProperties?: unknown }).additionalProperties !== false,
    );
    expect(open.map((t) => t.name)).toEqual([]);
  });

  it("documented arguments stay valid", async () => {
    stubFetch(() => json({ items: [{ id: ORG, name: "Org" }] }));
    const client = await connect();
    const r = await client.callTool({
      name: "action1_list_organizations",
      arguments: { response_format: "json" },
    });
    expect(r.isError ?? false).toBe(false);
  });
});

describe("ACTION1_ALLOWED_ORG_IDS", () => {
  it("refuses an org_id outside the allowlist without calling Action1", async () => {
    const calls = stubFetch(() => json({ items: [] }));
    const client = await connect({ ACTION1_ALLOWED_ORG_IDS: ORG.toUpperCase() });
    const r = await client.callTool({
      name: "action1_list_endpoints",
      arguments: { org_id: OTHER_ORG },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("ACTION1_ALLOWED_ORG_IDS");
    expect(calls).toEqual([]);
    // An allowed org (case-insensitive) still works.
    const ok = await client.callTool({
      name: "action1_list_endpoints",
      arguments: { org_id: ORG },
    });
    expect(ok.isError ?? false).toBe(false);
  });

  it("covers generated tools, resource URIs, raw_request paths and org ids in bodies", async () => {
    const calls = stubFetch(() => json({ items: [] }));
    const client = await connect({
      ACTION1_ALLOWED_ORG_IDS: ORG,
      ACTION1_ALLOW_DESTRUCTIVE: "true",
    });
    const gen = await client.callTool({
      name: "action1_list_org_vulnerabilities",
      arguments: { org_id: OTHER_ORG },
    });
    expect(gen.isError).toBe(true);

    const res = await client
      .readResource({ uri: `action1://endpoints/${OTHER_ORG}` })
      .catch((e: unknown) => e);
    expect(res).toBeInstanceOf(Error);
    expect((res as Error).message).toContain("ACTION1_ALLOWED_ORG_IDS");

    const raw = await client.callTool({
      name: "action1_raw_request",
      arguments: { method: "GET", path: `/endpoints/managed/${OTHER_ORG}` },
    });
    expect(raw.isError).toBe(true);
    const rawUnknown = await client.callTool({
      name: "action1_raw_request",
      arguments: { method: "GET", path: "/not/a/documented/path" },
    });
    expect(rawUnknown.isError).toBe(true);
    expect(textOf(rawUnknown)).toContain("documented Action1 API paths");

    const move = await client.callTool({
      name: "action1_move_endpoint",
      arguments: {
        endpoint_id: "11111111-1111-1111-1111-111111111111",
        body: { target_organization_id: OTHER_ORG },
      },
    });
    expect(move.isError).toBe(true);
    expect(textOf(move)).toContain("ACTION1_ALLOWED_ORG_IDS");
    expect(calls).toEqual([]);
  });

  it("ACTION1_ORG_ID outside the allowlist aborts startup", async () => {
    process.env.ACTION1_ALLOWED_ORG_IDS = OTHER_ORG;
    const { loadConfig, resetConfigCache } = await import("../../src/config.js");
    resetConfigCache();
    expect(() => loadConfig()).toThrow(/ACTION1_ALLOWED_ORG_IDS/);
  });
});

describe("account operations need ACTION1_ALLOW_ACCOUNT_OPS", () => {
  const deleteUser = {
    name: "action1_delete_user",
    arguments: { user_id: "u1", dry_run: false, confirm: "YES" },
  };

  it("are refused with destructive operations enabled but no account opt-in", async () => {
    const calls = stubFetch(() => json({}));
    const client = await connect({ ACTION1_ALLOW_DESTRUCTIVE: "true" });
    const r = await client.callTool(deleteUser);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("ACTION1_ALLOW_ACCOUNT_OPS=true");
    expect(calls).toEqual([]);
  });

  it("execute with the opt-in, and ordinary destructive tools never need it", async () => {
    const calls = stubFetch(() => json({ ok: true }));
    const client = await connect({
      ACTION1_ALLOW_DESTRUCTIVE: "true",
      ACTION1_ALLOW_ACCOUNT_OPS: "true",
    });
    const r = await client.callTool(deleteUser);
    expect(r.isError ?? false).toBe(false);
    expect(calls).toEqual(["DELETE https://app.eu.action1.test/api/3.0/users/u1"]);
  });

  it("an ordinary destructive tool executes without the account opt-in", async () => {
    const calls = stubFetch(() => json({ ok: true }));
    const client = await connect({ ACTION1_ALLOW_DESTRUCTIVE: "true" });
    const r = await client.callTool({
      name: "action1_delete_group",
      arguments: { group_id: "g1", dry_run: false, confirm: "YES" },
    });
    expect(r.isError ?? false).toBe(false);
    expect(calls).toEqual([
      `DELETE https://app.eu.action1.test/api/3.0/endpoints/groups/${ORG}/g1`,
    ]);
  });
});

describe("operational log events", () => {
  it("one tool_call event per call with outcome, status, attempts and a request_id", async () => {
    let n = 0;
    stubFetch(() => (n++ === 0 ? json({ error: "busy" }, 503) : json({ items: [] })));
    const client = await connect();
    const logs = captureLogs();
    const r = await client.callTool({ name: "action1_list_organizations", arguments: {} });
    expect(r.isError ?? false).toBe(false);
    const calls = logs.filter((l) => l.msg === "tool_call");
    expect(calls).toHaveLength(1);
    const meta = calls[0]!.meta as Record<string, unknown>;
    expect(meta).toMatchObject({
      tool: "action1_list_organizations",
      outcome: "ok",
      upstream_status: 200,
      attempts: 2,
    });
    expect(typeof meta.duration_ms).toBe("number");
    // The retry is logged and shares the correlation id of the call.
    const retry = logs.find((l) => l.msg === "upstream_retry");
    expect(retry).toBeDefined();
    expect(retry!.request_id).toBe(calls[0]!.request_id);
    expect(typeof calls[0]!.request_id).toBe("string");
  });

  it("validation failures and upstream errors are logged as outcome=error at warn", async () => {
    stubFetch(() => json({ error: "nope" }, 403));
    const client = await connect();
    const logs = captureLogs();
    await client.callTool({ name: "action1_list_organizations", arguments: { bogus: 1 } });
    await client.callTool({ name: "action1_list_organizations", arguments: {} });
    const calls = logs.filter((l) => l.msg === "tool_call");
    expect(calls.map((c) => [c.level, (c.meta as { outcome: string }).outcome])).toEqual([
      ["warn", "error"],
      ["warn", "error"],
    ]);
    expect((calls[1]!.meta as { upstream_status: number }).upstream_status).toBe(403);
  });

  it("guard decisions emit destructive_dry_run, destructive_refused and destructive_executed", async () => {
    stubFetch(() => json({ ok: true }));
    const client = await connect({ ACTION1_ALLOW_DESTRUCTIVE: "true" });
    const logs = captureLogs();
    const args = { group_id: "g1" };
    await client.callTool({ name: "action1_delete_group", arguments: args });
    await client.callTool({ name: "action1_delete_group", arguments: { ...args, dry_run: false } });
    await client.callTool({
      name: "action1_delete_group",
      arguments: { ...args, dry_run: false, confirm: "YES" },
    });
    const events = logs.filter((l) => String(l.msg).startsWith("destructive_"));
    expect(events.map((e) => e.msg)).toEqual([
      "destructive_dry_run",
      "destructive_refused",
      "destructive_executed",
    ]);
    for (const e of events) {
      expect(e.meta).toMatchObject({
        tool: "action1_delete_group",
        method: "DELETE",
        path: `/endpoints/groups/${ORG}/g1`,
        org: ORG,
      });
    }
    expect((events[1]!.meta as { reason: string }).reason).toBe("confirm_missing");
    const outcomes = logs
      .filter((l) => l.msg === "tool_call")
      .map((l) => (l.meta as { outcome: string }).outcome);
    expect(outcomes).toEqual(["dry_run", "refused", "ok"]);
    // Each guard event carries the request_id of its tool call.
    const ids = logs.filter((l) => l.msg === "tool_call").map((l) => l.request_id);
    expect(events.map((e) => e.request_id)).toEqual(ids);
  });
});

describe("ACTION1_REDACT_PII", () => {
  const endpoint = {
    id: "e1",
    name: "host-1",
    user: "CORP\\alice",
    address: "10.0.0.5",
    MAC: "aa:bb",
  };

  it("masks personal fields in tool output when on, and leaves them alone when off", async () => {
    stubFetch(() => json(endpoint));
    let client = await connect();
    let r = await client.callTool({
      name: "action1_raw_request",
      arguments: { method: "GET", path: `/endpoints/managed/${ORG}/e1` },
    });
    expect(textOf(r)).toContain("alice");
    await open?.close();
    open = undefined;
    vi.resetModules();
    client = await connect({ ACTION1_REDACT_PII: "true" });
    r = await client.callTool({
      name: "action1_raw_request",
      arguments: { method: "GET", path: `/endpoints/managed/${ORG}/e1` },
    });
    const text = textOf(r);
    expect(text).not.toContain("alice");
    expect(text).not.toContain("10.0.0.5");
    expect(text).not.toContain("aa:bb");
    expect(text).toContain("host-1");
    expect(r.structuredContent).toMatchObject({ user: "[REDACTED:pii]", name: "host-1" });
  });
});
