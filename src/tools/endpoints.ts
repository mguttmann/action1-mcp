import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Action1Client } from "../client/action1Client.js";
import { Action1ApiError } from "../client/errors.js";
import { resolveOrgId } from "../config.js";
import { fetchEndpointInfo } from "../client/endpointInfo.js";
import {
  cappedListResult,
  cursorInputShape,
  cursorListOutputShape,
  endpointIdSchema,
  errorResult,
  formatShape,
  jsonResult,
  listOutputShape,
  orgIdShape,
  pagedListResult,
  runTool,
  singleObjectOutputShape,
} from "./helpers.js";
import { collect } from "../client/pagination.js";
import { detectPlatform } from "../utils/osDetect.js";
import { bareEndpoint, compactEndpoint } from "../utils/capOutput.js";
import { isEndpointActuallyOnline } from "../utils/lastSeen.js";
import { buildCursor, fingerprintQuery, pagedFetch, parseCursor } from "../utils/cursor.js";

const projectEndpoint = (raw: unknown, mode: "bare" | "compact" | "full"): unknown => {
  if (mode === "full") return raw;
  if (mode === "bare") return bareEndpoint(raw);
  return compactEndpoint(raw);
};

export function registerEndpointTools(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_list_endpoints",
    {
      title: "List managed endpoints (cursor-paginated)",
      description:
        "List endpoints with server-side filters (status, online_status, os, reboot_required, …). For counts, use action1_endpoints_summary instead.",
      inputSchema: {
        ...orgIdShape,
        ...cursorInputShape,
        ...formatShape,
        page_size: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Upstream page size."),
        projection: z
          .enum(["bare", "compact", "full"])
          .optional()
          .describe("Client projection: bare (default), compact, full."),
        // Note: `fields` is the upstream Action1 API param (server-side
        // selection between summary fields like `missing_updates` and
        // `vulnerabilities`). It's separate from `projection` (above)
        // which controls how WE shape the response client-side.
        fields: z
          .enum(["*", "missing_updates", "vulnerabilities"])
          .optional()
          .describe("API field-set: *, missing_updates, vulnerabilities."),
        sortby: z.string().optional().describe("Sort key (e.g. name, last_seen)."),
        filter: z
          .string()
          .optional()
          .describe("Action1 filter expr (e.g. status=='Connected')."),
        status: z
          .string()
          .optional()
          .describe("Filter by status (Connected/Disconnected)."),
        online_status: z.string().optional().describe("Filter by online status."),
        update_status: z.string().optional().describe("Filter by update status."),
        vulnerability_status: z
          .string()
          .optional()
          .describe("Filter by vulnerability status."),
        reboot_required: z
          .enum(["yes", "no"])
          .optional()
          .describe("Filter by reboot-required."),
        os: z.string().optional().describe("Filter by OS substring."),
        reset_cache: z
          .boolean()
          .optional()
          .describe("Bypass cache for fresh page."),
      },
      outputSchema: cursorListOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      org_id,
      cursor,
      limit,
      page_size,
      projection,
      fields,
      response_format,
      sortby,
      filter,
      status,
      online_status,
      update_status,
      vulnerability_status,
      reboot_required,
      os,
      reset_cache,
    }) =>
      runTool(async () => {
        const orgId = resolveOrgId(org_id);
        const mode = projection ?? "bare";
        // Server-side filter values are part of the cursor's fingerprint
        // so a follow-up page can't accidentally use a different filter
        // set than the previous one.
        const fp = fingerprintQuery({
          orgId,
          mode,
          sortby: sortby ?? "",
          filter: filter ?? "",
          status: status ?? "",
          online_status: online_status ?? "",
          update_status: update_status ?? "",
          vulnerability_status: vulnerability_status ?? "",
          reboot_required: reboot_required ?? "",
          os: os ?? "",
          reset_cache: reset_cache ?? false,
          fields: fields ?? "",
        });
        const baseQuery: Record<string, unknown> = {};
        if (sortby !== undefined) baseQuery.sortby = sortby;
        if (filter !== undefined) baseQuery.filter = filter;
        if (status !== undefined) baseQuery.status = status;
        if (online_status !== undefined) baseQuery.online_status = online_status;
        if (update_status !== undefined) baseQuery.update_status = update_status;
        if (vulnerability_status !== undefined)
          baseQuery.vulnerability_status = vulnerability_status;
        if (reboot_required !== undefined) baseQuery.reboot_required = reboot_required;
        if (os !== undefined) baseQuery.os = os;
        if (reset_cache !== undefined) baseQuery.reset_cache = reset_cache;
        if (fields !== undefined) baseQuery.fields = fields;
        const result = await pagedFetch<unknown>(
          async ({ from, limit: pageLimit }) => {
            const raw = (await client.request<unknown>(
              `/endpoints/managed/${encodeURIComponent(orgId)}`,
              { query: { ...baseQuery, limit: pageLimit, from } },
            )) as { items?: unknown[] } | unknown[];
            const items = Array.isArray(raw) ? raw : (raw.items ?? []);
            return {
              items: items.map((it) => projectEndpoint(it, mode)),
              hasMore: items.length === pageLimit,
            };
          },
          {
            ...(cursor !== undefined ? { cursor } : {}),
            fingerprint: fp,
            pageSize: page_size ?? 200,
            ...(limit !== undefined ? { maxItems: limit } : {}),
          },
        );
        return pagedListResult(result, response_format);
      }),
  );

  server.registerTool(
    "action1_endpoints_summary",
    {
      title: "Server-side aggregation over all endpoints",
      description: "Walks every endpoint and returns counts (total, by status/platform/OS/online, reboot_required). ~1 KB output regardless of fleet size.",
      inputSchema: {
        ...orgIdShape,
        ...formatShape,
      },
      outputSchema: singleObjectOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ org_id, response_format }) =>
      runTool(async () => {
        const orgId = resolveOrgId(org_id);
        const all = await collect(
          client.paginate<unknown>(`/endpoints/managed/${encodeURIComponent(orgId)}`, {
            limit: 200,
          }),
        );
        const counters = {
          total: all.length,
          by_status: {} as Record<string, number>,
          by_platform: {} as Record<string, number>,
          by_os: {} as Record<string, number>,
          by_online_status: {} as Record<string, number>,
          fresh_last_seen: 0,
          stale_last_seen: 0,
          reboot_required: 0,
          windows: 0,
          macos: 0,
          linux: 0,
        };
        for (const ep of all) {
          if (!ep || typeof ep !== "object") continue;
          const e = ep as Record<string, unknown>;
          const status = typeof e.status === "string" ? e.status : "Unknown";
          counters.by_status[status] = (counters.by_status[status] ?? 0) + 1;
          const platform = typeof e.platform === "string" ? e.platform : "Unknown";
          counters.by_platform[platform] = (counters.by_platform[platform] ?? 0) + 1;
          const os = typeof e.OS === "string" ? e.OS : "Unknown";
          counters.by_os[os] = (counters.by_os[os] ?? 0) + 1;
          const online = typeof e.online_status === "string" ? e.online_status : "Unknown";
          counters.by_online_status[online] = (counters.by_online_status[online] ?? 0) + 1;
          const conn = isEndpointActuallyOnline(e);
          if (conn.online) counters.fresh_last_seen += 1;
          else counters.stale_last_seen += 1;
          if (e.reboot_required === "yes" || e.reboot_required === true) {
            counters.reboot_required += 1;
          }
          const detected = detectPlatform(e);
          if (detected === "windows") counters.windows += 1;
          else if (detected === "macos") counters.macos += 1;
          else if (detected === "linux") counters.linux += 1;
        }
        return jsonResult(counters, counters, response_format);
      }),
  );

  server.registerTool(
    "action1_get_endpoint",
    {
      title: "Get endpoint general info",
      description: "Fetch the general info block for a single endpoint, plus derived platform and connectivity.online flags.",
      inputSchema: {
        ...orgIdShape,
        ...formatShape,
        endpoint_id: endpointIdSchema,
      },
      outputSchema: singleObjectOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ org_id, endpoint_id, response_format }) =>
      runTool(async () => {
        const orgId = resolveOrgId(org_id);
        const info = await fetchEndpointInfo(client, orgId, endpoint_id);
        const platform = detectPlatform(info.data);
        const connectivity = isEndpointActuallyOnline(info.data);
        return jsonResult(
          { general: info.data, platform, connectivity, source: info.source },
          {
            general: info.data as Record<string, unknown>,
            platform,
            connectivity,
            source: info.source,
          },
          response_format,
        );
      }),
  );

  server.registerTool(
    "action1_search_endpoints",
    {
      title: "Search endpoints (client-side substring filter, cursor-paginated)",
      description: "Substring search across hostname, user, OS, status. Walks pages client-side since Action1 has no server-side substring search.",
      inputSchema: {
        ...orgIdShape,
        ...cursorInputShape,
        ...formatShape,
        query: z.string().min(1).describe("Substring (case-insensitive)."),
        fields: z
          .array(z.enum(["hostname", "user", "os", "status"]))
          .optional()
          .describe("Restrict matching to these fields."),
        projection: z
          .enum(["bare", "compact", "full"])
          .optional()
          .describe("Per-endpoint projection."),
      },
      outputSchema: cursorListOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ org_id, cursor, limit, query, fields, projection, response_format }) =>
      runTool(async () => {
        const orgId = resolveOrgId(org_id);
        const useFields = new Set<string>(fields ?? ["hostname", "user", "os", "status"]);
        const mode = projection ?? "compact";
        const fp = fingerprintQuery({
          orgId,
          query,
          fields: [...useFields].sort(),
          mode,
        });
        const startFrom = cursor ? (parseCursor(cursor)?.from ?? 0) : 0;
        const matches: unknown[] = [];
        const cap = 400_000;
        let pos = startFrom;
        const hardLimit = limit ?? Number.POSITIVE_INFINITY;
        while (matches.length < hardLimit) {
          const raw = (await client.request<unknown>(
            `/endpoints/managed/${encodeURIComponent(orgId)}`,
            { query: { limit: 200, from: pos } },
          )) as { items?: unknown[] } | unknown[];
          const items = Array.isArray(raw) ? raw : (raw.items ?? []);
          if (items.length === 0) break;
          pos += items.length;
          for (const it of items) {
            if (matches.length >= hardLimit) break;
            const candidates = collectFieldValues(it, useFields);
            if (!candidates.some((s) => s.toLowerCase().includes(query.toLowerCase()))) continue;
            matches.push(projectEndpoint(it, mode));
            if (JSON.stringify(matches).length > cap) {
              matches.pop();
              return pagedListResult(
                {
                  items: matches,
                  count: matches.length,
                  // Use the shared buildCursor helper so the wire format
                  // stays in lock-step with parseCursor / pagedFetch — a
                  // hand-rolled base64 of {from, q} would silently drift
                  // if the cursor schema ever changes.
                  next_cursor: buildCursor(pos - 1, fp),
                  has_more: true,
                },
                response_format,
              );
            }
          }
          if (items.length < 200) break;
        }
        return pagedListResult(
          {
            items: matches,
            count: matches.length,
            next_cursor: null,
            has_more: false,
          },
          response_format,
        );
      }),
  );

  server.registerTool(
    "action1_list_missing_updates",
    {
      title: "List missing updates for an endpoint",
      description: "Returns missing-update items for one endpoint. Each item.id can be passed to action1_deploy_update.",
      inputSchema: {
        ...orgIdShape,
        ...formatShape,
        endpoint_id: endpointIdSchema,
        limit: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe("Max items to return."),
      },
      outputSchema: listOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ org_id, endpoint_id, limit, response_format }) =>
      runTool(async () => {
        const orgId = resolveOrgId(org_id);
        const items = await collect(
          client.paginate<unknown>(
            `/endpoints/managed/${encodeURIComponent(orgId)}/${encodeURIComponent(endpoint_id)}/missing-updates`,
            { limit: 200, ...(limit !== undefined ? { maxItems: limit } : {}) },
          ),
        );
        return cappedListResult(items, response_format);
      }),
  );

  server.registerTool(
    "action1_list_vulnerabilities",
    {
      title: "List vulnerabilities for an endpoint",
      description: "Returns vulnerability findings for one endpoint. Returns a clear 403 if the API key lacks the vulnerabilities scope.",
      inputSchema: {
        ...orgIdShape,
        ...formatShape,
        endpoint_id: endpointIdSchema,
      },
      outputSchema: listOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ org_id, endpoint_id, response_format }) =>
      runTool(async () => {
        const orgId = resolveOrgId(org_id);
        try {
          const items = await collect(
            client.paginate<unknown>(
              `/endpoints/managed/${encodeURIComponent(orgId)}/${encodeURIComponent(endpoint_id)}/vulnerabilities`,
              { limit: 200 },
            ),
          );
          return cappedListResult(items, response_format);
        } catch (err) {
          // Action1 returns 403 when the API key role lacks the
          // `view_vulnerabilities` scope. Surface the curated hint
          // before the generic Action1ApiError handler so the agent
          // gets the most specific guidance.
          if (err instanceof Action1ApiError && err.status === 403) {
            return errorResult(
              "Action1 returned 403 for vulnerabilities. The API key likely lacks the vulnerabilities scope - check the role permissions in the Action1 console.",
            );
          }
          throw err;
        }
      }),
  );
}

function collectFieldValues(value: unknown, useFields: Set<string>): string[] {
  if (!value || typeof value !== "object") return [];
  const obj = value as Record<string, unknown>;
  const lookup = new Map<string, unknown>();
  for (const k of Object.keys(obj)) lookup.set(k.toLowerCase(), obj[k]);
  const out: string[] = [];
  if (useFields.has("hostname")) {
    for (const key of ["hostname", "computer_name", "device_name", "name", "address"]) {
      pushFromLookup(out, lookup, key);
    }
  }
  if (useFields.has("user")) {
    for (const key of ["last_logged_user", "user", "primary_user"]) {
      pushFromLookup(out, lookup, key);
    }
  }
  if (useFields.has("os")) {
    for (const key of ["os", "operating_system", "platform"]) {
      const v = lookup.get(key);
      if (typeof v === "string") out.push(v);
      else if (v && typeof v === "object") {
        const name = (v as Record<string, unknown>).name;
        if (typeof name === "string") out.push(name);
      }
    }
  }
  if (useFields.has("status")) {
    for (const key of ["status", "online_status"]) pushFromLookup(out, lookup, key);
  }
  return out;
}

function pushFromLookup(arr: string[], lookup: Map<string, unknown>, key: string): void {
  const v = lookup.get(key);
  if (typeof v === "string" && v.length > 0) arr.push(v);
}
