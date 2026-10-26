import { McpServer } from "@modelcontextprotocol/server";
import { Action1Client } from "./client/action1Client.js";
import { loadConfig, type AppConfig } from "./config.js";
import { log } from "./utils/logger.js";
import { autoConfirmWarning, guardInstructions } from "./tools/destructiveGuard.js";
import { applyToolPolicy, instrumentToolCalls } from "./tools/registry.js";
import { SERVER_VERSION } from "./version.js";
import type { CallerIdentity } from "./utils/requestContext.js";
import { registerOrgTools } from "./tools/orgs.js";
import { registerEndpointTools } from "./tools/endpoints.js";
import { registerTemplateTools } from "./tools/templates.js";
import { registerAutomationTools } from "./tools/automations.js";
import { registerExecutionTools } from "./tools/execution.js";
import { registerResultTools } from "./tools/results.js";
import { registerWorkflowTools } from "./tools/workflows.js";
import { registerGeneratedTools } from "./tools/generated/index.js";
import { registerWrapperTools } from "./tools/wrappers/index.js";
import { registerGroupTools } from "./tools/groups.js";
import { registerRawTool } from "./tools/raw.js";
import { registerResources } from "./resources/index.js";
import { registerPrompts } from "./prompts/index.js";

/**
 * Upper bound on the combined number of array elements and object
 * members in one tools/call `arguments` payload (GHSA-46jr-4wx8-v453:
 * validating oversized inputs can exhaust memory; the SDK only enforces
 * a cap when one is configured). Legitimate inputs (endpoint ids,
 * template params, update lists) stay orders of magnitude below it.
 */
export const MAX_TOOL_INPUT_ELEMENTS = 100_000;

export { SERVER_VERSION } from "./version.js";

export interface BuildServerResult {
  server: McpServer;
  client: Action1Client;
}

export interface BuildServerOptions {
  /**
   * Configuration to use instead of loadConfig(). The HTTP transport
   * passes the config it was started with.
   */
  config?: AppConfig;
  /**
   * Who is calling (recorded in tool_call and audit events). The HTTP
   * transport passes the peer of the current request; defaults to stdio.
   */
  caller?: CallerIdentity;
}

let startupLogged = false;

/**
 * The server instructions sent to the client in `initialize`. The
 * destructive-guard section is rendered from the guard policy for the
 * given flags, so it states what the guard actually does.
 */
export function serverInstructions(cfg: AppConfig): string {
  const lines = [
    "## Tool selection",
    "- For script execution prefer `action1_run_script` (auto-routes by OS to PowerShell on Windows / Bash on macOS).",
    '- For fleet-wide actions: pass an array of endpoint ids OR `target_type: "EndpointGroup"` with the group id. Action1 fans out server-side; one tool call covers thousands of endpoints.',
    "- For polling long-running actions use `action1_execute_and_wait` (start + poll + filtered output in one call).",
    "- Unknown or misspelled arguments are rejected with a validation error; use the argument names from the tool's input schema.",
    "## Pagination - IMPORTANT FOR LARGE DATASETS",
    "- Every list tool with a `cursor` argument returns `count`, `has_more` and `next_cursor` on every call, with or without `cursor`.",
    "- When `has_more` is `true`, you MUST call the same tool again with `cursor: <next_cursor>` and concatenate `items` across calls; repeat until `has_more` is `false`. Do NOT answer the user with partial data when `has_more` is true unless they explicitly asked for a subset.",
    '- A Markdown page (the default) holds the rows that fit its table; `response_format: "json"` returns up to ~400 KB per call. `next_cursor` always resumes at the first item not yet returned; in Markdown it is printed in full as a `next_cursor:` line below the table. A cursor is only valid with the same tool and arguments.',
    "## Aggregations",
    "- For pure counts ('how many endpoints are online', 'how many failed deploys this week') prefer the dedicated `*_summary` tools (`action1_endpoints_summary`, `action1_automations_summary`). They walk the data server-side and return ~1 KB of counts: `action1_endpoints_summary` walks every endpoint, `action1_automations_summary` walks up to `max_scan` instances and sets `has_more: true` when it stopped early; then raise `max_scan` before reporting a total. Never paginate just to count.",
    "## Connectivity",
    '- Before destructive operations, check `action1_get_endpoint` -> `connectivity.online`. Action1 reports `status: "Connected"` even when `last_seen` is hours old; the connectivity field accounts for both.',
    ...guardInstructions(cfg),
  ];
  if (cfg.allowedOrgIds.length > 0) {
    lines.push(
      "## Organizations",
      "- This server only addresses the organizations listed in ACTION1_ALLOWED_ORG_IDS; any other `org_id` is refused.",
      cfg.allowEnterpriseOps === true
        ? "- Changes that are not bound to one organization (enterprise settings, script library, roles, users) are allowed on this server."
        : "- Changes that are not bound to one allowed organization (enterprise settings, script library, roles, users, Enterprise scopes) are refused on this server.",
    );
  }
  return lines.join("\n");
}

/**
 * Build a fresh McpServer wired to an Action1Client.
 *
 * When `existingClient` is supplied the caller's client (and its
 * TokenProvider cache) is reused: the HTTP transport builds a server per
 * request and would otherwise force a new OAuth round-trip on every tool
 * call. The stdio path passes nothing and gets its own client.
 */
export function buildServer(
  existingClient?: Action1Client,
  options: BuildServerOptions = {},
): BuildServerResult {
  const cfg = options.config ?? loadConfig();
  const client = existingClient ?? new Action1Client(cfg);
  const server = new McpServer(
    { name: "action1-mcp-server", version: SERVER_VERSION },
    {
      maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
      instructions: serverInstructions(cfg),
    },
  );
  // Both must run before the first registerTool call.
  applyToolPolicy(server, cfg);
  instrumentToolCalls(server, options.caller);

  registerOrgTools(server, client);
  registerEndpointTools(server, client);
  registerTemplateTools(server, client);
  registerAutomationTools(server, client);
  registerExecutionTools(server, client);
  registerResultTools(server, client);
  registerWorkflowTools(server, client);
  registerGeneratedTools(server, client);
  registerWrapperTools(server, client);
  registerGroupTools(server, client);
  registerRawTool(server, client);
  registerResources(server, client);
  registerPrompts(server);

  // No MCP `logging` capability: logs go to stderr as JSON lines
  // (ACTION1_LOG_LEVEL), which is what the MCP spec recommends for
  // stdio servers; logging/setLevel is deprecated as of 2026-07-28.

  // Once per process: the HTTP transport builds a server per request.
  if (!startupLogged) {
    startupLogged = true;
    logStartup(cfg);
  }

  return { server, client };
}

function logStartup(cfg: AppConfig): void {
  log.info("guard_config", {
    allow_destructive: cfg.allowDestructive,
    auto_confirm: cfg.destructiveAutoConfirm,
    allow_account_ops: cfg.allowAccountOps,
    allowed_org_ids: cfg.allowedOrgIds.length > 0 ? cfg.allowedOrgIds : "any",
    allow_enterprise_ops: cfg.allowEnterpriseOps === true,
    toolsets: cfg.toolsets.length > 0 ? cfg.toolsets : ["all"],
    redact_pii: cfg.redactPii,
  });
  // Loud warning when auto-confirm is on; derived from the same policy
  // as the guard, so the text matches what the guard does.
  const warning = autoConfirmWarning(cfg);
  if (warning) log.warn("auto_confirm_enabled", warning);
}
