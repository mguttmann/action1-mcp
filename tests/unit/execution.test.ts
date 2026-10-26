import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../../src/config.js";

// Unit-tests for the curated execution-tool handlers in
// src/tools/execution.ts. Until this file landed, the 564-LOC module was
// covered by a single dry_run integration test - every input-validation
// branch and the run_script OS-routing logic were untested.
//
// Pattern (mirrors the integration test in tests/integration/server.test.ts):
//   1. Boot a full MCP server via buildServer() over an in-memory
//      transport pair. This exercises the real registerTool path so
//      schema validation actually runs.
//   2. Per test: stub `globalThis.fetch` with a route table. Any request
//      that doesn't match returns a 599 sentinel so a leaked upstream
//      call fails the test loudly instead of silently.
//   3. Drive the tools via the SDK client's `callTool` - this puts the
//      registered ZodObject through the validator and surfaces
//      structuredContent the same way an MCP host would.

let buildServer: typeof import("../../src/server.js").buildServer;
let SERVER: ReturnType<typeof import("../../src/server.js").buildServer>;
let CLIENT: import("@modelcontextprotocol/client").Client;

beforeAll(async () => {
  process.env.ACTION1_BASE_URL = "https://app.eu.action1.test/api/3.0";
  process.env.ACTION1_CLIENT_ID = "client-id-test";
  process.env.ACTION1_CLIENT_SECRET = "client-secret-test";
  process.env.ACTION1_ORG_ID = "00000000-0000-0000-0000-000000000001";
  resetConfigCache();
  buildServer = (await import("../../src/server.js")).buildServer;

  const { Client } = await import("@modelcontextprotocol/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/server");
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();

  SERVER = buildServer();
  await SERVER.server.connect(serverTx);

  CLIENT = new Client({ name: "execution-unit-test", version: "0.0.0" });
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

const ENDPOINT_UUID = "11111111-2222-3333-4444-555555555555";

interface ScriptedResponse {
  match: (url: string, init: RequestInit) => boolean;
  status?: number;
  body?: object | string;
}

function buildFetchStub(routes: ScriptedResponse[]): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string, init: RequestInit = {}) => {
    // OAuth dance - always serve a fresh token so the tool body actually
    // reaches the request site.
    if (url.endsWith("/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "tkn", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    for (const r of routes) {
      if (r.match(url, init)) {
        const status = r.status ?? 200;
        const body =
          r.body === undefined
            ? null
            : typeof r.body === "string"
              ? r.body
              : JSON.stringify(r.body);
        return new Response(body, {
          status,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    // Unmatched call - surface a sentinel so the test fails loudly.
    return new Response(JSON.stringify({ error: "no route matched", url }), {
      status: 599,
      headers: { "Content-Type": "application/json" },
    });
  });
}

function nonTokenCallCount(stub: ReturnType<typeof vi.fn>): number {
  return stub.mock.calls.filter((c) => !String(c[0]).endsWith("/oauth2/token")).length;
}

// ----- Per-destructive-tool dry_run preview shape ---------------------

describe.each([
  {
    tool: "action1_run_powershell",
    args: {
      endpoint_id: ENDPOINT_UUID,
      script_text: "Get-Process",
      dry_run: true,
    },
    expectPathContains: "/policies/instances/",
  },
  {
    tool: "action1_run_bash_macos",
    args: {
      endpoint_id: ENDPOINT_UUID,
      script_text: "uname -a",
      dry_run: true,
    },
    expectPathContains: "/automations/instances/",
  },
  {
    tool: "action1_reboot_endpoint",
    args: { endpoint_id: ENDPOINT_UUID, dry_run: true },
    expectPathContains: "/policies/instances/",
  },
  {
    tool: "action1_deploy_update",
    args: {
      endpoint_id: ENDPOINT_UUID,
      updates: [{ package_id: "pkg-1", version: "1.0" }],
      dry_run: true,
    },
    expectPathContains: "/policies/instances/",
  },
  {
    tool: "action1_deploy_package",
    args: {
      endpoint_id: ENDPOINT_UUID,
      params: { package: "AnyDesk" },
      dry_run: true,
    },
    expectPathContains: "/policies/instances/",
  },
  {
    tool: "action1_uninstall_program",
    args: {
      endpoint_id: ENDPOINT_UUID,
      params: { program: "AnyDesk" },
      dry_run: true,
    },
    expectPathContains: "/policies/instances/",
  },
  {
    tool: "action1_run_data_collection",
    args: { endpoint_id: ENDPOINT_UUID, dry_run: true },
    expectPathContains: "/policies/instances/",
  },
])("$tool dry_run=true", ({ tool, args, expectPathContains }) => {
  it("returns a preview with method/path/body and makes no upstream call", async () => {
    const stub = buildFetchStub([]);
    vi.stubGlobal("fetch", stub);

    const result = await CLIENT.callTool({ name: tool, arguments: args });

    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as Record<string, unknown> | undefined;
    expect(sc).toBeDefined();
    expect(sc!.dry_run).toBe(true);
    expect(sc!.tool).toBe(tool);
    const would = sc!.would_send as Record<string, unknown>;
    expect(would.method).toBe("POST");
    expect(would.path).toContain(expectPathContains);
    expect(would.body).toBeDefined();
    expect(nonTokenCallCount(stub)).toBe(0);
  });
});

// ----- Input-validation error per destructive tool --------------------

describe("destructive tools - input validation", () => {
  it("action1_run_powershell rejects missing script_text", async () => {
    vi.stubGlobal("fetch", buildFetchStub([]));
    const result = await CLIENT.callTool({
      name: "action1_run_powershell",
      arguments: { endpoint_id: ENDPOINT_UUID, dry_run: true },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]!.text;
    // The MCP SDK surfaces zod issues as a validation failure with the
    // offending path.
    expect(text.toLowerCase()).toMatch(/script_text|required|validation|invalid/);
  });

  it("action1_reboot_endpoint rejects missing endpoint_id", async () => {
    vi.stubGlobal("fetch", buildFetchStub([]));
    const result = await CLIENT.callTool({
      name: "action1_reboot_endpoint",
      arguments: { dry_run: true },
    });
    expect(result.isError).toBe(true);
  });

  it("action1_run_powershell rejects malformed success_exit_codes", async () => {
    vi.stubGlobal("fetch", buildFetchStub([]));
    const result = await CLIENT.callTool({
      name: "action1_run_powershell",
      arguments: {
        endpoint_id: ENDPOINT_UUID,
        script_text: "Get-Date",
        success_exit_codes: "0; rm -rf /", // contains non-digit/comma → rejected
        dry_run: true,
      },
    });
    expect(result.isError).toBe(true);
  });

  it("action1_deploy_update rejects empty updates[]", async () => {
    vi.stubGlobal("fetch", buildFetchStub([]));
    const result = await CLIENT.callTool({
      name: "action1_deploy_update",
      arguments: {
        endpoint_id: ENDPOINT_UUID,
        updates: [], // min(1) constraint
        dry_run: true,
      },
    });
    expect(result.isError).toBe(true);
  });

  it("action1_deploy_update rejects updates entry missing package_id", async () => {
    vi.stubGlobal("fetch", buildFetchStub([]));
    const result = await CLIENT.callTool({
      name: "action1_deploy_update",
      arguments: {
        endpoint_id: ENDPOINT_UUID,
        updates: [{ version: "1.0" }],
        dry_run: true,
      },
    });
    expect(result.isError).toBe(true);
  });

  it("action1_deploy_package rejects missing params", async () => {
    vi.stubGlobal("fetch", buildFetchStub([]));
    const result = await CLIENT.callTool({
      name: "action1_deploy_package",
      arguments: { endpoint_id: ENDPOINT_UUID, dry_run: true },
    });
    expect(result.isError).toBe(true);
  });

  it("action1_uninstall_program rejects missing params", async () => {
    vi.stubGlobal("fetch", buildFetchStub([]));
    const result = await CLIENT.callTool({
      name: "action1_uninstall_program",
      arguments: { endpoint_id: ENDPOINT_UUID, dry_run: true },
    });
    expect(result.isError).toBe(true);
  });

  it("rejects an endpoint_id that fails the UUID / Group-ID pattern", async () => {
    vi.stubGlobal("fetch", buildFetchStub([]));
    const result = await CLIENT.callTool({
      name: "action1_reboot_endpoint",
      arguments: { endpoint_id: "../etc/passwd", dry_run: true },
    });
    expect(result.isError).toBe(true);
  });
});

// ----- run_script OS-routing -----------------------------------------

describe("action1_run_script OS routing", () => {
  it("routes Windows endpoint to POST /policies/instances/", async () => {
    // skip_connectivity_check=true so the stale last_seen check doesn't
    // short-circuit the routing logic.
    const stub = buildFetchStub([
      {
        // GET /endpoints/managed/{orgId}/{endpointId}
        match: (url, init) =>
          (init?.method ?? "GET") === "GET" &&
          url.includes("/endpoints/managed/") &&
          url.endsWith(ENDPOINT_UUID),
        body: {
          id: ENDPOINT_UUID,
          OS: "Windows 11 (25H2)",
          platform: "Windows",
          status: "Connected",
          last_seen: "2026-05-12_11-00-00",
        },
      },
    ]);
    vi.stubGlobal("fetch", stub);

    const result = await CLIENT.callTool({
      name: "action1_run_script",
      arguments: {
        endpoint_id: ENDPOINT_UUID,
        script_text: "Get-Date",
        skip_connectivity_check: true,
        dry_run: true,
      },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.dry_run).toBe(true);
    const would = sc.would_send as Record<string, unknown>;
    expect(would.path).toContain("/policies/instances/");
    // Body contains the run_powershell template id.
    const body = would.body as { actions: { template_id: string }[] };
    expect(body.actions[0]!.template_id).toBe("run_powershell");
  });

  it("routes macOS endpoint to POST /automations/instances/", async () => {
    const stub = buildFetchStub([
      {
        match: (url, init) =>
          (init?.method ?? "GET") === "GET" &&
          url.includes("/endpoints/managed/") &&
          url.endsWith(ENDPOINT_UUID),
        body: {
          id: ENDPOINT_UUID,
          OS: "macOS 14",
          platform: "Mac",
          status: "Connected",
          last_seen: "2026-05-12_11-00-00",
        },
      },
    ]);
    vi.stubGlobal("fetch", stub);

    const result = await CLIENT.callTool({
      name: "action1_run_script",
      arguments: {
        endpoint_id: ENDPOINT_UUID,
        script_text: "uname -a",
        skip_connectivity_check: true,
        dry_run: true,
      },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as Record<string, unknown>;
    const would = sc.would_send as Record<string, unknown>;
    expect(would.path).toContain("/automations/instances/");
    const body = would.body as { actions: { template_id: string }[] };
    expect(body.actions[0]!.template_id).toBe("run_script");
  });

  it("returns a friendly error on Linux endpoints (no auto-routing)", async () => {
    const stub = buildFetchStub([
      {
        match: (url) => url.includes("/endpoints/managed/") && url.endsWith(ENDPOINT_UUID),
        body: {
          id: ENDPOINT_UUID,
          OS: "Ubuntu 22.04",
          platform: "Linux",
          status: "Connected",
          last_seen: "2026-05-12_11-00-00",
        },
      },
    ]);
    vi.stubGlobal("fetch", stub);

    const result = await CLIENT.callTool({
      name: "action1_run_script",
      arguments: {
        endpoint_id: ENDPOINT_UUID,
        script_text: "echo hi",
        skip_connectivity_check: true,
        dry_run: true,
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]!.text;
    expect(text.toLowerCase()).toMatch(/linux|cannot auto-run|platform/);
  });
});

// ----- run_script connectivity check ---------------------------------

describe("action1_run_script connectivity check", () => {
  it("aborts when last_seen is stale and skip_connectivity_check is unset", async () => {
    // last_seen = year 2000 → 25+ years old → well past the 10-minute
    // staleAfterMinutes threshold in lastSeen.ts.
    const stub = buildFetchStub([
      {
        match: (url) => url.includes("/endpoints/managed/") && url.endsWith(ENDPOINT_UUID),
        body: {
          id: ENDPOINT_UUID,
          OS: "Windows 11",
          platform: "Windows",
          status: "Connected",
          last_seen: "2000-01-01_00-00-00",
        },
      },
    ]);
    vi.stubGlobal("fetch", stub);

    const result = await CLIENT.callTool({
      name: "action1_run_script",
      arguments: {
        endpoint_id: ENDPOINT_UUID,
        script_text: "Get-Date",
        dry_run: true,
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]!.text;
    expect(text).toMatch(/not reachable|skip_connectivity_check/);
  });

  it("proceeds when skip_connectivity_check=true even with a stale last_seen", async () => {
    const stub = buildFetchStub([
      {
        match: (url) => url.includes("/endpoints/managed/") && url.endsWith(ENDPOINT_UUID),
        body: {
          id: ENDPOINT_UUID,
          OS: "Windows 11",
          platform: "Windows",
          status: "Connected",
          last_seen: "2000-01-01_00-00-00",
        },
      },
    ]);
    vi.stubGlobal("fetch", stub);

    const result = await CLIENT.callTool({
      name: "action1_run_script",
      arguments: {
        endpoint_id: ENDPOINT_UUID,
        script_text: "Get-Date",
        skip_connectivity_check: true,
        dry_run: true,
      },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.dry_run).toBe(true);
  });
});

// ----- Payload-content pins ------------------------------------------

describe("destructive tool preview body content", () => {
  it("action1_reboot_endpoint emits template_id='reboot' in the dry_run body", async () => {
    vi.stubGlobal("fetch", buildFetchStub([]));
    const result = await CLIENT.callTool({
      name: "action1_reboot_endpoint",
      arguments: { endpoint_id: ENDPOINT_UUID, dry_run: true },
    });
    const sc = result.structuredContent as Record<string, unknown>;
    const body = (sc.would_send as { body: { actions: { template_id: string }[] } }).body;
    expect(body.actions[0]!.template_id).toBe("reboot");
  });

  it("action1_deploy_update emits template_id='deploy_update' and lists the package", async () => {
    vi.stubGlobal("fetch", buildFetchStub([]));
    const result = await CLIENT.callTool({
      name: "action1_deploy_update",
      arguments: {
        endpoint_id: ENDPOINT_UUID,
        updates: [{ package_id: "pkg-xyz", version: "1.2.3" }],
        dry_run: true,
      },
    });
    const sc = result.structuredContent as Record<string, unknown>;
    const action = (
      sc.would_send as {
        body: { actions: { template_id: string; params: { packages: unknown[] } }[] };
      }
    ).body.actions[0]!;
    expect(action.template_id).toBe("deploy_update");
    expect(action.params.packages).toEqual([{ "pkg-xyz": "1.2.3" }]);
  });

  it("action1_deploy_update passes the repository version 'Latest' through unchanged", async () => {
    // The spec lists "Latest" as the version of repository-package
    // missing updates, and the live vulnerability rows carry it for
    // Windows updates. The spec documents no empty-string meaning for
    // the deploy body, so the description must not promise one.
    vi.stubGlobal("fetch", buildFetchStub([]));
    const result = await CLIENT.callTool({
      name: "action1_deploy_update",
      arguments: {
        endpoint_id: ENDPOINT_UUID,
        updates: [{ package_id: "pkg-win", version: "Latest" }],
        dry_run: true,
      },
    });
    const sc = result.structuredContent as Record<string, unknown>;
    const action = (sc.would_send as { body: { actions: { params: { packages: unknown[] } }[] } })
      .body.actions[0]!;
    expect(action.params.packages).toEqual([{ "pkg-win": "Latest" }]);

    const { tools } = await CLIENT.listTools();
    const tool = tools.find((t) => t.name === "action1_deploy_update")!;
    const updates = tool.inputSchema.properties!.updates as {
      items: { properties: { version: { description: string } } };
    };
    const desc = updates.items.properties.version.description;
    expect(desc).toMatch(/Latest/);
    expect(desc).not.toMatch(/empty string/i);
  });

  it("action1_run_powershell emits template_id='run_powershell' with script_text in params", async () => {
    vi.stubGlobal("fetch", buildFetchStub([]));
    const result = await CLIENT.callTool({
      name: "action1_run_powershell",
      arguments: {
        endpoint_id: ENDPOINT_UUID,
        script_text: "Get-Service",
        dry_run: true,
      },
    });
    const sc = result.structuredContent as Record<string, unknown>;
    const action = (
      sc.would_send as {
        body: {
          actions: {
            template_id: string;
            params: { script_text: string };
          }[];
        };
      }
    ).body.actions[0]!;
    expect(action.template_id).toBe("run_powershell");
    expect(action.params.script_text).toBe("Get-Service");
  });
});

// ----- asStartedJob behaviour on bad upstream responses ----------------
//
// When the upstream POST returned an object without a
// string `id` / `instance_id`, the previous implementation emitted a
// success-shape with `instance_id: undefined`. Downstream tools like
// `action1_wait_for_automation` then crashed with "instance_id is
// required" because their Zod schema is `z.string().min(1)`. We now
// fail loud at the source - return an explicit `errorResult` so the
// agent sees the parse failure and the raw body in one place.

describe("started-job extraction failure modes", () => {
  it("action1_run_powershell with allow=true + confirm=YES surfaces an explicit error when the API returns no id", async () => {
    process.env.ACTION1_ALLOW_DESTRUCTIVE = "true";
    resetConfigCache();
    // Upstream returns 200 OK but no `id` / `instance_id`. The old code
    // would have surfaced a success-shape with `instance_id: undefined`
    // and a `warning` field; the new code surfaces an errorResult.
    const stub = buildFetchStub([
      {
        match: (url, init) =>
          (init?.method ?? "GET") === "POST" && url.includes("/policies/instances/"),
        body: { unexpected_shape: true },
      },
    ]);
    vi.stubGlobal("fetch", stub);
    try {
      const result = await CLIENT.callTool({
        name: "action1_run_powershell",
        arguments: {
          endpoint_id: ENDPOINT_UUID,
          script_text: "Get-Date",
          dry_run: false,
          confirm: "YES",
        },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as { text: string }[])[0]!.text;
      expect(text).toContain("no_instance_id");
      expect(text).toContain("unexpected_shape");
    } finally {
      delete process.env.ACTION1_ALLOW_DESTRUCTIVE;
      resetConfigCache();
    }
  });
});

// ----- timeout_minutes / retry_minutes accept both shapes -------------
//
// `timeout_minutes` was `z.string().regex(/^\d+$/)` while
// `retry_minutes` was `z.number().int().min(0)` - agents that passed
// numbers for the former or strings for the latter saw bafflingly
// asymmetric validation errors. Both now accept either shape.

describe("destructive tools accept timeout_minutes and retry_minutes as number OR string", () => {
  it("action1_run_powershell accepts numeric timeout_minutes", async () => {
    vi.stubGlobal("fetch", buildFetchStub([]));
    const result = await CLIENT.callTool({
      name: "action1_run_powershell",
      arguments: {
        endpoint_id: ENDPOINT_UUID,
        script_text: "Get-Date",
        timeout_minutes: 15,
        dry_run: true,
      },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as Record<string, unknown>;
    const action = (
      sc.would_send as {
        body: { actions: { params: { timeout_minutes: string } }[] };
      }
    ).body.actions[0]!;
    // Payload-builder normalises to the wire-shape string.
    expect(action.params.timeout_minutes).toBe("15");
  });

  it("action1_run_powershell accepts digit-string timeout_minutes", async () => {
    vi.stubGlobal("fetch", buildFetchStub([]));
    const result = await CLIENT.callTool({
      name: "action1_run_powershell",
      arguments: {
        endpoint_id: ENDPOINT_UUID,
        script_text: "Get-Date",
        timeout_minutes: "20",
        dry_run: true,
      },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as Record<string, unknown>;
    const action = (
      sc.would_send as {
        body: { actions: { params: { timeout_minutes: string } }[] };
      }
    ).body.actions[0]!;
    expect(action.params.timeout_minutes).toBe("20");
  });

  it("action1_run_powershell accepts string retry_minutes", async () => {
    vi.stubGlobal("fetch", buildFetchStub([]));
    const result = await CLIENT.callTool({
      name: "action1_run_powershell",
      arguments: {
        endpoint_id: ENDPOINT_UUID,
        script_text: "Get-Date",
        retry_minutes: "300",
        dry_run: true,
      },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as Record<string, unknown>;
    const body = (sc.would_send as { body: { retry_minutes: number } }).body;
    expect(body.retry_minutes).toBe(300);
  });

  it("action1_run_powershell accepts numeric retry_minutes", async () => {
    vi.stubGlobal("fetch", buildFetchStub([]));
    const result = await CLIENT.callTool({
      name: "action1_run_powershell",
      arguments: {
        endpoint_id: ENDPOINT_UUID,
        script_text: "Get-Date",
        retry_minutes: 60,
        dry_run: true,
      },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as Record<string, unknown>;
    const body = (sc.would_send as { body: { retry_minutes: number } }).body;
    expect(body.retry_minutes).toBe(60);
  });

  it("action1_run_powershell still rejects non-digit timeout_minutes", async () => {
    vi.stubGlobal("fetch", buildFetchStub([]));
    const result = await CLIENT.callTool({
      name: "action1_run_powershell",
      arguments: {
        endpoint_id: ENDPOINT_UUID,
        script_text: "Get-Date",
        timeout_minutes: "10m",
        dry_run: true,
      },
    });
    expect(result.isError).toBe(true);
  });
});

// ----- Reboot connectivity check + skip flag --------------------------
//
// action1_reboot_endpoint used to fire without a
// connectivity check. The Action1 server happily accepts a reboot for
// an offline endpoint and queues it for the next check-in - which can
// be days later. That's a foot-gun for an agent that just confirmed
// "is the endpoint online?" five seconds ago. Mirror run_script's
// abort logic, and gate it behind skip_connectivity_check for the
// rare case the agent really does want a delayed reboot.

describe("action1_reboot_endpoint connectivity check", () => {
  it("aborts when last_seen is stale and skip_connectivity_check is unset", async () => {
    process.env.ACTION1_ALLOW_DESTRUCTIVE = "true";
    resetConfigCache();
    const stub = buildFetchStub([
      {
        match: (url) => url.includes("/endpoints/managed/") && url.endsWith(ENDPOINT_UUID),
        body: {
          id: ENDPOINT_UUID,
          status: "Connected",
          last_seen: "2000-01-01_00-00-00",
        },
      },
    ]);
    vi.stubGlobal("fetch", stub);
    try {
      const result = await CLIENT.callTool({
        name: "action1_reboot_endpoint",
        arguments: {
          endpoint_id: ENDPOINT_UUID,
          dry_run: false,
          confirm: "YES",
        },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as { text: string }[])[0]!.text;
      expect(text).toMatch(/not reachable|skip_connectivity_check/);
    } finally {
      delete process.env.ACTION1_ALLOW_DESTRUCTIVE;
      resetConfigCache();
    }
  });

  it("bypasses the connectivity check when skip_connectivity_check=true", async () => {
    process.env.ACTION1_ALLOW_DESTRUCTIVE = "true";
    resetConfigCache();
    const stub = buildFetchStub([
      // No /endpoints/managed/ route - if the handler tries to fetch
      // endpoint info, the stub returns 599 and we'd see an error here.
      {
        match: (url, init) =>
          (init?.method ?? "GET") === "POST" && url.includes("/policies/instances/"),
        body: { id: "reboot-instance-uuid-123" },
      },
    ]);
    vi.stubGlobal("fetch", stub);
    try {
      const result = await CLIENT.callTool({
        name: "action1_reboot_endpoint",
        arguments: {
          endpoint_id: ENDPOINT_UUID,
          dry_run: false,
          confirm: "YES",
          skip_connectivity_check: true,
        },
      });
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.instance_id).toBe("reboot-instance-uuid-123");
    } finally {
      delete process.env.ACTION1_ALLOW_DESTRUCTIVE;
      resetConfigCache();
    }
  });

  it("dry_run preview short-circuits before the connectivity GET (no upstream call)", async () => {
    const stub = buildFetchStub([]);
    vi.stubGlobal("fetch", stub);
    const result = await CLIENT.callTool({
      name: "action1_reboot_endpoint",
      arguments: { endpoint_id: ENDPOINT_UUID, dry_run: true },
    });
    expect(result.isError).toBeFalsy();
    // Crucially: no non-token call was made - dry_run must not fetch
    // endpoint info for the connectivity check.
    expect(nonTokenCallCount(stub)).toBe(0);
  });
});

// ----- run_script with target_type=EndpointGroup ----------------------
//
// A group id must not be probed as a single endpoint (that lookup
// returns 404 for a group), and the target type reaches the payload
// builders. A group has no single OS to detect, so the caller names it
// via `os`.

const GROUP_ID = "Marketing_Laptops-01";

describe("action1_run_script with target_type=EndpointGroup", () => {
  it.each([
    { os: "windows", path: "/policies/instances/", template: "run_powershell" },
    { os: "macos", path: "/automations/instances/", template: "run_script" },
  ])(
    "dry_run with os=$os previews a group-targeted $template body without upstream calls",
    async ({ os, path, template }) => {
      const stub = buildFetchStub([]);
      vi.stubGlobal("fetch", stub);
      const result = await CLIENT.callTool({
        name: "action1_run_script",
        arguments: {
          endpoint_id: GROUP_ID,
          target_type: "EndpointGroup",
          os,
          script_text: "hostname",
          dry_run: true,
        },
      });
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as Record<string, unknown>;
      const would = sc.would_send as {
        path: string;
        body: { endpoints: unknown[]; actions: { template_id: string }[] };
      };
      expect(would.path).toContain(path);
      expect(would.body.endpoints).toEqual([{ id: GROUP_ID, type: "EndpointGroup" }]);
      expect(would.body.actions[0]!.template_id).toBe(template);
      expect(nonTokenCallCount(stub)).toBe(0);
    },
  );

  it("rejects a group target without os, before any upstream call", async () => {
    const stub = buildFetchStub([]);
    vi.stubGlobal("fetch", stub);
    const result = await CLIENT.callTool({
      name: "action1_run_script",
      arguments: {
        endpoint_id: GROUP_ID,
        target_type: "EndpointGroup",
        script_text: "hostname",
        dry_run: true,
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]!.text;
    expect(text).toMatch(/os/);
    expect(nonTokenCallCount(stub)).toBe(0);
  });

  it("executes against the group with one POST and no endpoint lookup", async () => {
    process.env.ACTION1_ALLOW_DESTRUCTIVE = "true";
    resetConfigCache();
    const stub = buildFetchStub([
      {
        match: (url, init) =>
          (init?.method ?? "GET") === "POST" && url.includes("/policies/instances/"),
        body: { id: "group-instance-1" },
      },
    ]);
    vi.stubGlobal("fetch", stub);
    try {
      const result = await CLIENT.callTool({
        name: "action1_run_script",
        arguments: {
          endpoint_id: GROUP_ID,
          target_type: "EndpointGroup",
          os: "windows",
          script_text: "Get-Date",
          dry_run: false,
          confirm: "YES",
        },
      });
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.instance_id).toBe("group-instance-1");
      expect(sc.platform).toBe("windows");
      const calls = stub.mock.calls.filter((c) => !String(c[0]).endsWith("/oauth2/token"));
      expect(calls).toHaveLength(1);
      const sent = JSON.parse((calls[0]![1] as RequestInit).body as string) as {
        endpoints: unknown[];
      };
      expect(sent.endpoints).toEqual([{ id: GROUP_ID, type: "EndpointGroup" }]);
    } finally {
      delete process.env.ACTION1_ALLOW_DESTRUCTIVE;
      resetConfigCache();
    }
  });

  it("rejects an explicit os that contradicts the detected endpoint OS", async () => {
    const stub = buildFetchStub([
      {
        match: (url) => url.includes("/endpoints/managed/") && url.endsWith(ENDPOINT_UUID),
        body: { id: ENDPOINT_UUID, OS: "macOS 14", platform: "Mac", status: "Connected" },
      },
    ]);
    vi.stubGlobal("fetch", stub);
    const result = await CLIENT.callTool({
      name: "action1_run_script",
      arguments: {
        endpoint_id: ENDPOINT_UUID,
        os: "windows",
        script_text: "Get-Date",
        skip_connectivity_check: true,
        dry_run: true,
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]!.text;
    expect(text).toMatch(/macos/);
  });
});

// ----- Input bounds ----------------------------------------------------

describe("execution input bounds", () => {
  it.each(["99999", "10081"])(
    "rejects digit-string timeout_minutes %s above the numeric cap",
    async (v) => {
      vi.stubGlobal("fetch", buildFetchStub([]));
      const result = await CLIENT.callTool({
        name: "action1_run_powershell",
        arguments: {
          endpoint_id: ENDPOINT_UUID,
          script_text: "Get-Date",
          timeout_minutes: v,
          dry_run: true,
        },
      });
      expect(result.isError).toBe(true);
    },
  );

  it("still accepts digit-string retry_minutes at the cap", async () => {
    vi.stubGlobal("fetch", buildFetchStub([]));
    const result = await CLIENT.callTool({
      name: "action1_run_bash_macos",
      arguments: {
        endpoint_id: ENDPOINT_UUID,
        script_text: "uname",
        retry_minutes: "10080",
        dry_run: true,
      },
    });
    expect(result.isError).toBeFalsy();
  });

  it("action1_run_script rejects malformed success_exit_codes before any upstream call", async () => {
    const stub = buildFetchStub([]);
    vi.stubGlobal("fetch", stub);
    const result = await CLIENT.callTool({
      name: "action1_run_script",
      arguments: {
        endpoint_id: ENDPOINT_UUID,
        script_text: "Get-Date",
        success_exit_codes: "0; rm -rf /",
        dry_run: true,
      },
    });
    expect(result.isError).toBe(true);
    expect(nonTokenCallCount(stub)).toBe(0);
  });

  it("action1_execute_and_wait rejects malformed success_exit_codes", async () => {
    const stub = buildFetchStub([]);
    vi.stubGlobal("fetch", stub);
    const result = await CLIENT.callTool({
      name: "action1_execute_and_wait",
      arguments: {
        endpoint_id: ENDPOINT_UUID,
        script_text: "Get-Date",
        success_exit_codes: "0 or 1",
        dry_run: true,
      },
    });
    expect(result.isError).toBe(true);
    expect(nonTokenCallCount(stub)).toBe(0);
  });

  it("action1_execute_and_wait rejects a non-UUID endpoint_id", async () => {
    const stub = buildFetchStub([]);
    vi.stubGlobal("fetch", stub);
    const result = await CLIENT.callTool({
      name: "action1_execute_and_wait",
      arguments: { endpoint_id: "..", script_text: "Get-Date", dry_run: true },
    });
    expect(result.isError).toBe(true);
    expect(nonTokenCallCount(stub)).toBe(0);
  });
});

describe("raw upstream bodies in error texts", () => {
  it("startedJobResult masks personal data in raw_body under ACTION1_REDACT_PII", async () => {
    const { startedJobResult } = await import("../../src/tools/startAction.js");
    process.env.ACTION1_REDACT_PII = "true";
    resetConfigCache();
    try {
      const result = startedJobResult(
        { unexpected_shape: true, user_name: "alice.private", client_secret: "s3cr3tvalue99" },
        "json",
      );
      expect(result.isError).toBe(true);
      const text = (result.content as { text: string }[])[0]!.text;
      expect(text).toContain("no_instance_id");
      expect(text).toContain("unexpected_shape");
      expect(text).not.toContain("alice.private");
      expect(text).not.toContain("s3cr3tvalue99");
    } finally {
      delete process.env.ACTION1_REDACT_PII;
      resetConfigCache();
    }
  });

  it("upstreamBodyText masks credentials always and personal data under ACTION1_REDACT_PII", async () => {
    const { upstreamBodyText } = await import("../../src/tools/helpers.js");
    const body = {
      status: "Running",
      last_user: "x",
      ip_address: "10.1.2.3",
      password: "pw-123456",
    };
    expect(upstreamBodyText(body)).toContain("10.1.2.3");
    expect(upstreamBodyText(body)).not.toContain("pw-123456");
    process.env.ACTION1_REDACT_PII = "true";
    resetConfigCache();
    try {
      const masked = upstreamBodyText(body);
      expect(masked).toContain("Running");
      expect(masked).not.toContain("10.1.2.3");
      expect(masked).not.toContain("pw-123456");
    } finally {
      delete process.env.ACTION1_REDACT_PII;
      resetConfigCache();
    }
  });
});
