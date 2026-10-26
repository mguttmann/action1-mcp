import type { Tool } from "@modelcontextprotocol/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GENERATED_TOOL_MANIFEST } from "../../src/tools/generated/index.js";
import { connectHarness, resultText, setSweepEnv, type Harness } from "../helpers/mcpHarness.js";
import { finishAutomations, stubSpecApi, type SpecStubOptions } from "../helpers/specStub.js";
import { sweepToolArgs } from "../helpers/toolArgs.js";

// ACTION1_REDACT_PII over the whole registry: every read tool, every
// executed write tool, every resource and every upstream error text.
// The fake API answers with the spec's documented records and adds
// personal-data fields (names the spec uses for e-mail, IPs, addresses,
// logged-in user, Active Directory placement, MAC and serial) with
// sentinel values to every object of the answer.
//
// Each output is read twice: with redaction off it shows which tools
// echo the injected fields (a control that the sweep reaches them),
// with redaction on no sentinel may appear in text or structured
// content. The key set itself is held against the spec in pii.test.ts.

const PII_FIELDS = [
  "email",
  "customer_email",
  "closure_requested_by",
  "address",
  "external_address",
  "current_ip",
  "user",
  "AD_organization_unit",
  "AD_security_groups",
  "MAC",
  "serial",
  // Column display names, as report rows carry them in `fields`.
  "User Name",
  "IP Address",
  "Logged On User",
];
const SENTINEL = "pii-sentinel";

function injectPii(value: unknown, depth = 0): unknown {
  if (depth > 12 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => injectPii(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = injectPii(v, depth + 1);
  }
  for (const k of PII_FIELDS) out[k] = `${SENTINEL}-${k}`;
  return out;
}

const PII_API: SpecStubOptions = {
  transform: (body, call) => injectPii(finishAutomations(body, call)),
};

const MANIFEST = new Map(GENERATED_TOOL_MANIFEST.map((m) => [m.name, m]));

let H: Harness;
let TOOLS: Tool[];

beforeAll(async () => {
  setSweepEnv({});
  H = await connectHarness("pii-sweep");
  TOOLS = (await H.client.listTools()).tools;
}, 30_000);

afterAll(async () => {
  await H?.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setSweepEnv({});
});

const readTools = (): Tool[] => TOOLS.filter((t) => t.annotations?.readOnlyHint === true);
const writeTools = (): Tool[] =>
  TOOLS.filter(
    (t) => t.annotations?.destructiveHint === true && MANIFEST.get(t.name)?.unsupported !== true,
  );

interface Seen {
  name: string;
  output: string;
  isError: boolean;
  calls: number;
}

async function callAll(
  tools: Tool[],
  api: SpecStubOptions,
  extra: Record<string, unknown> = {},
): Promise<Seen[]> {
  const out: Seen[] = [];
  for (const t of tools) {
    const calls = stubSpecApi(api);
    const r = await H.client.callTool({
      name: t.name,
      arguments: { ...sweepToolArgs(t), ...extra },
    });
    out.push({
      name: t.name,
      output: JSON.stringify(r.content) + JSON.stringify(r.structuredContent ?? null),
      isError: r.isError === true,
      calls: calls.length,
    });
  }
  return out;
}

async function readAllResources(): Promise<{ uri: string; output: string }[]> {
  const { resources } = await H.client.listResources();
  const { resourceTemplates } = await H.client.listResourceTemplates();
  const uris = [
    ...resources.map((r) => r.uri),
    ...resourceTemplates.map((t) => t.uriTemplate.replace(/\{[^}]+\}/g, "default")),
  ];
  const out: { uri: string; output: string }[] = [];
  for (const uri of uris) {
    stubSpecApi(PII_API);
    const r = await H.client.readResource({ uri });
    out.push({ uri, output: JSON.stringify(r.contents) });
  }
  return out;
}

const leaks = <T extends { output: string }>(seen: T[]): T[] =>
  seen.filter((s) => s.output.includes(SENTINEL));

describe("ACTION1_REDACT_PII over every read tool", () => {
  it("every read tool succeeds against the spec answers and calls Action1", async () => {
    const seen = await callAll(readTools(), PII_API);
    const bad = seen.filter((s) => s.isError || s.calls === 0).map((s) => s.name);
    expect(bad).toEqual([]);
  });

  it("without redaction the sweep reaches personal data (control)", async () => {
    const echoed = leaks(await callAll(readTools(), PII_API)).map((s) => s.name);
    for (const name of ["action1_get_endpoint", "action1_get_me", "action1_audit_log_search"]) {
      expect(echoed).toContain(name);
    }
  });

  it("with redaction no read tool returns a personal-data value", async () => {
    setSweepEnv({ ACTION1_REDACT_PII: "true" });
    expect(leaks(await callAll(readTools(), PII_API)).map((s) => s.name)).toEqual([]);
  });

  it("with redaction no upstream error text returns a personal-data value", async () => {
    setSweepEnv({ ACTION1_REDACT_PII: "true" });
    const api: SpecStubOptions = {
      status: () => 409,
      errorBody: () => injectPii({ type: "Error", status: 409, developer_message: "conflict" }),
    };
    const seen = await callAll(readTools(), api);
    expect(seen.filter((s) => !s.isError).map((s) => s.name)).toEqual([]);
    expect(leaks(seen).map((s) => s.name)).toEqual([]);
  });
});

describe("ACTION1_REDACT_PII over every executed write tool", () => {
  const execute = { dry_run: false, confirm: "YES" };

  it("without redaction the sweep reaches personal data (control)", async () => {
    setSweepEnv({ ACTION1_ALLOW_DESTRUCTIVE: "true", ACTION1_ALLOW_ACCOUNT_OPS: "true" });
    const echoed = leaks(await callAll(writeTools(), PII_API, execute));
    expect(echoed.length).toBeGreaterThan(0);
  });

  it("with redaction no executed write returns a personal-data value", async () => {
    setSweepEnv({
      ACTION1_ALLOW_DESTRUCTIVE: "true",
      ACTION1_ALLOW_ACCOUNT_OPS: "true",
      ACTION1_REDACT_PII: "true",
    });
    const seen = await callAll(writeTools(), PII_API, execute);
    expect(seen.filter((s) => s.calls === 0).map((s) => s.name)).toEqual([]);
    expect(leaks(seen).map((s) => s.name)).toEqual([]);
  });
});

describe("ACTION1_REDACT_PII over every resource", () => {
  it("without redaction the resources carry personal data (control)", async () => {
    const all = await readAllResources();
    expect(all.length).toBeGreaterThan(0);
    expect(
      leaks(all)
        .map((r) => r.uri)
        .sort(),
    ).toEqual(all.map((r) => r.uri).sort());
  });

  it("with redaction no resource returns a personal-data value", async () => {
    setSweepEnv({ ACTION1_REDACT_PII: "true" });
    expect(leaks(await readAllResources()).map((r) => r.uri)).toEqual([]);
  });
});

describe("the sweep's own fixture", () => {
  it("injects into nested objects and arrays", () => {
    const out = JSON.stringify(injectPii({ items: [{ a: { b: 1 } }] }));
    expect(out.match(new RegExp(`${SENTINEL}-email`, "g"))?.length).toBe(3);
    expect(resultText({ content: [{ text: "x" }] })).toBe("x");
  });
});
