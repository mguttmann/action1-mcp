import { describe, expect, it } from "vitest";
import { capItemList } from "../../src/utils/capOutput.js";
import { renderMarkdownTable } from "../../src/utils/markdownTable.js";
import { stringifiedChars } from "../helpers/stringifyWork.js";

// Performance regressions on the hot path (capping + markdown
// rendering) directly translate to slow tool calls. These guards count
// work (serialised characters, cell reads) instead of wall-clock time,
// so they catch order-of-magnitude regressions without flaking on a
// loaded CI runner or under coverage instrumentation.

describe("capItemList - large list scaling", () => {
  it("trims a 10k-item list to fit a 50 KB byte cap with linear work", async () => {
    const items = Array.from({ length: 10_000 }, (_, i) => ({
      id: i,
      blob: "x".repeat(50),
    }));
    const inputChars = JSON.stringify(items).length;
    const { result: r, chars } = await stringifiedChars(() => capItemList(items, 50_000));
    expect(chars).toBeLessThanOrEqual(2 * inputChars);
    expect(r.returned).toBeLessThan(10_000);
    expect(r.truncated).toBeGreaterThan(0);
    expect(JSON.stringify(r.items).length).toBeLessThanOrEqual(50_000);
  });

  it("returns the full list when it already fits, serialising each item a bounded number of times", async () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ id: i }));
    const inputChars = JSON.stringify(items).length;
    const { result: r, chars } = await stringifiedChars(() => capItemList(items, 100_000));
    expect(chars).toBeLessThanOrEqual(2 * inputChars);
    expect(r.returned).toBe(500);
    expect(r.truncated).toBe(0);
  });
});

describe("renderMarkdownTable - large list scaling", () => {
  it("renders a 5k-row wide table under 25 KB and only reads the cells it renders", () => {
    let cellReads = 0;
    const items = Array.from({ length: 5_000 }, (_, i) => {
      const row = {
        id: i,
        name: `row-${i.toString().padStart(6, "0")}`,
        label: `human-readable-${i.toString().padStart(6, "0")}`,
        v: i % 13,
      };
      return new Proxy(row, {
        get(target, prop, receiver) {
          if (typeof prop === "string" && prop in target) cellReads += 1;
          return Reflect.get(target, prop, receiver) as unknown;
        },
      });
    });
    const out = renderMarkdownTable({ items, count: items.length });
    expect(out).toBeDefined();
    expect(out!.text.length).toBeLessThanOrEqual(25_000);
    // Truncation note must appear when the byte cap kicks in.
    expect(out!.text).toContain("more rows omitted");
    expect(out!.rows).toBeLessThan(5_000);
    // The renderer stops at the byte cap: every rendered row plus the
    // one row that no longer fit, four columns each. A renderer that
    // formats all 5 000 rows first would read 20 000 cells.
    expect(cellReads).toBeLessThanOrEqual(4 * (out!.rows + 1));
  });

  it("renders a small table fully (no truncation note)", () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      id: i,
      name: `row-${i}`,
    }));
    const out = renderMarkdownTable({ items, count: items.length });
    expect(out).toBeDefined();
    expect(out!.text).not.toContain("more rows omitted");
    expect(out!.text).toContain("| row-0 |");
    expect(out!.text).toContain("| row-49 |");
  });
});
