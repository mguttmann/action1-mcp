import { timingSafeEqual } from "node:crypto";

/**
 * Pure-function variant of the HTTP Bearer-auth check used by the
 * `requireBearer` middleware in `createHttpApp` (src/http.ts).
 *
 * Returns:
 *   - "ok"      → request passes
 *   - "missing" → no Authorization header / not a Bearer scheme
 *   - "invalid" → token present but doesn't match (timing-safe)
 *
 * A separate module so tests can import and call it without loading
 * the entry point.
 */
export function checkBearerHeader(
  header: string | string[] | undefined,
  expectedToken: string,
): "ok" | "missing" | "invalid" {
  const raw = Array.isArray(header) ? (header[0] ?? "") : (header ?? "");
  const match = /^Bearer\s+([\s\S]+)$/.exec(raw);
  if (!match) return "missing";
  const providedStr = (match[1] ?? "").trim();
  if (providedStr.length === 0) return "missing";
  const provided = Buffer.from(providedStr, "utf8");
  const expected = Buffer.from(expectedToken.trim(), "utf8");
  if (provided.length !== expected.length) return "invalid";
  if (!timingSafeEqual(provided, expected)) return "invalid";
  return "ok";
}
