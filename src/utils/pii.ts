import { loadConfig } from "../config.js";

// ACTION1_REDACT_PII: data minimisation for what reaches the LLM
// provider. When on, the values of personal-data fields are replaced in
// every tool result, resource read and upstream error text. Off by
// default: the fleet data is what the tools are for.
//
// The key set follows the vendored Action1 OpenAPI spec:
// tests/security/pii.test.ts derives every personal-data property from
// it (format email/ipv4/ipv6, IP and address names, Active Directory
// fields, people and device identifiers) and fails when one of them is
// not masked here.

// Case-insensitive name rules: IPs (ip, *_ip, ip_address, ipv4/6),
// e-mail (email, *_email), addresses (address, *_address such as
// external_address), logged-in or logged-on user, people's names, phone,
// serials, MACs. Keys are normalised first (see `normaliseKey`), so the
// column display names of report rows (`fields["User Name"]`,
// `fields["IP Address"]`, `fields["Logged On User"]`) match as well.
const PII_KEY =
  /^(?:user|users|user_?name|login|(?:.+_)?logged_?(?:in|on)_?users?|(?:.+_)?e_?mail|email_?address|(?:.+_)?address|(?:.+_)?ip|ip_?address(?:es)?|ipv[46]|mac|mac_?address|serial|serial_?number|phone|first_?name|last_?name|full_?name)$/i;

// Active Directory placement and group membership (AD_organization_unit,
// AD_security_groups). Case-sensitive: `ad_domain` in the agent
// deployment payload is a "1"/"0" switch, not personal data.
const AD_KEY = /^AD_/;

// Spec properties typed `format: email` whose names the rules above do
// not cover.
const SPEC_EMAIL_KEYS = new Set(["closure_requested_by"]);

/**
 * Report rows (`/reportdata`) and CSV exports name their values by the
 * column's display name ("User Name", "E-mail"). Spaces and hyphens
 * become `_` so one rule set covers spec keys and display names; the
 * case is kept for the case-sensitive AD rule.
 */
function normaliseKey(key: string): string {
  return key.trim().replace(/[\s-]+/g, "_");
}

/** Whether the value of `key` is personal data under ACTION1_REDACT_PII. */
export function isPiiKey(key: string): boolean {
  const k = normaliseKey(key);
  return PII_KEY.test(k) || AD_KEY.test(k) || SPEC_EMAIL_KEYS.has(k);
}

export const PII_PLACEHOLDER = "[REDACTED:pii]";

/** Return a copy of `value` with the values of personal-data keys masked. */
export function redactPii(value: unknown, depth = 0): unknown {
  if (depth > 32 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactPii(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] =
      isPiiKey(k) && v !== null && v !== undefined ? PII_PLACEHOLDER : redactPii(v, depth + 1);
  }
  return out;
}

/** Whether ACTION1_REDACT_PII is on; false while no valid config is loaded. */
export function piiRedactionEnabled(): boolean {
  try {
    return loadConfig().redactPii;
  } catch {
    return false;
  }
}

/**
 * Mask personal data in a text that may be a JSON document (an upstream
 * error body). Non-JSON text is returned unchanged: without keys there
 * is nothing to match.
 */
export function redactPiiInText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
  try {
    return JSON.stringify(redactPii(JSON.parse(trimmed)));
  } catch {
    return text;
  }
}

/**
 * Mask personal data in a text body of the Action1 API: a JSON document
 * as in `redactPiiInText`, otherwise a CSV export (see `redactPiiInCsv`).
 */
export function redactPiiInBody(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return redactPiiInText(text);
  return redactPiiInCsv(text);
}

/**
 * Mask the personal-data columns of a CSV export. The first record is
 * the header; every column whose name `isPiiKey` matches has its cells
 * replaced in all later records. Quoted cells (with `""` escapes,
 * delimiters and line breaks inside) are parsed per RFC 4180; the
 * delimiter is the most frequent of `,` `;` and tab in the header.
 * Text without such a header is returned unchanged.
 */
export function redactPiiInCsv(text: string): string {
  if (!text) return text;
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = text.slice(bom.length);
  const firstLine = body.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = detectDelimiter(firstLine);
  const { records, newline } = parseCsv(body, delimiter);
  const header = records[0];
  if (!header) return text;
  const piiColumns = header
    .map((cell, i) => (isPiiKey(unquoteCell(cell)) ? i : -1))
    .filter((i) => i >= 0);
  if (piiColumns.length === 0) return text;
  for (const record of records.slice(1)) {
    for (const i of piiColumns) {
      const cell = record[i];
      if (cell !== undefined && unquoteCell(cell) !== "") record[i] = PII_PLACEHOLDER;
    }
  }
  return bom + records.map((r) => r.join(delimiter)).join(newline);
}

function detectDelimiter(headerLine: string): string {
  let best = ",";
  let bestCount = 0;
  for (const d of [",", ";", "\t"]) {
    const count = headerLine.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

function unquoteCell(cell: string): string {
  const t = cell.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/""/g, '"');
  }
  return t;
}

/**
 * Split CSV text into records of raw cells (quotes kept, so unmasked
 * cells are written back byte for byte). Record breaks are `\n` or
 * `\r\n` outside quotes; the first one seen is used when joining.
 */
function parseCsv(text: string, delimiter: string): { records: string[][]; newline: string } {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let inQuote = false;
  let newline: string | undefined;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charAt(i);
    if (inQuote) {
      if (c === '"' && text.charAt(i + 1) === '"') {
        cell += '""';
        i += 1;
      } else {
        if (c === '"') inQuote = false;
        cell += c;
      }
    } else if (c === '"') {
      inQuote = true;
      cell += c;
    } else if (c === delimiter) {
      record.push(cell);
      cell = "";
    } else if (c === "\n" || (c === "\r" && text.charAt(i + 1) === "\n")) {
      const nl = c === "\r" ? "\r\n" : "\n";
      newline ??= nl;
      if (c === "\r") i += 1;
      record.push(cell);
      records.push(record);
      record = [];
      cell = "";
    } else {
      cell += c;
    }
  }
  // The last record, or the empty record after a trailing line break
  // (kept so the join restores that line break).
  record.push(cell);
  records.push(record);
  return { records, newline: newline ?? "\n" };
}
