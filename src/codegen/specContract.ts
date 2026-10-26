// The part of the Action1 OpenAPI spec that curated tools read.
//
// Curated tools interpret upstream records: they filter audit events by
// user, count endpoints that need a reboot, decide when an automation
// instance is finished. Every field name and enum value they rely on is
// listed here as a path into `components.schemas`, and `npm run codegen`
// writes the resolved names and values to src/spec/generated.ts. The
// curated code imports them from there (through src/spec/entities.ts),
// so a renamed field or a changed enum in a refreshed spec shows up as a
// type error or a failing contract test instead of a silent wrong answer.
//
// The resolver merges `$ref`, `allOf`, `oneOf` and `anyOf` parts, because
// Action1 composes most entities (AuditEvent = Base + own properties,
// InstalledSoftwareEndpoints = ReportDataSimple + field list + extra
// fields).

import type { JsonSchema } from "./zodEmit.js";

export interface SpecLike {
  components?: { schemas?: Record<string, unknown> };
}

/** A path below a component schema: property names, `[]` for array items. */
export interface SpecPath {
  /** Name of the generated constant. */
  name: string;
  /** Component schema name (`components.schemas.<schema>`). */
  schema: string;
  path: readonly string[];
}

/** Enum value sets the curated tools compare against. */
export const SPEC_ENUM_SOURCES: readonly SpecPath[] = [
  { name: "AutomationInstanceStatus", schema: "AutomationInstance", path: ["status"] },
  { name: "EndpointRebootRequired", schema: "Endpoint", path: ["reboot_required"] },
  { name: "EndpointStatus", schema: "Endpoint", path: ["status"] },
  { name: "EndpointOnlineStatus", schema: "Endpoint", path: ["online_status"] },
  { name: "EndpointUpdateStatus", schema: "Endpoint", path: ["update_status"] },
  { name: "EndpointVulnerabilityStatus", schema: "Endpoint", path: ["vulnerability_status"] },
  { name: "EndpointPlatform", schema: "Endpoint", path: ["platform"] },
  { name: "AuditEventName", schema: "AuditEvent", path: ["event"] },
  // Query parameter `reset_cache` of GET /endpoints/managed/{orgId}.
  { name: "ResetCache", schema: "ResetCache", path: [] },
];

/** Entities whose field names the curated tools read. */
export const SPEC_FIELD_SOURCES: readonly SpecPath[] = [
  { name: "ResultPage", schema: "ResultPage", path: [] },
  { name: "ResultPageAbridged", schema: "ResultPageAbridged", path: [] },
  { name: "Endpoint", schema: "Endpoint", path: [] },
  { name: "AuditEvent", schema: "AuditEvent", path: [] },
  { name: "AutomationInstance", schema: "AutomationInstance", path: [] },
  { name: "AutomationSchedule", schema: "AutomationSchedule", path: [] },
  { name: "AutomationTarget", schema: "AutomationSchedule", path: ["endpoints", "[]"] },
  { name: "AutomationAction", schema: "AutomationSchedule", path: ["actions", "[]"] },
  { name: "InstalledSoftwareRow", schema: "InstalledSoftwareEndpoints", path: [] },
  { name: "InstalledSoftwareFields", schema: "InstalledSoftwareEndpoints", path: ["fields"] },
  { name: "Vulnerability", schema: "Vulnerability", path: [] },
  { name: "VulnerableEndpoint", schema: "VulnerableEndpoint", path: [] },
  { name: "VulnerabilitySoftware", schema: "VulnerabilitySoftware", path: ["[]"] },
  {
    name: "VulnerabilityAvailableUpdate",
    schema: "VulnerabilityAvailableUpdates",
    path: ["[]"],
  },
  { name: "EndpointGroup", schema: "EndpointGroup", path: [] },
  { name: "Report", schema: "Report", path: [] },
  {
    name: "MissingUpdate",
    schema: "MissingUpdateSoftwareRepositoryPackage",
    path: [],
  },
];

function resolveRef(spec: SpecLike, ref: string): JsonSchema | undefined {
  const m = /^#\/components\/schemas\/(.+)$/.exec(ref);
  if (!m) return undefined;
  const v = spec.components?.schemas?.[m[1]!];
  return v && typeof v === "object" ? v : undefined;
}

/**
 * Expand a schema into its concrete parts: `$ref` targets, `allOf`,
 * `oneOf` and `anyOf` members are followed recursively (cycle-safe), the
 * schema itself is kept as one part.
 */
export function flattenSchema(
  spec: SpecLike,
  schema: JsonSchema | undefined,
  seen: readonly string[] = [],
): JsonSchema[] {
  if (!schema || typeof schema !== "object") return [];
  if (schema.$ref) {
    if (seen.includes(schema.$ref)) return [];
    return flattenSchema(spec, resolveRef(spec, schema.$ref), [...seen, schema.$ref]);
  }
  const out: JsonSchema[] = [schema];
  for (const part of [...(schema.allOf ?? []), ...(schema.oneOf ?? []), ...(schema.anyOf ?? [])]) {
    out.push(...flattenSchema(spec, part, seen));
  }
  return out;
}

/** Parts of the schema found at `path` below `components.schemas[schema]`. */
export function resolvePath(spec: SpecLike, schema: string, path: readonly string[]): JsonSchema[] {
  const root = spec.components?.schemas?.[schema];
  if (!root || typeof root !== "object") {
    throw new Error("Spec contract: components.schemas." + schema + " does not exist.");
  }
  let parts = flattenSchema(spec, root);
  for (const step of path) {
    parts =
      step === "[]"
        ? parts.flatMap((p) => (p.items ? flattenSchema(spec, p.items) : []))
        : parts.flatMap((p) => {
            const prop = p.properties?.[step];
            return prop ? flattenSchema(spec, prop) : [];
          });
    if (parts.length === 0) {
      throw new Error(
        "Spec contract: " + [schema, ...path].join(".") + " does not resolve (at " + step + ").",
      );
    }
  }
  return parts;
}

/** Property names declared by any part, in first-seen order. */
export function propertyNames(parts: readonly JsonSchema[]): string[] {
  const out = new Set<string>();
  for (const p of parts) for (const k of Object.keys(p.properties ?? {})) out.add(k);
  return [...out];
}

/** String enum values declared by any part (an allOf of enums is their union). */
export function enumValues(parts: readonly JsonSchema[]): string[] {
  const out = new Set<string>();
  for (const p of parts) {
    for (const v of p.enum ?? []) if (typeof v === "string") out.add(v);
  }
  return [...out];
}

export interface ResolvedContract {
  enums: Record<string, string[]>;
  fields: Record<string, string[]>;
}

/** Resolve every contract source; throws when a path no longer exists. */
export function resolveContract(spec: SpecLike): ResolvedContract {
  const enums: Record<string, string[]> = {};
  for (const src of SPEC_ENUM_SOURCES) {
    const values = enumValues(resolvePath(spec, src.schema, src.path));
    if (values.length === 0) {
      throw new Error(
        "Spec contract: " + [src.schema, ...src.path].join(".") + " has no string enum values.",
      );
    }
    enums[src.name] = values;
  }
  const fields: Record<string, string[]> = {};
  for (const src of SPEC_FIELD_SOURCES) {
    const names = propertyNames(resolvePath(spec, src.schema, src.path));
    if (names.length === 0) {
      throw new Error(
        "Spec contract: " + [src.schema, ...src.path].join(".") + " declares no properties.",
      );
    }
    fields[src.name] = names;
  }
  return { enums, fields };
}

/** TypeScript source of src/spec/generated.ts. */
export function specModuleSource(contract: ResolvedContract, sha: string): string {
  const block = (rec: Record<string, string[]>): string =>
    "{\n" +
    Object.entries(rec)
      .map(([k, vs]) => "  " + k + ": [" + vs.map((v) => JSON.stringify(v)).join(", ") + "],")
      .join("\n") +
    "\n}";
  return (
    "// AUTO-GENERATED by src/codegen/generate.ts. Do not edit by hand.\n" +
    "// Source: src/codegen/spec/openapi.json (SHA: " +
    sha +
    ")\n" +
    "// Field names and enum values the curated tools read, resolved from\n" +
    "// the paths in src/codegen/specContract.ts.\n\n" +
    "/** Enum value sets, in spec order. */\n" +
    "export const SPEC_ENUMS = " +
    block(contract.enums) +
    " as const;\n\n" +
    "/** Declared property names per entity (allOf / oneOf parts merged). */\n" +
    "export const SPEC_FIELDS = " +
    block(contract.fields) +
    " as const;\n\n" +
    "export type SpecEnumName = keyof typeof SPEC_ENUMS;\n" +
    "export type SpecEnumValue<N extends SpecEnumName> = (typeof SPEC_ENUMS)[N][number];\n" +
    "export type SpecEntity = keyof typeof SPEC_FIELDS;\n" +
    "export type SpecField<E extends SpecEntity> = (typeof SPEC_FIELDS)[E][number];\n"
  );
}
