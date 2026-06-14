// Cursor-based pagination for list-shaped tools.
//
// Wire format: a base64-encoded JSON object `{ from: <number>, q?: <string> }`.
// `q` is a fingerprint of the query parameters; when set, follow-up calls
// must reuse the same fingerprint or the cursor is rejected. This prevents
// an agent from accidentally combining a cursor from one query with a
// different filter and getting silent garbage.

import { createHash } from "node:crypto";

export interface CursorPayload {
  from: number;
  q?: string;
}

export function buildCursor(from: number, fingerprint?: string): string {
  const payload: CursorPayload = { from };
  if (fingerprint !== undefined) payload.q = fingerprint;
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

export function parseCursor(cursor: string): CursorPayload | undefined {
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf8");
    const obj = JSON.parse(decoded) as Record<string, unknown>;
    if (typeof obj.from !== "number" || !Number.isFinite(obj.from)) return undefined;
    const out: CursorPayload = { from: obj.from };
    if (typeof obj.q === "string") out.q = obj.q;
    return out;
  } catch {
    return undefined;
  }
}

export function fingerprintQuery(query: Record<string, unknown>): string {
  const normalised = Object.keys(query)
    .filter((k) => query[k] !== undefined && k !== "cursor" && k !== "limit")
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = query[k];
      return acc;
    }, {});
  // 16 hex chars = 64 bits of entropy. The previous 12-char slice
  // gave only 48 bits, enough for ~16M cursors before a 50%
  // collision probability (birthday bound). Bumping to 64 bits is
  // free (same SHA-256 hash, just an extra slice byte) and pushes
  // the collision horizon out to ~4 billion cursors.
  return createHash("sha256").update(JSON.stringify(normalised)).digest("hex").slice(0, 16);
}

const CAP_BYTES_DEFAULT = 400_000;

export interface PagedFetchResult<T> {
  items: T[];
  count: number;
  next_cursor: string | null;
  has_more: boolean;
  total_estimate?: number;
}

export interface PagedFetchOptions {
  cursor?: string | undefined;
  fingerprint?: string;
  pageSize?: number;
  capBytes?: number;
  // Hard cap on items returned in this single tool call. Useful when the
  // caller wants a small-ish slice even if 400 KB would fit more.
  maxItems?: number;
}

export interface FetchedPage<T> {
  items: T[];
  hasMore: boolean;
}

/**
 * Drive a cursor-aware paginated fetch. The caller passes a `fetchPage`
 * function that does one HTTP page (e.g. `{ from: 200, limit: 200 }`) and
 * returns the items + whether the upstream API has more.
 *
 * The helper accumulates items until either (a) the byte cap is reached
 * (returns next_cursor with the position of the last accepted item) or
 * (b) the upstream is exhausted (returns next_cursor=null).
 *
 * Per-call ceiling is the page-size of the underlying API. Across calls
 * this gives the agent unbounded data — at the cost of multiple
 * tool-calls.
 */
export async function pagedFetch<T>(
  fetchPage: (params: { from: number; limit: number }) => Promise<FetchedPage<T>>,
  opts: PagedFetchOptions = {},
): Promise<PagedFetchResult<T>> {
  const cap = opts.capBytes ?? CAP_BYTES_DEFAULT;
  const pageSize = opts.pageSize ?? 200;
  const fingerprint = opts.fingerprint;

  let from = 0;
  if (opts.cursor) {
    const parsed = parseCursor(opts.cursor);
    if (parsed) {
      if (
        fingerprint !== undefined &&
        parsed.q !== undefined &&
        parsed.q !== fingerprint
      ) {
        throw new Error(
          "Cursor fingerprint mismatch. The cursor was issued for a different set of query parameters. Drop the cursor and start over.",
        );
      }
      from = parsed.from;
    }
  }

  const items: T[] = [];
  let pos = from;
  let upstreamExhausted = false;
  const maxItems = opts.maxItems ?? Number.POSITIVE_INFINITY;
  // Running byte counter — mirrors `capItemList`'s linear walk so we
  // don't re-stringify the full accumulator on every item. Previous
  // implementation called `JSON.stringify(items).length` per push,
  // giving O(n²) wall-clock on a 10 000-item walk. The new counter
  // tracks `[`, per-item `JSON.stringify(item).length`, and the
  // inter-item comma `,` exactly the way `JSON.stringify(array)` does.
  const BRACKET_BYTES = 2;
  let runningBytes = BRACKET_BYTES;

  while (items.length < maxItems) {
    const page = await fetchPage({ from: pos, limit: pageSize });
    if (page.items.length === 0) {
      upstreamExhausted = true;
      break;
    }
    for (const item of page.items) {
      const itemBytes = JSON.stringify(item).length;
      const addition = itemBytes + (items.length === 0 ? 0 : 1);
      // Tentative push: if it overflows we don't actually keep it.
      if (runningBytes + addition > cap) {
        return {
          items,
          count: items.length,
          next_cursor: buildCursor(pos, fingerprint),
          has_more: true,
        };
      }
      items.push(item);
      runningBytes += addition;
      pos += 1;
      if (items.length >= maxItems) break;
    }
    if (!page.hasMore || page.items.length < pageSize) {
      upstreamExhausted = true;
      break;
    }
  }

  return {
    items,
    count: items.length,
    next_cursor: upstreamExhausted ? null : buildCursor(pos, fingerprint),
    has_more: !upstreamExhausted,
  };
}
