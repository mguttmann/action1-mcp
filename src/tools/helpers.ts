import { z } from "zod";
import { Action1ApiError } from "../client/errors.js";
import { maybeRenderMarkdownTable } from "../utils/markdownTable.js";
import { capItemList, compactItem } from "../utils/capOutput.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Reusable output schemas for the curated read tools.
//
// All output schemas are registered as full ZodObjects with
// .passthrough() — NOT raw shapes. Reason: when a raw shape is wrapped
// internally by the SDK as `z.object(shape)`, the generated JSON schema
// gets `additionalProperties: false` and the structured-content
// validator rejects any extra key the upstream API surfaces. The
// upstream Action1 envelope varies (some endpoints add `next`, `total`,
// fields the agent actually wants to read), and a constrained shape
// would block them all.
//
// Required fields stay required, extras pass through. This is the same
// fix that production-bug-Pass-3 caught for `singleObjectOutputShape`
// and `okStatusOutputShape`; we apply it preventively to the list
// shapes too — same bug class, just hadn't fired yet.
export const listOutputShape = z
  .object({
    items: z.array(z.record(z.unknown())),
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
// reject every non-cursor call against these tools — same Pass-3
// production-bug class.
export const cursorListOutputShape = z
  .object({
    items: z.array(z.record(z.unknown())),
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
  limit: z.number().int().min(1).max(50000).optional().describe("Max items."),
};

// Output schema for single-object responses. Registered as a full
// ZodObject (.passthrough()) — NOT a ZodRawShape — so the SDK's
// structuredContent validator emits `additionalProperties: true`.
// The upstream Action1 payload varies per endpoint, and a constrained
// shape would reject any extra field the agent legitimately needs.
//
// Why .passthrough() and not z.record(z.unknown()):
// the SDK's `normalizeObjectSchema` accepts either a raw shape
// (Record<string, ZodSchema>) or a ZodObject; a ZodRecord falls
// through both branches and yields `undefined`, which crashes the
// register path with "Cannot read properties of undefined (reading
// '_zod')". A passthrough ZodObject keeps registration happy AND
// admits arbitrary keys at validation time.
//
// Production bug Pass 3 missed: a curated counter response like
// `{ total, by_status, by_platform, ... }` was rejected by the prior
// `{ data: z.record(z.unknown()).optional() }` shape because it had
// keys other than `data`. Going wide-open is the right tradeoff: the
// schema advertises "this is a single object", not every upstream key.
export const singleObjectOutputShape = z.object({}).passthrough();

// Output schema for destructive operations (POST/PATCH/PUT/DELETE).
// Same rationale as singleObjectOutputShape: the dry-run preview emits
// `{ dry_run, tool, would_send }` while the live path returns whatever
// the upstream API hands back — both have keys that a constrained shape
// would reject. Permissive ZodObject (.passthrough()) keeps the SDK
// registration happy and admits arbitrary keys at validation time.
export const okStatusOutputShape = z.object({}).passthrough();

export const orgIdShape = {
  org_id: z.string().min(1).optional().describe("Org UUID."),
};

// Strict UUID — for tools that only accept a single endpoint (no
// `target_type: "EndpointGroup"` argument). Action1's endpoint IDs are
// canonical UUIDv4 strings (lowercase hex, 4 dashes). Group IDs use a
// different format ("New_Endpoints_<uuid>") and need the looser schema
// below.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

// Per the MCP-builder skill best practice, every list tool should
// support both `markdown` (human-readable, token-cheap) and `json`
// (machine-readable, complete) output formats.
export const formatShape = {
  response_format: z
    .enum(["markdown", "json"])
    .optional()
    .describe("Output format. Default markdown."),
};

// Note on `.strict()` — the MCP-builder skill recommends `.strict()`
// on every tool's input schema so unknown fields surface as validation
// errors rather than getting silently dropped. The SDK's `registerTool`
// API accepts either a `ZodRawShape` (typed handler args, non-strict)
// or a full `ZodTypeAny` (handler receives `unknown`, strict honoured).
//
// We use the shape form because the typed-args ergonomics matter for a
// surface this size; the trade-off is that an unknown field like a
// typo'd `confrim: "YES"` is silently dropped instead of erroring. In
// practice this is harmless: the destructive guard's per-call check is
// against the *actual* `confirm` (which is then `undefined`), so the
// guard fires correctly. The risk is reduced agent-DX: a typo'd field
// name produces a stale "missing field" error rather than "unknown
// field 'confrim'".
//
// If you want strict on a specific tool, pass
// `inputSchema: z.object(shape).strict()` at the registration site and
// downcast args inside the handler to `z.infer<typeof schema>`.

export type OutputFormat = "json" | "markdown";

// Token-budget strategy:
// MCP host behaviour around `structuredContent` is inconsistent — some
// hosts feed it to the model, others (like Claude Desktop) only render
// it in the UI for the user. To stay portable, the data MUST also be
// in the `content[].text` block.
//
// What we control: format of that text. Compact JSON (no indent) is
// ~30-40% smaller than pretty-printed and the model parses both
// equally well. structuredContent stays as a parallel form for hosts
// that drive validation off it (outputSchema).

export function jsonResult(
  value: unknown,
  structured?: Record<string, unknown>,
  format?: OutputFormat,
): CallToolResult {
  // Default to markdown for list-shaped responses (skill best practice:
  // markdown is human-readable AND ~30-50% smaller than JSON for typical
  // tabular data). Single-object responses fall through to compact JSON
  // since they don't render as tables anyway.
  const requested = format ?? inferDefaultFormat(value);
  let text: string;
  if (requested === "markdown") {
    const table = maybeRenderMarkdownTable(value, { format: "markdown" });
    text = table ?? toCompactText(value);
  } else {
    text = toCompactText(value);
  }
  return structured
    ? { content: [{ type: "text", text }], structuredContent: structured }
    : { content: [{ type: "text", text }] };
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


export function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

/**
 * Like `errorResult` but pairs the error message with an actionable
 * suggestion. Skill best-practice: every error response should guide
 * the agent toward a fix, not just describe what went wrong.
 */
export function actionableError(message: string, suggestion: string): CallToolResult {
  return errorResult(`${message}\n\nSuggestion: ${suggestion}`);
}

export async function runTool(
  fn: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
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

export function asStructured<T>(items: T[]): Record<string, unknown> {
  return { items, count: items.length };
}

/**
 * Narrow `unknown` to `Record<string, unknown>`. Used by tool handlers
 * that accept the upstream API response (typed `unknown` for safety)
 * and need to embed it in `structuredContent` without a blind cast.
 *
 * Returns an empty object when the input isn't a plain object — that
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
 * Drop-in replacement for `jsonResult(items, asStructured(items))` that
 * caps the items list at ~400 KB to fit the 1 MB MCP-host limit. Adds
 * a truncation note when capping fires. Always emits `total` so the
 * agent can decide whether to refine the query.
 *
 * Per-item compactor: by default we run `compactItem` over each entry
 * to truncate embedded scripts / EULAs / 100-CVE walls. This guards
 * the host context budget against single-tool-call blow-ups. Pass
 * `verbose: true` to skip the compactor and return the raw upstream
 * objects.
 *
 * Use for every curated list-tool. For single-object responses use the
 * regular jsonResult.
 */
export function cappedListResult(
  rawItems: unknown[],
  format?: OutputFormat,
  verbose = false,
): CallToolResult {
  const projected = verbose
    ? rawItems
    : rawItems.map((it) => compactItem(it));
  const cap = capItemList(projected as Record<string, unknown>[]);
  if (cap.truncated > 0) {
    // Pass-4 Operational #7: prefer the specific note from capItemList
    // (e.g. "single record exceeded byte cap, see __truncated_item
    // placeholder") over the generic "output truncated" message. The
    // specific note tells the agent WHY truncation happened and
    // suggests the right fix (per-record get-by-id vs. tighter filter).
    const note =
      cap.note ??
      "Output truncated to fit the 1 MB host limit. Refine via `limit` / a more specific filter / a per-id getter to see the rest. (Per-item heavy fields like embedded scripts / EULAs are also compacted by default — pass `verbose: true` to disable.)";
    const payload = {
      items: cap.items,
      count: cap.returned,
      total: cap.total,
      truncated: cap.truncated,
      note,
    };
    return jsonResult(payload, payload, format);
  }
  const payload: Record<string, unknown> = {
    items: cap.items,
    count: cap.returned,
    total: cap.total,
  };
  if (!verbose) {
    payload.note =
      "Per-item heavy fields (embedded scripts, full CVE walls, EULAs) were compacted to keep the host context small. Pass `verbose: true` to receive the raw upstream records.";
  }
  return jsonResult(payload, payload, format);
}

/**
 * Drop-in for paginated list tools using cursor pagination. The agent
 * walks all pages by feeding `next_cursor` back; the server emits
 * `has_more: false` and `next_cursor: null` once the upstream is
 * exhausted. Each call returns at most ~400 KB of items so the wire
 * response stays under the 1 MB host limit.
 *
 * The optional `verbose` flag mirrors `cappedListResult`: when the
 * caller did NOT opt into verbose mode, the runtime applied the
 * per-item compactor pre-pagination, so we surface that fact via the
 * note so the agent knows heavy fields (scripts / EULAs / CVE walls)
 * were trimmed and can re-fetch with `verbose: true` if needed.
 */
export function pagedListResult(
  result: {
    items: unknown[];
    count: number;
    next_cursor: string | null;
    has_more: boolean;
    total_estimate?: number;
  },
  format?: OutputFormat,
  verbose?: boolean,
): CallToolResult {
  // `total` policy: terminal pages MUST emit an authoritative total
  // (the count is the truth — we just walked the whole list). For
  // mid-walk pages, an upstream `total_estimate` can be surfaced as
  // a hint. When neither applies, `total` is omitted (the agent
  // must paginate to learn the total).
  //
  // Pass-3 audit found a regression: when both `total_estimate` and
  // `has_more=false` were set, the estimate was preferred over the
  // actual count — confusing if the estimate disagreed with the
  // visible count. The terminal page's count is always authoritative
  // and wins.
  const payload: Record<string, unknown> = {
    items: result.items,
    count: result.count,
    has_more: result.has_more,
    next_cursor: result.next_cursor,
  };
  if (!result.has_more) {
    payload.total = result.count;
  } else if (typeof result.total_estimate === "number") {
    payload.total = result.total_estimate;
  }
  // Note precedence: the "more data available" hint wins over the
  // verbose-compacted hint when both apply — the agent needs the
  // pagination instruction first. When the upstream is exhausted
  // AND the compactor ran, surface the verbose-toggle hint instead.
  if (result.has_more) {
    payload.note =
      "More data available. Call this tool again with `cursor` set to `next_cursor` to fetch the next page; concatenate `items` across pages to get the full list. Repeat until `has_more` is false.";
  } else if (verbose !== true) {
    payload.note =
      "Per-item heavy fields (embedded scripts, full CVE walls, EULAs) were compacted to keep the host context small. Pass `verbose: true` to receive the raw upstream records.";
  }
  return jsonResult(payload, payload, format);
}
