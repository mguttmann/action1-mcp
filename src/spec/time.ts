// Action1 timestamps.
//
// The spec documents date-time values (AuditEvent.timestamp, the
// `timefrom` / `timeto` query parameters, last_seen, ...) in the format
// `YYYY-MM-DD_HH-MM-SS`, UTC, while its schemas also mark them
// `format: date-time`. Inputs accept both that format and ISO-8601;
// values sent to Action1 use the documented format.

import { z } from "zod";
import { parseTimestamp } from "../utils/lastSeen.js";

const ACTION1_TIME = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;
const ACTION1_OR_ISO =
  /^(?:\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))$/;

/** Epoch milliseconds of an Action1 or ISO-8601 timestamp; undefined when unparseable. */
export function parseAction1Time(value: string): number | undefined {
  return parseTimestamp(value);
}

/** `YYYY-MM-DD_HH-MM-SS` (UTC) for an Action1 or ISO-8601 input; undefined when unparseable. */
export function toAction1Time(value: string): string | undefined {
  if (ACTION1_TIME.test(value)) return value;
  const ms = parseTimestamp(value);
  if (ms === undefined) return undefined;
  return new Date(ms)
    .toISOString()
    .replace(/\.\d{3}Z$/, "")
    .replace("T", "_")
    .replace(/:/g, "-");
}

/**
 * Input schema for a date-time argument: the Action1 format
 * `YYYY-MM-DD_HH-MM-SS` (UTC) or ISO-8601 with a zone.
 */
export const action1TimeSchema = z
  .string()
  .regex(
    ACTION1_OR_ISO,
    "Expected YYYY-MM-DD_HH-MM-SS (UTC) or ISO-8601 with a zone, e.g. 2026-10-01T00:00:00Z.",
  )
  .refine((v) => parseTimestamp(v) !== undefined, "Not a valid date and time.");

/** Query value for a date-time parameter: the Action1 format when the input parses. */
export function action1TimeQuery(value: unknown): unknown {
  return typeof value === "string" ? (toAction1Time(value) ?? value) : value;
}
