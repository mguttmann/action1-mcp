import { z } from "zod";
import { errorResult, jsonResult } from "./helpers.js";
import { redact } from "../utils/logger.js";
import { loadConfig } from "../config.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const destructiveGuardShape = {
  confirm: z
    .literal("YES")
    .optional()
    .describe('Required to execute. Exact string "YES".'),
  dry_run: z
    .boolean()
    .optional()
    .describe("Default true (preview). Set false to execute."),
};

export interface DestructiveGuardInput {
  confirm?: "YES" | undefined;
  dry_run?: boolean | undefined;
}

export interface DestructivePreview {
  method: string;
  path: string;
  body?: unknown;
  description?: string;
}

export interface DestructiveContext {
  toolName: string;
  preview: DestructivePreview;
}

const ALLOW_ENV = "ACTION1_ALLOW_DESTRUCTIVE";
const AUTO_CONFIRM_ENV = "ACTION1_DESTRUCTIVE_AUTO_CONFIRM";

// Read both env flags through `loadConfig()` when available so the
// values are parsed via the same Zod pipeline (trim + case-fold) as
// the rest of the config. That fixes a real footgun where values like
// `"TRUE\n"` (pasted from a `.env` file with a trailing newline)
// previously failed the strict `process.env.X.toLowerCase() === "true"`
// compare and silently refused the destructive call.
//
// When `loadConfig()` itself fails — e.g. unit tests that exercise the
// destructive guard without setting the mandatory ACTION1_* vars — we
// fall back to a local trim-and-lowercase parse of `process.env` so
// the guard's dry_run preview path still works in isolation.
//
// Auto-confirm mode: when ACTION1_DESTRUCTIVE_AUTO_CONFIRM=true, the
// per-call `confirm: "YES"` is implicit. The `dry_run` layer is NOT
// collapsed — the caller still has to pass dry_run=false explicitly
// to actually execute.
function envAllows(): boolean {
  try {
    return loadConfig().allowDestructive;
  } catch {
    return parseFlag(process.env[ALLOW_ENV]);
  }
}

function envAutoConfirms(): boolean {
  try {
    return loadConfig().destructiveAutoConfirm;
  } catch {
    return parseFlag(process.env[AUTO_CONFIRM_ENV]);
  }
}

function parseFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

export async function runDestructive(
  input: DestructiveGuardInput,
  ctx: DestructiveContext,
  perform: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const guard = checkDestructiveGuard(input, ctx);
  if (guard) return guard;
  return perform();
}

export function checkDestructiveGuard(
  input: DestructiveGuardInput,
  ctx: DestructiveContext,
): CallToolResult | null {
  const autoConfirm = envAutoConfirms();
  // dry_run ALWAYS defaults to true — even in auto-confirm mode.
  // Auto-confirm only collapses the per-call `confirm` requirement;
  // the dry_run preview-by-default behaviour remains as a final
  // safety net so a bare `tool({})` call never fires for real.
  const dryRun = input.dry_run ?? true;
  if (dryRun) {
    // Defence-in-depth: route the preview body through the same
    // `redact()` pipeline the structured-stderr logger uses, so an
    // accidental secret in the would-be request body (hardcoded
    // Bearer / api-key / client_secret inside a `script_text`, custom
    // header, etc.) doesn't escape verbatim into the LLM context via
    // the dry-run preview. `redact()` is a no-op on normal Action1
    // payloads (no secret-shaped keys or values), so this only fires
    // on payloads that *should* be redacted.
    const redactedPreview: DestructivePreview = {
      method: ctx.preview.method,
      path: ctx.preview.path,
      ...(ctx.preview.body !== undefined ? { body: redact(ctx.preview.body) } : {}),
      ...(ctx.preview.description !== undefined ? { description: ctx.preview.description } : {}),
    };
    return jsonResult(
      {
        dry_run: true,
        tool: ctx.toolName,
        would_send: redactedPreview,
        next_step:
          'Re-run with dry_run=false and confirm="YES" to actually execute. Also ensure ACTION1_ALLOW_DESTRUCTIVE=true in the server environment.',
      },
      {
        dry_run: true,
        tool: ctx.toolName,
        would_send: redactedPreview,
      },
    );
  }
  if (!envAllows()) {
    return errorResult(
      `Refusing destructive call: server is not allowed to perform destructive operations. Set ${ALLOW_ENV}=true in the server environment to enable, or pass dry_run=true to preview the payload only.`,
    );
  }
  if (input.confirm !== "YES" && !autoConfirm) {
    return errorResult(
      'Refusing destructive call: missing per-call confirmation. Pass confirm:"YES" (case-sensitive, exact string). If you typed a typo like "confrim"/"comfirm"/"conifrm", the SDK silently dropped the unknown key — re-check spelling. With dry_run=true (default) the call is a no-op preview; set dry_run=false plus confirm:"YES" to execute. (Or set ACTION1_DESTRUCTIVE_AUTO_CONFIRM=true to bypass this layer in isolated test setups.)',
    );
  }
  return null;
}
