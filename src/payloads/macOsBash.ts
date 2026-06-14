import { defaultName, type TargetType } from "./shared.js";

export type { TargetType };

export interface MacOsBashInput {
  endpointId: string;
  targetType?: TargetType;
  scriptText: string;
  name?: string;
  retryMinutes?: string;
}

export interface AutomationInstancePayload {
  name: string;
  retry_minutes: string;
  endpoints: { id: string; type: TargetType }[];
  actions: {
    name: string;
    template_id: string;
    params: Record<string, unknown>;
  }[];
}

// macOS schema reverse-engineered from web-console traffic: any field omitted here
// makes the API silently mark the action as "not applicable to Mac platform".
// Endpoint must be /automations/instances/{org}, NOT /policies/instances/{org}.
export function buildMacOsBashPayload(input: MacOsBashInput): AutomationInstancePayload {
  if (!input.endpointId) throw new Error("endpointId is required");
  if (!input.scriptText) throw new Error("scriptText is required");
  return {
    name: input.name ?? defaultName("Bash"),
    retry_minutes: input.retryMinutes ?? "1440",
    endpoints: [{ id: input.endpointId, type: input.targetType ?? "Endpoint" }],
    actions: [
      {
        name: "Run Script",
        template_id: "run_script",
        params: {
          run_script_text: input.scriptText,
          run_script_language: "Bash",
          platform: "Mac",
          display_summary: "",
          condition_script_text: "",
          condition_script_file_name: "",
          condition_script_language: "Bash",
          run_script_params: [],
          run_script_file_name: "",
          reboot_exit_codes: "",
          reboot_options: { auto_reboot: "no" },
        },
      },
    ],
  };
}

