/**
 * Shared start path for the curated execution tools (execution.ts) and
 * action1_execute_and_wait (workflows.ts).
 *
 * One place for: the input fragments the tools share (target type,
 * minutes, success exit codes), the OS switch that picks the script
 * payload and endpoint, the platform resolution for script tools
 * (explicit `os` for groups, detection plus connectivity check for a
 * single endpoint), and the guard -> POST -> instance-id sequence.
 */
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Action1Client } from "../client/action1Client.js";
import { fetchEndpointInfo } from "../client/endpointInfo.js";
import type { AppConfig } from "../config.js";
import { buildMacOsBashPayload } from "../payloads/macOsBash.js";
import type { TargetType } from "../payloads/shared.js";
import { buildWindowsPowerShellPayload } from "../payloads/windowsPowerShell.js";
import { isEndpointActuallyOnline } from "../utils/lastSeen.js";
import { detectPlatform } from "../utils/osDetect.js";
import { runDestructive, type DestructiveGuardInput } from "./destructiveGuard.js";
import { errorResult, jsonResult, upstreamBodyText } from "./helpers.js";

// ----- Shared input fragments ------------------------------------------

export const targetTypeShape = {
  target_type: z
    .enum(["Endpoint", "EndpointGroup"])
    .optional()
    .describe("Endpoint (default) or EndpointGroup for fan-out."),
};

const MAX_MINUTES = 10080;

// `timeout_minutes` and `retry_minutes` accept a non-negative integer or
// a digit-only string with the same upper bound; both reach the payload
// as the digit string Action1 expects.
export const minutesShape = z.union([
  z.number().int().min(0).max(MAX_MINUTES),
  z
    .string()
    .regex(/^\d+$/)
    .refine((v) => Number.parseInt(v, 10) <= MAX_MINUTES, {
      message: `Must be at most ${MAX_MINUTES} minutes.`,
    }),
]);

export const successExitCodesSchema = z
  .string()
  .regex(
    /^\d+(,\d+)*$/,
    "Must be a comma-separated list of digits with no spaces, e.g. '0' or '0,1,3010'.",
  );

export type ScriptPlatform = "windows" | "macos";

export const scriptOsSchema = z.enum(["windows", "macos"]);

// ----- Paths ----------------------------------------------------------

export function policyInstancesPath(orgId: string): string {
  return `/policies/instances/${encodeURIComponent(orgId)}`;
}

export function automationInstancesPath(orgId: string): string {
  return `/automations/instances/${encodeURIComponent(orgId)}`;
}

// ----- Script payload routing -----------------------------------------

export interface ScriptRequestInput {
  orgId: string;
  endpointId: string;
  targetType?: TargetType | undefined;
  scriptText: string;
  name?: string | undefined;
  successExitCodes?: string | undefined;
  timeoutMinutes?: number | string | undefined;
  retryMinutes?: number | string | undefined;
}

export interface StartRequest {
  path: string;
  payload: unknown;
}

/**
 * The one OS switch: PowerShell policy for Windows, Bash automation for
 * macOS. Unset minutes fall back to the configured defaults.
 */
export function buildScriptRequest(
  platform: ScriptPlatform,
  input: ScriptRequestInput,
  cfg: Pick<AppConfig, "defaultTimeoutMinutes" | "defaultRetryMinutes">,
): StartRequest {
  const common = {
    endpointId: input.endpointId,
    ...(input.targetType !== undefined ? { targetType: input.targetType } : {}),
    scriptText: input.scriptText,
    ...(input.name !== undefined ? { name: input.name } : {}),
  };
  const retry = input.retryMinutes ?? cfg.defaultRetryMinutes;
  if (platform === "windows") {
    return {
      path: policyInstancesPath(input.orgId),
      payload: buildWindowsPowerShellPayload({
        ...common,
        successExitCodes: input.successExitCodes ?? "0",
        timeoutMinutes: String(input.timeoutMinutes ?? cfg.defaultTimeoutMinutes),
        retryMinutes: typeof retry === "number" ? retry : Number.parseInt(retry, 10),
      }),
    };
  }
  return {
    path: automationInstancesPath(input.orgId),
    payload: buildMacOsBashPayload({ ...common, retryMinutes: String(retry) }),
  };
}

// ----- Endpoint probe and platform resolution --------------------------

export interface ProbeEndpointInput {
  orgId: string;
  endpointId: string;
  skipConnectivityCheck?: boolean | undefined;
  lastSeenStaleMinutes: number;
  /** Sentence after the offline reason; defaults to the generic skip hint. */
  offlineHint?: string;
  /** Cancellation signal of the MCP request, passed to the endpoint GET. */
  signal?: AbortSignal | undefined;
}

export type Outcome<T> = ({ ok: true } & T) | { ok: false; error: CallToolResult };

/**
 * One read-only GET of a single endpoint, plus the offline-abort check
 * unless skipped. Script tools call this before the guard because the
 * preview body depends on the detected OS, so a dry_run makes this GET.
 */
export async function probeEndpoint(
  client: Action1Client,
  input: ProbeEndpointInput,
): Promise<Outcome<{ data: unknown }>> {
  const info = await fetchEndpointInfo(client, input.orgId, input.endpointId, input.signal);
  if (!input.skipConnectivityCheck) {
    const conn = isEndpointActuallyOnline(info.data, input.lastSeenStaleMinutes);
    if (!conn.online) {
      return {
        ok: false,
        error: errorResult(
          `Aborting: endpoint not reachable. ${conn.reason} ${
            input.offlineHint ?? "Pass skip_connectivity_check=true to send anyway."
          }`,
        ),
      };
    }
  }
  return { ok: true, data: info.data };
}

export interface ResolvePlatformInput extends ProbeEndpointInput {
  targetType?: TargetType | undefined;
  os?: ScriptPlatform | undefined;
  /** Appended to the error for Linux / unknown endpoints. */
  unsupportedHint: string;
}

/**
 * Decide which script flavour to send.
 *
 * - EndpointGroup: a group has no single OS and no single endpoint to
 *   probe, so the caller must name `os`; no upstream call is made.
 * - Endpoint: probeEndpoint detects the OS and checks connectivity. An
 *   explicit `os` must match the detected one.
 */
export async function resolveScriptPlatform(
  client: Action1Client,
  input: ResolvePlatformInput,
): Promise<Outcome<{ platform: ScriptPlatform }>> {
  if (input.targetType === "EndpointGroup") {
    if (input.os === undefined) {
      return {
        ok: false,
        error: errorResult(
          'target_type="EndpointGroup" requires os="windows" (PowerShell) or os="macos" (Bash): a group has no single OS to detect. Run once per platform for mixed groups.',
        ),
      };
    }
    return { ok: true, platform: input.os };
  }
  const probe = await probeEndpoint(client, input);
  if (!probe.ok) return probe;
  const detected = detectPlatform(probe.data);
  if (detected !== "windows" && detected !== "macos") {
    return {
      ok: false,
      error: errorResult(`Cannot auto-run on platform "${detected}". ${input.unsupportedHint}`),
    };
  }
  if (input.os !== undefined && input.os !== detected) {
    return {
      ok: false,
      error: errorResult(
        `os="${input.os}" does not match the endpoint's detected platform "${detected}". Omit os or pass the matching value.`,
      ),
    };
  }
  return { ok: true, platform: detected };
}

// ----- Guard -> POST -> instance id ------------------------------------

export interface StartActionSpec extends StartRequest {
  toolName: string;
  /** Extra fields merged into the success result (e.g. platform). */
  extra?: Record<string, unknown>;
  /**
   * Runs after the guard and before the POST, so a dry_run preview
   * never reaches it. Return a result to abort.
   */
  beforePost?: () => Promise<CallToolResult | null>;
}

/**
 * Guard, then POST the action with `retry: false` (a retry after a lost
 * response could start the action twice), then return the instance id.
 */
export async function startAction(
  client: Action1Client,
  args: DestructiveGuardInput & { response_format?: "json" | "markdown" | undefined },
  spec: StartActionSpec,
): Promise<CallToolResult> {
  return runDestructive(
    args,
    { toolName: spec.toolName, preview: { method: "POST", path: spec.path, body: spec.payload } },
    async () => {
      if (spec.beforePost) {
        const abort = await spec.beforePost();
        if (abort) return abort;
      }
      const response = await client.request<unknown>(spec.path, {
        method: "POST",
        body: spec.payload,
        retry: false,
      });
      return startedJobResult(response, args.response_format, spec.extra);
    },
  );
}

/**
 * Wrap a started-action upstream response into a CallToolResult.
 *
 * When the upstream returns a parseable string `id` / `instance_id`,
 * emit a success-shape with that id. When it doesn't, emit an
 * `errorResult` instead of a success-shape with `instance_id: undefined`;
 * downstream tools like `action1_wait_for_automation` validate
 * `instance_id` and crash on undefined.
 */
export function startedJobResult(
  response: unknown,
  format: "json" | "markdown" | undefined,
  extra: Record<string, unknown> = {},
): CallToolResult {
  const instanceId = extractInstanceId(response);
  if (instanceId === undefined) {
    return errorResult(
      `no_instance_id: Upstream did not return a parseable instance id. raw_body=${upstreamBodyText(
        response,
      )}`,
    );
  }
  const payload = { instance_id: instanceId, raw: response, ...extra };
  return jsonResult(payload, payload, format);
}

export function extractInstanceId(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const obj = response as Record<string, unknown>;
  if (typeof obj.id === "string") return obj.id;
  if (typeof obj.instance_id === "string") return obj.instance_id;
  return undefined;
}
