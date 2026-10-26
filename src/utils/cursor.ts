// Cursor-based pagination for list-shaped tools.
//
// Wire format: a base64-encoded JSON object `{ from, q?, n? }`.
//   - `from`: upstream offset of the next raw record to examine.
//   - `q`: fingerprint of the query parameters. When the tool passes a
//     fingerprint, a cursor must carry the same one or it is rejected, so
//     a cursor from one query can never be combined with another filter.
//   - `n`: number of items already returned by earlier calls of this
//     walk. It lets the final page report the real `total`.
//
// A cursor that cannot be parsed, or that belongs to another query, is
// rejected with a `CursorError`; it never silently restarts at offset 0
// (that produced duplicates or endless loops for agents).

import { createHash } from "node:crypto";
import { WIRE_LIMIT_BYTES } from "../constants.js";
import { jsonByteLength, oversizePlaceholder } from "./capOutput.js";

/** Decoded cursor; see the wire format above. */
export interface CursorPayload {
  from: number;
  q?: string;
  n?: number;
}

/** A caller passed a cursor that is malformed or belongs to another query. */
export class CursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorError";
  }
}

/**
 * Encode a cursor: `from` is the upstream offset to resume at,
 * `fingerprint` the `fingerprintQuery` of the call's arguments and
 * `emitted` the number of items earlier calls of the walk returned.
 */
export function buildCursor(from: number, fingerprint?: string, emitted?: number): string {
  const payload: CursorPayload = { from };
  if (fingerprint !== undefined) payload.q = fingerprint;
  if (emitted !== undefined) payload.n = emitted;
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/**
 * Decode a cursor without checking its query; undefined when it is not
 * a cursor of this server. Tools call `resolveCursor`, which also checks
 * the fingerprint and throws `CursorError`.
 */
export function parseCursor(cursor: string): CursorPayload | undefined {
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf8");
    const obj = JSON.parse(decoded) as Record<string, unknown>;
    if (!obj || typeof obj !== "object" || !isCount(obj.from)) return undefined;
    const out: CursorPayload = { from: obj.from };
    if (typeof obj.q === "string") out.q = obj.q;
    if (isCount(obj.n)) out.n = obj.n;
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Parse and validate a caller-supplied cursor. Throws `CursorError` for
 * a cursor that is not one of ours or that was issued for a different
 * query (`fingerprint`).
 */
export function resolveCursor(cursor: string, fingerprint: string | undefined): CursorPayload {
  const parsed = parseCursor(cursor);
  if (!parsed) {
    throw new CursorError(
      "Invalid cursor: it is not a `next_cursor` value issued by this server (truncated, edited or from another tool). " +
        "Pass the exact `next_cursor` string from the previous response, or omit `cursor` to start from the first page.",
    );
  }
  if (fingerprint !== undefined && parsed.q !== fingerprint) {
    throw new CursorError(
      "Cursor fingerprint mismatch: the cursor was issued for a different tool or set of query parameters. " +
        "Re-use the cursor only with the exact same arguments, or omit `cursor` to start over.",
    );
  }
  return parsed;
}

export function fingerprintQuery(query: Record<string, unknown>): string {
  const normalised = Object.keys(query)
    .filter((k) => query[k] !== undefined && k !== "cursor" && k !== "limit")
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = query[k];
      return acc;
    }, {});
  // 16 hex chars = 64 bits of entropy: a 50% collision probability
  // (birthday bound) needs ~4 billion cursors. 48 bits would reach it
  // at ~16M.
  return createHash("sha256").update(JSON.stringify(normalised)).digest("hex").slice(0, 16);
}

export interface PagedFetchResult<T> {
  items: T[];
  count: number;
  next_cursor: string | null;
  has_more: boolean;
  total_estimate?: number;
  /**
   * Number of items across the whole walk. Only set on the final page
   * (`has_more: false`) and only when the cursor chain carried the
   * running count, so it is always the real total, never a page count.
   */
  total?: number;
  /** Set when an oversize item was replaced by a placeholder. */
  note?: string;
  /**
   * Cursor that resumes right after the first `k` returned items. Used
   * to shorten a page (e.g. to the rows a Markdown table could render)
   * without losing the rest.
   */
  resumeAfter: (k: number) => string;
}

export interface PagedFetchOptions<R = unknown, T = R> {
  cursor?: string | undefined;
  fingerprint?: string;
  pageSize?: number;
  capBytes?: number;
  // Hard cap on items returned in this single tool call. Useful when the
  // caller wants a small-ish slice even if 400 KB would fit more.
  maxItems?: number;
  /**
   * Client-side filter on the raw upstream records. The cursor keeps
   * tracking upstream positions, so filtered walks never skip or repeat
   * matches across calls.
   */
  filter?: (item: R) => boolean;
  /** Shape an accepted record before it is measured and returned. */
  project?: (item: R) => T;
  /**
   * Upstream offset of the first record when no cursor is given
   * (default 0). A cursor always wins: it carries its own position.
   */
  startFrom?: number;
  /**
   * Most upstream pages fetched in this call. When reached before the
   * upstream is exhausted, the call returns what it has with
   * `has_more: true` and a cursor that resumes the scan. Bounds the cost
   * of one call when a client-side filter matches little or nothing.
   */
  maxPages?: number;
}

export interface FetchedPage<T> {
  items: T[];
  hasMore: boolean;
  /**
   * True when `hasMore` comes from the upstream envelope (next_page or a
   * total count) rather than from the page length. Only then does a
   * page shorter than the requested size keep the walk going (the
   * server may cap the page size below the requested limit).
   */
  hasMoreFromEnvelope?: boolean;
  /** Upstream total of the unfiltered list, when the envelope carries one. */
  total?: number;
}

/**
 * Drive a cursor-aware paginated fetch. The caller passes a `fetchPage`
 * function that does one HTTP page (e.g. `{ from: 200, limit: 200 }`) and
 * returns the raw items + whether the upstream API has more.
 *
 * The helper accumulates (optionally filtered and projected) items until
 * the byte cap or `maxItems` is reached (returns `next_cursor` pointing
 * at the first record not returned) or the upstream is exhausted
 * (returns `next_cursor: null`). Budgets are measured in UTF-8 bytes.
 *
 * A single record larger than the cap is replaced by a
 * `__truncated_item` placeholder so the walk always makes progress.
 */
export async function pagedFetch<T, R = T>(
  fetchPage: (params: { from: number; limit: number }) => Promise<FetchedPage<R>>,
  opts: PagedFetchOptions<R, T> = {},
): Promise<PagedFetchResult<T>> {
  const cap = opts.capBytes ?? WIRE_LIMIT_BYTES;
  const pageSize = opts.pageSize ?? 200;
  const fingerprint = opts.fingerprint;
  const maxItems = opts.maxItems ?? Number.POSITIVE_INFINITY;

  let from = opts.startFrom ?? 0;
  // Items already returned before this call; undefined when a cursor
  // from an older build carried no count (then `total` stays unknown),
  // or when the walk did not start at the first record.
  let before: number | undefined = from === 0 ? 0 : undefined;
  if (opts.cursor !== undefined) {
    const parsed = resolveCursor(opts.cursor, fingerprint);
    from = parsed.from;
    before = parsed.n;
  }

  const items: T[] = [];
  const positions: number[] = [];
  let pos = from;
  let exhausted = false;
  let oversize = 0;
  let pages = 0;
  let pageCapped = false;
  let upstreamTotal: number | undefined;
  // Running byte counter (UTF-8) that mirrors JSON.stringify(items):
  // `[` + `]`, each item, and a comma between items. Linear, no
  // re-stringify of the accumulator.
  let runningBytes = 2;

  walk: for (;;) {
    if (items.length >= maxItems) break;
    if (opts.maxPages !== undefined && pages >= opts.maxPages) {
      pageCapped = true;
      break;
    }
    const page = await fetchPage({ from: pos, limit: pageSize });
    pages += 1;
    if (page.total !== undefined) upstreamTotal = page.total;
    if (page.items.length === 0) {
      exhausted = true;
      break;
    }
    for (const raw of page.items) {
      if (items.length >= maxItems) break walk;
      if (opts.filter && !opts.filter(raw)) {
        pos += 1;
        continue;
      }
      let item: T = opts.project ? opts.project(raw) : (raw as unknown as T);
      const comma = items.length === 0 ? 0 : 1;
      let size = jsonByteLength(item);
      if (runningBytes + comma + size > cap) {
        if (items.length > 0) break walk;
        // A single record bigger than the whole budget: replace it so
        // the cursor still moves forward (no endless empty pages).
        item = oversizePlaceholder(item, size, cap) as T;
        size = jsonByteLength(item);
        oversize += 1;
      }
      items.push(item);
      positions.push(pos);
      runningBytes += comma + size;
      pos += 1;
    }
    if (!page.hasMore || (page.items.length < pageSize && page.hasMoreFromEnvelope !== true)) {
      exhausted = true;
      break;
    }
  }

  const emitted = before === undefined ? undefined : before + items.length;
  const result: PagedFetchResult<T> = {
    items,
    count: items.length,
    next_cursor: exhausted ? null : buildCursor(pos, fingerprint, emitted),
    has_more: !exhausted,
    resumeAfter: (k: number) =>
      k < positions.length
        ? buildCursor(positions[k]!, fingerprint, before === undefined ? undefined : before + k)
        : buildCursor(pos, fingerprint, emitted),
  };
  if (exhausted && emitted !== undefined) result.total = emitted;
  // Without a filter (and from the first record on) the upstream total
  // is also the total of the walk.
  if (!exhausted && !opts.filter && (opts.startFrom ?? 0) === 0 && upstreamTotal !== undefined) {
    result.total_estimate = upstreamTotal;
  }
  const notes: string[] = [];
  if (oversize > 0) {
    notes.push(
      "An item was too large to fit the response budget and was replaced by a `__truncated_item` placeholder. Request that record individually via the matching get-by-id tool.",
    );
  }
  if (pageCapped && !exhausted) {
    notes.push(
      `This call stopped after scanning ${pages} upstream pages (up to record ${pos}). ` +
        "Matches may exist further on: call again with `next_cursor` to continue the scan, or narrow the query.",
    );
  }
  if (notes.length > 0) result.note = notes.join(" ");
  return result;
}
