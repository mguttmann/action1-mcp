import {
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
} from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Action1Client } from "../client/action1Client.js";
import { collect } from "../client/pagination.js";
import { Action1ApiError } from "../client/errors.js";
import { resolveOrgId } from "../config.js";
import { capItemList } from "../utils/capOutput.js";
import { piiRedactionEnabled, redactPii } from "../utils/pii.js";
import { redactSecretKeys } from "../utils/logger.js";

const JSON_MIME = "application/json";

interface CapNote {
  truncated: number;
  note: string;
}

/** Credential-shaped keys always, personal data with ACTION1_REDACT_PII. */
function cleanResource(data: unknown): unknown {
  const masked = redactSecretKeys(data);
  return piiRedactionEnabled() ? redactPii(masked) : masked;
}

function buildResourcePayload(rawItems: unknown[], extra: Record<string, unknown> = {}): string {
  const items = cleanResource(rawItems) as unknown[];
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
      note: "Resource truncated to fit the 1 MB host limit. For full data, use the equivalent paginated tool (e.g. action1_list_endpoints) which streams across multiple calls.",
    };
    payload.truncated = note.truncated;
    payload.note = note.note;
  }
  return JSON.stringify(payload, null, 2);
}

/**
 * Run a resource handler and turn failures into JSON-RPC errors, as the
 * MCP spec asks for `resources/read`: an upstream 404 becomes the SDK's
 * ResourceNotFoundError, every other failure an InternalError
 * (-32603) whose `data` carries the upstream status and hint. A failed
 * read is never returned as successful content.
 */
export async function safeResourceRead(
  uri: string,
  fn: () => Promise<string>,
): Promise<{ contents: { uri: string; mimeType: string; text: string }[] }> {
  let text: string;
  try {
    text = await fn();
  } catch (err) {
    if (err instanceof Action1ApiError) {
      if (err.status === 404) throw new ResourceNotFoundError(uri, err.message);
      throw new ProtocolError(ProtocolErrorCode.InternalError, err.message, {
        uri,
        status: err.status,
        ...(err.hint ? { hint: err.hint } : {}),
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new ProtocolError(ProtocolErrorCode.InternalError, message, { uri });
  }
  return { contents: [{ uri, mimeType: JSON_MIME, text }] };
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
        "The authenticated API user (GET /me). Useful as a startup probe - agents can read this to know which permissions / role they have before calling potentially-403 tools.",
      mimeType: JSON_MIME,
    },
    async (uri) =>
      safeResourceRead(uri.href, async () => {
        const data = await client.request<unknown>("/me");
        return JSON.stringify(cleanResource(data), null, 2);
      }),
  );

  server.registerResource(
    "organizations",
    "action1://orgs",
    {
      title: "Visible organizations",
      description: "All organizations the configured API key can access (GET /organizations).",
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

/** `default` or an empty value means ACTION1_ORG_ID; every org is checked against the allowlist. */
function resolveOrgIdParam(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return resolveOrgId(!value || value === "default" ? undefined : value);
}
