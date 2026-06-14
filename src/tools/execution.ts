import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Action1Client } from "../client/action1Client.js";
import { loadConfig, resolveOrgId } from "../config.js";
import {
  endpointOrGroupIdSchema,
  errorResult,
  formatShape,
  jsonResult,
  okStatusOutputShape,
  orgIdShape,
  runTool,
} from "./helpers.js";
import { destructiveGuardShape, runDestructive } from "./destructiveGuard.js";
import {
  buildSimplePolicyPayload,
  buildWindowsPowerShellPayload,
} from "../payloads/windowsPowerShell.js";
import { buildMacOsBashPayload } from "../payloads/macOsBash.js";
import { detectPlatform, type Platform } from "../utils/osDetect.js";
import { isEndpointActuallyOnline } from "../utils/lastSeen.js";
import { fetchEndpointInfo } from "../client/endpointInfo.js";
import { redactString } from "../utils/logger.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const targetTypeShape = {
  target_type: z
    .enum(["Endpoint", "EndpointGroup"])
    .optional()
    .describe("Endpoint (default) or EndpointGroup for fan-out."),
};

// `timeout_minutes` and `retry_minutes` accept either a non-negative
// integer or a digit-only string so historical callers (which passed
// strings) keep working while modern callers can pass real numbers.
// `toMinutesString` / `toMinutesNumber` normalise at the payload-build
// site.
const minutesShape = z
  .union([
    z.number().int().min(0).max(10080),
    z.string().regex(/^\d+$/),
  ]);

function toMinutesString(v: number | string | undefined, fallback: string): string {
  if (v === undefined) return fallback;
  return typeof v === "number" ? String(v) : v;
}

function toMinutesNumber(v: number | string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  return typeof v === "number" ? v : Number.parseInt(v, 10);
}

const scriptInputShape = {
  ...orgIdShape,
  ...destructiveGuardShape,
  ...targetTypeShape,
  ...formatShape,
  endpoint_id: endpointOrGroupIdSchema,
  script_text: z.string().min(1).describe("Script source."),
  name: z
    .string()
    .optional()
    .describe("Friendly action name."),
  timeout_minutes: minutesShape
    .optional()
    .describe("Per-action timeout in minutes (number or digit-string)."),
  retry_minutes: minutesShape
    .optional()
    .describe("Retry window in minutes when endpoint is offline."),
};

const DESTRUCTIVE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export function registerExecutionTools(server: McpServer, client: Action1Client): void {
  registerRunPowerShell(server, client);
  registerRunBashMacOs(server, client);
  registerRunScript(server, client);
  registerReboot(server, client);
  registerDeployUpdate(server, client);
  registerDeployPackage(server, client);
  registerUninstallProgram(server, client);
  registerRunDataCollection(server, client);
}

function registerRunPowerShell(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_run_powershell",
    {
      title: "Run PowerShell on a Windows endpoint",
      description: "Run PowerShell on a Windows endpoint via the run_powershell template. Runs as SYSTEM (no user profile).",
      inputSchema: {
        ...scriptInputShape,
        success_exit_codes: z
          .string()
          .regex(
            /^\d+(,\d+)*$/,
            "Must be a comma-separated list of digits with no spaces, e.g. '0' or '0,1,3010'.",
          )
          .optional()
          .describe("Comma-separated success exit codes."),
      },
      outputSchema: okStatusOutputShape,
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async (args) =>
      runTool(async () => {
        const cfg = loadConfig();
        const orgId = resolveOrgId(args.org_id, cfg);
        const payload = buildWindowsPowerShellPayload({
          endpointId: args.endpoint_id,
          ...(args.target_type ? { targetType: args.target_type } : {}),
          scriptText: args.script_text,
          ...(args.name !== undefined ? { name: args.name } : {}),
          successExitCodes: args.success_exit_codes ?? "0",
          timeoutMinutes: toMinutesString(args.timeout_minutes, cfg.defaultTimeoutMinutes),
          retryMinutes: toMinutesNumber(
            args.retry_minutes,
            Number.parseInt(cfg.defaultRetryMinutes, 10),
          ),
        });
        const path = `/policies/instances/${encodeURIComponent(orgId)}`;
        return runDestructive(
          args,
          { toolName: "action1_run_powershell", preview: { method: "POST", path, body: payload } },
          async () => {
            const response = await client.request<unknown>(path, {
              method: "POST",
              body: payload,
              retry: false,
            });
            return startedJobResult(response, args.response_format);
          },
        );
      }),
  );
}

function registerRunBashMacOs(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_run_bash_macos",
    {
      title: "Run a Bash script on a macOS endpoint",
      description: "Run a Bash script on a macOS endpoint via the run_script template. For OS-aware routing use action1_run_script.",
      inputSchema: scriptInputShape,
      outputSchema: okStatusOutputShape,
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async (args) =>
      runTool(async () => {
        const cfg = loadConfig();
        const orgId = resolveOrgId(args.org_id, cfg);
        const payload = buildMacOsBashPayload({
          endpointId: args.endpoint_id,
          ...(args.target_type ? { targetType: args.target_type } : {}),
          scriptText: args.script_text,
          ...(args.name !== undefined ? { name: args.name } : {}),
          retryMinutes: toMinutesString(args.retry_minutes, cfg.defaultRetryMinutes),
        });
        const path = `/automations/instances/${encodeURIComponent(orgId)}`;
        return runDestructive(
          args,
          { toolName: "action1_run_bash_macos", preview: { method: "POST", path, body: payload } },
          async () => {
            const response = await client.request<unknown>(path, {
              method: "POST",
              body: payload,
              retry: false,
            });
            return startedJobResult(response, args.response_format);
          },
        );
      }),
  );
}

function registerRunScript(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_run_script",
    {
      title: "Run a script (auto-route by endpoint OS)",
      description: "Cross-platform script runner. Routes to PowerShell (Windows) or Bash (macOS); errors on Linux/unknown.",
      inputSchema: {
        ...scriptInputShape,
        success_exit_codes: z
          .string()
          .optional()
          .describe("PowerShell only; ignored on macOS."),
        skip_connectivity_check: z
          .boolean()
          .optional()
          .describe("Skip offline-abort check."),
      },
      outputSchema: okStatusOutputShape,
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async (args) =>
      runTool(async () => {
        const cfg = loadConfig();
        const orgId = resolveOrgId(args.org_id, cfg);
        const info = await fetchEndpointInfo(client, orgId, args.endpoint_id);
        const platform: Platform = detectPlatform(info.data);
        if (!args.skip_connectivity_check) {
          const conn = isEndpointActuallyOnline(info.data, cfg.lastSeenStaleMinutes);
          if (!conn.online) {
            return errorResult(
              `Aborting: endpoint not reachable. ${conn.reason} Pass skip_connectivity_check=true to send anyway.`,
            );
          }
        }
        if (platform === "windows") {
          const payload = buildWindowsPowerShellPayload({
            endpointId: args.endpoint_id,
            scriptText: args.script_text,
            ...(args.name !== undefined ? { name: args.name } : {}),
            successExitCodes: args.success_exit_codes ?? "0",
            timeoutMinutes: toMinutesString(args.timeout_minutes, cfg.defaultTimeoutMinutes),
            retryMinutes: toMinutesNumber(
              args.retry_minutes,
              Number.parseInt(cfg.defaultRetryMinutes, 10),
            ),
          });
          const path = `/policies/instances/${encodeURIComponent(orgId)}`;
          return runDestructive(
            args,
            { toolName: "action1_run_script", preview: { method: "POST", path, body: payload } },
            async () => {
              const response = await client.request<unknown>(path, {
                method: "POST",
                body: payload,
                retry: false,
              });
              return startedJobResult(response, args.response_format, { platform });
            },
          );
        }
        if (platform === "macos") {
          const payload = buildMacOsBashPayload({
            endpointId: args.endpoint_id,
            scriptText: args.script_text,
            ...(args.name !== undefined ? { name: args.name } : {}),
            retryMinutes: toMinutesString(args.retry_minutes, cfg.defaultRetryMinutes),
          });
          const path = `/automations/instances/${encodeURIComponent(orgId)}`;
          return runDestructive(
            args,
            { toolName: "action1_run_script", preview: { method: "POST", path, body: payload } },
            async () => {
              const response = await client.request<unknown>(path, {
                method: "POST",
                body: payload,
                retry: false,
              });
              return startedJobResult(response, args.response_format, { platform });
            },
          );
        }
        return errorResult(
          `Cannot auto-run on platform "${platform}". Use action1_run_powershell or action1_run_bash_macos directly, or run via the appropriate Action1 template.`,
        );
      }),
  );
}

function registerReboot(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_reboot_endpoint",
    {
      title: "Reboot an endpoint",
      description: "Reboots the host via the reboot action template. Combine with action1_wait_for_automation to track recovery.",
      inputSchema: {
        ...orgIdShape,
        ...destructiveGuardShape,
        ...targetTypeShape,
        ...formatShape,
        endpoint_id: endpointOrGroupIdSchema,
        name: z
          .string()
          .optional()
          .describe("Friendly action name."),
        skip_connectivity_check: z
          .boolean()
          .optional()
          .describe("Skip offline-abort check."),
      },
      outputSchema: okStatusOutputShape,
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async (args) =>
      runTool(async () => {
        const cfg = loadConfig();
        const orgId = resolveOrgId(args.org_id, cfg);
        const payload = buildSimplePolicyPayload({
          endpointId: args.endpoint_id,
          ...(args.target_type ? { targetType: args.target_type } : {}),
          templateId: "reboot",
          actionName: "Reboot",
          ...(args.name !== undefined ? { name: args.name } : {}),
        });
        const path = `/policies/instances/${encodeURIComponent(orgId)}`;
        return runDestructive(
          args,
          { toolName: "action1_reboot_endpoint", preview: { method: "POST", path, body: payload } },
          async () => {
            // Connectivity check: a reboot fired against an offline
            // endpoint sits in the Action1 queue and silently fires at
            // the next check-in, possibly days later. Mirrors
            // run_script's check so an offline endpoint aborts the
            // call instead of arming a delayed reboot. Skipped for
            // EndpointGroup targets (no single endpoint to probe) and
            // when skip_connectivity_check=true.
            //
            // The check lives inside the perform-callback so the
            // dry_run preview short-circuits in `runDestructive`
            // BEFORE issuing a `GET /endpoints/managed/...` — we don't
            // want a preview to make any upstream calls.
            if (
              !args.skip_connectivity_check &&
              (args.target_type ?? "Endpoint") === "Endpoint"
            ) {
              const info = await fetchEndpointInfo(client, orgId, args.endpoint_id);
              const conn = isEndpointActuallyOnline(info.data, cfg.lastSeenStaleMinutes);
              if (!conn.online) {
                return errorResult(
                  `Aborting: endpoint not reachable. ${conn.reason} Pass skip_connectivity_check=true to send anyway (the reboot will queue and fire on the next check-in).`,
                );
              }
            }
            const response = await client.request<unknown>(path, {
              method: "POST",
              body: payload,
              retry: false,
            });
            return startedJobResult(response, args.response_format);
          },
        );
      }),
  );
}

function registerDeployUpdate(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_deploy_update",
    {
      title: "Deploy specific updates to an endpoint",
      description: "Deploy one or more updates (by package id) via the deploy_update template.",
      inputSchema: {
        ...orgIdShape,
        ...destructiveGuardShape,
        ...targetTypeShape,
        ...formatShape,
        endpoint_id: endpointOrGroupIdSchema,
        updates: z
          .array(
            z.object({
              package_id: z
                .string()
                .min(1)
                .describe("Package id from missing-updates."),
              version: z
                .string()
                .describe("Target version (empty string for latest)."),
            }),
          )
          .min(1)
          .describe("Updates to deploy."),
        reboot_after: z
          .enum(["no", "if_required", "yes"])
          .optional()
          .describe("Reboot policy after deploy."),
        display_summary: z
          .string()
          .optional()
          .describe("Optional console summary."),
        name: z
          .string()
          .optional()
          .describe("Friendly action name."),
      },
      outputSchema: okStatusOutputShape,
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async (args) =>
      runTool(async () => {
        const orgId = resolveOrgId(args.org_id);
        const packages = args.updates.map((u) => ({ [u.package_id]: u.version }));
        const payload = buildSimplePolicyPayload({
          endpointId: args.endpoint_id,
          ...(args.target_type ? { targetType: args.target_type } : {}),
          templateId: "deploy_update",
          actionName: "Deploy Update",
          params: {
            scope: "Specified",
            packages,
            display_summary: args.display_summary ?? "",
            reboot_options: { auto_reboot: args.reboot_after ?? "no" },
          },
          ...(args.name !== undefined ? { name: args.name } : {}),
        });
        const path = `/policies/instances/${encodeURIComponent(orgId)}`;
        return runDestructive(
          args,
          { toolName: "action1_deploy_update", preview: { method: "POST", path, body: payload } },
          async () => {
            const response = await client.request<unknown>(path, {
              method: "POST",
              body: payload,
              retry: false,
            });
            return startedJobResult(response, args.response_format);
          },
        );
      }),
  );
}

function registerDeployPackage(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_deploy_package",
    {
      title: "Deploy a software package",
      description: "Deploy software via the deploy_package template. Use action1_get_action_template for the params schema.",
      inputSchema: {
        ...orgIdShape,
        ...destructiveGuardShape,
        ...targetTypeShape,
        ...formatShape,
        endpoint_id: endpointOrGroupIdSchema,
        params: z
          .record(z.unknown())
          .describe("Template params for deploy_package."),
        name: z
          .string()
          .optional()
          .describe("Friendly action name."),
      },
      outputSchema: okStatusOutputShape,
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async (args) =>
      runTool(async () => {
        const orgId = resolveOrgId(args.org_id);
        const payload = buildSimplePolicyPayload({
          endpointId: args.endpoint_id,
          ...(args.target_type ? { targetType: args.target_type } : {}),
          templateId: "deploy_package",
          actionName: "Deploy Package",
          params: args.params,
          ...(args.name !== undefined ? { name: args.name } : {}),
        });
        const path = `/policies/instances/${encodeURIComponent(orgId)}`;
        return runDestructive(
          args,
          { toolName: "action1_deploy_package", preview: { method: "POST", path, body: payload } },
          async () => {
            const response = await client.request<unknown>(path, {
              method: "POST",
              body: payload,
              retry: false,
            });
            return startedJobResult(response, args.response_format);
          },
        );
      }),
  );
}

function registerUninstallProgram(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_uninstall_program",
    {
      title: "Uninstall a program",
      description: "Uninstall software via the uninstall_program template. Use action1_get_action_template for the params schema.",
      inputSchema: {
        ...orgIdShape,
        ...destructiveGuardShape,
        ...targetTypeShape,
        ...formatShape,
        endpoint_id: endpointOrGroupIdSchema,
        params: z
          .record(z.unknown())
          .describe("Template params for uninstall_program."),
        name: z
          .string()
          .optional()
          .describe("Friendly action name."),
      },
      outputSchema: okStatusOutputShape,
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async (args) =>
      runTool(async () => {
        const orgId = resolveOrgId(args.org_id);
        const payload = buildSimplePolicyPayload({
          endpointId: args.endpoint_id,
          ...(args.target_type ? { targetType: args.target_type } : {}),
          templateId: "uninstall_program",
          actionName: "Uninstall Program",
          params: args.params,
          ...(args.name !== undefined ? { name: args.name } : {}),
        });
        const path = `/policies/instances/${encodeURIComponent(orgId)}`;
        return runDestructive(
          args,
          {
            toolName: "action1_uninstall_program",
            preview: { method: "POST", path, body: payload },
          },
          async () => {
            const response = await client.request<unknown>(path, {
              method: "POST",
              body: payload,
              retry: false,
            });
            return startedJobResult(response, args.response_format);
          },
        );
      }),
  );
}

function registerRunDataCollection(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_run_data_collection",
    {
      title: "Run a data collection",
      description: "Trigger the run_data_collection template on an endpoint.",
      inputSchema: {
        ...orgIdShape,
        ...destructiveGuardShape,
        ...targetTypeShape,
        ...formatShape,
        endpoint_id: endpointOrGroupIdSchema,
        params: z.record(z.unknown()).optional().describe("Optional template params."),
        name: z
          .string()
          .optional()
          .describe("Friendly action name."),
      },
      outputSchema: okStatusOutputShape,
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async (args) =>
      runTool(async () => {
        const orgId = resolveOrgId(args.org_id);
        const payload = buildSimplePolicyPayload({
          endpointId: args.endpoint_id,
          ...(args.target_type ? { targetType: args.target_type } : {}),
          templateId: "run_data_collection",
          actionName: "Run Data Collection",
          ...(args.params !== undefined ? { params: args.params } : {}),
          ...(args.name !== undefined ? { name: args.name } : {}),
        });
        const path = `/policies/instances/${encodeURIComponent(orgId)}`;
        return runDestructive(
          args,
          {
            toolName: "action1_run_data_collection",
            preview: { method: "POST", path, body: payload },
          },
          async () => {
            const response = await client.request<unknown>(path, {
              method: "POST",
              body: payload,
              retry: false,
            });
            return startedJobResult(response, args.response_format);
          },
        );
      }),
  );
}

/**
 * Wrap a started-action upstream response into a CallToolResult.
 *
 * When the upstream returns a parseable string `id` / `instance_id`,
 * emit a success-shape with that id. When it doesn't, emit an
 * `errorResult` instead of a success-shape with `instance_id: undefined`
 * — downstream tools like `action1_wait_for_automation` validate
 * `instance_id` and crash on undefined, so a silent success-shape with
 * an undefined id is worse than an explicit error.
 *
 * Mirrors the workflows.ts:waitForInstance error path for shape
 * consistency.
 */
function startedJobResult(
  response: unknown,
  format: "json" | "markdown" | undefined,
  extra: Record<string, unknown> = {},
): CallToolResult {
  const instanceId = extractInstanceId(response);
  if (instanceId === undefined) {
    return errorResult(
      `no_instance_id: Upstream did not return a parseable instance id. raw_body=${redactString(
        JSON.stringify(response ?? null),
      )}`,
    );
  }
  const payload = { instance_id: instanceId, raw: response, ...extra };
  return jsonResult(payload, payload, format);
}

function extractInstanceId(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const obj = response as Record<string, unknown>;
  if (typeof obj.id === "string") return obj.id;
  if (typeof obj.instance_id === "string") return obj.instance_id;
  return undefined;
}
