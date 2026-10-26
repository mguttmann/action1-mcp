// Translate OpenAPI 3.1 (JSON Schema) request-body and response schemas
// into Zod source code for the generated tools.
//
// Request bodies (`bodyZodSource`) get a real input contract: objects
// with their properties, `required`, enums, consts, arrays (including a
// top-level array body) and oneOf/anyOf alternatives. The translation is
// deliberately permissive where the spec is not a reliable contract:
//   - every object is a loose object (unknown keys pass through), so a
//     field Action1 accepts but does not document is never rejected;
//   - minItems / minimum / pattern / format are not enforced;
//   - a string enum with a "{placeholder}" value is a plain string
//     (the placeholder stands for an id the caller fills in);
//   - PATCH bodies drop top-level `required` (partial update semantics;
//     Action1 reuses POST payload schemas for some PATCH operations);
//   - unresolvable or very deep sub-schemas fall back to z.unknown().
//
// Response schemas (`outputObjectSource`) only contribute the top-level
// property NAMES (all optional, value z.unknown(), the spec type as the
// description). Real Action1 responses do not always match
// the declared types (nulls, numbers sent as strings), and MCP clients
// validate structuredContent against outputSchema, so typed output
// properties would turn spec inaccuracies into failed tool calls.

import { flattenSchema } from "./specContract.js";

export interface JsonSchema {
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  const?: unknown;
  description?: string;
  title?: string;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  patternProperties?: Record<string, JsonSchema>;
  allOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  $ref?: string;
}

export interface SpecWithComponents {
  components?: { schemas?: Record<string, unknown> };
}

/**
 * Object-nesting depth after which sub-schemas are emitted as z.unknown()
 * (and objects at this depth as plain records). Arrays do not count as a
 * level. Every level is repeated in every tools/list response, so the cap
 * trades contract detail for context size: 2 keeps body fields, the
 * fields of nested objects and array items (e.g. the `template_id` and
 * `name` of automation actions), while deeper parameter trees stay
 * untyped records.
 */
export const MAX_BODY_DEPTH = 2;

/** An enum value such as "{orgId}": a template for an id, not an option. */
const PLACEHOLDER = /\{[^}]+\}/;

function isPlaceholderEnum(schema: JsonSchema): boolean {
  return (
    Array.isArray(schema.enum) &&
    schema.enum.length > 0 &&
    schema.enum.every((v) => typeof v === "string") &&
    schema.enum.some((v) => PLACEHOLDER.test(v))
  );
}

/** Max length of a property description emitted with .describe(). */
const PROP_DESC_MAX = 90;

const lit = (v: unknown): string => JSON.stringify(v);

function resolveRef(spec: SpecWithComponents, ref: string): JsonSchema | undefined {
  const m = /^#\/components\/schemas\/(.+)$/.exec(ref);
  if (!m) return undefined;
  const value = spec.components?.schemas?.[m[1]!];
  return value && typeof value === "object" ? value : undefined;
}

/** Collapse whitespace and cap at a sentence or word boundary. */
export function capDescription(raw: string | undefined, max = PROP_DESC_MAX): string {
  // En and em dashes from the spec become plain hyphens.
  const desc = (raw ?? "")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  if (desc.length <= max) return desc;
  const slice = desc.slice(0, max);
  const sentenceCut = slice.search(/\.\s/);
  if (sentenceCut > 0) return slice.slice(0, sentenceCut + 1);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > 30) return slice.slice(0, lastSpace) + "...";
  return desc.slice(0, max - 3) + "...";
}

interface Ctx {
  spec: SpecWithComponents;
  depth: number;
  refs: string[];
  /** Drop `required` on the object at this level (PATCH top level). */
  partial: boolean;
}

/**
 * Merge an allOf chain (plus the schema's own properties / required)
 * into one object schema. Returns null when a part is not object-like
 * (e.g. carries its own oneOf), so the caller can fall back.
 */
function mergeAllOf(schema: JsonSchema, ctx: Ctx): JsonSchema | null {
  const properties: Record<string, JsonSchema> = {};
  const required = new Set<string>();
  const visit = (s: JsonSchema, refs: string[]): boolean => {
    if (s.$ref) {
      if (refs.includes(s.$ref)) return false;
      const r = resolveRef(ctx.spec, s.$ref);
      return r ? visit(r, [...refs, s.$ref]) : false;
    }
    if (s.oneOf || s.anyOf) return false;
    if (s.type !== undefined && s.type !== "object") return false;
    for (const part of s.allOf ?? []) if (!visit(part, refs)) return false;
    Object.assign(properties, s.properties ?? {});
    for (const r of s.required ?? []) required.add(r);
    return true;
  };
  if (!visit(schema, ctx.refs)) return null;
  return {
    type: "object",
    properties,
    required: [...required],
    ...(schema.description !== undefined ? { description: schema.description } : {}),
  };
}

function primitive(type: string | undefined): string | null {
  switch (type) {
    case "string":
      return "z.string()";
    case "integer":
      return "z.number().int()";
    case "number":
      return "z.number()";
    case "boolean":
      return "z.boolean()";
    case "null":
      return "z.null()";
    default:
      return null;
  }
}

function union(members: string[]): string {
  const uniq = [...new Set(members)];
  if (uniq.includes("z.unknown()")) return "z.unknown()";
  if (uniq.length === 1) return uniq[0]!;
  return "z.union([" + uniq.join(", ") + "])";
}

function emit(schema: JsonSchema | undefined, ctx: Ctx): string {
  if (!schema || typeof schema !== "object") return "z.unknown()";
  if (ctx.depth > MAX_BODY_DEPTH) return "z.unknown()";
  const next = (s: JsonSchema | undefined, refs = ctx.refs): string =>
    emit(s, { spec: ctx.spec, depth: ctx.depth + 1, refs, partial: false });

  if (schema.$ref) {
    if (ctx.refs.includes(schema.$ref)) return "z.unknown()";
    const target = resolveRef(ctx.spec, schema.$ref);
    if (!target) return "z.unknown()";
    return emit(target, { ...ctx, refs: [...ctx.refs, schema.$ref] });
  }

  if (schema.const !== undefined) return "z.literal(" + lit(schema.const) + ")";

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    if (schema.enum.every((v) => typeof v === "string")) {
      // A value like "{orgId}" is a template for a caller-supplied id, not
      // a literal option (SettingScope.object lists ["all", "{orgId}",
      // "{groupId}"]); a strict enum would reject every real id.
      if (isPlaceholderEnum(schema)) {
        const own = capDescription(schema.description);
        const hint = (own ? own + " " : "") + "Accepts: " + schema.enum.join(", ") + ".";
        return "z.string().describe(" + lit(hint) + ")";
      }
      return "z.enum([" + schema.enum.map(lit).join(", ") + "])";
    }
    return union(schema.enum.map((v) => "z.literal(" + lit(v) + ")"));
  }

  const alternatives = schema.oneOf ?? schema.anyOf;
  if (alternatives && alternatives.length > 0) {
    const alt = union(alternatives.map((a) => emit(a, { ...ctx, partial: false })));
    const hasOwnShape = schema.properties !== undefined || schema.allOf !== undefined;
    if (!hasOwnShape) return alt;
    const { oneOf: _o, anyOf: _a, ...rest } = schema;
    void _o;
    void _a;
    const own = emit(rest, ctx);
    return own === "z.unknown()" || alt === "z.unknown()"
      ? "z.unknown()"
      : "z.intersection(" + own + ", " + alt + ")";
  }

  if (schema.allOf && schema.allOf.length > 0) {
    const merged = mergeAllOf(schema, ctx);
    if (!merged) {
      const parts = [...schema.allOf.map((p) => emit(p, { ...ctx, partial: false }))];
      if (parts.includes("z.unknown()")) return "z.unknown()";
      return parts.reduce((acc, p) => "z.intersection(" + acc + ", " + p + ")");
    }
    return emit(merged, ctx);
  }

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const nullable = types.includes("null") && types.length > 1;
  const type = types.find((t) => t !== "null") ?? (types.length === 1 ? "null" : undefined);
  const isObject = type === "object" || (type === undefined && schema.properties !== undefined);

  let out: string;
  if (isObject) {
    const props = schema.properties ?? {};
    const keys = Object.keys(props);
    if (keys.length > 0 && ctx.depth >= MAX_BODY_DEPTH) {
      // Every field would be z.unknown() at the next level; a plain
      // record says the same thing in far fewer tools/list bytes.
      out = "z.record(z.string(), z.unknown())";
    } else if (keys.length === 0) {
      const valueSchema =
        schema.patternProperties !== undefined
          ? Object.values(schema.patternProperties)[0]
          : typeof schema.additionalProperties === "object"
            ? schema.additionalProperties
            : undefined;
      out = "z.record(z.string(), " + (valueSchema ? next(valueSchema) : "z.unknown()") + ")";
    } else {
      const required = ctx.partial ? new Set<string>() : new Set(schema.required ?? []);
      const fields = keys.map((k) => {
        let z = next(props[k]);
        // A placeholder enum already carries its description plus the hint.
        const desc =
          ctx.depth <= 1 && !isPlaceholderEnum(props[k]!)
            ? capDescription(props[k]!.description)
            : "";
        if (desc) z += ".describe(" + lit(desc) + ")";
        if (!required.has(k)) z += ".optional()";
        return lit(k) + ": " + z;
      });
      out = "z.looseObject({ " + fields.join(", ") + " })";
    }
  } else if (type === "array") {
    // Array items stay at the array's depth: the cap counts object
    // nesting, so `[{...}]` bodies keep their item fields typed.
    out = "z.array(" + emit(schema.items, { ...ctx, partial: false }) + ")";
  } else {
    out = primitive(type) ?? "z.unknown()";
  }
  if (nullable && out !== "z.unknown()") out += ".nullable()";
  return out;
}

/**
 * Zod source for a request body schema. `method` decides the PATCH
 * partial-update rule. The returned expression has no .optional() /
 * .describe(); the caller adds those.
 */
export function bodyZodSource(
  spec: SpecWithComponents,
  schema: JsonSchema | undefined,
  method: string,
): string {
  return emit(schema, {
    spec,
    depth: 0,
    refs: [],
    partial: method.toUpperCase() === "PATCH",
  });
}

/**
 * Top-level properties of a response object schema (allOf merged), or
 * null when the schema is not an object with named properties.
 */
export function responseProperties(
  spec: SpecWithComponents,
  schema: JsonSchema | undefined,
): Record<string, JsonSchema> | null {
  if (!schema) return null;
  const merged = mergeAllOf(schema, { spec, depth: 0, refs: [], partial: false });
  if (!merged || !merged.properties || Object.keys(merged.properties).length === 0) return null;
  return merged.properties;
}

/**
 * Zod source for a loose output object whose keys are `props`, every
 * value `z.unknown()` and optional, without descriptions: the field
 * names are the documentation. Prose descriptions would roughly double
 * the size of every outputSchema in tools/list, and a bare type name
 * ({"description": "string"}) adds bytes without a contract. Never
 * rejects any object.
 */
export function outputObjectSource(props: Record<string, JsonSchema>): string {
  const fields = Object.keys(props).map((k) => lit(k) + ": z.unknown().optional()");
  return "z.looseObject({ " + fields.join(", ") + " })";
}

/** Zod source of one path or query parameter. */
export interface ParamZod {
  zod: string;
  /** The parameter is a date-time: accept and send the Action1 format. */
  action1Time: boolean;
}

/**
 * Zod source for a path or query parameter schema. Same translation as
 * request bodies (so `$ref` enums such as RebootRequired or LogLevel
 * stay enums), with three parameter rules:
 *   - `format: date-time` becomes `action1TimeSchema` (src/spec/time.ts):
 *     the spec documents these values as YYYY-MM-DD_HH-MM-SS, which a
 *     plain ISO check would reject; ISO input is accepted too and the
 *     runtime sends the documented format;
 *   - a value composed of several enums (`OS` = allOf of the Windows and
 *     macOS version lists) stays a free string: an intersection of
 *     disjoint enums would accept nothing, and the version lists move
 *     faster than the pinned spec;
 *   - an untyped schema is a string (query strings are strings on the
 *     wire).
 */
export function paramZodSource(spec: SpecWithComponents, schema: JsonSchema | undefined): ParamZod {
  if (!schema) return { zod: "z.string()", action1Time: false };
  const parts = flattenSchema(spec, schema);
  if (parts.some((p) => p.format === "date-time")) {
    return { zod: "action1TimeSchema", action1Time: true };
  }
  if (parts.some((p) => p.format === "uuid"))
    return { zod: "z.string().uuid()", action1Time: false };
  const enumParts = parts.filter((p) => Array.isArray(p.enum) && p.enum.length > 0);
  if (enumParts.length > 1) return { zod: "z.string()", action1Time: false };
  const out = emit(schema, { spec, depth: 0, refs: [], partial: false });
  return { zod: out === "z.unknown()" ? "z.string()" : out, action1Time: false };
}
