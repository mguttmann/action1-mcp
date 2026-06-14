import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Action1Client } from "../client/action1Client.js";
import { collect } from "../client/pagination.js";
import { Action1ApiError } from "../client/errors.js";
import { resolveOrgId } from "../config.js";
import { capItemList } from "../utils/capOutput.js";

const JSON_MIME = "application/json";

interface CapNote {
  truncated: number;
  note: string;
}

function buildResourcePayload(items: unknown[], extra: Record<string, unknown> = {}): string {
  const cap = capItemList(items as Record<string, unknown>[]);
  const payload: Record<string, unknown> = {
    ...extra,
    items: cap.items,
    count: cap.returned,
    total: cap.total,
  };
  if (cap.truncated > 0) {
    const note: CapNote = {
      truncated: cap.truncated,
      note:
        "Resource truncated to fit the 1 MB host limit. For full data, use the equivalent paginated tool (e.g. action1_list_endpoints) which streams across multiple calls.",
    };
    payload.truncated = note.truncated;
    payload.note = note.note;
  }
  return JSON.stringify(payload, null, 2);
}

/**
 * Wrap a resource handler so that downstream API failures land as a
 * structured JSON `{ error, status?, hint? }` payload instead of as a
 * raw JSON-RPC -32603 (which some MCP clients render as a hard crash).
 *
 * The wrapper always returns content[] so the resource read remains
 * "successful" at the MCP protocol level — but the JSON body carries
 * the error details. This matches the UX of tool isError responses.
 */
export async function safeResourceRead(
  uri: string,
  fn: () => Promise<string>,
): Promise<{ contents: { uri: string; mimeType: string; text: string }[] }> {
  try {
    const text = await fn();
    return { contents: [{ uri, mimeType: JSON_MIME, text }] };
  } catch (err) {
    const errorPayload: Record<string, unknown> = { error: "resource_read_failed" };
    if (err instanceof Action1ApiError) {
      errorPayload.message = err.message;
      errorPayload.status = err.status;
      if (err.hint) errorPayload.hint = err.hint;
    } else if (err instanceof Error) {
      errorPayload.message = err.message;
    } else {
      errorPayload.message = String(err);
    }
    return {
      contents: [
        {
          uri,
          mimeType: JSON_MIME,
          text: JSON.stringify(errorPayload, null, 2),
        },
      ],
    };
  }
}

export function registerResources(server: McpServer, client: Action1Client): void {
  // Pre-flight identity / scope check. Lets a host (and the agent) see what
  // role and permissions the configured API key carries before any tool call.
  server.registerResource(
    "me",
    "action1://me",
    {
      title: "Current API identity",
      description:
        "The authenticated API user (GET /me). Useful as a startup probe — agents can read this to know which permissions / role they have before calling potentially-403 tools.",
      mimeType: JSON_MIME,
    },
    async (uri) =>
      safeResourceRead(uri.href, async () => {
        const data = await client.request<unknown>("/me");
        return JSON.stringify(data, null, 2);
      }),
  );

  server.registerResource(
    "organizations",
    "action1://orgs",
    {
      title: "Visible organizations",
      description:
        "All organizations the configured API key can access (GET /organizations).",
      mimeType: JSON_MIME,
    },
    async (uri) =>
      safeResourceRead(uri.href, async () => {
        const items = await collect(client.paginate<unknown>("/organizations", { limit: 100 }));
        return buildResourcePayload(items);
      }),
  );

  server.registerResource(
    "templates",
    "action1://templates",
    {
      title: "Action templates catalog",
      description:
        "All action templates (run_powershell, run_script, deploy_update, …) with their parameter shapes (GET /automations/action-templates).",
      mimeType: JSON_MIME,
    },
    async (uri) =>
      safeResourceRead(uri.href, async () => {
        const items = await collect(
          client.paginate<unknown>("/automations/action-templates", { limit: 100 }),
        );
        return buildResourcePayload(items);
      }),
  );

  server.registerResource(
    "endpoints",
    new ResourceTemplate("action1://endpoints/{orgId}", { list: undefined }),
    {
      title: "Managed endpoints for an organization",
      description:
        "Live snapshot of every managed endpoint for the given org (GET /endpoints/managed/{orgId}). Pass 'default' as orgId to use ACTION1_ORG_ID. Output is capped at ~400 KB; use action1_list_endpoints for unbounded paging.",
      mimeType: JSON_MIME,
    },
    async (uri, { orgId }) =>
      safeResourceRead(uri.href, async () => {
        const id = resolveOrgIdParam(orgId);
        const items = await collect(
          client.paginate<unknown>(`/endpoints/managed/${encodeURIComponent(id)}`, { limit: 200 }),
        );
        return buildResourcePayload(items, { org_id: id });
      }),
  );

  server.registerResource(
    "vulnerabilities",
    new ResourceTemplate("action1://vulnerabilities/{orgId}", { list: undefined }),
    {
      title: "Org-wide CVE rollup",
      description:
        "Vulnerabilities visible to the API key (GET /vulnerabilities/{orgId}). May 403 if the role lacks view_vulnerabilities. Pass 'default' as orgId to use ACTION1_ORG_ID. Output is capped at ~400 KB; for full data use action1_list_vulnerabilities per endpoint.",
      mimeType: JSON_MIME,
    },
    async (uri, { orgId }) =>
      safeResourceRead(uri.href, async () => {
        const id = resolveOrgIdParam(orgId);
        const items = await collect(
          client.paginate<unknown>(`/vulnerabilities/${encodeURIComponent(id)}`, { limit: 200 }),
        );
        return buildResourcePayload(items, { org_id: id });
      }),
  );

  server.registerResource(
    "groups",
    new ResourceTemplate("action1://groups/{orgId}", { list: undefined }),
    {
      title: "Endpoint groups for an organization",
      description:
        "All endpoint groups for the given org (GET /endpoints/groups/{orgId}). Pass 'default' as orgId to use ACTION1_ORG_ID. Use action1_endpoint_groups_resolve to look up by name.",
      mimeType: JSON_MIME,
    },
    async (uri, { orgId }) =>
      safeResourceRead(uri.href, async () => {
        const id = resolveOrgIdParam(orgId);
        const items = await collect(
          client.paginate<unknown>(`/endpoints/groups/${encodeURIComponent(id)}`, { limit: 200 }),
        );
        return buildResourcePayload(items, { org_id: id });
      }),
  );

  server.registerResource(
    "reports",
    "action1://reports",
    {
      title: "Report catalog",
      description:
        "All reports the API key can see (GET /reports/all). Use action1_report_export to fetch one by id or name fragment.",
      mimeType: JSON_MIME,
    },
    async (uri) =>
      safeResourceRead(uri.href, async () => {
        const items = await collect(client.paginate<unknown>("/reports/all", { limit: 100 }));
        return buildResourcePayload(items);
      }),
  );
}

function resolveOrgIdParam(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || value === "default") return resolveOrgId(undefined);
  return value;
}
