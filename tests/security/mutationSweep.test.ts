import type { Tool } from "@modelcontextprotocol/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GENERATED_TOOL_MANIFEST } from "../../src/tools/generated/index.js";
import {
  connectHarness,
  FOREIGN_ORG,
  resultText,
  setSweepEnv,
  TEST_ORG,
  type Harness,
} from "../helpers/mcpHarness.js";
import { finishAutomations, specOperationFor, stubSpecApi } from "../helpers/specStub.js";
import { sweepToolArgs } from "../helpers/toolArgs.js";

// Every state-changing tool of the registry (curated and generated,
// selected by destructiveHint from tools/list), executed with both
// guard switches on against the spec-backed fake API:
//
//   - the state-changing request is sent exactly once, also when the
//     upstream answers 502 (a write is never retried after it may have
//     reached Action1);
//   - generated tools send it to the documented operation of their
//     manifest entry, and a documented 200 answer validates against the
//     advertised output schema (the client checks structuredContent).
//
// And every tool with an `org_id` argument, read or write, refuses an
// organization outside ACTION1_ALLOWED_ORG_IDS before any request.
// action1_raw_request has its own sweep (rawRequestSweep.test.ts).

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const MANIFEST = new Map(GENERATED_TOOL_MANIFEST.map((m) => [m.name, m]));

let H: Harness;
let TOOLS: Tool[];

beforeAll(async () => {
  setSweepEnv({});
  H = await connectHarness("mutation-sweep");
  TOOLS = (await H.client.listTools()).tools;
}, 30_000);

afterAll(async () => {
  await H?.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setSweepEnv({});
});

/** Destructive tools that can execute (unsupported generated operations always refuse). */
function executableWriteTools(): Tool[] {
  return TOOLS.filter(
    (t) =>
      t.annotations?.destructiveHint === true &&
      t.name !== "action1_raw_request" &&
      MANIFEST.get(t.name)?.unsupported !== true,
  );
}

describe("every state-changing tool, executed", () => {
  it("covers curated and generated tools", () => {
    const names = executableWriteTools().map((t) => t.name);
    expect(names.some((n) => MANIFEST.has(n))).toBe(true);
    expect(names.some((n) => !MANIFEST.has(n))).toBe(true);
  });

  it("sends the write exactly once when the upstream answers 502", async () => {
    setSweepEnv({ ACTION1_ALLOW_DESTRUCTIVE: "true", ACTION1_ALLOW_ACCOUNT_OPS: "true" });
    const problems: string[] = [];
    for (const t of executableWriteTools()) {
      // Pre-flight reads (endpoint lookup, platform detection) answer
      // normally; only the write fails.
      const calls = stubSpecApi({
        status: (c) => (WRITE_METHODS.has(c.method) ? 502 : undefined),
        transform: finishAutomations,
      });
      const r = await H.client.callTool({
        name: t.name,
        arguments: { ...sweepToolArgs(t), dry_run: false, confirm: "YES" },
      });
      const writes = calls.filter((c) => WRITE_METHODS.has(c.method));
      if (writes.length !== 1 || !r.isError) {
        problems.push(`${t.name}: writes=${writes.length} ${resultText(r).slice(0, 100)}`);
      }
    }
    expect(problems).toEqual([]);
  }, 60_000);

  it("sends the write once to a documented operation and returns a schema-valid result", async () => {
    setSweepEnv({ ACTION1_ALLOW_DESTRUCTIVE: "true", ACTION1_ALLOW_ACCOUNT_OPS: "true" });
    const problems: string[] = [];
    for (const t of executableWriteTools()) {
      const calls = stubSpecApi({ transform: finishAutomations });
      let r;
      try {
        r = await H.client.callTool({
          name: t.name,
          arguments: { ...sweepToolArgs(t), dry_run: false, confirm: "YES" },
        });
      } catch (err) {
        problems.push(`${t.name}: ${String(err).slice(0, 160)}`);
        continue;
      }
      const writes = calls.filter((c) => WRITE_METHODS.has(c.method));
      const undocumented = calls.filter((c) => c.template === undefined && !c.knownUndocumented);
      const meta = MANIFEST.get(t.name);
      const wrongOp =
        meta !== undefined &&
        (writes[0]?.method !== meta.method ||
          specOperationFor(writes[0].method, writes[0].path)?.template !== meta.path);
      if (r.isError || writes.length !== 1 || undocumented.length > 0 || wrongOp) {
        problems.push(
          `${t.name}: writes=${writes.length} undocumented=${undocumented.map((c) => c.path).join(",")} ${resultText(r).slice(0, 100)}`,
        );
      }
    }
    expect(problems).toEqual([]);
  }, 60_000);
});

describe("ACTION1_ALLOWED_ORG_IDS over every tool with an org_id argument", () => {
  const withOrgArg = (): Tool[] =>
    TOOLS.filter((t) => {
      const props = (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      return "org_id" in props && MANIFEST.get(t.name)?.unsupported !== true;
    });

  it("covers read and write tools", () => {
    const tools = withOrgArg();
    expect(tools.some((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.some((t) => t.annotations?.destructiveHint === true)).toBe(true);
  });

  it("refuses a foreign org before any request (previews and executions alike)", async () => {
    setSweepEnv({
      ACTION1_ALLOWED_ORG_IDS: TEST_ORG,
      ACTION1_ALLOW_DESTRUCTIVE: "true",
      ACTION1_ALLOW_ACCOUNT_OPS: "true",
    });
    const problems: string[] = [];
    for (const t of withOrgArg()) {
      const modes =
        t.annotations?.destructiveHint === true ? [{}, { dry_run: false, confirm: "YES" }] : [{}];
      for (const mode of modes) {
        const calls = stubSpecApi();
        const r = await H.client.callTool({
          name: t.name,
          arguments: { ...sweepToolArgs(t), ...mode, org_id: FOREIGN_ORG },
        });
        if (!r.isError || !resultText(r).includes(FOREIGN_ORG) || calls.length !== 0) {
          problems.push(
            `${t.name} ${JSON.stringify(mode)}: calls=${calls.length} ${resultText(r).slice(0, 100)}`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
