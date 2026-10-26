import { describe, expect, it } from "vitest";
import { buildCursor, fingerprintQuery, pagedFetch, parseCursor } from "../../src/utils/cursor.js";
import { stringifiedChars } from "../helpers/stringifyWork.js";

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
    expect(parseCursor("garbage!!")).toBeUndefined();
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
    const result = await pagedFetch<number>(
      async ({ from, limit }) => {
        const all = [1, 2, 3, 4, 5];
        const slice = all.slice(from, from + limit);
        return { items: slice, hasMore: from + slice.length < all.length };
      },
      { pageSize: 2 },
    );
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
      const items = Array.from({ length: Math.min(limit, total - from) }, (_, i) => ({
        id: from + i,
        name: `endpoint-${from + i}`,
      }));
      return Promise.resolve({ items, hasMore: from + items.length < total });
    };
    // Deterministic guard: count serialised characters instead of
    // wall-clock time. A linear walk serialises each item a constant
    // number of times; re-stringifying the accumulator after every push
    // produces roughly n/2 times the input size.
    const inputChars = JSON.stringify(
      Array.from({ length: total }, (_, i) => ({ id: i, name: `endpoint-${i}` })),
    ).length;
    const { result, chars } = await stringifiedChars(() =>
      pagedFetch<{ id: number; name: string }>(fetchPage, {
        pageSize: 500,
        capBytes: 10_000_000,
      }),
    );
    expect(result.items.length).toBe(10_000);
    expect(chars).toBeLessThanOrEqual(2 * inputChars);
  });
});

// List correctness: walks neither skip nor repeat items at page and
// cursor boundaries, and report the total of the whole walk.
describe("pagedFetch - list correctness", () => {
  const fleet = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i, name: `host-${i}` }));
  const serve =
    <T>(all: T[]) =>
    async ({ from, limit }: { from: number; limit: number }) => {
      const slice = all.slice(from, from + limit);
      return { items: slice, hasMore: from + slice.length < all.length };
    };

  async function walk<T>(
    fetchPage: Parameters<typeof pagedFetch<T>>[0],
    opts: Parameters<typeof pagedFetch<T>>[1],
  ): Promise<{ items: T[]; calls: number; lastTotal: number | undefined }> {
    const items: T[] = [];
    let cursor: string | undefined;
    let calls = 0;
    for (;;) {
      calls += 1;
      if (calls > 100) throw new Error("cursor loop");
      const r = await pagedFetch<T>(fetchPage, { ...opts, ...(cursor ? { cursor } : {}) });
      items.push(...r.items);
      if (!r.has_more) return { items, calls, lastTotal: r.total };
      expect(r.next_cursor).toBeTypeOf("string");
      cursor = r.next_cursor!;
    }
  }

  it("rejects an unparseable cursor instead of restarting at 0", async () => {
    await expect(
      pagedFetch(serve(fleet(10)), { cursor: "garbage!!", fingerprint: "fp" }),
    ).rejects.toThrow(/invalid cursor/i);
  });

  it("rejects a cursor without fingerprint when the query has one", async () => {
    await expect(
      pagedFetch(serve(fleet(10)), { cursor: buildCursor(3), fingerprint: "fp" }),
    ).rejects.toThrow(/fingerprint/i);
  });

  it("rejects a cursor with a negative or fractional offset", async () => {
    const neg = Buffer.from(JSON.stringify({ from: -1, q: "fp" })).toString("base64");
    const frac = Buffer.from(JSON.stringify({ from: 1.5, q: "fp" })).toString("base64");
    await expect(pagedFetch(serve(fleet(10)), { cursor: neg, fingerprint: "fp" })).rejects.toThrow(
      /invalid cursor/i,
    );
    await expect(pagedFetch(serve(fleet(10)), { cursor: frac, fingerprint: "fp" })).rejects.toThrow(
      /invalid cursor/i,
    );
  });

  it("replaces a single oversize item with a placeholder and advances the cursor", async () => {
    const all = [{ id: 0, blob: "x".repeat(5_000) }, { id: 1 }, { id: 2 }];
    const r = await pagedFetch<Record<string, unknown>>(serve(all), {
      capBytes: 1_000,
      fingerprint: "fp",
    });
    expect(r.items).toHaveLength(3);
    expect(r.items[0]).toMatchObject({ __truncated_item: true, id: 0 });
    expect(r.items.slice(1)).toEqual([{ id: 1 }, { id: 2 }]);
    expect(r.has_more).toBe(false);
    expect(r.note).toMatch(/too large/i);
  });

  it("never loops when every item is oversize", async () => {
    const all = Array.from({ length: 3 }, (_, i) => ({ id: i, blob: "x".repeat(5_000) }));
    const { items, calls } = await walk<Record<string, unknown>>(serve(all), {
      capBytes: 1_000,
      fingerprint: "fp",
    });
    expect(items.map((i) => i.id)).toEqual([0, 1, 2]);
    expect(calls).toBe(3);
  });

  it("maxItems on the last upstream page reports has_more and resumes without loss", async () => {
    // 25 items, page size 10: the third page holds 5 items. maxItems=3
    // used to stop mid-page and report has_more=false.
    const { items, lastTotal } = await walk(serve(fleet(25)), {
      pageSize: 10,
      maxItems: 3,
      fingerprint: "fp",
    });
    expect(items.map((i) => i.id)).toEqual(fleet(25).map((i) => i.id));
    expect(lastTotal).toBe(25);
  });

  it("byte cap chain returns every item exactly once and the real total", async () => {
    const all = fleet(1_000);
    const { items, calls, lastTotal } = await walk(serve(all), {
      pageSize: 64,
      capBytes: 4_000,
      fingerprint: "fp",
    });
    expect(calls).toBeGreaterThan(3);
    expect(items).toEqual(all);
    expect(lastTotal).toBe(1_000);
  });

  it("filter option scans upstream positions, never skips or duplicates matches", async () => {
    const all = fleet(1_000);
    const isMatch = (it: { id: number }) => it.id % 7 === 0;
    const expected = all.filter(isMatch);
    for (const opts of [
      { pageSize: 50, maxItems: 9 },
      { pageSize: 200, capBytes: 300 },
      { pageSize: 30 },
    ]) {
      const { items, lastTotal } = await walk(serve(all), {
        ...opts,
        filter: isMatch,
        fingerprint: "fp",
      });
      expect(items).toEqual(expected);
      expect(lastTotal).toBe(expected.length);
    }
  });

  it("project option shapes accepted items after the filter", async () => {
    const r = await pagedFetch<{ name: string }, { id: number; name: string }>(serve(fleet(10)), {
      filter: (it) => it.id < 2,
      project: (it) => ({ name: it.name }),
      fingerprint: "fp",
    });
    expect(r.items).toEqual([{ name: "host-0" }, { name: "host-1" }]);
  });

  it("measures the byte cap in UTF-8 bytes, not UTF-16 code units", async () => {
    // Each item is ~1 000 code units but ~3 000 UTF-8 bytes.
    const all = Array.from({ length: 10 }, (_, i) => ({ id: i, v: "€".repeat(1_000) }));
    const r = await pagedFetch(serve(all), { capBytes: 5_000, fingerprint: "fp" });
    const bytes = Buffer.byteLength(JSON.stringify(r.items), "utf8");
    expect(bytes).toBeLessThanOrEqual(5_000);
    expect(r.items.length).toBe(1);
  });

  it("resumeAfter(k) yields a cursor that continues right after the first k items", async () => {
    const all = fleet(50);
    const isMatch = (it: { id: number }) => it.id % 3 === 0;
    const first = await pagedFetch(serve(all), { filter: isMatch, fingerprint: "fp" });
    expect(first.has_more).toBe(false);
    const cut = first.resumeAfter(4);
    const rest = await pagedFetch(serve(all), { filter: isMatch, fingerprint: "fp", cursor: cut });
    expect([...first.items.slice(0, 4), ...rest.items]).toEqual(all.filter(isMatch));
    expect(rest.total).toBe(all.filter(isMatch).length);
  });

  it("maxPages bounds the pages of one call and the cursor resumes the scan", async () => {
    const all = fleet(1_000);
    let fetched = 0;
    const counting = async (p: { from: number; limit: number }) => {
      fetched += 1;
      return serve(all)(p);
    };
    const none = () => false;
    const first = await pagedFetch(counting, {
      filter: none,
      fingerprint: "fp",
      pageSize: 100,
      maxPages: 3,
    });
    expect(fetched).toBe(3);
    expect(first.items).toEqual([]);
    expect(first.has_more).toBe(true);
    expect(first.note).toMatch(/scanning 3 upstream pages/);
    const next = await pagedFetch(counting, {
      filter: (it: { id: number }) => it.id >= 300,
      fingerprint: "fp",
      pageSize: 100,
      maxPages: 3,
      cursor: first.next_cursor!,
    });
    expect(next.items[0]).toEqual({ id: 300, name: "host-300" });
  });

  it("startFrom begins the walk at that offset; a cursor still wins", async () => {
    const all = fleet(30);
    const r = await pagedFetch(serve(all), { startFrom: 25, fingerprint: "fp" });
    expect(r.items.map((i) => (i as { id: number }).id)).toEqual([25, 26, 27, 28, 29]);
    expect(r.total).toBeUndefined();
    const c = buildCursor(28, "fp", 28);
    const r2 = await pagedFetch(serve(all), { startFrom: 5, cursor: c, fingerprint: "fp" });
    expect(r2.items.map((i) => (i as { id: number }).id)).toEqual([28, 29]);
  });

  it("reports the envelope total while more pages exist (unfiltered walks only)", async () => {
    const all = fleet(500);
    const withTotal = async (p: { from: number; limit: number }) => ({
      ...(await serve(all)(p)),
      total: all.length,
    });
    const r = await pagedFetch(withTotal, { fingerprint: "fp", maxItems: 10 });
    expect(r.has_more).toBe(true);
    expect(r.total_estimate).toBe(500);
    const filtered = await pagedFetch(withTotal, {
      fingerprint: "fp",
      maxItems: 10,
      filter: () => true,
    });
    expect(filtered.total_estimate).toBeUndefined();
  });

  it("omits total when the walk resumed from a cursor that carries no running count", async () => {
    const legacy = Buffer.from(JSON.stringify({ from: 5, q: "fp" })).toString("base64");
    const r = await pagedFetch(serve(fleet(10)), { cursor: legacy, fingerprint: "fp" });
    expect(r.items).toHaveLength(5);
    expect(r.total).toBeUndefined();
  });
});
