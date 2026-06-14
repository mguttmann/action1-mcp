import { describe, expect, it } from "vitest";
import { pagedListResult } from "../../src/tools/helpers.js";

// Pin the `total` policy. Pass-3 audit found a regression where
// `total_estimate` won over the actual `count` even on terminal
// pages — confusing if the estimate disagreed with the visible count.

function structured(r: ReturnType<typeof pagedListResult>): Record<string, unknown> {
  return r.structuredContent ?? {};
}

describe("pagedListResult — total policy", () => {
  it("emits total = count on terminal page (has_more=false, no estimate)", () => {
    const r = pagedListResult({
      items: [{ id: 1 }, { id: 2 }, { id: 3 }],
      count: 3,
      has_more: false,
      next_cursor: null,
    });
    expect(structured(r).total).toBe(3);
  });

  it("count wins over total_estimate on terminal page (Pass-3 fix)", () => {
    const r = pagedListResult({
      items: [{ id: 1 }, { id: 2 }],
      count: 2,
      has_more: false,
      next_cursor: null,
      total_estimate: 99, // stale estimate
    });
    expect(structured(r).total).toBe(2);
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
