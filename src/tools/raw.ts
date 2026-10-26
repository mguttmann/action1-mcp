import type { McpServer, CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { assertSafeApiPath, type Action1Client } from "../client/action1Client.js";
import { formatShape, jsonResult, runTool, singleObjectOutputShape } from "./helpers.js";
import { destructiveGuardShape, runDestructive } from "./destructiveGuard.js";
import { GENERATED_SKIPPED_OPERATIONS, GENERATED_TOOL_MANIFEST } from "./generated/index.js";
import { assertPathOrgAllowed, assertPayloadOrgsAllowed } from "./orgScope.js";

/** Documented API path templates, for the org check on free-form paths. */
const API_PATH_TEMPLATES = [...GENERATED_TOOL_MANIFEST, ...GENERATED_SKIPPED_OPERATIONS];

/**
 * Query parameters written into the path itself (`/x?org_id=...`). The
 * client sends them unchanged, so the org check has to see them too.
 */
function inlineQuery(path: string): Record<string, string[]> {
  const beforeFragment = path.split("#", 1)[0] ?? "";
  const at = beforeFragment.indexOf("?");
  const out: Record<string, string[]> = {};
  if (at < 0) return out;
  for (const [k, v] of new URLSearchParams(beforeFragment.slice(at + 1))) {
    (out[k] ??= []).push(v);
  }
  return out;
}

export function registerRawTool(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_raw_request",
    {
      title: "Raw Action1 API request (escape hatch)",
      description:
        "Generic passthrough to any Action1 API path. Bypasses per-tool schemas; use only when no dedicated tool exists. GET/HEAD run free; POST/PUT/PATCH/DELETE require the destructive guard (ACTION1_ALLOW_DESTRUCTIVE + confirm:YES + dry_run-default-true) and, as account operations, ACTION1_ALLOW_ACCOUNT_OPS.",
      inputSchema: z.object({
        ...destructiveGuardShape,
        ...formatShape,
        method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).describe("HTTP method."),
        path: z
          .string()
          .regex(/^\//, "path must start with / (e.g. /endpoints/managed/{orgId}).")
          .describe("API path beginning with /."),
        query: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Optional query params."),
        body: z.unknown().optional().describe("Request body for non-GET verbs."),
      }),
      outputSchema: singleObjectOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, ctx) =>
      runTool(async (): Promise<CallToolResult> => {
        // Dot segments, empty segments and paths outside the API base
        // are refused before the guard, so a dry-run preview never shows
        // a path that the client would refuse or retarget.
        assertSafeApiPath(args.path);
        // ACTION1_ALLOWED_ORG_IDS also covers org ids in the free-form
        // path, the query and the body.
        assertPathOrgAllowed(args.path, API_PATH_TEMPLATES);
        assertPayloadOrgsAllowed(args.query);
        assertPayloadOrgsAllowed(inlineQuery(args.path));
        assertPayloadOrgsAllowed(args.body);
        const perform = async (): Promise<CallToolResult> => {
          const data = await client.request<unknown>(args.path, {
            method: args.method,
            ...(args.query ? { query: args.query } : {}),
            ...(args.body !== undefined ? { body: args.body } : {}),
            signal: ctx.mcpReq.signal,
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
