import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Action1Client } from "../client/action1Client.js";
import { loadConfig, resolveOrgId } from "../config.js";
import {
  endpointOrGroupIdSchema,
  formatShape,
  okStatusOutputShape,
  orgIdShape,
  runTool,
} from "./helpers.js";
import { destructiveGuardShape } from "./destructiveGuard.js";
import { buildSimplePolicyPayload } from "../payloads/policyInstance.js";
import {
  buildScriptRequest,
  minutesShape,
  policyInstancesPath,
  probeEndpoint,
  resolveScriptPlatform,
  scriptOsSchema,
  startAction,
  successExitCodesSchema,
  targetTypeShape,
  type ScriptPlatform,
} from "./startAction.js";

const scriptInputShape = {
  ...orgIdShape,
  ...destructiveGuardShape,
  ...targetTypeShape,
  ...formatShape,
  endpoint_id: endpointOrGroupIdSchema,
  script_text: z.string().min(1).describe("Script source."),
  name: z.string().optional().describe("Friendly action name."),
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
  registerTemplateTool(server, client, {
    name: "action1_deploy_update",
    title: "Deploy specific updates to an endpoint",
    description: "Deploy one or more updates (by package id) via the deploy_update template.",
    templateId: "deploy_update",
    actionName: "Deploy Update",
    shape: {
      updates: z
        .array(
          z.object({
            package_id: z.string().min(1).describe("Package id from missing-updates."),
            version: z
              .string()
              .describe(
                "Version to deploy, as listed by the missing-update or vulnerability tools (repository packages list 'Latest'). Passed through unchanged; see docs/GOTCHAS.md.",
              ),
          }),
        )
        .min(1)
        .describe("Updates to deploy."),
      reboot_after: z
        .enum(["no", "if_required", "yes"])
        .optional()
        .describe("Reboot policy after deploy."),
      display_summary: z.string().optional().describe("Optional console summary."),
    },
    params: (args) => ({
      scope: "Specified",
      packages: args.updates.map((u) => ({ [u.package_id]: u.version })),
      display_summary: args.display_summary ?? "",
      reboot_options: { auto_reboot: args.reboot_after ?? "no" },
    }),
  });
  registerTemplateTool(server, client, {
    name: "action1_deploy_package",
    title: "Deploy a software package",
    description:
      "Deploy software via the deploy_package template. Use action1_get_action_template for the params schema.",
    templateId: "deploy_package",
    actionName: "Deploy Package",
    shape: {
      params: z.record(z.string(), z.unknown()).describe("Template params for deploy_package."),
    },
    params: (args) => args.params,
  });
  registerTemplateTool(server, client, {
    name: "action1_uninstall_program",
    title: "Uninstall a program",
    description:
      "Uninstall software via the uninstall_program template. Use action1_get_action_template for the params schema.",
    templateId: "uninstall_program",
    actionName: "Uninstall Program",
    shape: {
      params: z.record(z.string(), z.unknown()).describe("Template params for uninstall_program."),
    },
    params: (args) => args.params,
  });
  registerTemplateTool(server, client, {
    name: "action1_run_data_collection",
    title: "Run a data collection",
    description: "Trigger the run_data_collection template on an endpoint.",
    templateId: "run_data_collection",
    actionName: "Run Data Collection",
    shape: {
      params: z.record(z.string(), z.unknown()).optional().describe("Optional template params."),
    },
    params: (args) => args.params,
  });
}

type ScriptArgs = z.infer<z.ZodObject<typeof scriptInputShape>> & {
  os?: ScriptPlatform | undefined;
  success_exit_codes?: string | undefined;
  skip_connectivity_check?: boolean | undefined;
};

/**
 * Shared body of the three script tools. A fixed platform (run_powershell,
 * run_bash_macos) skips the endpoint lookup; otherwise run_script resolves
 * it (explicit `os` for groups, detection for a single endpoint).
 */
async function runScript(
  client: Action1Client,
  toolName: string,
  args: ScriptArgs,
  fixedPlatform?: ScriptPlatform,
): Promise<CallToolResult> {
  const cfg = loadConfig();
  const orgId = resolveOrgId(args.org_id, cfg);
  let platform: ScriptPlatform;
  if (fixedPlatform) {
    platform = fixedPlatform;
  } else {
    const resolved = await resolveScriptPlatform(client, {
      orgId,
      endpointId: args.endpoint_id,
      targetType: args.target_type,
      os: args.os,
      skipConnectivityCheck: args.skip_connectivity_check,
      lastSeenStaleMinutes: cfg.lastSeenStaleMinutes,
      unsupportedHint:
        "Use action1_run_powershell or action1_run_bash_macos directly, or run via the appropriate Action1 template.",
    });
    if (!resolved.ok) return resolved.error;
    platform = resolved.platform;
  }
  const request = buildScriptRequest(
    platform,
    {
      orgId,
      endpointId: args.endpoint_id,
      targetType: args.target_type,
      scriptText: args.script_text,
      name: args.name,
      successExitCodes: args.success_exit_codes,
      timeoutMinutes: args.timeout_minutes,
      retryMinutes: args.retry_minutes,
    },
    cfg,
  );
  return startAction(client, args, {
    toolName,
    ...request,
    ...(fixedPlatform ? {} : { extra: { platform } }),
  });
}

function registerRunPowerShell(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_run_powershell",
    {
      title: "Run PowerShell on a Windows endpoint",
      description:
        "Run PowerShell on a Windows endpoint via the run_powershell template. Runs as SYSTEM (no user profile).",
      inputSchema: z.object({
        ...scriptInputShape,
        success_exit_codes: successExitCodesSchema
          .optional()
          .describe("Comma-separated success exit codes."),
      }),
      outputSchema: okStatusOutputShape,
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async (args) => runTool(() => runScript(client, "action1_run_powershell", args, "windows")),
  );
}

function registerRunBashMacOs(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_run_bash_macos",
    {
      title: "Run a Bash script on a macOS endpoint",
      description:
        "Run a Bash script on a macOS endpoint via the run_script template. For OS-aware routing use action1_run_script.",
      inputSchema: z.object(scriptInputShape),
      outputSchema: okStatusOutputShape,
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async (args) => runTool(() => runScript(client, "action1_run_bash_macos", args, "macos")),
  );
}

function registerRunScript(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_run_script",
    {
      title: "Run a script (auto-route by endpoint OS)",
      description:
        "Cross-platform script runner. Routes to PowerShell (Windows) or Bash (macOS); errors on Linux/unknown. For target_type='EndpointGroup' pass os ('windows' or 'macos').",
      inputSchema: z.object({
        ...scriptInputShape,
        os: scriptOsSchema
          .optional()
          .describe(
            "Script OS. Required for target_type='EndpointGroup'; for a single endpoint it must match the detected OS.",
          ),
        success_exit_codes: successExitCodesSchema
          .optional()
          .describe("PowerShell only; ignored on macOS."),
        skip_connectivity_check: z.boolean().optional().describe("Skip offline-abort check."),
      }),
      outputSchema: okStatusOutputShape,
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async (args) => runTool(() => runScript(client, "action1_run_script", args)),
  );
}

function registerReboot(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_reboot_endpoint",
    {
      title: "Reboot an endpoint",
      description:
        "Reboots the host via the reboot action template. Combine with action1_wait_for_automation to track recovery.",
      inputSchema: z.object({
        ...orgIdShape,
        ...destructiveGuardShape,
        ...targetTypeShape,
        ...formatShape,
        endpoint_id: endpointOrGroupIdSchema,
        name: z.string().optional().describe("Friendly action name."),
        skip_connectivity_check: z.boolean().optional().describe("Skip offline-abort check."),
      }),
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
        return startAction(client, args, {
          toolName: "action1_reboot_endpoint",
          path: policyInstancesPath(orgId),
          payload,
          // A reboot sent to an offline endpoint queues and fires at the
          // next check-in, possibly days later, so a single endpoint is
          // probed first. The probe runs after the guard: a dry_run
          // preview makes no upstream call. Groups have no single
          // endpoint to probe.
          beforePost: async () => {
            if (args.skip_connectivity_check || (args.target_type ?? "Endpoint") !== "Endpoint") {
              return null;
            }
            const probe = await probeEndpoint(client, {
              orgId,
              endpointId: args.endpoint_id,
              lastSeenStaleMinutes: cfg.lastSeenStaleMinutes,
              offlineHint:
                "Pass skip_connectivity_check=true to send anyway (the reboot will queue and fire on the next check-in).",
            });
            return probe.ok ? null : probe.error;
          },
        });
      }),
  );
}

const templateBaseShape = {
  ...orgIdShape,
  ...destructiveGuardShape,
  ...targetTypeShape,
  ...formatShape,
  endpoint_id: endpointOrGroupIdSchema,
};

const nameShape = { name: z.string().optional().describe("Friendly action name.") };

interface TemplateToolSpec<S extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  templateId: string;
  actionName: string;
  shape: S;
  params: (args: z.infer<z.ZodObject<S>>) => Record<string, unknown> | undefined;
}

// Template tools without OS routing or connectivity probe: build the
// policy payload, then guard and POST.
function registerTemplateTool<S extends z.ZodRawShape>(
  server: McpServer,
  client: Action1Client,
  spec: TemplateToolSpec<S>,
): void {
  const inputSchema = z.object({ ...templateBaseShape, ...spec.shape, ...nameShape });
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema,
      outputSchema: okStatusOutputShape,
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async (rawArgs) =>
      runTool(async () => {
        const args = rawArgs as z.infer<z.ZodObject<typeof templateBaseShape>> &
          z.infer<z.ZodObject<typeof nameShape>>;
        const orgId = resolveOrgId(args.org_id);
        const params = spec.params(rawArgs as z.infer<z.ZodObject<S>>);
        const payload = buildSimplePolicyPayload({
          endpointId: args.endpoint_id,
          ...(args.target_type ? { targetType: args.target_type } : {}),
          templateId: spec.templateId,
          actionName: spec.actionName,
          ...(params !== undefined ? { params } : {}),
          ...(args.name !== undefined ? { name: args.name } : {}),
        });
        return startAction(client, args, {
          toolName: spec.name,
          path: policyInstancesPath(orgId),
          payload,
        });
      }),
  );
}
