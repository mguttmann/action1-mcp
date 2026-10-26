import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Action1Client } from "../client/action1Client.js";
import {
  cappedListResult,
  formatShape,
  jsonResult,
  listOutputShape,
  runTool,
  singleObjectOutputShape,
  toRecord,
} from "./helpers.js";
import { collect } from "../client/pagination.js";

export function registerTemplateTools(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_list_action_templates",
    {
      title: "List action templates",
      description:
        "List every action template (id, name, description). Use ids with action1_get_action_template.",
      inputSchema: z.object({
        ...formatShape,
        applicable_to: z
          .string()
          .optional()
          .describe("Filter to templates applicable to a context URL."),
      }),
      outputSchema: listOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ response_format, applicable_to }) =>
      runTool(async () => {
        const baseQuery: Record<string, string | number | boolean | undefined> = {};
        if (applicable_to !== undefined) baseQuery.applicable_to = applicable_to;
        const items = await collect(
          client.paginate<unknown>("/automations/action-templates", {
            limit: 100,
            query: baseQuery,
          }),
        );
        return cappedListResult(items, response_format);
      }),
  );

  server.registerTool(
    "action1_get_action_template",
    {
      title: "Get action template details",
      description:
        "Fetch full details (parameters, supported platforms) for a single action template by id.",
      inputSchema: z.object({
        ...formatShape,
        template_id: z.string().min(1).describe("Action template id."),
      }),
      outputSchema: singleObjectOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ template_id, response_format }) =>
      runTool(async () => {
        const data = await client.request<unknown>(
          `/automations/action-templates/${encodeURIComponent(template_id)}`,
        );
        return jsonResult(data, { template: toRecord(data) }, response_format);
      }),
  );
}
