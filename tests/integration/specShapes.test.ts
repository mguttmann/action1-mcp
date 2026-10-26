import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../../src/config.js";
import { specExample } from "../helpers/specFixtures.js";

// Curated tools against records shaped like the vendored OpenAPI spec.
// Every fixture comes from `specExample` (tests/helpers/specFixtures.ts),
// so field names and enum values are the spec's, not the test author's.
// A few cases also feed the shape the tools assumed before (legacy
// fields) to prove the readers accept both.
//
// The fake API answers list routes with the documented ResultPage
// envelope (`items`, `total_items`, `next_page`) and can cap the page
// size below the requested `limit`, as a server is allowed to.

const ORG = "00000000-0000-0000-0000-000000000001";
const EP = "00000000-0000-4000-8000-0000000000e1";

let SERVER: ReturnType<typeof import("../../src/server.js").buildServer>;
let CLIENT: import("@modelcontextprotocol/client").Client;

beforeAll(async () => {
  process.env.ACTION1_BASE_URL = "https://app.eu.action1.test/api/3.0";
  process.env.ACTION1_CLIENT_ID = "client-id-test";
  process.env.ACTION1_CLIENT_SECRET = "client-secret-test";
  process.env.ACTION1_ORG_ID = ORG;
  resetConfigCache();
  const { buildServer } = await import("../../src/server.js");
  const { Client } = await import("@modelcontextprotocol/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/server");
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  SERVER = buildServer();
  await SERVER.server.connect(serverTx);
  CLIENT = new Client({ name: "spec-shapes", version: "0.0.0" }, { capabilities: {} });
  await CLIENT.connect(clientTx);
}, 30_000);

afterAll(async () => {
  if (CLIENT) await CLIENT.close();
  if (SERVER?.server) await SERVER.server.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Route {
  path: RegExp;
  /** Full data set; served as ResultPage slices honouring from/limit. */
  all?: unknown[];
  /** Server-side page size cap (the server returns at most this many). */
  cap?: number;
  body?: unknown;
  status?: number;
}

interface Seen {
  path: string;
  query: URLSearchParams;
}

function stubApi(routes: Route[]): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input.endsWith("/oauth2/token")) {
        return Response.json({ access_token: "tkn", expires_in: 3600 });
      }
      const url = new URL(input);
      const path = url.pathname.replace(/^\/api\/3\.0/, "");
      seen.push({ path, query: url.searchParams });
      for (const r of routes) {
        if (!r.path.test(path)) continue;
        if (r.status && r.status >= 400) {
          return Response.json({ error: "stub error" }, { status: r.status });
        }
        if (r.all) {
          const from = Number(url.searchParams.get("from") ?? 0);
          const asked = Number(url.searchParams.get("limit") ?? 50);
          const limit = Math.min(asked, r.cap ?? asked);
          const items = r.all.slice(from, from + limit);
          const next = from + items.length < r.all.length;
          return Response.json({
            type: "ResultPage",
            items,
            total_items: String(r.all.length),
            limit: String(limit),
            next_page: next ? `${path}?limit=${limit}&from=${from + items.length}` : "",
            prev_page: "",
          });
        }
        return Response.json(r.body ?? {});
      }
      return Response.json({ error: "no route", path }, { status: 404 });
    }),
  );
  return seen;
}

type CallResult = Awaited<ReturnType<typeof CLIENT.callTool>>;
const textOf = (r: CallResult) => (r.content as { type: string; text: string }[])[0]!.text;
const scOf = (r: CallResult) => r.structuredContent as Record<string, unknown>;

async function call(name: string, args: Record<string, unknown>): Promise<CallResult> {
  const r = await CLIENT.callTool({ name, arguments: args });
  return r;
}

/** Follow next_cursor (JSON mode) until has_more is false. */
async function chain(name: string, args: Record<string, unknown>) {
  const items: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  for (let n = 1; n <= 500; n++) {
    const r = await call(name, { ...args, response_format: "json", ...(cursor ? { cursor } : {}) });
    expect(r.isError ?? false, textOf(r)).toBe(false);
    const sc = scOf(r);
    items.push(...(sc.items as Record<string, unknown>[]));
    if (!sc.has_more) return { items, last: sc, calls: n };
    cursor = sc.next_cursor as string;
  }
  throw new Error("cursor chain did not terminate");
}

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

describe("automation instance status (spec enum)", () => {
  it("action1_wait_for_automation stops on the spec status Warning", async () => {
    const instance = specExample("AutomationInstance", { id: "inst-1", status: "Warning" });
    stubApi([{ path: /^\/automations\/instances\/[^/]+\/inst-1$/, body: instance }]);
    const started = Date.now();
    const r = await call("action1_wait_for_automation", {
      instance_id: "inst-1",
      timeout_seconds: 5,
      poll_interval_seconds: 1,
      response_format: "json",
    });
    expect(r.isError ?? false, textOf(r)).toBe(false);
    expect((scOf(r).status as Record<string, unknown>).status).toBe("Warning");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("action1_wait_for_automation keeps polling Pending and Running", async () => {
    let n = 0;
    const statuses = ["Pending", "Running", "Error"];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (input.endsWith("/oauth2/token")) {
          return Response.json({ access_token: "tkn", expires_in: 3600 });
        }
        const status = statuses[Math.min(n, statuses.length - 1)];
        n += 1;
        return Response.json(specExample("AutomationInstance", { id: "inst-2", status }));
      }),
    );
    const r = await call("action1_wait_for_automation", {
      instance_id: "inst-2",
      timeout_seconds: 10,
      poll_interval_seconds: 1,
      response_format: "json",
    });
    expect(r.isError ?? false, textOf(r)).toBe(false);
    expect((scOf(r).status as Record<string, unknown>).status).toBe("Error");
    expect(n).toBe(3);
  }, 10_000);

  it("action1_automations_summary counts Warning separately and Error/Stopped as failures", async () => {
    const statuses = ["Success", "Warning", "Warning", "Error", "Stopped", "Running", "Failed"];
    const instances = statuses.map((status, i) =>
      specExample("AutomationInstance", { id: `inst-${i}`, status }),
    );
    stubApi([{ path: /^\/automations\/instances\/[^/]+$/, all: instances }]);
    const r = await call("action1_automations_summary", { response_format: "json" });
    const sc = scOf(r);
    expect(sc.total_scanned).toBe(7);
    expect(sc.success_count).toBe(1);
    expect(sc.warning_count).toBe(2);
    // Error, Stopped (spec) and Failed (the shape assumed before).
    expect(sc.failure_count).toBe(3);
  });

  it("action1_automations_summary has no by_template: list instances carry no actions", async () => {
    // The spec says GET /automations/instances omits `actions` for a
    // list, and the live API returns `actions: []` there, so a
    // per-template count would always be empty.
    const instances = ["Success", "Error"].map((status, i) =>
      specExample("AutomationInstance", { id: `inst-${i}`, status, actions: [] }),
    );
    stubApi([{ path: /^\/automations\/instances\/[^/]+$/, all: instances }]);
    const r = await call("action1_automations_summary", { response_format: "json" });
    expect(r.isError ?? false, textOf(r)).toBe(false);
    expect(scOf(r)).not.toHaveProperty("by_template");
    const { tools } = await CLIENT.listTools();
    const listed = tools.find((t) => t.name === "action1_automations_summary")!;
    expect(listed.description).not.toMatch(/by_template/);
    expect(Object.keys(listed.outputSchema?.properties ?? {})).not.toContain("by_template");
  });
});

describe("endpoint reboot_required (spec enum Yes/No)", () => {
  it("action1_endpoints_summary counts spec 'Yes' and the legacy 'yes'/true", async () => {
    const values = ["Yes", "Yes", "No", "yes", true, "No"];
    const fleet = values.map((v, i) =>
      specExample("Endpoint", { id: uuid(i), reboot_required: v }),
    );
    stubApi([{ path: /^\/endpoints\/managed\/[^/]+$/, all: fleet }]);
    const r = await call("action1_endpoints_summary", { response_format: "json" });
    expect(scOf(r).total).toBe(6);
    expect(scOf(r).reboot_required).toBe(4);
  });

  it("action1_list_endpoints accepts Yes and yes and sends the spec value", async () => {
    const seen = stubApi([{ path: /^\/endpoints\/managed\/[^/]+$/, all: [] }]);
    for (const v of ["Yes", "yes"]) {
      const r = await call("action1_list_endpoints", { reboot_required: v });
      expect(r.isError ?? false, textOf(r)).toBe(false);
    }
    const sent = seen
      .filter((s) => /^\/endpoints\/managed\/[^/]+$/.test(s.path))
      .map((s) => s.query.get("reboot_required"));
    expect(sent).toEqual(["Yes", "Yes"]);
  });

  it("describes the filter parameter as the spec's substring filter", async () => {
    const { tools } = await CLIENT.listTools();
    const list = tools.find((t) => t.name === "action1_list_endpoints")!;
    const props = (list.inputSchema as { properties: Record<string, { description?: string }> })
      .properties;
    expect(props.filter!.description).toMatch(/substring/i);
    expect(props.filter!.description).not.toMatch(/==/);
  });
});

describe("installed software rows (spec ReportData fields)", () => {
  it("find_by_name matches fields.Name of spec rows and the legacy top-level name", async () => {
    const rows = [
      specExample("InstalledSoftwareEndpoints", { id: "r1", fields: { Name: "Microsoft Teams" } }),
      specExample("InstalledSoftwareEndpoints", { id: "r2", fields: { Name: "7-Zip" } }),
      { id: "r3", name: "Teams Machine-Wide Installer" },
    ];
    stubApi([{ path: /^\/installed-software\/[^/]+\/data\/[^/]+$/, all: rows }]);
    const { items } = await chain("action1_software_inventory_for_endpoint", {
      endpoint_id: EP,
      find_by_name: "teams",
    });
    expect(items.map((i) => i.id)).toEqual(["r1", "r3"]);
  });
});

describe("action1_cve_remediation_plan (spec VulnerableEndpoint / Vulnerability)", () => {
  const CVE = "CVE-2026-0001";
  const updates = [{ package_id: "Vendor_App_1_builtin", version_id: "2.0_1", version: "2.0" }];

  it("cve_id: reads endpoint_id and correlates packages from available_updates", async () => {
    const rows = [
      specExample("VulnerableEndpoint", {
        endpoint_id: uuid(1),
        endpoint_name: "host-1",
        software: [{ product_name: "App", available_updates: updates }],
      }),
      // Legacy shape: the id under `id`.
      { id: uuid(2) },
    ];
    stubApi([
      { path: new RegExp(`^/vulnerabilities/[^/]+/${CVE}/endpoints$`), all: rows },
      { path: /\/missing-updates$/, all: [{ id: "unrelated_pkg" }] },
    ]);
    const r = await call("action1_cve_remediation_plan", {
      cve_id: CVE,
      response_format: "json",
    });
    expect(r.isError ?? false, textOf(r)).toBe(false);
    const plan = scOf(r).plan as {
      cve: string;
      affected_endpoints: string[];
      candidate_packages: { id: string; version?: string }[];
    }[];
    expect(plan).toHaveLength(1);
    expect(plan[0]!.affected_endpoints).toEqual([uuid(1), uuid(2)]);
    expect(plan[0]!.candidate_packages.map((p) => [p.id, p.version])).toEqual([
      ["Vendor_App_1_builtin", "2.0"],
    ]);
  });

  it("endpoint_id: reads the documented /vulnerabilities?endpoint_id= list and correlates per CVE", async () => {
    const vulns = [
      specExample("Vulnerability", {
        cve_id: "CVE-2026-0001",
        software: [{ product_name: "App", available_updates: updates }],
      }),
      specExample("Vulnerability", {
        cve_id: "CVE-2026-0002",
        software: [
          {
            product_name: "Other",
            available_updates: [{ package_id: "Other_pkg", version_id: "1", version: "1.1" }],
          },
        ],
      }),
    ];
    const seen = stubApi([{ path: /^\/vulnerabilities\/[^/]+$/, all: vulns }]);
    const r = await call("action1_cve_remediation_plan", {
      endpoint_id: EP,
      response_format: "json",
    });
    expect(r.isError ?? false, textOf(r)).toBe(false);
    const plan = scOf(r).plan as {
      cve: string;
      candidate_packages: { id: string }[];
    }[];
    expect(plan.map((p) => [p.cve, p.candidate_packages.map((c) => c.id)])).toEqual([
      ["CVE-2026-0001", ["Vendor_App_1_builtin"]],
      ["CVE-2026-0002", ["Other_pkg"]],
    ]);
    const listCall = seen.find((s) => /^\/vulnerabilities\/[^/]+$/.test(s.path));
    expect(listCall?.query.get("endpoint_id")).toBe(EP);
  });
});

describe("action1_audit_log_search (spec AuditEvent)", () => {
  // 30 events, one per hour from 2026-10-21 00:00 UTC, in spec format.
  const events = Array.from({ length: 30 }, (_, i) => {
    const h = String(i % 24).padStart(2, "0");
    const d = 21 + Math.floor(i / 24);
    return specExample("AuditEvent", {
      id: String(i),
      user_name: i % 3 === 0 ? "alice" : "bob",
      event: i % 2 === 0 ? "Login" : "View Report",
      object_name: i % 5 === 0 ? "Weekly Patch Report" : "API",
      timestamp: `2026-10-${d}_${h}-00-00`,
    });
  });

  it("filters on user_name, event and object_name", async () => {
    stubApi([{ path: /^\/audit\/events$/, all: events }]);
    const byUser = await chain("action1_audit_log_search", { user_substring: "ALICE" });
    expect(byUser.items.map((e) => e.id)).toEqual(
      events.filter((e) => e.user_name === "alice").map((e) => e.id),
    );
    const byEvent = await chain("action1_audit_log_search", { event_type_substring: "login" });
    expect(byEvent.items).toHaveLength(15);
    const byTarget = await chain("action1_audit_log_search", { target_substring: "patch" });
    expect(byTarget.items).toHaveLength(6);
  });

  it("filters on the Action1 timestamp format and sends timefrom/timeto upstream", async () => {
    const seen = stubApi([{ path: /^\/audit\/events$/, all: events }]);
    const { items, last } = await chain("action1_audit_log_search", {
      from_time: "2026-10-21T10:00:00Z",
      to_time: "2026-10-21_12-00-00",
    });
    expect(items.map((e) => e.id)).toEqual(["10", "11", "12"]);
    expect(last.dropped_unparseable_timestamps).toBeUndefined();
    const q = seen.find((s) => s.path === "/audit/events")!.query;
    expect(q.get("timefrom")).toBe("2026-10-21_10-00-00");
    expect(q.get("timeto")).toBe("2026-10-21_12-00-00");
  });

  it("bounds the upstream pages scanned per call and resumes with next_cursor", async () => {
    // The server ignores timefrom: every event is older than the window.
    const old = Array.from({ length: 6_000 }, (_, i) =>
      specExample("AuditEvent", { id: String(i), timestamp: "2025-01-01_00-00-00" }),
    );
    const seen = stubApi([{ path: /^\/audit\/events$/, all: old }]);
    const first = await call("action1_audit_log_search", {
      from_time: "2026-10-26T00:00:00Z",
      response_format: "json",
    });
    expect(first.isError ?? false, textOf(first)).toBe(false);
    const pagesFirstCall = seen.filter((s) => s.path === "/audit/events").length;
    expect(pagesFirstCall).toBeLessThan(old.length / 200);
    expect(scOf(first).has_more).toBe(true);
    expect(scOf(first).count).toBe(0);
    expect(textOf(first)).toMatch(/scan/i);
    const { items } = await chain("action1_audit_log_search", {
      from_time: "2026-10-26T00:00:00Z",
    });
    expect(items).toHaveLength(0);
  });
});

describe("curated list walks follow the ResultPage envelope", () => {
  const fleet = Array.from({ length: 250 }, (_, i) => specExample("Endpoint", { id: uuid(i) }));

  it.each([
    ["action1_list_endpoints", /^\/endpoints\/managed\/[^/]+$/, {}],
    ["action1_search_endpoints", /^\/endpoints\/managed\/[^/]+$/, { query: "conference" }],
  ])("%s keeps walking when the server caps the page size", async (name, path, args) => {
    stubApi([{ path, all: fleet, cap: 100 }]);
    const { items, last } = await chain(name, args);
    expect(items).toHaveLength(250);
    expect(last.total).toBe(250);
  });

  it("action1_list_recent_automations keeps walking when the server caps the page size", async () => {
    const instances = Array.from({ length: 250 }, (_, i) =>
      specExample("AutomationInstance", { id: `inst-${i}`, status: "Success" }),
    );
    stubApi([{ path: /^\/automations\/instances\/[^/]+$/, all: instances, cap: 100 }]);
    const { items } = await chain("action1_list_recent_automations", {});
    expect(items).toHaveLength(250);
  });

  it("action1_recurring_schedules keeps walking when the server caps the page size", async () => {
    const schedules = Array.from({ length: 250 }, (_, i) =>
      specExample("AutomationSchedule", { id: `s-${i}` }),
    );
    stubApi([{ path: /^\/automations\/schedules\/[^/]+$/, all: schedules, cap: 100 }]);
    const { items } = await chain("action1_recurring_schedules", {});
    expect(items).toHaveLength(250);
  });

  it("action1_software_inventory_for_endpoint keeps walking when the server caps the page size", async () => {
    const rows = Array.from({ length: 250 }, (_, i) =>
      specExample("InstalledSoftwareEndpoints", { id: `r-${i}` }),
    );
    stubApi([{ path: /^\/installed-software\//, all: rows, cap: 100 }]);
    const { items } = await chain("action1_software_inventory_for_endpoint", { endpoint_id: EP });
    expect(items).toHaveLength(250);
  });

  it("action1_audit_log_search keeps walking when the server caps the page size", async () => {
    const events = Array.from({ length: 250 }, (_, i) =>
      specExample("AuditEvent", { id: String(i) }),
    );
    stubApi([{ path: /^\/audit\/events$/, all: events, cap: 100 }]);
    const { items } = await chain("action1_audit_log_search", {});
    expect(items).toHaveLength(250);
  });
});

describe("generated tool parameters follow the spec", () => {
  type Props = Record<string, { enum?: unknown[]; pattern?: string; format?: string }>;
  async function inputProps(name: string): Promise<Props> {
    const { tools } = await CLIENT.listTools();
    const t = tools.find((x) => x.name === name);
    expect(t, name).toBeDefined();
    return (t!.inputSchema as { properties: Props }).properties;
  }

  it("$ref enums of query parameters stay enums", async () => {
    expect((await inputProps("action1_list_logs")).level!.enum).toEqual([
      "Debug",
      "Normal",
      "Internal",
      "Important",
      "Error",
      "Critical",
    ]);
    const contents = await inputProps("action1_list_group_contents");
    expect(contents.reboot_required!.enum).toEqual(["Yes", "No"]);
    expect(contents.status!.enum).toEqual(["Connected", "Disconnected", "Pending Uninstall"]);
    expect((await inputProps("action1_list_scripts")).platform!.enum).toEqual([
      "Windows",
      "Mac",
      "Linux",
    ]);
  });

  it("an OS filter composed of several enums stays a free string", async () => {
    expect((await inputProps("action1_list_group_contents")).os!.enum).toBeUndefined();
  });

  it.each([
    ["2026-10-01_00-00-00", "2026-10-01_00-00-00"],
    ["2026-10-01T02:00:00+02:00", "2026-10-01_00-00-00"],
  ])("action1_list_audit_events accepts timefrom %s and sends %s", async (input, sent) => {
    const seen = stubApi([{ path: /^\/audit\/events$/, all: [] }]);
    const r = await call("action1_list_audit_events", { timefrom: input, timeto: input });
    expect(r.isError ?? false, textOf(r)).toBe(false);
    const q = seen.find((s) => s.path === "/audit/events")!.query;
    expect(q.get("timefrom")).toBe(sent);
    expect(q.get("timeto")).toBe(sent);
  });

  it("action1_list_audit_events rejects a time that is neither format", async () => {
    stubApi([{ path: /^\/audit\/events$/, all: [] }]);
    const r = await call("action1_list_audit_events", { timefrom: "last tuesday" });
    expect(r.isError).toBe(true);
  });
});

describe("curated list_endpoints sends spec values", () => {
  it("reset_cache true/false goes upstream as Yes/No", async () => {
    const seen = stubApi([{ path: /^\/endpoints\/managed\/[^/]+$/, all: [] }]);
    await call("action1_list_endpoints", { reset_cache: true });
    await call("action1_list_endpoints", { reset_cache: false });
    const sent = seen
      .filter((s) => /^\/endpoints\/managed\/[^/]+$/.test(s.path))
      .map((s) => s.query.get("reset_cache"));
    expect(sent).toEqual(["Yes", "No"]);
  });
});

describe("output notes only name parameters the tool has", () => {
  const LONG = "x".repeat(5_000);
  const longDescription = { id: "x1", name: "n", description: LONG };

  it.each([
    ["action1_list_organizations", {}],
    ["action1_list_endpoints", {}],
    ["action1_list_action_templates", {}],
    ["action1_list_recent_automations", {}],
    ["action1_recurring_schedules", {}],
    ["action1_audit_log_search", {}],
    ["action1_search_endpoints", { query: "n" }],
    ["action1_list_missing_updates", { endpoint_id: EP }],
    ["action1_software_inventory_for_endpoint", { endpoint_id: EP }],
  ])("%s never suggests `verbose` (it has no such parameter)", async (name, args) => {
    const { tools } = await CLIENT.listTools();
    const t = tools.find((x) => x.name === name)!;
    const props = (t.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props.verbose).toBeUndefined();
    stubApi([{ path: /./, all: [longDescription, { id: "x2", name: "short" }] }]);
    for (const response_format of ["markdown", "json"]) {
      const r = await call(name, { ...args, response_format });
      expect(r.isError ?? false, textOf(r)).toBe(false);
      expect(textOf(r)).not.toMatch(/verbose/);
      expect(JSON.stringify(r.structuredContent ?? {})).not.toMatch(/verbose/);
    }
  });

  it("a generated tool with `verbose` mentions it only when something was compacted", async () => {
    stubApi([{ path: /\/missing-updates$/, all: [{ id: "a", name: "short" }] }]);
    const plain = await call("action1_list_endpoint_missing_updates", {
      endpoint_id: EP,
      response_format: "json",
    });
    expect(textOf(plain)).not.toMatch(/verbose/);
    stubApi([{ path: /\/missing-updates$/, all: [longDescription] }]);
    const compacted = await call("action1_list_endpoint_missing_updates", {
      endpoint_id: EP,
      response_format: "json",
    });
    expect(scOf(compacted).note).toMatch(/verbose: true/);
    const raw = await call("action1_list_endpoint_missing_updates", {
      endpoint_id: EP,
      verbose: true,
      response_format: "json",
    });
    expect(textOf(raw)).not.toMatch(/verbose/);
  });
});

describe("output schemas document the result", () => {
  // Curated tools whose output schema is owned by other modules and is
  // still the permissive empty object (execution, templates, groups, raw).
  const CURATED_WITHOUT_SHAPE = new Set([
    "action1_get_action_template",
    "action1_run_powershell",
    "action1_run_bash_macos",
    "action1_run_script",
    "action1_reboot_endpoint",
    "action1_deploy_update",
    "action1_deploy_package",
    "action1_uninstall_program",
    "action1_run_data_collection",
    "action1_execute_and_wait",
    "action1_add_endpoint_to_group",
    "action1_remove_endpoint_from_group",
    "action1_raw_request",
  ]);

  it("every tool advertises named output properties (except the listed curated ones)", async () => {
    const { tools } = await CLIENT.listTools();
    const empty = tools
      .filter((t) => Object.keys((t.outputSchema?.properties as object) ?? {}).length === 0)
      .map((t) => t.name)
      .filter((n) => !CURATED_WITHOUT_SHAPE.has(n));
    expect(empty).toEqual([]);
  });

  it("generated destructive tools document the dry-run preview fields", async () => {
    const { GENERATED_TOOL_MANIFEST } = await import("../../src/tools/generated/index.js");
    const destructive = new Set(
      GENERATED_TOOL_MANIFEST.filter((m) => m.destructive && !m.unsupported).map((m) => m.name),
    );
    const { tools } = await CLIENT.listTools();
    const missing = tools
      .filter((t) => destructive.has(t.name))
      .filter((t) => {
        const props = Object.keys((t.outputSchema?.properties as object) ?? {});
        return !["dry_run", "tool", "would_send"].every((k) => props.includes(k));
      })
      .map((t) => t.name);
    expect(missing).toEqual([]);
  });

  it("a generated write tool's schema also lists the response fields of the spec", async () => {
    const { tools } = await CLIENT.listTools();
    const createRole = tools.find((t) => t.name === "action1_create_role")!;
    const props = Object.keys(createRole.outputSchema!.properties as object);
    expect(props).toEqual(expect.arrayContaining(["dry_run", "would_send", "id", "name"]));
  });
});

describe("aggregations report when they stop before the end of the data", () => {
  const CVE = "CVE-2026-0001";

  it("cve_id: lists every affected endpoint, max_items caps plan entries only", async () => {
    const rows = Array.from({ length: 120 }, (_, i) =>
      specExample("VulnerableEndpoint", { endpoint_id: uuid(i + 1) }),
    );
    stubApi([
      { path: new RegExp(`^/vulnerabilities/[^/]+/${CVE}/endpoints$`), all: rows },
      { path: new RegExp(`^/vulnerabilities/[^/]+/${CVE}$`), body: {} },
      { path: /\/missing-updates$/, all: [] },
    ]);
    const r = await call("action1_cve_remediation_plan", { cve_id: CVE, response_format: "json" });
    expect(r.isError ?? false, textOf(r)).toBe(false);
    const plan = scOf(r).plan as { affected_endpoints: string[] }[];
    expect(plan[0]!.affected_endpoints).toHaveLength(120);
    expect(scOf(r).truncated).toBe(false);
  });

  it("endpoint_id: more vulnerabilities than max_items sets truncated and a warning", async () => {
    const vulns = Array.from({ length: 60 }, (_, i) =>
      specExample("Vulnerability", {
        cve_id: `CVE-2026-${String(i + 1).padStart(4, "0")}`,
        software: [
          {
            product_name: "App",
            available_updates: [{ package_id: `pkg_${i}`, version_id: "1", version: "1" }],
          },
        ],
      }),
    );
    stubApi([{ path: /^\/vulnerabilities\/[^/]+$/, all: vulns }]);
    const r = await call("action1_cve_remediation_plan", {
      endpoint_id: EP,
      max_items: 50,
      response_format: "json",
    });
    expect(r.isError ?? false, textOf(r)).toBe(false);
    expect(scOf(r).plan).toHaveLength(50);
    expect(scOf(r).truncated).toBe(true);
    expect(scOf(r).warning).toMatch(/max_items/);
    expect(textOf(r)).toMatch(/max_items/);
  });

  it("endpoint_id: exactly max_items vulnerabilities is not truncated", async () => {
    const vulns = Array.from({ length: 50 }, (_, i) =>
      specExample("Vulnerability", {
        cve_id: `CVE-2026-${String(i + 1).padStart(4, "0")}`,
        software: [
          {
            product_name: "App",
            available_updates: [{ package_id: `pkg_${i}`, version_id: "1", version: "1" }],
          },
        ],
      }),
    );
    stubApi([{ path: /^\/vulnerabilities\/[^/]+$/, all: vulns }]);
    const r = await call("action1_cve_remediation_plan", {
      endpoint_id: EP,
      max_items: 50,
      response_format: "json",
    });
    expect(scOf(r).plan).toHaveLength(50);
    expect(scOf(r).truncated).toBe(false);
    expect(scOf(r)).not.toHaveProperty("warning");
  });

  const instances = Array.from({ length: 1500 }, (_, i) =>
    specExample("AutomationInstance", { id: `inst-${i}`, status: i >= 1200 ? "Error" : "Success" }),
  );

  it("action1_automations_summary flags has_more when max_scan stops the walk", async () => {
    stubApi([{ path: /^\/automations\/instances\/[^/]+$/, all: instances }]);
    const r = await call("action1_automations_summary", { response_format: "json" });
    expect(r.isError ?? false, textOf(r)).toBe(false);
    expect(scOf(r).total_scanned).toBe(1000);
    expect(scOf(r).has_more).toBe(true);
    expect(scOf(r).note).toMatch(/max_scan/);
    expect(textOf(r)).toMatch(/max_scan/);
  });

  it("action1_automations_summary counts everything when max_scan covers the data", async () => {
    stubApi([{ path: /^\/automations\/instances\/[^/]+$/, all: instances }]);
    const r = await call("action1_automations_summary", {
      max_scan: 1500,
      response_format: "json",
    });
    expect(scOf(r).total_scanned).toBe(1500);
    expect(scOf(r).failure_count).toBe(300);
    expect(scOf(r).has_more).toBe(false);
    expect(scOf(r)).not.toHaveProperty("note");
  });
});
