import { describe, expect, it } from "vitest";
import { collect, paginate, parsePageEnvelope } from "../../src/client/pagination.js";

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

  // Pass-4 review #6 — explicit tests for the new termination logic.
  // The pre-fix length-only heuristic terminated too early when the
  // upstream applied a client-side filter mid-walk.

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
    // total=12 with `limit: 5`. Page 1 = 5 items, page 2 = 5 items
    // (full but `from+5=10 < total=12` so continue), page 3 = 2 items
    // (`from+2 = 12 >= total` → stop).
    let call = 0;
    const out = await collect(
      paginate<number>(
        async ({ from }) => {
          call += 1;
          if (from === 0) return { items: [1, 2, 3, 4, 5], total: 12 };
          if (from === 5) return { items: [6, 7, 8, 9, 10], total: 12 };
          return { items: [11, 12], total: 12 };
        },
        { limit: 5 },
      ),
    );
    expect(out).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(call).toBe(3);
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

  // Pass-4 review #2: explicit Cursor-Konvertierung tests. The
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
    expect(parsePageEnvelope({ items: [], next_cursor: "tok-1" }).hasMore).toBe(
      true,
    );
  });

  it("maps non-empty camelCase `nextCursor` to hasMore=true", () => {
    expect(parsePageEnvelope({ items: [], nextCursor: "tok-1" }).hasMore).toBe(
      true,
    );
  });

  it("maps explicit `has_more: true` through unchanged", () => {
    expect(parsePageEnvelope({ items: [], has_more: true }).hasMore).toBe(true);
    expect(parsePageEnvelope({ items: [], has_more: false }).hasMore).toBe(
      false,
    );
  });

  it("maps camelCase `hasMore` through unchanged", () => {
    expect(parsePageEnvelope({ items: [], hasMore: true }).hasMore).toBe(true);
  });

  it("leaves hasMore undefined when no cursor hint is present", () => {
    expect(parsePageEnvelope({ items: [1, 2, 3] }).hasMore).toBeUndefined();
  });

  it("has_more (explicit bool) wins over next (cursor) when both are present", () => {
    // Pass-6 review: pin the priority order documented in the source.
    // coerceBool(has_more) is tried first; coerceCursorPresence(next)
    // only runs if has_more is undefined / non-bool. Contradictory
    // upstream values (false + non-empty next) must resolve to FALSE.
    expect(
      parsePageEnvelope({ items: [], has_more: false, next: "abc" }).hasMore,
    ).toBe(false);
    expect(
      parsePageEnvelope({ items: [], has_more: true, next: "" }).hasMore,
    ).toBe(true);
  });

  it("string `has_more: \"true\"` is not coerced (falls through to next)", () => {
    // coerceBool only accepts boolean. A string "true" makes it
    // return undefined, so the next-cursor branch wins. This pins
    // the strict-typing contract — if someone loosens coerceBool to
    // accept strings, this test will break.
    expect(
      parsePageEnvelope({ items: [], has_more: "true", next: "abc" }).hasMore,
    ).toBe(true);
    expect(
      parsePageEnvelope({ items: [], has_more: "true" }).hasMore,
    ).toBeUndefined();
  });

  // Pass-9 review: number-cursor edge case. coerceCursorPresence only
  // accepts string OR null — numbers leave hasMore undefined. Pins the
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
  ])(
    "leaves hasMore undefined for non-string cursor values ($label)",
    ({ input, expected }) => {
      expect(parsePageEnvelope(input).hasMore).toBe(expected);
    },
  );
});
