// Shared formatting helpers used by Markdown rendering and any tool
// that produces human-readable output. The Action1 API returns
// timestamps in two flavours:
//
//   1. The historic console format `YYYY-MM-DD_HH-MM-SS` (UTC, local
//      to the Action1 server). Used on most endpoint records.
//   2. ISO-8601 datetimes used on automations.
//
// Both should render as `YYYY-MM-DD HH:MM:SS UTC` in human-friendly
// output so the agent can summarise to the user without re-parsing.
//
// Field-name heuristics live here too — they're the canonical list of
// "looks like a timestamp" / "looks like an id field" so the markdown
// table renderer doesn't have to guess.

const ACTION1_TS_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/;

/**
 * Detect Action1's `YYYY-MM-DD_HH-MM-SS` format and convert to
 * `YYYY-MM-DD HH:MM:SS UTC`. Pass-through for ISO datetimes (which
 * are already human-readable) and for anything that doesn't match.
 */
export function formatTimestamp(value: unknown): string {
  if (typeof value === "string") {
    // fall through to the format-detection branch below
  } else if (value === null || value === undefined) {
    return "";
  } else if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  } else {
    return JSON.stringify(value);
  }
  const m = ACTION1_TS_RE.exec(value);
  if (m) {
    const [, y, mo, d, h, mi, s] = m;
    return y + "-" + mo + "-" + d + " " + h + ":" + mi + ":" + s + " UTC";
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
    return value
      .replace(/T/, " ")
      .replace(/\.\d{3}Z$/, " UTC")
      .replace(/Z$/, " UTC")
      .replace(/([+-]\d{2}):?(\d{2})$/, " $1:$2");
  }
  return value;
}

const TIMESTAMP_FIELD_NAMES = new Set([
  "last_seen",
  "lastseen",
  "first_seen",
  "firstseen",
  "last_boot_time",
  "last_boot",
  "boot_time",
  "created",
  "created_at",
  "modified",
  "modified_at",
  "updated",
  "updated_at",
  "start_time",
  "start_at",
  "started",
  "started_at",
  "end_time",
  "end_at",
  "finished",
  "finished_at",
  "completed_at",
  "scheduled_at",
  "scheduled_for",
  "timestamp",
  "time",
  "event_time",
  "occurred_at",
  "run_at",
  "issued_at",
  "expires_at",
  "deadline",
]);

export function isTimestampField(name: string): boolean {
  return TIMESTAMP_FIELD_NAMES.has(name.toLowerCase());
}

/**
 * Render `name (id)` when both are present, otherwise whichever
 * value is non-empty. Keeps Markdown output discoverable for humans
 * while letting an agent still grep out the id.
 */
export function displayNameWithId(
  name: unknown,
  id: unknown,
): string {
  const n = typeof name === "string" && name.length > 0 ? name : undefined;
  const i = typeof id === "string" && id.length > 0 ? id : undefined;
  if (n && i) return n + " (" + i + ")";
  return n ?? i ?? "";
}

/**
 * Auto-format a cell value for human-readable Markdown output.
 *
 * Timestamps get human-readable formatting; everything else returns
 * as-is. The renderer combines this with pipe-escaping and length
 * truncation in `markdownTable.ts`.
 */
export function formatHumanCell(field: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (isTimestampField(field) && typeof value === "string") {
    return formatTimestamp(value);
  }
  return value;
}
