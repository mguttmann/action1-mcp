// Generic output-size cap. MCP hosts (Claude Desktop, Claude.ai) reject
// tool results larger than 1 MB total. The constant lives in
// src/constants.ts (`WIRE_LIMIT_BYTES`); see the comment there for the
// budget breakdown.

import { COMPACT_STRING_CEILING, WIRE_LIMIT_BYTES } from "../constants.js";

const DEFAULT_MAX_BYTES = WIRE_LIMIT_BYTES;

// Field-name patterns that the compactor treats as "structurally
// heavy" - these get replaced with a placeholder regardless of length
// when shrinking to fit a budget. They hold licence texts, nested
// action lists, upload metadata and notes that the agent rarely needs
// and that would otherwise fill the output budget.
const STRUCTURALLY_HEAVY_FIELDS = new Set<string>([
  "additional_actions",
  "EULA_text",
  "binary_id",
  "file_name",
  "internal_notes",
]);

// Field-name patterns that the compactor treats as "string-heavy" -
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
 * the degenerate-oversize case without parsing the note string. `id`
 * is copied from the original record when it has one, so the caller
 * can fetch it individually.
 */
export interface TruncatedItemPlaceholder {
  __truncated_item: true;
  __original_size_bytes: number;
  __reason: string;
  id?: string | number;
}

const OVERSIZE_NOTE =
  "Item too large to fit budget and replaced by a `__truncated_item` placeholder. Request individual record via the get-by-id tool.";

/**
 * Size of `JSON.stringify(value)` in UTF-8 bytes, which is what the
 * host measures on the wire. `.length` would count UTF-16 code units
 * and under-count umlauts, CJK and emoji by a factor of 2 to 4.
 */
export function jsonByteLength(value: unknown): number {
  const s = JSON.stringify(value);
  return s === undefined ? 0 : Buffer.byteLength(s, "utf8");
}

export function oversizePlaceholder(
  item: unknown,
  sizeBytes: number,
  maxBytes: number,
): TruncatedItemPlaceholder {
  const placeholder: TruncatedItemPlaceholder = {
    __truncated_item: true,
    __original_size_bytes: sizeBytes,
    __reason: `single item exceeded ${maxBytes}-byte cap`,
  };
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const id = (item as Record<string, unknown>).id;
    if (typeof id === "string" || typeof id === "number") placeholder.id = id;
  }
  return placeholder;
}

/**
 * Incremental cap: keeps the longest prefix whose JSON array fits
 * `maxBytes` (UTF-8, `[`/`]` and commas included), replaces any single
 * record that alone exceeds the budget with a placeholder, and keeps
 * counting (without storing) once the budget is full.
 */
class CapAccumulator<T> {
  private readonly items: T[] = [];
  private total = 0;
  private oversize = 0;
  private full = false;
  private running = 2;

  constructor(private readonly maxBytes: number) {}

  add(item: T): void {
    this.total += 1;
    if (this.full) return;
    const comma = this.items.length === 0 ? 0 : 1;
    let size = jsonByteLength(item);
    if (size + 2 > this.maxBytes) {
      item = oversizePlaceholder(item, size, this.maxBytes) as T;
      size = jsonByteLength(item);
      this.oversize += 1;
    }
    if (this.running + comma + size > this.maxBytes) {
      this.full = true;
      return;
    }
    this.items.push(item);
    this.running += comma + size;
  }

  result(): CapResult<T> {
    const out: CapResult<T> = {
      items: this.items,
      total: this.total,
      returned: this.items.length,
      truncated: this.total - this.items.length,
    };
    if (this.oversize > 0) out.note = OVERSIZE_NOTE;
    return out;
  }
}

/**
 * Trim a list down so that JSON.stringify of the result fits under
 * `maxBytes` (UTF-8 bytes). Single linear walk with a running byte
 * counter (each item costs its own size plus one byte for the comma),
 * O(n) total.
 *
 * A record that alone exceeds `maxBytes` is replaced in place by a
 * `__truncated_item` placeholder plus a `note` pointing the caller at
 * the per-record `get-by-id` tool; the records after it are kept.
 *
 * Returns the trimmed list plus counters so the caller can attach a
 * truncation note to the response.
 */
export function capItemList<T>(items: T[], maxBytes = DEFAULT_MAX_BYTES): CapResult<T> {
  const acc = new CapAccumulator<T>(maxBytes);
  for (const item of items) acc.add(item);
  return acc.result();
}

/**
 * Streaming variant of `capItemList` for paginated sources: only the
 * records that fit the budget are kept in memory, the rest are counted
 * so `total` stays exact.
 */
export async function capItemStream<T>(
  source: AsyncIterable<unknown>,
  opts: { maxBytes?: number; project: (raw: unknown) => T },
): Promise<CapResult<T>> {
  const acc = new CapAccumulator<T>(opts.maxBytes ?? DEFAULT_MAX_BYTES);
  for await (const raw of source) acc.add(opts.project(raw));
  return acc.result();
}

// Shrink levels for `fitToByteBudget`, from gentle to aggressive:
// maximum string length (chars) and maximum array length.
const SHRINK_LEVELS: ReadonlyArray<readonly [number, number]> = [
  [65_536, 5_000],
  [16_384, 1_000],
  [4_096, 200],
  [1_024, 50],
  [256, 10],
  [64, 3],
];

function truncateString(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + ` …(+${s.length - max} chars truncated)`;
}

function shrinkValue(v: unknown, maxString: number, maxArray: number): unknown {
  if (typeof v === "string") return truncateString(v, maxString);
  if (!v || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.slice(0, maxArray).map((x) => shrinkValue(x, maxString, maxArray));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    out[k] = shrinkValue(x, maxString, maxArray);
  }
  return out;
}

export interface FitResult {
  value: unknown;
  truncated: boolean;
  /** Human-readable description of what was cut, when `truncated`. */
  note?: string;
}

/**
 * Make an arbitrary value fit a byte budget. Strings are cut with a
 * visible `(+N chars truncated)` marker and arrays are shortened, with
 * progressively tighter limits until `measure(value) <= maxBytes`.
 * Used as the last-line guard for single objects, script output and raw
 * responses that no list cap covers.
 */
export function fitToByteBudget(
  value: unknown,
  maxBytes: number,
  measure: (v: unknown) => number = jsonByteLength,
): FitResult {
  if (measure(value) <= maxBytes) return { value, truncated: false };
  for (const [maxString, maxArray] of SHRINK_LEVELS) {
    const shrunk = shrinkValue(value, maxString, maxArray);
    if (measure(shrunk) <= maxBytes) {
      return {
        value: shrunk,
        truncated: true,
        note: `Response exceeded the ${maxBytes}-byte budget: strings longer than ${maxString} chars were cut (marked "chars truncated") and arrays were shortened to ${maxArray} elements. Use a narrower query or a per-id tool to read the full data.`,
      };
    }
  }
  return {
    value: undefined,
    truncated: true,
    note: `Response exceeded the ${maxBytes}-byte budget and could not be shrunk. Use a narrower query or a per-id tool.`,
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
 * through unchanged - the compactor is a separate, optional pass.
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
    return (
      raw.slice(0, COMPACT_STRING_CEILING) +
      ` …(+${raw.length - COMPACT_STRING_CEILING} chars truncated)`
    );
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
        out[k] = `[truncated: ${v.length} items]`;
      } else if (v && typeof v === "object") {
        out[k] = "[truncated: nested object]";
      } else {
        out[k] = v;
      }
      continue;
    }
    if (typeof v === "string" && STRING_HEAVY_FIELD_PATTERNS.some((re) => re.test(k))) {
      // String-heavy fields get a tighter truncation because the agent
      // rarely needs the whole CVE wall or full description prose.
      if (v.length > COMPACT_STRING_CEILING && !isAlreadyCompactedString(v)) {
        out[k] =
          v.slice(0, COMPACT_STRING_CEILING) +
          ` …(+${v.length - COMPACT_STRING_CEILING} chars truncated)`;
        continue;
      }
    }
    out[k] = compactItem(v);
  }
  return out;
}

/**
 * Even denser projection - only the fields needed to identify, address,
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
