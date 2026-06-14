import { DEFAULT_PAGE_SIZE } from "../constants.js";

export interface PageEnvelope<T> {
  items: T[];
  total?: number;
  from?: number;
  limit?: number;
  /**
   * Set when the upstream envelope contains an explicit "more pages
   * exist" hint (e.g. `next`, `next_cursor`, `has_more`). When this
   * flag is `false` we terminate immediately regardless of the
   * length heuristic; when `true` we keep walking even if the page
   * happens to be shorter than `limit` (which can happen if Action1
   * applies a server-side filter mid-page).
   */
  hasMore?: boolean;
}

export interface PaginationOptions {
  limit?: number;
  maxItems?: number;
  signal?: AbortSignal;
}

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

    // Termination logic, in priority order:
    //   1. Explicit upstream "more pages" flag wins. If Action1 told
    //      us hasMore=false we trust it; if hasMore=true we keep
    //      walking even when the page was shorter than `limit`
    //      (server-side filters can make a *middle* page short).
    //   2. Otherwise, prefer `from`-based termination using the
    //      `total` count when the upstream provides one — this
    //      avoids the false-positive where a filtered middle page
    //      is shorter than `limit` and the heuristic gives up too
    //      early.
    //   3. Fall back to the length heuristic only when neither hint
    //      is available (purely from-based APIs with no envelope
    //      metadata).
    if (page.hasMore !== undefined) {
      if (!page.hasMore) return;
      continue;
    }
    if (typeof page.total === "number") {
      if (from >= page.total) return;
      continue;
    }
    if (page.items.length < limit) return;
  }
}

export async function collect<T>(iter: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

export function parsePageEnvelope<T>(raw: unknown): PageEnvelope<T> {
  if (Array.isArray(raw)) {
    return { items: raw as T[] };
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const items = obj.items ?? obj.data ?? obj.results ?? [];
    if (Array.isArray(items)) {
      // Action1 (and most pagey REST APIs) use one of a handful of
      // names for the "more pages exist" hint. Normalise them all
      // to a single boolean so callers don't have to care.
      const hasMore =
        coerceBool(obj.has_more) ??
        coerceBool(obj.hasMore) ??
        coerceCursorPresence(obj.next) ??
        coerceCursorPresence(obj.next_cursor) ??
        coerceCursorPresence(obj.nextCursor);
      const envelope: PageEnvelope<T> = {
        items: items as T[],
        total: typeof obj.total === "number" ? obj.total : undefined,
        from: typeof obj.from === "number" ? obj.from : undefined,
        limit: typeof obj.limit === "number" ? obj.limit : undefined,
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
  // cursor shapes — leave them undefined so the caller falls back
  // to the next signal.
  if (v === null) return false;
  if (typeof v === "string") return v.length > 0;
  return undefined;
}
