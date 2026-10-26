import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../../src/config.js";
import {
  GENERATED_SKIPPED_OPERATIONS,
  GENERATED_TOOL_MANIFEST,
} from "../../src/tools/generated/index.js";
import { READISH_OPERATION_IDS, SKIP_OPERATION_IDS } from "../../src/codegen/curated-overrides.js";

// Drives the GENERATED tools through the real MCP protocol (in-memory
// transport, real buildServer, real generated/index.ts). Three groups:
//
//   1. Classification invariant: every mutating spec operation becomes a
//      destructive tool, unless its operationId is on the reviewed
//      READISH_OPERATION_IDS allowlist.
//   2. Guard sweep: every generated destructive tool, called with minimal
//      valid arguments, (a) previews by default and (b) refuses
//      dry_run=false without ACTION1_ALLOW_DESTRUCTIVE. Neither path may
//      reach the network.
//   3. Behaviour of individual tools that were broken before v0.6.0
//      (array body of action1_create_approval, binary upload chunk) and a
//      sample of read tools per output shape, validated by the client
//      against the advertised outputSchema.

type Json = Record<string, unknown>;

interface SpecOp {
  method: string;
  path: string;
  operationId: string;
}

const spec = JSON.parse(
  readFileSync(new URL("../../src/codegen/spec/openapi.json", import.meta.url), "utf8"),
) as { paths: Record<string, Record<string, { operationId?: string }>> };

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function specOperations(): SpecOp[] {
  const out: SpecOp[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [m, op] of Object.entries(item)) {
      if (op.operationId) out.push({ method: m.toUpperCase(), path, operationId: op.operationId });
    }
  }
  return out;
}

let CLIENT: import("@modelcontextprotocol/client").Client;
let SERVER: ReturnType<typeof import("../../src/server.js").buildServer>;
let TOOLS: Awaited<ReturnType<typeof CLIENT.listTools>>["tools"];

function setBaseEnv(): void {
  process.env.ACTION1_BASE_URL = "https://app.eu.action1.test/api/3.0";
  process.env.ACTION1_CLIENT_ID = "client-id-test";
  process.env.ACTION1_CLIENT_SECRET = "client-secret-test";
  process.env.ACTION1_ORG_ID = "00000000-0000-0000-0000-000000000001";
  delete process.env.ACTION1_ALLOW_DESTRUCTIVE;
  delete process.env.ACTION1_DESTRUCTIVE_AUTO_CONFIRM;
  resetConfigCache();
}

beforeAll(async () => {
  setBaseEnv();
  const { buildServer } = await import("../../src/server.js");
  const { Client } = await import("@modelcontextprotocol/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/server");
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  SERVER = buildServer();
  await SERVER.server.connect(serverTx);
  CLIENT = new Client({ name: "generated-tools-test", version: "0.0.0" });
  await CLIENT.connect(clientTx);
  TOOLS = (await CLIENT.listTools()).tools;
}, 30_000);

afterAll(async () => {
  await CLIENT?.close();
  await SERVER?.server.close();
});

let fetchSpy: ReturnType<typeof vi.fn>;
let upstreamCalls: { url: string; init: RequestInit }[];
let nextBody: unknown;

beforeEach(() => {
  setBaseEnv();
  upstreamCalls = [];
  nextBody = {};
  fetchSpy = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (String(url).endsWith("/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "tkn", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    upstreamCalls.push({ url: String(url), init });
    return new Response(JSON.stringify(nextBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setBaseEnv();
});

/** Build a minimal value that satisfies a JSON Schema (as advertised in tools/list). */
function sample(schema: Json | undefined): unknown {
  if (!schema || Object.keys(schema).length === 0) return "x";
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (Array.isArray(schema.anyOf)) return sample(schema.anyOf[0] as Json);
  if (Array.isArray(schema.oneOf)) return sample(schema.oneOf[0] as Json);
  if (Array.isArray(schema.allOf)) {
    return Object.assign({}, ...schema.allOf.map((s) => sample(s as Json) as Json));
  }
  const type = Array.isArray(schema.type)
    ? (schema.type as string[]).find((t) => t !== "null")
    : (schema.type as string | undefined);
  switch (type) {
    case "object": {
      const props = (schema.properties ?? {}) as Record<string, Json>;
      const out: Json = {};
      for (const k of (schema.required ?? []) as string[]) out[k] = sample(props[k]);
      return out;
    }
    case "array":
      return [sample(schema.items as Json)];
    case "integer":
    case "number":
      return 1;
    case "boolean":
      return true;
    case "null":
      return null;
    default:
      if (schema.format === "uuid") return "00000000-0000-4000-8000-000000000001";
      if (schema.format === "date-time") return "2026-01-01T00:00:00Z";
      return "x";
  }
}

function minimalArgs(toolName: string): Json {
  const tool = TOOLS.find((t) => t.name === toolName);
  if (!tool) throw new Error("tool not listed: " + toolName);
  const schema = tool.inputSchema as Json;
  const props = (schema.properties ?? {}) as Record<string, Json>;
  const args: Json = {};
  for (const k of (schema.required ?? []) as string[]) args[k] = sample(props[k]);
  return args;
}

describe("generated tool classification (spec -> artifact invariant)", () => {
  it("the manifest covers every spec operation exactly once (emitted, skipped, or curated)", () => {
    const emitted = new Set(GENERATED_TOOL_MANIFEST.map((t) => t.operationId));
    const skipped = new Set(GENERATED_SKIPPED_OPERATIONS.map((s) => s.operationId));
    for (const op of specOperations()) {
      const where = [emitted.has(op.operationId), skipped.has(op.operationId)].filter(Boolean);
      if (SKIP_OPERATION_IDS.has(op.operationId)) {
        expect(where.length, op.operationId).toBe(0);
      } else {
        expect(where.length, `${op.method} ${op.path} (${op.operationId})`).toBe(1);
      }
    }
  });

  it("every mutating operation yields a destructive tool unless reviewed as read-ish", () => {
    const listed = new Map(TOOLS.map((t) => [t.name, t]));
    const offenders: string[] = [];
    for (const t of GENERATED_TOOL_MANIFEST) {
      if (!MUTATING.has(t.method)) continue;
      const hint = listed.get(t.name)?.annotations?.destructiveHint;
      const expected = !READISH_OPERATION_IDS.has(t.operationId);
      if (t.destructive !== expected || hint !== expected) {
        offenders.push(`${t.method} ${t.path} -> ${t.name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("mutating operations covered by a curated tool map to a destructive curated tool", () => {
    const listed = new Map(TOOLS.map((t) => [t.name, t]));
    for (const s of GENERATED_SKIPPED_OPERATIONS) {
      if (!MUTATING.has(s.method)) continue;
      expect(listed.get(s.toolName)?.annotations?.destructiveHint, s.toolName).toBe(true);
    }
  });

  it("every read-only generated tool is a GET or HEAD", () => {
    for (const t of GENERATED_TOOL_MANIFEST) {
      if (!t.destructive) {
        expect(MUTATING.has(t.method) && !READISH_OPERATION_IDS.has(t.operationId), t.name).toBe(
          false,
        );
      }
    }
  });
});

describe("curated / generated name separation", () => {
  it("the codegen's curated-name scan equals the curated tools the server registers", async () => {
    const { curatedToolNames } = await import("../../src/codegen/generate.js");
    const generated = new Set(GENERATED_TOOL_MANIFEST.map((t) => t.name));
    const registeredCurated = TOOLS.map((t) => t.name)
      .filter((n) => !generated.has(n))
      .sort();
    expect([...curatedToolNames()].sort()).toEqual(registeredCurated);
  });
});

describe("generated titles and descriptions", () => {
  it("titles are imperative, without the vendor's TBD: prefix", () => {
    const generated = new Set(GENERATED_TOOL_MANIFEST.map((t) => t.name));
    for (const t of TOOLS.filter((x) => generated.has(x.name))) {
      expect(t.title ?? "", t.name).not.toMatch(/^(TBD:|[A-Z][a-z]+ing\b)/);
    }
  });

  it("a short last word of a complete spec sentence is kept (no false truncation marker)", () => {
    const tool = TOOLS.find((t) => t.name === "action1_get_user")!;
    expect(tool.description).toContain("Gets an existing user.");
    expect(tool.description).not.toContain("…");
  });
});

describe("guard sweep over every generated destructive tool", () => {
  const destructive = GENERATED_TOOL_MANIFEST.filter((t) => t.destructive);

  it("has destructive tools to sweep", () => {
    expect(destructive.length).toBeGreaterThan(0);
  });

  it("a call without dry_run previews (or refuses an unsupported op) and never reaches the network", async () => {
    const problems: string[] = [];
    for (const t of destructive) {
      const r = await CLIENT.callTool({ name: t.name, arguments: minimalArgs(t.name) });
      const sc = r.structuredContent as Json | undefined;
      if (t.unsupported) {
        if (!r.isError) problems.push(`${t.name}: unsupported op did not return isError`);
      } else if (r.isError || sc?.dry_run !== true) {
        problems.push(
          `${t.name}: expected dry-run preview, got ${JSON.stringify(r).slice(0, 300)}`,
        );
      }
    }
    expect(problems).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("dry_run=false with confirm=YES but without ACTION1_ALLOW_DESTRUCTIVE is refused without a network call", async () => {
    const problems: string[] = [];
    for (const t of destructive) {
      const r = await CLIENT.callTool({
        name: t.name,
        arguments: { ...minimalArgs(t.name), dry_run: false, confirm: "YES" },
      });
      if (!r.isError) problems.push(t.name);
    }
    expect(problems).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("account-operation opt-in sweep (ACTION1_ALLOW_ACCOUNT_OPS off)", () => {
  // Expectation from the spec paths, not from the guard's regex: every
  // generated destructive tool on the users, roles, enterprise,
  // organizations or subscription path families, and on /me itself, is
  // an account operation. /me/report-subscriptions (which reports the
  // API user receives) is not: it changes no identity or access.
  const ACCOUNT_FAMILIES = ["users", "roles", "enterprise", "organizations", "subscription"];
  const familyOf = (path: string): string => path.split("/")[1] ?? "";
  const isAccountPath = (path: string): boolean =>
    path === "/me" || ACCOUNT_FAMILIES.includes(familyOf(path));
  const destructive = GENERATED_TOOL_MANIFEST.filter((t) => t.destructive && !t.unsupported);
  const accountTools = destructive.filter((t) => isAccountPath(t.path));
  const otherTools = destructive.filter((t) => !isAccountPath(t.path));

  beforeEach(() => {
    process.env.ACTION1_ALLOW_DESTRUCTIVE = "true";
    delete process.env.ACTION1_ALLOW_ACCOUNT_OPS;
    resetConfigCache();
  });

  it("covers every account path family of the spec, including /me and /subscription", () => {
    expect(accountTools.some((t) => t.path === "/me")).toBe(true);
    for (const family of ACCOUNT_FAMILIES) {
      expect(
        accountTools.some((t) => familyOf(t.path) === family),
        family,
      ).toBe(true);
    }
  });

  it("every account tool is refused as an account operation without a network call", async () => {
    const problems: string[] = [];
    for (const t of accountTools) {
      const r = await CLIENT.callTool({
        name: t.name,
        arguments: { ...minimalArgs(t.name), dry_run: false, confirm: "YES" },
      });
      const text = (r.content as { text?: string }[])[0]?.text ?? "";
      if (!r.isError || !text.includes("Refusing account operation")) {
        problems.push(`${t.method} ${t.path} -> ${t.name}: ${text.slice(0, 120)}`);
      }
    }
    expect(problems).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no tool outside those families is refused as an account operation", async () => {
    const problems: string[] = [];
    for (const t of otherTools) {
      const r = await CLIENT.callTool({
        name: t.name,
        arguments: { ...minimalArgs(t.name), dry_run: false, confirm: "YES" },
      });
      const text = (r.content as { text?: string }[])[0]?.text ?? "";
      if (text.includes("Refusing account operation")) problems.push(`${t.method} ${t.path}`);
    }
    expect(problems).toEqual([]);
  });
});

describe("generated input schemas (spec -> artifact invariant)", () => {
  it("no advertised enum contains a {placeholder} value (those are free-form ids, not options)", () => {
    const offenders: string[] = [];
    const walk = (node: unknown, where: string): void => {
      if (Array.isArray(node)) {
        node.forEach((n, i) => walk(n, where + "[" + i + "]"));
        return;
      }
      if (!node || typeof node !== "object") return;
      const obj = node as Json;
      if (
        Array.isArray(obj.enum) &&
        obj.enum.some((v) => typeof v === "string" && /\{[^}]+\}/.test(v))
      ) {
        offenders.push(where);
      }
      for (const [k, v] of Object.entries(obj)) walk(v, where + "." + k);
    };
    const generated = new Set(GENERATED_TOOL_MANIFEST.map((m) => m.name));
    for (const t of TOOLS) if (generated.has(t.name)) walk(t.inputSchema, t.name);
    expect(offenders).toEqual([]);
  });
});

describe("individual generated tools", () => {
  it("action1_create_approval accepts the spec's top-level array body", async () => {
    const body = [
      {
        approval_status: "Approved",
        packages: [{ id: "pkg-1" }],
      },
    ];
    const r = await CLIENT.callTool({ name: "action1_create_approval", arguments: { body } });
    expect(r.isError, JSON.stringify(r)).toBeFalsy();
    const sc = r.structuredContent as { would_send: { body: unknown; path: string } };
    expect(sc.would_send.body).toEqual(body);
    expect(sc.would_send.path).toBe("/updates/00000000-0000-0000-0000-000000000001/approvals");
  });

  it("action1_create_approval sends the array body upstream when execution is allowed", async () => {
    process.env.ACTION1_ALLOW_DESTRUCTIVE = "true";
    resetConfigCache();
    nextBody = { type: "Success" };
    const body = [{ approval_status: "Declined", packages: [] }];
    const r = await CLIENT.callTool({
      name: "action1_create_approval",
      arguments: { body, dry_run: false, confirm: "YES" },
    });
    expect(r.isError, JSON.stringify(r)).toBeFalsy();
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]!.init.method).toBe("POST");
    expect(JSON.parse(upstreamCalls[0]!.init.body as string)).toEqual(body);
  });

  it("action1_create_approval rejects a status outside the spec enum", async () => {
    const r = await CLIENT.callTool({
      name: "action1_create_approval",
      arguments: { body: [{ approval_status: "Maybe", packages: [] }] },
    });
    expect(r.isError).toBe(true);
  });

  it("action1_create_setting accepts a real group id in scope.object (spec enum lists placeholders)", async () => {
    const body = {
      value: "1",
      template_id: "tpl",
      scope: [{ type: "Group", object: "abcdef12-0000-0000-0000-000000000009" }],
    };
    const r = await CLIENT.callTool({ name: "action1_create_setting", arguments: { body } });
    expect(r.isError, JSON.stringify(r)).toBeFalsy();
    const sc = r.structuredContent as { would_send: { body: unknown } };
    expect(sc.would_send.body).toEqual(body);
  });

  it("action1_update_setting accepts a real org id in scope.object", async () => {
    const r = await CLIENT.callTool({
      name: "action1_update_setting",
      arguments: {
        setting_id: "s1",
        body: { scope: [{ type: "Organization", object: "00000000-0000-0000-0000-000000000001" }] },
      },
    });
    expect(r.isError, JSON.stringify(r)).toBeFalsy();
  });

  it("typed bodies still accept extra keys the spec does not list (passthrough)", async () => {
    const r = await CLIENT.callTool({
      name: "action1_update_me",
      arguments: { body: { timezone: "Europe/Berlin", future_field: 1 } },
    });
    expect(r.isError, JSON.stringify(r)).toBeFalsy();
    const sc = r.structuredContent as { would_send: { body: Json } };
    expect(sc.would_send.body).toEqual({ timezone: "Europe/Berlin", future_field: 1 });
  });

  it("PATCH bodies treat every top-level field as optional", async () => {
    const r = await CLIENT.callTool({
      name: "action1_update_remediation",
      arguments: { cve_id: "CVE-2026-0001", remediation_id: "r1", body: {} },
    });
    expect(r.isError, JSON.stringify(r)).toBeFalsy();
  });

  it("POST bodies enforce the spec's required fields", async () => {
    const r = await CLIENT.callTool({
      name: "action1_request_enterprise_closure",
      arguments: { body: {} },
    });
    expect(r.isError).toBe(true);
  });

  it("action1_upload_software_chunk never sends a JSON body upstream (binary endpoint)", async () => {
    process.env.ACTION1_ALLOW_DESTRUCTIVE = "true";
    resetConfigCache();
    const r = await CLIENT.callTool({
      name: "action1_upload_software_chunk",
      arguments: {
        ...minimalArgs("action1_upload_software_chunk"),
        dry_run: false,
        confirm: "YES",
      },
    });
    expect(r.isError).toBe(true);
    const text = (r.content as { text: string }[])[0]!.text;
    expect(text).toMatch(/application\/octet-stream/);
    expect(upstreamCalls).toHaveLength(0);
  });
});

describe("generated read tools validate against their advertised outputSchema", () => {
  // The client validates structuredContent against outputSchema and turns
  // a mismatch into an error, so a successful call is the assertion.
  const cases: { tool: string; args: Json; upstream: unknown }[] = [
    {
      tool: "action1_get_me",
      args: {},
      upstream: { id: "u1", email: "a@example.test", timezone: null, extra: [1, 2] },
    },
    {
      tool: "action1_list_roles",
      args: {},
      upstream: { items: [{ id: "r1", name: "Admin", unknown_field: true }], total_items: 1 },
    },
    {
      tool: "action1_list_automation_schedules",
      args: {},
      upstream: { items: [{ id: "s1" }] },
    },
    { tool: "action1_get_role", args: { role_id: "r1" }, upstream: [1, 2, 3] },
    { tool: "action1_get_enterprise", args: {}, upstream: "plain text" },
  ];

  for (const c of cases) {
    it(`${c.tool} round-trips a stubbed upstream response`, async () => {
      nextBody = c.upstream;
      const r = await CLIENT.callTool({ name: c.tool, arguments: { ...c.args } });
      expect(r.isError, JSON.stringify(r).slice(0, 500)).toBeFalsy();
      expect(upstreamCalls.length).toBeGreaterThan(0);
    });
  }

  it("single-object read tools advertise the spec's top-level properties", () => {
    const tool = TOOLS.find((t) => t.name === "action1_get_role")!;
    const props = (tool.outputSchema as { properties?: Json }).properties ?? {};
    expect(Object.keys(props)).toContain("id");
  });
});
