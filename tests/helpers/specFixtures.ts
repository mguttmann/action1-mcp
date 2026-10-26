// Test fixtures derived from the vendored Action1 OpenAPI spec.
//
// `specExample("AuditEvent", { user_name: "alice" })` builds a minimal
// valid record of a component schema: every declared property (allOf /
// oneOf parts merged) gets its spec `example`, else its first enum value,
// else a value of its declared type. Overrides are merged on top (nested
// objects deep-merged). Fixtures built this way follow the spec's field
// names, so a test cannot quietly confirm an invented shape.

import { readFileSync } from "node:fs";
import {
  flattenSchema,
  propertyNames,
  resolvePath,
  type SpecLike,
} from "../../src/codegen/specContract.js";
import type { JsonSchema } from "../../src/codegen/zodEmit.js";

export const SPEC = JSON.parse(
  readFileSync(new URL("../../src/codegen/spec/openapi.json", import.meta.url), "utf8"),
) as SpecLike;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const MAX_DEPTH = 3;

function valueFor(parts: JsonSchema[], name: string, depth: number): Json {
  const example = parts
    .map((p) => (p as { example?: unknown }).example)
    .find((e) => e !== undefined);
  const enumValue = parts.flatMap((p) => p.enum ?? []).find((v) => typeof v === "string");
  const constValue = parts.map((p) => p.const).find((c) => c !== undefined);
  const types = parts.flatMap((p) => (Array.isArray(p.type) ? p.type : p.type ? [p.type] : []));
  const isArray = types.includes("array") || parts.some((p) => p.items !== undefined);
  const props = propertyNames(parts);
  if (constValue !== undefined) return constValue as Json;
  if (enumValue !== undefined) return enumValue;
  if (isArray) {
    if (depth >= MAX_DEPTH) return [];
    const itemParts = parts.flatMap((p) => (p.items ? flattenSchema(SPEC, p.items) : []));
    if (itemParts.length === 0) return [];
    return [valueFor(itemParts, name, depth + 1)];
  }
  if (props.length > 0 || types.includes("object")) {
    if (depth >= MAX_DEPTH) return {};
    return objectFor(parts, depth + 1);
  }
  if (example !== undefined && typeof example !== "object") {
    // The spec types some numeric examples as strings ("example": 1).
    return types.includes("string")
      ? typeof example === "string"
        ? example
        : JSON.stringify(example)
      : (example as Json);
  }
  if (types.includes("number") || types.includes("integer")) return 1;
  if (types.includes("boolean")) return true;
  return name + "-value";
}

function objectFor(parts: JsonSchema[], depth: number): { [k: string]: Json } {
  const out: { [k: string]: Json } = {};
  for (const key of propertyNames(parts)) {
    const propParts = parts.flatMap((p) => {
      const prop = p.properties?.[key];
      return prop ? flattenSchema(SPEC, prop) : [];
    });
    out[key] = valueFor(propParts, key, depth);
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** Minimal record of `components.schemas[schema]` (optionally at `path`) plus overrides. */
export function specExample(
  schema: string,
  overrides: Record<string, unknown> = {},
  path: readonly string[] = [],
): Record<string, unknown> {
  const base = objectFor(resolvePath(SPEC, schema, path), 1);
  return deepMerge(base, overrides);
}

/** Minimal value of an arbitrary spec schema (a response or request body schema). */
export function schemaExample(schema: JsonSchema): unknown {
  return valueFor(flattenSchema(SPEC, schema), "value", 0);
}

/** A `ResultPage` envelope as documented in the spec. */
export function resultPage(
  items: unknown[],
  opts: { total?: number; nextPage?: string } = {},
): Record<string, unknown> {
  return {
    type: "ResultPage",
    items,
    total_items: String(opts.total ?? items.length),
    limit: String(items.length),
    next_page: opts.nextPage ?? "",
    prev_page: "",
  };
}
