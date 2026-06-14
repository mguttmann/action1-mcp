import { describe, expect, it } from "vitest";
import {
  buildCursor,
  fingerprintQuery,
  pagedFetch,
  parseCursor,
} from "../../src/utils/cursor.js";

describe("buildCursor / parseCursor", () => {
  it("round-trips a simple from-only cursor", () => {
    const c = buildCursor(42);
    const p = parseCursor(c);
    expect(p?.from).toBe(42);
    expect(p?.q).toBeUndefined();
  });

  it("round-trips a cursor with fingerprint", () => {
    const c = buildCursor(100, "abcdef123456");
    const p = parseCursor(c);
    expect(p?.from).toBe(100);
    expect(p?.q).toBe("abcdef123456");
  });

  it("rejects garbage cursors", () => {
    expect(parseCursor("not-base64-!@#$")).toBeUndefined();
    expect(parseCursor(Buffer.from('{"foo":"bar"}', "utf8").toString("base64"))).toBeUndefined();
  });
});

describe("fingerprintQuery", () => {
  it("produces stable hashes for identical inputs", () => {
    const a = fingerprintQuery({ orgId: "x", filter: "y" });
    const b = fingerprintQuery({ orgId: "x", filter: "y" });
    expect(a).toBe(b);
  });

  it("ignores `cursor` and `limit` keys (they aren't part of the filter identity)", () => {
    const a = fingerprintQuery({ orgId: "x", cursor: "abc", limit: 100 });
    const b = fingerprintQuery({ orgId: "x", cursor: "different", limit: 50 });
    expect(a).toBe(b);
  });

  it("differs when filter inputs differ", () => {
    const a = fingerprintQuery({ orgId: "x", filter: "y" });
    const b = fingerprintQuery({ orgId: "x", filter: "z" });
    expect(a).not.toBe(b);
  });

  it("treats `undefined` values as absent", () => {
    const a = fingerprintQuery({ orgId: "x", filter: undefined });
    const b = fingerprintQuery({ orgId: "x" });
    expect(a).toBe(b);
  });
});

describe("pagedFetch", () => {
  it("returns all items when upstream is exhausted", async () => {
    const result = await pagedFetch<number>(async ({ from, limit }) => {
      const all = [1, 2, 3, 4, 5];
      const slice = all.slice(from, from + limit);
      return { items: slice, hasMore: from + slice.length < all.length };
    }, { pageSize: 2 });
    expect(result.items).toEqual([1, 2, 3, 4, 5]);
    expect(result.has_more).toBe(false);
    expect(result.next_cursor).toBeNull();
  });

  it("emits next_cursor when byte cap is reached mid-page", async () => {
    const blob = "x".repeat(1000);
    const result = await pagedFetch<{ blob: string }>(
      async ({ from, limit }) => {
        const items = Array.from({ length: limit }, () => ({ blob }));
        return { items, hasMore: from + items.length < 100 };
      },
      { pageSize: 10, capBytes: 5_000 },
    );
    expect(result.has_more).toBe(true);
    // Sharpen: `toBeTruthy()` would silently pass on weird shapes like
    // the number `1` or a non-empty array. Pin the type to string and
    // require a non-empty value so a regression that emits a numeric
    // cursor (decoded clients then break) fails loudly.
    expect(typeof result.next_cursor).toBe("string");
    expect((result.next_cursor as string).length).toBeGreaterThan(0);
    const parsed = parseCursor(result.next_cursor!);
    expect(parsed?.from).toBeGreaterThan(0);
  });

  it("rejects cursor with mismatched fingerprint", async () => {
    const cursor = buildCursor(50, "old-fingerprint");
    await expect(
      pagedFetch<number>(async () => ({ items: [], hasMore: false }), {
        cursor,
        fingerprint: "new-fingerprint",
      }),
    ).rejects.toThrow(/fingerprint mismatch/i);
  });

  it("accepts cursor with matching fingerprint", async () => {
    const cursor = buildCursor(2, "fp1");
    const result = await pagedFetch<number>(
      async ({ from, limit }) => {
        const all = [10, 20, 30, 40, 50];
        const slice = all.slice(from, from + limit);
        return { items: slice, hasMore: from + slice.length < all.length };
      },
      { cursor, fingerprint: "fp1", pageSize: 2 },
    );
    expect(result.items).toEqual([30, 40, 50]);
  });

  it("respects maxItems even when more pages exist", async () => {
    const result = await pagedFetch<number>(
      async ({ from, limit }) => {
        const all = Array.from({ length: 100 }, (_, i) => i);
        const slice = all.slice(from, from + limit);
        return { items: slice, hasMore: from + slice.length < all.length };
      },
      { pageSize: 10, maxItems: 5 },
    );
    expect(result.items.length).toBe(5);
    expect(result.items).toEqual([0, 1, 2, 3, 4]);
  });

  it("runs in linear time over 10k items (Cluster-D #3 perf regression guard)", async () => {
    // Prior bug: pagedFetch called JSON.stringify(items) on the full
    // accumulator AFTER every push, giving O(n²) wall-clock on a
    // 10 000-item walk. The new running-bytes counter mirrors
    // capItemList's linear strategy.
    const total = 10_000;
    const fetchPage = async ({
      from,
      limit,
    }: {
      from: number;
      limit: number;
    }): Promise<{ items: Array<{ id: number; name: string }>; hasMore: boolean }> => {
      const items = Array.from(
        { length: Math.min(limit, total - from) },
        (_, i) => ({ id: from + i, name: `endpoint-${from + i}` }),
      );
      return Promise.resolve({ items, hasMore: from + items.length < total });
    };
    const start = performance.now();
    const result = await pagedFetch<{ id: number; name: string }>(fetchPage, {
      pageSize: 500,
      capBytes: 10_000_000,
    });
    const elapsed = performance.now() - start;
    // 250 ms is a generous ceiling for the post-fix linear walk over
    // 10 000 small items. The O(n²) variant takes seconds on the same
    // input.
    expect(result.items.length).toBe(10_000);
    expect(elapsed).toBeLessThan(250);
  });
});
