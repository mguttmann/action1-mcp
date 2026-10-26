import { isRedirectError, TokenProvider } from "./auth.js";
import {
  Action1ApiError,
  Action1TimeoutError,
  deriveHint,
  isSafeMethod,
  NOT_RETRIED_NOTE,
  redactPath,
} from "./errors.js";
import {
  DEFAULT_RETRY,
  isPreSendNetworkError,
  isTransientNetworkError,
  withRetry,
  type RetryOptions,
} from "./retry.js";
import { paginate, parsePageEnvelope, type PaginationOptions } from "./pagination.js";
import { DEFAULT_REQUEST_TIMEOUT_MS, type AppConfig } from "../config.js";
import { log } from "../utils/logger.js";
import { piiRedactionEnabled, redactPiiInBody } from "../utils/pii.js";
import { currentRequestContext, noteUpstreamAttempt } from "../utils/requestContext.js";
import { noteExecutionSent } from "../utils/audit.js";

/**
 * Retry-schedule override per request. `false` disables retries; an
 * object partially overrides DEFAULT_RETRY (e.g. a shorter back-off in
 * tests). WHICH errors are retried is decided by the HTTP method, not by
 * this option: GET/HEAD retry on 429, 5xx and transient network errors;
 * every other method only on 429 and on network errors that happened
 * before the request was sent, so a mutation is never executed twice.
 */
export type RetryOverride = boolean | Partial<Omit<RetryOptions, "retryOn" | "signal">>;

/** Options of one `Action1Client.request` call. */
export interface RequestOptions {
  /** HTTP method, default GET. Anything but GET/HEAD is never retried after it may have reached Action1. */
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Query parameters; `undefined` values are left out. */
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON request body. */
  body?: unknown;
  /** Caller cancellation (e.g. the MCP request signal). */
  signal?: AbortSignal;
  retry?: RetryOverride;
}

/**
 * HTTP client for the Action1 REST API. Every call goes to
 * `ACTION1_BASE_URL` (paths are checked by `assertSafeApiPath` and the
 * resolved URL must stay under the base path), carries a bearer token
 * from `tokens`, refuses redirects, and is bounded by
 * `ACTION1_REQUEST_TIMEOUT_MS`. Upstream errors surface as
 * `Action1ApiError` (HTTP status), `Action1AuthError` (token request)
 * or `Action1TimeoutError`. One instance is shared by every tool of a
 * server; it holds no per-request state.
 */
export class Action1Client {
  /** OAuth token cache shared by every request of this client. */
  readonly tokens: TokenProvider;

  constructor(private readonly cfg: AppConfig) {
    this.tokens = new TokenProvider(cfg);
  }

  /**
   * One Action1 API call. The whole call (token wait, every attempt and
   * every back-off sleep) is bounded by ACTION1_REQUEST_TIMEOUT_MS and
   * by the caller's signal, whichever fires first. A timeout surfaces as
   * Action1TimeoutError, a caller cancellation as AbortError.
   */
  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    const method = opts.method ?? "GET";
    const safeMethod = isSafeMethod(method);
    const timeoutMs = this.cfg.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const callerSignals = callerSignalsFor(opts.signal);
    const signal =
      callerSignals.length > 0 ? AbortSignal.any([...callerSignals, timeoutSignal]) : timeoutSignal;
    // Tracks whether *this* request has already retried after a 401
    // refresh. Two cooperating paths can hit a stale token at once
    // (in-flight dedup in TokenProvider doesn't cover requests that
    // already grabbed the cached token before it went stale upstream);
    // without this single-shot retry the unlucky caller would surface a
    // confusing 401 to the agent. A 401 means the request was rejected
    // before processing, so re-issuing it is safe for every method.
    let retriedAfter401 = false;
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    // Audit: a state-changing request of a guarded call is logged once,
    // right before it is first sent (not per retry attempt).
    let auditPending = !safeMethod;
    const doRequest = async (): Promise<T> => {
      const token = await abortable(this.tokens.getAccessToken(), signal);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (auditPending) {
        auditPending = false;
        noteExecutionSent(method, path.startsWith("/") ? path : `/${path}`, body);
      }
      let res: Response;
      try {
        // redirect:"error": a 3xx is never followed, so the bearer token,
        // a mutation body or the answer of another origin cannot cross
        // to a host other than ACTION1_BASE_URL (buildUrl pins only the
        // first URL).
        res = await fetch(url, { method, headers, body, signal, redirect: "error" });
      } catch (err) {
        if (signal.aborted || (err instanceof Error && err.name === "AbortError")) throw err;
        if (isRedirectError(err)) {
          noteUpstreamAttempt(0);
          throw new Action1ApiError({
            status: 0,
            url,
            method,
            body: "redirect refused",
            hint: "Action1 answered with a redirect, which this server never follows (the token and request body must not reach another location). Check ACTION1_BASE_URL.",
          });
        }
        noteUpstreamAttempt(0);
        throw wrapNetworkError(err, url, method);
      }
      noteUpstreamAttempt(res.status);
      if (res.status === 401) {
        this.tokens.invalidate();
        // `retriedAfter401` guards against an endless loop if the
        // upstream genuinely keeps returning 401 (e.g. revoked
        // credentials).
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
          hint: deriveHint(401, url, method),
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
          hint: deriveHint(res.status, url, method),
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
      // A text body (CSV and other exports) carries no keys for the
      // result-level masking in jsonResult, so ACTION1_REDACT_PII is
      // applied here, where every text answer passes.
      const text = await res.text();
      return (piiRedactionEnabled() ? redactPiiInBody(text) : text) as unknown as T;
    };

    try {
      if (opts.retry === false) return await doRequest();
      const retryOverride = typeof opts.retry === "object" && opts.retry !== null ? opts.retry : {};
      return await withRetry(doRequest, {
        ...DEFAULT_RETRY,
        ...retryOverride,
        retryOn: (err) => shouldRetry(err, safeMethod),
        onRetry: (err, attempt, delayMs) =>
          log.warn("upstream_retry", {
            method,
            path: redactPath(url),
            attempt,
            delay_ms: Math.round(delayMs),
            status: err instanceof Action1ApiError ? err.status : null,
            error: err instanceof Error ? err.message.slice(0, 200) : String(err),
          }),
        signal,
      });
    } catch (err) {
      if (timeoutSignal.aborted && !callerSignals.some((s) => s.aborted)) {
        throw new Action1TimeoutError(timeoutMessage(method, url, timeoutMs));
      }
      throw err;
    }
  }

  /**
   * Walk a list endpoint page by page (GET with `limit` / `from`) and
   * yield its items. The walk stops by `pageHasMore`, after
   * `opts.maxItems` items, or when the signal (default: the current MCP
   * request's) aborts. Each page is one `request` call with its own
   * timeout.
   */
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
      {
        limit: opts.limit,
        maxItems: opts.maxItems,
        signal: opts.signal ?? currentRequestContext()?.signal,
      },
    );
  }

  private buildUrl(path: string, query?: RequestOptions["query"]): string {
    assertSafeApiPath(path);
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    // Single-arg `new URL(base + path)` structurally pins the host to
    // `baseUrl`: once the parser has consumed `https://<authority>`,
    // everything after is path. (The dangerous form is the TWO-arg
    // `new URL(path, base)`, where a path of `https://evil` or `//evil`
    // overrides the base authority; it is deliberately not used.)
    const url = new URL(`${this.cfg.baseUrl}${cleanPath}`);
    // Hard invariants on the resolved URL: same origin as the configured
    // base, and a pathname below the base path. assertSafeApiPath already
    // rejects the inputs that could violate them; these checks keep a
    // future refactor from silently turning a `path` argument into a
    // request to another host or outside the API.
    const base = new URL(this.cfg.baseUrl);
    if (url.origin !== base.origin) {
      throw new Error(
        `Refusing request: resolved URL origin (${url.origin}) does not match the configured ACTION1_BASE_URL origin (${base.origin}). The path argument must not redirect to a different host.`,
      );
    }
    const basePath = base.pathname.replace(/\/+$/, "");
    if (!url.pathname.startsWith(`${basePath}/`)) {
      throw new Error(
        `Refusing request: resolved path (${url.pathname}) is outside the API base path (${basePath || "/"}).`,
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

/**
 * Reject API paths whose segments could be re-interpreted by URL
 * normalisation: empty segments (`//`, trailing `/`), dot segments
 * (`.`, `..`, also percent-encoded as `%2e`), segments that decode to a
 * `/` or `\`, raw backslashes and control characters.
 * A path parameter such as `user_id: ".."` would otherwise turn
 * `DELETE /roles/R1/users/..` into `DELETE /roles/R1/`. Throws before
 * any network call; callers run it before the destructive dry-run
 * preview so the preview never shows a path that would be refused.
 */
export function assertSafeApiPath(path: string): void {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const pathOnly = cleanPath.split(/[?#]/, 1)[0] ?? "";
  // WHATWG URL parsing treats `\` as `/` and silently strips tab and
  // newline characters (so `.\n.` would become `..`).
  if (pathOnly.includes("\\") || /[\u0000-\u001f\u007f]/.test(pathOnly)) {
    throw new Error(
      `Refusing request: path ${JSON.stringify(path)} contains a backslash or a control character.`,
    );
  }
  for (const segment of pathOnly.split("/").slice(1)) {
    if (segment === "") {
      throw new Error(
        `Refusing request: path ${JSON.stringify(path)} contains an empty segment (an empty ID or a doubled or trailing "/").`,
      );
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error(
        `Refusing request: path ${JSON.stringify(path)} contains malformed percent-encoding.`,
      );
    }
    if (decoded === "." || decoded === "..") {
      throw new Error(
        `Refusing request: path ${JSON.stringify(path)} contains the dot segment "${decoded}", which would retarget the request to a different resource.`,
      );
    }
    if (decoded.includes("/") || decoded.includes("\\")) {
      throw new Error(
        `Refusing request: a segment of path ${JSON.stringify(path)} contains "/" or "\\". IDs must not contain path separators.`,
      );
    }
  }
}

/**
 * The caller's cancellation signals for one request: the explicit
 * `opts.signal` and the signal of the MCP request this call runs in
 * (set centrally by the tools/call and resources/read wrappers in
 * registry.ts), so every tool and resource read is cancellable without
 * passing the signal by hand.
 */
function callerSignalsFor(explicit: AbortSignal | undefined): AbortSignal[] {
  const fromContext = currentRequestContext()?.signal;
  const out: AbortSignal[] = [];
  if (explicit) out.push(explicit);
  if (fromContext && fromContext !== explicit) out.push(fromContext);
  return out;
}

function shouldRetry(err: unknown, safeMethod: boolean): boolean {
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return false;
  }
  if (err instanceof Action1ApiError) {
    // 429: the rate limiter rejected the request before processing.
    if (err.status === 429) return true;
    // status 0: wrapped network error (see wrapNetworkError).
    if (err.status === 0) {
      return safeMethod ? isTransientNetworkError(err) : isPreSendNetworkError(err);
    }
    return safeMethod && err.status >= 500 && err.status < 600;
  }
  return safeMethod ? isTransientNetworkError(err) : isPreSendNetworkError(err);
}

function wrapNetworkError(err: unknown, url: string, method: string): Error {
  const msg = err instanceof Error ? err.message : String(err);
  let hint: string;
  if (isPreSendNetworkError(err)) {
    hint = "Network error before the request reached Action1. Retried automatically.";
  } else if (!isSafeMethod(method)) {
    hint = `Network error while talking to Action1. ${NOT_RETRIED_NOTE}`;
  } else if (isTransientNetworkError(err)) {
    hint = "Network error while talking to Action1. Retried automatically.";
  } else {
    hint = "Network error while talking to Action1.";
  }
  const wrapped = new Action1ApiError({ status: 0, url, method, body: msg, hint });
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

function timeoutMessage(method: string, url: string, timeoutMs: number): string {
  const base = `${method} ${redactPath(url)} timed out after ${timeoutMs} ms (ACTION1_REQUEST_TIMEOUT_MS).`;
  if (isSafeMethod(method)) {
    return `${base} Retry later, or raise ACTION1_REQUEST_TIMEOUT_MS if Action1 is slow for this call.`;
  }
  return `${base} The request may already have been processed by Action1; verify the resulting state before re-issuing it.`;
}

/**
 * Wait for `p`, but stop waiting when `signal` fires. `p` itself keeps
 * running: the token fetch is shared with other callers, so one
 * caller's cancellation must not abort it for everyone.
 */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason as Error);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// Strict numeric Retry-After matcher: digits, optional decimal part.
// `parseFloat("123 abc")` silently returns 123 - we reject that so a
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
