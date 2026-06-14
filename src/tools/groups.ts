import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Action1Client } from "../client/action1Client.js";
import { resolveOrgId } from "../config.js";
import {
  endpointIdSchema,
  formatShape,
  jsonResult,
  okStatusOutputShape,
  orgIdShape,
  runTool,
} from "./helpers.js";
import { destructiveGuardShape, runDestructive } from "./destructiveGuard.js";
import {
  buildGroupContentsAdd,
  buildGroupContentsRemove,
} from "../payloads/groupContents.js";

const DESTRUCTIVE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

// Group IDs are not plain UUIDs (e.g. "New_Endpoints_<uuid>",
// "Patch_Ring0_Pilot_macOS_<digits>"); enforce a sane charset so a path
// traversal can't slip through, but don't require UUID format.
const groupIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9._-]+$/, "group_id must be an Action1 endpoint-group id.")
  .describe("Endpoint group id.");

export function registerGroupTools(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_add_endpoint_to_group",
    {
      title: "Add an endpoint to an endpoint group",
      description:
        "Add a single endpoint to an endpoint group. POSTs the spec array body [{method:POST,data:{endpoint_id,type}}] to /endpoints/groups/{org}/{group}/contents. Re-adding an existing member is a no-op.",
      inputSchema: {
        ...orgIdShape,
        ...destructiveGuardShape,
        ...formatShape,
        group_id: groupIdSchema,
        endpoint_id: endpointIdSchema,
      },
      outputSchema: okStatusOutputShape,
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async (args) =>
      runTool(async () => {
        const orgId = resolveOrgId(args.org_id);
        const payload = buildGroupContentsAdd(args.endpoint_id);
        const path = `/endpoints/groups/${encodeURIComponent(orgId)}/${encodeURIComponent(args.group_id)}/contents`;
        return runDestructive(
          args,
          {
            toolName: "action1_add_endpoint_to_group",
            preview: { method: "POST", path, body: payload },
          },
          async () => {
            const response = await client.request<unknown>(path, {
              method: "POST",
              body: payload,
              retry: false,
            });
            const result = {
              ok: true,
              group_id: args.group_id,
              endpoint_id: args.endpoint_id,
              raw: response,
            };
            return jsonResult(result, result, args.response_format);
          },
        );
      }),
  );

  server.registerTool(
    "action1_remove_endpoint_from_group",
    {
      title: "Remove an endpoint from an endpoint group",
      description:
        "Remove a single endpoint from an endpoint group. POSTs the spec array body [{method:DELETE,endpoint_id}] to /endpoints/groups/{org}/{group}/contents (there is no DELETE verb or /contents/{id} sub-path).",
      inputSchema: {
        ...orgIdShape,
        ...destructiveGuardShape,
        ...formatShape,
        group_id: groupIdSchema,
        endpoint_id: endpointIdSchema,
      },
      outputSchema: okStatusOutputShape,
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async (args) =>
      runTool(async () => {
        const orgId = resolveOrgId(args.org_id);
        const payload = buildGroupContentsRemove(args.endpoint_id);
        const path = `/endpoints/groups/${encodeURIComponent(orgId)}/${encodeURIComponent(args.group_id)}/contents`;
        return runDestructive(
          args,
          {
            toolName: "action1_remove_endpoint_from_group",
            preview: { method: "POST", path, body: payload },
          },
          async () => {
            const response = await client.request<unknown>(path, {
              method: "POST",
              body: payload,
              retry: false,
            });
            const result = {
              ok: true,
              group_id: args.group_id,
              endpoint_id: args.endpoint_id,
              raw: response,
            };
            return jsonResult(result, result, args.response_format);
          },
        );
      }),
  );
}
