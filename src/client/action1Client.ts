import { TokenProvider } from "./auth.js";
import { Action1ApiError, deriveHint } from "./errors.js";
import {
  DEFAULT_RETRY,
  isTransientNetworkError,
  withRetry,
  type RetryOptions,
} from "./retry.js";
import { paginate, parsePageEnvelope, type PaginationOptions } from "./pagination.js";
import type { AppConfig } from "../config.js";

/**
 * Retry-policy override per request. Pass-10 review: previously typed
 * as `boolean`. Tests were silently passing object overrides that the
 * runtime ignored (truthy → fall through to DEFAULT_RETRY). Now an
 * object override partially merges into DEFAULT_RETRY so callers can
 * shrink the schedule (e.g. for fast unit tests) without re-spelling
 * every field.
 */
export type RetryOverride = boolean | Partial<Omit<RetryOptions, "retryOn" | "signal">>;

export interface RequestOptions {
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  retry?: RetryOverride;
}

export class Action1Client {
  readonly tokens: TokenProvider;

  constructor(private readonly cfg: AppConfig) {
    this.tokens = new TokenProvider(cfg);
  }

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    const method = opts.method ?? "GET";
    // Tracks whether *this* request has already retried after a 401
    // refresh. The flag lives in the outer closure so the inner
    // `doRequest` can both read and update it without polluting the
    // public RequestOptions surface. Two cooperating paths can hit a
    // stale token at once (in-flight dedup in TokenProvider doesn't
    // cover requests that already grabbed the cached token before it
    // went stale upstream); without this single-shot retry the
    // unlucky caller would surface a confusing 401 to the agent.
    let retriedAfter401 = false;
    const doRequest = async (): Promise<T> => {
      const token = await this.tokens.getAccessToken();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      };
      let body: string | undefined;
      if (opts.body !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(opts.body);
      }
      let res: Response;
      try {
        res = await fetch(url, { method, headers, body, signal: opts.signal });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err;
        throw wrapNetworkError(err, url, method);
      }
      if (res.status === 401) {
        this.tokens.invalidate();
        // One-shot 401 retry: drain the response body, refresh the
        // token, then re-issue the request. `retriedAfter401` guards
        // against an endless loop if the upstream genuinely keeps
        // returning 401 (e.g. revoked credentials).
        if (!retriedAfter401) {
          retriedAfter401 = true;
          await safeText(res);
          return doRequest();
        }
        const text = await safeText(res);
        throw new Action1ApiError({
          status: 401,
          url,
          method,
          body: text,
          hint: deriveHint(401, url),
        });
      }
      if (!res.ok) {
        const text = await safeText(res);
        const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
        const apiErr = new Action1ApiError({
          status: res.status,
          url,
          method,
          body: text,
          hint: deriveHint(res.status, url),
        });
        if (retryAfterMs !== undefined) {
          apiErr.retryAfterMs = retryAfterMs;
        }
        throw apiErr;
      }
      if (res.status === 204) return undefined as T;
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        return (await res.json()) as T;
      }
      return (await res.text()) as unknown as T;
    };

    if (opts.retry === false) return doRequest();

    // Pass-10: merge partial retry overrides into DEFAULT_RETRY so the
    // caller can shrink the backoff schedule (e.g. tests with 5ms base
    // delay). Previously `retry` was typed `boolean` and any object
    // override was silently ignored — tests pretended to pin 3-attempt
    // schedules while the runtime always ran the default 5-attempt one.
    const retryOverride =
      typeof opts.retry === "object" && opts.retry !== null ? opts.retry : {};
    return withRetry(doRequest, {
      ...DEFAULT_RETRY,
      ...retryOverride,
      retryOn: shouldRetry,
      signal: opts.signal,
    });
  }

  paginate<T>(
    path: string,
    opts: PaginationOptions & {
      query?: Record<string, string | number | boolean | undefined>;
      signal?: AbortSignal;
    } = {},
  ): AsyncGenerator<T, void, void> {
    return paginate<T>(
      async ({ limit, from }) => {
        const raw = await this.request<unknown>(path, {
          query: { ...opts.query, limit, from },
          signal: opts.signal,
        });
        return parsePageEnvelope<T>(raw);
      },
      { limit: opts.limit, maxItems: opts.maxItems, signal: opts.signal },
    );
  }

  private buildUrl(path: string, query?: RequestOptions["query"]): string {
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    // Single-arg `new URL(base + path)` structurally pins the host to
    // `baseUrl`: once the parser has consumed `https://<authority>`,
    // everything after is path — a `path` of `//evil.com`, `/@evil`,
    // `/../..//evil`, `\evil`, etc. cannot introduce a new authority.
    // (The dangerous form is the TWO-arg `new URL(path, base)`, where a
    // path of `https://evil` or `//evil` overrides the base authority —
    // we deliberately do NOT use it.)
    const url = new URL(`${this.cfg.baseUrl}${cleanPath}`);
    // Belt-and-suspenders: enforce that the resolved origin still equals
    // the configured base origin. This converts the structural property
    // above into a hard invariant so a future refactor (e.g. to the
    // two-arg URL form, or a base URL that is an origin with no path)
    // can never silently turn an attacker-influenced `path` into an
    // SSRF to a different host. A no-op on every legitimate Action1
    // path; throws loudly only if the host/scheme would change.
    const baseOrigin = new URL(this.cfg.baseUrl).origin;
    if (url.origin !== baseOrigin) {
      throw new Error(
        `Refusing request: resolved URL origin (${url.origin}) does not match the configured ACTION1_BASE_URL origin (${baseOrigin}). The path argument must not redirect to a different host.`,
      );
    }
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined) continue;
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }
}

function shouldRetry(err: unknown): boolean {
  if (err instanceof Action1ApiError) {
    if (err.status === 429) return true;
    if (err.status >= 500 && err.status < 600) return true;
    // Pass-9: a wrapped transient network error has status=0 plus a
    // `code` like ECONNRESET / ENOTFOUND / EAI_AGAIN. Pre-fix the
    // first instanceof-check short-circuited and these never reached
    // the `isTransientNetworkError` fallback below — the "Retried
    // automatically" hint in wrapNetworkError was a lie. Now: explicit
    // status=0+transient-code path is retryable.
    if (err.status === 0 && isTransientNetworkError(err)) return true;
    return false;
  }
  if (err instanceof Error && err.name === "AbortError") return false;
  return isTransientNetworkError(err);
}

function wrapNetworkError(err: unknown, url: string, method: string): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const wrapped = new Action1ApiError({
    status: 0,
    url,
    method,
    body: msg,
    hint: "Network error before reaching Action1. Retried automatically.",
  });
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") {
      wrapped.code = code;
    }
    const cause = (err as { cause?: unknown }).cause;
    if (cause !== undefined) {
      wrapped.cause = cause;
    }
  }
  return wrapped;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// Strict numeric Retry-After matcher: digits, optional decimal part.
// `parseFloat("123 abc")` silently returns 123 — we reject that so a
// malformed header falls through to the HTTP-date branch instead of
// being parsed as a partial number.
const RETRY_AFTER_SECONDS_RE = /^\d+(\.\d+)?$/;

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (RETRY_AFTER_SECONDS_RE.test(trimmed)) {
    const sec = Number.parseFloat(trimmed);
    if (Number.isFinite(sec) && sec >= 0) return Math.round(sec * 1000);
  }
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) {
    const ms = date - Date.now();
    return ms > 0 ? ms : 0;
  }
  return undefined;
}
