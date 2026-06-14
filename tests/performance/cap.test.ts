import { describe, expect, it } from "vitest";
import { capItemList } from "../../src/utils/capOutput.js";
import { maybeRenderMarkdownTable } from "../../src/utils/markdownTable.js";

// Performance regressions on the hot path (capping + markdown
// rendering) directly translate to slow tool calls. The numbers below
// are generous on a typical 2025-era Mac/Linux laptop; they exist to
// catch order-of-magnitude regressions, not micro-tune.

describe("capItemList — large list scaling", () => {
  it("trims a 10k-item list to fit a 50 KB byte cap in <500 ms", () => {
    const items = Array.from({ length: 10_000 }, (_, i) => ({
      id: i,
      blob: "x".repeat(50),
    }));
    const t0 = performance.now();
    const r = capItemList(items, 50_000);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(500);
    expect(r.returned).toBeLessThan(10_000);
    expect(r.truncated).toBeGreaterThan(0);
    expect(JSON.stringify(r.items).length).toBeLessThanOrEqual(50_000);
  });

  it("returns the full list when it already fits, in <50 ms", () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ id: i }));
    const t0 = performance.now();
    const r = capItemList(items, 100_000);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(50);
    expect(r.returned).toBe(500);
    expect(r.truncated).toBe(0);
  });
});

describe("maybeRenderMarkdownTable — large list scaling", () => {
  it("renders a 5k-row wide table under 25 KB / 200 ms", () => {
    const items = Array.from({ length: 5_000 }, (_, i) => ({
      id: i,
      name: `row-${i.toString().padStart(6, "0")}`,
      label: `human-readable-${i.toString().padStart(6, "0")}`,
      v: i % 13,
    }));
    const t0 = performance.now();
    const out = maybeRenderMarkdownTable({ items, count: items.length }, {
      format: "markdown",
    });
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(200);
    expect(out).toBeDefined();
    expect(out!.length).toBeLessThanOrEqual(25_000);
    // Truncation note must appear when the byte cap kicks in.
    expect(out).toContain("more rows omitted");
  });

  it("renders a small table fully (no truncation note)", () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      id: i,
      name: `row-${i}`,
    }));
    const out = maybeRenderMarkdownTable({ items, count: items.length }, {
      format: "markdown",
    });
    expect(out).toBeDefined();
    expect(out).not.toContain("more rows omitted");
    expect(out).toContain("| row-0 |");
    expect(out).toContain("| row-49 |");
  });
});
