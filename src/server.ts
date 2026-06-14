import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SetLevelRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Action1Client } from "./client/action1Client.js";
import { loadConfig } from "./config.js";
import { log, setLogLevel } from "./utils/logger.js";
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

export interface BuildServerResult {
  server: McpServer;
  client: Action1Client;
}

/**
 * Build a fresh McpServer wired to an Action1Client.
 *
 * When `existingClient` is supplied the caller's client (and its
 * TokenProvider cache) is reused — critical for the HTTP transport,
 * which would otherwise instantiate a fresh client per `POST /mcp`
 * request and force a new OAuth round-trip on every tool call
 * (token cache effectively dead). The stdio path passes nothing and
 * gets its own client; that process lives long enough for caching to
 * matter.
 */
export function buildServer(existingClient?: Action1Client): BuildServerResult {
  const client = existingClient ?? new Action1Client(loadConfig());
  const server = new McpServer(
    { name: "action1-mcp-server", version: "0.5.0" },
    {
      instructions: [
        "## Tool selection",
        "- For script execution prefer `action1_run_script` (auto-routes by OS to PowerShell on Windows / Bash on macOS).",
        "- For fleet-wide actions: pass an array of endpoint ids OR `target_type: \"EndpointGroup\"` with the group id. Action1 fans out server-side; one tool call covers thousands of endpoints.",
        "- For polling long-running actions use `action1_execute_and_wait` (start + poll + filtered output in one call).",
        "## Pagination — IMPORTANT FOR LARGE DATASETS",
        "- Every list tool returns `count`, `has_more`, and `next_cursor`.",
        "- When `has_more` is `true`, you MUST call the same tool again with `cursor: <next_cursor>` and concatenate `items` across calls — repeat until `has_more` is `false`. Do NOT answer the user with partial data when `has_more` is true unless they explicitly asked for a subset.",
        "- Each call returns up to ~400 KB; multiple calls combine into the full result in your context window. For 3000 endpoints in `compact` mode this is typically 4-5 chained calls. `fields: \"bare\"` (id/name/status/last_seen/OS/platform) packs ~5000 endpoints per call.",
        "## Aggregations",
        "- For pure counts ('how many endpoints are online', 'how many failed deploys this week') prefer the dedicated `*_summary` tools (`action1_endpoints_summary`, `action1_automations_summary`). They walk all data server-side and return ~1 KB of counts. Never paginate just to count.",
        "## Connectivity",
        "- Before destructive operations, check `action1_get_endpoint` → `connectivity.online`. Action1 reports `status: \"Connected\"` even when `last_seen` is hours old; the connectivity field accounts for both.",
        "## Destructive guard",
        "- Tools tagged `destructiveHint: true` default to `dry_run: true` (preview). To execute, pass `dry_run: false` AND `confirm: \"YES\"`. The server must also have `ACTION1_ALLOW_DESTRUCTIVE=true` set.",
        "- An auto-confirm mode exists for isolated single-operator setups (env: `ACTION1_DESTRUCTIVE_AUTO_CONFIRM=true`); when enabled, both per-call layers default to execute.",
      ].join("\n"),
    },
  );

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

  // Honour MCP logging/setLevel — clients can dynamically bump or lower
  // verbosity without restarting the server.
  server.server.registerCapabilities({ logging: {} });
  server.server.setRequestHandler(SetLevelRequestSchema, ({ params }) => {
    setLogLevel(params.level);
    return {};
  });

  // Loud start-up warning if the destructive-auto-confirm switch is on:
  // this collapses the per-call confirm + dry_run layers and is meant
  // for isolated test setups only. Visible in any log aggregator.
  const autoConfirm = (process.env.ACTION1_DESTRUCTIVE_AUTO_CONFIRM ?? "")
    .toLowerCase();
  if (["true", "1", "yes"].includes(autoConfirm)) {
    log.warn("auto_confirm_enabled", {
      env: "ACTION1_DESTRUCTIVE_AUTO_CONFIRM",
      effect:
        "dry_run defaults to false; confirm:\"YES\" no longer required per call. Intended for isolated test setups only.",
    });
  }

  return { server, client };
}
