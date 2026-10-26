import { readFileSync } from "node:fs";
import type { Tool } from "@modelcontextprotocol/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GENERATED_TOOL_MANIFEST } from "../../src/tools/generated/index.js";
import { connectHarness, resultText, setSweepEnv, type Harness } from "../helpers/mcpHarness.js";
import { specExample } from "../helpers/specFixtures.js";
import {
  finishAutomations,
  KNOWN_UNDOCUMENTED_ALIASES,
  stubSpecApi,
  type StubCall,
} from "../helpers/specStub.js";
import { sweepToolArgs } from "../helpers/toolArgs.js";

// Schema smoke over the whole registry without a live tenant: every tool
// from tools/list is called with minimal arguments (in every
// response_format it offers) against a fake API that answers each
// documented operation with a record of its spec response schema. The
// client validates every structuredContent against the tool's advertised
// outputSchema and throws on a mismatch, so a call that returns is
// schema-valid. Destructive tools are called without dry_run and so
// return their preview; their executed results are validated in
// tests/security/mutationSweep.test.ts.

const MANIFEST = new Map(GENERATED_TOOL_MANIFEST.map((m) => [m.name, m]));

let H: Harness;
let TOOLS: Tool[];

beforeAll(async () => {
  setSweepEnv({});
  H = await connectHarness("tool-smoke");
  TOOLS = (await H.client.listTools()).tools;
}, 30_000);

afterAll(async () => {
  await H?.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setSweepEnv({});
});

function formatsOf(tool: Tool): (string | undefined)[] {
  const props = (tool.inputSchema as { properties?: Record<string, { enum?: string[] }> })
    .properties;
  return props?.response_format?.enum ?? [undefined];
}

describe("schema smoke over every tool", () => {
  const calls: StubCall[] = [];

  it("every tool answers a minimal call with a schema-valid result", async () => {
    const problems: string[] = [];
    for (const t of TOOLS) {
      for (const format of formatsOf(t)) {
        const seen = stubSpecApi({ transform: finishAutomations });
        const args = { ...sweepToolArgs(t), ...(format ? { response_format: format } : {}) };
        try {
          const r = await H.client.callTool({ name: t.name, arguments: args });
          // Operations the server cannot send (binary uploads) refuse.
          const expectError = MANIFEST.get(t.name)?.unsupported === true;
          if (Boolean(r.isError) !== expectError) {
            problems.push(`${t.name} (${format ?? "-"}): ${resultText(r).slice(0, 120)}`);
          }
        } catch (err) {
          problems.push(`${t.name} (${format ?? "-"}): ${String(err).slice(0, 200)}`);
        }
        calls.push(...seen);
      }
    }
    expect(problems).toEqual([]);
  }, 60_000);

  it("tools only call documented operations or the listed known-undocumented endpoints", () => {
    expect(calls.length).toBeGreaterThan(0);
    const undocumented = calls
      .filter((c) => c.template === undefined && c.knownUndocumented === undefined)
      .map((c) => `${c.method} ${c.path}`);
    expect(undocumented).toEqual([]);
  });

  it("the fake API knows exactly the endpoints of known-undocumented-endpoints.json", () => {
    const file = JSON.parse(
      readFileSync(
        new URL("../../src/codegen/spec/known-undocumented-endpoints.json", import.meta.url),
        "utf8",
      ),
    ) as { endpoints: { method: string; path: string }[] };
    expect(Object.keys(KNOWN_UNDOCUMENTED_ALIASES).sort()).toEqual(
      file.endpoints.map((e) => `${e.method} ${e.path}`).sort(),
    );
  });
});

describe("every resource reads against the spec answers", () => {
  it("returns JSON built from the documented records", async () => {
    const { resources } = await H.client.listResources();
    const { resourceTemplates } = await H.client.listResourceTemplates();
    const uris = [
      ...resources.map((r) => r.uri),
      ...resourceTemplates.map((t) => t.uriTemplate.replace(/\{[^}]+\}/g, "default")),
    ];
    expect(uris.length).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const uri of uris) {
      const seen = stubSpecApi();
      const r = await H.client.readResource({ uri });
      const body = JSON.parse((r.contents[0] as { text: string }).text) as Record<string, unknown>;
      const listShaped = Array.isArray(body.items);
      if (
        seen.length === 0 ||
        seen.some((c) => c.template === undefined) ||
        (listShaped && (body.items as unknown[]).length !== body.count) ||
        (listShaped && (body.items as unknown[]).length === 0)
      ) {
        problems.push(`${uri}: ${JSON.stringify(body).slice(0, 120)}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("action template tools (spec-shaped records)", () => {
  const TEMPLATE = specExample("ActionTemplate", { id: "run_powershell", name: "Run PowerShell" });

  it("action1_list_action_templates lists the documented records and forwards applicable_to", async () => {
    const seen = stubSpecApi({ transform: () => ({ items: [TEMPLATE] }) });
    const r = await H.client.callTool({
      name: "action1_list_action_templates",
      arguments: { applicable_to: "/API/installed-software", response_format: "json" },
    });
    expect(r.isError ?? false, resultText(r)).toBe(false);
    const sc = r.structuredContent as { items: Record<string, unknown>[]; count: number };
    expect(sc.count).toBe(1);
    expect(sc.items[0]).toMatchObject({ id: "run_powershell", name: "Run PowerShell" });
    expect(seen[0]!.template).toBe("/automations/action-templates");
    expect(seen[0]!.query.get("applicable_to")).toBe("/API/installed-software");
  });

  it("action1_list_action_templates renders the records as a Markdown table", async () => {
    stubSpecApi({ transform: () => ({ items: [TEMPLATE] }) });
    const r = await H.client.callTool({
      name: "action1_list_action_templates",
      arguments: { response_format: "markdown" },
    });
    expect(resultText(r)).toContain("| id | name |");
    expect(resultText(r)).toContain("run\\_powershell | Run PowerShell");
  });

  it("action1_get_action_template fetches one documented record by id", async () => {
    const seen = stubSpecApi({ transform: () => TEMPLATE });
    const r = await H.client.callTool({
      name: "action1_get_action_template",
      arguments: { template_id: "run_powershell" },
    });
    expect(r.isError ?? false, resultText(r)).toBe(false);
    expect(seen.map((c) => c.path)).toEqual(["/automations/action-templates/run_powershell"]);
    expect(seen[0]!.template).toBe("/automations/action-templates/{templateId}");
    const sc = r.structuredContent as { template: Record<string, unknown> };
    expect(sc.template).toMatchObject({ id: "run_powershell", type: "ActionTemplate" });
  });

  it("action1_get_action_template reports an upstream 404 as a tool error", async () => {
    stubSpecApi({ status: () => 404 });
    const r = await H.client.callTool({
      name: "action1_get_action_template",
      arguments: { template_id: "nope" },
    });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toContain("404");
  });
});
