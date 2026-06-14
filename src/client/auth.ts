import { Action1AuthError } from "./errors.js";
import { log } from "../utils/logger.js";
import type { AppConfig } from "../config.js";

interface CachedToken {
  accessToken: string;
  refreshToken: string | undefined;
  expiresAt: number;
}

const REFRESH_LEAD_MS = 5 * 60 * 1000;

export class TokenProvider {
  private cache: CachedToken | undefined;
  private inFlight: Promise<CachedToken> | undefined;

  constructor(private readonly cfg: AppConfig) {}

  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt - now > REFRESH_LEAD_MS) {
      return this.cache.accessToken;
    }
    return (await this.fetchOrJoinInFlight()).accessToken;
  }

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
   *   path does this today — `cache` is only set on success), every
   *   joined waiter receives the same rejection. That's the intended
   *   contract: a failing refresh must visibly fail every dependent
   *   request rather than silently feed them a torn cache. Future
   *   changes to `acquire()` MUST preserve "either cache is fully
   *   updated, or it isn't touched at all" — see Pass-4 Security Audit
   *   #2.3.
   */
  private async fetchOrJoinInFlight(): Promise<CachedToken> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.acquire().finally(() => {
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
        // The refresh token is dead — drop it from the cache so we
        // don't keep trying it on every subsequent acquire(). The
        // client_credentials path below issues a fresh refresh_token
        // anyway, but until then we'd otherwise re-attempt the dead
        // one on every cold-cache lookup.
        this.cache = undefined;
      }
    }
    const fresh = await this.exchange({
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
    });
    log.debug("token_acquired_via_client_credentials");
    this.cache = fresh;
    return fresh;
  }

  private async exchange(form: Record<string, string>): Promise<CachedToken> {
    const url = `${this.cfg.baseUrl}/oauth2/token`;
    // TODO(Pass-13 Item 7): Action1's OAuth spec calls for JSON body
    // with `grant_type` mandatory on every token request. Today we send
    // form-encoded (which works in production — both the
    // client-credentials and refresh-token flows succeed) and omit
    // `grant_type` from the initial client_credentials request (only
    // the refresh path includes it). A "spec-correct" rewrite would
    // switch primary to JSON + grant_type and fall back to
    // form-encoded on 4xx. Deferring until we can verify against a
    // live Action1 tenant — a misstep here breaks every token
    // acquisition, so a riskless TODO is preferable to a speculative
    // live change. References: Action1 API spec /oauth2/token.
    const body = new URLSearchParams(form);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch (err) {
      throw new Action1AuthError(
        `Failed to reach Action1 token endpoint at ${this.cfg.baseUrl}/oauth2/token: ${describeError(err)}`,
      );
    }

    if (!res.ok) {
      const text = await safeReadText(res);
      throw new Action1AuthError(
        `Token request failed (HTTP ${res.status}). Verify ACTION1_CLIENT_ID/ACTION1_CLIENT_SECRET and ACTION1_BASE_URL.${text ? ` Body: ${truncate(text, 300)}` : ""}`,
      );
    }

    const data = (await res.json()) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
    };
    if (typeof data.access_token !== "string" || !data.access_token) {
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
    // every refresh. Reset on process restart is fine — operators will
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

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
