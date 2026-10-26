import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  concretePath,
  connectHarness,
  FOREIGN_ORG,
  resultText,
  setSweepEnv,
  TEST_ORG,
  type Harness,
} from "../helpers/mcpHarness.js";
import { SPEC_OPERATIONS, stubSpecApi } from "../helpers/specStub.js";

// action1_raw_request over every HTTP method it accepts and every path
// template of the vendored spec. The method list comes from the tool's
// advertised input schema and the paths from the spec, so a new method
// or a new operation is swept without editing this file.
//
//   GET / HEAD   run free: one upstream call, no preview, no flags.
//   any other    is guarded: preview by default, refused without
//                ACTION1_ALLOW_DESTRUCTIVE, refused as an account
//                operation without ACTION1_ALLOW_ACCOUNT_OPS (every raw
//                write is one, its path is free-form), and sent exactly
//                once when allowed, also when the upstream answers 502.
//   allowlist    with ACTION1_ALLOWED_ORG_IDS set, every method on a
//                foreign org's path is refused before any request.

const FREE_METHODS = new Set(["GET", "HEAD"]);
const TEMPLATES = [...new Set(SPEC_OPERATIONS.map((op) => op.template))].sort();
const ORG_TEMPLATES = TEMPLATES.filter((t) => t.includes("{orgId}"));

let H: Harness;
let METHODS: string[];

beforeAll(async () => {
  setSweepEnv({});
  H = await connectHarness("raw-request-sweep");
  const { tools } = await H.client.listTools();
  const raw = tools.find((t) => t.name === "action1_raw_request")!;
  const props = (raw.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
  METHODS = props.method!.enum!;
}, 30_000);

afterAll(async () => {
  await H?.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setSweepEnv({});
});

async function raw(args: Record<string, unknown>) {
  return H.client.callTool({ name: "action1_raw_request", arguments: args });
}

describe("action1_raw_request method sweep", () => {
  it("accepts every method the spec uses, plus HEAD", () => {
    const specMethods = new Set(SPEC_OPERATIONS.map((op) => op.method));
    for (const m of [...specMethods, "HEAD"]) expect(METHODS, m).toContain(m);
    expect(METHODS.filter((m) => !FREE_METHODS.has(m)).length).toBeGreaterThan(0);
  });

  it("GET and HEAD reach every documented path once, without a preview", async () => {
    const problems: string[] = [];
    for (const method of METHODS.filter((m) => FREE_METHODS.has(m))) {
      for (const t of TEMPLATES) {
        const calls = stubSpecApi();
        const path = concretePath(t);
        const r = await raw({ method, path });
        const sc = r.structuredContent as Record<string, unknown> | undefined;
        if (calls.length !== 1 || calls[0]!.method !== method || sc?.dry_run === true) {
          problems.push(`${method} ${path}: calls=${calls.length} ${resultText(r).slice(0, 80)}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("every other method previews by default and sends nothing", async () => {
    const problems: string[] = [];
    for (const method of METHODS.filter((m) => !FREE_METHODS.has(m))) {
      for (const t of TEMPLATES) {
        const calls = stubSpecApi();
        const path = concretePath(t);
        const r = await raw({ method, path, body: { name: "x" } });
        const sc = r.structuredContent as {
          dry_run?: boolean;
          would_send?: { method?: string; path?: string };
        };
        if (
          r.isError ||
          sc?.dry_run !== true ||
          sc.would_send?.method !== method ||
          sc.would_send.path !== path ||
          calls.length !== 0
        ) {
          problems.push(`${method} ${path}: ${resultText(r).slice(0, 80)}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("every other method is refused without ACTION1_ALLOW_DESTRUCTIVE, even with confirm", async () => {
    const problems: string[] = [];
    for (const method of METHODS.filter((m) => !FREE_METHODS.has(m))) {
      for (const t of TEMPLATES) {
        const calls = stubSpecApi();
        const path = concretePath(t);
        const r = await raw({ method, path, dry_run: false, confirm: "YES" });
        if (!r.isError || !resultText(r).includes("ACTION1_ALLOW_DESTRUCTIVE") || calls.length) {
          problems.push(`${method} ${path}: ${resultText(r).slice(0, 80)}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("every other method is an account operation: refused without ACTION1_ALLOW_ACCOUNT_OPS", async () => {
    setSweepEnv({ ACTION1_ALLOW_DESTRUCTIVE: "true" });
    const problems: string[] = [];
    for (const method of METHODS.filter((m) => !FREE_METHODS.has(m))) {
      for (const t of TEMPLATES) {
        const calls = stubSpecApi();
        const path = concretePath(t);
        const r = await raw({ method, path, dry_run: false, confirm: "YES" });
        if (!r.isError || !resultText(r).includes("Refusing account operation") || calls.length) {
          problems.push(`${method} ${path}: ${resultText(r).slice(0, 80)}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("every other method still needs confirm when both switches are on", async () => {
    setSweepEnv({ ACTION1_ALLOW_DESTRUCTIVE: "true", ACTION1_ALLOW_ACCOUNT_OPS: "true" });
    const problems: string[] = [];
    for (const method of METHODS.filter((m) => !FREE_METHODS.has(m))) {
      const calls = stubSpecApi();
      const r = await raw({ method, path: concretePath(TEMPLATES[0]!), dry_run: false });
      if (!r.isError || !resultText(r).includes('confirm:"YES"') || calls.length) {
        problems.push(`${method}: ${resultText(r).slice(0, 80)}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("an allowed write is sent exactly once, also when the upstream answers 502", async () => {
    setSweepEnv({ ACTION1_ALLOW_DESTRUCTIVE: "true", ACTION1_ALLOW_ACCOUNT_OPS: "true" });
    const problems: string[] = [];
    for (const method of METHODS.filter((m) => !FREE_METHODS.has(m))) {
      for (const t of TEMPLATES) {
        const path = concretePath(t);
        for (const status of [200, 502]) {
          const calls = stubSpecApi({ status: () => status });
          const r = await raw({
            method,
            path,
            body: { name: "x" },
            dry_run: false,
            confirm: "YES",
          });
          const sent = calls.filter((c) => c.method === method && c.path === path);
          // A 502 is reported as an error, never retried for a write.
          if (calls.length !== 1 || sent.length !== 1 || (status === 502 && !r.isError)) {
            problems.push(`${method} ${path} (${status}): calls=${calls.length}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("action1_raw_request under ACTION1_ALLOWED_ORG_IDS", () => {
  it("has org-scoped spec paths to sweep", () => {
    expect(ORG_TEMPLATES.length).toBeGreaterThan(0);
  });

  it("refuses every method on a foreign org's path before any request (also previews)", async () => {
    setSweepEnv({
      ACTION1_ALLOWED_ORG_IDS: TEST_ORG,
      ACTION1_ALLOW_DESTRUCTIVE: "true",
      ACTION1_ALLOW_ACCOUNT_OPS: "true",
    });
    const problems: string[] = [];
    for (const method of METHODS) {
      for (const t of ORG_TEMPLATES) {
        const path = concretePath(t, FOREIGN_ORG);
        for (const extra of [{}, { dry_run: false, confirm: "YES" }]) {
          const calls = stubSpecApi();
          const r = await raw({ method, path, ...extra });
          if (!r.isError || !resultText(r).includes(FOREIGN_ORG) || calls.length !== 0) {
            problems.push(
              `${method} ${path} ${JSON.stringify(extra)}: ${resultText(r).slice(0, 80)}`,
            );
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("refuses a foreign org in the query, in the path's query string and in the body", async () => {
    setSweepEnv({
      ACTION1_ALLOWED_ORG_IDS: TEST_ORG,
      ACTION1_ALLOW_DESTRUCTIVE: "true",
      ACTION1_ALLOW_ACCOUNT_OPS: "true",
    });
    // An allowed org in the path, so only the payload can be at fault.
    const path = concretePath(ORG_TEMPLATES[0]!);
    const cases: { name: string; args: Record<string, unknown>; allowed: boolean }[] = [];
    for (const [key, org, allowed] of [
      ["organization_id", FOREIGN_ORG, false],
      ["orgId", FOREIGN_ORG, false],
      ["organization_id", TEST_ORG, true],
    ] as const) {
      cases.push(
        {
          name: `query ${key}=${org}`,
          args: { method: "GET", path, query: { [key]: org } },
          allowed,
        },
        {
          name: `path ?${key}=${org}`,
          args: { method: "GET", path: `${path}?${key}=${org}` },
          allowed,
        },
        {
          name: `body ${key}=${org}`,
          args: { method: "POST", path, body: { [key]: org }, dry_run: false, confirm: "YES" },
          allowed,
        },
      );
    }
    const problems: string[] = [];
    for (const c of cases) {
      const calls = stubSpecApi();
      const r = await raw(c.args);
      const refused = r.isError === true && resultText(r).includes(FOREIGN_ORG);
      // The allowed org reaches Action1 once; a foreign one is refused
      // before any request.
      if (c.allowed ? calls.length !== 1 || r.isError : !refused || calls.length !== 0) {
        problems.push(`${c.name}: calls=${calls.length} ${resultText(r).slice(0, 80)}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("reads the allowed org's paths, and refuses a path that matches no documented template", async () => {
    setSweepEnv({ ACTION1_ALLOWED_ORG_IDS: TEST_ORG });
    const problems: string[] = [];
    for (const t of ORG_TEMPLATES) {
      const calls = stubSpecApi();
      const r = await raw({ method: "GET", path: concretePath(t) });
      if (calls.length !== 1) problems.push(`GET ${t}: ${resultText(r).slice(0, 80)}`);
    }
    expect(problems).toEqual([]);
    const calls = stubSpecApi();
    const r = await raw({ method: "GET", path: `/undocumented/${FOREIGN_ORG}` });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
