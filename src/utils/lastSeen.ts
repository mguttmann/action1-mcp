export interface ConnectivityCheck {
  online: boolean;
  reason: string;
  lastSeen?: string;
  lastSeenAgeMinutes?: number;
}

/**
 * Default stale-after threshold (minutes). Every tool call site
 * (`startAction.ts` for the execution tools and `execute_and_wait`,
 * `endpoints.ts` for `get_endpoint` and `endpoints_summary`) passes the
 * configured ACTION1_LAST_SEEN_STALE_MINUTES; the constant is the
 * fallback for direct callers without a config in scope.
 *
 * Kept as a hardcoded default (no `loadConfig()` import) to avoid a
 * circular dependency: `loadConfig` is used by `destructiveGuard` which
 * is registered by `execution.ts` which already imports this module.
 * Inverting that with a top-level config import would create a cycle
 * via the `helpers` ↔ `config` edge on test boot.
 */
export const DEFAULT_LAST_SEEN_STALE_MINUTES = 10;

export function isEndpointActuallyOnline(
  general: unknown,
  staleAfterMinutes: number = DEFAULT_LAST_SEEN_STALE_MINUTES,
): ConnectivityCheck {
  if (!general || typeof general !== "object") {
    return { online: false, reason: "No endpoint data available." };
  }
  const obj = general as Record<string, unknown>;
  const status = pickString(obj, ["status", "connection_status"]);
  const lastSeen = pickString(obj, ["last_seen", "lastSeen", "last_seen_at"]);

  if (status && status.toLowerCase() !== "connected") {
    return {
      online: false,
      reason: `Endpoint status is "${status}".`,
      ...(lastSeen ? { lastSeen } : {}),
    };
  }

  if (lastSeen) {
    const ts = parseTimestamp(lastSeen);
    if (ts !== undefined) {
      const ageMinutes = (Date.now() - ts) / 60000;
      if (ageMinutes > staleAfterMinutes) {
        return {
          online: false,
          reason: `Status is "${status ?? "unknown"}" but last_seen=${lastSeen} is ${Math.round(ageMinutes)} minutes old (threshold: ${staleAfterMinutes}).`,
          lastSeen,
          lastSeenAgeMinutes: ageMinutes,
        };
      }
      return {
        online: true,
        reason: `Endpoint connected; last_seen ${Math.round(ageMinutes)} minutes ago.`,
        lastSeen,
        lastSeenAgeMinutes: ageMinutes,
      };
    }
  }

  if (status?.toLowerCase() === "connected") {
    return { online: true, reason: "Endpoint reports connected (no last_seen available)." };
  }

  return { online: false, reason: "Insufficient connectivity data." };
}

/**
 * Parse an Action1 timestamp string and return a Unix millisecond
 * epoch, or `undefined` when the input is unparseable.
 *
 * Action1 emits `last_seen` and similar fields in the non-standard
 * format `YYYY-MM-DD_HH-MM-SS` *without* a timezone designator. We
 * treat the absence of a zone as UTC for two reasons:
 *
 *   1. Action1 emits timestamps without timezone designator; per
 *      the Action1 API documentation these values are produced in
 *      UTC on the server side.
 *   2. Date.parse on an ISO-8601 string with no zone falls back to
 *      the *local* timezone, which would make `lastSeenAgeMinutes`
 *      vary by 23+ hours depending on where the MCP server runs.
 *
 * The function also accepts a real ISO-8601 string with an explicit
 * `Z` or `±HH:MM` zone (passing it through Date.parse unchanged).
 */
export function parseTimestamp(value: string): number | undefined {
  const isoLike =
    /^(\d{4})-(\d{2})-(\d{2})[_T](\d{2})[-:](\d{2})[-:](\d{2})(?:[.,](\d+))?(Z|[+-]\d{2}:?\d{2})?$/;
  const m = isoLike.exec(value);
  if (m) {
    const y = m[1];
    const mo = m[2];
    const d = m[3];
    const h = m[4];
    const mi = m[5];
    const s = m[6];
    const fraction = m[7] ? "." + m[7] : "";
    const zone = m[8] ?? "Z";
    const iso = y + "-" + mo + "-" + d + "T" + h + ":" + mi + ":" + s + fraction + zone;
    const ts = Date.parse(iso);
    if (!Number.isNaN(ts)) return ts;
  }
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? undefined : ts;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v;
    if (v && typeof v === "object") {
      const nested = (v as Record<string, unknown>).value;
      if (typeof nested === "string" && nested.length > 0) return nested;
    }
  }
  return undefined;
}
