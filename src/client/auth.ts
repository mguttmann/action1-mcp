import { Action1AuthError } from "./errors.js";
import { withRetry } from "./retry.js";
import { log } from "../utils/logger.js";
import { DEFAULT_TOKEN_TIMEOUT_MS, type AppConfig } from "../config.js";

interface CachedToken {
  accessToken: string;
  refreshToken: string | undefined;
  expiresAt: number;
}

const REFRESH_LEAD_MS = 5 * 60 * 1000;

/**
 * Bounded retry for the client_credentials request: transient failures
 * (network error, timeout, HTTP 429/5xx) are retried, credential errors
 * are not. Re-requesting a token has no side effect beyond issuing a
 * token, so a retry is safe even if the first attempt reached Action1.
 */
const TOKEN_RETRY = { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 1000 };

/**
 * Token state for the readiness probe, derived without any network call:
 * `cached` (a valid token is held), `failing` (the most recent
 * acquisition failed and no valid token is held), `not_acquired`
 * (nothing fetched yet, or the cached token expired).
 */
export type TokenState = "cached" | "failing" | "not_acquired";

/**
 * OAuth2 token source for one Action1 credential. Requests a token with
 * client_credentials, renews it with the refresh token when Action1
 * issued one (falling back to client_credentials), and renews it five
 * minutes before it expires. Concurrent callers share one in-flight
 * request. Token requests refuse redirects, so the client secret is only
 * ever sent to `ACTION1_BASE_URL`.
 */
export class TokenProvider {
  private cache: CachedToken | undefined;
  private inFlight: Promise<CachedToken> | undefined;
  private lastAcquisitionFailed = false;

  /** See TokenState. Makes no upstream call. */
  state(now = Date.now()): TokenState {
    if (this.cache && this.cache.expiresAt > now) return "cached";
    return this.lastAcquisitionFailed ? "failing" : "not_acquired";
  }

  constructor(private readonly cfg: AppConfig) {}

  /**
   * A valid access token: the cached one, or a new one when none is
   * cached or it expires within five minutes. Throws `Action1AuthError`
   * when the token request fails; transient failures are retried a
   * bounded number of times first.
   */
  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt - now > REFRESH_LEAD_MS) {
      return this.cache.accessToken;
    }
    return (await this.fetchOrJoinInFlight()).accessToken;
  }

  /** Drop the cached token, e.g. after Action1 answered 401, so the next call fetches a new one. */
  invalidate(): void {
    this.cache = undefined;
  }

  /**
   * In-flight-dedup so that N concurrent tool-calls trigger AT MOST one
   * `acquire()` round-trip. Implementation:
   * - We expose the SAME promise to every caller until it settles.
   * - `.finally()` clears `inFlight` regardless of resolve/reject so the
   *   next caller (post-settle) starts a fresh attempt instead of being
   *   handed a dead resolved-or-rejected promise.
   * - If `acquire()` throws after partially mutating `this.cache` (no
   *   path does this today - `cache` is only set on success), every
   *   joined waiter receives the same rejection. That's the intended
   *   contract: a failing refresh must visibly fail every dependent
   *   request rather than silently feed them a torn cache. Future
   *   changes to `acquire()` MUST preserve "either cache is fully
   *   updated, or it isn't touched at all".
   */
  private async fetchOrJoinInFlight(): Promise<CachedToken> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.acquire()
      .then(
        (token) => {
          this.lastAcquisitionFailed = false;
          return token;
        },
        (err: unknown) => {
          this.lastAcquisitionFailed = true;
          throw err;
        },
      )
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  private async acquire(): Promise<CachedToken> {
    if (this.cache?.refreshToken) {
      try {
        const refreshed = await this.exchange({
          grant_type: "refresh_token",
          refresh_token: this.cache.refreshToken,
        });
        log.debug("token_refreshed_via_refresh_token");
        this.cache = refreshed;
        return refreshed;
      } catch (err) {
        log.warn("refresh_token_failed_falling_back_to_client_credentials", {
          error: err instanceof Error ? err.message : String(err),
        });
        // The refresh token is dead - drop it from the cache so we
        // don't keep trying it on every subsequent acquire(). The
        // client_credentials path below issues a fresh refresh_token
        // anyway, but until then we'd otherwise re-attempt the dead
        // one on every cold-cache lookup.
        this.cache = undefined;
      }
    }
    const fresh = await withRetry(
      () =>
        this.exchange({
          client_id: this.cfg.clientId,
          client_secret: this.cfg.clientSecret,
        }),
      {
        ...TOKEN_RETRY,
        retryOn: (err) => err instanceof Action1AuthError && err.transient,
      },
    );
    log.debug("token_acquired_via_client_credentials");
    this.cache = fresh;
    return fresh;
  }

  private async exchange(form: Record<string, string>): Promise<CachedToken> {
    const url = `${this.cfg.baseUrl}/oauth2/token`;
    // Wire format (pinned by tests/unit/auth.test.ts): form-encoded body,
    // no Accept header. The client_credentials request sends client_id +
    // client_secret without grant_type; the refresh request sends
    // grant_type=refresh_token + refresh_token. Both flows work against
    // production Action1 tenants in this shape. The pinned OpenAPI spec
    // documents a JSON body instead (client_credentials: client_id +
    // client_secret; refresh: client_id + refresh_token + grant_type).
    // A failed refresh falls back to client_credentials below, so a
    // refresh rejected for the missing client_id costs one extra round
    // trip, not an outage. The format is deliberately left unchanged
    // until a switch has been verified against a live tenant: a wrong
    // guess here breaks every token acquisition.
    const body = new URLSearchParams(form);
    const timeoutMs = this.cfg.tokenTimeoutMs ?? DEFAULT_TOKEN_TIMEOUT_MS;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
        // Never follow a redirect: it would re-send client_id and
        // client_secret to whatever origin the Location header names.
        redirect: "error",
      });
    } catch (err) {
      if (isRedirectError(err)) {
        throw new Action1AuthError(
          `Action1 token endpoint at ${url} answered with a redirect, which is refused so the client secret is never sent to another location. Check ACTION1_BASE_URL (use the API host itself, e.g. https://app.eu.action1.com/api/3.0).`,
        );
      }
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new Action1AuthError(
          `Action1 token endpoint at ${url} timed out after ${timeoutMs} ms (ACTION1_TOKEN_TIMEOUT_MS).`,
          { transient: true },
        );
      }
      throw new Action1AuthError(
        `Failed to reach Action1 token endpoint at ${url}: ${describeError(err)}`,
        // A fetch rejection is a network-level failure (DNS, connect,
        // reset); worth another attempt for an idempotent token request.
        { transient: true },
      );
    }

    if (!res.ok) {
      const text = await safeReadText(res);
      throw new Action1AuthError(
        `Token request failed (HTTP ${res.status}). Verify ACTION1_CLIENT_ID/ACTION1_CLIENT_SECRET and ACTION1_BASE_URL.${text ? ` Body: ${truncate(text, 300)}` : ""}`,
        { transient: res.status === 429 || res.status >= 500 },
      );
    }

    let data: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      throw new Action1AuthError(
        `Token endpoint returned HTTP ${res.status} but the body is not valid JSON. Check ACTION1_BASE_URL (a proxy or login page may be answering instead of Action1).`,
      );
    }
    if (typeof data?.access_token !== "string" || !data.access_token) {
      throw new Action1AuthError("Token endpoint returned no access_token.");
    }
    // Clamp `expires_in` into a sane range. An upstream-supplied 0
    // would force a refresh on every request (and an in-flight-dedup
    // thrash); a value of 99,999,999 would freeze the cache for 3+
    // years (token already revoked upstream → silent 401 storms). The
    // bounds 60 s / 24 h are coarse but unambiguous: shorter than 60 s
    // is unworkable for the lead-time refresh window, longer than 24 h
    // is outside any sane OAuth provider config.
    const expiresIn = clampExpiresIn(data.expires_in);
    return {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
      expiresAt: Date.now() + expiresIn * 1000,
    };
  }
}

const EXPIRES_IN_MIN_S = 60;
const EXPIRES_IN_MAX_S = 24 * 3600;
const EXPIRES_IN_DEFAULT_S = 3600;
let clampWarnedForRange = false;

function clampExpiresIn(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return EXPIRES_IN_DEFAULT_S;
  }
  if (raw < EXPIRES_IN_MIN_S || raw > EXPIRES_IN_MAX_S) {
    // One-shot warn: a misbehaving upstream shouldn't spam the log on
    // every refresh. Reset on process restart is fine - operators will
    // notice the warning at deploy time. The clamp itself remains
    // active for every call (this guard only suppresses the log).
    if (!clampWarnedForRange) {
      clampWarnedForRange = true;
      log.warn("expires_in_clamped", {
        received: raw,
        clamped_to: Math.max(EXPIRES_IN_MIN_S, Math.min(raw, EXPIRES_IN_MAX_S)),
        min: EXPIRES_IN_MIN_S,
        max: EXPIRES_IN_MAX_S,
      });
    }
  }
  return Math.max(EXPIRES_IN_MIN_S, Math.min(raw, EXPIRES_IN_MAX_S));
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

/**
 * True for the fetch rejection that `redirect: "error"` produces when
 * the server answers with a 3xx. Undici reports it as a TypeError whose
 * cause (or message) mentions the redirect.
 */
export function isRedirectError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cause = (err as { cause?: unknown }).cause;
  const causeMsg = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  return /redirect/i.test(`${err.message} ${causeMsg}`);
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
