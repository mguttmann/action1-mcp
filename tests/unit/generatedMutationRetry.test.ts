import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { Action1Client } from "../../src/client/action1Client.js";
import { loadConfig, resetConfigCache } from "../../src/config.js";
import { registerGeneratedTools } from "../../src/tools/generated/index.js";

// Every generated non-GET tool must hit the upstream exactly once when
// the upstream answers 502: the server may already have executed the
// mutation, so an automatic retry could run it twice. The test walks the
// REAL generated registry, fills each tool's required arguments from its
// own input schema and drives the real runGenerated -> Action1Client path
// against a mocked fetch.

interface Captured {
  name: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  handler: (args: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
}

const CANDIDATES: unknown[] = [
  "00000000-0000-0000-0000-0000000000aa",
  "2026-01-01T00:00:00Z",
  1,
  true,
  {},
  [],
];

/** Minimal value for a JSON Schema (typed request bodies from the codegen). */
function sample(schema: Record<string, unknown> | undefined): unknown {
  if (!schema || Object.keys(schema).length === 0) return "x";
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  for (const k of ["anyOf", "oneOf"] as const) {
    const alts = schema[k];
    if (Array.isArray(alts)) return sample(alts[0] as Record<string, unknown>);
  }
  if (Array.isArray(schema.allOf)) {
    return Object.assign({}, ...schema.allOf.map((s) => sample(s as Record<string, unknown>)));
  }
  const type = Array.isArray(schema.type)
    ? (schema.type as string[]).find((t) => t !== "null")
    : (schema.type as string | undefined);
  switch (type) {
    case "object": {
      const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const out: Record<string, unknown> = {};
      for (const k of (schema.required ?? []) as string[]) out[k] = sample(props[k]);
      return out;
    }
    case "array":
      return [sample(schema.items as Record<string, unknown>)];
    case "integer":
    case "number":
      return 1;
    case "boolean":
      return true;
    default:
      if (schema.format === "uuid") return "00000000-0000-4000-8000-000000000001";
      if (schema.format === "date-time") return "2026-01-01T00:00:00Z";
      return "x";
  }
}

function fillRequired(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const args: Record<string, unknown> = { confirm: "YES", dry_run: false };
  for (const [key, field] of Object.entries(schema.shape)) {
    if (key in args) continue;
    const f = field as z.ZodType;
    if (f.safeParse(undefined).success) continue; // optional
    const options = (f as unknown as { options?: unknown[] }).options;
    const candidates = Array.isArray(options) ? [...options, ...CANDIDATES] : CANDIDATES;
    let hit = candidates.find((c) => f.safeParse(c).success);
    if (hit === undefined) {
      const fromSchema = sample(z.toJSONSchema(f, { io: "input" }));
      if (f.safeParse(fromSchema).success) hit = fromSchema;
    }
    if (hit === undefined) throw new Error(`cannot fill required arg ${key}`);
    args[key] = hit;
  }
  return args;
}

let tools: Captured[] = [];
let client: Action1Client;

beforeAll(() => {
  process.env.ACTION1_BASE_URL = "https://example.test/api/3.0";
  process.env.ACTION1_CLIENT_ID = "client";
  process.env.ACTION1_CLIENT_SECRET = "secret";
  process.env.ACTION1_ORG_ID = "00000000-0000-0000-0000-000000000001";
  process.env.ACTION1_ALLOW_DESTRUCTIVE = "true";
  resetConfigCache();
  const fakeServer = {
    registerTool: (name: string, config: { inputSchema: unknown }, handler: unknown) => {
      tools.push({
        name,
        inputSchema: config.inputSchema as z.ZodObject<z.ZodRawShape>,
        handler: handler as Captured["handler"],
      });
    },
  };
  client = new Action1Client(loadConfig());
  registerGeneratedTools(fakeServer as unknown as McpServer, client);
});

afterAll(() => {
  delete process.env.ACTION1_ALLOW_DESTRUCTIVE;
  resetConfigCache();
  vi.unstubAllGlobals();
  tools = [];
});

describe("generated mutations are never auto-retried on 5xx", () => {
  it("every generated non-GET tool sends exactly one request against a 502 upstream", async () => {
    const methodsSeen = new Map<string, string[]>();
    let apiCalls: { method: string; url: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (url.endsWith("/oauth2/token")) {
          return new Response(JSON.stringify({ access_token: "tkn", expires_in: 3600 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        apiCalls.push({ method: init.method ?? "GET", url });
        return new Response("bad gateway", { status: 502 });
      }),
    );

    let mutatingTools = 0;
    for (const tool of tools) {
      // GET tools retry by design (with backoff), so skip the ones whose
      // schema has neither a destructive guard nor a body: those are the
      // generated GET/HEAD shapes. Anything else is driven and its method
      // is read from the recorded request.
      const isGetShape =
        !("confirm" in tool.inputSchema.shape) && !("body" in tool.inputSchema.shape);
      if (isGetShape) continue;
      apiCalls = [];
      const args = fillRequired(tool.inputSchema);
      const result = (await tool.handler(args, {
        mcpReq: { signal: new AbortController().signal },
      })) as { isError?: boolean; content: { text: string }[] };
      const method = apiCalls[0]?.method ?? "NONE";
      if (method === "GET") continue;
      if (method === "NONE") {
        // Operations the runtime cannot send (binary or header-driven
        // upload) refuse without any request; nothing can be duplicated.
        expect(result.isError, `${tool.name}: ${result.content[0]?.text}`).toBe(true);
        continue;
      }
      mutatingTools += 1;
      methodsSeen.set(method, [...(methodsSeen.get(method) ?? []), tool.name]);
      expect(result.isError, `${tool.name}: ${result.content[0]?.text}`).toBe(true);
      expect(apiCalls.length, `${tool.name} (${method}) fetch count`).toBe(1);
    }
    // Guard against a vacuous pass: the registry must actually contain
    // POST tools, and at least the other mutating verbs it is known to have.
    expect(methodsSeen.get("POST")?.length ?? 0).toBeGreaterThan(0);
    expect(methodsSeen.get("PATCH")?.length ?? 0).toBeGreaterThan(0);
    expect(methodsSeen.get("DELETE")?.length ?? 0).toBeGreaterThan(0);
    expect(mutatingTools).toBeGreaterThan(0);
  }, 60_000);
});
