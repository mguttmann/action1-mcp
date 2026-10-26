#!/usr/bin/env node
// Read-only check of the record shapes a live Action1 tenant returns.
//
// The curated tools read field names and enum values from the vendored
// OpenAPI spec (src/spec/entities.ts) and also accept the names assumed
// before the spec binding. Whether the live API returns the spec shape
// is not verified. This script answers that for the owner of a tenant:
// it calls only GET endpoints the curated tools use, and writes an
// anonymized report of what came back.
//
// What it sends:
//   - one POST /oauth2/token (client credentials), as the server does;
//   - GET requests only, each with a small `limit`, nothing else. No
//     write, no automation, no requery.
//
// What the report contains (never record values):
//   - per request: path template ({orgId}, {endpointId}, ...), HTTP
//     status, envelope keys, item count, the key paths of the items
//     (e.g. `fields.Name`, `software[].available_updates[].package_id`),
//     and the keys missing from or added to the spec schema;
//   - distinct values of a fixed list of enum-like fields (status,
//     reboot_required, event, ...), only when they look like enum
//     words;
//   - the format of timestamp fields, digits replaced by 9
//     (`9999-99-99_99-99-99`).
// Ids picked at runtime to follow up (an endpoint, a CVE, an instance)
// stay in memory and are never written.
//
// Usage (owner only, with real credentials; nothing in CI runs this):
//   node --env-file=.env scripts/live-shape-check.mjs [--out <file>]
//   npm run live:shapes            (when ACTION1_* are already exported)
// Env: ACTION1_BASE_URL, ACTION1_CLIENT_ID, ACTION1_CLIENT_SECRET,
//      ACTION1_ORG_ID (the org to read from).
// Default output: ./live-shape-report.json (git-ignored).

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_PATH = path.join(ROOT, "src", "codegen", "spec", "openapi.json");
export const DEFAULT_OUT = "live-shape-report.json";
const PAGE = 5;
const TIMEOUT_MS = 20_000;

/** Fields whose distinct values are reported (enum-like words only). */
export const ENUM_FIELDS = new Set([
  "status",
  "online_status",
  "reboot_required",
  "update_status",
  "vulnerability_status",
  "platform",
  "subscription_status",
  "event",
  "remediation_status",
  "cisa_kev",
  "response_type",
  "type",
  "update_type",
  "approval_status",
  "settings_timezone",
  "fields.Update Status",
  "fields.Platform",
  "fields.Install Type",
]);

/** Fields whose timestamp format (digits as 9) is reported. */
export const TIME_FIELDS = new Set([
  "timestamp",
  "last_seen",
  "last_boot_time",
  "agent_install_date",
  "start_time",
  "end_time",
  "last_run",
  "next_run",
  "published_date",
  "remediation_deadline",
  "last_refresh",
]);

const ENUM_WORD = /^[A-Za-z][A-Za-z0-9 _.-]{0,39}$/;
const TIME_SHAPE = /^[0-9TZ:_.+\- ]{8,40}$/;
const SUSPICIOUS_KEY = /@|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const MAX_DEPTH = 4;

function actionTime(date) {
  return date.toISOString().slice(0, 19).replace("T", "_").replace(/:/g, "-");
}

/**
 * GET requests, in order. `path` and `query` receive the ids captured by
 * earlier probes; a probe whose ids are missing is skipped. `capture`
 * names the item field whose first value later probes use.
 */
export function probes(now = new Date()) {
  const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);
  return [
    { id: "organizations", template: "/organizations", schema: "Organization" },
    {
      id: "endpoints",
      template: "/endpoints/managed/{orgId}",
      schema: "Endpoint",
      capture: { endpointId: "id" },
    },
    {
      id: "endpoint",
      template: "/endpoints/managed/{orgId}/{endpointId}",
      schema: "Endpoint",
      single: true,
    },
    {
      id: "endpoints_reboot_required_filter",
      template: "/endpoints/managed/{orgId}",
      query: { reboot_required: "Yes" },
      schema: "Endpoint",
    },
    {
      id: "missing_updates",
      template: "/endpoints/managed/{orgId}/{endpointId}/missing-updates",
      schema: "MissingUpdateSoftwareRepositoryPackage",
    },
    {
      id: "endpoint_vulnerabilities_documented",
      template: "/vulnerabilities/{orgId}?endpoint_id={endpointId}",
      schema: "Vulnerability",
    },
    {
      id: "endpoint_vulnerabilities_undocumented",
      template: "/endpoints/managed/{orgId}/{endpointId}/vulnerabilities",
      schema: "Vulnerability",
    },
    {
      id: "vulnerabilities",
      template: "/vulnerabilities/{orgId}",
      schema: "Vulnerability",
      capture: { cveId: "cve_id" },
    },
    {
      id: "vulnerability",
      template: "/vulnerabilities/{orgId}/{cveId}",
      schema: "Vulnerability",
      single: true,
    },
    {
      id: "vulnerable_endpoints",
      template: "/vulnerabilities/{orgId}/{cveId}/endpoints",
      schema: "VulnerableEndpoint",
    },
    {
      id: "installed_software",
      template: "/installed-software/{orgId}/data/{endpointId}",
      schema: "InstalledSoftwareEndpoints",
    },
    {
      id: "automation_instances",
      template: "/automations/instances/{orgId}",
      schema: "AutomationInstance",
      capture: { instanceId: "id" },
    },
    {
      id: "automation_instance",
      template: "/automations/instances/{orgId}/{instanceId}",
      schema: "AutomationInstance",
      single: true,
    },
    {
      id: "automation_schedules",
      template: "/automations/schedules/{orgId}",
      schema: "AutomationSchedule",
    },
    { id: "action_templates", template: "/automations/action-templates", schema: "ActionTemplate" },
    { id: "endpoint_groups", template: "/endpoints/groups/{orgId}", schema: "EndpointGroup" },
    { id: "reports", template: "/reports/all", schema: "Report" },
    { id: "audit_events", template: "/audit/events", schema: "AuditEvent" },
    {
      id: "audit_events_timefrom_action1_format",
      template: "/audit/events",
      query: { timefrom: actionTime(dayAgo) },
      schema: "AuditEvent",
    },
    {
      id: "audit_events_timefrom_iso_format",
      template: "/audit/events",
      query: { timefrom: dayAgo.toISOString().slice(0, 19) + "Z" },
      schema: "AuditEvent",
    },
  ];
}

/** Fill `{name}` placeholders; undefined when an id is missing. */
export function fillTemplate(template, ids) {
  let missing = false;
  const filled = template.replace(/\{(\w+)\}/g, (_, name) => {
    const v = ids[name];
    if (typeof v !== "string" || v.length === 0) {
      missing = true;
      return "";
    }
    return encodeURIComponent(v);
  });
  return missing ? undefined : filled;
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Key paths, enum-like values and timestamp formats of `items`. Values
 * are never copied, except enum words of ENUM_FIELDS.
 */
export function describeItems(items) {
  const keys = new Set();
  const enums = new Map();
  const times = new Map();
  const visit = (value, prefix, depth) => {
    if (depth > MAX_DEPTH) return;
    if (Array.isArray(value)) {
      for (const v of value.slice(0, 20)) visit(v, prefix + "[]", depth + 1);
      return;
    }
    if (!isObject(value)) return;
    for (const [rawKey, v] of Object.entries(value)) {
      const key = SUSPICIOUS_KEY.test(rawKey) ? "<key>" : rawKey;
      const p = prefix ? prefix + "." + key : key;
      keys.add(p);
      if (ENUM_FIELDS.has(p) && typeof v === "string" && ENUM_WORD.test(v)) {
        if (!enums.has(p)) enums.set(p, new Set());
        enums.get(p).add(v);
      } else if (ENUM_FIELDS.has(p) && typeof v === "boolean") {
        if (!enums.has(p)) enums.set(p, new Set());
        enums.get(p).add(String(v) + " (boolean)");
      }
      if (TIME_FIELDS.has(p) && typeof v === "string" && TIME_SHAPE.test(v)) {
        if (!times.has(p)) times.set(p, new Set());
        times.get(p).add(v.replace(/[0-9]/g, "9"));
      }
      visit(v, p, depth + 1);
    }
  };
  for (const item of items) visit(item, "", 0);
  const sortedObject = (m) =>
    Object.fromEntries(
      [...m.entries()].sort().map(([k, set]) => [k, [...set].sort().slice(0, 20)]),
    );
  return {
    item_keys: [...keys].sort(),
    enum_values: sortedObject(enums),
    time_formats: sortedObject(times),
  };
}

/** Envelope facts without values: keys, whether next_page is set, value types. */
export function describeEnvelope(raw) {
  if (Array.isArray(raw)) return { kind: "array" };
  if (!isObject(raw)) return { kind: typeof raw };
  return {
    kind: "object",
    keys: Object.keys(raw).sort(),
    items_is_array: Array.isArray(raw.items),
    next_page: raw.next_page === undefined ? "absent" : raw.next_page ? "set" : "empty",
    total_items_type: raw.total_items === undefined ? "absent" : typeof raw.total_items,
    limit_type: raw.limit === undefined ? "absent" : typeof raw.limit,
  };
}

// --- spec comparison --------------------------------------------------

function resolveRef(spec, ref) {
  const m = /^#\/components\/schemas\/(.+)$/.exec(ref ?? "");
  return m ? spec.components?.schemas?.[m[1]] : undefined;
}

function flatten(spec, schema, seen = []) {
  if (!isObject(schema)) return [];
  if (schema.$ref) {
    if (seen.includes(schema.$ref)) return [];
    return flatten(spec, resolveRef(spec, schema.$ref), [...seen, schema.$ref]);
  }
  const out = [schema];
  for (const p of [...(schema.allOf ?? []), ...(schema.oneOf ?? []), ...(schema.anyOf ?? [])]) {
    out.push(...flatten(spec, p, seen));
  }
  return out;
}

/** Key paths the spec declares for a component schema (same notation as describeItems). */
export function specKeyPaths(spec, schemaName) {
  const out = new Set();
  const visit = (parts, prefix, depth) => {
    if (depth > MAX_DEPTH) return;
    for (const part of parts) {
      for (const [k, sub] of Object.entries(part.properties ?? {})) {
        const p = prefix ? prefix + "." + k : k;
        out.add(p);
        const subParts = flatten(spec, sub);
        visit(subParts, p, depth + 1);
        const itemParts = subParts.flatMap((s) => (s.items ? flatten(spec, s.items) : []));
        if (itemParts.length > 0) visit(itemParts, p + "[]", depth + 1);
      }
    }
  };
  const root = spec.components?.schemas?.[schemaName];
  if (root) visit(flatten(spec, root), "", 0);
  return out;
}

function compareWithSpec(spec, schemaName, itemKeys) {
  if (!spec.components?.schemas?.[schemaName]) return { schema: schemaName, note: "not in spec" };
  const declared = specKeyPaths(spec, schemaName);
  const topLevel = (p) => !p.includes(".") && !p.includes("[]");
  return {
    schema: schemaName,
    live_keys_not_in_spec: itemKeys.filter((k) => !declared.has(k)),
    spec_top_level_keys_not_seen: [...declared]
      .filter((k) => topLevel(k) && !itemKeys.includes(k))
      .sort(),
  };
}

// --- HTTP --------------------------------------------------------------

async function token(cfg) {
  const res = await fetch(cfg.baseUrl + "/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret }),
    // Never re-send the client secret to the target of a redirect.
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error("token request failed with HTTP " + res.status);
  const body = await res.json();
  if (typeof body.access_token !== "string") throw new Error("token response has no access_token");
  return body.access_token;
}

async function get(cfg, bearer, pathAndQuery, query) {
  const url = new URL(cfg.baseUrl + pathAndQuery);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: "Bearer " + bearer, Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let body;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
}

function itemsOf(body, single) {
  if (single) return isObject(body) ? [body] : [];
  if (Array.isArray(body)) return body;
  if (isObject(body) && Array.isArray(body.items)) return body.items;
  return [];
}

export async function run({ out = DEFAULT_OUT, env = process.env } = {}) {
  const cfg = {
    baseUrl: (env.ACTION1_BASE_URL ?? "").replace(/\/+$/, ""),
    clientId: env.ACTION1_CLIENT_ID ?? "",
    clientSecret: env.ACTION1_CLIENT_SECRET ?? "",
    orgId: env.ACTION1_ORG_ID ?? "",
  };
  const missing = Object.entries(cfg)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error("Missing settings: " + missing.join(", ") + " (set the ACTION1_* variables).");
  }
  if (!cfg.baseUrl.startsWith("https://")) throw new Error("ACTION1_BASE_URL must be https.");
  const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
  const bearer = await token(cfg);
  const ids = { orgId: cfg.orgId };
  const results = [];
  for (const probe of probes()) {
    const [tpl, tplQuery] = probe.template.split("?");
    const p = fillTemplate(tpl, ids);
    const extra = tplQuery ? fillTemplate(tplQuery, ids) : "";
    if (p === undefined || extra === undefined) {
      results.push({
        id: probe.id,
        path: probe.template,
        skipped: "no id from an earlier request",
      });
      continue;
    }
    const query = { ...(probe.single ? {} : { limit: PAGE }), ...(probe.query ?? {}) };
    for (const pair of (extra ?? "").split("&").filter(Boolean)) {
      const [k, v] = pair.split("=");
      query[k] = decodeURIComponent(v);
    }
    let status;
    let body;
    try {
      ({ status, body } = await get(cfg, bearer, p, query));
    } catch (err) {
      results.push({ id: probe.id, path: probe.template, error: err?.name ?? "Error" });
      continue;
    }
    const items = status >= 200 && status < 300 ? itemsOf(body, probe.single) : [];
    if (probe.capture) {
      for (const [name, field] of Object.entries(probe.capture)) {
        const v = items
          .map((i) => (isObject(i) ? i[field] : undefined))
          .find((x) => typeof x === "string");
        if (v) ids[name] = v;
      }
    }
    const shape = describeItems(items);
    results.push({
      id: probe.id,
      path: probe.template,
      query_keys: Object.keys(query).sort(),
      status,
      envelope: probe.single ? undefined : describeEnvelope(body),
      item_count: items.length,
      ...shape,
      spec: items.length > 0 ? compareWithSpec(spec, probe.schema, shape.item_keys) : undefined,
    });
  }
  const report = {
    generated_at: new Date().toISOString(),
    base_url_host: new URL(cfg.baseUrl).host,
    note: "Key names, statuses, enum-like values and timestamp formats only. No ids, names or other values.",
    results,
  };
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n", "utf8");
  return report;
}

const invokedAsScript =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedAsScript) {
  const outIdx = process.argv.indexOf("--out");
  const out = outIdx > 0 ? process.argv[outIdx + 1] : DEFAULT_OUT;
  run({ out })
    .then((report) => {
      for (const r of report.results) {
        process.stdout.write(
          `${r.id}: ${r.skipped ?? r.error ?? r.status} (${r.item_count ?? 0} items)\n`,
        );
      }
      process.stdout.write("Report written to " + out + "\n");
    })
    .catch((err) => {
      process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
      process.exit(1);
    });
}
