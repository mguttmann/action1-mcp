import { defaultName, humanize, type TargetType } from "./shared.js";

export type { TargetType };

export interface WindowsPowerShellInput {
  endpointId: string;
  targetType?: TargetType;
  scriptText: string;
  name?: string;
  successExitCodes?: string;
  timeoutMinutes?: string;
  retryMinutes?: number;
}

export interface PolicyInstancePayload {
  name: string;
  retry_minutes: number;
  endpoints: { id: string; type: TargetType }[];
  actions: {
    name: string;
    template_id: string;
    params: Record<string, unknown>;
  }[];
}

// success_exit_codes is mandatory: Action1 rejects the request with
// "at least one valid success exit code must be specified" when omitted.
export function buildWindowsPowerShellPayload(input: WindowsPowerShellInput): PolicyInstancePayload {
  if (!input.endpointId) throw new Error("endpointId is required");
  if (!input.scriptText) throw new Error("scriptText is required");
  return {
    name: input.name ?? defaultName("PowerShell"),
    retry_minutes: input.retryMinutes ?? 1440,
    endpoints: [{ id: input.endpointId, type: input.targetType ?? "Endpoint" }],
    actions: [
      {
        name: "Run PowerShell",
        template_id: "run_powershell",
        params: {
          script_text: input.scriptText,
          success_exit_codes: input.successExitCodes ?? "0",
          timeout_minutes: input.timeoutMinutes ?? "10",
        },
      },
    ],
  };
}

export interface SimpleTemplatePayloadInput {
  endpointId: string;
  targetType?: TargetType;
  templateId: string;
  actionName?: string;
  params?: Record<string, unknown>;
  name?: string;
  retryMinutes?: number;
}

export function buildSimplePolicyPayload(input: SimpleTemplatePayloadInput): PolicyInstancePayload {
  if (!input.endpointId) throw new Error("endpointId is required");
  if (!input.templateId) throw new Error("templateId is required");
  return {
    name: input.name ?? defaultName(input.templateId),
    retry_minutes: input.retryMinutes ?? 1440,
    endpoints: [{ id: input.endpointId, type: input.targetType ?? "Endpoint" }],
    actions: [
      {
        name: input.actionName ?? humanize(input.templateId),
        template_id: input.templateId,
        params: input.params ?? {},
      },
    ],
  };
}

