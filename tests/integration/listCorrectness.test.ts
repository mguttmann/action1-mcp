import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../../src/config.js";
import { specExample } from "../helpers/specFixtures.js";

// List data must be complete and correct on the real tool path. Every test drives the MCP server through the SDK
// in-memory transport against a stubbed Action1 API that honours
// `from` / `limit`, and chains `next_cursor` until `has_more` is false.
// The Markdown chains read the cursor from the text block only, because
// hosts such as Claude Desktop do not show structuredContent to the
// model.

const ORG = "00000000-0000-0000-0000-000000000001";
const EP0 = "00000000-0000-0000-0000-000000000000";

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
  CLIENT = new Client({ name: "list-test", version: "0.0.0" });
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

const uuid = (i: number) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;

// Endpoint records in the spec's Endpoint shape (tests/helpers/specFixtures.ts).
function endpoint(i: number): Record<string, unknown> {
  return specExample("Endpoint", {
    id: uuid(i),
    name: i % 7 === 0 ? `host-${i}-match` : `host-${i}`,
    device_name: `wks-${i}`,
    status: i % 3 ? "Connected" : "Disconnected",
    OS: i % 2 ? "Windows 11 (25H2)" : "macOS Sequoia",
    platform: i % 2 ? "Windows" : "Mac",
    online_status: "SUCCESS",
    last_seen: "2026-05-05_10-00-00",
    user: `user-${i}`,
    address: `10.0.${Math.floor(i / 250)}.${i % 250}`,
  });
}

type Route = {
  path: RegExp;
  status?: number;
  all?: unknown[];
  body?: unknown;
};

/** Fake Action1 API: list routes serve `all.slice(from, from + limit)`. */
function stubApi(routes: Route[]) {
  const fn = vi.fn(async (input: string) => {
    if (input.endsWith("/oauth2/token")) {
      return Response.json({ access_token: "tkn", expires_in: 3600 });
    }
    const url = new URL(input);
    const path = url.pathname.replace(/^\/api\/3\.0/, "");
    for (const r of routes) {
      if (!r.path.test(path)) continue;
      if (r.status && r.status >= 400) {
        return Response.json({ error: "stub error" }, { status: r.status });
      }
      if (r.all) {
        const from = Number(url.searchParams.get("from") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 50);
        return Response.json({ items: r.all.slice(from, from + limit) });
      }
      return Response.json(r.body ?? {});
    }
    return Response.json({ error: "no route", path }, { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

type CallResult = Awaited<ReturnType<typeof CLIENT.callTool>>;
const textOf = (r: CallResult) => (r.content as { type: string; text: string }[])[0]!.text;
const scOf = (r: CallResult) => r.structuredContent as Record<string, unknown>;

/** Chain a tool through JSON pages; returns all items and the last page. */
async function chainJson(name: string, args: Record<string, unknown>) {
  const items: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  for (let call = 1; call <= 200; call++) {
    const r = await CLIENT.callTool({
      name,
      arguments: { ...args, response_format: "json", ...(cursor ? { cursor } : {}) },
    });
    expect(r.isError ?? false, textOf(r)).toBe(false);
    const sc = scOf(r);
    items.push(...(sc.items as Record<string, unknown>[]));
    if (!sc.has_more) return { items, last: sc, calls: call };
    cursor = sc.next_cursor as string;
  }
  throw new Error("cursor chain did not terminate");
}

/** Chain a tool through Markdown pages using only the text block. */
async function chainMarkdown(name: string, args: Record<string, unknown>) {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let call = 1; call <= 200; call++) {
    const r = await CLIENT.callTool({
      name,
      arguments: { ...args, ...(cursor ? { cursor } : {}) },
    });
    const text = textOf(r);
    expect(r.isError ?? false, text).toBe(false);
    for (const m of text.matchAll(/^\| (0{8}-0{4}-0{4}-0{4}-\d{12}) \|/gm)) ids.push(m[1]!);
    if (!/^has_more: true$/m.test(text)) return { ids, text, calls: call };
    const next = /^next_cursor: (\S+)$/m.exec(text)?.[1];
    expect(next, "full next_cursor in the text").toBeDefined();
    cursor = next;
  }
  throw new Error("cursor chain did not terminate");
}

describe("action1_list_endpoints", () => {
  const fleet = Array.from({ length: 1_200 }, (_, i) => endpoint(i));

  it("Markdown (default) chain via the text block returns every endpoint exactly once", async () => {
    stubApi([{ path: /^\/endpoints\/managed\/[^/]+$/, all: fleet }]);
    const { ids, text, calls } = await chainMarkdown("action1_list_endpoints", {});
    expect(calls).toBeGreaterThan(1);
    expect(ids).toEqual(fleet.map((e) => e.id));
    expect(text).toMatch(/^total: 1200$/m);
  });

  it("JSON chain with limit returns every endpoint exactly once and the real total", async () => {
    stubApi([{ path: /^\/endpoints\/managed\/[^/]+$/, all: fleet }]);
    const { items, last } = await chainJson("action1_list_endpoints", {
      limit: 350,
      projection: "compact",
    });
    expect(items.map((e) => e.id)).toEqual(fleet.map((e) => e.id));
    expect(last.total).toBe(1_200);
    expect(last.count).toBe(150);
  });

  it("rejects a garbage cursor with isError instead of restarting at page 1", async () => {
    const stub = stubApi([{ path: /^\/endpoints\/managed\/[^/]+$/, all: fleet }]);
    const r = await CLIENT.callTool({
      name: "action1_list_endpoints",
      arguments: { cursor: "garbage!!" },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/invalid cursor/i);
    expect(stub.mock.calls.filter((c) => String(c[0]).includes("/endpoints/"))).toHaveLength(0);
  });

  it("rejects a cursor issued for a different filter", async () => {
    stubApi([{ path: /^\/endpoints\/managed\/[^/]+$/, all: fleet }]);
    const first = await CLIENT.callTool({
      name: "action1_list_endpoints",
      arguments: { status: "Connected", limit: 5, response_format: "json" },
    });
    const cursor = scOf(first).next_cursor as string;
    const r = await CLIENT.callTool({
      name: "action1_list_endpoints",
      arguments: { status: "Disconnected", cursor },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/fingerprint/i);
  });
});

describe("action1_search_endpoints", () => {
  const fleet = Array.from({ length: 1_200 }, (_, i) => endpoint(i));
  const matches = fleet.filter((e) => String(e.name).includes("match"));

  it("limit pages through every match (has_more stays true until the end)", async () => {
    stubApi([{ path: /^\/endpoints\/managed\/[^/]+$/, all: fleet }]);
    const { items, last, calls } = await chainJson("action1_search_endpoints", {
      query: "MATCH",
      limit: 25,
    });
    expect(calls).toBeGreaterThan(6);
    expect(items.map((e) => e.id)).toEqual(matches.map((e) => e.id));
    expect(last.total).toBe(matches.length);
  });

  it("byte-cap page breaks never skip matches (full projection, fat records)", async () => {
    const fat = fleet.map((e) => ({ ...e, inventory: "x".repeat(4_000) }));
    stubApi([{ path: /^\/endpoints\/managed\/[^/]+$/, all: fat }]);
    const { items, calls } = await chainJson("action1_search_endpoints", {
      query: "match",
      projection: "full",
    });
    expect(calls).toBeGreaterThan(1);
    expect(items.map((e) => e.id)).toEqual(matches.map((e) => e.id));
  });

  it("Markdown chain via the text block returns every match", async () => {
    stubApi([{ path: /^\/endpoints\/managed\/[^/]+$/, all: fleet }]);
    const { ids } = await chainMarkdown("action1_search_endpoints", { query: "match" });
    expect(ids).toEqual(matches.map((e) => e.id));
  });

  it("rejects a cursor from another query", async () => {
    stubApi([{ path: /^\/endpoints\/managed\/[^/]+$/, all: fleet }]);
    const first = await CLIENT.callTool({
      name: "action1_search_endpoints",
      arguments: { query: "match", limit: 2, response_format: "json" },
    });
    const r = await CLIENT.callTool({
      name: "action1_search_endpoints",
      arguments: { query: "host", cursor: scOf(first).next_cursor as string },
    });
    expect(r.isError).toBe(true);
  });
});

describe("other curated read tools", () => {
  it("action1_get_endpoint returns the record plus derived platform/connectivity", async () => {
    stubApi([{ path: new RegExp(`^/endpoints/managed/[^/]+/${EP0}$`), body: endpoint(1) }]);
    const r = await CLIENT.callTool({
      name: "action1_get_endpoint",
      arguments: { endpoint_id: EP0 },
    });
    expect(r.isError ?? false).toBe(false);
    const sc = scOf(r);
    expect(sc.platform).toBe("windows");
    expect(sc.source).toBe("canonical");
    expect((sc.general as Record<string, unknown>).name).toBe("host-1");
  });

  it("action1_list_missing_updates walks every upstream page", async () => {
    const updates = Array.from({ length: 450 }, (_, i) => ({
      id: `pkg-${i}`,
      name: `Update ${i}`,
    }));
    stubApi([{ path: /\/missing-updates$/, all: updates }]);
    const r = await CLIENT.callTool({
      name: "action1_list_missing_updates",
      arguments: { endpoint_id: EP0, response_format: "json" },
    });
    const sc = scOf(r);
    expect(sc.total).toBe(450);
    expect((sc.items as { id: string }[]).map((u) => u.id)).toEqual(updates.map((u) => u.id));
  });

  it("action1_list_vulnerabilities walks every page and keeps the 403 hint", async () => {
    const vulns = Array.from({ length: 230 }, (_, i) => ({
      id: `v-${i}`,
      cve_id: `CVE-2026-${i}`,
    }));
    stubApi([{ path: /\/vulnerabilities$/, all: vulns }]);
    const ok = await CLIENT.callTool({
      name: "action1_list_vulnerabilities",
      arguments: { endpoint_id: EP0, response_format: "json" },
    });
    expect(scOf(ok).total).toBe(230);
    expect((scOf(ok).items as unknown[]).length).toBe(230);

    stubApi([{ path: /\/vulnerabilities$/, status: 403 }]);
    const denied = await CLIENT.callTool({
      name: "action1_list_vulnerabilities",
      arguments: { endpoint_id: EP0 },
    });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toMatch(/vulnerabilities scope/);
  });

  it("action1_endpoints_summary counts every endpoint across pages", async () => {
    const fleet = Array.from({ length: 450 }, (_, i) => endpoint(i));
    stubApi([{ path: /^\/endpoints\/managed\/[^/]+$/, all: fleet }]);
    const r = await CLIENT.callTool({
      name: "action1_endpoints_summary",
      arguments: { response_format: "json" },
    });
    const sc = scOf(r);
    expect(sc.total).toBe(450);
    expect(sc.windows).toBe(225);
    expect(sc.macos).toBe(225);
  });
});

describe("filtered wrapper lists scan every upstream page", () => {
  it("action1_software_inventory_for_endpoint finds matches beyond the first page", async () => {
    const software = Array.from({ length: 700 }, (_, i) =>
      specExample("InstalledSoftwareEndpoints", {
        id: uuid(i),
        fields: { Name: i % 50 === 0 ? `Chrome ${i}` : `App ${i}` },
      }),
    );
    stubApi([{ path: /^\/installed-software\//, all: software }]);
    const { items, last } = await chainJson("action1_software_inventory_for_endpoint", {
      endpoint_id: EP0,
      find_by_name: "chrome",
      limit: 4,
    });
    const nameOf = (s: Record<string, unknown>) => (s.fields as { Name: string }).Name;
    const expected = software.filter((s) => nameOf(s).startsWith("Chrome"));
    expect(items.map((s) => s.id)).toEqual(expected.map((s) => s.id));
    expect(last.total).toBe(expected.length);
  });

  it("action1_recurring_schedules filters across pages", async () => {
    // AutomationSchedule as in the spec: activity in `settings`.
    const schedules = Array.from({ length: 450 }, (_, i) =>
      specExample("AutomationSchedule", {
        id: uuid(i),
        settings: i % 3 === 0 ? "DISABLED WEEKLY:Mon AT:04-00-00" : "ENABLED MONTHLY:3 AT:17-00-00",
        actions: [{ template_id: i % 10 === 0 ? "deploy_update" : "run_script" }],
      }),
    );
    stubApi([{ path: /^\/automations\/schedules\//, all: schedules }]);
    const { items } = await chainJson("action1_recurring_schedules", {
      template_id: "deploy_update",
      active_only: true,
    });
    const expected = schedules.filter(
      (s, i) => i % 10 === 0 && !String(s.settings).startsWith("DISABLED"),
    );
    expect(items.map((s) => s.id)).toEqual(expected.map((s) => s.id));
  });

  it("action1_audit_log_search filters across pages and shows the drop counter in Markdown", async () => {
    // AuditEvent as in the spec: user_name, event, timestamp in the
    // Action1 format YYYY-MM-DD_HH-MM-SS.
    const stamp = (i: number) =>
      new Date(Date.UTC(2026, 0, 1) + i * 60_000)
        .toISOString()
        .slice(0, 19)
        .replace("T", "_")
        .replace(/:/g, "-");
    const events = Array.from({ length: 450 }, (_, i) =>
      specExample("AuditEvent", {
        id: uuid(i),
        timestamp: i === 5 ? "not-a-date" : stamp(i),
        user_name: i % 4 === 0 ? "alice@example.test" : "bob@example.test",
        event: "Login",
      }),
    );
    stubApi([{ path: /^\/audit\/events$/, all: events }]);
    const { ids, text } = await chainMarkdown("action1_audit_log_search", {
      user_substring: "alice",
      from_time: "2026-01-01T00:00:00Z",
    });
    const expected = events.filter(
      (e) => String(e.user_name).startsWith("alice") && e.timestamp !== "not-a-date",
    );
    expect(ids).toEqual(expected.map((e) => e.id));
    expect(text).toContain("| id |");
    expect(text).toMatch(/^dropped_unparseable_timestamps: 1$/m);
  });
});

describe("action1_report_export (json)", () => {
  it("reports the exact total of a large report while returning what fits", async () => {
    const rows = Array.from({ length: 3_000 }, (_, i) => ({ id: i, blob: "r".repeat(300) }));
    const REPORT = "11111111-2222-3333-4444-555555555555";
    stubApi([{ path: new RegExp(`^/reportdata/[^/]+/${REPORT}/data$`), all: rows }]);
    const r = await CLIENT.callTool({
      name: "action1_report_export",
      arguments: { report: REPORT, response_format: "json" },
    });
    const sc = scOf(r);
    expect(sc.total).toBe(3_000);
    expect(sc.count as number).toBeLessThan(3_000);
    expect(sc.truncated).toBe(3_000 - (sc.count as number));
  });
});

describe("action1_cve_remediation_plan error handling", () => {
  const vulns = { items: [{ cve_id: "CVE-2026-0001" }, { cve_id: "CVE-2026-0002" }] };

  it("surfaces a non-403/404 missing-updates failure as an error", async () => {
    stubApi([
      { path: /\/missing-updates$/, status: 400 },
      { path: /\/vulnerabilities$/, body: vulns },
    ]);
    const r = await CLIENT.callTool({
      name: "action1_cve_remediation_plan",
      arguments: { endpoint_id: EP0 },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/400/);
  });

  it("turns a 403 on missing-updates into a visible warning", async () => {
    stubApi([
      { path: /\/missing-updates$/, status: 403 },
      { path: /\/vulnerabilities$/, body: vulns },
    ]);
    const r = await CLIENT.callTool({
      name: "action1_cve_remediation_plan",
      arguments: { endpoint_id: EP0, response_format: "json" },
    });
    expect(r.isError ?? false).toBe(false);
    const sc = scOf(r);
    expect(sc.warning).toMatch(/missing-updates.*403/);
    expect(textOf(r)).toMatch(/missing-updates.*403/);
  });

  it("fetches missing updates once per endpoint, not once per CVE", async () => {
    const stub = stubApi([
      { path: /\/missing-updates$/, all: [{ id: "pkg-1" }, { id: "pkg-2" }] },
      { path: /\/vulnerabilities$/, body: vulns },
    ]);
    const r = await CLIENT.callTool({
      name: "action1_cve_remediation_plan",
      arguments: { endpoint_id: EP0, response_format: "json" },
    });
    const plan = scOf(r).plan as { candidate_packages: { id: string }[] }[];
    expect(plan).toHaveLength(2);
    expect(plan[1]!.candidate_packages.map((p) => p.id)).toEqual(["pkg-1", "pkg-2"]);
    const calls = stub.mock.calls.filter((c) => String(c[0]).includes("/missing-updates"));
    expect(calls).toHaveLength(1);
  });
});

describe("generated list tools share the same list contract", () => {
  const updates = Array.from({ length: 900 }, (_, i) => ({
    id: uuid(i),
    name: `Update ${i}`,
    security_severity: i % 2 ? "Critical" : "Low",
  }));

  it("auto_paginate Markdown chain via the text block returns every item", async () => {
    stubApi([{ path: /\/missing-updates$/, all: updates }]);
    const { ids, calls } = await chainMarkdown("action1_list_endpoint_missing_updates", {
      endpoint_id: EP0,
      auto_paginate: true,
    });
    expect(calls).toBeGreaterThan(1);
    expect(ids).toEqual(updates.map((u) => u.id));
  });

  it("rejects a garbage cursor with isError", async () => {
    stubApi([{ path: /\/missing-updates$/, all: updates }]);
    const r = await CLIENT.callTool({
      name: "action1_list_endpoint_missing_updates",
      arguments: { endpoint_id: EP0, cursor: "garbage!!" },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/invalid cursor/i);
  });

  it("a call without cursor reports has_more/next_cursor and the cursor continues after it", async () => {
    stubApi([{ path: /\/missing-updates$/, all: updates }]);
    const first = await CLIENT.callTool({
      name: "action1_list_endpoint_missing_updates",
      arguments: { endpoint_id: EP0, limit: 300, response_format: "json" },
    });
    const sc = scOf(first);
    expect(sc.count).toBe(300);
    expect(sc.has_more).toBe(true);
    expect(typeof sc.next_cursor).toBe("string");
    const rest = await chainJson("action1_list_endpoint_missing_updates", {
      endpoint_id: EP0,
      limit: 300,
    });
    expect(rest.items.map((u) => u.id)).toEqual(updates.map((u) => u.id));
    const ids = [
      ...(sc.items as { id: string }[]).map((u) => u.id),
      ...(
        await chainJson("action1_list_endpoint_missing_updates", {
          endpoint_id: EP0,
          limit: 300,
          cursor: sc.next_cursor,
        })
      ).items.map((u) => u.id as string),
    ];
    expect(ids).toEqual(updates.map((u) => u.id));
  });

  it("a call without cursor on the last page reports has_more false and next_cursor null", async () => {
    stubApi([{ path: /\/missing-updates$/, all: updates.slice(0, 10) }]);
    const r = await CLIENT.callTool({
      name: "action1_list_endpoint_missing_updates",
      arguments: { endpoint_id: EP0, limit: 50, response_format: "json" },
    });
    expect(scOf(r).has_more).toBe(false);
    expect(scOf(r).next_cursor).toBeNull();
  });

  it("the Markdown text of a call without cursor carries the full next_cursor", async () => {
    stubApi([{ path: /\/missing-updates$/, all: updates }]);
    const r = await CLIENT.callTool({
      name: "action1_list_endpoint_missing_updates",
      arguments: { endpoint_id: EP0, limit: 20 },
    });
    expect(textOf(r)).toMatch(/^has_more: true$/m);
    expect(textOf(r)).toMatch(/^next_cursor: \S+$/m);
  });

  it("auto_paginate starts at `from` instead of dropping it", async () => {
    stubApi([{ path: /\/missing-updates$/, all: updates }]);
    const r = await CLIENT.callTool({
      name: "action1_list_endpoint_missing_updates",
      arguments: { endpoint_id: EP0, auto_paginate: true, from: 890, response_format: "json" },
    });
    expect((scOf(r).items as { id: string }[]).map((u) => u.id)).toEqual(
      updates.slice(890).map((u) => u.id),
    );
  });

  it("describes auto_paginate and cursor by what they do", async () => {
    const { tools } = await CLIENT.listTools();
    const t = tools.find((x) => x.name === "action1_list_endpoint_missing_updates")!;
    const props = (t.inputSchema as { properties: Record<string, { description?: string }> })
      .properties;
    expect(props.auto_paginate!.description).not.toMatch(/^Walk all pages\.$/);
    expect(props.auto_paginate!.description).toMatch(/next_cursor/);
    expect(props.cursor!.description).toMatch(/next_cursor/);
  });

  it("a plain Markdown call with wide rows moves next_cursor to the first row it did not show", async () => {
    // Wide rows: the Markdown table fits far fewer rows than the JSON
    // cap. A text-only client follows next_cursor from the text, so the
    // first call (no cursor, no auto_paginate) must not skip the rows
    // the table could not show.
    const wide = Array.from({ length: 400 }, (_, i) => ({
      id: uuid(i),
      name: `pkg-${i}-${"x".repeat(150)}`,
      version: "1.0",
      vendor: "v".repeat(80),
    }));
    stubApi([{ path: /\/missing-updates$/, all: wide }]);
    const first = await CLIENT.callTool({
      name: "action1_list_endpoint_missing_updates",
      arguments: { endpoint_id: EP0, limit: 200 },
    });
    const shown = [...textOf(first).matchAll(/^\| (0{8}-0{4}-0{4}-0{4}-\d{12}) \|/gm)].length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(200);
    expect(scOf(first).count).toBe(shown);
    expect(textOf(first)).not.toMatch(/more rows omitted/);
    const { ids } = await chainMarkdown("action1_list_endpoint_missing_updates", {
      endpoint_id: EP0,
      limit: 200,
    });
    expect(ids).toEqual(wide.map((u) => u.id));
  });

  it("single-call Markdown keeps upstream envelope fields visible", async () => {
    stubApi([
      {
        path: /\/missing-updates$/,
        body: { items: updates.slice(0, 3), total_items: 900, next_page: "from=3" },
      },
    ]);
    const r = await CLIENT.callTool({
      name: "action1_list_endpoint_missing_updates",
      arguments: { endpoint_id: EP0, limit: 3 },
    });
    const text = textOf(r);
    expect(text).toContain("| id |");
    expect(text).toMatch(/^total_items: 900$/m);
    expect(text).toMatch(/^next_page: from=3$/m);
  });
});
