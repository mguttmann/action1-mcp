import { describe, expect, it } from "vitest";
import { capItemList, compactEndpoint } from "../../src/utils/capOutput.js";
import { jsonResult } from "../../src/tools/helpers.js";

describe("capItemList", () => {
  it("returns the full list when it fits", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: i, x: "small" }));
    const r = capItemList(items, 10_000);
    expect(r.returned).toBe(10);
    expect(r.truncated).toBe(0);
    expect(r.total).toBe(10);
  });

  it("trims to the largest prefix that fits", () => {
    const big = "x".repeat(1000);
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i, blob: big }));
    const r = capItemList(items, 10_000);
    expect(r.returned).toBeLessThan(100);
    expect(r.returned).toBeGreaterThan(0);
    expect(r.truncated).toBe(100 - r.returned);
    expect(r.total).toBe(100);
    expect(JSON.stringify(r.items).length).toBeLessThanOrEqual(10_000);
  });

  it("returns an empty list when the input is empty", () => {
    const r = capItemList([], 10_000);
    expect(r.returned).toBe(0);
    expect(r.truncated).toBe(0);
    expect(r.total).toBe(0);
  });

  it("emits a single placeholder + note when the first item exceeds the cap", () => {
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

  it("runs in linear time over large lists (5.2 perf regression guard)", () => {
    // 5 000 mid-sized items. The previous binary-search variant
    // called JSON.stringify on a prefix at every probe, giving
    // O(n² log n) wall-clock; the linear version should sail
    // through this in well under a second on any dev machine.
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
    // 250 ms is a comfortable ceiling — the binary-search variant
    // takes seconds on the same input. Loose enough not to flake
    // in CI, tight enough to fail on a regression to O(n²).
    expect(elapsedMs).toBeLessThan(250);
  });
});

describe("compactEndpoint", () => {
  it("projects only the documented fields", () => {
    const raw = {
      id: "x",
      name: "host-1",
      OS: "Windows 11",
      AD_organization_unit: "should-drop",
      MAC: "should-drop",
      WiFi: "should-drop",
      status: "Connected",
      last_seen: "2026-05-04_12-00-00",
    };
    const out = compactEndpoint(raw);
    expect(out.id).toBe("x");
    expect(out.name).toBe("host-1");
    expect(out.OS).toBe("Windows 11");
    expect(out.status).toBe("Connected");
    expect(out.last_seen).toBe("2026-05-04_12-00-00");
    expect("AD_organization_unit" in out).toBe(false);
    expect("MAC" in out).toBe(false);
    expect("WiFi" in out).toBe(false);
  });

  it("returns an empty object for non-objects", () => {
    expect(compactEndpoint(null)).toEqual({});
    expect(compactEndpoint(undefined)).toEqual({});
    expect(compactEndpoint("string")).toEqual({});
  });
});

describe("jsonResult — compact text block carries the data", () => {
  it("emits compact JSON (no indent) so the model can read the data even when the host hides structuredContent", () => {
    const r = jsonResult({ a: 1, b: 2 }, { a: 1, b: 2 });
    const text = (r.content[0] as { text: string }).text;
    // Compact JSON — no indentation, no extra whitespace
    expect(text).toBe('{"a":1,"b":2}');
    expect(r.structuredContent).toEqual({ a: 1, b: 2 });
  });

  it("renders items[] as a Markdown table by default (skill best practice)", () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: i }));
    const structured = { items, count: items.length };
    const r = jsonResult(structured, structured);
    const text = (r.content[0] as { text: string }).text;
    // Markdown table — header + separator + rows
    expect(text).toContain("| id |");
    expect(text).toContain("| --- |");
    expect(text).toContain("| 0 |");
    expect(text).toContain("| 49 |");
  });

  it("emits compact JSON when response_format=json is requested explicitly", () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ id: i }));
    const structured = { items, count: items.length };
    const r = jsonResult(structured, structured, "json");
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain('"items":');
    expect(text).toContain('"id":0');
  });

  it("returns string values verbatim (no JSON-wrapping)", () => {
    const r = jsonResult("plain string");
    expect((r.content[0] as { text: string }).text).toBe("plain string");
  });
});
