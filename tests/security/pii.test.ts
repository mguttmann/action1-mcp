import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import { isPiiKey, PII_PLACEHOLDER, redactPii, redactPiiInCsv } from "../../src/utils/pii.js";

// ACTION1_REDACT_PII: the masked key set is held against the vendored
// Action1 OpenAPI spec, and every output channel (tool text, structured
// content, resource reads, error texts) is checked.

const spec = JSON.parse(
  readFileSync(new URL("../../src/codegen/spec/openapi.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

/**
 * Keys in the spec that carry personal data, derived from the spec:
 * every property typed `format: email | ipv4 | ipv6`, plus the names the
 * spec uses for IPs, e-mail and postal or network addresses, Active
 * Directory placement and people (user, names, phone), serials and MACs.
 * Request bodies of /oauth2/token are skipped (client_id is a credential
 * identifier, never returned in results).
 */
const NOT_PERSONAL: Record<string, string> = {
  field_value:
    "endpoint-group filter criterion (a value pattern of the filter definition, not data about a person)",
};
const NAME_RULES: RegExp[] = [
  /(^|_)ip$/i,
  /(^|_)ip_?address(es)?$/i,
  /(^|_)e_?mail$/i,
  /(^|_)address$/i,
  /^AD_/,
  /^(first|last|full)_?name$/i,
  /^user(s|_?name)?$/i,
  /^phone$/i,
  /^serial(_?number)?$/i,
  /^mac(_?address)?$/i,
];

function specPiiKeys(): string[] {
  const keys = new Set<string>();
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      for (const v of node) walk(v, path);
      return;
    }
    if (!node || typeof node !== "object") return;
    if (path.includes("/oauth2/token")) return;
    const obj = node as Record<string, unknown>;
    if (obj.properties && typeof obj.properties === "object") {
      for (const [k, v] of Object.entries(obj.properties as Record<string, unknown>)) {
        if (k in NOT_PERSONAL) continue;
        const fmt = (v as { format?: unknown } | null)?.format;
        if (fmt === "email" || fmt === "ipv4" || fmt === "ipv6") keys.add(k);
        if (NAME_RULES.some((re) => re.test(k))) keys.add(k);
      }
    }
    for (const [k, v] of Object.entries(obj)) walk(v, `${path}/${k}`);
  };
  walk(spec, "");
  return [...keys].sort();
}

describe("redactPii key set is derived from the spec", () => {
  const keys = specPiiKeys();

  it("finds the personal-data keys the spec defines", () => {
    for (const k of [
      "address",
      "external_address",
      "current_ip",
      "customer_email",
      "email",
      "closure_requested_by",
      "AD_organization_unit",
      "AD_security_groups",
      "user",
      "MAC",
      "serial",
    ]) {
      expect(keys).toContain(k);
    }
  });

  it.each(specPiiKeys())("masks %s at the top level, nested and in arrays", (key) => {
    const value = { [key]: "pii-value" };
    const out = redactPii({ ...value, nested: { inner: [value] }, keep: "visible" }) as Record<
      string,
      unknown
    >;
    expect(out[key]).toBe(PII_PLACEHOLDER);
    expect(JSON.stringify(out)).not.toContain("pii-value");
    expect(out.keep).toBe("visible");
  });

  it("masks the generic ip spellings too", () => {
    for (const key of ["ip", "IP", "ip_address", "ipAddress", "ipv4", "ipv6", "mac_address"]) {
      expect((redactPii({ [key]: "x" }) as Record<string, unknown>)[key]).toBe(PII_PLACEHOLDER);
    }
  });

  it("leaves non-personal fields alone", () => {
    const input = {
      id: "e1",
      name: "host-1",
      status: "Connected",
      email_verified: "yes",
      ad_domain: "1",
      field_value: "*Windows*",
      OS: "Windows 11",
    };
    expect(redactPii(input)).toEqual(input);
  });
});

describe("report column names (ReportData.fields display names)", () => {
  it.each([
    "User Name",
    "IP Address",
    "IP Addresses",
    "Logged On User",
    "Last Logged On User",
    "Logged In User",
    "MAC Address",
    "Serial Number",
    "External Address",
    "E-mail",
    "AD Security Groups",
  ])("treats %s as personal data", (key) => {
    expect(isPiiKey(key)).toBe(true);
    expect(
      (redactPii({ fields: { [key]: "v" } }) as { fields: Record<string, unknown> }).fields[key],
    ).toBe(PII_PLACEHOLDER);
  });

  it.each(["Name", "OS", "OS Name", "Status", "Update Name", "Endpoint Name", "ad_domain"])(
    "leaves %s alone",
    (key) => {
      expect(isPiiKey(key)).toBe(false);
    },
  );
});

describe("redactPiiInCsv", () => {
  it("masks the cells of personal-data columns by header", () => {
    const csv =
      'Name,User Name,IP Address,OS\r\nhost-1,alice.smith,10.1.2.3,Windows 11\r\nhost-2,"bob, jr",10.1.2.4,macOS\r\n';
    const out = redactPiiInCsv(csv);
    expect(out).not.toContain("alice.smith");
    expect(out).not.toContain("10.1.2.3");
    expect(out).not.toContain("bob, jr");
    expect(out).toContain("host-1");
    expect(out).toContain("Windows 11");
    expect(out.split("\r\n")[1]).toBe(`host-1,${PII_PLACEHOLDER},${PII_PLACEHOLDER},Windows 11`);
  });

  it("handles a BOM, quoted headers, semicolons and multi-line quoted cells", () => {
    const csv =
      '\uFEFF"Name";"Logged On User";"Note"\n"host-1";"CORP\\alice";"line one\nline two"\n"host-2";"CORP\\bob";""\n';
    const out = redactPiiInCsv(csv);
    expect(out).not.toContain("alice");
    expect(out).not.toContain("bob");
    expect(out).toContain('"line one\nline two"');
    expect(out).toContain('"host-2"');
  });

  it("returns text without a personal-data header unchanged", () => {
    for (const text of ["Name,OS\nhost-1,Windows", "plain text output", ""]) {
      expect(redactPiiInCsv(text)).toBe(text);
    }
  });
});

// ---- End to end through an MCP client --------------------------------------

const ORG = "00000000-0000-0000-0000-000000000001";
const EP = "00000000-0000-4000-8000-0000000000e1";
const ENDPOINT = {
  id: EP,
  name: "host-1",
  status: "Connected",
  user: "CORP\\alice",
  address: "10.0.0.5",
  external_address: "203.0.113.7",
  MAC: "aa:bb:cc:dd:ee:ff",
  serial: "SN-ALICE-1",
  AD_organization_unit: "OU=Alice,DC=corp",
  AD_security_groups: ["alice-admins"],
};
const SECRETS = ["alice", "10.0.0.5", "203.0.113.7", "aa:bb:cc:dd:ee:ff", "SN-ALICE-1", "OU=Alice"];
const REPORT = "00000000-0000-4000-8000-0000000000a1";
// ReportData rows carry their values under the report's column display
// names (spec ReportData.fields; the live check saw `fields.Name`).
const REPORT_ROW = {
  id: "row-1",
  type: "ReportRow",
  fields: {
    Name: "host-1",
    "User Name": "alice.smith",
    "IP Address": "10.1.2.3",
    "Logged On User": "CORP\\alice",
  },
};
const REPORT_CSV =
  "Name,User Name,IP Address,Logged On User\r\nhost-1,alice.smith,10.1.2.3,CORP\\alice\r\n";
const REPORT_SECRETS = ["alice", "10.1.2.3"];

let saved: NodeJS.ProcessEnv;
let open: { client: Client; close: () => Promise<void> } | undefined;

beforeEach(() => {
  saved = { ...process.env };
  Object.assign(process.env, {
    ACTION1_BASE_URL: "https://app.eu.action1.test/api/3.0",
    ACTION1_CLIENT_ID: "client-id-test",
    ACTION1_CLIENT_SECRET: "client-secret-test",
    ACTION1_ORG_ID: ORG,
    ACTION1_REDACT_PII: "true",
  });
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

async function connect(): Promise<Client> {
  const { resetConfigCache } = await import("../../src/config.js");
  resetConfigCache();
  const { buildServer } = await import("../../src/server.js");
  const { Client } = await import("@modelcontextprotocol/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/server");
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const built = buildServer();
  await built.server.connect(serverTx);
  const client = new Client({ name: "pii-test", version: "0.0.0" });
  await client.connect(clientTx);
  open = {
    client,
    close: async () => {
      await client.close();
      await built.server.close();
    },
  };
  return client;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function stubUpstream(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/oauth2/token")) return json({ access_token: "tkn", expires_in: 3600 });
      const path = new URL(url).pathname;
      if (path.endsWith(`/endpoints/managed/${ORG}/${EP}`)) return json(ENDPOINT);
      if (path.endsWith(`/endpoints/managed/${ORG}`))
        return json({ items: [ENDPOINT], total_items: 1 });
      if (path.endsWith("/me"))
        return json({ id: "u1", email: "alice@example.com", first_name: "Alice" });
      if (path.endsWith(`/remote-sessions/${ORG}/s1`)) {
        return json({ id: "s1", current_ip: "198.51.100.9", customer_email: "alice@example.com" });
      }
      if (path.endsWith("/bad"))
        return json({ error: "conflict", email: "alice@example.com" }, 409);
      if (path.endsWith(`/reportdata/${ORG}/${REPORT}/data`)) {
        return json({ items: [REPORT_ROW], total_items: 1 });
      }
      if (path.includes(`/reportdata/${ORG}/${REPORT}/`) && path.endsWith("/export")) {
        return new Response(REPORT_CSV, { status: 200, headers: { "Content-Type": "text/csv" } });
      }
      return json({ error: "no route" }, 404);
    }),
  );
}

function expectNoPii(serialised: string): void {
  for (const s of SECRETS) expect(serialised).not.toContain(s);
}

describe("REDACT_PII end to end", () => {
  it("masks a single-object tool result in text and structured content", async () => {
    stubUpstream();
    const client = await connect();
    const r = await client.callTool({
      name: "action1_get_endpoint",
      arguments: { endpoint_id: EP, response_format: "json" },
    });
    expect(r.isError ?? false).toBe(false);
    expectNoPii(JSON.stringify(r.content));
    expectNoPii(JSON.stringify(r.structuredContent ?? {}));
    expect(JSON.stringify(r.content)).toContain("host-1");
  });

  it.each(["json", "markdown"])("masks a cursor list result (%s)", async (format) => {
    stubUpstream();
    const client = await connect();
    const r = await client.callTool({
      name: "action1_list_endpoints",
      arguments: { projection: "full", response_format: format },
    });
    expect(r.isError ?? false).toBe(false);
    expectNoPii(JSON.stringify(r.content));
    expectNoPii(JSON.stringify(r.structuredContent ?? {}));
  });

  it("masks the endpoints resource and the me resource", async () => {
    stubUpstream();
    const client = await connect();
    const eps = await client.readResource({ uri: "action1://endpoints/default" });
    expectNoPii(JSON.stringify(eps.contents));
    expect(JSON.stringify(eps.contents)).toContain("host-1");
    const me = await client.readResource({ uri: "action1://me" });
    expect(JSON.stringify(me.contents)).not.toContain("alice@example.com");
    expect(JSON.stringify(me.contents)).not.toContain("Alice");
  });

  it("masks remote-session ip and customer e-mail from a raw request", async () => {
    stubUpstream();
    const client = await connect();
    const r = await client.callTool({
      name: "action1_raw_request",
      arguments: { method: "GET", path: `/remote-sessions/${ORG}/s1` },
    });
    const text = JSON.stringify(r.content) + JSON.stringify(r.structuredContent ?? {});
    expect(text).not.toContain("198.51.100.9");
    expect(text).not.toContain("alice@example.com");
  });

  it("masks personal fields in an upstream error body", async () => {
    stubUpstream();
    const client = await connect();
    const r = await client.callTool({
      name: "action1_raw_request",
      arguments: { method: "GET", path: `/endpoints/managed/${ORG}/bad` },
    });
    expect(r.isError).toBe(true);
    const text = JSON.stringify(r.content);
    expect(text).toContain("409");
    expect(text).not.toContain("alice@example.com");
  });
  it.each([
    ["action1_report_export", { report: REPORT, format: "json", response_format: "json" }],
    ["action1_report_export", { report: REPORT, format: "json", response_format: "markdown" }],
    ["action1_report_export", { report: REPORT, format: "csv" }],
    ["action1_list_report_data", { report_id: REPORT, response_format: "json" }],
    ["action1_list_report_data", { report_id: REPORT, verbose: true }],
    ["action1_get_export_for_report", { report_id: REPORT }],
    ["action1_get_export_for_report_row", { report_id: REPORT, report_row_id: "row-1" }],
    ["action1_raw_request", { method: "GET", path: `/reportdata/${ORG}/${REPORT}/export` }],
  ])("masks report column values in %s %j", async (name, args) => {
    stubUpstream();
    const client = await connect();
    const r = await client.callTool({ name, arguments: args });
    const out = JSON.stringify(r.content) + JSON.stringify(r.structuredContent ?? {});
    expect(r.isError ?? false, out).toBe(false);
    for (const s of REPORT_SECRETS) expect(out).not.toContain(s);
    expect(out).toContain("host-1");
  });
});
