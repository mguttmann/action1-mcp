import { inspect } from "node:util";
import { currentRequestContext } from "./requestContext.js";

export type LogLevel =
  "debug" | "info" | "notice" | "warning" | "warn" | "error" | "critical" | "alert" | "emergency";

// Maps the syslog level names (as used by MCP) to an internal rank.
// "warn" and "warning" share a rank, so ACTION1_LOG_LEVEL accepts both.
const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  notice: 25,
  warn: 30,
  warning: 30,
  error: 40,
  critical: 50,
  alert: 60,
  emergency: 70,
};

const DEFAULT_LEVEL = (process.env.ACTION1_LOG_LEVEL ?? "info").trim().toLowerCase() as LogLevel;
let currentLevel: LogLevel = LEVEL_RANK[DEFAULT_LEVEL] !== undefined ? DEFAULT_LEVEL : "info";

export function setLogLevel(level: LogLevel): void {
  // future SDK enum-loosening tolerates unknown levels gracefully -
  // an unknown value is logged as a warning and silently ignored
  // instead of crashing the request handler that called us.
  if (LEVEL_RANK[level] === undefined) {
    log.warn("unknown_log_level", { requested: level });
    return;
  }
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

const REDACT_VALUE_PATTERNS: RegExp[] = [
  // Full RFC-6750 token68 charset (including `~` and `*`). Action1
  // tokens are base64url today, but a narrower class would stop at an
  // unexpected character and leak the rest of the token.
  /Bearer\s+[A-Za-z0-9._~*\-+/=]+/gi,
  /api-key-[A-Za-z0-9.@_\-+/]+/gi,
  /\bsk-[A-Za-z0-9_\-]{16,}\b/g,
  // Bare JWT (header.payload.signature) - caught even when the leading
  // "Bearer " prefix is missing, e.g. when an Action1 error body
  // includes a token verbatim or when a refresh-token shows up in a
  // non-standard field. Pattern: 3 base64url chunks separated by dots,
  // each with at least 8 chars to avoid matching short version strings
  // like "1.2.3-rc.5".
  /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/g,
  // URL-embedded basic-auth credentials (https://user:password@host).
  /(https?:\/\/)[^:/?#@\s]+:[^@\s]+@/gi,
  // JSON or form-encoded credential key/value pairs that an upstream
  // OAuth-server might echo verbatim into a 4xx response body. Catches
  // e.g. `"client_secret":"32hex"`, `client_secret=32hex`,
  // `"refresh_token": "..."` and similar. Defence-in-Depth - RFC 6749
  // forbids servers from returning the secret, but the redactor MUST
  // assume that an upstream might do so anyway.
  /(["']?(?:client_secret|refresh_token|access_token|api_key|password)["']?\s*[:=]\s*["']?)[^"',&\s}]+/gi,
  // Cookie / Set-Cookie / x-action1-token header-shapes. Header values
  // are session-bearing - a leak here is as bad as a Bearer-token leak.
  // The capture group preserves the field name for debug-readability;
  // the value (until terminator chars) is replaced with [REDACTED].
  /(["']?(?:cookie|set-cookie|x-action1-token)["']?\s*[:=]\s*["']?)[^"',\n\r}]+/gi,
];

// Key-pattern order matters. The more-specific token patterns
// (`access[_-]?token`, `refresh[_-]?token`, `id[_-]?token`) MUST be
// checked before the bare `^token$` pattern so a key named
// `access_token` is matched on its specific pattern - which is the
// intent - and not silently degraded into a generic "bare token"
// match. The bare-token catch is the last resort for raw `token`
// fields that some upstream servers emit verbatim.
const REDACT_KEY_PATTERNS: RegExp[] = [
  /authorization/i,
  /api[_-]?key/i,
  /access[_-]?token/i,
  /refresh[_-]?token/i,
  /id[_-]?token/i,
  /client[_-]?secret/i,
  /^secret$/i,
  /password/i,
  /\bbearer\b/i,
  /^x[-_]action1[-_]token$/i,
  /^cookie$/i,
  /^set[-_]cookie$/i,
  /^token$/i,
];

const REDACTED = "[REDACTED]";

function shouldRedactKey(key: string): boolean {
  return REDACT_KEY_PATTERNS.some((re) => re.test(key));
}

export function redact(input: unknown, depth = 0, visited?: WeakSet<object>): unknown {
  if (depth > 6) return "[truncated]";
  if (input === null || input === undefined) return input;
  if (typeof input === "string") return redactString(input);
  if (typeof input === "number" || typeof input === "boolean") return input;
  // Binary buffers serialise byte-by-byte under Object.entries(), which
  // bloats a 28-byte buffer into a 28-key object full of integers and
  // bypasses every secret-shaped-key check (the keys are "0", "1", …).
  // Short-circuit with a stable placeholder that preserves the length
  // for debug-readability without leaking content.
  if (typeof Buffer !== "undefined" && Buffer.isBuffer?.(input)) {
    return `[binary ${input.length}B]`;
  }
  if (input instanceof Uint8Array) {
    return `[binary ${input.length}B]`;
  }
  if (Array.isArray(input)) {
    const tracker = visited ?? new WeakSet<object>();
    if (tracker.has(input)) return "[circular]";
    tracker.add(input);
    return input.map((v) => redact(v, depth + 1, tracker));
  }
  if (input instanceof Error) {
    return {
      name: input.name,
      message: redactString(input.message),
      ...(typeof input.stack === "string" ? { stack: redactString(input.stack) } : {}),
    };
  }
  if (typeof input === "object") {
    const tracker = visited ?? new WeakSet<object>();
    if (tracker.has(input)) return "[circular]";
    tracker.add(input);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (shouldRedactKey(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = redact(v, depth + 1, tracker);
      }
    }
    return out;
  }
  return inspect(input, { depth: 1 });
}

/**
 * Mask the values of credential-shaped keys (the same key patterns as
 * `redact`) at any depth, without touching other values: used on
 * successful tool results and resource reads, where `redact`'s depth
 * cut-off and free-text patterns would damage legitimate data. Strings
 * (script output) are returned unchanged.
 */
export function redactSecretKeys(input: unknown, depth = 0): unknown {
  if (input === null || typeof input !== "object" || depth > 256) return input;
  if (Array.isArray(input)) return input.map((v) => redactSecretKeys(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] =
      shouldRedactKey(k) && v !== null && v !== undefined
        ? REDACTED
        : redactSecretKeys(v, depth + 1);
  }
  return out;
}

/**
 * Redaction for the dry-run preview of a mutating call: the person who
 * confirms must see every value that will be sent, so unlike `redact`
 * there is no depth cut-off at 6 (deploy bodies nest update filters at
 * actions[].params.filters[].values[]). Credential-shaped keys are
 * masked as in `redactSecretKeys`, and strings go through the
 * free-text patterns of `redactString` (a Bearer token in a script).
 */
export function redactPreview(input: unknown, depth = 0): unknown {
  if (depth > 256) return "[truncated]";
  if (typeof input === "string") return redactString(input);
  if (input === null || typeof input !== "object") return input;
  if (Array.isArray(input)) return input.map((v) => redactPreview(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] =
      shouldRedactKey(k) && v !== null && v !== undefined ? REDACTED : redactPreview(v, depth + 1);
  }
  return out;
}

export function redactString(s: string): string {
  let out = s;
  for (const re of REDACT_VALUE_PATTERNS) {
    // When the regex captured a prefix (group 1, e.g.
    // `"client_secret":"`), keep it in the output and replace only
    // the value - that preserves the field name for debug-readability
    // while removing the secret. Patterns without a capture group
    // fall back to a full-match replace.
    out = out.replace(re, (_match, prefix?: string) =>
      typeof prefix === "string" && prefix.length > 0 ? prefix + REDACTED : REDACTED,
    );
  }
  return out;
}

export interface LogEvent {
  level: LogLevel;
  msg: string;
  meta?: Record<string, unknown>;
}

// Per-entry meta-payload ceilings. A pathological `meta` (an entire
// 1 000-endpoint response dropped into a debug log) can easily push
// stderr into the megabytes during a sweep. Truncate when the
// serialised payload exceeds the soft cap and replace it with a
// stable placeholder + counter so callers still see something useful.
const META_SOFT_CAP_BYTES = 8 * 1024;
const META_HARD_CAP_BYTES = 4 * 1024;

// Throughput throttling. DEBUG-level scans across 1 000+ endpoints
// can produce thousands of log lines per minute; once we exceed the
// budget we sample down to ~10% and emit a single
// `logger_throttled` summary per sample window so observers know
// they're seeing a subset. Only debug and info entries are counted and
// sampled: notice and above (audit events such as
// destructive_executed, warnings, errors) are always written.
const THROTTLE_LIMIT_PER_MINUTE = 1000;
const THROTTLE_WINDOW_MS = 60_000;
const THROTTLE_SAMPLE_DIVISOR = 10;

interface ThrottleState {
  windowStart: number;
  count: number; // entries observed in the current window (all levels)
  dropped: number; // entries silently dropped during sampling
  summaryEmittedAt: number; // last time we wrote `logger_throttled`
}

const throttle: ThrottleState = {
  windowStart: 0,
  count: 0,
  dropped: 0,
  summaryEmittedAt: 0,
};

function truncateMetaIfHuge(meta: Record<string, unknown>): Record<string, unknown> {
  let serialised: string;
  try {
    serialised = JSON.stringify(meta);
  } catch {
    return { __truncated: true, __reason: "meta_serialise_failed" };
  }
  if (serialised.length <= META_SOFT_CAP_BYTES) return meta;
  return {
    __truncated: true,
    __original_size_bytes: serialised.length,
    payload_prefix: serialised.slice(0, META_HARD_CAP_BYTES),
  };
}

function shouldEmitUnderThrottle(now: number): { emit: boolean; flushSummary: boolean } {
  // Roll the window forward when more than 60 s have elapsed.
  if (now - throttle.windowStart >= THROTTLE_WINDOW_MS) {
    throttle.windowStart = now;
    throttle.count = 0;
    throttle.dropped = 0;
  }
  throttle.count += 1;
  if (throttle.count <= THROTTLE_LIMIT_PER_MINUTE) {
    return { emit: true, flushSummary: false };
  }
  // Past the limit - sample at 1/N. Use the running count as the
  // sampling key so the cadence is deterministic (no Math.random
  // here, the test would be flaky).
  const sampled = throttle.count % THROTTLE_SAMPLE_DIVISOR === 0;
  if (!sampled) {
    throttle.dropped += 1;
    return { emit: false, flushSummary: false };
  }
  // Emit at most one summary per sample period so we don't drown the
  // throttled output in `logger_throttled` lines.
  const summaryDue = now - throttle.summaryEmittedAt >= THROTTLE_WINDOW_MS;
  return { emit: true, flushSummary: summaryDue };
}

function writeLine(record: Record<string, unknown>): void {
  try {
    process.stderr.write(JSON.stringify(record) + "\n");
  } catch {
    process.stderr.write(`{"level":"error","msg":"logger_serialise_failed"}\n`);
  }
}

/** Levels below this rank are subject to the throttle. */
const THROTTLED_BELOW_RANK = LEVEL_RANK.notice;

function emit(level: LogLevel, msg: string, meta?: Record<string, unknown>, always = false): void {
  if (!always && LEVEL_RANK[level] < LEVEL_RANK[currentLevel]) return;

  const now = Date.now();
  const decision =
    !always && LEVEL_RANK[level] < THROTTLED_BELOW_RANK
      ? shouldEmitUnderThrottle(now)
      : { emit: true, flushSummary: false };
  if (!decision.emit) return;

  if (decision.flushSummary) {
    throttle.summaryEmittedAt = now;
    writeLine({
      ts: new Date(now).toISOString(),
      level: "notice",
      msg: "logger_throttled",
      meta: {
        window_ms: THROTTLE_WINDOW_MS,
        limit_per_window: THROTTLE_LIMIT_PER_MINUTE,
        sample_divisor: THROTTLE_SAMPLE_DIVISOR,
        dropped_in_window: throttle.dropped,
      },
    });
  }

  const record: Record<string, unknown> = {
    ts: new Date(now).toISOString(),
    level,
    msg: redactString(msg),
  };
  // Correlation id: every line written while a tool call runs carries
  // the id of that call, so its tool_call event, retries and guard
  // decisions can be joined.
  const ctx = currentRequestContext();
  if (ctx) record.request_id = ctx.requestId;
  if (meta) record.meta = truncateMetaIfHuge(redact(meta) as Record<string, unknown>);
  writeLine(record);
}

/**
 * Write a `critical` JSON line for an error that is about to end the
 * process. Bypasses the level filter and the throttle, so the last line
 * of a crashed process is always a parseable record.
 */
export function logFatal(msg: string, err: unknown): void {
  writeLine({
    ts: new Date().toISOString(),
    level: "critical",
    msg: redactString(msg),
    meta: {
      error: redact(err instanceof Error ? err : { message: String(err) }),
    },
  });
}

/**
 * Reset the logger's throttle counters. Intended for tests that need
 * deterministic behaviour across cases; production callers should
 * leave this alone.
 *
 * Gated on NODE_ENV=test / VITEST=true so a tool author cannot import
 * this from a generated tool module to silently uncap stderr.
 */
export function __resetLoggerThrottleForTests(): void {
  if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
    throw new Error("__resetLoggerThrottleForTests is test-only");
  }
  throttle.windowStart = 0;
  throttle.count = 0;
  throttle.dropped = 0;
  throttle.summaryEmittedAt = 0;
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  notice: (msg: string, meta?: Record<string, unknown>) => emit("notice", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  warning: (msg: string, meta?: Record<string, unknown>) => emit("warning", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
  critical: (msg: string, meta?: Record<string, unknown>) => emit("critical", msg, meta),
  /**
   * Audit event (destructive_refused, destructive_executed, HTTP
   * rejections): written at level notice regardless of
   * ACTION1_LOG_LEVEL and never throttled, so an operator cannot lose
   * the audit trail by lowering the log volume.
   */
  audit: (msg: string, meta?: Record<string, unknown>) => emit("notice", msg, meta, true),
};
