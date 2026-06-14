import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Action1Client } from "../client/action1Client.js";
import { loadConfig, resolveOrgId } from "../config.js";
import {
  errorResult,
  formatShape,
  jsonResult,
  okStatusOutputShape,
  orgIdShape,
  runTool,
  singleObjectOutputShape,
} from "./helpers.js";
import { Action1TimeoutError } from "../client/errors.js";
import { filterEndpointResultDetails } from "../utils/filterOutput.js";
import { sleep } from "../utils/sleep.js";
import { DEFAULT_POLL_INTERVAL_MS } from "../constants.js";
import {
  buildSimplePolicyPayload,
  buildWindowsPowerShellPayload,
} from "../payloads/windowsPowerShell.js";
import { buildMacOsBashPayload } from "../payloads/macOsBash.js";
import { detectPlatform, type Platform } from "../utils/osDetect.js";
import { isEndpointActuallyOnline } from "../utils/lastSeen.js";
import { fetchEndpointInfo } from "../client/endpointInfo.js";
import { checkDestructiveGuard, destructiveGuardShape } from "./destructiveGuard.js";

const TERMINAL_STATUSES = new Set(["Success", "Failed", "Stopped", "Error", "Canceled"]);

interface InstanceStatus {
  status?: unknown;
  percent_completed?: unknown;
  id?: unknown;
}

export function registerWorkflowTools(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_wait_for_automation",
    {
      title: "Poll an automation until it terminates",
      description: "Block until an automation instance reaches a terminal status (Success/Failed/Stopped/Error/Canceled) or timeout.",
      inputSchema: {
        ...orgIdShape,
        ...formatShape,
        instance_id: z.string().min(1).describe("Instance UUID."),
        endpoint_id: z
          .string()
          .min(1)
          .optional()
          .describe("If set, also fetch filtered script output."),
        timeout_seconds: z
          .number()
          .int()
          .min(5)
          .max(3600)
          .default(300)
          .describe("Polling timeout."),
        poll_interval_seconds: z
          .number()
          .int()
          .min(1)
          .max(60)
          .default(DEFAULT_POLL_INTERVAL_MS / 1000)
          .describe("Poll interval seconds."),
      },
      outputSchema: singleObjectOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (
      {
        org_id,
        instance_id,
        endpoint_id,
        timeout_seconds,
        poll_interval_seconds,
        response_format,
      },
      extra,
    ) =>
      runTool(async () => {
        const orgId = resolveOrgId(org_id);
        const finalStatus = await waitForInstance(client, orgId, instance_id, {
          timeoutMs: timeout_seconds * 1000,
          intervalMs: poll_interval_seconds * 1000,
          ...(extra?.signal ? { signal: extra.signal } : {}),
        });
        let output: string | undefined;
        if (endpoint_id) {
          output = await fetchFilteredOutput(client, orgId, instance_id, endpoint_id);
        }
        return jsonResult(
          { status: finalStatus, ...(output !== undefined ? { output } : {}) },
          {
            status: finalStatus,
            ...(output !== undefined ? { output } : {}),
          },
          response_format,
        );
      }),
  );

  server.registerTool(
    "action1_execute_and_wait",
    {
      title: "Execute and wait for output (script or template)",
      description: "One-shot helper: starts an action (auto-routes by OS for 'script', or runs a template), polls until terminal, returns filtered output.",
      inputSchema: {
        ...orgIdShape,
        ...destructiveGuardShape,
        ...formatShape,
        endpoint_id: z.string().min(1).describe("Endpoint UUID."),
        mode: z
          .enum(["script", "template"])
          .default("script")
          .describe("'script' auto-routes by OS; 'template' runs a template_id."),
        script_text: z.string().optional().describe("Required when mode='script'."),
        template_id: z.string().optional().describe("Required when mode='template'."),
        params: z
          .record(z.unknown())
          .optional()
          .describe("Template params when mode='template'."),
        success_exit_codes: z
          .string()
          .optional()
          .describe("PowerShell only. Default '0'."),
        timeout_seconds: z
          .number()
          .int()
          .min(5)
          .max(3600)
          .default(300)
          .describe("Polling timeout."),
        poll_interval_seconds: z
          .number()
          .int()
          .min(1)
          .max(60)
          .default(DEFAULT_POLL_INTERVAL_MS / 1000)
          .describe("Poll interval seconds."),
        skip_connectivity_check: z
          .boolean()
          .optional()
          .describe("Skip offline-abort check."),
        name: z
          .string()
          .optional()
          .describe("Friendly action name."),
      },
      outputSchema: okStatusOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) =>
      runTool(async () => {
        const cfg = loadConfig();
        const orgId = resolveOrgId(args.org_id, cfg);
        const info = await fetchEndpointInfo(client, orgId, args.endpoint_id);
        void extra;
        const platform: Platform = detectPlatform(info.data);
        if (!args.skip_connectivity_check) {
          const conn = isEndpointActuallyOnline(info.data, cfg.lastSeenStaleMinutes);
          if (!conn.online) {
            return errorResult(
              `Aborting: endpoint not reachable. ${conn.reason} Pass skip_connectivity_check=true to send anyway.`,
            );
          }
        }

        let postPath: string;
        let payload: unknown;

        if (args.mode === "script") {
          if (!args.script_text) {
            return errorResult("script_text is required when mode = 'script'.");
          }
          if (platform === "windows") {
            postPath = `/policies/instances/${encodeURIComponent(orgId)}`;
            payload = buildWindowsPowerShellPayload({
              endpointId: args.endpoint_id,
              scriptText: args.script_text,
              ...(args.name !== undefined ? { name: args.name } : {}),
              successExitCodes: args.success_exit_codes ?? "0",
              timeoutMinutes: cfg.defaultTimeoutMinutes,
              retryMinutes: Number.parseInt(cfg.defaultRetryMinutes, 10),
            });
          } else if (platform === "macos") {
            postPath = `/automations/instances/${encodeURIComponent(orgId)}`;
            payload = buildMacOsBashPayload({
              endpointId: args.endpoint_id,
              scriptText: args.script_text,
              ...(args.name !== undefined ? { name: args.name } : {}),
              retryMinutes: cfg.defaultRetryMinutes,
            });
          } else {
            return errorResult(
              `Cannot auto-run on platform "${platform}". Use mode='template' with the appropriate template_id.`,
            );
          }
        } else {
          if (!args.template_id) {
            return errorResult("template_id is required when mode = 'template'.");
          }
          postPath = `/policies/instances/${encodeURIComponent(orgId)}`;
          payload = buildSimplePolicyPayload({
            endpointId: args.endpoint_id,
            templateId: args.template_id,
            ...(args.params !== undefined ? { params: args.params } : {}),
            ...(args.name !== undefined ? { name: args.name } : {}),
          });
        }

        const guard = checkDestructiveGuard(args, {
          toolName: "action1_execute_and_wait",
          preview: { method: "POST", path: postPath, body: payload },
        });
        if (guard) return guard;

        // `retry: false` is intentional here: POST /policies/instances
        // (and /automations/instances) creates a brand-new action
        // instance server-side, and retrying after a network blip
        // would risk starting the action *twice* against the
        // endpoint. We'd rather surface the error to the agent and
        // let it confirm via list-recent before re-issuing than
        // silently double-fire a script.
        let startResponse: { id?: unknown };
        try {
          startResponse = await client.request<{ id?: unknown }>(postPath, {
            method: "POST",
            body: payload,
            retry: false,
          });
        } catch (err) {
          // Inject an ID-hint into the surfaced error so the agent
          // knows the request *may* have succeeded server-side even
          // though we got an error locally — common for transient
          // 5xx and connection-reset cases on the create path.
          const baseMsg = err instanceof Error ? err.message : String(err);
          throw new Error(
            `${baseMsg}\n\nNote: the action may have started server-side despite this error; check action1_list_recent_automations for the most recent instance to confirm.`,
          );
        }
        const instanceId = typeof startResponse?.id === "string" ? startResponse.id : undefined;
        if (!instanceId) {
          return errorResult(
            `Started action but the API did not return an instance id. Raw response: ${JSON.stringify(startResponse)}`,
          );
        }

        const finalStatus = await waitForInstance(client, orgId, instanceId, {
          timeoutMs: args.timeout_seconds * 1000,
          intervalMs: args.poll_interval_seconds * 1000,
          ...(extra?.signal ? { signal: extra.signal } : {}),
        });
        const output = await fetchFilteredOutput(client, orgId, instanceId, args.endpoint_id);
        return jsonResult(
          { instance_id: instanceId, platform, status: finalStatus, output },
          {
            instance_id: instanceId,
            platform,
            status: finalStatus,
            output,
          },
          args.response_format,
        );
      }),
  );
}

interface PollOptions {
  timeoutMs: number;
  intervalMs: number;
  signal?: AbortSignal;
}

async function waitForInstance(
  client: Action1Client,
  orgId: string,
  instanceId: string,
  opts: PollOptions,
): Promise<InstanceStatus> {
  const deadline = Date.now() + opts.timeoutMs;
  let last: InstanceStatus = {};
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    last = await client.request<InstanceStatus>(
      `/automations/instances/${encodeURIComponent(orgId)}/${encodeURIComponent(instanceId)}`,
      opts.signal ? { signal: opts.signal } : {},
    );
    if (typeof last.status === "string" && TERMINAL_STATUSES.has(last.status)) {
      return last;
    }
    // FOLLOW-UP: an earlier revision short-circuited on
    // `status==="Running" && percent_completed==="100"` to work around a
    // suspected Action1 bug where Running tasks would hang at 100%.
    // That short-circuit was removed: correctness > performance for a
    // tool that drives destructive workflows. If the bug resurfaces,
    // file an upstream ticket — do not re-add the hack here. Only the
    // states in TERMINAL_STATUSES terminate the poll.
    await sleep(opts.intervalMs, opts.signal);
  }
  throw new Action1TimeoutError(
    `Polling exceeded ${Math.round(opts.timeoutMs / 1000)}s. Aborted to avoid runaway loop. Use action1_get_automation_status to inspect manually. Last status: ${JSON.stringify(last)}`,
  );
}

async function fetchFilteredOutput(
  client: Action1Client,
  orgId: string,
  instanceId: string,
  endpointId: string,
): Promise<string> {
  const data = await client.request<{ items?: unknown }>(
    `/automations/instances/${encodeURIComponent(orgId)}/${encodeURIComponent(instanceId)}/endpoint-results/${encodeURIComponent(endpointId)}/details`,
  );
  return filterEndpointResultDetails(data?.items ?? data).output;
}

