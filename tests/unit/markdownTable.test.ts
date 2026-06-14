import { describe, expect, it } from "vitest";
import { maybeRenderMarkdownTable } from "../../src/utils/markdownTable.js";

describe("maybeRenderMarkdownTable", () => {
  it("returns undefined when format is not markdown", () => {
    expect(
      maybeRenderMarkdownTable({ items: [{ a: 1 }] }, { format: "json" }),
    ).toBeUndefined();
    expect(maybeRenderMarkdownTable({ items: [{ a: 1 }] })).toBeUndefined();
  });

  it("renders a basic table from {items:[...]}", () => {
    const out = maybeRenderMarkdownTable(
      { items: [{ id: "x", name: "X", v: 1 }, { id: "y", name: "Y", v: 2 }] },
      { format: "markdown" },
    );
    expect(out).toBeDefined();
    expect(out).toContain("| id | name | v |");
    expect(out).toContain("| x | X | 1 |");
    expect(out).toContain("| y | Y | 2 |");
  });

  it("escapes pipes inside cells", () => {
    const out = maybeRenderMarkdownTable(
      { items: [{ id: "x", v: "left|right" }] },
      { format: "markdown" },
    );
    expect(out).toContain("left\\|right");
  });

  it("defuses Markdown-link injection in cell content", () => {
    const out = maybeRenderMarkdownTable(
      { items: [{ id: "x", v: "[click](https://attacker.example/?token=)" }] },
      { format: "markdown" },
    );
    // Brackets must be escaped so the renderer does not produce a
    // clickable link.
    expect(out).toContain("\\[click\\]");
    expect(out).not.toMatch(/(?<!\\)\[click\]\(/);
  });

  it("defuses HTML tags in cell content", () => {
    const out = maybeRenderMarkdownTable(
      { items: [{ id: "x", v: "<script>alert(1)</script>" }] },
      { format: "markdown" },
    );
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<script>");
  });

  it("defuses HTML-entity-encoded tags (renderer-decode bypass)", () => {
    const out = maybeRenderMarkdownTable(
      { items: [{ id: "x", v: "&#60;script&#62;alert(1)&#60;/script&#62;" }] },
      { format: "markdown" },
    );
    // The leading `&` in the input is HTML-encoded so a permissive
    // renderer can't decode `&#60;` back into `<`. The `#` is also
    // escaped (Markdown heading marker), so we expect `&amp;\#60;`.
    expect(out).toContain("&amp;\\#60;");
    expect(out).not.toContain("&#60;");
  });

  it("escapes Markdown formatting markers (`*`, `_`, `~`, `` ` ``, `#`) in cells", () => {
    const out = maybeRenderMarkdownTable(
      { items: [{ id: "x", v: "**bold** _italic_ ~strike~ `code` #heading" }] },
      { format: "markdown" },
    );
    expect(out).toContain("\\*\\*bold\\*\\*");
    expect(out).toContain("\\_italic\\_");
    expect(out).toContain("\\~strike\\~");
    expect(out).toContain("\\`code\\`");
    expect(out).toContain("\\#heading");
  });

  it("escapes backslashes in cell content", () => {
    const out = maybeRenderMarkdownTable(
      { items: [{ id: "x", v: "C:\\Windows\\System32" }] },
      { format: "markdown" },
    );
    expect(out).toContain("C:\\\\Windows\\\\System32");
  });

  it("collapses newlines and CR to spaces", () => {
    const out = maybeRenderMarkdownTable(
      { items: [{ id: "x", v: "line1\nline2\r\nline3" }] },
      { format: "markdown" },
    );
    // No actual newline inside the cell.
    const lines = out!.split("\n");
    const dataLine = lines.find((l) => l.includes("line1"));
    expect(dataLine).toBeDefined();
    expect(dataLine).toContain("line1 line2");
  });

  it("truncates long cell values", () => {
    const long = "a".repeat(500);
    const out = maybeRenderMarkdownTable(
      { items: [{ id: "x", v: long }] },
      { format: "markdown" },
    );
    // row contains the truncated value plus surrounding cells/delimiters
    expect(out!.split("\n")[2]!.length).toBeLessThan(260);
    expect(out!).toContain("…");
  });

  it("falls back to undefined for non-tabular non-list payloads", () => {
    expect(
      maybeRenderMarkdownTable({ ok: true }, { format: "markdown" }),
    ).toBeUndefined();
    expect(maybeRenderMarkdownTable("string", { format: "markdown" })).toBeUndefined();
  });

  it("returns an explicit '_No items._' line for empty lists", () => {
    expect(maybeRenderMarkdownTable([], { format: "markdown" })).toBe("_No items._");
    expect(
      maybeRenderMarkdownTable({ items: [], count: 0 }, { format: "markdown" }),
    ).toContain("_No items._");
  });

  it("respects maxBytes and notes truncation", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i, v: "x".repeat(20) }));
    const out = maybeRenderMarkdownTable({ items }, { format: "markdown", maxBytes: 200 });
    expect(out).toContain("more rows omitted");
  });
});
