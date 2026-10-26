import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Action1Client } from "../client/action1Client.js";
import { cappedListResult, formatShape, listOutputShape, runTool } from "./helpers.js";
import { collect } from "../client/pagination.js";

export function registerOrgTools(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_list_organizations",
    {
      title: "List organizations",
      description: "List every organization the configured API key can access.",
      inputSchema: z.object({
        ...formatShape,
        limit: z.number().int().min(1).max(500).optional().describe("Max items to return."),
        admin: z
          .boolean()
          .optional()
          .describe("If true, restrict to orgs the API key has admin rights on."),
      }),
      outputSchema: listOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ limit, response_format, admin }) =>
      runTool(async () => {
        const baseQuery: Record<string, string | number | boolean | undefined> = {};
        if (admin !== undefined) baseQuery.admin = admin;
        const items = await collect(
          client.paginate<unknown>("/organizations", {
            limit: 100,
            query: baseQuery,
            ...(limit !== undefined ? { maxItems: limit } : {}),
          }),
        );
        return cappedListResult(items, response_format);
      }),
  );
}
