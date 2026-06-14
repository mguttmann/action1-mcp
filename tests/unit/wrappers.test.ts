import { describe, expect, it } from "vitest";
import { fuzzyFind, UUID_RE } from "../../src/tools/wrappers/index.js";

describe("UUID_RE", () => {
  it("matches valid UUIDs", () => {
    expect(UUID_RE.test("00000000-1111-2222-3333-444444444444")).toBe(true);
    expect(UUID_RE.test("00000000-0000-0000-0000-000000000000")).toBe(true);
  });
  it("rejects non-UUIDs", () => {
    expect(UUID_RE.test("9f828cb7")).toBe(false);
    expect(UUID_RE.test("not-a-uuid-at-all-but-has-dashes")).toBe(false);
    expect(UUID_RE.test("")).toBe(false);
  });
});

describe("fuzzyFind", () => {
  const items = [
    { id: "a-1", name: "Marketing Laptops" },
    { id: "b-2", name: "Marketing Desktops" },
    { id: "c-3", name: "Engineering" },
    { id: "00000000-1111-2222-3333-444444444444", name: "Servers" },
  ];

  it("matches by exact id (UUID)", () => {
    const r = fuzzyFind(items, "00000000-1111-2222-3333-444444444444");
    expect(r.how).toBe("exact-id");
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]?.name).toBe("Servers");
  });

  it("matches by exact name (case-insensitive)", () => {
    const r = fuzzyFind(items, "ENGINEERING");
    expect(r.how).toBe("exact-name");
    expect(r.matches[0]?.id).toBe("c-3");
  });

  it("falls back to starts-with", () => {
    const r = fuzzyFind(items, "Marketing L");
    expect(r.how).toBe("starts-with");
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]?.id).toBe("a-1");
  });

  it("falls back to contains", () => {
    const r = fuzzyFind(items, "Desk");
    expect(r.how).toBe("contains");
    expect(r.matches[0]?.id).toBe("b-2");
  });

  it("returns multiple matches when starts-with hits more than one", () => {
    const r = fuzzyFind(items, "Marketing");
    expect(r.how).toBe("starts-with");
    expect(r.matches).toHaveLength(2);
  });

  it("returns none when no match", () => {
    const r = fuzzyFind(items, "Finance");
    expect(r.how).toBe("none");
    expect(r.matches).toHaveLength(0);
  });
});
