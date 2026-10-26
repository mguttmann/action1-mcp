// CSV helpers shared by tools that return spreadsheet exports.

/**
 * Defuse Excel / spreadsheet formula-injection in a CSV blob. Any cell
 * whose first non-whitespace character is one of `= + - @ TAB CR` is
 * interpreted as a formula by Excel, Google Sheets, etc. Prefixing
 * with a single quote (`'`) is the conventional CSV-injection defence
 * (Excel honours it as a literal-text marker on import).
 *
 * Implementation notes:
 *   - Excel ignores leading whitespace (including NBSP and other
 *     Unicode whitespace) before a formula character, so
 *     `"  =cmd|x"` is a formula too. The check runs on the trimmed
 *     content.
 *   - `-100` and `+44 1234` are numeric / phone data, not formulas.
 *     `+`/`-` only count when the *next* char is also a
 *     formula-trigger (`=`, `+`, etc.) or a function-name letter, not
 *     a digit. Negative numbers and phone numbers therefore pass
 *     through unchanged.
 *   - RFC-4180 quoting is partially supported: a leading `"` opens a
 *     quoted cell that may contain commas. We do a slightly smarter
 *     split that respects quotes; full embedded-CRLF handling is out
 *     of scope (Action1's exports are line-oriented).
 */
export function sanitizeCsvFormulas(csv: string): string {
  if (!csv) return csv;
  return csv
    .split("\n")
    .map((line) => splitCsvLineRespectingQuotes(line).map(sanitizeCell).join(","))
    .join("\n");
}

const FORMULA_HAZARD_FIRST = /[=@\t\r]/;
const FORMULA_HAZARD_PLUS_MINUS = /[+\-]/;

function isHazardousCell(inner: string): boolean {
  // Trim leading whitespace (incl. NBSP / ZWSP / RTL marks).
  const trimmed = inner.replace(/^[\s ​‎‏]+/, "");
  if (!trimmed) return false;
  // An embedded CR / LF followed by a formula-trigger
  // can be re-interpreted by Excel as a soft-newline that starts a
  // fresh formula, so flag even when the first char is benign.
  if (/[\r\n][=+\-@]/.test(trimmed)) return true;
  const first = trimmed.charAt(0);
  if (FORMULA_HAZARD_FIRST.test(first)) return true;
  if (FORMULA_HAZARD_PLUS_MINUS.test(first)) {
    // `+`/`-` is hazardous only if it isn't followed by a digit /
    // dot / space (numeric / phone-number pattern). I.e.
    // `+cmd`/`-=cmd`/`-+1` are formulas; `+44`/`-100`/`-1.5e3`/`+ 7`
    // are data.
    const next = trimmed.charAt(1);
    return Boolean(next) && !/[0-9. ]/.test(next);
  }
  return false;
}

function sanitizeCell(cell: string): string {
  if (!cell) return cell;
  const isQuoted = cell.length >= 2 && cell.startsWith('"') && cell.endsWith('"');
  const inner = isQuoted ? cell.slice(1, -1) : cell;
  if (isHazardousCell(inner)) {
    const safe = "'" + inner;
    return isQuoted ? `"${safe}"` : safe;
  }
  return cell;
}

/**
 * Split a CSV line on commas while respecting double-quoted cells. A
 * `""` inside a quoted cell is the RFC-4180 escape for a literal `"`.
 * This is intentionally simpler than a full CSV parser: embedded
 * CRLF is not handled, but Action1's exports never contain it in
 * practice.
 */
function splitCsvLineRespectingQuotes(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line.charAt(i);
    if (inQuote) {
      if (c === '"' && line.charAt(i + 1) === '"') {
        current += '""';
        i += 1;
      } else if (c === '"') {
        inQuote = false;
        current += c;
      } else {
        current += c;
      }
    } else if (c === '"') {
      inQuote = true;
      current += c;
    } else if (c === ",") {
      cells.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  cells.push(current);
  return cells;
}
