import { describe, expect, it } from "vitest";
import { sanitizeCsvFormulas } from "../../src/utils/csv.js";

// Adversarial probes against the CSV sanitiser. These pin the
// behaviour for the embedded-CR / embedded-LF + formula-trigger cases,
// a possible bypass.

describe("sanitizeCsvFormulas - adversarial probes", () => {
  it("flags an embedded CR followed by a formula trigger as hazardous", () => {
    // Excel can interpret CR mid-cell as a soft-newline that starts a
    // fresh formula. We prefix the cell with `'` regardless of the
    // leading character. The cell here is unquoted; the prefix lands
    // outside the quotes when the cell IS quoted.
    const out = sanitizeCsvFormulas("foo\r=cmd");
    expect(out).toContain("'foo");
    expect(out.startsWith("'foo")).toBe(true);
  });

  it("flags an embedded LF followed by a formula trigger", () => {
    const out = sanitizeCsvFormulas("foo\n=cmd");
    // The split-by-LF puts `=cmd` on its own line; that line starts
    // with `=` and gets prefixed.
    expect(out).toContain("'=cmd");
  });

  it("does NOT flag a benign embedded CR (no formula trigger after)", () => {
    expect(sanitizeCsvFormulas("foo\rbar")).toBe("foo\rbar");
  });

  it("preserves multiple-quote sequences in cell content", () => {
    // RFC-4180 escape: `""` inside a quoted cell means literal `"`.
    expect(sanitizeCsvFormulas('"a""b"')).toBe('"a""b"');
  });

  it("handles a row with mixed quoted and unquoted cells, only the dangerous one prefixed", () => {
    expect(sanitizeCsvFormulas('"normal","=evil","also normal"')).toBe(
      '"normal","\'=evil","also normal"',
    );
  });

  it("preserves a cell whose content is purely Unicode whitespace", () => {
    // `\t` alone is whitespace - trimmed to empty → not hazardous.
    expect(sanitizeCsvFormulas("\t")).toBe("\t");
  });

  it("flags an LRM-prefixed formula", () => {
    expect(sanitizeCsvFormulas("‎=cmd")).toBe("'‎=cmd");
  });

  it("flags an RTL-prefixed formula", () => {
    expect(sanitizeCsvFormulas("‏=cmd")).toBe("'‏=cmd");
  });

  it("preserves a header row that starts with `Endpoint` (no `+`/`-`/`=`)", () => {
    expect(sanitizeCsvFormulas("Endpoint,Status,LastSeen")).toBe("Endpoint,Status,LastSeen");
  });
});
