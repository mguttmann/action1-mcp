import type { Action1Client } from "../../client/action1Client.js";
import { runDestructive } from "../destructiveGuard.js";
import {
  errorResult,
  jsonResult,
  pagedListResult,
  type OutputFormat,
} from "../helpers.js";
import { Action1ApiError } from "../../client/errors.js";
import { capItemList, compactItem } from "../../utils/capOutput.js";
import { fingerprintQuery, pagedFetch } from "../../utils/cursor.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface RunGeneratedOptions {
  client: Action1Client;
  toolName: string;
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  queryParams?: Record<string, unknown> | undefined;
  body?: Record<string, unknown> | undefined;
  autoPaginate?: boolean;
  cursor?: string | undefined;
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
   * unaffected — the agent rarely fetches a single record without
   * needing its full body.
   */
  verbose?: boolean | undefined;
  signal?: AbortSignal;
}

export async function runGenerated(opts: RunGeneratedOptions): Promise<CallToolResult> {
  try {
    const perform = async (): Promise<CallToolResult> => {
      // GET tools with `cursor` set, OR auto_paginate=true, drive through
      // pagedFetch so the agent can chain multiple calls to cover any
      // fleet size. Single-call mode (no cursor, no auto_paginate) stays
      // the regular request path.
      if (opts.method === "GET" && (opts.autoPaginate || opts.cursor)) {
        const callerLimit = opts.queryParams ? toFiniteNumber(opts.queryParams.limit) : undefined;
        const queryWithoutPagination = opts.queryParams
          ? stripPagination(opts.queryParams)
          : undefined;
        const fp = fingerprintQuery({ path: opts.path, query: queryWithoutPagination ?? {} });
        const result = await pagedFetch<unknown>(
          async ({ from, limit }) => {
            const raw = (await opts.client.request<unknown>(opts.path, {
              method: "GET",
              query: { ...(queryWithoutPagination ?? {}), limit, from },
              ...(opts.signal ? { signal: opts.signal } : {}),
            })) as { items?: unknown[] } | unknown[];
            const rawItems = Array.isArray(raw) ? raw : (raw.items ?? []);
            // Same per-item compactor as the single-call path: when
            // `verbose !== true`, trim embedded scripts / EULAs / CVE
            // walls before they accumulate across pages. Otherwise
            // auto_paginate would silently bypass the size guard that
            // the non-paginated path enforces.
            const items = opts.verbose === true
              ? rawItems
              : rawItems.map((it) => compactItem(it));
            return { items, hasMore: rawItems.length === limit };
          },
          {
            ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
            fingerprint: fp,
            ...(callerLimit !== undefined ? { maxItems: callerLimit } : {}),
          },
        );
        return pagedListResult(result, opts.responseFormat, opts.verbose);
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
      if (Array.isArray(data)) {
        return cappedItemsResult(data, opts.responseFormat, opts.verbose);
      }
      if (isObject(data) && Array.isArray(data.items)) {
        const obj = data;
        const rawItems = obj.items as unknown[];
        // Per-item compactor (verbose=false default) trims embedded
        // scripts / EULAs / 100-CVE walls before the size cap kicks
        // in, otherwise a single 50 KB list item burns through the
        // host context after one or two calls.
        const items = opts.verbose
          ? rawItems
          : rawItems.map((it) => compactItem(it));
        const cap = capItemList(items as Record<string, unknown>[]);
        // `count` is required by listOutputShape — it MUST be set on
        // every response, not just on truncated ones. The structured
        // validator otherwise rejects the call with "must have required
        // property 'count'". Same bug class as the singleObjectOutputShape
        // production miss: schema and emitter were silently out of sync.
        const payload: Record<string, unknown> = {
          ...obj,
          items: cap.items,
          count: cap.returned,
        };
        if (cap.truncated > 0) {
          payload.total = cap.total;
          payload.truncated = cap.truncated;
          payload.note =
            "Output truncated to fit the 1 MB host limit. Re-call with `cursor` set + `auto_paginate: true` to walk all pages.";
        } else if (!opts.verbose) {
          payload.note =
            "Per-item heavy fields (embedded scripts, full CVE walls, EULAs) were compacted to keep the host context small. Pass `verbose: true` to receive the raw upstream records.";
        }
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
  } catch (err) {
    if (err instanceof Action1ApiError) {
      return errorResult(err.toToolErrorText());
    }
    if (err instanceof Error) {
      return errorResult(err.message);
    }
    return errorResult(String(err));
  }
}

function cappedItemsResult(
  items: unknown[],
  format?: OutputFormat,
  verbose?: boolean,
): CallToolResult {
  const projected = verbose ? items : items.map((it) => compactItem(it));
  const cap = capItemList(projected as Record<string, unknown>[]);
  const payload: Record<string, unknown> = { items: cap.items, count: cap.returned };
  if (cap.truncated > 0) {
    payload.total = cap.total;
    payload.truncated = cap.truncated;
    payload.note =
      "Output truncated to fit the 1 MB host limit. Refine via `limit` / a more specific filter / a per-id getter.";
  } else if (!verbose) {
    payload.note =
      "Per-item heavy fields (embedded scripts, full CVE walls, EULAs) were compacted to keep the host context small. Pass `verbose: true` to receive the raw upstream records.";
  }
  return jsonResult(payload, payload, format);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function stripPagination(q: Record<string, unknown>): Record<string, string | number | boolean | undefined> {
  const out: Record<string, string | number | boolean | undefined> = {};
  for (const [k, v] of Object.entries(q)) {
    if (k === "limit" || k === "from" || k === "auto_paginate") continue;
    out[k] = toQueryValue(v);
  }
  return out;
}

function stripUndefined(q: Record<string, unknown>): Record<string, string | number | boolean | undefined> {
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
