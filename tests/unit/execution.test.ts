import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../../src/config.js";

// Unit-tests for the curated execution-tool handlers in
// src/tools/execution.ts. Until this file landed, the 564-LOC module was
// covered by a single dry_run integration test — every input-validation
// branch and the run_script OS-routing logic were untested.
//
// Pattern (mirrors the integration test in tests/integration/server.test.ts):
//   1. Boot a full MCP server via buildServer() over an in-memory
//      transport pair. This exercises the real registerTool path so
//      schema validation actually runs.
//   2. Per test: stub `globalThis.fetch` with a route table. Any request
//      that doesn't match returns a 599 sentinel so a leaked upstream
//      call fails the test loudly instead of silently.
//   3. Drive the tools via the SDK client's `callTool` — this puts the
//      registered ZodObject through the validator and surfaces
//      structuredContent the same way an MCP host would.

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

  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import(
    "@modelcontextprotocol/sdk/inMemory.js"
  );
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();

  SERVER = buildServer();
  await SERVER.server.connect(serverTx);

  CLIENT = new Client(
    { name: "execution-unit-test", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
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
    // OAuth dance — always serve a fresh token so the tool body actually
    // reaches the request site.
    if (url.endsWith("/oauth2/token")) {
      return new Response(
        JSON.stringify({ access_token: "tkn", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
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
    // Unmatched call — surface a sentinel so the test fails loudly.
    return new Response(JSON.stringify({ error: "no route matched", url }), {
      status: 599,
      headers: { "Content-Type": "application/json" },
    });
  });
}

function nonTokenCallCount(stub: ReturnType<typeof vi.fn>): number {
  return stub.mock.calls.filter(
    (c) => !String(c[0]).endsWith("/oauth2/token"),
  ).length;
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

describe("destructive tools — input validation", () => {
  it("action1_run_powershell rejects missing script_text", async () => {
    vi.stubGlobal("fetch", buildFetchStub([]));
    const result = await CLIENT.callTool({
      name: "action1_run_powershell",
      arguments: { endpoint_id: ENDPOINT_UUID, dry_run: true } as Record<string, unknown>,
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
      arguments: { dry_run: true } as Record<string, unknown>,
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
      } as Record<string, unknown>,
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
      } as Record<string, unknown>,
    });
    expect(result.isError).toBe(true);
  });

  it("action1_deploy_package rejects missing params", async () => {
    vi.stubGlobal("fetch", buildFetchStub([]));
    const result = await CLIENT.callTool({
      name: "action1_deploy_package",
      arguments: { endpoint_id: ENDPOINT_UUID, dry_run: true } as Record<string, unknown>,
    });
    expect(result.isError).toBe(true);
  });

  it("action1_uninstall_program rejects missing params", async () => {
    vi.stubGlobal("fetch", buildFetchStub([]));
    const result = await CLIENT.callTool({
      name: "action1_uninstall_program",
      arguments: { endpoint_id: ENDPOINT_UUID, dry_run: true } as Record<string, unknown>,
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
        match: (url) =>
          url.includes("/endpoints/managed/") && url.endsWith(ENDPOINT_UUID),
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
        match: (url) =>
          url.includes("/endpoints/managed/") && url.endsWith(ENDPOINT_UUID),
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
        match: (url) =>
          url.includes("/endpoints/managed/") && url.endsWith(ENDPOINT_UUID),
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
    const action = (sc.would_send as {
      body: { actions: { template_id: string; params: { packages: unknown[] } }[] };
    }).body.actions[0]!;
    expect(action.template_id).toBe("deploy_update");
    expect(action.params.packages).toEqual([{ "pkg-xyz": "1.2.3" }]);
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
    const action = (sc.would_send as {
      body: {
        actions: {
          template_id: string;
          params: { script_text: string };
        }[];
      };
    }).body.actions[0]!;
    expect(action.template_id).toBe("run_powershell");
    expect(action.params.script_text).toBe("Get-Service");
  });
});

// ----- asStartedJob behaviour on bad upstream responses ----------------
//
// Pass-N audit: when the upstream POST returned an object without a
// string `id` / `instance_id`, the previous implementation emitted a
// success-shape with `instance_id: undefined`. Downstream tools like
// `action1_wait_for_automation` then crashed with "instance_id is
// required" because their Zod schema is `z.string().min(1)`. We now
// fail loud at the source — return an explicit `errorResult` so the
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
          (init?.method ?? "GET") === "POST" &&
          url.includes("/policies/instances/"),
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
// Pass-N audit: `timeout_minutes` was `z.string().regex(/^\d+$/)` while
// `retry_minutes` was `z.number().int().min(0)` — agents that passed
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
      } as Record<string, unknown>,
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as Record<string, unknown>;
    const action = (sc.would_send as {
      body: { actions: { params: { timeout_minutes: string } }[] };
    }).body.actions[0]!;
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
      } as Record<string, unknown>,
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as Record<string, unknown>;
    const action = (sc.would_send as {
      body: { actions: { params: { timeout_minutes: string } }[] };
    }).body.actions[0]!;
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
      } as Record<string, unknown>,
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
      } as Record<string, unknown>,
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
      } as Record<string, unknown>,
    });
    expect(result.isError).toBe(true);
  });
});

// ----- Reboot connectivity check + skip flag --------------------------
//
// Pass-N audit: action1_reboot_endpoint used to fire without a
// connectivity check. The Action1 server happily accepts a reboot for
// an offline endpoint and queues it for the next check-in — which can
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
        match: (url) =>
          url.includes("/endpoints/managed/") && url.endsWith(ENDPOINT_UUID),
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
      // No /endpoints/managed/ route — if the handler tries to fetch
      // endpoint info, the stub returns 599 and we'd see an error here.
      {
        match: (url, init) =>
          (init?.method ?? "GET") === "POST" &&
          url.includes("/policies/instances/"),
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
    // Crucially: no non-token call was made — dry_run must not fetch
    // endpoint info for the connectivity check.
    expect(nonTokenCallCount(stub)).toBe(0);
  });
});
