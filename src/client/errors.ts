import { redactString } from "../utils/logger.js";

export interface Action1ApiErrorOptions {
  status: number;
  url: string;
  method: string;
  body: string;
  hint?: string;
}

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
    // Redact at construction time. Previously the body was stored raw
    // and only redacted on `toToolErrorText()`. That left `err.body`
    // available to any caller (curated tools, logs, .cause chains)
    // who reached for the raw text — a single forgotten redaction call
    // would leak the upstream response (e.g. an OAuth error that echoed
    // `client_secret` back). Redact-at-rest closes that gap.
    this.body = typeof opts.body === "string" ? redactString(opts.body) : opts.body;
    this.hint = opts.hint;
  }

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
      const safe = redactString(this.body);
      const truncated = safe.length > 500 ? `${safe.slice(0, 500)}...` : safe;
      parts.push(`Response body: ${truncated}`);
    }
    return parts.join("\n");
  }
}

export class Action1AuthError extends Error {
  constructor(message: string) {
    // Same defence-in-depth as Action1ApiError: any Action1-Response-Body
    // that gets composed into the message is redacted before it propagates
    // to the tool-output / log stream.
    super(redactString(message));
    this.name = "Action1AuthError";
  }
}

export class Action1TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Action1TimeoutError";
  }
}

function redactPath(url: string): string {
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
    // Not a parseable URL — still scrub it; the raw string may carry a
    // query/token that the URL-parse branch would have dropped.
    return redactString(url);
  }
}

export function deriveHint(status: number, url: string): string | undefined {
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
    return "Conflict — another operator may have changed the resource. Re-read state and retry.";
  }
  if (status === 422) {
    return "Validation error. The body fields are present but values are invalid.";
  }
  if (status === 429) {
    return "Rate limited. The client retries automatically with backoff.";
  }
  if (status >= 500) {
    return "Upstream Action1 service error. Retried automatically; check Action1 status if this persists.";
  }
  return undefined;
}
