// Infer the right curated `outputSchema` shape for each generated tool.
//
// `outputSchemaSource` then refines the read shapes with the top-level
// property names the spec documents for the response (or for each list
// item), via `outputObjectSource` in zodEmit.ts: loose objects whose
// values are z.unknown(), so the schema documents the contract without
// ever rejecting a real response.
//
// We pick from three reusable shapes defined in `src/tools/helpers.ts`:
//
//   - cursorListOutputShape   : list-of-items + has_more + next_cursor
//   - listOutputShape         : list-of-items + count + total + truncated
//   - singleObjectOutputShape : { data?: Record<string, unknown> }
//
// Plus a synthesised `okStatusShape` for destructive endpoints whose
// 200 response is documented as a single object (the runtime returns
// `{ ok: true, ...body }` either way).

import { outputObjectSource, responseProperties, type JsonSchema } from "./zodEmit.js";

interface SchemaObject {
  type?: string;
  format?: string;
  enum?: string[];
  description?: string;
  items?: SchemaObject | RefObject;
  properties?: Record<string, SchemaObject | RefObject>;
  $ref?: string;
  allOf?: (SchemaObject | RefObject)[];
}

interface RefObject {
  $ref: string;
}

interface ResponseObject {
  description?: string;
  content?: Record<string, { schema?: SchemaObject | RefObject }>;
  $ref?: string;
}

interface SpecLike {
  components?: {
    responses?: Record<string, unknown>;
    schemas?: Record<string, unknown>;
  };
}

function isRef(v: unknown): v is RefObject {
  return Boolean(v) && typeof v === "object" && v !== null && "$ref" in v;
}

function deref<T>(spec: SpecLike, value: T | RefObject): T {
  if (!isRef(value)) return value;
  const parts = value.$ref.replace(/^#\//, "").split("/");
  let cur: unknown = spec;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in cur) {
      // nosemgrep: javascript.lang.security.audit.prototype-pollution.prototype-pollution-loop.prototype-pollution-loop -- read-only $ref traversal guarded by `p in cur`; no write, so no prototype pollution. Trusted build-time OpenAPI spec input.
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return value as unknown as T;
    }
  }
  return cur as T;
}

/**
 * Walk the (possibly $ref'd) 200-response schema and decide whether it
 * looks list-shaped or single-object.
 */
export type OutputShape = "list" | "cursor_list" | "single" | "ok_status";

export function inferOutputShape(
  spec: SpecLike,
  responses: Record<string, unknown> | undefined,
  method: string,
  hasPagination: boolean,
): OutputShape {
  const m = method.toUpperCase();
  // Non-JSON endpoints (audit_export, reportdata
  // *_export - CSV/HTML downloads) advertise `limit`+`from` for paging
  // through tabular export rows, but the upstream body is a raw blob
  // wrapped as `{value: <string>}` by the runtime. cursor_list would
  // then fail schema validation. Detect "no JSON response" up-front and
  // force `single` regardless of `hasPagination`.
  const hasJsonResponse = hasJsonResponseBody(spec, responses);
  if (!hasJsonResponse) {
    // Destructive non-JSON ops still benefit from the destructive guard
    // emitting `{ok, dry_run, would_call}` - keep ok_status. Read-only
    // non-JSON ops (CSV exports) get `single` so the {value: ...} envelope
    // round-trips cleanly.
    if (m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE") {
      return "ok_status";
    }
    return "single";
  }
  if (m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE") {
    // Even when the destructive endpoint returns the full updated object,
    // the runtime wraps it in `{ ok: true, dry_run, would_call }` for the
    // dry-run path; the live path returns the raw body. The simplest
    // reliable schema is `singleObject`.
    // But for actions whose 200 schema is a list (rare), prefer that.
    const schema = resolveResponseSchema(spec, responses);
    if (schema && looksListLike(spec, schema)) {
      return hasPagination ? "cursor_list" : "list";
    }
    // Pagination semantics dominate response-shape inference. If the
    // operation accepts `limit`+`from`, the runtime's pagedFetch path
    // returns `{items, count, has_more, next_cursor, ...}` whenever the
    // agent sets `auto_paginate=true` - even if the spec advertises a
    // single-object body. Single-object + pagination is semantically
    // inconsistent; emit cursor_list so the runtime output validates.
    if (hasPagination) return "cursor_list";
    return "ok_status";
  }
  // GET / HEAD
  const schema = resolveResponseSchema(spec, responses);
  if (schema && looksListLike(spec, schema)) {
    return hasPagination ? "cursor_list" : "list";
  }
  // Same reasoning as the destructive branch: pagination wins over the
  // declared single-object shape. The agent can paginate; the schema
  // must validate the pagedFetch envelope when it does.
  if (hasPagination) return "cursor_list";
  return "single";
}

/**
 * Returns true iff the 200/201 response declares an `application/json`
 * content-type. Used to detect CSV / octet-stream / HTML endpoints
 * (audit_export, reportdata exports) so they don't get bucketed into
 * the list/cursor_list shape - their non-JSON bodies are wrapped by the
 * runtime as `{value: "<raw>"}` which would fail list-shape validation.
 */
function hasJsonResponseBody(
  spec: SpecLike,
  responses: Record<string, unknown> | undefined,
): boolean {
  if (!responses) return false;
  const r = (responses["200"] ?? responses["201"]) as ResponseObject | RefObject | undefined;
  if (!r) return false;
  // Deref $ref before reading content: many 200/201 entries in the spec
  // are references, and treating them as "no JSON body" would
  // mis-classify paginated ref'd operations as `single`.
  let resolved: ResponseObject;
  try {
    resolved = deref<ResponseObject>(spec, r);
  } catch {
    return false;
  }
  const content = resolved.content;
  if (!content) return false;
  return Object.keys(content).some((mt) => /^application\/json\b/i.test(mt));
}

function resolveResponseSchema(
  spec: SpecLike,
  responses: Record<string, unknown> | undefined,
): SchemaObject | null {
  if (!responses) return null;
  const r200 = (responses["200"] ?? responses["201"]) as ResponseObject | RefObject | undefined;
  if (!r200) return null;
  const resolved = deref<ResponseObject>(spec, r200);
  const schema = resolved.content?.["application/json"]?.schema;
  if (!schema) return null;
  return deref<SchemaObject>(spec, schema);
}

function looksListLike(spec: SpecLike, schema: SchemaObject): boolean {
  // Direct array
  if (schema.type === "array") return true;
  // {items: [...]} envelope (Action1's ResultPage pattern)
  if (schema.properties && "items" in schema.properties) {
    const items = schema.properties.items;
    const itemsResolved = items ? deref<SchemaObject>(spec, items) : null;
    if (itemsResolved && (itemsResolved.type === "array" || itemsResolved.items)) {
      return true;
    }
  }
  // allOf with a $ref to ResultPage or similar
  if (schema.allOf) {
    for (const a of schema.allOf) {
      const r = deref<SchemaObject>(spec, a);
      if (r.properties && "items" in r.properties) return true;
      if (r.$ref && /ResultPage|Page/i.test(r.$ref)) return true;
    }
  }
  return false;
}

/**
 * Render the import-name + emit string for a given output shape.
 *
 * Returns null when no `outputSchema` should be set (defensive default).
 */
export function emitOutputSchema(shape: OutputShape): string {
  switch (shape) {
    case "cursor_list":
      return "cursorListOutputShape";
    case "list":
      return "listOutputShape";
    case "single":
      return "singleObjectOutputShape";
    case "ok_status":
      return "okStatusOutputShape";
  }
}

/** Item schema of a list-shaped response (bare array or `{items: [...]}`). */
function listItemSchema(spec: SpecLike, schema: SchemaObject): SchemaObject | null {
  if (schema.type === "array" && schema.items) return deref<SchemaObject>(spec, schema.items);
  const props = responseProperties(spec, schema);
  const items = props?.items as SchemaObject | undefined;
  if (items?.items) return deref<SchemaObject>(spec, items.items);
  return null;
}

/** Union of the documented top-level properties of an item schema and its oneOf/anyOf variants. */
function itemProperties(spec: SpecLike, item: SchemaObject): Record<string, JsonSchema> | null {
  const variants = (item as JsonSchema).oneOf ?? (item as JsonSchema).anyOf;
  const parts = variants
    ? variants.map((v) => deref<SchemaObject>(spec, v as SchemaObject))
    : [item];
  const out: Record<string, JsonSchema> = {};
  for (const part of parts) {
    Object.assign(out, responseProperties(spec, part as JsonSchema) ?? {});
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Fields of the dry-run preview every destructive tool returns by
 * default (src/tools/destructiveGuard.ts). A destructive tool's output
 * schema lists them next to the spec's response fields: one call returns
 * either the preview or the response, and all fields are optional.
 */
const DRY_RUN_PREVIEW_PROPS: Record<string, JsonSchema> = {
  dry_run: { type: "boolean" },
  tool: { type: "string" },
  would_send: { type: "object" },
};

/** Field the runtime wraps a non-object response body in. */
const VALUE_PROP: Record<string, JsonSchema> = { value: { type: "string" } };

/**
 * TypeScript source of the outputSchema for a generated tool. Read
 * shapes are refined with the spec's documented property names when the
 * response schema has them; destructive tools add the dry-run preview
 * fields; a response without JSON properties is documented as the
 * `value` the runtime wraps it in.
 */
export function outputSchemaSource(
  spec: SpecLike,
  responses: Record<string, unknown> | undefined,
  shape: OutputShape,
  destructive = false,
): string {
  const base = emitOutputSchema(shape);
  const json = hasJsonResponseBody(spec, responses);
  const schema = json ? resolveResponseSchema(spec, responses) : null;
  if (shape === "single" || shape === "ok_status") {
    const props = (schema && itemProperties(spec, schema)) ?? VALUE_PROP;
    if (!destructive) return outputObjectSource(props);
    return outputObjectSource({ ...DRY_RUN_PREVIEW_PROPS, ...props });
  }
  if (!schema) return base;
  const item = listItemSchema(spec, schema);
  const props = item ? itemProperties(spec, item) : null;
  if (!props) return base;
  return base + ".extend({ items: z.array(" + outputObjectSource(props) + ") })";
}
