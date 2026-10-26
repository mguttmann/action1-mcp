import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Action1Client } from "../client/action1Client.js";
import { loadConfig, resolveOrgId } from "../config.js";
import {
  endpointIdSchema,
  errorResult,
  formatShape,
  jsonResult,
  okStatusOutputShape,
  orgIdShape,
  runTool,
  objectOutputShape,
  upstreamBodyText,
} from "./helpers.js";
import { Action1ApiError, Action1TimeoutError } from "../client/errors.js";
import { log } from "../utils/logger.js";
import { filterEndpointResultDetails } from "../utils/filterOutput.js";
import { sleep } from "../utils/sleep.js";
import { DEFAULT_POLL_INTERVAL_MS } from "../constants.js";
import { buildSimplePolicyPayload } from "../payloads/policyInstance.js";
import { detectPlatform, type Platform } from "../utils/osDetect.js";
import {
  buildScriptRequest,
  policyInstancesPath,
  probeEndpoint,
  resolveScriptPlatform,
  successExitCodesSchema,
} from "./startAction.js";
import { checkDestructiveGuard, destructiveGuardShape } from "./destructiveGuard.js";

import { AUTOMATION_TERMINAL_STATUSES, isTerminalAutomationStatus } from "../spec/entities.js";

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
      description:
        "Block until an automation instance reaches a terminal status (" +
        AUTOMATION_TERMINAL_STATUSES.join("/") +
        ") or timeout.",
      inputSchema: z.object({
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
      }),
      outputSchema: objectOutputShape({ status: "object", output: "string" }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (
      { org_id, instance_id, endpoint_id, timeout_seconds, poll_interval_seconds, response_format },
      ctx,
    ) =>
      runTool(async () => {
        const orgId = resolveOrgId(org_id);
        const signal = ctx?.mcpReq.signal;
        let finalStatus: InstanceStatus;
        let output: string | undefined;
        try {
          finalStatus = await waitForInstance(client, orgId, instance_id, {
            timeoutMs: timeout_seconds * 1000,
            intervalMs: poll_interval_seconds * 1000,
            ...(signal ? { signal } : {}),
            onPoll: progressReporter(ctx, instance_id),
          });
          if (endpoint_id) {
            output = await fetchFilteredOutput(client, orgId, instance_id, endpoint_id, signal);
          }
        } catch (err) {
          throw new Error(
            `${describeError(err)}\n\nThis happened while waiting for automation instance ${instance_id}. Call action1_wait_for_automation again with instance_id "${instance_id}" to keep waiting.`,
          );
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
      description:
        "One-shot helper: starts an action (auto-routes by OS for 'script', or runs a template), polls until terminal, returns filtered output.",
      inputSchema: z.object({
        ...orgIdShape,
        ...destructiveGuardShape,
        ...formatShape,
        endpoint_id: endpointIdSchema,
        mode: z
          .enum(["script", "template"])
          .default("script")
          .describe("'script' auto-routes by OS; 'template' runs a template_id."),
        script_text: z.string().optional().describe("Required when mode='script'."),
        template_id: z.string().optional().describe("Required when mode='template'."),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Template params when mode='template'."),
        success_exit_codes: successExitCodesSchema
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
        skip_connectivity_check: z.boolean().optional().describe("Skip offline-abort check."),
        name: z.string().optional().describe("Friendly action name."),
      }),
      outputSchema: okStatusOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, ctx) =>
      runTool(async () => {
        const cfg = loadConfig();
        const orgId = resolveOrgId(args.org_id, cfg);
        const signal = ctx?.mcpReq.signal;
        if (args.mode === "script" && !args.script_text) {
          return errorResult("script_text is required when mode = 'script'.");
        }
        if (args.mode === "template" && !args.template_id) {
          return errorResult("template_id is required when mode = 'template'.");
        }

        // Script mode needs the endpoint OS for the payload, so the
        // endpoint lookup (and the connectivity check) runs before the
        // guard and therefore also for dry_run. See docs/SECURITY.md.
        let platform: Platform;
        let postPath: string;
        let payload: unknown;

        if (args.mode === "script") {
          const resolved = await resolveScriptPlatform(client, {
            orgId,
            endpointId: args.endpoint_id,
            skipConnectivityCheck: args.skip_connectivity_check,
            lastSeenStaleMinutes: cfg.lastSeenStaleMinutes,
            unsupportedHint: "Use mode='template' with the appropriate template_id.",
            signal,
          });
          if (!resolved.ok) return resolved.error;
          platform = resolved.platform;
          ({ path: postPath, payload } = buildScriptRequest(
            resolved.platform,
            {
              orgId,
              endpointId: args.endpoint_id,
              scriptText: args.script_text!,
              name: args.name,
              successExitCodes: args.success_exit_codes,
            },
            cfg,
          ));
        } else {
          const probe = await probeEndpoint(client, {
            orgId,
            endpointId: args.endpoint_id,
            skipConnectivityCheck: args.skip_connectivity_check,
            lastSeenStaleMinutes: cfg.lastSeenStaleMinutes,
            signal,
          });
          if (!probe.ok) return probe.error;
          platform = detectPlatform(probe.data);
          postPath = policyInstancesPath(orgId);
          payload = buildSimplePolicyPayload({
            endpointId: args.endpoint_id,
            templateId: args.template_id!,
            ...(args.params !== undefined ? { params: args.params } : {}),
            ...(args.name !== undefined ? { name: args.name } : {}),
          });
        }

        const guard = checkDestructiveGuard(args, {
          toolName: "action1_execute_and_wait",
          preview: { method: "POST", path: postPath, body: payload },
        });
        if (guard) return guard;

        // POST /policies/instances (and /automations/instances) creates a
        // new action instance server-side. The client never re-sends a
        // non-idempotent request after it may have reached Action1 (only
        // 429 and connect-level failures are retried), so the action
        // cannot start twice because of a retry.
        let startResponse: { id?: unknown };
        try {
          startResponse = await client.request<{ id?: unknown }>(postPath, {
            method: "POST",
            body: payload,
            ...(signal ? { signal } : {}),
          });
        } catch (err) {
          // A 4xx means Action1 rejected the request: nothing started.
          // Any other failure (5xx, timeout, connection reset after the
          // send) may have reached Action1, so the action may be running.
          const startError =
            err instanceof Action1ApiError
              ? err.toToolErrorText()
              : err instanceof Error
                ? err.message
                : String(err);
          const rejected = err instanceof Action1ApiError && err.status >= 400 && err.status < 500;
          if (rejected) return errorResult(startError);
          return errorResult(
            `${startError}\n\nNote: the action may have started server-side despite this error; check action1_list_recent_automations for the most recent instance to confirm.`,
          );
        }
        const instanceId = typeof startResponse?.id === "string" ? startResponse.id : undefined;
        if (!instanceId) {
          return errorResult(
            `Started action but the API did not return an instance id. Do not re-run the action blindly: check action1_list_recent_automations for the new instance first. Raw response: ${upstreamBodyText(startResponse)}`,
          );
        }

        // From here on the action is running. Every error must carry the
        // instance id and must not invite a second run. Announce the id
        // before polling: in the audit log, and to clients that asked for
        // progress, so it survives a client-side timeout of this call.
        log.audit("action_started", {
          tool: "action1_execute_and_wait",
          instance_id: instanceId,
          org: orgId,
          endpoint_id: args.endpoint_id,
        });
        await announceStart(ctx, instanceId, args.endpoint_id);
        let finalStatus: InstanceStatus;
        let output: string;
        try {
          finalStatus = await waitForInstance(client, orgId, instanceId, {
            timeoutMs: args.timeout_seconds * 1000,
            intervalMs: args.poll_interval_seconds * 1000,
            ...(signal ? { signal } : {}),
            onPoll: progressReporter(ctx, instanceId),
          });
          output = await fetchFilteredOutput(client, orgId, instanceId, args.endpoint_id, signal);
        } catch (err) {
          throw new Error(
            `${describeError(err)}\n\nThe action was started as automation instance ${instanceId}; this error happened afterwards, while waiting for its result. Do not re-run the action. Check its status with action1_wait_for_automation (instance_id "${instanceId}", endpoint_id "${args.endpoint_id}") or action1_get_automation_status.`,
          );
        }
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
  /** Called after every status poll with the 1-based poll count. */
  onPoll?: ((poll: number, status: unknown) => Promise<void>) | undefined;
}

/**
 * MCP progress notifications for a polling loop, one per poll, sent
 * only when the client asked for progress (request `_meta.progressToken`).
 * Progress keeps long waits visible to the client and lets clients that
 * reset their request timeout on progress wait past their default.
 */
function progressReporter(
  ctx: ServerContext | undefined,
  instanceId: string,
): PollOptions["onPoll"] {
  const progressToken = ctx?.mcpReq._meta?.progressToken;
  if (ctx === undefined || progressToken === undefined) return undefined;
  return async (poll, status) => {
    try {
      await ctx.mcpReq.notify({
        method: "notifications/progress",
        params: {
          progressToken,
          progress: poll,
          message: `Automation instance ${instanceId}: poll ${poll}, status ${typeof status === "string" ? status : "unknown"}`,
        },
      });
    } catch {
      // Progress is best effort; a failed notification must not fail the wait.
    }
  };
}

/**
 * Progress notification (progress 0) sent right after the action was
 * started, before the first status poll, carrying the instance id. A
 * client that gives up waiting still has the id to check the status
 * instead of starting the action again.
 */
async function announceStart(
  ctx: ServerContext | undefined,
  instanceId: string,
  endpointId: string,
): Promise<void> {
  const progressToken = ctx?.mcpReq._meta?.progressToken;
  if (ctx === undefined || progressToken === undefined) return;
  try {
    await ctx.mcpReq.notify({
      method: "notifications/progress",
      params: {
        progressToken,
        progress: 0,
        message: `Started automation instance ${instanceId}. If this call times out, do not re-run the action: check it with action1_wait_for_automation (instance_id "${instanceId}", endpoint_id "${endpointId}").`,
      },
    });
  } catch {
    // Best effort, like the per-poll progress.
  }
}

function describeError(err: unknown): string {
  if (err instanceof Action1ApiError) return err.toToolErrorText();
  if (err instanceof Error && err.name === "AbortError") {
    return "Waiting was cancelled by the client.";
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

async function waitForInstance(
  client: Action1Client,
  orgId: string,
  instanceId: string,
  opts: PollOptions,
): Promise<InstanceStatus> {
  const deadline = Date.now() + opts.timeoutMs;
  let last: InstanceStatus = {};
  let poll = 0;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    last = await client.request<InstanceStatus>(
      `/automations/instances/${encodeURIComponent(orgId)}/${encodeURIComponent(instanceId)}`,
      opts.signal ? { signal: opts.signal } : {},
    );
    poll += 1;
    await opts.onPoll?.(poll, last.status);
    // Only final states (src/spec/entities.ts) end the poll. A Running
    // instance at percent_completed 100 keeps being polled: for a tool
    // that drives destructive workflows, correctness beats latency.
    if (isTerminalAutomationStatus(last.status)) {
      return last;
    }
    await sleep(opts.intervalMs, opts.signal);
  }
  throw new Action1TimeoutError(
    `Polling exceeded ${Math.round(opts.timeoutMs / 1000)}s. Aborted to avoid runaway loop. Use action1_get_automation_status to inspect manually. Last status: ${upstreamBodyText(last)}`,
  );
}

async function fetchFilteredOutput(
  client: Action1Client,
  orgId: string,
  instanceId: string,
  endpointId: string,
  signal?: AbortSignal,
): Promise<string> {
  const data = await client.request<{ items?: unknown }>(
    `/automations/instances/${encodeURIComponent(orgId)}/${encodeURIComponent(instanceId)}/endpoint-results/${encodeURIComponent(endpointId)}/details`,
    signal ? { signal } : {},
  );
  return filterEndpointResultDetails(data?.items ?? data).output;
}
