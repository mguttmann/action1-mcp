import { describe, expect, it } from "vitest";
import { maybeRenderMarkdownTable, renderMarkdownTable } from "../../src/utils/markdownTable.js";

describe("maybeRenderMarkdownTable", () => {
  it("returns undefined when format is not markdown", () => {
    expect(maybeRenderMarkdownTable({ items: [{ a: 1 }] }, { format: "json" })).toBeUndefined();
    expect(maybeRenderMarkdownTable({ items: [{ a: 1 }] })).toBeUndefined();
  });

  it("renders a basic table from {items:[...]}", () => {
    const out = maybeRenderMarkdownTable(
      {
        items: [
          { id: "x", name: "X", v: 1 },
          { id: "y", name: "Y", v: 2 },
        ],
      },
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
    const out = maybeRenderMarkdownTable({ items: [{ id: "x", v: long }] }, { format: "markdown" });
    // row contains the truncated value plus surrounding cells/delimiters
    expect(out!.split("\n")[2]!.length).toBeLessThan(260);
    expect(out!).toContain("…");
  });

  it("falls back to undefined for non-tabular non-list payloads", () => {
    expect(maybeRenderMarkdownTable({ ok: true }, { format: "markdown" })).toBeUndefined();
    expect(maybeRenderMarkdownTable("string", { format: "markdown" })).toBeUndefined();
  });

  it("returns an explicit '_No items._' line for empty lists", () => {
    expect(maybeRenderMarkdownTable([], { format: "markdown" })).toBe("_No items._");
    expect(maybeRenderMarkdownTable({ items: [], count: 0 }, { format: "markdown" })).toContain(
      "_No items._",
    );
  });

  it("respects maxBytes and notes truncation", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i, v: "x".repeat(20) }));
    const out = maybeRenderMarkdownTable({ items }, { format: "markdown", maxBytes: 200 });
    expect(out).toContain("more rows omitted");
  });

  it("prints next_cursor in full so text-only hosts can paginate", () => {
    const cursor = Buffer.from(
      JSON.stringify({ from: 1234, q: "0123456789abcdef", n: 1234 }),
    ).toString("base64");
    const out = maybeRenderMarkdownTable(
      { items: [{ id: 1 }], count: 1, has_more: true, next_cursor: cursor },
      { format: "markdown" },
    )!;
    expect(cursor.length).toBeGreaterThan(24);
    expect(out).toContain(`next_cursor: ${cursor}`);
  });

  it("prints the note and every other top-level field", () => {
    const out = maybeRenderMarkdownTable(
      {
        items: [{ id: 1 }],
        count: 1,
        note: "Per-item heavy fields were compacted. Pass `verbose: true`.",
        warning: "missing-updates returned 403",
        total_items: 900,
        next_page: "https://example.test/next?from=50",
      },
      { format: "markdown" },
    )!;
    expect(out).toContain("note: Per-item heavy fields were compacted. Pass `verbose: true`.");
    expect(out).toContain("warning: missing-updates returned 403");
    expect(out).toContain("total_items: 900");
    expect(out).toContain("next_page: https://example.test/next?from=50");
  });

  it("names the columns it does not show, including keys missing from some rows", () => {
    const items = [
      { id: 1, name: "a", c1: 1, c2: 2, c3: 3, c4: 4, c5: 5, c6: 6, severity: "High", cvss: 9.8 },
      {
        id: 2,
        name: "b",
        c1: 1,
        c2: 2,
        c3: 3,
        c4: 4,
        c5: 5,
        c6: 6,
        severity: "Low",
        cvss: 2.1,
        kb: "KB1",
      },
    ];
    const out = maybeRenderMarkdownTable({ items, count: 2 }, { format: "markdown" })!;
    expect(out).toMatch(/Columns not shown: severity, cvss, kb\b/);
    expect(out).toContain('response_format="json"');
  });

  it("reports how many rows it rendered", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i, v: "x".repeat(20) }));
    const r = renderMarkdownTable({ items, count: 100 }, { maxBytes: 1_000 })!;
    expect(r.rows).toBeGreaterThan(0);
    expect(r.rows).toBeLessThan(100);
    expect(r.text.split("\n").filter((l) => /^\| \d+ \|/.test(l))).toHaveLength(r.rows);
    expect(r.text).toContain(`${100 - r.rows} more rows omitted`);
  });
});
