import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetConfigCache } from "../../src/config.js";

// Compatibility guard for existing MCP consumers (e.g. a gateway that
// proxies these tools by name). The baseline was captured from the
// v0.5.0 build with `node scripts/tools-list-snapshot.mjs --write
// tests/fixtures/tools-list.baseline.json`. Additions are fine: new
// tools, optional input properties, annotation keys, output schemas,
// resources and prompts (with optional arguments). Breaking changes fail
// here: a removed or renamed baseline tool or input property, a new
// required input property, a changed baseline annotation, a dropped
// output schema, a removed resource, resource template or prompt, a
// removed prompt argument and a new required prompt argument.

interface BaselineTool {
  name: string;
  inputProperties: string[];
  required: string[];
  annotations: Record<string, unknown>;
  hasOutputSchema: boolean;
}

interface Baseline {
  tools: BaselineTool[];
  resources: string[];
  resourceTemplates: string[];
  prompts: { name: string; arguments: string[] }[];
}

const baseline = JSON.parse(
  readFileSync(new URL("../fixtures/tools-list.baseline.json", import.meta.url), "utf8"),
) as Baseline;

let CLIENT: import("@modelcontextprotocol/client").Client;
let SERVER: ReturnType<typeof import("../../src/server.js").buildServer>;

beforeAll(async () => {
  process.env.ACTION1_BASE_URL = "https://127.0.0.1:1/api/3.0";
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
  CLIENT = new Client({ name: "baseline-test", version: "0.0.0" });
  await CLIENT.connect(clientTx);
}, 30_000);

afterAll(async () => {
  await CLIENT?.close();
  await SERVER?.server.close();
});

describe("tools/list stays compatible with the v0.5.0 baseline", () => {
  it("baseline fixture is non-trivial", () => {
    expect(baseline.tools.length).toBeGreaterThan(0);
  });

  it("every baseline tool and every baseline input property is still exposed", async () => {
    const { tools } = await CLIENT.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    const missingTools: string[] = [];
    const missingProps: string[] = [];
    for (const b of baseline.tools) {
      const live = byName.get(b.name);
      if (!live) {
        missingTools.push(b.name);
        continue;
      }
      const props = Object.keys(
        (live.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      for (const p of b.inputProperties) {
        if (!props.includes(p)) missingProps.push(`${b.name}.${p}`);
      }
    }
    expect(missingTools).toEqual([]);
    expect(missingProps).toEqual([]);
  });

  it("adds no required input property and keeps annotations and output schemas", async () => {
    const { tools } = await CLIENT.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    const problems: string[] = [];
    for (const b of baseline.tools) {
      const live = byName.get(b.name);
      if (!live) continue; // reported by the test above
      const required = (live.inputSchema as { required?: string[] }).required ?? [];
      for (const r of required) {
        if (!b.required.includes(r)) problems.push(`${b.name}: new required input ${r}`);
      }
      const annotations = (live.annotations ?? {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(b.annotations)) {
        if (annotations[key] !== value) {
          problems.push(
            `${b.name}: annotation ${key} ${JSON.stringify(value)} -> ${JSON.stringify(annotations[key])}`,
          );
        }
      }
      if (b.hasOutputSchema && !live.outputSchema)
        problems.push(`${b.name}: output schema dropped`);
    }
    expect(problems).toEqual([]);
  });

  it("keeps every baseline resource, resource template and prompt argument", async () => {
    const resources = (await CLIENT.listResources()).resources.map((r) => r.uri);
    const templates = (await CLIENT.listResourceTemplates()).resourceTemplates.map(
      (t) => t.uriTemplate,
    );
    const prompts = new Map((await CLIENT.listPrompts()).prompts.map((p) => [p.name, p]));
    const problems: string[] = [];
    for (const uri of baseline.resources) {
      if (!resources.includes(uri)) problems.push(`resource ${uri} missing`);
    }
    for (const uri of baseline.resourceTemplates) {
      if (!templates.includes(uri)) problems.push(`resource template ${uri} missing`);
    }
    for (const b of baseline.prompts) {
      const live = prompts.get(b.name);
      if (!live) {
        problems.push(`prompt ${b.name} missing`);
        continue;
      }
      const args = live.arguments ?? [];
      for (const a of b.arguments) {
        if (!args.some((x) => x.name === a))
          problems.push(`prompt ${b.name}: argument ${a} missing`);
      }
      for (const a of args) {
        if (a.required && !b.arguments.includes(a.name)) {
          problems.push(`prompt ${b.name}: new required argument ${a.name}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
