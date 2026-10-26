import { describe, it, expect } from "vitest";
import { compactItem } from "../../src/utils/capOutput.js";

describe("compactItem", () => {
  it("returns primitives unchanged", () => {
    expect(compactItem(null)).toBe(null);
    expect(compactItem(undefined)).toBe(undefined);
    expect(compactItem(42)).toBe(42);
    expect(compactItem(true)).toBe(true);
  });

  it("truncates long strings", () => {
    const long = "x".repeat(1000);
    const out = compactItem(long) as string;
    expect(out.length).toBeLessThan(500);
    expect(out).toContain("…(+");
    expect(out).toContain("chars truncated)");
  });

  it("leaves short strings unchanged", () => {
    expect(compactItem("hello")).toBe("hello");
  });

  it("replaces additional_actions arrays with a placeholder", () => {
    const item = {
      id: "abc",
      name: "Mozilla Firefox",
      versions: [
        {
          id: "v1",
          additional_actions: [
            { name: "before", params: { run_script_text: "x".repeat(5000) } },
            { name: "after", params: { run_script_text: "y".repeat(3000) } },
          ],
        },
      ],
    };
    const out = compactItem(item) as Record<string, unknown>;
    const v0 = (out.versions as Record<string, unknown>[])[0];
    expect(v0?.additional_actions).toMatch(/^\[truncated: 2 items/);
  });

  it("replaces binary_id and file_name nested objects", () => {
    const item = {
      versions: [
        {
          binary_id: { Windows_64: "blob1", Windows_ARM64: "blob2" },
          file_name: { Windows_64: { name: "x.exe", type: "cloud" } },
        },
      ],
    };
    const out = compactItem(item) as Record<string, unknown>;
    const v0 = (out.versions as Record<string, unknown>[])[0];
    expect(v0?.binary_id).toMatch(/^\[truncated: nested object/);
    expect(v0?.file_name).toMatch(/^\[truncated: nested object/);
  });

  it("truncates string-heavy fields like security_CVE and run_script_text", () => {
    const item = {
      run_script_text: "Function Main { ".repeat(500),
      security_CVE: Array.from({ length: 200 }, (_, i) => `CVE-2026-${i}`).join(", "),
      description: "Lorem ipsum ".repeat(500),
      name: "Mozilla Firefox", // short - must NOT be truncated
    };
    const out = compactItem(item) as Record<string, unknown>;
    expect(String(out.run_script_text).length).toBeLessThan(500);
    expect(String(out.security_CVE).length).toBeLessThan(500);
    expect(String(out.description).length).toBeLessThan(500);
    expect(out.name).toBe("Mozilla Firefox");
  });

  it("preserves identity / status / approval fields verbatim", () => {
    const item = {
      id: "Mozilla_Firefox_de_builtin",
      version: "150.0.1",
      status: "Published",
      approval_status: "New",
      update_sla_status: "Due soon",
      reboot_needed: "Unknown",
      kb_number: "None",
    };
    const out = compactItem(item);
    expect(out).toEqual(item);
  });

  it("recurses into nested arrays of objects", () => {
    const item = {
      items: [{ run_script_text: "x".repeat(1000) }, { run_script_text: "y".repeat(1000) }],
    };
    const out = compactItem(item) as Record<string, unknown>;
    const inner = out.items as Record<string, unknown>[];
    expect(inner).toHaveLength(2);
    expect(String(inner[0]?.run_script_text).length).toBeLessThan(500);
  });

  it("is idempotent: compact(compact(x)) === compact(x) (Cluster-D #5)", () => {
    // Prior bug: a 2nd pass would re-slice the already-truncated
    // string (which still exceeds COMPACT_STRING_CEILING because of
    // the marker), corrupting the marker and adding a 2nd marker on
    // top. The fix short-circuits when a string already ends with the
    // truncation marker.
    const sample = {
      run_script_text: "Function Main { ".repeat(500),
      security_CVE: Array.from({ length: 200 }, (_, i) => `CVE-2026-${i}`).join(", "),
      description: "Lorem ipsum ".repeat(500),
      name: "Mozilla Firefox",
      id: "abc",
      versions: [{ run_script_text: "x".repeat(5000) }],
    };
    const onePass = compactItem(sample);
    const twoPass = compactItem(onePass);
    expect(JSON.stringify(twoPass)).toBe(JSON.stringify(onePass));
  });

  it("idempotent on bare long strings", () => {
    const sample = "x".repeat(5_000);
    const onePass = compactItem(sample);
    const twoPass = compactItem(onePass);
    expect(twoPass).toBe(onePass);
  });
});
