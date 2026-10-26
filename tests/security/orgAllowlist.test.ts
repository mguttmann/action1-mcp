import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import type { AppConfig } from "../../src/config.js";
import { assertMutationOrgScope } from "../../src/tools/orgScope.js";

// ACTION1_ALLOWED_ORG_IDS for mutations: every organization a request
// body names, at any depth (org id keys, scope entries of settings,
// roles and update approvals), must be allowed, and a mutation that is
// not bound to an allowed organization (enterprise-wide paths, Enterprise
// or unbound scope entries) fails closed unless
// ACTION1_ALLOW_ENTERPRISE_OPS is set. The body locations are derived
// from the vendored OpenAPI spec.

const ALLOWED = "00000000-0000-0000-0000-000000000001";
const FOREIGN = "00000000-0000-0000-0000-0000000000ff";

function cfg(over: Partial<AppConfig> = {}): AppConfig {
  return {
    baseUrl: "https://app.eu.action1.test/api/3.0",
    defaultOrgId: ALLOWED,
    clientId: "c",
    clientSecret: "s",
    defaultTimeoutMinutes: "10",
    defaultRetryMinutes: "1440",
    lastSeenStaleMinutes: 10,
    allowDestructive: true,
    destructiveAutoConfirm: false,
    allowAccountOps: true,
    allowedOrgIds: [ALLOWED],
    toolsets: [],
    redactPii: false,
    http: { port: 0, host: "127.0.0.1", allowedOrigins: [], allowedHosts: [] },
    ...over,
  } as AppConfig;
}

const ORG_PATH = `/software-repository/${ALLOWED}/pkg-1/versions`;

describe("assertMutationOrgScope (hand-picked spec shapes)", () => {
  it("is a no-op without an allowlist", () => {
    expect(() =>
      assertMutationOrgScope(
        {
          method: "POST",
          path: "/settings/all",
          body: { scope: [{ type: "Enterprise", object: "all" }] },
        },
        cfg({ allowedOrgIds: [] }),
      ),
    ).not.toThrow();
  });

  it("ignores reads", () => {
    expect(() =>
      assertMutationOrgScope({ method: "GET", path: "/scripts/all" }, cfg()),
    ).not.toThrow();
  });

  it("refuses a foreign org in scoped_approvals[].organization_id (software repository versions)", () => {
    const body = {
      scoped_approvals: [{ type: "Organization", status: "Approved", organization_id: FOREIGN }],
    };
    expect(() => assertMutationOrgScope({ method: "POST", path: ORG_PATH, body }, cfg())).toThrow(
      /Refusing organization/,
    );
    expect(() =>
      assertMutationOrgScope({ method: "PATCH", path: `${ORG_PATH}/v1`, body }, cfg()),
    ).toThrow(/Refusing organization/);
  });

  it("allows an allowed org in scoped_approvals and refuses an Enterprise approval without the opt-in", () => {
    const ok = {
      scoped_approvals: [{ type: "Organization", status: "Approved", organization_id: ALLOWED }],
    };
    expect(() =>
      assertMutationOrgScope({ method: "POST", path: ORG_PATH, body: ok }, cfg()),
    ).not.toThrow();
    const ent = { scoped_approvals: [{ type: "Enterprise", status: "Approved" }] };
    expect(() =>
      assertMutationOrgScope({ method: "POST", path: ORG_PATH, body: ent }, cfg()),
    ).toThrow(/ACTION1_ALLOW_ENTERPRISE_OPS/);
    expect(() =>
      assertMutationOrgScope(
        { method: "POST", path: ORG_PATH, body: ent },
        cfg({ allowEnterpriseOps: true }),
      ),
    ).not.toThrow();
  });

  it("refuses Enterprise and Group scope entries that carry a spurious organization_id without the opt-in", () => {
    // The spec gives EnterpriseApproval and SettingScope no organization_id,
    // and RolePermissionScope.organization_id binds only Report and
    // AdvancedSettingTemplate scopes, so the key does not bind these entries.
    const bodies = [
      { scoped_approvals: [{ type: "Enterprise", status: "Approved", organization_id: ALLOWED }] },
      { scope: [{ type: "Group", object: "g1", organization_id: ALLOWED }] },
      { include_scope: [{ type: "AdHocScript", organization_id: ALLOWED }] },
      { scope: [{ organization_id: ALLOWED }] },
    ];
    for (const body of bodies) {
      expect(() =>
        assertMutationOrgScope({ method: "PATCH", path: `${ORG_PATH}/v1`, body }, cfg()),
      ).toThrow(/ACTION1_ALLOW_ENTERPRISE_OPS/);
      expect(() =>
        assertMutationOrgScope(
          { method: "PATCH", path: `${ORG_PATH}/v1`, body },
          cfg({ allowEnterpriseOps: true }),
        ),
      ).not.toThrow();
    }
  });

  it("treats Report and AdvancedSettingTemplate entries with an allowed organization_id as bound", () => {
    for (const entry of [
      { type: "Report", object: "r1", organization_id: ALLOWED },
      { type: "AdvancedSettingTemplate", object: "t1", organization_id: ALLOWED },
      { type: "Organization", organization_id: ALLOWED },
    ]) {
      const body = { include_scope: [entry] };
      expect(() =>
        assertMutationOrgScope({ method: "PATCH", path: `${ORG_PATH}/v1`, body }, cfg()),
      ).not.toThrow();
    }
  });

  it("refuses a foreign org in a role's include_scope object and exclude_scope organization_id, even with the enterprise opt-in", () => {
    const opt = cfg({ allowEnterpriseOps: true });
    const include = {
      scoped_permissions: [
        {
          permission: "p",
          include_scope: [{ type: "Organization", object: FOREIGN }],
          exclude_scope: [],
        },
      ],
    };
    expect(() =>
      assertMutationOrgScope({ method: "POST", path: "/roles", body: include }, opt),
    ).toThrow(/Refusing organization/);
    const exclude = {
      scoped_permissions: [
        {
          permission: "p",
          include_scope: [{ type: "Organization", object: ALLOWED }],
          exclude_scope: [{ type: "Report", object: "r1", organization_id: FOREIGN }],
        },
      ],
    };
    expect(() =>
      assertMutationOrgScope({ method: "PATCH", path: "/roles/r1", body: exclude }, opt),
    ).toThrow(/Refusing organization/);
  });

  it("refuses a settings scope naming a foreign org, an Enterprise scope and an unbound Group scope", () => {
    const opt = cfg({ allowEnterpriseOps: true });
    const foreign = {
      template_id: "t",
      value: "v",
      scope: [{ type: "Organization", object: FOREIGN }],
    };
    expect(() =>
      assertMutationOrgScope({ method: "POST", path: "/settings/all", body: foreign }, opt),
    ).toThrow(/Refusing organization/);
    for (const scope of [
      { type: "Enterprise", object: "all" },
      { type: "Group", object: "g1" },
    ]) {
      expect(() =>
        assertMutationOrgScope(
          { method: "PATCH", path: `/endpoints/groups/${ALLOWED}/g1`, body: { scope: [scope] } },
          cfg(),
        ),
      ).toThrow(/ACTION1_ALLOW_ENTERPRISE_OPS/);
    }
  });

  it("refuses enterprise-wide paths without the opt-in and allows them with it", () => {
    for (const [method, path] of [
      ["DELETE", "/scripts/all/s1"],
      ["POST", "/settings/all"],
      ["PATCH", "/enterprise"],
      ["POST", "/organizations"],
      ["DELETE", "/data-sources/all/d1"],
    ] as const) {
      expect(() => assertMutationOrgScope({ method, path }, cfg()), path).toThrow(
        /ACTION1_ALLOW_ENTERPRISE_OPS/,
      );
      expect(() =>
        assertMutationOrgScope({ method, path }, cfg({ allowEnterpriseOps: true })),
      ).not.toThrow();
    }
  });

  it("allows an org-bound path with a body that names no other org", () => {
    expect(() =>
      assertMutationOrgScope(
        {
          method: "POST",
          path: `/policies/instances/${ALLOWED}`,
          body: { actions: [{ params: { scope: "Specified" } }] },
        },
        cfg(),
      ),
    ).not.toThrow();
  });

  it("finds an org id nested deeper than any spec body and fails closed beyond the depth limit", () => {
    let deep: Record<string, unknown> = { organization_id: FOREIGN };
    for (let i = 0; i < 30; i++) deep = { level: [deep] };
    expect(() =>
      assertMutationOrgScope({ method: "POST", path: ORG_PATH, body: deep }, cfg()),
    ).toThrow(/Refusing organization/);
    let tooDeep: Record<string, unknown> = { harmless: true };
    for (let i = 0; i < 500; i++) tooDeep = { level: tooDeep };
    expect(() =>
      assertMutationOrgScope({ method: "POST", path: ORG_PATH, body: tooDeep }, cfg()),
    ).toThrow(/nested too deeply/);
  });
});

// ---- Every org location in every spec request body ------------------------

type Schema = Record<string, unknown>;
const spec = JSON.parse(
  readFileSync(new URL("../../src/codegen/spec/openapi.json", import.meta.url), "utf8"),
) as {
  paths: Record<string, Record<string, Schema>>;
  components: { schemas: Record<string, Schema> };
};

function resolve(s: unknown): Schema | undefined {
  if (!s || typeof s !== "object") return undefined;
  const ref = (s as { $ref?: string }).$ref;
  if (ref) return spec.components.schemas[ref.split("/").pop()!];
  return s as Schema;
}

/** A property name, or "[]" for the items of an array. */
type Step = string;
interface Location {
  steps: Step[];
  kind: "org_key" | "scope_entry";
}

/** Every place in a request body schema that names an organization. */
function orgLocations(root: unknown): Location[] {
  const out: Location[] = [];
  const walk = (raw: unknown, steps: Step[], seen: Set<Schema>): void => {
    const s = resolve(raw);
    if (!s || seen.has(s) || steps.length > 12) return;
    const next = new Set(seen).add(s);
    for (const comb of ["allOf", "anyOf", "oneOf"]) {
      for (const sub of (s[comb] as unknown[] | undefined) ?? []) walk(sub, steps, next);
    }
    if (s.items) walk(s.items, [...steps, "[]"], next);
    const props = (s.properties ?? {}) as Record<string, unknown>;
    if ("type" in props && "object" in props) out.push({ steps, kind: "scope_entry" });
    for (const [k, v] of Object.entries(props)) {
      if (/(^|_)org(anization)?_?ids?$/i.test(k))
        out.push({ steps: [...steps, k], kind: "org_key" });
      else walk(v, [...steps, k], next);
    }
  };
  walk(root, [], new Set());
  return out;
}

function bodyAt(steps: Step[], leaf: unknown): unknown {
  if (steps.length === 0) return leaf;
  const [head, ...rest] = steps;
  return head === "[]" ? [bodyAt(rest, leaf)] : { [head!]: bodyAt(rest, leaf) };
}

interface Case {
  op: string;
  method: string;
  path: string;
  loc: Location;
}

function specCases(): Case[] {
  const cases: Case[] = [];
  const seen = new Set<string>();
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const [m, op] of Object.entries(item)) {
      if (!["post", "put", "patch", "delete"].includes(m)) continue;
      const schema = (op.requestBody as Schema | undefined)?.content as Schema | undefined;
      const json = (schema?.["application/json"] as Schema | undefined)?.schema;
      if (!json) continue;
      for (const loc of orgLocations(json)) {
        const key = `${m} ${p} ${loc.kind} ${loc.steps.join(".")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        cases.push({
          op: key,
          method: m.toUpperCase(),
          path: p.replace("{orgId}", ALLOWED).replace(/\{[^}]+\}/g, "x"),
          loc,
        });
      }
    }
  }
  return cases;
}

describe("every organization location in the spec's request bodies", () => {
  const cases = specCases();

  it("covers the known shapes (move target, update approvals, role scopes, setting scopes)", () => {
    const ops = cases.map((c) => c.op).join("\n");
    expect(ops).toContain("target_organization_id");
    expect(ops).toMatch(/versions .*scoped_approvals\.\[\]\.organization_id/);
    expect(ops).toMatch(/roles .*include_scope\.\[\]/);
    expect(ops).toMatch(/roles .*exclude_scope\.\[\]/);
    expect(ops).toMatch(/settings\/all .*scope_entry scope\.\[\]/);
  });

  it.each(specCases().map((c) => [c.op, c] as const))("refuses a foreign org: %s", (_name, c) => {
    const leaf = c.loc.kind === "org_key" ? FOREIGN : { type: "Organization", object: FOREIGN };
    const body = bodyAt(c.loc.steps, leaf);
    // With the enterprise opt-in, so only the org check can refuse.
    expect(() =>
      assertMutationOrgScope(
        { method: c.method, path: c.path, body },
        cfg({ allowEnterpriseOps: true }),
      ),
    ).toThrow(/Refusing organization/);
  });
});

// ---- End to end through the generated tools --------------------------------

let saved: NodeJS.ProcessEnv;
let open: { close: () => Promise<void> } | undefined;

beforeEach(() => {
  saved = { ...process.env };
  vi.resetModules();
});

afterEach(async () => {
  await open?.close();
  open = undefined;
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function connect(env: Record<string, string>): Promise<{ client: Client; calls: string[] }> {
  Object.assign(process.env, {
    ACTION1_BASE_URL: "https://app.eu.action1.test/api/3.0",
    ACTION1_CLIENT_ID: "client-id-test",
    ACTION1_CLIENT_SECRET: "client-secret-test",
    ACTION1_ORG_ID: ALLOWED,
    ACTION1_ALLOWED_ORG_IDS: ALLOWED,
    ACTION1_ALLOW_DESTRUCTIVE: "true",
    ...env,
  });
  delete process.env.ACTION1_ALLOW_ENTERPRISE_OPS;
  if (env.ACTION1_ALLOW_ENTERPRISE_OPS)
    process.env.ACTION1_ALLOW_ENTERPRISE_OPS = env.ACTION1_ALLOW_ENTERPRISE_OPS;
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "tkn", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      calls.push(`${init?.method ?? "GET"} ${url}`);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  const { resetConfigCache } = await import("../../src/config.js");
  resetConfigCache();
  const { buildServer } = await import("../../src/server.js");
  const { Client } = await import("@modelcontextprotocol/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/server");
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const built = buildServer();
  await built.server.connect(serverTx);
  const client = new Client({ name: "org-test", version: "0.0.0" });
  await client.connect(clientTx);
  open = {
    close: async () => {
      await client.close();
      await built.server.close();
    },
  };
  return { client, calls };
}

const textOf = (r: { content?: unknown }): string =>
  (r.content as { text?: string }[] | undefined)?.[0]?.text ?? "";

describe("generated tools enforce the allowlist on bodies and enterprise paths", () => {
  it("a foreign org inside a setting scope is refused (also as a preview) without a network call", async () => {
    const { client, calls } = await connect({ ACTION1_ALLOW_ENTERPRISE_OPS: "true" });
    const r = await client.callTool({
      name: "action1_create_setting",
      arguments: {
        body: { template_id: "t", value: "v", scope: [{ type: "Organization", object: FOREIGN }] },
      },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Refusing organization/);
    expect(calls).toEqual([]);
  });

  it("an Enterprise approval with a spurious organization_id is refused end to end without a network call", async () => {
    const { client, calls } = await connect({});
    const r = await client.callTool({
      name: "action1_update_version",
      arguments: {
        package_id: "p1",
        version_id: "v1",
        dry_run: false,
        confirm: "YES",
        body: {
          scoped_approvals: [{ type: "Enterprise", status: "Approved", organization_id: ALLOWED }],
        },
      },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/ACTION1_ALLOW_ENTERPRISE_OPS/);
    expect(calls).toEqual([]);
  });

  it("an enterprise-wide mutation is refused without ACTION1_ALLOW_ENTERPRISE_OPS and sent with it", async () => {
    let { client, calls } = await connect({});
    const args = { script_id: "s1", dry_run: false, confirm: "YES" };
    let r = await client.callTool({ name: "action1_delete_script", arguments: args });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/ACTION1_ALLOW_ENTERPRISE_OPS/);
    expect(calls).toEqual([]);
    await open?.close();
    open = undefined;
    vi.resetModules();
    ({ client, calls } = await connect({ ACTION1_ALLOW_ENTERPRISE_OPS: "true" }));
    r = await client.callTool({ name: "action1_delete_script", arguments: args });
    expect(r.isError ?? false).toBe(false);
    expect(calls).toEqual(["DELETE https://app.eu.action1.test/api/3.0/scripts/all/s1"]);
  });
});

describe("org id keys are matched after normalising case and separators", () => {
  const VARIANTS = [
    "org_id",
    "orgId",
    "OrgID",
    "ORG_ID",
    "org-id",
    "org.id",
    "org id",
    "organization_id",
    "organizationId",
    "OrganizationID",
    "organization-id",
    "organisation_id",
    "organization_ids",
    "organizationIds",
    "target_organization_id",
    "targetOrganizationId",
    "target-org-id",
  ];

  it.each(VARIANTS)("refuses a foreign org under %j (payload check)", async (key) => {
    const { assertPayloadOrgsAllowed } = await import("../../src/tools/orgScope.js");
    expect(() => assertPayloadOrgsAllowed({ nested: { [key]: FOREIGN } }, cfg())).toThrow(
      /ACTION1_ALLOWED_ORG_IDS/,
    );
    expect(() => assertPayloadOrgsAllowed({ nested: { [key]: ALLOWED } }, cfg())).not.toThrow();
  });

  it.each(VARIANTS)("refuses a foreign org under %j (mutation check)", (key) => {
    expect(() =>
      assertMutationOrgScope({ method: "POST", path: ORG_PATH, body: { [key]: FOREIGN } }, cfg()),
    ).toThrow(/ACTION1_ALLOWED_ORG_IDS/);
  });

  it.each(["organization", "org_name", "orgs_count", "origin_id", "organization_type"])(
    "leaves the unrelated key %j alone",
    async (key) => {
      const { assertPayloadOrgsAllowed } = await import("../../src/tools/orgScope.js");
      expect(() => assertPayloadOrgsAllowed({ [key]: FOREIGN }, cfg())).not.toThrow();
    },
  );
});
