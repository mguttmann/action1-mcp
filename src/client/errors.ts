import { redactString } from "../utils/logger.js";
import { piiRedactionEnabled, redactPiiInText } from "../utils/pii.js";

/** Fields of an `Action1ApiError`. */
export interface Action1ApiErrorOptions {
  status: number;
  url: string;
  method: string;
  body: string;
  hint?: string;
}

/**
 * An Action1 API call that ended with an HTTP error status, or a network
 * error before any response (`status` 0, `code` set). The message names
 * method, URL (query string dropped, secrets redacted) and status; `body`
 * holds the upstream response, redacted at construction.
 */
export class Action1ApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly method: string;
  readonly body: string;
  readonly hint?: string;
  // Set by the HTTP client when the upstream returned 429 with a
  // `Retry-After` header. The retry layer reads this to honour the
  // server's chosen back-off instead of using its own exponential.
  retryAfterMs?: number;
  // Set by the network-error wrapper to preserve the original
  // platform error code (ECONNRESET, ENOTFOUND, …) so the retry
  // layer's `isTransientNetworkError` heuristic can match.
  code?: string;
  // The original Error we wrapped, when the failure happened before
  // we got an HTTP response. Useful for debug logs. The `override`
  // modifier is required because Error already declares `cause`.
  override cause?: unknown;

  constructor(opts: Action1ApiErrorOptions) {
    const summary = `${opts.method} ${redactPath(opts.url)} -> HTTP ${opts.status}`;
    super(opts.hint ? `${summary} - ${opts.hint}` : summary);
    this.name = "Action1ApiError";
    this.status = opts.status;
    this.url = opts.url;
    this.method = opts.method;
    // Redact at construction time, so `err.body` is safe for every
    // reader (curated tools, logs, .cause chains): one forgotten
    // redaction call must not leak an upstream response that echoed a
    // secret such as `client_secret`.
    this.body = typeof opts.body === "string" ? redactString(opts.body) : opts.body;
    this.hint = opts.hint;
  }

  /**
   * Error text for a tool result: status, method, URL, hint and the
   * first 500 characters of the redacted response body (with
   * ACTION1_REDACT_PII also PII-masked).
   */
  toToolErrorText(): string {
    const parts: string[] = [
      `Action1 API error: HTTP ${this.status} on ${this.method} ${redactPath(this.url)}`,
    ];
    if (this.hint) parts.push(this.hint);
    if (this.body) {
      // `this.body` was already redacted at construction; running the
      // redactor again is a cheap idempotent no-op and lets a future
      // refactor that exposes a raw-body channel still be safe-by-default
      // here.
      // ACTION1_REDACT_PII also covers error texts: an upstream error
      // body can echo the record it refused.
      const scrubbed = redactString(this.body);
      const safe = piiRedactionEnabled() ? redactPiiInText(scrubbed) : scrubbed;
      const truncated = safe.length > 500 ? `${safe.slice(0, 500)}...` : safe;
      parts.push(`Response body: ${truncated}`);
    }
    return parts.join("\n");
  }
}

/** The OAuth token request failed. The message is redacted. */
export class Action1AuthError extends Error {
  /**
   * True when the token request failed for a reason worth retrying
   * (network error, timeout, HTTP 429 or 5xx). Credential errors (4xx)
   * and malformed responses are not transient.
   */
  readonly transient: boolean;

  constructor(message: string, opts: { transient?: boolean } = {}) {
    // Same defence-in-depth as Action1ApiError: any Action1-Response-Body
    // that gets composed into the message is redacted before it propagates
    // to the tool-output / log stream.
    super(redactString(message));
    this.name = "Action1AuthError";
    this.transient = opts.transient ?? false;
  }
}

/** An API call exceeded ACTION1_REQUEST_TIMEOUT_MS (including its retries). */
export class Action1TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Action1TimeoutError";
  }
}

/**
 * A URL for error texts and logs: origin and path only (the query string
 * is dropped) with secret-shaped values redacted.
 */
export function redactPath(url: string): string {
  try {
    const u = new URL(url);
    // Drop the query string entirely (a `?token=…` / `?access_token=…`
    // must never reach the error summary) AND run the surviving
    // origin+pathname through redactString. The pathname pass is
    // defence-in-depth: Action1 puts secrets in the OAuth body /
    // Authorization header, not in REST path segments, but a future
    // endpoint (or a non-Action1 upstream reached via a misconfigured
    // base URL) that embeds a token-shaped value in the path would
    // otherwise leak it verbatim into the error line.
    return redactString(`${u.origin}${u.pathname}`);
  } catch {
    // Not a parseable URL - still scrub it; the raw string may carry a
    // query/token that the URL-parse branch would have dropped.
    return redactString(url);
  }
}

/**
 * True for HTTP methods the client retries on 5xx and on any transient
 * network error. Every other method may already have been processed by
 * Action1 when such an error arrives, so it is only retried on 429 and
 * on network errors that happened before the request was sent.
 */
export function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

/** Appended to errors of mutations that were not retried after they may have reached Action1. */
export const NOT_RETRIED_NOTE =
  "Not retried automatically: the request may already have been processed by Action1. Verify the resulting state before re-issuing it.";

/**
 * A short next step for an upstream error status (credentials for 401,
 * the missing role permission for 403, the rate limit for 429, ...), or
 * undefined when there is nothing specific to say. `url` and `method`
 * select permission hints for the endpoint family and the not-retried
 * note for mutations.
 */
export function deriveHint(status: number, url: string, method = "GET"): string | undefined {
  if (status === 400) {
    return "Request validation failed. Check the body shape against the tool input schema or `action1_get_action_template`.";
  }
  if (status === 401) {
    return "Authentication failed. Verify ACTION1_CLIENT_ID and ACTION1_CLIENT_SECRET.";
  }
  if (status === 403) {
    // Permission-pattern-specific hints. The role-permission names
    // mirror the Action1 console (view_vulnerabilities, manage_*, …)
    // so an operator who hits a 403 immediately knows which checkbox
    // to toggle on the API-user's role.
    if (url.includes("/vulnerabilities")) {
      return "API key may lack the vulnerabilities scope (view_vulnerabilities). Check the role permissions in the Action1 console.";
    }
    if (url.includes("/automations")) {
      return "API key may lack the automations scope (manage_automations). Check the role permissions in the Action1 console.";
    }
    if (url.includes("/endpoints")) {
      return "API key may lack the endpoints scope (manage_endpoints). Check the role permissions in the Action1 console.";
    }
    if (url.includes("/audit")) {
      return "API key may lack the audit scope (view_audit). Check the role permissions in the Action1 console.";
    }
    return "Forbidden. The API key may lack the scope required for this resource.";
  }
  if (status === 404) {
    return "Resource not found. Verify org_id and resource IDs.";
  }
  if (status === 409) {
    return "Conflict - another operator may have changed the resource. Re-read state and retry.";
  }
  if (status === 422) {
    return "Validation error. The body fields are present but values are invalid.";
  }
  if (status === 429) {
    return "Rate limited. The client retries automatically with backoff.";
  }
  if (status >= 500) {
    if (!isSafeMethod(method)) {
      return `Upstream Action1 service error. ${NOT_RETRIED_NOTE}`;
    }
    return "Upstream Action1 service error. Retried automatically; check Action1 status if this persists.";
  }
  return undefined;
}
