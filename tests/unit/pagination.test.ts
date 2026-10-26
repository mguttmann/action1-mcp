import { describe, expect, it } from "vitest";
import {
  collect,
  paginate,
  parsePageEnvelope,
  envelopePage,
  listPageFetcher,
} from "../../src/client/pagination.js";

describe("paginate", () => {
  it("walks pages until the last page is shorter than limit", async () => {
    const pages = [
      Array.from({ length: 5 }, (_, i) => i),
      Array.from({ length: 5 }, (_, i) => i + 5),
      Array.from({ length: 2 }, (_, i) => i + 10),
    ];
    let calls = 0;
    const out = await collect(
      paginate<number>(
        async ({ from, limit }) => {
          calls += 1;
          expect(limit).toBe(5);
          const idx = from / 5;
          return { items: pages[idx] ?? [] };
        },
        { limit: 5 },
      ),
    );
    expect(out).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(calls).toBe(3);
  });

  it("respects maxItems cap", async () => {
    const out = await collect(
      paginate<number>(
        async ({ from, limit }) => ({
          items: Array.from({ length: limit }, (_, i) => i + from),
        }),
        { limit: 5, maxItems: 7 },
      ),
    );
    expect(out).toHaveLength(7);
  });

  // Termination logic: a length-only heuristic would stop too early
  // when the upstream applies a filter mid-walk.

  it("hasMore=false stops immediately even on a full page", async () => {
    const pages: number[][] = [[1, 2, 3, 4, 5]]; // exactly `limit`
    let call = 0;
    const out = await collect(
      paginate<number>(
        async () => {
          const items = pages[call] ?? [];
          call += 1;
          return { items, hasMore: false };
        },
        { limit: 5 },
      ),
    );
    expect(out).toEqual([1, 2, 3, 4, 5]);
    expect(call).toBe(1);
  });

  it("hasMore=true keeps walking even after a short middle page", async () => {
    // The middle page has only 2 items (shorter than the limit of 5)
    // but the upstream tells us more pages exist. Pre-fix this would
    // have terminated early; post-fix we continue.
    let call = 0;
    const out = await collect(
      paginate<number>(
        async () => {
          const i = call;
          call += 1;
          if (i === 0) return { items: [1, 2, 3, 4, 5], hasMore: true };
          if (i === 1) return { items: [6, 7], hasMore: true };
          if (i === 2) return { items: [8, 9, 10], hasMore: false };
          return { items: [] };
        },
        { limit: 5 },
      ),
    );
    expect(out).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(call).toBe(3);
  });

  it("from+total termination beats the length heuristic", async () => {
    // total=8 with `limit: 5`. Page 1 is short (3 items) but
    // `from 3 < total 8`, so the walk continues where the length
    // heuristic would stop. Page 2 is full (5 items) but
    // `from 8 >= total 8`, so the walk stops where the heuristic would
    // ask again. A third call would add the sentinel 99.
    let call = 0;
    const out = await collect(
      paginate<number>(
        async ({ from }) => {
          call += 1;
          if (from === 0) return { items: [1, 2, 3], total: 8 };
          if (from === 3) return { items: [4, 5, 6, 7, 8], total: 8 };
          return { items: [99], total: 8 };
        },
        { limit: 5 },
      ),
    );
    expect(out).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(call).toBe(2);
  });

  it("falls back to length heuristic when no hint is present", async () => {
    // No hasMore, no total. The classic from-based API.
    let call = 0;
    const out = await collect(
      paginate<number>(
        async ({ from, limit }) => {
          call += 1;
          if (from < 10) {
            return { items: Array.from({ length: limit }, (_, i) => i + from) };
          }
          return { items: [] }; // exhausted
        },
        { limit: 5 },
      ),
    );
    expect(out).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(call).toBe(3); // two full pages + empty terminator
  });

  it("non-empty next_cursor (parsed via parsePageEnvelope.hasMore=true) keeps walking", async () => {
    // Simulate what `parsePageEnvelope` produces for an upstream
    // payload `{items, next: "<token>"}`: hasMore: true.
    let call = 0;
    const out = await collect(
      paginate<number>(
        async () => {
          call += 1;
          if (call === 1) return { items: [1, 2], hasMore: true };
          if (call === 2) return { items: [3], hasMore: false };
          return { items: [] };
        },
        { limit: 5 },
      ),
    );
    expect(out).toEqual([1, 2, 3]);
    expect(call).toBe(2);
  });
});

describe("parsePageEnvelope", () => {
  it("handles {items: [...]}", () => {
    const env = parsePageEnvelope({ items: [1, 2, 3], total: 99, limit: 10, from: 0 });
    expect(env.items).toEqual([1, 2, 3]);
    expect(env.total).toBe(99);
  });

  it("handles a bare array", () => {
    expect(parsePageEnvelope([1, 2]).items).toEqual([1, 2]);
  });

  it("handles {data: [...]}", () => {
    expect(parsePageEnvelope({ data: ["a"] }).items).toEqual(["a"]);
  });

  it("returns empty for unsupported shapes", () => {
    expect(parsePageEnvelope(null).items).toEqual([]);
    expect(parsePageEnvelope({ foo: 1 }).items).toEqual([]);
  });

  // Explicit cursor conversion tests. The
  // pagination terminate-test simulated `hasMore: true/false` directly;
  // these tests pin the parsePageEnvelope-side translation from the
  // raw Action1 envelope keys (next / next_cursor / nextCursor / has_more
  // / hasMore) to the normalised `hasMore` flag.
  it("maps non-empty `next` to hasMore=true", () => {
    expect(parsePageEnvelope({ items: [], next: "abc-cursor" }).hasMore).toBe(true);
  });

  it("maps empty `next` to hasMore=false", () => {
    expect(parsePageEnvelope({ items: [], next: "" }).hasMore).toBe(false);
  });

  it("maps null `next` to hasMore=false", () => {
    expect(parsePageEnvelope({ items: [], next: null }).hasMore).toBe(false);
  });

  it("maps non-empty `next_cursor` to hasMore=true", () => {
    expect(parsePageEnvelope({ items: [], next_cursor: "tok-1" }).hasMore).toBe(true);
  });

  it("maps non-empty camelCase `nextCursor` to hasMore=true", () => {
    expect(parsePageEnvelope({ items: [], nextCursor: "tok-1" }).hasMore).toBe(true);
  });

  it("maps explicit `has_more: true` through unchanged", () => {
    expect(parsePageEnvelope({ items: [], has_more: true }).hasMore).toBe(true);
    expect(parsePageEnvelope({ items: [], has_more: false }).hasMore).toBe(false);
  });

  it("maps camelCase `hasMore` through unchanged", () => {
    expect(parsePageEnvelope({ items: [], hasMore: true }).hasMore).toBe(true);
  });

  it("leaves hasMore undefined when no cursor hint is present", () => {
    expect(parsePageEnvelope({ items: [1, 2, 3] }).hasMore).toBeUndefined();
  });

  it("has_more (explicit bool) wins over next (cursor) when both are present", () => {
    // Pin the priority order documented in the source.
    // coerceBool(has_more) is tried first; coerceCursorPresence(next)
    // only runs if has_more is undefined / non-bool. Contradictory
    // upstream values (false + non-empty next) must resolve to FALSE.
    expect(parsePageEnvelope({ items: [], has_more: false, next: "abc" }).hasMore).toBe(false);
    expect(parsePageEnvelope({ items: [], has_more: true, next: "" }).hasMore).toBe(true);
  });

  it('string `has_more: "true"` is not coerced (falls through to next)', () => {
    // coerceBool only accepts boolean. A string "true" makes it
    // return undefined, so the next-cursor branch wins. This pins
    // the strict-typing contract - if someone loosens coerceBool to
    // accept strings, this test will break.
    expect(parsePageEnvelope({ items: [], has_more: "true", next: "abc" }).hasMore).toBe(true);
    expect(parsePageEnvelope({ items: [], has_more: "true" }).hasMore).toBeUndefined();
  });

  // Number-cursor edge case. coerceCursorPresence only
  // accepts string OR null - numbers leave hasMore undefined. Pins the
  // strict-typing for the cursor path symmetric to has_more above.
  it.each([
    { input: { items: [], next: 0 }, expected: undefined, label: "next: 0" },
    { input: { items: [], next: 1 }, expected: undefined, label: "next: 1" },
    {
      input: { items: [], next_cursor: 42 },
      expected: undefined,
      label: "next_cursor: 42",
    },
    {
      input: { items: [], nextCursor: true },
      expected: undefined,
      label: "nextCursor: true (boolean, not string)",
    },
  ])("leaves hasMore undefined for non-string cursor values ($label)", ({ input, expected }) => {
    expect(parsePageEnvelope(input).hasMore).toBe(expected);
  });
});

// The pinned Action1 spec (components.schemas.ResultPage) documents the
// list envelope as { items, total_items, limit, next_page, prev_page }:
// next_page is the URL of the next page and empty on the last page;
// total_items and limit are typed as strings.
describe("Action1 ResultPage envelope", () => {
  const resultPage = (over: Record<string, unknown>) => ({
    id: "page",
    type: "ResultPage",
    items: [{ id: "a" }, { id: "b" }],
    total_items: "5",
    limit: "2",
    next_page: "/API/endpoints/managed/org?limit=2&from=2",
    prev_page: "",
    ...over,
  });

  it("maps a non-empty next_page to hasMore=true and total_items to total", () => {
    const env = parsePageEnvelope(resultPage({}));
    expect(env.hasMore).toBe(true);
    expect(env.total).toBe(5);
    expect(env.limit).toBe(2);
  });

  it("maps an empty next_page (last page) to hasMore=false", () => {
    expect(parsePageEnvelope(resultPage({ next_page: "" })).hasMore).toBe(false);
  });

  it("accepts numeric total_items as well", () => {
    expect(parsePageEnvelope(resultPage({ total_items: 7 })).total).toBe(7);
  });

  it("keeps walking when the server caps the page below the requested limit", async () => {
    // Requested limit 200, server returns 2 per page with next_page set.
    const pages = [
      resultPage({ items: [1, 2], next_page: "/API/x?from=2" }),
      resultPage({ items: [3, 4], next_page: "/API/x?from=4" }),
      resultPage({ items: [5], next_page: "" }),
    ];
    let call = 0;
    const out = await collect(
      paginate<number>(async () => parsePageEnvelope<number>(pages[call++] ?? []), {
        limit: 200,
      }),
    );
    expect(out).toEqual([1, 2, 3, 4, 5]);
    expect(call).toBe(3);
  });

  // Both seen on the live API (read-only shape check, 2026-10-26):
  // total_items as a lower bound like "25+", and a page shorter than
  // its limit that still carries next_page.
  it("drops a lower-bound total_items like '25+' and lets next_page decide", () => {
    const env = parsePageEnvelope(resultPage({ total_items: "25+" }));
    expect(env.total).toBeUndefined();
    expect(env.hasMore).toBe(true);
  });

  it("keeps walking after a short page with next_page and a '25+' total", async () => {
    const pages = [
      resultPage({ items: [1], total_items: "25+", limit: "2", next_page: "/API/x?from=1" }),
      resultPage({ items: [2, 3], total_items: "25+", limit: "2", next_page: "/API/x?from=3" }),
      resultPage({ items: [4], total_items: "4", limit: "2", next_page: "" }),
    ];
    let call = 0;
    const out = await collect(
      paginate<number>(async () => parsePageEnvelope<number>(pages[call++] ?? []), { limit: 2 }),
    );
    expect(out).toEqual([1, 2, 3, 4]);
    expect(call).toBe(3);
  });

  it("envelopePage reports more pages for a short live page with next_page and '25+'", () => {
    const p = envelopePage(
      { items: [1], total_items: "25+", limit: "2", next_page: "/API/x?from=1" },
      0,
      2,
    );
    expect(p).toEqual({ items: [1], hasMore: true, hasMoreFromEnvelope: true });
  });
});

describe("envelopePage (shared page adapter)", () => {
  it("keeps walking after a capped page when next_page is set", () => {
    const p = envelopePage({ items: [1, 2], total_items: "10", next_page: "/x?from=2" }, 0, 200);
    expect(p).toEqual({ items: [1, 2], hasMore: true, hasMoreFromEnvelope: true, total: 10 });
  });

  it("stops on an empty next_page even after a full page", () => {
    const p = envelopePage({ items: [1, 2], next_page: "" }, 0, 2);
    expect(p.hasMore).toBe(false);
  });

  it("falls back to the page length for a bare array", () => {
    expect(envelopePage([1, 2], 0, 2)).toEqual({
      items: [1, 2],
      hasMore: true,
      hasMoreFromEnvelope: false,
    });
    expect(envelopePage([1], 0, 2).hasMore).toBe(false);
  });

  it("listPageFetcher sends the base query plus limit/from", async () => {
    const seen: unknown[] = [];
    const fetchPage = listPageFetcher<number>(
      {
        request: <R>(path: string, opts?: unknown) => {
          seen.push([path, opts]);
          return Promise.resolve({ items: [7] } as R);
        },
      },
      "/p",
      { a: "b" },
    );
    const page = await fetchPage({ from: 5, limit: 3 });
    expect(page.items).toEqual([7]);
    expect(seen).toEqual([["/p", { query: { a: "b", limit: 3, from: 5 } }]]);
  });
});
