// Hand-written runtime shared by every auto-generated tool. NOT generated:
// `npm run codegen` writes only ./index.ts in this directory and never
// touches this file. Edit it like any other source file.
import { assertSafeApiPath, type Action1Client } from "../../client/action1Client.js";
import { runDestructive } from "../destructiveGuard.js";
import {
  cappedListResult,
  compactionNote,
  jsonResult,
  pagedListResult,
  runTool,
} from "../helpers.js";
import type { OutputFormat } from "../helpers.js";
import { assertPayloadOrgsAllowed } from "../orgScope.js";
import { envelopePage, parsePageEnvelope } from "../../client/pagination.js";
import { capItemList, compactItem } from "../../utils/capOutput.js";
import { buildCursor, fingerprintQuery, pagedFetch } from "../../utils/cursor.js";
import type { CallToolResult } from "@modelcontextprotocol/server";

export interface RunGeneratedOptions {
  client: Action1Client;
  toolName: string;
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  queryParams?: Record<string, unknown> | undefined;
  body?: unknown;
  autoPaginate?: boolean;
  cursor?: string | undefined;
  /**
   * The operation pages with `limit` / `from`. Every call of such a tool
   * reports `has_more` and `next_cursor`, with or without `cursor`.
   */
  paginated?: boolean;
  destructive?: { confirm?: "YES" | undefined; dry_run?: boolean | undefined } | undefined;
  /**
   * Optional output-format hint. When set, list-shaped responses will be
   * rendered as a Markdown table ("markdown") or as compact JSON ("json").
   * Single-object responses are always emitted as compact JSON.
   * Default: undefined (helpers.ts inferDefaultFormat picks per shape).
   */
  responseFormat?: OutputFormat | undefined;
  /**
   * When true, skip the per-item compactor and emit raw upstream
   * records. Default false: list-shaped responses are compacted to
   * truncate embedded scripts / EULAs / huge CVE strings before
   * `capItemList` measures them. Single-object responses are
   * unaffected - the agent rarely fetches a single record without
   * needing its full body.
   */
  verbose?: boolean | undefined;
  signal?: AbortSignal;
}

/**
 * Execute one generated tool call. Errors are mapped to tool results by
 * the shared `runTool`, so generated and curated tools report failures
 * the same way.
 */
export async function runGenerated(opts: RunGeneratedOptions): Promise<CallToolResult> {
  return runTool(async () => {
    // Reject empty IDs and dot segments before the destructive guard, so
    // a dry-run preview never shows a path that would be retargeted.
    assertSafeApiPath(opts.path);
    // Org ids inside the body (target_organization_id, organization_ids,
    // ...) are held to ACTION1_ALLOWED_ORG_IDS like the org_id argument.
    assertPayloadOrgsAllowed(opts.body);
    const perform = async (): Promise<CallToolResult> => {
      // List contract of paginated GET tools: `limit` is the most items
      // one call returns, `from` the first record when no cursor is
      // given, and every call reports `has_more` / `next_cursor`. With
      // `cursor` or `auto_paginate` the call walks upstream pages
      // (pagedFetch) until `limit` or the response budget; without them
      // it returns one upstream page (below).
      const callerLimit = opts.queryParams ? toFiniteNumber(opts.queryParams.limit) : undefined;
      const callerFrom = opts.queryParams ? toFiniteNumber(opts.queryParams.from) : undefined;
      const queryWithoutPagination = opts.queryParams
        ? stripPagination(opts.queryParams)
        : undefined;
      const fingerprint = (): string =>
        fingerprintQuery({ path: opts.path, query: queryWithoutPagination ?? {} });
      if (opts.method === "GET" && (opts.autoPaginate || opts.cursor)) {
        const result = await pagedFetch<unknown>(
          async ({ from, limit }) => {
            const raw = await opts.client.request<unknown>(opts.path, {
              method: "GET",
              query: { ...(queryWithoutPagination ?? {}), limit, from },
              ...(opts.signal ? { signal: opts.signal } : {}),
            });
            const page = envelopePage<unknown>(raw, from, limit);
            // Same per-item compactor as the single-call path: when
            // `verbose !== true`, trim embedded scripts / EULAs / CVE
            // walls before they accumulate across pages. Otherwise
            // auto_paginate would silently bypass the size guard that
            // the non-paginated path enforces.
            return opts.verbose === true
              ? page
              : { ...page, items: page.items.map((it) => compactItem(it)) };
          },
          {
            ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
            ...(callerFrom !== undefined ? { startFrom: callerFrom } : {}),
            fingerprint: fingerprint(),
            ...(callerLimit !== undefined
              ? { maxItems: callerLimit, pageSize: Math.min(Math.max(1, callerLimit), 200) }
              : {}),
          },
        );
        return pagedListResult(result, opts.responseFormat, opts.verbose === true);
      }
      const data = await opts.client.request<unknown>(opts.path, {
        method: opts.method,
        ...(opts.queryParams ? { query: stripUndefined(opts.queryParams) } : {}),
        ...(opts.body !== undefined ? { body: opts.body } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      // Apply a defensive cap to single-call responses that look
      // list-shaped (Action1 uses {items: [...]} envelopes and bare
      // arrays interchangeably). The agent can switch to cursor mode
      // by re-calling with `cursor: <returned next_cursor>` if any.
      // `limit` is the most items one call returns, also when the
      // upstream sends more than asked for.
      const overLimit = (items: unknown[]): boolean =>
        callerLimit !== undefined && items.length > callerLimit;
      if (Array.isArray(data) && !opts.paginated && !overLimit(data)) {
        return cappedListResult(data, opts.responseFormat, opts.verbose === true);
      }
      if (Array.isArray(data) || (isObject(data) && Array.isArray(data.items))) {
        const obj: Record<string, unknown> = Array.isArray(data) ? { items: data } : data;
        const upstreamItems = obj.items as unknown[];
        const limited = overLimit(upstreamItems);
        const rawItems = limited ? upstreamItems.slice(0, callerLimit) : upstreamItems;
        // Per-item compactor (verbose=false default) trims embedded
        // scripts / EULAs / 100-CVE walls before the size cap kicks
        // in, otherwise a single 50 KB list item burns through the
        // host context after one or two calls.
        const items = opts.verbose ? rawItems : rawItems.map((it) => compactItem(it));
        const cap = capItemList(items as Record<string, unknown>[]);
        if (opts.paginated) {
          // One upstream page: more exists when the envelope (or a full
          // page) says so, or when the size cap cut this page. The page
          // goes through pagedListResult like the cursor path, so a
          // Markdown table that cannot show every row ends the page
          // there and next_cursor resumes at the first row not shown.
          const from = callerFrom ?? 0;
          const page = envelopePage<unknown>(
            data,
            from,
            callerLimit ?? parsePageEnvelope<unknown>(data).limit ?? Number.POSITIVE_INFINITY,
          );
          const hasMore = cap.truncated > 0 || page.hasMore || limited;
          const resumeAfter = (k: number): string =>
            buildCursor(from + k, fingerprint(), from === 0 ? k : undefined);
          const envelope: Record<string, unknown> = { ...obj };
          for (const k of ["items", "count", "has_more", "next_cursor", "note"]) delete envelope[k];
          if (cap.truncated > 0) {
            envelope.total = cap.total;
            envelope.truncated = cap.truncated;
          }
          return pagedListResult(
            {
              items: cap.items,
              count: cap.returned,
              has_more: hasMore,
              next_cursor: hasMore ? resumeAfter(cap.returned) : null,
              resumeAfter,
            },
            opts.responseFormat,
            opts.verbose === true,
            envelope,
          );
        }
        // `count` is required by listOutputShape, so it is set on every
        // response, not just on truncated ones; the structured-content
        // validator rejects a list payload without it.
        const payload: Record<string, unknown> = {
          ...obj,
          items: cap.items,
          count: cap.returned,
        };
        // Generated read tools have the `verbose` parameter.
        const compacted = compactionNote(cap.items, opts.verbose === true);
        if (cap.truncated > 0) {
          payload.total = cap.total;
          payload.truncated = cap.truncated;
        }
        if (limited) payload.total = upstreamItems.length;
        const notes = [
          cap.truncated > 0 ? TRUNCATED_NOTE : undefined,
          limited
            ? `Returned the first ${callerLimit} of ${upstreamItems.length} items (limit).`
            : undefined,
          compacted,
        ].filter((n): n is string => n !== undefined);
        if (notes.length > 0) payload.note = notes.join(" ");
        return jsonResult(payload, payload, opts.responseFormat);
      }
      const structured = isObject(data) ? data : { value: data };
      return jsonResult(data, structured, opts.responseFormat);
    };

    if (opts.destructive) {
      return await runDestructive(
        opts.destructive,
        {
          toolName: opts.toolName,
          preview: {
            method: opts.method,
            path: opts.path,
            ...(opts.body !== undefined ? { body: opts.body } : {}),
          },
        },
        perform,
      );
    }
    return await perform();
  });
}

const TRUNCATED_NOTE =
  "Output truncated to fit the 1 MB host limit. Narrow the request with `limit` or a filter.";

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function stripPagination(
  q: Record<string, unknown>,
): Record<string, string | number | boolean | undefined> {
  const out: Record<string, string | number | boolean | undefined> = {};
  for (const [k, v] of Object.entries(q)) {
    if (k === "limit" || k === "from" || k === "auto_paginate") continue;
    out[k] = toQueryValue(v);
  }
  return out;
}

function stripUndefined(
  q: Record<string, unknown>,
): Record<string, string | number | boolean | undefined> {
  const out: Record<string, string | number | boolean | undefined> = {};
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined) continue;
    out[k] = toQueryValue(v);
  }
  return out;
}

function toQueryValue(v: unknown): string | number | boolean | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.join(",");
  return JSON.stringify(v);
}

function toFiniteNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
