import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Action1Client } from "../client/action1Client.js";
import { resolveOrgId } from "../config.js";
import {
  cursorInputShape,
  cursorListOutputShape,
  formatShape,
  jsonResult,
  orgIdShape,
  pagedListResult,
  runTool,
  singleObjectOutputShape,
} from "./helpers.js";
import { fingerprintQuery, pagedFetch } from "../utils/cursor.js";
import { collect } from "../client/pagination.js";

export function registerAutomationTools(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_list_recent_automations",
    {
      title: "List recent automation instances",
      description: "List recent automation instances for the org. For counts use action1_automations_summary instead.",
      inputSchema: {
        ...orgIdShape,
        ...cursorInputShape,
        ...formatShape,
      },
      outputSchema: cursorListOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ org_id, cursor, limit, response_format }) =>
      runTool(async () => {
        const orgId = resolveOrgId(org_id);
        const fp = fingerprintQuery({ orgId });
        const result = await pagedFetch<unknown>(
          async ({ from, limit: pageLimit }) => {
            const raw = (await client.request<unknown>(
              `/automations/instances/${encodeURIComponent(orgId)}`,
              { query: { limit: pageLimit, from } },
            )) as { items?: unknown[] } | unknown[];
            const items = Array.isArray(raw) ? raw : (raw.items ?? []);
            return { items, hasMore: items.length === pageLimit };
          },
          {
            ...(cursor !== undefined ? { cursor } : {}),
            fingerprint: fp,
            ...(limit !== undefined ? { maxItems: limit } : {}),
          },
        );
        return pagedListResult(result, response_format);
      }),
  );

  server.registerTool(
    "action1_automations_summary",
    {
      title: "Server-side aggregation over recent automation instances",
      description: "Walks recent automation instances and returns counts (by_status, by_template, success/failure). ~1 KB output.",
      inputSchema: {
        ...orgIdShape,
        ...formatShape,
        max_scan: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .optional()
          .describe("Max instances to walk."),
      },
      outputSchema: singleObjectOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ org_id, max_scan, response_format }) =>
      runTool(async () => {
        const orgId = resolveOrgId(org_id);
        const all = await collect(
          client.paginate<unknown>(`/automations/instances/${encodeURIComponent(orgId)}`, {
            limit: 200,
            maxItems: max_scan ?? 1000,
          }),
        );
        const stats = {
          total_scanned: all.length,
          by_status: {} as Record<string, number>,
          by_template: {} as Record<string, number>,
          success_count: 0,
          failure_count: 0,
        };
        for (const inst of all) {
          if (!inst || typeof inst !== "object") continue;
          const i = inst as Record<string, unknown>;
          const status = typeof i.status === "string" ? i.status : "Unknown";
          stats.by_status[status] = (stats.by_status[status] ?? 0) + 1;
          if (status === "Success") stats.success_count += 1;
          else if (["Failed", "Error", "Stopped", "Canceled"].includes(status)) {
            stats.failure_count += 1;
          }
          const actions = i.actions as Array<Record<string, unknown>> | undefined;
          for (const a of actions ?? []) {
            const t = typeof a.template_id === "string" ? a.template_id : "Unknown";
            stats.by_template[t] = (stats.by_template[t] ?? 0) + 1;
          }
        }
        return jsonResult(stats, stats, response_format);
      }),
  );
}
