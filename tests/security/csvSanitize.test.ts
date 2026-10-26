import { describe, expect, it } from "vitest";
import { sanitizeCsvFormulas } from "../../src/utils/csv.js";

// Three classes of CSV-injection / data-corruption risks. These tests
// pin the behaviour:
//
//  1. Whitespace / NBSP / leading-quote bypasses are caught.
//  2. Negative numbers and phone numbers are NOT corrupted.
//  3. Quoted cells with embedded commas split correctly (RFC-4180-ish).

describe("sanitizeCsvFormulas - pin behaviour", () => {
  it("prefixes a leading = with single quote", () => {
    expect(sanitizeCsvFormulas("=cmd|x")).toBe("'=cmd|x");
  });

  it("prefixes a leading @ with single quote", () => {
    expect(sanitizeCsvFormulas("@SUM(A1)")).toBe("'@SUM(A1)");
  });

  it("prefixes a leading TAB with single quote", () => {
    expect(sanitizeCsvFormulas("\t=evil")).toBe("'\t=evil");
  });

  it("catches a whitespace-prefixed formula", () => {
    expect(sanitizeCsvFormulas("  =cmd|x")).toBe("'  =cmd|x");
  });

  it("catches an NBSP-prefixed formula", () => {
    expect(sanitizeCsvFormulas(" =cmd|x")).toBe("' =cmd|x");
  });

  it("catches a leading-quoted formula", () => {
    expect(sanitizeCsvFormulas('"=cmd|x"')).toBe('"\'=cmd|x"');
  });

  it("does NOT corrupt a negative integer", () => {
    expect(sanitizeCsvFormulas("-100")).toBe("-100");
  });

  it("does NOT corrupt a negative decimal", () => {
    expect(sanitizeCsvFormulas("-1.5e3")).toBe("-1.5e3");
  });

  it("does NOT corrupt an international phone number", () => {
    expect(sanitizeCsvFormulas("+44 1234")).toBe("+44 1234");
  });

  it("DOES catch a `+` prefix that's not numeric", () => {
    expect(sanitizeCsvFormulas("+cmd|/c calc")).toBe("'+cmd|/c calc");
  });

  it("DOES catch a `-` prefix that's not numeric (e.g. `-=cmd`)", () => {
    expect(sanitizeCsvFormulas("-=cmd")).toBe("'-=cmd");
  });

  it("respects RFC-4180 quoted commas in cell content", () => {
    // The literal CSV `"hello, world",=cmd` has 2 cells: `"hello, world"`
    // (the comma is inside quotes) and `=cmd` (a hazardous one).
    const out = sanitizeCsvFormulas('"hello, world",=cmd');
    expect(out).toBe('"hello, world",\'=cmd');
  });

  it("operates line-by-line on multi-row CSV", () => {
    const csv = "a,b,c\n=evil,2,3\n4,5,6";
    expect(sanitizeCsvFormulas(csv)).toBe("a,b,c\n'=evil,2,3\n4,5,6");
  });

  it("handles empty input", () => {
    expect(sanitizeCsvFormulas("")).toBe("");
  });

  it("preserves header row that starts with a non-formula word", () => {
    expect(sanitizeCsvFormulas("Endpoint,Status,LastSeen")).toBe("Endpoint,Status,LastSeen");
  });
});
