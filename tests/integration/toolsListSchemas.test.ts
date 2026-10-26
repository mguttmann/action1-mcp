import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { connectHarness, setSweepEnv, type Harness } from "../helpers/mcpHarness.js";

// Properties of the advertised input schemas that clients validate
// against before a call reaches the server.

type Schema = Record<string, unknown>;
let H: Harness;
let TOOLS: Awaited<ReturnType<Harness["client"]["listTools"]>>["tools"];

beforeAll(async () => {
  setSweepEnv({});
  H = await connectHarness("tools-list-schemas");
  TOOLS = (await H.client.listTools()).tools;
}, 30_000);

afterAll(async () => {
  await H?.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function props(tool: (typeof TOOLS)[number]): Record<string, Schema> {
  return (tool.inputSchema.properties ?? {}) as Record<string, Schema>;
}

describe("published UUID patterns", () => {
  it("accept upper-case UUIDs like the server-side check", () => {
    const upper = "0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D";
    const lower = upper.toLowerCase();
    const checked: string[] = [];
    for (const tool of TOOLS) {
      for (const [name, schema] of Object.entries(props(tool))) {
        const pattern = schema.pattern;
        if (typeof pattern !== "string" || !pattern.includes("{8}-")) continue;
        // JSON Schema patterns carry no flags: what the string says is
        // what a strict client enforces.
        const re = new RegExp(pattern, "u");
        checked.push(`${tool.name}.${name}`);
        expect(re.test(lower), `${tool.name}.${name}`).toBe(true);
        expect(re.test(upper), `${tool.name}.${name}`).toBe(true);
      }
    }
    expect(checked.length).toBeGreaterThan(0);
  });
});

describe("generated paging inputs", () => {
  it("limit is an integer of at least 1 with an upper bound, from an integer of at least 0", () => {
    const limits: string[] = [];
    for (const tool of TOOLS) {
      const p = props(tool);
      if (!("auto_paginate" in p) && !(tool.name === "action1_search")) continue;
      if (p.limit) {
        limits.push(tool.name);
        expect(p.limit.type, `${tool.name}.limit`).toBe("integer");
        expect(p.limit.minimum, `${tool.name}.limit`).toBe(1);
        expect(typeof p.limit.maximum, `${tool.name}.limit`).toBe("number");
      }
      if (p.from) {
        expect(p.from.type, `${tool.name}.from`).toBe("integer");
        expect(p.from.minimum, `${tool.name}.from`).toBe(0);
      }
    }
    expect(limits.length).toBeGreaterThan(0);
  });

  it.each([[{ limit: -1 }], [{ limit: 0 }], [{ limit: 2.5 }], [{ from: -5 }], [{ from: 1.5 }]])(
    "rejects %j before any upstream call",
    async (args) => {
      const fetchSpy = vi.fn(async () => {
        throw new Error("no upstream call expected");
      });
      vi.stubGlobal("fetch", fetchSpy);
      const r = await H.client.callTool({ name: "action1_list_updates", arguments: args });
      expect(r.isError).toBe(true);
      const text = ((r.content as { text?: string }[])[0]?.text ?? "").toLowerCase();
      expect(text).toMatch(/limit|from/);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});

describe("tools/list size", () => {
  it("generated output schemas name the spec's response fields without bare type-name descriptions", async () => {
    const { GENERATED_TOOL_MANIFEST } = await import("../../src/tools/generated/index.js");
    const generated = new Set(GENERATED_TOOL_MANIFEST.map((t) => t.name));
    const tools = (await H.client.listTools()).tools.filter((t) => generated.has(t.name));
    expect(tools.length).toBeGreaterThan(0);
    const labelled: string[] = [];
    let documented = 0;
    const walk = (node: unknown, where: string): void => {
      if (Array.isArray(node)) return node.forEach((n) => walk(n, where));
      if (!node || typeof node !== "object") return;
      const obj = node as Record<string, unknown>;
      if (obj.properties && typeof obj.properties === "object") {
        for (const [k, v] of Object.entries(obj.properties as Record<string, unknown>)) {
          documented += 1;
          const d = (v as { description?: unknown }).description;
          const keys = Object.keys(v as object);
          // A schema whose only content is a type name as description
          // ({"description":"string"}) adds bytes but no contract.
          if (keys.length === 1 && typeof d === "string" && /^[a-z]+(?: \| [a-z]+)*$/.test(d)) {
            labelled.push(`${where}.${k}`);
          }
        }
      }
      for (const v of Object.values(obj)) walk(v, where);
    };
    for (const t of tools) walk(t.outputSchema, t.name);
    expect(documented).toBeGreaterThan(0);
    expect(labelled).toEqual([]);
  });
});
