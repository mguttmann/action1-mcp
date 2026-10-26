import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * Who sent the MCP request, as far as the server can tell. stdio has a
 * single local client; over HTTP the peer address (after TRUST_PROXY),
 * the user agent and a short SHA-256 prefix of the bearer token that
 * was accepted (never the token itself) are recorded.
 */
export interface CallerIdentity {
  transport: "stdio" | "http";
  remote_ip?: string;
  user_agent?: string;
  token_id?: string;
}

export const STDIO_CALLER: CallerIdentity = { transport: "stdio" };

/** A destructive call the guard allowed, waiting for its upstream request. */
export interface ApprovedExecution {
  tool: string;
  accountOp: boolean;
}

/**
 * Per tool call state shared by the logger, the Action1 client and the
 * destructive guard. One context exists for the lifetime of one
 * `tools/call` request; code outside a tool call sees `undefined`.
 */
export interface RequestContext {
  /** Correlation id: on every log line written during the call. */
  readonly requestId: string;
  /** Name of the tool being called. */
  readonly tool: string;
  /** Number of HTTP requests sent to Action1 (every retry counts). */
  attempts: number;
  /** HTTP status of the most recent Action1 response (0 = network error). */
  upstreamStatus: number | undefined;
  /** Org id the call resolved (set by resolveOrgId). */
  orgId: string | undefined;
  /** Destructive guard decision, when the tool ran through the guard. */
  guard: "dry_run" | "refused" | "executed" | undefined;
  /**
   * Cancellation signal of the MCP request (ctx.mcpReq.signal). The
   * Action1 client attaches it to every upstream call made during this
   * request, so notifications/cancelled and a closed HTTP connection
   * abort the fetches of every tool and resource read, not only of the
   * handlers that pass a signal explicitly.
   */
  readonly signal: AbortSignal | undefined;
  /** The caller of this request (see CallerIdentity). */
  readonly caller: CallerIdentity | undefined;
  /**
   * Set by the destructive guard when it lets a call through. The
   * Action1 client writes the destructive_executed audit event for each
   * state-changing request it then sends, right before sending it, so a
   * call that a pre-flight check aborts is never logged as executed.
   */
  approvedExecution: ApprovedExecution | undefined;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` inside a fresh request context for `tool`. */
export function runWithRequestContext<T>(
  tool: string,
  fn: (ctx: RequestContext) => T,
  signal?: AbortSignal,
  caller?: CallerIdentity,
): T {
  const ctx: RequestContext = {
    requestId: randomUUID(),
    tool,
    attempts: 0,
    upstreamStatus: undefined,
    orgId: undefined,
    guard: undefined,
    signal,
    caller,
    approvedExecution: undefined,
  };
  return storage.run(ctx, () => fn(ctx));
}

/** The context of the tool call currently executing, if any. */
export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Record one HTTP exchange with Action1 for the current tool call:
 * counts the attempt and keeps the status (0 for a network error).
 */
export function noteUpstreamAttempt(status: number): void {
  const ctx = storage.getStore();
  if (!ctx) return;
  ctx.attempts += 1;
  ctx.upstreamStatus = status;
}
