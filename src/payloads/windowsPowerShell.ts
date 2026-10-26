import { defaultName, type TargetType } from "./shared.js";
import { buildSimplePolicyPayload, type PolicyInstancePayload } from "./policyInstance.js";

export type { TargetType, PolicyInstancePayload };

export interface WindowsPowerShellInput {
  endpointId: string;
  targetType?: TargetType;
  scriptText: string;
  name?: string;
  successExitCodes?: string;
  timeoutMinutes?: string;
  retryMinutes?: number;
}

// success_exit_codes is mandatory: Action1 rejects the request with
// "at least one valid success exit code must be specified" when omitted.
export function buildWindowsPowerShellPayload(
  input: WindowsPowerShellInput,
): PolicyInstancePayload {
  if (!input.endpointId) throw new Error("endpointId is required");
  if (!input.scriptText) throw new Error("scriptText is required");
  return buildSimplePolicyPayload({
    endpointId: input.endpointId,
    ...(input.targetType !== undefined ? { targetType: input.targetType } : {}),
    templateId: "run_powershell",
    actionName: "Run PowerShell",
    name: input.name ?? defaultName("PowerShell"),
    ...(input.retryMinutes !== undefined ? { retryMinutes: input.retryMinutes } : {}),
    params: {
      script_text: input.scriptText,
      success_exit_codes: input.successExitCodes ?? "0",
      timeout_minutes: input.timeoutMinutes ?? "10",
    },
  });
}
