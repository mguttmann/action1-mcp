import { defaultName, humanize, type TargetType } from "./shared.js";

export type { TargetType };

/**
 * Body of POST /policies/instances/{orgId}: one target (endpoint or
 * group) and one template action. Platform-neutral; the Windows
 * PowerShell builder and every template-based execution tool (reboot,
 * deploy_update, deploy_package, uninstall_program, run_data_collection,
 * execute_and_wait in template mode) build on it.
 */
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
