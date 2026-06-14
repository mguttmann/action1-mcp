// Generic output-size cap. MCP hosts (Claude Desktop, Claude.ai) reject
// tool results larger than 1 MB total. The constant lives in
// src/constants.ts (`WIRE_LIMIT_BYTES`); see the comment there for the
// budget breakdown.

import { COMPACT_STRING_CEILING, WIRE_LIMIT_BYTES } from "../constants.js";

const DEFAULT_MAX_BYTES = WIRE_LIMIT_BYTES;

// Field-name patterns that the compactor treats as "structurally
// heavy" — these get replaced with a placeholder regardless of length
// when shrinking to fit a budget. They're the fields that have
// historically caused context-cap incidents.
const STRUCTURALLY_HEAVY_FIELDS = new Set<string>([
  "additional_actions",
  "EULA_text",
  "binary_id",
  "file_name",
  "internal_notes",
]);

// Field-name patterns that the compactor treats as "string-heavy" —
// these can be truncated even when they're below the byte budget,
// because they routinely carry huge payloads (full embedded scripts,
// CVE lists with 100+ entries) that the agent rarely needs verbatim.
//
// `internal_notes` is deliberately covered by both the structurally-
// heavy set (when it appears as a nested object/array) and the
// string-heavy patterns (when it appears as a long free-text string).
const STRING_HEAVY_FIELD_PATTERNS = [
  /script_text$/i,
  /^description$/i,
  /^security_CVE$/i,
  /^summary$/i,
  /^details$/i,
  /^notes$/i,
  /^internal_notes$/i,
];

export interface CapResult<T> {
  items: T[];
  total: number;
  returned: number;
  truncated: number;
  /**
   * Optional human-readable note describing degenerate truncation
   * scenarios (e.g. a single item that exceeded the byte budget).
   * When undefined the result fit cleanly and no caller action is
   * required.
   */
  note?: string;
}

/**
 * Placeholder shape emitted in place of a single record that exceeds
 * the byte cap on its own. Exposed so callers (and tests) can detect
 * the degenerate-oversize case without parsing the note string.
 */
export interface TruncatedItemPlaceholder {
  __truncated_item: true;
  __original_size_bytes: number;
  __reason: string;
}

/**
 * Trim a list down so that JSON.stringify of the result fits under
 * `maxBytes`. Uses a single linear walk with a running byte-cost
 * accumulator (each item costs `JSON.stringify(item).length` plus
 * one byte for the inter-item comma). The previous implementation
 * used binary search with `JSON.stringify(items.slice(0, mid))` on
 * every probe — that's O(n² log n) on a 5 000-item list because each
 * stringify scans a prefix proportional to `mid`. The linear walk
 * is O(n) total.
 *
 * Degenerate case: when the *first* item alone is bigger than
 * `maxBytes`, return a single placeholder record plus a `note`
 * pointing the caller at the per-record `get-by-id` tool. This
 * prevents the previous silent `{items: [], returned: 0,
 * truncated: 1}` response which left agents confused about why a
 * non-empty upstream list came back empty.
 *
 * Returns the trimmed list plus counters so the caller can attach a
 * truncation note to the response.
 */
export function capItemList<T>(items: T[], maxBytes = DEFAULT_MAX_BYTES): CapResult<T> {
  if (items.length === 0) {
    return { items: [], total: 0, returned: 0, truncated: 0 };
  }

  // Pre-compute the byte cost of each item once. `JSON.stringify`
  // is what the host actually measures; we add 1 byte for the
  // inter-item comma. Array brackets `[]` cost 2 bytes total.
  const BRACKET_BYTES = 2;
  const itemBytes: number[] = new Array<number>(items.length);
  for (let i = 0; i < items.length; i++) {
    itemBytes[i] = JSON.stringify(items[i]).length;
  }

  // Single-oversize-item shortcut: if the very first record already
  // exceeds the budget, emit a placeholder describing the failure
  // instead of returning an empty list.
  if (itemBytes[0]! + BRACKET_BYTES > maxBytes) {
    const placeholder: TruncatedItemPlaceholder = {
      __truncated_item: true,
      __original_size_bytes: itemBytes[0]!,
      __reason: `single item exceeded ${maxBytes}-byte cap`,
    };
    return {
      items: [placeholder as unknown as T],
      total: items.length,
      returned: 1,
      truncated: items.length,
      note: "Item too large to fit budget. Request individual record via the get-by-id tool.",
    };
  }

  // Linear accumulation: stop the first time appending the next
  // item would breach the cap.
  let running = BRACKET_BYTES;
  let cutoff = 0;
  for (let i = 0; i < items.length; i++) {
    // Each subsequent item adds itself plus a separating comma
    // (the first item contributes no comma since it follows `[`).
    const addition = itemBytes[i]! + (i === 0 ? 0 : 1);
    if (running + addition > maxBytes) {
      cutoff = i;
      break;
    }
    running += addition;
    cutoff = i + 1;
  }

  if (cutoff === items.length) {
    return { items, total: items.length, returned: items.length, truncated: 0 };
  }

  return {
    items: items.slice(0, cutoff),
    total: items.length,
    returned: cutoff,
    truncated: items.length - cutoff,
  };
}

/**
 * Generic structural compactor for arbitrary list items. Walks the
 * item recursively and:
 *   - truncates long strings to COMPACT_STRING_CEILING + a marker;
 *   - replaces "structurally heavy" sub-objects/arrays (additional
 *     actions, binary blobs, EULAs) with a stable placeholder;
 *   - keeps every identity / status / version / sla / approval field
 *     intact so the agent can still reason about the item.
 *
 * Use it on the inbound list before `capItemList` so the per-item
 * footprint is bounded. Callers can opt out by passing the raw record
 * through unchanged — the compactor is a separate, optional pass.
 *
 * Trade-off documented for the agent:
 *   embedded script bodies and full CVE lists are dropped from the
 *   default response. The agent gets a placeholder + count and can
 *   re-fetch the verbose form via `verbose: true` (when supported by
 *   the calling tool) or by hitting the resource directly.
 */
// Marker emitted by the compactor when it truncates a long string. Used
// as an idempotency guard: a value ending in this suffix has already
// been compacted and re-running the truncation would produce nonsense
// (the marker itself would get sliced off and replaced with another
// marker pointing at the now-shorter "original"). Treating the marker
// as a stop-condition keeps `compact(compact(x)) === compact(x)`.
const COMPACT_MARKER_SUFFIX = "chars truncated)";

function isAlreadyCompactedString(v: string): boolean {
  return v.length > COMPACT_STRING_CEILING && v.endsWith(COMPACT_MARKER_SUFFIX);
}

export function compactItem(raw: unknown): unknown {
  if (raw === null || raw === undefined) return raw;
  if (typeof raw === "string") {
    if (raw.length <= COMPACT_STRING_CEILING) return raw;
    // Idempotency: a previously compacted string still exceeds the
    // ceiling (the marker adds chars on top of the ceiling slice), so
    // the length-check alone re-fires. Short-circuit when we see the
    // sentinel suffix.
    if (isAlreadyCompactedString(raw)) return raw;
    return raw.slice(0, COMPACT_STRING_CEILING) + ` …(+${raw.length - COMPACT_STRING_CEILING} chars truncated)`;
  }
  if (typeof raw !== "object") return raw;
  if (Array.isArray(raw)) {
    return raw.map((v) => compactItem(v));
  }
  const obj = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (STRUCTURALLY_HEAVY_FIELDS.has(k)) {
      // Preserve a useful placeholder so the agent knows the field
      // existed and can re-request the verbose record if needed.
      if (Array.isArray(v)) {
        out[k] = `[truncated: ${v.length} items, request verbose=true to expand]`;
      } else if (v && typeof v === "object") {
        out[k] = "[truncated: nested object, request verbose=true to expand]";
      } else {
        out[k] = v;
      }
      continue;
    }
    if (typeof v === "string" && STRING_HEAVY_FIELD_PATTERNS.some((re) => re.test(k))) {
      // String-heavy fields get a tighter truncation because the agent
      // rarely needs the whole CVE wall or full description prose.
      if (v.length > COMPACT_STRING_CEILING && !isAlreadyCompactedString(v)) {
        out[k] = v.slice(0, COMPACT_STRING_CEILING) + ` …(+${v.length - COMPACT_STRING_CEILING} chars truncated)`;
        continue;
      }
    }
    out[k] = compactItem(v);
  }
  return out;
}

/**
 * Even denser projection — only the fields needed to identify, address,
 * and gate an endpoint. ~80-100 bytes per item versus ~500 in compact
 * form, so a 400 KB call holds 4-5 thousand endpoints in `bare` mode
 * versus 600-800 in `compact` mode.
 */
export function bareEndpoint(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const e = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if ("id" in e) out.id = e.id;
  if ("name" in e) out.name = e.name;
  if ("status" in e) out.status = e.status;
  if ("last_seen" in e) out.last_seen = e.last_seen;
  if ("OS" in e) out.OS = e.OS;
  if ("platform" in e) out.platform = e.platform;
  if ("online_status" in e) out.online_status = e.online_status;
  return out;
}

/**
 * Project an endpoint record down to a compact, agent-friendly shape.
 * Action1's full Endpoint object has 35-40 fields per item, which blows
 * past the 1 MB host limit at 100+ endpoints. The compact form keeps
 * just the fields the agent typically reasons about.
 */
export function compactEndpoint(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const e = raw as Record<string, unknown>;
  const compact: Record<string, unknown> = {};
  // Identity
  if ("id" in e) compact.id = e.id;
  if ("name" in e) compact.name = e.name;
  if ("address" in e) compact.address = e.address;
  // Connectivity
  if ("status" in e) compact.status = e.status;
  if ("online_status" in e) compact.online_status = e.online_status;
  if ("last_seen" in e) compact.last_seen = e.last_seen;
  if ("last_boot_time" in e) compact.last_boot_time = e.last_boot_time;
  if ("reboot_required" in e) compact.reboot_required = e.reboot_required;
  // Platform
  if ("OS" in e) compact.OS = e.OS;
  if ("platform" in e) compact.platform = e.platform;
  if ("architecture" in e) compact.architecture = e.architecture;
  if ("agent_version" in e) compact.agent_version = e.agent_version;
  // Person
  if ("user" in e) compact.user = e.user;
  // Health rollups
  if ("update_status" in e) compact.update_status = e.update_status;
  if ("vulnerability_status" in e) compact.vulnerability_status = e.vulnerability_status;
  return compact;
}
