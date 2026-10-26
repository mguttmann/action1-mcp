import { describe, expect, it } from "vitest";
import { jsonResult, pagedListResult } from "../../src/tools/helpers.js";
import { pagedFetch } from "../../src/utils/cursor.js";
import { RESPONSE_BYTE_BUDGET } from "../../src/constants.js";

function structured(r: ReturnType<typeof pagedListResult>): Record<string, unknown> {
  return (r.structuredContent ?? {}) as Record<string, unknown>;
}

function text(r: ReturnType<typeof pagedListResult>): string {
  return (r.content[0] as { text: string }).text;
}

describe("pagedListResult - total policy", () => {
  // `total` must be the real total of the walk, never the item count of
  // the last call.
  it("emits the walk total on the terminal page", () => {
    const r = pagedListResult({
      items: [{ id: 1 }, { id: 2 }, { id: 3 }],
      count: 3,
      has_more: false,
      next_cursor: null,
      total: 1003,
    });
    expect(structured(r).total).toBe(1003);
  });

  it("omits total on a terminal page when the walk total is unknown", () => {
    const r = pagedListResult({
      items: [{ id: 1 }, { id: 2 }],
      count: 2,
      has_more: false,
      next_cursor: null,
      total_estimate: 99, // stale estimate
    });
    expect(structured(r).total).toBeUndefined();
  });

  it("reports the real total after a cursor chain, not the last page count", async () => {
    const all = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
    const fetchPage = async ({ from, limit }: { from: number; limit: number }) => {
      const items = all.slice(from, from + limit);
      return { items, hasMore: from + items.length < all.length };
    };
    let cursor: string | undefined;
    let last: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) {
      const page = await pagedFetch(fetchPage, {
        fingerprint: "fp",
        capBytes: 5_000,
        ...(cursor ? { cursor } : {}),
      });
      last = structured(pagedListResult(page, "json"));
      if (!last.has_more) break;
      cursor = last.next_cursor as string;
    }
    expect(last.has_more).toBe(false);
    expect(last.count).toBeLessThan(1000);
    expect(last.total).toBe(1000);
  });

  it("emits total = total_estimate while still walking (has_more=true)", () => {
    const r = pagedListResult({
      items: [{ id: 1 }],
      count: 1,
      has_more: true,
      next_cursor: "cursor-1",
      total_estimate: 50,
    });
    expect(structured(r).total).toBe(50);
  });

  it("omits total when has_more=true and no estimate", () => {
    const r = pagedListResult({
      items: [{ id: 1 }],
      count: 1,
      has_more: true,
      next_cursor: "cursor-1",
    });
    expect(structured(r).total).toBeUndefined();
  });

  it("emits the pagination note when has_more=true", () => {
    const r = pagedListResult({
      items: [{ id: 1 }],
      count: 1,
      has_more: true,
      next_cursor: "cursor-1",
    });
    expect(typeof structured(r).note).toBe("string");
    expect(structured(r).note).toMatch(/cursor.*next_cursor/i);
  });
});

describe("pagedListResult - Markdown output never loses rows", () => {
  const all = Array.from({ length: 3_000 }, (_, i) => ({
    id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
    name: `host-${i}`,
    status: i % 2 ? "Connected" : "Disconnected",
  }));
  const fetchPage = async ({ from, limit }: { from: number; limit: number }) => {
    const items = all.slice(from, from + limit);
    return { items, hasMore: from + items.length < all.length };
  };

  it("couples next_cursor to the last rendered row and prints it in full", async () => {
    const page = await pagedFetch(fetchPage, { fingerprint: "fp" });
    // Everything fits the 400 KB item budget in one call ...
    expect(page.count).toBe(3_000);
    const r = pagedListResult(page);
    const sc = structured(r);
    // ... but not the Markdown text budget, so the page is shortened.
    expect(sc.count as number).toBeLessThan(3_000);
    expect((sc.items as unknown[]).length).toBe(sc.count);
    expect(sc.has_more).toBe(true);
    expect(text(r)).toContain(`next_cursor: ${sc.next_cursor as string}`);
    expect(text(r)).not.toContain("more rows omitted");
  });

  it("chaining next_cursor read from the text alone yields every row exactly once", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let lastText = "";
    for (let i = 0; i < 100; i++) {
      const page = await pagedFetch(fetchPage, {
        fingerprint: "fp",
        ...(cursor ? { cursor } : {}),
      });
      lastText = text(pagedListResult(page));
      for (const m of lastText.matchAll(/^\| (0{8}-[0-9-]+) \|/gm)) seen.push(m[1]!);
      const next = /^next_cursor: (\S+)$/m.exec(lastText)?.[1];
      if (!/^has_more: true$/m.test(lastText)) break;
      expect(next).toBeDefined();
      cursor = next;
    }
    expect(seen).toEqual(all.map((e) => e.id));
    expect(lastText).toMatch(/^total: 3000$/m);
  });

  it("carries extra fields into both channels", () => {
    const r = pagedListResult(
      { items: [{ id: 1 }], count: 1, has_more: false, next_cursor: null },
      "markdown",
      false,
      { dropped_unparseable_timestamps: 2 },
    );
    expect(structured(r).dropped_unparseable_timestamps).toBe(2);
    expect(text(r)).toContain("dropped_unparseable_timestamps: 2");
    expect(text(r)).toContain("| id |");
  });
});

describe("pagedListResult - JSON output stays under the wire budget", () => {
  it("shortens the page instead of exceeding the budget, without losing items", async () => {
    // Quote-heavy items: the escaped text copy costs far more than the
    // structured copy, so 400 KB of items would exceed the wire budget.
    const all = Array.from({ length: 6_000 }, (_, i) => ({
      i,
      t: Array.from({ length: 12 }, (_, j) => `"${j}"`),
    }));
    const fetchPage = async ({ from, limit }: { from: number; limit: number }) => {
      const items = all.slice(from, from + limit);
      return { items, hasMore: from + items.length < all.length };
    };
    const collected: unknown[] = [];
    let cursor: string | undefined;
    for (let n = 0; n < 50; n++) {
      const page = await pagedFetch(fetchPage, {
        fingerprint: "fp",
        ...(cursor ? { cursor } : {}),
      });
      const r = pagedListResult(page, "json");
      expect(Buffer.byteLength(JSON.stringify(r), "utf8")).toBeLessThanOrEqual(
        RESPONSE_BYTE_BUDGET,
      );
      const sc = structured(r);
      collected.push(...(sc.items as unknown[]));
      if (!sc.has_more) break;
      cursor = sc.next_cursor as string;
    }
    expect(collected).toEqual(all);
  });
});

describe("jsonResult - response budget for single objects", () => {
  it("keeps a multi-MB object under the wire budget with a visible note", () => {
    const big = {
      instance_id: "abc",
      output: "PS> Get-ChildItem\n".repeat(200_000),
    };
    const r = jsonResult(big, big);
    expect(Buffer.byteLength(JSON.stringify(r), "utf8")).toBeLessThanOrEqual(RESPONSE_BYTE_BUDGET);
    const sc = r.structuredContent as Record<string, unknown>;
    expect(sc.instance_id).toBe("abc");
    expect(sc.output as string).toMatch(/chars truncated\)$/);
    expect(sc.truncation_note).toMatch(/budget/);
    expect((r.content[0] as { text: string }).text).toContain("truncation_note");
  });

  it("leaves normal responses untouched", () => {
    const r = jsonResult({ a: 1 }, { a: 1 });
    expect(r.structuredContent).toEqual({ a: 1 });
  });
});
