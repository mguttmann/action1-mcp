// Tunable response-size guards. The per-tool CHARACTER_LIMIT is
// defined centrally in src/constants.ts, so a typical 200-row Markdown
// table fits well under the 1 MB host
// limit AND under the model's context budget for follow-on operations.
//
// Many hosts only show `content[].text` to the model, so the Markdown
// rendering must never drop information silently: rows that do not fit
// are counted, columns that are not shown are named, and every
// top-level field next to the item list (count, total, has_more, the
// full next_cursor, note, warnings, upstream envelope fields) is printed
// verbatim below the table.
import { CHARACTER_LIMIT } from "../constants.js";
import { formatHumanCell } from "./format.js";

export { CHARACTER_LIMIT };
const MAX_BYTES = CHARACTER_LIMIT;
const MAX_CELL = 200;
const MAX_COLUMNS = 8;
const ITEM_KEYS = ["items", "data", "results", "rows"] as const;
// Printed first, in this order; any other field follows in insertion order.
const META_FIRST = ["count", "total", "has_more", "next_cursor"];

export interface RenderOptions {
  format?: "json" | "markdown";
  maxBytes?: number;
}

export interface MarkdownTable {
  text: string;
  /** Number of item rows actually rendered. */
  rows: number;
  /** Number of items in the payload. */
  totalRows: number;
}

export function maybeRenderMarkdownTable(
  payload: unknown,
  opts: RenderOptions = {},
): string | undefined {
  if (opts.format !== "markdown") return undefined;
  return renderMarkdownTable(payload, opts)?.text;
}

/**
 * Render a list-shaped payload as a Markdown table plus metadata lines.
 * Returns undefined when the payload is not tabular (the caller then
 * falls back to JSON). Rows are cut at `maxBytes` characters; the
 * result reports how many were rendered so paginated callers can move
 * their cursor to the first row that was not shown.
 */
export function renderMarkdownTable(
  payload: unknown,
  opts: { maxBytes?: number } = {},
): MarkdownTable | undefined {
  const found = extractItems(payload);
  if (!found) return undefined;
  const { items, key } = found;
  const meta = formatMeta(payload, key);
  // For empty lists, return an explicit "no items" line so the agent
  // sees that the query ran successfully but yielded nothing,
  // distinguishable from "format unsupported, fall through to JSON".
  if (items.length === 0) {
    return { text: meta ? `_No items._\n\n${meta}` : "_No items._", rows: 0, totalRows: 0 };
  }
  if (!items.every((i) => i && typeof i === "object" && !Array.isArray(i))) return undefined;
  const records = items as Record<string, unknown>[];
  const { columns, omitted } = pickColumns(records);
  if (columns.length === 0) return undefined;
  const cap = opts.maxBytes ?? MAX_BYTES;
  const columnsLine = omitted.length
    ? `_Columns not shown: ${omitted.join(", ")}. Re-call with response_format="json" to see every field._`
    : undefined;
  // Reserve room for the "N more rows omitted" line, the omitted-columns
  // line and the metadata so the whole output stays near `cap`.
  const TRAILER_BUDGET = 200;
  const reserved = TRAILER_BUDGET + (columnsLine?.length ?? 0) + (meta?.length ?? 0);
  const rowBudget = Math.max(cap - reserved, 0);
  const header = "| " + columns.join(" | ") + " |";
  const sep = "| " + columns.map(() => "---").join(" | ") + " |";
  const rows: string[] = [];
  let bytes = header.length + sep.length + 2;
  for (const item of records) {
    const cells = columns.map((c) => formatCell(formatHumanCell(c, item[c])));
    const row = "| " + cells.join(" | ") + " |";
    // Always render at least one row, so a paginated caller that moves
    // its cursor to the first unrendered row makes progress.
    if (rows.length > 0 && bytes + row.length + 1 > rowBudget) break;
    rows.push(row);
    bytes += row.length + 1;
  }
  const out = [header, sep, ...rows];
  const omittedRows = records.length - rows.length;
  if (omittedRows > 0) {
    out.push(
      `_..., ${omittedRows} more rows omitted from this table. Re-call with response_format="json" (or a narrower filter) to receive them._`,
    );
  }
  if (columnsLine) out.push(columnsLine);
  if (meta) out.push("", meta);
  return { text: out.join("\n"), rows: rows.length, totalRows: records.length };
}

/**
 * Every top-level field except the item list, one `key: value` line
 * each. Values are printed in full (a shortened cursor cannot be used);
 * strings have line breaks collapsed so they cannot start Markdown
 * blocks, everything else is compact JSON.
 */
function formatMeta(payload: unknown, itemsKey: string | undefined): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const obj = payload as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => k !== itemsKey && obj[k] !== undefined);
  const ordered = [
    ...META_FIRST.filter((k) => keys.includes(k)),
    ...keys.filter((k) => !META_FIRST.includes(k)),
  ];
  const lines = ordered.map((k) => {
    const v = obj[k];
    const text = typeof v === "string" ? v.replace(/[\r\n]+/g, " ") : JSON.stringify(v);
    return `${k}: ${text}`;
  });
  return lines.length ? lines.join("\n") : undefined;
}

function extractItems(payload: unknown): { items: unknown[]; key?: string } | undefined {
  if (Array.isArray(payload)) return { items: payload as unknown[] };
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const key of ITEM_KEYS) {
      const v = obj[key];
      if (Array.isArray(v)) return { items: v as unknown[], key };
    }
  }
  return undefined;
}

function pickColumns(items: Record<string, unknown>[]): { columns: string[]; omitted: string[] } {
  const counts = new Map<string, number>();
  for (const it of items) {
    for (const k of Object.keys(it)) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const all = [...counts.keys()];
  const universal = all.filter((k) => counts.get(k) === items.length);
  const columns = preferIdFirst(universal.length > 0 ? universal : all).slice(0, MAX_COLUMNS);
  const omitted = all.filter((k) => !columns.includes(k));
  return { columns, omitted };
}

function preferIdFirst(keys: string[]): string[] {
  const lc = (k: string) => k.toLowerCase();
  const idLike = keys.filter((k) => lc(k) === "id" || lc(k).endsWith("_id"));
  const nameLike = keys.filter((k) => lc(k) === "name" || lc(k).endsWith("_name"));
  const rest = keys.filter((k) => !idLike.includes(k) && !nameLike.includes(k));
  return [...idLike, ...nameLike, ...rest];
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return truncate(escapePipes(v), MAX_CELL);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return truncate(escapePipes(JSON.stringify(v)), MAX_CELL);
  } catch {
    return "[object]";
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function escapePipes(s: string): string {
  // Markdown-active characters that an attacker-controlled cell value
  // might use to inject clickable links, images, HTML, or formatting
  // that breaks the table layout. We escape (in this exact order):
  //   - `\\`  → backslash literal (must be first so subsequent escapes
  //             don't double-escape).
  //   - `&`   → HTML-encode so that an upstream value that already
  //             contained `&#60;` (numeric HTML entity for `<`) doesn't
  //             get re-decoded by a permissive Markdown renderer into
  //             a live `<`.
  //   - `|`   → would split table cells.
  //   - `` ` `` → opens/closes a Markdown code-span; inside such a
  //             span our pipe-escapes are ignored, which can break
  //             cell-splitting downstream.
  //   - `[`/`]` → defuses Markdown link / image syntax.
  //   - `*`/`_`/`~` → bold / italic / strikethrough markers; primarily
  //             cosmetic, but prevent attacker-controlled bold-everything
  //             that hides content.
  //   - `#`   → at start of line would render as a Markdown heading; we
  //             escape unconditionally for simplicity.
  //   - `<`/`>` → defuses HTML tags.
  //   - newlines/CR → would break row layout (collapsed to spaces).
  return s
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "\\`")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/~/g, "\\~")
    .replace(/#/g, "\\#")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, " ")
    .replace(/\r/g, " ");
}
