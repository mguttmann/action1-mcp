import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Action1Client } from "../client/action1Client.js";
import {
  formatShape,
  jsonResult,
  runTool,
  singleObjectOutputShape,
} from "./helpers.js";
import { destructiveGuardShape, runDestructive } from "./destructiveGuard.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function registerRawTool(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_raw_request",
    {
      title: "Raw Action1 API request (escape hatch)",
      description:
        "Generic passthrough to any Action1 API path. Bypasses per-tool schemas — use only when no dedicated tool exists. GET/HEAD run free; POST/PUT/PATCH/DELETE require the destructive guard (ACTION1_ALLOW_DESTRUCTIVE + confirm:YES + dry_run-default-true).",
      inputSchema: {
        ...destructiveGuardShape,
        ...formatShape,
        method: z
          .enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])
          .describe("HTTP method."),
        path: z
          .string()
          .regex(/^\//, "path must start with / (e.g. /endpoints/managed/{orgId}).")
          .describe("API path beginning with /."),
        query: z
          .record(z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Optional query params."),
        body: z.unknown().optional().describe("Request body for non-GET verbs."),
      },
      outputSchema: singleObjectOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) =>
      runTool(async (): Promise<CallToolResult> => {
        const perform = async (): Promise<CallToolResult> => {
          const data = await client.request<unknown>(args.path, {
            method: args.method,
            ...(args.query ? { query: args.query } : {}),
            ...(args.body !== undefined ? { body: args.body } : {}),
          });
          const structured =
            data && typeof data === "object" && !Array.isArray(data)
              ? (data as Record<string, unknown>)
              : { value: data };
          return jsonResult(data, structured, args.response_format);
        };
        if (args.method === "GET" || args.method === "HEAD") {
          return perform();
        }
        return runDestructive(
          args,
          {
            toolName: "action1_raw_request",
            preview: {
              method: args.method,
              path: args.path,
              ...(args.body !== undefined ? { body: args.body } : {}),
            },
          },
          perform,
        );
      }),
  );
}
