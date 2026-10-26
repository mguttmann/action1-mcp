import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Action1Client } from "../client/action1Client.js";
import { resolveOrgId } from "../config.js";
import {
  endpointIdSchema,
  formatShape,
  jsonResult,
  orgIdShape,
  runTool,
  objectOutputShape,
  toRecord,
} from "./helpers.js";
import { filterEndpointResultDetails } from "../utils/filterOutput.js";

export function registerResultTools(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_get_automation_status",
    {
      title: "Get automation instance status",
      description:
        "Returns the high-level status of one automation instance. For stdout use action1_get_automation_output.",
      inputSchema: z.object({
        ...orgIdShape,
        ...formatShape,
        instance_id: z.string().min(1).describe("Instance UUID."),
      }),
      outputSchema: objectOutputShape({ instance: "object" }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ org_id, instance_id, response_format }) =>
      runTool(async () => {
        const orgId = resolveOrgId(org_id);
        const data = await client.request<unknown>(
          `/automations/instances/${encodeURIComponent(orgId)}/${encodeURIComponent(instance_id)}`,
        );
        return jsonResult(data, { instance: toRecord(data) }, response_format);
      }),
  );

  server.registerTool(
    "action1_get_automation_results",
    {
      title: "Get automation endpoint-results overview",
      description:
        "Per-endpoint result rollup for an instance. Use action1_get_automation_output for stdout.",
      inputSchema: z.object({
        ...orgIdShape,
        ...formatShape,
        instance_id: z.string().min(1).describe("Instance UUID."),
      }),
      outputSchema: objectOutputShape({ results: "object" }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ org_id, instance_id, response_format }) =>
      runTool(async () => {
        const orgId = resolveOrgId(org_id);
        const data = await client.request<unknown>(
          `/automations/instances/${encodeURIComponent(orgId)}/${encodeURIComponent(instance_id)}/endpoint-results`,
        );
        return jsonResult(data, { results: toRecord(data) }, response_format);
      }),
  );

  server.registerTool(
    "action1_get_automation_output",
    {
      title: "Get automation script output (filtered)",
      description:
        "Returns filtered stdout for one endpoint of an automation instance. Strips Action1 status markers.",
      inputSchema: z.object({
        ...orgIdShape,
        ...formatShape,
        instance_id: z.string().min(1).describe("Instance UUID."),
        endpoint_id: endpointIdSchema,
        include_raw: z.boolean().optional().describe("If true, also include raw description list."),
      }),
      outputSchema: objectOutputShape({
        output: "string",
        raw: "array",
        skipped_status_lines: "number",
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ org_id, instance_id, endpoint_id, include_raw, response_format }) =>
      runTool(async () => {
        const orgId = resolveOrgId(org_id);
        const data = await client.request<{ items?: unknown }>(
          `/automations/instances/${encodeURIComponent(orgId)}/${encodeURIComponent(instance_id)}/endpoint-results/${encodeURIComponent(endpoint_id)}/details`,
        );
        const filtered = filterEndpointResultDetails(data?.items ?? data);
        const payload: Record<string, unknown> = include_raw
          ? {
              output: filtered.output,
              raw: filtered.rawDescriptions,
              skipped_status_lines: filtered.skippedStatusLines,
            }
          : { output: filtered.output, skipped_status_lines: filtered.skippedStatusLines };
        return jsonResult(payload, payload, response_format);
      }),
  );
}
