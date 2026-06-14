// Tunable response-size guards. The skill best-practice is a per-tool
// CHARACTER_LIMIT constant — defined centrally in src/constants.ts —
// so a typical 200-row Markdown table fits well under the 1 MB host
// limit AND under the model's context budget for follow-on operations.
import { CHARACTER_LIMIT } from "../constants.js";
import { formatHumanCell } from "./format.js";

export { CHARACTER_LIMIT };
const MAX_BYTES = CHARACTER_LIMIT;
const MAX_CELL = 200;

export interface RenderOptions {
  format?: "json" | "markdown";
  maxBytes?: number;
}

export function maybeRenderMarkdownTable(
  payload: unknown,
  opts: RenderOptions = {},
): string | undefined {
  if (opts.format !== "markdown") return undefined;
  const items = extractItems(payload);
  // For empty lists, return an explicit "no items" line so the agent
  // sees that the query ran successfully but yielded nothing —
  // distinguishable from "format unsupported, fall through to JSON".
  if (!items) return undefined;
  if (items.length === 0) {
    const meta = formatMetaLine(payload);
    return meta ? `_No items._\n\n${meta}` : "_No items._";
  }
  if (!items.every((i) => i && typeof i === "object" && !Array.isArray(i))) return undefined;
  const columns = pickColumns(items as Record<string, unknown>[]);
  if (columns.length === 0) return undefined;
  const cap = opts.maxBytes ?? MAX_BYTES;
  // Reserve a small budget for the trailing "...N more rows omitted" /
  // metadata footer so the final output stays under `cap` even when
  // truncation kicks in.
  const TRAILER_BUDGET = 200;
  const rowBudget = Math.max(cap - TRAILER_BUDGET, 0);
  const header = "| " + columns.join(" | ") + " |";
  const sep = "| " + columns.map(() => "---").join(" | ") + " |";
  const rows: string[] = [];
  let bytes = header.length + sep.length + 2;
  let truncated = 0;
  for (const item of items as Record<string, unknown>[]) {
    const cells = columns.map((c) => formatCell(formatHumanCell(c, item[c])));
    const row = "| " + cells.join(" | ") + " |";
    if (bytes + row.length + 1 > rowBudget) {
      truncated = items.length - rows.length;
      break;
    }
    rows.push(row);
    bytes += row.length + 1;
  }
  const out = [header, sep, ...rows];
  if (truncated > 0) out.push(`_..., ${truncated} more rows omitted_`);
  // Append pagination / total metadata so the agent can decide whether
  // to chain more calls.
  const meta = formatMetaLine(payload);
  if (meta) {
    out.push("");
    out.push(meta);
  }
  return out.join("\n");
}

function formatMetaLine(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const obj = payload as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof obj.count === "number") parts.push(`count=${obj.count}`);
  if (typeof obj.total === "number") parts.push(`total=${obj.total}`);
  if (typeof obj.has_more === "boolean") parts.push(`has_more=${obj.has_more}`);
  if (typeof obj.next_cursor === "string" && obj.next_cursor.length > 0) {
    parts.push(`next_cursor=${obj.next_cursor.slice(0, 24)}…`);
  }
  return parts.length ? `_${parts.join(" · ")}_` : undefined;
}

function extractItems(payload: unknown): unknown[] | undefined {
  if (Array.isArray(payload)) return payload as unknown[];
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const key of ["items", "data", "results", "rows"]) {
      const v = obj[key];
      if (Array.isArray(v)) return v as unknown[];
    }
  }
  return undefined;
}

function pickColumns(items: Record<string, unknown>[]): string[] {
  if (items.length === 0) return [];
  const counts = new Map<string, number>();
  for (const it of items) {
    for (const k of Object.keys(it)) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const universal = [...counts.entries()].filter(([, c]) => c === items.length).map(([k]) => k);
  if (universal.length > 0) {
    return preferIdFirst(universal).slice(0, 8);
  }
  return preferIdFirst([...counts.keys()]).slice(0, 8);
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
