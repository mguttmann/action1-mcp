import type { McpServer } from "@modelcontextprotocol/server";
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
  objectOutputShape,
} from "./helpers.js";
import { fingerprintQuery, pagedFetch } from "../utils/cursor.js";
import { collect, listPageFetcher } from "../client/pagination.js";
import { automationOutcome, automationStatus } from "../spec/entities.js";

const DEFAULT_MAX_SCAN = 1000;

export function registerAutomationTools(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_list_recent_automations",
    {
      title: "List recent automation instances",
      description:
        "List recent automation instances for the org. For counts use action1_automations_summary instead.",
      inputSchema: z.object({
        ...orgIdShape,
        ...cursorInputShape,
        ...formatShape,
      }),
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
          listPageFetcher(client, `/automations/instances/${encodeURIComponent(orgId)}`),
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
      description:
        "Walks up to max_scan (default 1000) automation instances and returns counts (by_status, success/warning/failure); has_more: true means instances beyond max_scan were not counted. Instance lists carry no actions, so there is no per-template count. ~1 KB output.",
      inputSchema: z.object({
        ...orgIdShape,
        ...formatShape,
        max_scan: z.number().int().min(1).max(10000).optional().describe("Max instances to walk."),
      }),
      outputSchema: objectOutputShape({
        total_scanned: "number",
        by_status: "object",
        success_count: "number",
        warning_count: "number",
        failure_count: "number",
        has_more: "boolean",
        note: "string",
      }),
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
        const scanCap = max_scan ?? DEFAULT_MAX_SCAN;
        // One more than the cap tells whether instances were left out.
        const all = await collect(
          client.paginate<unknown>(`/automations/instances/${encodeURIComponent(orgId)}`, {
            limit: 200,
            maxItems: scanCap + 1,
          }),
        );
        const hasMore = all.length > scanCap;
        if (hasMore) all.length = scanCap;
        const stats: {
          total_scanned: number;
          by_status: Record<string, number>;
          success_count: number;
          warning_count: number;
          failure_count: number;
          has_more: boolean;
          note?: string;
        } = {
          total_scanned: all.length,
          by_status: {},
          success_count: 0,
          warning_count: 0,
          failure_count: 0,
          has_more: hasMore,
        };
        if (hasMore) {
          stats.note = `Counted the first ${scanCap} instances only; more exist. Raise max_scan (up to 10000) for a complete count.`;
        }
        for (const inst of all) {
          if (!inst || typeof inst !== "object") continue;
          const status = automationStatus(inst) ?? "Unknown";
          stats.by_status[status] = (stats.by_status[status] ?? 0) + 1;
          const outcome = automationOutcome(status);
          if (outcome === "success") stats.success_count += 1;
          else if (outcome === "warning") stats.warning_count += 1;
          else if (outcome === "failure") stats.failure_count += 1;
        }
        return jsonResult(stats, stats, response_format);
      }),
  );
}
