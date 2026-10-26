import { createHash } from "node:crypto";
import { log } from "./logger.js";
import { currentRequestContext } from "./requestContext.js";

// The destructive_executed audit event. The destructive guard records an
// approved call on the request context; the Action1 client calls
// noteExecutionSent right before each state-changing request it sends,
// so the event is written for requests that actually leave the server.

/**
 * SHA-256 (hex) of a request body serialised the way the Action1 client
 * sends it (JSON.stringify); null when there is no body.
 */
export function bodyDigest(body: unknown): string | null {
  if (body === undefined) return null;
  return sha256Hex(JSON.stringify(body));
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Called by the Action1 client right before it sends a state-changing
 * request. When the guard approved the current tool call, writes the
 * `destructive_executed` audit event for exactly this request (method,
 * path, SHA-256 of the serialised body, caller).
 */
export function noteExecutionSent(
  method: string,
  path: string,
  serialisedBody: string | undefined,
): void {
  const rc = currentRequestContext();
  const approved = rc?.approvedExecution;
  if (!rc || !approved) return;
  rc.guard = "executed";
  log.audit("destructive_executed", {
    tool: approved.tool,
    method,
    path: path.split(/[?#]/, 1)[0],
    org: rc.orgId ?? null,
    account_op: approved.accountOp,
    body_sha256: serialisedBody === undefined ? null : sha256Hex(serialisedBody),
    caller: rc.caller ?? null,
  });
}
