import { DEFAULT_PAGE_SIZE } from "../constants.js";

/** One upstream list page, normalised by `parsePageEnvelope`. */
export interface PageEnvelope<T> {
  items: T[];
  total?: number;
  from?: number;
  limit?: number;
  /**
   * Set when the upstream envelope contains an explicit "more pages
   * exist" hint (`next_page`, `has_more`, `next`, `next_cursor`). See
   * `pageHasMore` for how it ranks against `total` and page length.
   */
  hasMore?: boolean;
}

/** Options of `paginate`. */
export interface PaginationOptions {
  /** Requested page size (default DEFAULT_PAGE_SIZE). */
  limit?: number;
  /** Stop after this many items in total (default: no cap). */
  maxItems?: number;
  /** Abort between pages; the walk throws an AbortError. */
  signal?: AbortSignal;
}

/**
 * Walk a list from offset 0 and yield its items. `fetchPage` loads one
 * page for `{ limit, from }`; the walk stops on an empty page, by
 * `pageHasMore`, after `maxItems` items, or when `signal` aborts.
 */
export async function* paginate<T>(
  fetchPage: (params: { limit: number; from: number }) => Promise<PageEnvelope<T>>,
  opts: PaginationOptions = {},
): AsyncGenerator<T, void, void> {
  const limit = opts.limit ?? DEFAULT_PAGE_SIZE;
  const cap = opts.maxItems ?? Number.POSITIVE_INFINITY;
  let from = 0;
  let yielded = 0;

  while (yielded < cap) {
    if (opts.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const page = await fetchPage({ limit, from });
    if (!page.items.length) return;
    for (const item of page.items) {
      yield item;
      yielded += 1;
      if (yielded >= cap) return;
    }
    from += page.items.length;
    if (!pageHasMore(page, from, limit)) return;
  }
}

/**
 * Single termination rule for every paginated walk (`paginate` here and
 * the cursor-based `pagedFetch` in the generated runtime), in priority
 * order:
 *   1. An explicit upstream "more pages" signal wins (`next_page` in the
 *      Action1 ResultPage envelope, or `has_more` / `next` /
 *      `next_cursor`). `true` keeps walking even after a short page
 *      (the server may cap the page size below the requested limit or
 *      filter a middle page); `false` stops even after a full page.
 *   2. Otherwise a total count (`total_items`, `total`) decides by
 *      comparing it with the position after this page.
 *   3. Otherwise the length heuristic: a page shorter than the
 *      requested limit is the last one.
 * `fromAfter` is the offset after consuming `page`.
 */
export function pageHasMore<T>(page: PageEnvelope<T>, fromAfter: number, limit: number): boolean {
  if (page.items.length === 0) return false;
  if (page.hasMore !== undefined) return page.hasMore;
  if (typeof page.total === "number") return fromAfter < page.total;
  return page.items.length >= limit;
}

/** Drain an async generator into an array. Unbounded: give the walk a `maxItems`. */
export async function collect<T>(iter: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

/**
 * Normalise a list response to a `PageEnvelope`: a bare array, or an
 * object with `items` (also `data` / `results`) plus Action1's ResultPage
 * fields `next_page`, `total_items`, `from` and `limit` (numbers or digit
 * strings). Anything else is an empty page.
 */
export function parsePageEnvelope<T>(raw: unknown): PageEnvelope<T> {
  if (Array.isArray(raw)) {
    return { items: raw as T[] };
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const items = obj.items ?? obj.data ?? obj.results ?? [];
    if (Array.isArray(items)) {
      // Normalise the "more pages exist" hint to one boolean. Action1's
      // documented ResultPage envelope uses `next_page` (URL of the next
      // page, empty on the last page); the other names are kept as
      // fallbacks for envelopes that use them.
      const hasMore =
        coerceBool(obj.has_more) ??
        coerceBool(obj.hasMore) ??
        coerceCursorPresence(obj.next_page) ??
        coerceCursorPresence(obj.next) ??
        coerceCursorPresence(obj.next_cursor) ??
        coerceCursorPresence(obj.nextCursor);
      const envelope: PageEnvelope<T> = {
        items: items as T[],
        // ResultPage types total_items and limit as strings.
        total: coerceCount(obj.total_items) ?? coerceCount(obj.total),
        from: coerceCount(obj.from),
        limit: coerceCount(obj.limit),
      };
      if (hasMore !== undefined) envelope.hasMore = hasMore;
      return envelope;
    }
  }
  return { items: [] };
}

function coerceBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  return undefined;
}

function coerceCursorPresence(v: unknown): boolean | undefined {
  // A cursor-style hint is "present" (more pages) when it's a
  // non-empty string. `null`, empty string, and missing all mean
  // the upstream is exhausted. Numbers and booleans aren't valid
  // cursor shapes - leave them undefined so the caller falls back
  // to the next signal.
  if (v === null) return false;
  if (typeof v === "string") return v.length > 0;
  return undefined;
}

function coerceCount(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number.parseInt(v, 10);
  return undefined;
}

/** One page of a cursor walk (`pagedFetch` in src/utils/cursor.ts). */
export interface EnvelopePage<T> {
  items: T[];
  /** More pages exist, by the rule in `pageHasMore`. */
  hasMore: boolean;
  /** `hasMore` came from the envelope (next_page / total), not the page length. */
  hasMoreFromEnvelope: boolean;
  /** Upstream total (`total_items`), when the envelope carries one. */
  total?: number;
}

/**
 * Read one upstream list response (ResultPage envelope or bare array)
 * fetched at offset `from` with page size `limit`. The single page
 * adapter for every cursor walk, curated and generated, so all of them
 * stop by the same rule (`pageHasMore`).
 */
export function envelopePage<T>(raw: unknown, from: number, limit: number): EnvelopePage<T> {
  const page = parsePageEnvelope<T>(raw);
  const out: EnvelopePage<T> = {
    items: page.items,
    hasMore: pageHasMore(page, from + page.items.length, limit),
    hasMoreFromEnvelope: page.hasMore !== undefined || page.total !== undefined,
  };
  if (page.total !== undefined) out.total = page.total;
  return out;
}

type Query = Record<string, string | number | boolean | undefined>;

/** The part of Action1Client a page fetcher needs. */
export interface ListRequester {
  request<R>(path: string, opts?: { query?: Query; signal?: AbortSignal }): Promise<R>;
}

/**
 * `fetchPage` for `pagedFetch`: GET `path` with `query` plus the walk's
 * `limit` / `from`, read through `envelopePage`.
 */
export function listPageFetcher<T>(
  client: ListRequester,
  path: string,
  query: Query = {},
  signal?: AbortSignal,
): (p: { from: number; limit: number }) => Promise<EnvelopePage<T>> {
  return async ({ from, limit }) => {
    const raw = await client.request<unknown>(path, {
      query: { ...query, limit, from },
      ...(signal ? { signal } : {}),
    });
    return envelopePage<T>(raw, from, limit);
  };
}
