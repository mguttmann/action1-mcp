import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../../src/config.js";

// Integration test: drive the McpServer through the SDK's in-memory
// transport pair so we exercise registration, tools/list, the destructive
// guard, and the resource catalog without booting an actual stdio /
// HTTP transport. This catches regressions in tool wiring that pure
// unit tests miss.

let buildServer: typeof import("../../src/server.js").buildServer;
let SERVER: ReturnType<typeof import("../../src/server.js").buildServer>;
let CLIENT: import("@modelcontextprotocol/sdk/client/index.js").Client;

beforeAll(async () => {
  process.env.ACTION1_BASE_URL = "https://app.eu.action1.test/api/3.0";
  process.env.ACTION1_CLIENT_ID = "client-id-test";
  process.env.ACTION1_CLIENT_SECRET = "client-secret-test";
  process.env.ACTION1_ORG_ID = "00000000-0000-0000-0000-000000000001";
  resetConfigCache();
  buildServer = (await import("../../src/server.js")).buildServer;

  const sdkServer = await import("@modelcontextprotocol/sdk/server/index.js");
  void sdkServer;
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import(
    "@modelcontextprotocol/sdk/inMemory.js"
  );
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();

  SERVER = buildServer();
  await SERVER.server.connect(serverTx);

  CLIENT = new Client(
    { name: "integration-test", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  await CLIENT.connect(clientTx);
}, 30_000);

afterAll(async () => {
  if (CLIENT) await CLIENT.close();
  if (SERVER?.server) await SERVER.server.close();
});

describe("MCP server boots and registers everything", () => {
  it("advertises the skill-conformant server name", async () => {
    const info = CLIENT.getServerVersion();
    expect(info?.name).toBe("action1-mcp-server");
  });

  it("registers the full curated + generated tool set via tools/list", async () => {
    const list = await CLIENT.listTools();
    // Hard floor: 33 curated + 133 generated = 166 tools (spec). The
    // numbers shift by 1-2 when individual operations are added or
    // retired upstream, so we assert ≥160. The two sub-buckets are
    // counted independently so a regression that nukes one source
    // (e.g. the generated index silently going empty) is caught even
    // when the other source happens to grow.
    expect(list.tools.length).toBeGreaterThanOrEqual(160);
    const generated = list.tools.filter((t) =>
      /^action1_(get|list|create|update|delete|search|run|reboot|deploy|uninstall|clone|export|init|modify|move|requery|request|revoke|stop|upload)(_|$)/.test(
        t.name,
      ),
    );
    expect(generated.length).toBeGreaterThanOrEqual(115);
    const curated = list.tools.filter((t) =>
      [
        "action1_list_endpoints",
        "action1_get_endpoint",
        "action1_endpoints_summary",
      ].includes(t.name),
    );
    expect(curated.length).toBe(3);
  });

  it("every tool has a name, description, inputSchema, and outputSchema", async () => {
    const list = await CLIENT.listTools();
    for (const tool of list.tools) {
      expect(tool.name, `tool[${list.tools.indexOf(tool)}].name`).toMatch(
        /^[a-z0-9_]+$/,
      );
      expect(tool.name.length, "tool name within MCP cap").toBeLessThanOrEqual(
        64,
      );
      // Sharpen: description must be a non-empty string, not just
      // truthy (a stray `0` or `false` would have passed the old
      // assertion).
      expect(
        typeof tool.description,
        `${tool.name}.description type`,
      ).toBe("string");
      expect(
        (tool.description ?? "").length,
        `${tool.name}.description length`,
      ).toBeGreaterThan(0);
      expect(tool.inputSchema, `${tool.name}.inputSchema`).toBeDefined();
      // Pass-N audit Item 2: every tool MUST expose an outputSchema so
      // the SDK can validate structuredContent. A missing outputSchema
      // means structured payload validation is silently skipped and
      // shape regressions surface only at runtime in client hosts.
      expect(
        tool.outputSchema,
        `outputSchema missing for ${tool.name}`,
      ).toBeDefined();
      expect(
        typeof tool.outputSchema,
        `${tool.name}.outputSchema typeof`,
      ).toBe("object");
      // MCP JSON-Schema convention: tool output schemas are object
      // schemas (so hosts can map structuredContent to a record).
      expect(
        (tool.outputSchema as { type?: unknown }).type,
        `${tool.name}.outputSchema.type`,
      ).toBe("object");
    }
  });

  it("every read tool sets readOnlyHint=true", async () => {
    const list = await CLIENT.listTools();
    const reads = list.tools.filter(
      (t) => t.name.includes("_list_") || t.name.includes("_get_") || t.name.endsWith("_summary"),
    );
    for (const tool of reads) {
      expect(
        tool.annotations?.readOnlyHint,
        `${tool.name} readOnlyHint`,
      ).toBe(true);
    }
  });

  it("destructive tools include both confirm and dry_run params", async () => {
    const list = await CLIENT.listTools();
    const destructive = list.tools.filter(
      (t) => t.annotations?.destructiveHint === true,
    );
    for (const tool of destructive) {
      const props =
        ((tool.inputSchema as { properties?: Record<string, unknown> })
          ?.properties ?? {}) as Record<string, unknown>;
      expect(props.confirm, `${tool.name} requires confirm`).toBeDefined();
      expect(props.dry_run, `${tool.name} requires dry_run`).toBeDefined();
    }
  });

  it("registers the standard resource set", async () => {
    const res = await CLIENT.listResources();
    const names = res.resources.map((r) => r.name);
    expect(names).toContain("me");
    expect(names).toContain("organizations");
    expect(names).toContain("templates");
    expect(names).toContain("reports");
  });

  it("exposes resource templates for org-scoped data", async () => {
    const res = await CLIENT.listResourceTemplates();
    const templates = res.resourceTemplates.map((t) => t.name);
    expect(templates).toContain("endpoints");
    expect(templates).toContain("vulnerabilities");
    expect(templates).toContain("groups");
  });

  it("registers the slash-prompt set", async () => {
    const res = await CLIENT.listPrompts();
    const names = res.prompts.map((p) => p.name);
    expect(names).toContain("patch-windows-fleet");
    expect(names).toContain("audit-vulnerabilities");
    expect(names).toContain("triage-offline-endpoints");
    expect(names).toContain("run-script-fleetwide");
    expect(names).toContain("software-inventory-sweep");
    expect(names).toContain("check-my-permissions");
  });
});

// ---------------------------------------------------------------------------
// tools/call + resources/read with a stubbed fetch.
//
// `listTools` etc. only test registration. The Pass-3 production bug
// (singleObjectOutputShape + cursor-shape required-field trap) only
// fires on actual tools/call — the SDK validates structuredContent
// against the registered outputSchema there. These tests drive
// representative read + destructive + resource paths against a
// stubbed `fetch` so the schema-validation step actually runs.
// ---------------------------------------------------------------------------

interface ScriptedResponse {
  match: (url: string, init: RequestInit) => boolean;
  status?: number;
  body?: object | string;
  headers?: Record<string, string>;
}

function buildFetchStub(routes: ScriptedResponse[]): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string, init: RequestInit = {}) => {
    // OAuth dance: any /oauth2/token POST returns a fresh token.
    if (url.endsWith("/oauth2/token")) {
      return new Response(
        JSON.stringify({ access_token: "tkn", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    for (const r of routes) {
      if (r.match(url, init)) {
        const status = r.status ?? 200;
        const headers = { "Content-Type": "application/json", ...(r.headers ?? {}) };
        const body =
          r.body === undefined
            ? null
            : typeof r.body === "string"
              ? r.body
              : JSON.stringify(r.body);
        return new Response(body, { status, headers });
      }
    }
    return new Response(JSON.stringify({ error: "no route matched", url }), {
      status: 599,
      headers: { "Content-Type": "application/json" },
    });
  });
}

describe("MCP server: tools/call + resources/read with stubbed fetch", () => {
  afterAll(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("tools/call action1_list_organizations returns structuredContent matching the list output schema", async () => {
    const stub = buildFetchStub([
      {
        match: (url) => url.includes("/organizations"),
        body: {
          items: [
            { id: "org-1", name: "Acme" },
            { id: "org-2", name: "Beta" },
          ],
          total: 2,
        },
      },
    ]);
    vi.stubGlobal("fetch", stub);

    const result = await CLIENT.callTool({
      name: "action1_list_organizations",
      arguments: { response_format: "json" },
    });

    // Not an error — and structuredContent reflects the upstream list.
    // Sharpen: `toBeFalsy()` passed for `undefined`, but we want to
    // distinguish "no error reported" from "isError omitted". The
    // result MUST be explicitly non-error.
    expect(result.isError ?? false).toBe(false);
    const sc = result.structuredContent as {
      items: { id: string; name: string }[];
      count: number;
    };
    expect(sc).toBeDefined();
    expect(Array.isArray(sc.items)).toBe(true);
    expect(sc.items.length).toBe(2);
    expect(sc.count).toBe(2);
    // Sharpen: pin the concrete payload contents, not just shape, so an
    // empty `{ items: [], count: 0 }` would no longer pass.
    expect(sc.items[0]?.id).toBe("org-1");
    expect(sc.items[0]?.name).toBe("Acme");
    expect(sc.items[1]?.id).toBe("org-2");
  });

  it("tools/call on a destructive tool with dry_run=true returns a preview (no upstream call)", async () => {
    // No route registered: if the tool ever hits the network, the stub
    // returns 599 and the assertion fails. dry_run must short-circuit
    // before that point.
    const stub = buildFetchStub([]);
    vi.stubGlobal("fetch", stub);

    const result = await CLIENT.callTool({
      name: "action1_reboot_endpoint",
      arguments: {
        endpoint_id: "00000000-0000-0000-0000-000000000000",
        dry_run: true,
      },
    });

    expect(result.isError ?? false).toBe(false);
    const sc = result.structuredContent as Record<string, unknown> | undefined;
    expect(sc).toBeDefined();
    expect(sc!.dry_run).toBe(true);
    expect(sc!.tool).toBe("action1_reboot_endpoint");
    // Sharpen: `toBeDefined()` passes for `null`. Pin both type and
    // non-null so a regression that emits `would_send: null` (or any
    // primitive) fails loudly.
    expect(typeof sc!.would_send).toBe("object");
    expect(sc!.would_send).not.toBeNull();
    // Sharpen: pin method/path shape and the reboot template id in body.
    // An empty `{}` for would_send would now fail loudly. The path uses
    // the orgId (not the endpoint_id — that goes into body.endpoints[]).
    const would = sc!.would_send as {
      method: string;
      path: string;
      body: {
        endpoints: { id: string; type: string }[];
        actions: { template_id: string }[];
      };
    };
    expect(would.method).toBe("POST");
    expect(would.path.startsWith("/policies/instances/")).toBe(true);
    expect(would.body.endpoints[0]?.id).toBe(
      "00000000-0000-0000-0000-000000000000",
    );
    expect(would.body.endpoints[0]?.type).toBe("Endpoint");
    expect(would.body.actions[0]?.template_id).toBe("reboot");
    // Critically: no non-token fetch call was made.
    const nonTokenCalls = stub.mock.calls.filter(
      (c) => !String(c[0]).endsWith("/oauth2/token"),
    );
    expect(nonTokenCalls.length).toBe(0);
  });

  it("resources/read action1://me returns the upstream JSON in contents[].text", async () => {
    const meBody = { user: { email: "a@b.c", role: "Admin" } };
    const stub = buildFetchStub([
      {
        match: (url) => url.endsWith("/me"),
        body: meBody,
      },
    ]);
    vi.stubGlobal("fetch", stub);

    const result = await CLIENT.readResource({ uri: "action1://me" });
    expect(result.contents.length).toBe(1);
    expect(result.contents[0]?.mimeType).toBe("application/json");
    const parsed = JSON.parse(result.contents[0]?.text as string) as Record<string, unknown>;
    expect(parsed).toEqual(meBody);
  });

  // Pass-9 review #5: direct callTool tests for the curated workflow
  // tools that previously had only indirect coverage. Each test pins
  // the structuredContent shape via the SDK's outputSchema validator
  // (which is what surfaces production schema-mismatches).

  it("tools/call action1_endpoints_summary returns counters with required keys", async () => {
    const stub = buildFetchStub([
      {
        match: (url) => url.includes("/endpoints/managed/"),
        body: {
          items: [
            {
              id: "ep-1",
              status: "Connected",
              platform: "Windows",
              OS: "Windows 11 (25H2)",
              online_status: "SUCCESS",
              last_seen: "2026-05-05_10-00-00",
            },
          ],
        },
      },
    ]);
    vi.stubGlobal("fetch", stub);

    const result = await CLIENT.callTool({
      name: "action1_endpoints_summary",
      arguments: { response_format: "json" },
    });
    expect(result.isError ?? false).toBe(false);
    const sc = result.structuredContent as {
      total: number;
      by_status: Record<string, number>;
      by_platform: Record<string, number>;
      windows: number;
    } | undefined;
    expect(sc).toBeDefined();
    expect(sc!.total).toBe(1);
    // Sharpen: pin the per-bucket counters so a regression that emits
    // empty `{}` for the counters wouldn't silently pass.
    expect(sc!.by_status.Connected).toBe(1);
    expect(sc!.by_platform.Windows).toBe(1);
    expect(sc!.windows).toBe(1);
  });

  it.each([
    {
      tool: "action1_deploy_update",
      args: {
        endpoint_id: "00000000-0000-0000-0000-000000000000",
        updates: [{ package_id: "pkg-1", version: "1.0" }],
        dry_run: true,
      },
      expectedTemplate: "deploy_update",
    },
    {
      tool: "action1_deploy_package",
      args: {
        endpoint_id: "00000000-0000-0000-0000-000000000000",
        params: { package: "AnyDesk" },
        dry_run: true,
      },
      expectedTemplate: "deploy_package",
    },
    {
      tool: "action1_uninstall_program",
      args: {
        endpoint_id: "00000000-0000-0000-0000-000000000000",
        params: { program: "AnyDesk" },
        dry_run: true,
      },
      expectedTemplate: "uninstall_program",
    },
    {
      tool: "action1_run_data_collection",
      args: {
        endpoint_id: "00000000-0000-0000-0000-000000000000",
        params: { collection: "diag" },
        dry_run: true,
      },
      expectedTemplate: "run_data_collection",
    },
  ])(
    "tools/call $tool with dry_run=true returns preview, no upstream call",
    async ({ tool, args, expectedTemplate }) => {
      const stub = buildFetchStub([]);
      vi.stubGlobal("fetch", stub);

      const result = await CLIENT.callTool({ name: tool, arguments: args });
      expect(result.isError ?? false).toBe(false);
      const sc = result.structuredContent as Record<string, unknown> | undefined;
      expect(sc).toBeDefined();
      expect(sc!.dry_run).toBe(true);
      expect(sc!.tool).toBe(tool);
      expect(typeof sc!.would_send).toBe("object");
      expect(sc!.would_send).not.toBeNull();
      // Sharpen: pin the method, the path prefix, and the template id
      // in the dry_run body. An empty `would_send: {}` would now fail.
      const would = sc!.would_send as {
        method: string;
        path: string;
        body: { actions: { template_id: string }[] };
      };
      expect(would.method).toBe("POST");
      expect(would.path.startsWith("/policies/instances/")).toBe(true);
      expect(would.body.actions[0]?.template_id).toBe(expectedTemplate);
      const nonTokenCalls = stub.mock.calls.filter(
        (c) => !String(c[0]).endsWith("/oauth2/token"),
      );
      expect(nonTokenCalls.length).toBe(0);
    },
  );

  it("tools/call action1_deploy_update preview lists the supplied package id in params.packages", async () => {
    const stub = buildFetchStub([]);
    vi.stubGlobal("fetch", stub);

    const result = await CLIENT.callTool({
      name: "action1_deploy_update",
      arguments: {
        endpoint_id: "00000000-0000-0000-0000-000000000000",
        updates: [{ package_id: "pkg-foo", version: "2.4.0" }],
        dry_run: true,
      },
    });
    const sc = result.structuredContent as Record<string, unknown> | undefined;
    const action = (sc!.would_send as {
      body: {
        actions: {
          template_id: string;
          params: { packages: Record<string, string>[] };
        }[];
      };
    }).body.actions[0]!;
    expect(action.template_id).toBe("deploy_update");
    // The handler shapes updates into `[{ <package_id>: <version> }]`.
    expect(action.params.packages).toEqual([{ "pkg-foo": "2.4.0" }]);
  });

  it("tools/call action1_execute_and_wait dry_run=true returns preview", async () => {
    // action1_execute_and_wait first calls action1_get_endpoint to
    // detect platform — the stub serves that, then dry_run preempts
    // any further upstream call.
    const stub = buildFetchStub([
      {
        match: (url) =>
          url.includes("/endpoints/managed/") &&
          url.endsWith("00000000-0000-0000-0000-000000000000"),
        body: {
          id: "00000000-0000-0000-0000-000000000000",
          OS: "Windows 11 (25H2)",
          platform: "Windows",
          status: "Connected",
          last_seen: "2026-05-05_10-00-00",
        },
      },
    ]);
    vi.stubGlobal("fetch", stub);

    const result = await CLIENT.callTool({
      name: "action1_execute_and_wait",
      arguments: {
        endpoint_id: "00000000-0000-0000-0000-000000000000",
        mode: "script",
        script_text: "Get-Date",
        skip_connectivity_check: true,
        dry_run: true,
      },
    });
    expect(result.isError ?? false).toBe(false);
    const sc = result.structuredContent as Record<string, unknown> | undefined;
    expect(sc).toBeDefined();
    expect(sc!.dry_run).toBe(true);
    // Sharpen: pin the tool name and confirm a preview shape exists
    // (the wrapper's dry_run forwards to the underlying run_script
    // preview). `toBeDefined()` previously passed when `tool` was
    // `null`; pin the type so a regression that returns a non-string
    // tool name is caught.
    expect(typeof sc!.tool).toBe("string");
    expect((sc!.tool as string).length).toBeGreaterThan(0);
  });

  it("tools/call action1_automations_summary returns counters", async () => {
    const stub = buildFetchStub([
      {
        match: (url) =>
          url.includes("/automations/instances/") && !url.endsWith("/details"),
        body: {
          items: [
            { status: "Success", action_status: "OK" },
            { status: "Running" },
            { status: "Failed" },
          ],
        },
      },
    ]);
    vi.stubGlobal("fetch", stub);

    const result = await CLIENT.callTool({
      name: "action1_automations_summary",
      arguments: { response_format: "json" },
    });
    expect(result.isError ?? false).toBe(false);
    const sc = result.structuredContent as {
      total_scanned: number;
      by_status: Record<string, number>;
    } | undefined;
    expect(sc).toBeDefined();
    // Sharpen: pin the counter values, not just their types. The
    // mocked upstream had 3 items, one each of Success/Running/Failed.
    expect(sc!.total_scanned).toBe(3);
    expect(sc!.by_status.Success).toBe(1);
    expect(sc!.by_status.Running).toBe(1);
    expect(sc!.by_status.Failed).toBe(1);
  });

  it("tools/call action1_wait_for_automation polls once and returns the terminal status", async () => {
    // The wait_for_automation tool polls every poll_interval_seconds
    // (min 1). For test speed we set the timeout small and serve a
    // terminal status on the first poll so no actual sleep is needed.
    const terminal = {
      id: "inst-1",
      status: "Success",
      percent_completed: 100,
    };
    const stub = buildFetchStub([
      {
        match: (url) =>
          url.includes("/automations/instances/") && url.endsWith("inst-1"),
        body: terminal,
      },
    ]);
    vi.stubGlobal("fetch", stub);

    const result = await CLIENT.callTool({
      name: "action1_wait_for_automation",
      arguments: {
        instance_id: "inst-1",
        poll_interval_seconds: 1,
        timeout_seconds: 5,
      },
    });
    expect(result.isError ?? false).toBe(false);
    const sc = result.structuredContent as
      | { status?: { id?: string; status?: string; percent_completed?: number } }
      | undefined;
    expect(sc).toBeDefined();
    // wait_for_automation returns `{ status: <terminal instance> }` —
    // the inner object is the upstream payload. Sharpen: pin the
    // terminal status string and the instance id from the mock, not
    // just the presence of the key.
    expect(sc!.status?.id).toBe("inst-1");
    expect(sc!.status?.status).toBe("Success");
    expect(sc!.status?.percent_completed).toBe(100);
  });

  it("tools/call action1_get_automation_output returns filtered output", async () => {
    const stub = buildFetchStub([
      {
        match: (url) => url.includes("/endpoint-results/") && url.endsWith("/details"),
        body: {
          items: [
            { description: "Starting" },
            { description: "Hello world" },
            { description: "Completed" },
          ],
        },
      },
    ]);
    vi.stubGlobal("fetch", stub);

    const result = await CLIENT.callTool({
      name: "action1_get_automation_output",
      arguments: {
        instance_id: "inst-1",
        endpoint_id: "00000000-0000-0000-0000-000000000000",
      },
    });
    expect(result.isError ?? false).toBe(false);
    const sc = result.structuredContent as
      | { output?: string; lines_total?: number; lines_filtered?: number }
      | undefined;
    expect(sc).toBeDefined();
    // Status markers ("Starting" / "Completed") must be filtered out.
    const output = sc!.output as string;
    expect(output).toContain("Hello world");
    expect(output).not.toContain("Starting");
    expect(output).not.toContain("Completed");
  });

  it("generated tool descriptions use the `Perm:` footer (wording pin)", async () => {
    // Pass-6 review: pin the `Perm: <permission>.` wording in the
    // generated tool descriptions so a refactor that switches back
    // to "Permissions:" or "Required scope:" gets caught.
    const tools = await CLIENT.listTools();
    const withPerm = tools.tools.filter((t) =>
      (t.description ?? "").includes("Perm:"),
    );
    // At least 50 of the 133 generated tools have permission tags in
    // the spec — if the prefix wording silently changes, hundreds of
    // descriptions degrade without a single test breaking.
    expect(withPerm.length).toBeGreaterThanOrEqual(50);
  });

  // -----------------------------------------------------------------
  // Pass-N audit: waitForInstance used to short-circuit on
  // `status === "Running" && percent_completed === "100"`. That was a
  // workaround for a suspected Action1 quirk, but it returned a
  // non-terminal status as if it were terminal — for destructive
  // workflows that's a correctness bug. The new behaviour: only the
  // states in TERMINAL_STATUSES (Success/Failed/Stopped/Error/Cancelled)
  // terminate the poll. Running@100% must NOT short-circuit.
  // -----------------------------------------------------------------

  it("action1_wait_for_automation keeps polling on Running+100% and returns the terminal Success", async () => {
    let calls = 0;
    const stub = buildFetchStub([
      {
        match: (url) =>
          url.includes("/automations/instances/") && url.endsWith("inst-running-100"),
        body: { id: "inst-running-100", status: "Running", percent_completed: 100 },
      },
    ]);
    // Override the route order: the first poll returns Running+100%,
    // subsequent polls return Success. We swap the route once the
    // first call has been seen.
    const finalStub = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith("/oauth2/token")) {
        return new Response(
          JSON.stringify({ access_token: "tkn", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/automations/instances/") && url.endsWith("inst-running-100")) {
        calls += 1;
        const body = calls === 1
          ? { id: "inst-running-100", status: "Running", percent_completed: 100 }
          : { id: "inst-running-100", status: "Success", percent_completed: 100 };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      void init;
      return new Response(JSON.stringify({ error: "no route", url }), {
        status: 599,
        headers: { "Content-Type": "application/json" },
      });
    });
    void stub;
    vi.stubGlobal("fetch", finalStub);

    const result = await CLIENT.callTool({
      name: "action1_wait_for_automation",
      arguments: {
        instance_id: "inst-running-100",
        poll_interval_seconds: 1,
        timeout_seconds: 5,
      },
    });
    expect(result.isError ?? false).toBe(false);
    const sc = result.structuredContent as {
      status?: { id?: string; status?: string };
    };
    // The poll did NOT terminate on Running+100%; it waited until
    // Success on the second call. `calls` should be >= 2.
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(sc.status?.status).toBe("Success");
  });

  // -----------------------------------------------------------------
  // Pass-N audit: action1_audit_log_search previously let records
  // with unparseable timestamps bypass the time filter silently. The
  // new behaviour: when a time filter is active, drop those records
  // AND surface a `dropped_unparseable_timestamps` counter so the
  // agent can detect upstream schema regressions.
  // -----------------------------------------------------------------

  it("action1_audit_log_search drops items with unparseable timestamps and surfaces a counter", async () => {
    const stub = buildFetchStub([
      {
        match: (url) => url.includes("/audit/events"),
        body: {
          items: [
            // Two valid records within the time window.
            { time: "2026-05-10T10:00:00Z", user: "alice", event_type: "login", target: "console" },
            { time: "2026-05-11T10:00:00Z", user: "bob", event_type: "logout", target: "console" },
            // One record with a broken timestamp — must be dropped.
            { time: "not-a-timestamp", user: "mallory", event_type: "exploit", target: "console" },
          ],
        },
      },
    ]);
    vi.stubGlobal("fetch", stub);

    const result = await CLIENT.callTool({
      name: "action1_audit_log_search",
      arguments: {
        from_time: "2026-05-09T00:00:00Z",
        to_time: "2026-05-12T00:00:00Z",
        response_format: "json",
      },
    });
    expect(result.isError ?? false).toBe(false);
    const sc = result.structuredContent as {
      items: unknown[];
      count: number;
      dropped_unparseable_timestamps?: number;
    };
    expect(sc.count).toBe(2);
    expect(sc.dropped_unparseable_timestamps).toBe(1);
  });

  // -----------------------------------------------------------------
  // Pass-N audit: action1_cve_remediation_plan used to swallow ALL
  // errors from the vulnerabilities fetch (`.catch(() => ({ items: [] }))`).
  // That made a 403 (caller lacks the vuln-read scope) visually
  // indistinguishable from "no vulns found", so the agent reported
  // "nothing to do" for an endpoint it actually couldn't see. The new
  // behaviour: surface 403/404 as a `warning` in the output; re-throw
  // anything else.
  // -----------------------------------------------------------------

  it("action1_cve_remediation_plan surfaces a warning when the vulnerabilities fetch returns 403", async () => {
    const stub = buildFetchStub([
      {
        match: (url) =>
          url.includes("/endpoints/managed/") && url.endsWith("/vulnerabilities"),
        status: 403,
        body: { error: "forbidden" },
      },
    ]);
    vi.stubGlobal("fetch", stub);
    const result = await CLIENT.callTool({
      name: "action1_cve_remediation_plan",
      arguments: {
        endpoint_id: "00000000-1111-2222-3333-444444444444",
        max_items: 5,
        response_format: "json",
      },
    });
    expect(result.isError ?? false).toBe(false);
    const sc = result.structuredContent as { plan: unknown[]; warning?: string };
    expect(sc.warning).toBeDefined();
    expect(sc.warning).toContain("403");
    expect(sc.warning).toContain("plan may be incomplete");
    expect(sc.plan).toEqual([]);
  });

  it("no tool description ends on an ungrammatical connector", async () => {
    // Pass-6 review safety net: ensure the iterative connector-strip in
    // generate.ts keeps converging. If a pathological description ever
    // sneaks past the safety counter the description would still end on
    // "of." / "in." / etc. — this test catches it.
    const tools = await CLIENT.listTools();
    // Pass-9 review #6 + Pass-10 review #3: import the connector list
    // from a side-effect-free module (importing generate.js previously
    // triggered its top-level main() at test time).
    const { INCOMPLETE_TAIL_CONNECTORS } = await import(
      "../../src/codegen/connectors.js"
    );
    const bad: string[] = [];
    for (const t of tools.tools) {
      const desc = t.description ?? "";
      for (const c of INCOMPLETE_TAIL_CONNECTORS) {
        // Two patterns:
        //   (a) connector + period followed by a Footer ("Perm:" / "See action1").
        //   (b) connector + period as the last visible token (with optional
        //       trailing whitespace, including \n — \s matches them all).
        const beforeFooter = new RegExp(
          `\\b${c}\\.\\s+(Perm:|See action1)`,
          "i",
        );
        const atVeryEnd = new RegExp(`\\b${c}\\.\\s*$`, "i");
        if (beforeFooter.test(desc) || atVeryEnd.test(desc)) {
          bad.push(t.name);
          break;
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildServer(client) singleton wiring — Pass-13 Item 1.
//
// Before this fix, the HTTP transport's /mcp handler called
// `buildServer()` once PER REQUEST and instantiated a fresh
// Action1Client (and its TokenProvider) every time. Effect: every tool
// call paid an OAuth round-trip because the in-process token cache
// was scoped to a single-request McpServer that immediately closed.
//
// The fix: pass an existing Action1Client into buildServer(). The
// McpServer remains per-request (stateless transport requires it),
// but the upstream-facing client (and its token cache) is shared.
//
// Test strategy: wire 5 tool calls through 5 fresh McpServers that
// all share ONE Action1Client. Mock fetch and assert exactly one
// call to /oauth2/token in total. If the fix regresses we'd see 5.
// ---------------------------------------------------------------------------

describe("buildServer(client) reuses the supplied Action1Client (Pass-13 Item 1)", () => {
  afterAll(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("five separate buildServer(sharedClient) calls share one TokenProvider (one /oauth2/token fetch)", async () => {
    let tokenFetches = 0;
    const stub = vi.fn(async (url: string, init: RequestInit = {}) => {
      void init;
      if (url.endsWith("/oauth2/token")) {
        tokenFetches += 1;
        return new Response(
          JSON.stringify({ access_token: "shared-t", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/organizations")) {
        return new Response(
          JSON.stringify({ items: [{ id: "org-1", name: "Acme" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "no route" }), {
        status: 599,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", stub);

    const { Action1Client } = await import("../../src/client/action1Client.js");
    const { loadConfig, resetConfigCache } = await import("../../src/config.js");
    resetConfigCache();
    const sharedClient = new Action1Client(loadConfig());

    const { Client: SdkClient } = await import(
      "@modelcontextprotocol/sdk/client/index.js"
    );
    const { InMemoryTransport } = await import(
      "@modelcontextprotocol/sdk/inMemory.js"
    );

    for (let i = 0; i < 5; i++) {
      const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
      // buildServer(sharedClient) is the wire we are asserting:
      // each iteration must reuse `sharedClient.tokens`, not new it.
      const built = buildServer(sharedClient);
      await built.server.connect(serverTx);
      const sdkClient = new SdkClient(
        { name: "singleton-test", version: "0.0.0" },
        { capabilities: { tools: {} } },
      );
      await sdkClient.connect(clientTx);
      const result = await sdkClient.callTool({
        name: "action1_list_organizations",
        arguments: { response_format: "json" },
      });
      expect(result.isError ?? false).toBe(false);
      await sdkClient.close();
      await built.server.close();
    }
    // ONE token fetch total across 5 tool-calls. With the bug, this
    // would be 5 (each per-request Action1Client fetches its own
    // token on first use).
    expect(tokenFetches).toBe(1);
  });
});
