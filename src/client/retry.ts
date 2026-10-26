import { sleep } from "../utils/sleep.js";
import { log } from "../utils/logger.js";

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryOn: (err: unknown, attempt: number) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  signal?: AbortSignal;
}

export const DEFAULT_RETRY: Pick<RetryOptions, "maxAttempts" | "baseDelayMs" | "maxDelayMs"> = {
  maxAttempts: 5,
  baseDelayMs: 250,
  maxDelayMs: 4000,
};

/**
 * Maximum delay we honour from a server-supplied Retry-After before
 * clamping. Without a cap a hostile or buggy upstream could send
 * `Retry-After: 86400` and stall the worker for 24 hours; the
 * exponential schedule with jitter is a more sensible fallback past
 * the 60 s mark.
 */
export const RETRY_AFTER_CEILING_MS = 60_000;

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    if (opts.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === opts.maxAttempts || !opts.retryOn(err, attempt)) {
        throw err;
      }
      const retryAfterMs = extractRetryAfter(err);
      const computed = Math.min(opts.baseDelayMs * 2 ** (attempt - 1), opts.maxDelayMs);
      // ±25% jitter on the exponential schedule to avoid a thundering
      // herd when multiple parallel agents retry against the same
      // upstream simultaneously. Server-driven `Retry-After` values are
      // honoured verbatim and NOT jittered (the server told us when to
      // come back; randomising would undermine that).
      const jittered = computed * (0.75 + Math.random() * 0.5);
      const delay = retryAfterMs ?? jittered;
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay, opts.signal);
    }
  }
  throw lastErr;
}

function extractRetryAfter(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const maybe = err as { retryAfterMs?: unknown };
  if (typeof maybe.retryAfterMs === "number" && Number.isFinite(maybe.retryAfterMs)) {
    const requested = Math.max(0, maybe.retryAfterMs);
    if (requested > RETRY_AFTER_CEILING_MS) {
      // Cap absurd Retry-After values (the upstream told us to come
      // back in hours / days). Surface a warn-log once so operators
      // can spot a misbehaving upstream without drowning in noise on
      // every retry attempt.
      log.warn("retry_after_clamped", {
        requested_ms: requested,
        capped_ms: RETRY_AFTER_CEILING_MS,
      });
      return RETRY_AFTER_CEILING_MS;
    }
    return requested;
  }
  return undefined;
}

/**
 * Network failures that provably happened before any byte of the
 * request reached Action1 (DNS lookup or TCP connect failed). Retrying
 * these is safe even for non-idempotent methods.
 */
const PRE_SEND_NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * Transient network failures in general. The ones not in
 * PRE_SEND_NETWORK_CODES may happen after the request was sent, so they
 * are only retried for safe methods (GET/HEAD).
 */
const TRANSIENT_NETWORK_CODES = new Set([
  ...PRE_SEND_NETWORK_CODES,
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

function networkCodeIn(err: unknown, codes: Set<string>): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  if (typeof e.code === "string" && codes.has(e.code)) return true;
  if (e.cause && typeof e.cause === "object") {
    const code = e.cause.code;
    if (typeof code === "string" && codes.has(code)) return true;
  }
  return false;
}

export function isTransientNetworkError(err: unknown): boolean {
  return networkCodeIn(err, TRANSIENT_NETWORK_CODES);
}

export function isPreSendNetworkError(err: unknown): boolean {
  return networkCodeIn(err, PRE_SEND_NETWORK_CODES);
}
