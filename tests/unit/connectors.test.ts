import { describe, expect, it } from "vitest";
import { INCOMPLETE_TAIL_CONNECTORS, INCOMPLETE_TAIL_RE } from "../../src/codegen/connectors.js";
import { fitLead, fitTitle } from "../../src/codegen/generate.js";

// The codegen's connector-strip walks back past dangling clause-ending
// tokens like "...of." or "...the.". connectors.ts is a side-effect-free
// module (generate.ts runs main() on import) exporting two surfaces:
//   - INCOMPLETE_TAIL_CONNECTORS: the canonical token list
//   - INCOMPLETE_TAIL_RE: a compiled regex anchored at end-of-string
//
// These tests pin both surfaces so a silent regression (dropped token,
// regex anchor wrong) gets caught by CI.

describe("INCOMPLETE_TAIL_CONNECTORS", () => {
  it("includes determiners and quantifiers", () => {
    // Descriptions must not end on "...one." / "...their." / "...this.".
    // Pin the tokens so a future trim of the list can't drop them.
    for (const t of ["of", "the", "one", "their", "this", "that", "these", "those"]) {
      expect(INCOMPLETE_TAIL_CONNECTORS).toContain(t);
    }
  });

  it("includes prepositions, conjunctions, auxiliaries, temporal, quantifiers", () => {
    // Spot-check at least one token per documented category so a wholesale
    // deletion of a category gets caught.
    expect(INCOMPLETE_TAIL_CONNECTORS).toContain("of"); // preposition
    expect(INCOMPLETE_TAIL_CONNECTORS).toContain("and"); // conjunction
    expect(INCOMPLETE_TAIL_CONNECTORS).toContain("is"); // auxiliary
    expect(INCOMPLETE_TAIL_CONNECTORS).toContain("then"); // temporal
    expect(INCOMPLETE_TAIL_CONNECTORS).toContain("each"); // quantifier
    expect(INCOMPLETE_TAIL_CONNECTORS).toContain("this"); // determiner
  });

  it("contains no duplicate entries (canonical list)", () => {
    const set = new Set(INCOMPLETE_TAIL_CONNECTORS);
    expect(set.size).toBe(INCOMPLETE_TAIL_CONNECTORS.length);
  });

  it("contains 30+ tokens (catches accidental list truncation)", () => {
    // The documented coverage spans 7 categories with multiple tokens each.
    // A list that drops below 30 entries is almost certainly a bug.
    expect(INCOMPLETE_TAIL_CONNECTORS.length).toBeGreaterThanOrEqual(30);
  });
});

describe("INCOMPLETE_TAIL_RE", () => {
  it("matches a description ending on a connector + period", () => {
    expect(INCOMPLETE_TAIL_RE.test("This is a list of.")).toBe(true);
    expect(INCOMPLETE_TAIL_RE.test("Wait for the.")).toBe(true);
    expect(INCOMPLETE_TAIL_RE.test("Trigger one.")).toBe(true);
    expect(INCOMPLETE_TAIL_RE.test("Update their.")).toBe(true);
  });

  it("does NOT match a grammatically complete sentence", () => {
    // "fine" is not a connector; "ends" / "complete" / "endpoint" likewise.
    expect(INCOMPLETE_TAIL_RE.test("This sentence ends fine.")).toBe(false);
    expect(INCOMPLETE_TAIL_RE.test("The sentence is complete.")).toBe(false);
    expect(INCOMPLETE_TAIL_RE.test("Reboot the endpoint.")).toBe(false);
  });

  it("tolerates trailing whitespace after the period", () => {
    expect(INCOMPLETE_TAIL_RE.test("Wait for the.   ")).toBe(true);
    expect(INCOMPLETE_TAIL_RE.test("Wait for the.\n")).toBe(true);
    expect(INCOMPLETE_TAIL_RE.test("Wait for the.\t\n  ")).toBe(true);
  });

  it("is case-insensitive (catches Title-cased descriptions)", () => {
    expect(INCOMPLETE_TAIL_RE.test("Wait For The.")).toBe(true);
    expect(INCOMPLETE_TAIL_RE.test("WAIT FOR THE.")).toBe(true);
  });

  it("matches the tolerant pre-collapse form ('...the..')", () => {
    // The doc-comment on INCOMPLETE_TAIL_RE explicitly cites the
    // `[.\s]*\.+\s*$` tail accepting both pre- and post-collapse periods.
    // Pin that behaviour so a regex refactor doesn't silently regress it.
    expect(INCOMPLETE_TAIL_RE.test("Wait for the..")).toBe(true);
    expect(INCOMPLETE_TAIL_RE.test("Wait for the. .")).toBe(true);
  });

  it("requires a word-boundary before the connector", () => {
    // "Bathe." ends in "the." as a substring but NOT as a separate word.
    // The `\b` anchor in the regex must prevent a false positive.
    expect(INCOMPLETE_TAIL_RE.test("Bathe.")).toBe(false);
    // "Either." ends in "ther." which is NOT a connector token at word
    // boundary either.
    expect(INCOMPLETE_TAIL_RE.test("Lather.")).toBe(false);
  });

  it("does not flag connector words mid-sentence", () => {
    // Only the tail position matters - interior connectors are fine.
    expect(INCOMPLETE_TAIL_RE.test("One of the endpoints failed.")).toBe(false);
    expect(INCOMPLETE_TAIL_RE.test("Wait for the response to complete.")).toBe(false);
  });
});

// Cluster-D #2: lead-truncation now uses word-boundary backtrack + single
// "…" character. Prior fallback (`slice(0, 137) + "..."`) shipped
// mid-word stubs like "...specific v." / "...detailed inf.". The new
// `fitLead` helper plus the post-loop stub-regex catch both cases.
describe("fitLead (lead-truncation, Cluster-D #2)", () => {
  it("returns short input unchanged", () => {
    const short = "List all endpoints in the organisation.";
    expect(fitLead(short, 140)).toBe(short);
  });

  it("backtracks to a word boundary when the cap fires", () => {
    const long =
      "Documents applied compensating controls for a specific vulnerability. Adds documentation for an applied remediation action for specific vulnerability records.";
    const out = fitLead(long, 140);
    expect(out.length).toBeLessThanOrEqual(140);
    // No mid-word stub at the tail.
    expect(out).not.toMatch(/\b[a-z]{1,4}\.$/);
    // Ends with the ellipsis sentinel.
    expect(out).toMatch(/…$/);
  });

  it("drops a trailing connector word ('for', 'of') before the ellipsis", () => {
    // Construct a lead that, when sliced at maxChars, would land
    // immediately after the connector token "for".
    const lead =
      "Trigger a synchronous remediation cycle for vulnerabilities flagged as critical inside the calling organisation for ";
    const out = fitLead(lead, lead.length - 10);
    expect(out).toMatch(/…$/);
    // The connector at the cut point ("for") must be gone - neither
    // INCOMPLETE_TAIL_RE nor a bare connector word may sit at the
    // pre-ellipsis position.
    const beforeEllipsis = out.replace(/…$/, "").trim();
    const lastToken = beforeEllipsis.split(/\s+/).pop() ?? "";
    expect(["for", "of", "the", "a", "and"]).not.toContain(lastToken);
  });

  it("handles a short trailing word (1-letter stub) by trimming back further", () => {
    // The pathological case from the witness lines: a 1-2 letter
    // stub right after the cap. fitLead must word-boundary backtrack
    // BEFORE the stub.
    const lead = "Retrieves detailed information about a specific v";
    const out = fitLead(lead, lead.length);
    // Input is exactly at the cap → unchanged path
    expect(out).toBe(lead);
    // Now exceed the cap by one char.
    const out2 = fitLead(lead + "u", lead.length);
    expect(out2).toMatch(/…$/);
    expect(out2).not.toMatch(/\bv…$/);
  });

  it("treats exactly-maxChars as no-op (no ellipsis appended)", () => {
    const s = "x".repeat(140);
    expect(fitLead(s, 140)).toBe(s);
  });
});

describe("fitTitle (title-truncation, Cluster-D #7)", () => {
  it("returns short titles unchanged", () => {
    expect(fitTitle("List endpoints")).toBe("List endpoints");
  });

  it("caps over-long titles at the word boundary with a single ellipsis", () => {
    const long =
      "Detailed information on a specific vulnerability within an organization, including CVE details like attack vector.";
    const out = fitTitle(long);
    expect(out.length).toBeLessThan(long.length);
    expect(out).toMatch(/…$/);
    // No trailing punctuation before the ellipsis.
    expect(out).not.toMatch(/[.,;:!?]…$/);
  });

  it("never exceeds the 80-char budget (visual layout guard)", () => {
    const long = "a".repeat(100) + " bar";
    const out = fitTitle(long);
    // JS string length, NOT byte length. The "…" is one JS char.
    expect(out.length).toBeLessThanOrEqual(81); // 80 + 1 ellipsis
  });
});
