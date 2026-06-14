import { describe, expect, it } from "vitest";
import { capItemList } from "../../src/utils/capOutput.js";

// Findings 5.2 (linear-time cap) and 5.3 (single-oversize-item
// handling). These tests guard against regressing back to the
// O(n² log n) binary-search variant and against silently returning
// an empty list when one record is too big to fit alone.

describe("capItemList — linear-time (finding 5.2)", () => {
  it("handles 5 000 mid-sized items in well under a second", () => {
    const items = Array.from({ length: 5_000 }, (_, i) => ({
      id: i,
      name: `endpoint-${i}`,
      blob: "y".repeat(200),
    }));
    const start = performance.now();
    const r = capItemList(items, 50_000);
    const elapsedMs = performance.now() - start;
    expect(r.total).toBe(5_000);
    expect(r.returned).toBeGreaterThan(0);
    expect(r.returned).toBeLessThan(5_000);
    expect(JSON.stringify(r.items).length).toBeLessThanOrEqual(50_000);
    // 250 ms is a comfortable upper bound on dev hardware; the
    // previous binary-search variant takes several seconds on the
    // same input.
    expect(elapsedMs).toBeLessThan(250);
  });

  it("handles 20 000 items without timing out (extreme regression guard)", () => {
    const items = Array.from({ length: 20_000 }, (_, i) => ({
      id: i,
      pad: "z".repeat(80),
    }));
    const start = performance.now();
    const r = capItemList(items, 200_000);
    const elapsedMs = performance.now() - start;
    expect(r.total).toBe(20_000);
    expect(JSON.stringify(r.items).length).toBeLessThanOrEqual(200_000);
    expect(elapsedMs).toBeLessThan(1_000);
  });
});

describe("capItemList — single-oversize-item handling (finding 5.3)", () => {
  it("emits a placeholder + note when the first item alone exceeds the cap", () => {
    const huge = { id: 1, body: "x".repeat(20_000) };
    const r = capItemList([huge, { id: 2 }, { id: 3 }], 1_000);

    expect(r.items).toHaveLength(1);
    const placeholder = r.items[0] as Record<string, unknown>;
    expect(placeholder.__truncated_item).toBe(true);
    expect(placeholder.__reason).toMatch(/1000-byte cap/);
    expect(typeof placeholder.__original_size_bytes).toBe("number");
    expect(placeholder.__original_size_bytes).toBeGreaterThan(1_000);
    expect(r.note).toMatch(/get-by-id/i);
    expect(r.total).toBe(3);
    expect(r.truncated).toBe(3);
  });

  it("returns no note for the normal case", () => {
    const r = capItemList([{ id: 1 }, { id: 2 }], 1_000);
    expect(r.note).toBeUndefined();
  });
});
