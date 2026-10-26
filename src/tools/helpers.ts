import { z } from "zod";
import { Action1ApiError } from "../client/errors.js";
import { renderMarkdownTable } from "../utils/markdownTable.js";
import {
  capItemList,
  capItemStream,
  compactItem,
  fitToByteBudget,
  jsonByteLength,
  type CapResult,
} from "../utils/capOutput.js";
import { MAX_LIST_LIMIT, RESPONSE_BYTE_BUDGET } from "../constants.js";
import { piiRedactionEnabled, redactPii } from "../utils/pii.js";
import { redactSecretKeys, redactString } from "../utils/logger.js";
import type { CallToolResult } from "@modelcontextprotocol/server";

// Reusable output schemas for the curated read tools.
//
// All output schemas are registered as full ZodObjects with
// .passthrough() - NOT plain `z.object(shape)`. Reason: a plain object
// schema strips or (in clients that validate against the advertised
// JSON schema) rejects any extra key the upstream API surfaces. The
// upstream Action1 envelope varies (some endpoints add `next`, `total`,
// fields the agent actually wants to read), and a constrained shape
// would block them all.
//
// Required fields stay required, extras pass through. The single-object
// and ok-status shapes below follow the same rule.
export const listOutputShape = z
  .object({
    items: z.array(z.record(z.string(), z.unknown())),
    count: z.number(),
    total: z.number().optional(),
    truncated: z.number().optional(),
    note: z.string().optional(),
  })
  .passthrough();

// Output schema for cursor-paginated list tools. Same shape as
// `listOutputShape` plus the cursor-control fields. Also .passthrough()
// for the same reason.
//
// `has_more` and `next_cursor` are intentionally optional: generated
// tools that *can* paginate (cursor / auto_paginate args present) only
// emit the cursor fields when the caller actually opts into cursor
// mode. A plain GET without cursor args goes through runtime.ts's
// direct-request path which returns a single-page envelope and does
// not synthesise pagination state. Pinning them as required would
// reject every non-cursor call against these tools.
export const cursorListOutputShape = z
  .object({
    items: z.array(z.record(z.string(), z.unknown())),
    count: z.number(),
    has_more: z.boolean().optional(),
    next_cursor: z.string().nullable().optional(),
    total: z.number().optional(),
    note: z.string().optional(),
  })
  .passthrough();

// Input shape extension for cursor-aware list tools.
// Param descriptions are kept tight: the agent has the docstring +
// the schema, repeating "default" / "max" wastes tools/list payload.
export const cursorInputShape = {
  cursor: z.string().optional().describe("Pagination cursor."),
  limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional().describe("Max items."),
};

// Output schema for single-object responses. A permissive ZodObject
// (.passthrough()) so the advertised JSON schema allows additional
// properties: the upstream Action1 payload varies per endpoint, and a
// constrained shape would reject any extra field the agent legitimately
// needs. It must be an object schema (not z.record) because MCP
// requires an outputSchema of type "object".
//
// A narrower shape such as `{ data?: object }` would reject a curated
// counter response like `{ total, by_status, by_platform, ... }`. The
// schema advertises "this is a single object", not every upstream key.
export const singleObjectOutputShape = z.object({}).passthrough();

/**
 * Output schema of a curated single-object result: the named fields
 * (each optional, any value, described by `label`) plus passthrough.
 * Documents the result without ever rejecting it, like the generated
 * tools' output schemas.
 */
export function objectOutputShape(fields: Record<string, string>) {
  return z
    .object(
      Object.fromEntries(
        Object.entries(fields).map(([k, label]) => [k, z.unknown().describe(label).optional()]),
      ),
    )
    .passthrough();
}

// Output schema for destructive operations (POST/PATCH/PUT/DELETE).
// Same rationale as singleObjectOutputShape: the dry-run preview emits
// `{ dry_run, tool, would_send }` while the live path returns whatever
// the upstream API hands back - both have keys that a constrained shape
// would reject. Permissive ZodObject (.passthrough()) keeps the SDK
// registration happy and admits arbitrary keys at validation time.
export const okStatusOutputShape = z.object({}).passthrough();

export const orgIdShape = {
  org_id: z.string().min(1).optional().describe("Org UUID."),
};

// Strict UUID - for tools that only accept a single endpoint (no
// `target_type: "EndpointGroup"` argument). Action1's endpoint IDs are
// canonical UUIDv4 strings (lowercase hex, 4 dashes). Group IDs use a
// different format ("New_Endpoints_<uuid>") and need the looser schema
// below. Both cases are spelled out instead of using the `i` flag: the
// published JSON Schema `pattern` carries no flags, so strict clients
// would otherwise reject upper-case ids the server accepts.
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const endpointIdSchema = z
  .string()
  .regex(UUID_PATTERN, "endpoint_id must be a UUID (8-4-4-4-12 hex format).")
  .describe("Endpoint UUID.");

// Looser variant for tools that accept EITHER an Endpoint UUID OR a
// Group ID (when paired with `target_type`). Group IDs may include
// underscores, hyphens, and alphanumerics; we still enforce non-empty
// and a sane character set so a path-traversal "../" or empty string
// can't slip through.
export const endpointOrGroupIdSchema = z
  .string()
  .min(8)
  .regex(/^[A-Za-z0-9._-]+$/, "Must be an Endpoint UUID or a Group ID.")
  .describe("Endpoint UUID, or Group ID when target_type='EndpointGroup'.");

// Every list tool supports both `markdown` (human-readable, token-cheap)
// and `json` (machine-readable, complete) output formats.
export const formatShape = {
  response_format: z
    .enum(["markdown", "json"])
    .optional()
    .describe("Output format. Default markdown."),
};

// Input schemas are strict: `applyToolPolicy` (registry.ts) turns every
// registered `z.object(shape)` into `.strict()`, so an unknown or
// misspelled argument (a typo like `confrim: "YES"`, or a filter the
// tool does not support) fails validation with an "Unrecognized key"
// error instead of being dropped silently. Tool modules keep writing
// plain `z.object(shape)`.

export type OutputFormat = "json" | "markdown";

// Token-budget strategy:
// MCP host behaviour around `structuredContent` is inconsistent - some
// hosts feed it to the model, others (like Claude Desktop) only render
// it in the UI for the user. To stay portable, the data MUST also be
// in the `content[].text` block.
//
// What we control: format of that text. Compact JSON (no indent) is
// ~30-40% smaller than pretty-printed and the model parses both
// equally well. structuredContent stays as a parallel form for hosts
// that drive validation off it (outputSchema).

export function jsonResult(
  rawValue: unknown,
  rawStructured?: Record<string, unknown>,
  format?: OutputFormat,
): CallToolResult {
  // Credential-shaped keys are always masked; ACTION1_REDACT_PII also
  // masks personal data. Both apply to both output channels.
  const pii = piiRedactionEnabled();
  const clean = (v: unknown): unknown => {
    const masked = redactSecretKeys(v);
    return pii ? redactPii(masked) : masked;
  };
  const value = clean(rawValue);
  const structured = rawStructured ? (clean(rawStructured) as Record<string, unknown>) : undefined;
  // Default to markdown for list-shaped responses: markdown is
  // human-readable AND ~30-50% smaller than JSON for typical tabular
  // data. Single-object responses fall through to compact JSON
  // since they don't render as tables anyway.
  const requested = format ?? inferDefaultFormat(value);
  const result = buildResult(value, structured, requested);
  if (jsonByteLength(result) <= RESPONSE_BYTE_BUDGET) return result;
  return shrinkResult(value, structured, requested);
}

function buildResult(
  value: unknown,
  structured: Record<string, unknown> | undefined,
  format: OutputFormat,
): CallToolResult {
  const table = format === "markdown" ? renderMarkdownTable(value)?.text : undefined;
  const text = table ?? toCompactText(value);
  return structured
    ? { content: [{ type: "text", text }], structuredContent: structured }
    : { content: [{ type: "text", text }] };
}

// Room kept free for the `truncation_note` added after shrinking.
const NOTE_RESERVE_BYTES = 2_000;

/**
 * Last-line size guard for any tool result (single objects, script
 * output, raw responses): the serialised result (text + structured)
 * must stay under RESPONSE_BYTE_BUDGET or the host rejects the whole
 * call. Long strings and arrays are cut with visible markers and a
 * `truncation_note` is added to both channels.
 */
function shrinkResult(
  value: unknown,
  structured: Record<string, unknown> | undefined,
  format: OutputFormat,
): CallToolResult {
  const fit = fitToByteBudget(
    { value, structured },
    RESPONSE_BYTE_BUDGET - NOTE_RESERVE_BYTES,
    (pair) => {
      const p = pair as { value: unknown; structured?: Record<string, unknown> };
      return jsonByteLength(buildResult(p.value, p.structured, format));
    },
  );
  const note = fit.note ?? "Response exceeded the size budget and was truncated.";
  const withNote = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v)
      ? { ...(v as Record<string, unknown>), truncation_note: note }
      : v;
  if (fit.value === undefined) {
    const minimal: Record<string, unknown> = { truncation_note: note };
    if (structured && Array.isArray(structured.items)) {
      minimal.items = [];
      minimal.count = 0;
    }
    return buildResult(minimal, structured ? minimal : undefined, "json");
  }
  const shrunk = fit.value as { value: unknown; structured?: Record<string, unknown> };
  return buildResult(
    withNote(shrunk.value),
    shrunk.structured ? (withNote(shrunk.structured) as Record<string, unknown>) : undefined,
    format,
  );
}

function inferDefaultFormat(value: unknown): OutputFormat {
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.items)) return "markdown";
  }
  return "json";
}

function toCompactText(value: unknown): string {
  if (typeof value === "string") return value;
  // JSON.stringify without indent: ~30-40% smaller than pretty-printed
  // for typical Action1 list shapes. The model has no trouble parsing
  // dense JSON.
  return JSON.stringify(value);
}

/**
 * An upstream response echoed into an error text (a start response
 * without an instance id, the last status of a timed-out poll): compact
 * JSON with credential-shaped keys and values masked, and with
 * ACTION1_REDACT_PII also personal data, like every tool result.
 */
export function upstreamBodyText(value: unknown): string {
  const masked = redactSecretKeys(value ?? null);
  return redactString(JSON.stringify(piiRedactionEnabled() ? redactPii(masked) : masked) ?? "null");
}

export function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

/**
 * Like `errorResult` but pairs the error message with an actionable
 * suggestion, so the agent learns how to fix the call, not only what
 * went wrong.
 */
export function actionableError(message: string, suggestion: string): CallToolResult {
  return errorResult(`${message}\n\nSuggestion: ${suggestion}`);
}

export async function runTool(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Action1ApiError) {
      return errorResult(err.toToolErrorText());
    }
    if (err instanceof z.ZodError) {
      // Bubble up validation errors with the offending paths so the
      // agent can fix the args, not just see "validation failed".
      const issues = err.issues
        .map((i) => `  - ${i.path.length ? i.path.join(".") : "<root>"}: ${i.message}`)
        .join("\n");
      return actionableError(
        "Tool input failed validation:\n" + issues,
        "Re-call this tool with the listed paths corrected. Field types and constraints are documented in the tool's input schema.",
      );
    }
    if (err instanceof Error) {
      // Best-effort: a leaf "Aborted" / "AbortError" indicates a timeout
      // or client cancellation. Make that distinction explicit so the
      // agent can decide whether to retry.
      if (err.name === "AbortError") {
        return errorResult(
          "Operation aborted: the client cancelled the request or the server timed out. " +
            "Retry with a longer timeout if appropriate.",
        );
      }
      return errorResult(err.message);
    }
    return errorResult(String(err));
  }
}

/**
 * Narrow `unknown` to `Record<string, unknown>`. Used by tool handlers
 * that accept the upstream API response (typed `unknown` for safety)
 * and need to embed it in `structuredContent` without a blind cast.
 *
 * Returns an empty object when the input isn't a plain object - that
 * keeps the shape consistent so the SDK's outputSchema validation
 * won't surface arrays / strings / nulls as structured content.
 */
export function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * Notes about per-item compaction. Tools without a `verbose` parameter
 * get the variant that does not mention it: strict input validation
 * would reject the argument, so the hint could never be followed.
 */
export const COMPACTED_NOTE =
  "Per-item heavy fields (embedded scripts, full CVE walls, EULAs) were compacted to keep the host context small. Pass `verbose: true` to receive the raw upstream records.";
const COMPACTED_NOTE_NO_PARAM =
  "Per-item heavy fields (embedded scripts, full CVE walls, EULAs) were compacted to keep the host context small. Fetch a single record by id for its full form.";

/**
 * `verbose` of a list helper: `true` / `false` for a tool that has the
 * parameter (raw records requested or not), `undefined` for a tool that
 * does not have it.
 */
export type VerboseFlag = boolean | undefined;

/** Markers `compactItem` (utils/capOutput.ts) leaves in a value it shortened. */
const COMPACTION_MARKER = /chars truncated\)|\[truncated: /;

function wasCompacted(items: unknown[]): boolean {
  return COMPACTION_MARKER.test(JSON.stringify(items) ?? "");
}

/** The compaction note for these returned items, or undefined when nothing was compacted. */
export function compactionNote(items: unknown[], verbose: VerboseFlag): string | undefined {
  if (verbose === true || !wasCompacted(items)) return undefined;
  return verbose === false ? COMPACTED_NOTE : COMPACTED_NOTE_NO_PARAM;
}

const CAPPED_NOTE =
  "Output truncated to fit the 1 MB host limit. Refine via `limit` / a more specific filter / a per-id getter to see the rest.";

/** Note on a list page with `has_more: true`. */
export const MORE_DATA_NOTE =
  "More data available. Call this tool again with `cursor` set to `next_cursor` to fetch the next page; concatenate `items` across pages to get the full list. Repeat until `has_more` is false.";

const joinNotes = (...notes: (string | undefined)[]): string | undefined => {
  const present = notes.filter((n): n is string => typeof n === "string" && n.length > 0);
  return present.length ? present.join(" ") : undefined;
};

function cappedPayload(cap: CapResult<unknown>, verbose: VerboseFlag): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    items: cap.items,
    count: cap.returned,
    total: cap.total,
  };
  if (cap.truncated > 0) payload.truncated = cap.truncated;
  const note = joinNotes(
    cap.truncated > 0 ? CAPPED_NOTE : undefined,
    cap.note,
    compactionNote(cap.items, verbose),
  );
  if (note !== undefined) payload.note = note;
  return payload;
}

/**
 * List result for a complete in-memory list: caps the items list at ~400 KB to fit the 1 MB MCP-host limit. Adds
 * a truncation note when capping fires. Always emits `total` (the full
 * length of `rawItems`) so the agent can decide whether to refine the
 * query.
 *
 * Per-item compactor: unless `verbose` is true, `compactItem` runs over
 * each entry to truncate embedded scripts / EULAs / 100-CVE walls. This
 * guards the host context budget against single-tool-call blow-ups.
 * `verbose` is undefined for tools without that parameter (see
 * VerboseFlag); the note then does not suggest it.
 *
 * Use for every curated non-paginated list tool. For single-object
 * responses use the regular jsonResult.
 */
export function cappedListResult(
  rawItems: unknown[],
  format?: OutputFormat,
  verbose?: VerboseFlag,
): CallToolResult {
  const projected = verbose === true ? rawItems : rawItems.map((it) => compactItem(it));
  const payload = cappedPayload(capItemList(projected), verbose);
  return jsonResult(payload, payload, format);
}

/**
 * Streaming form of `cappedListResult`: consumes a paginated source and
 * keeps only the records that fit the budget in memory, while still
 * counting the rest for an exact `total`.
 */
export async function cappedListResultFromStream(
  source: AsyncIterable<unknown>,
  format?: OutputFormat,
  verbose?: VerboseFlag,
): Promise<CallToolResult> {
  const cap = await capItemStream(source, {
    project: verbose === true ? (it) => it : (it) => compactItem(it),
  });
  const payload = cappedPayload(cap, verbose);
  return jsonResult(payload, payload, format);
}

export interface PagedListInput {
  items: unknown[];
  count: number;
  next_cursor: string | null;
  has_more: boolean;
  total_estimate?: number;
  /** Real total of the walk (set by pagedFetch on the final page). */
  total?: number;
  note?: string;
  /** Cursor resuming after the first k items (from pagedFetch). */
  resumeAfter?: (k: number) => string;
}

/**
 * Drop-in for paginated list tools using cursor pagination. The agent
 * walks all pages by feeding `next_cursor` back; the server emits
 * `has_more: false` and `next_cursor: null` once the upstream is
 * exhausted.
 *
 * The page is shortened to what the chosen output format can carry and
 * `next_cursor` moves to the first item that was not returned:
 *   - markdown (the default): the rows the table can render within
 *     CHARACTER_LIMIT, so text-only hosts never skip rows;
 *   - json: what fits RESPONSE_BYTE_BUDGET with both the text and the
 *     structured copy.
 *
 * `total` is only emitted when it is the real total of the walk (final
 * page, from pagedFetch) or an upstream estimate while walking.
 *
 * `verbose` (see VerboseFlag) decides the compaction note: it appears
 * only when a returned item was compacted, and names `verbose` only
 * for tools that have it. `extra` fields are added to both output
 * channels.
 */
export function pagedListResult(
  result: PagedListInput,
  format?: OutputFormat,
  verbose?: VerboseFlag,
  extra?: Record<string, unknown>,
): CallToolResult {
  const effective: OutputFormat = format ?? "markdown";
  const build = (k: number): Record<string, unknown> => {
    const shortened = k < result.items.length;
    const hasMore = shortened || result.has_more;
    const payload: Record<string, unknown> = {
      items: shortened ? result.items.slice(0, k) : result.items,
      count: k,
      has_more: hasMore,
      next_cursor: shortened && result.resumeAfter ? result.resumeAfter(k) : result.next_cursor,
    };
    if (!hasMore && typeof result.total === "number") {
      payload.total = result.total;
    } else if (hasMore && typeof result.total_estimate === "number") {
      payload.total = result.total_estimate;
    }
    const note = joinNotes(
      hasMore ? MORE_DATA_NOTE : undefined,
      result.note,
      compactionNote(payload.items as unknown[], verbose),
    );
    if (note !== undefined) payload.note = note;
    if (extra) Object.assign(payload, extra);
    return payload;
  };

  let k = result.items.length;
  if (result.resumeAfter && k > 1) {
    if (effective === "markdown") {
      // Shrink until the table renders every row of the page. Each pass
      // can only lower k and at least one row is always rendered.
      for (;;) {
        const rows = renderMarkdownTable(build(k))?.rows ?? k;
        if (rows >= k) break;
        k = rows;
      }
    } else {
      k = fitItemsToWire(result.items, k, (n) => {
        const payload = build(n);
        return jsonByteLength(buildResult(payload, payload, "json"));
      });
    }
  }
  const payload = build(k);
  return jsonResult(payload, payload, effective);
}

/**
 * Largest item count n <= k whose JSON result fits RESPONSE_BYTE_BUDGET.
 * Starts from a per-item cost estimate (structured copy + escaped text
 * copy) and verifies against the real serialisation.
 */
function fitItemsToWire(items: unknown[], k: number, measure: (n: number) => number): number {
  if (measure(k) <= RESPONSE_BYTE_BUDGET) return k;
  let used = measure(0);
  let n = 0;
  while (n < k) {
    const s = JSON.stringify(items[n]) ?? "null";
    const cost = Buffer.byteLength(s, "utf8") + Buffer.byteLength(JSON.stringify(s), "utf8");
    if (used + cost + 2 > RESPONSE_BYTE_BUDGET) break;
    used += cost + 2;
    n += 1;
  }
  n = Math.max(n, 1);
  while (n > 1 && measure(n) > RESPONSE_BYTE_BUDGET) n = Math.max(1, Math.floor(n * 0.95));
  return n;
}
