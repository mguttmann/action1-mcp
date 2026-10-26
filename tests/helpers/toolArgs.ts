// Minimal valid arguments for a tool, built from the input schema it
// advertises in tools/list. Sweeps over the registry use this, so a new
// tool is called without a hand-written argument list.

type Json = Record<string, unknown>;

/** A value that satisfies a JSON Schema as advertised in tools/list. */
export function sampleValue(schema: Json | undefined, key = ""): unknown {
  if (!schema || Object.keys(schema).length === 0) return "x";
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (Array.isArray(schema.anyOf)) return sampleValue(schema.anyOf[0] as Json, key);
  if (Array.isArray(schema.oneOf)) return sampleValue(schema.oneOf[0] as Json, key);
  if (Array.isArray(schema.allOf)) {
    return Object.assign({}, ...schema.allOf.map((s) => sampleValue(s as Json, key) as Json));
  }
  const type = Array.isArray(schema.type)
    ? (schema.type as string[]).find((t) => t !== "null")
    : (schema.type as string | undefined);
  switch (type) {
    case "object": {
      const props = (schema.properties ?? {}) as Record<string, Json>;
      const out: Json = {};
      for (const k of (schema.required ?? []) as string[]) out[k] = sampleValue(props[k], k);
      return out;
    }
    case "array": {
      const n = typeof schema.minItems === "number" ? Math.max(1, schema.minItems) : 1;
      return Array.from({ length: n }, () => sampleValue(schema.items as Json, key));
    }
    case "integer":
    case "number":
      return typeof schema.minimum === "number" ? Math.max(1, schema.minimum) : 1;
    case "boolean":
      return true;
    case "null":
      return null;
    default:
      return sampleString(schema, key);
  }
}

function sampleString(schema: Json, key: string): string {
  if (schema.format === "uuid") return "00000000-0000-4000-8000-000000000001";
  if (schema.format === "date-time") return "2026-01-01T00:00:00Z";
  const pattern = typeof schema.pattern === "string" ? schema.pattern : "";
  if (/CVE/i.test(pattern) || /^cve/i.test(key)) return "CVE-2026-0001";
  if (pattern.startsWith("^\\/")) return "/x";
  // Ids: curated tools validate endpoint ids as UUIDs or by length.
  if (/_id$/.test(key) || pattern !== "" || typeof schema.minLength === "number") {
    return "00000000-0000-4000-8000-000000000001";
  }
  return "x";
}

/** Minimal arguments: every required property of the advertised input schema. */
export function minimalToolArgs(tool: { name: string; inputSchema: unknown }): Json {
  const schema = tool.inputSchema as Json;
  const props = (schema.properties ?? {}) as Record<string, Json>;
  const args: Json = {};
  for (const k of (schema.required ?? []) as string[]) args[k] = sampleValue(props[k], k);
  return args;
}

/**
 * Arguments a sweep adds to the minimal ones, per tool, where the
 * required properties alone do not describe a call that can succeed.
 */
export const SWEEP_ARG_OVERRIDES: Readonly<Record<string, Json>> = {
  // Either cve_id or endpoint_id is needed; neither is required alone.
  action1_cve_remediation_plan: { cve_id: "CVE-2026-0001" },
  // script mode (the default) needs script_text; poll as fast as allowed.
  action1_execute_and_wait: {
    script_text: "x",
    timeout_seconds: 5,
    poll_interval_seconds: 1,
    skip_connectivity_check: true,
  },
  action1_wait_for_automation: { timeout_seconds: 5, poll_interval_seconds: 1 },
  // The spec's example endpoint was last seen years ago; the offline
  // check would abort before the request under test (also above).
  action1_run_script: { skip_connectivity_check: true },
  action1_reboot_endpoint: { skip_connectivity_check: true },
  // A documented path instead of the schema's minimal "/x".
  action1_raw_request: { path: "/me" },
};

/** Minimal arguments plus the sweep overrides of the tool. */
export function sweepToolArgs(tool: { name: string; inputSchema: unknown }): Json {
  return { ...minimalToolArgs(tool), ...(SWEEP_ARG_OVERRIDES[tool.name] ?? {}) };
}
