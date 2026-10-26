import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Action1Client } from "../client/action1Client.js";
import { Action1ApiError } from "../client/errors.js";
import { loadConfig, resolveOrgId } from "../config.js";
import { fetchEndpointInfo } from "../client/endpointInfo.js";
import {
  cappedListResultFromStream,
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
  objectOutputShape,
} from "./helpers.js";
import { detectPlatform } from "../utils/osDetect.js";
import { bareEndpoint, compactEndpoint } from "../utils/capOutput.js";
import { isEndpointActuallyOnline } from "../utils/lastSeen.js";
import { fingerprintQuery, pagedFetch } from "../utils/cursor.js";
import { listPageFetcher } from "../client/pagination.js";
import {
  ENDPOINT_FILTER_VALUES,
  endpointRebootRequired,
  endpointSearchValues,
  endpointView,
  type EndpointSearchField,
  rebootRequiredQueryValue,
  resetCacheQueryValue,
} from "../spec/entities.js";

const values = (vs: readonly string[]): string => vs.join(", ");

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
      inputSchema: z.object({
        ...orgIdShape,
        ...cursorInputShape,
        ...formatShape,
        page_size: z.number().int().min(1).max(500).optional().describe("Upstream page size."),
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
          .describe("Case-insensitive substring; an endpoint matches when any field contains it."),
        status: z
          .string()
          .optional()
          .describe("Filter by status: " + values(ENDPOINT_FILTER_VALUES.status) + "."),
        online_status: z
          .string()
          .optional()
          .describe(
            "Filter by online status: " + values(ENDPOINT_FILTER_VALUES.online_status) + ".",
          ),
        update_status: z
          .string()
          .optional()
          .describe(
            "Filter by update status: " + values(ENDPOINT_FILTER_VALUES.update_status) + ".",
          ),
        vulnerability_status: z
          .string()
          .optional()
          .describe(
            "Filter by vulnerability status: " +
              values(ENDPOINT_FILTER_VALUES.vulnerability_status) +
              ".",
          ),
        reboot_required: z
          .enum(["Yes", "No", "yes", "no"])
          .optional()
          .describe("Filter by reboot-required: Yes or No."),
        os: z.string().optional().describe("Filter by operating system name."),
        reset_cache: z.boolean().optional().describe("Bypass cache for fresh page."),
      }),
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
          reboot_required:
            reboot_required !== undefined ? rebootRequiredQueryValue(reboot_required) : "",
          os: os ?? "",
          reset_cache: reset_cache ?? false,
          fields: fields ?? "",
        });
        const baseQuery: Record<string, string> = {};
        if (sortby !== undefined) baseQuery.sortby = sortby;
        if (filter !== undefined) baseQuery.filter = filter;
        if (status !== undefined) baseQuery.status = status;
        if (online_status !== undefined) baseQuery.online_status = online_status;
        if (update_status !== undefined) baseQuery.update_status = update_status;
        if (vulnerability_status !== undefined)
          baseQuery.vulnerability_status = vulnerability_status;
        if (reboot_required !== undefined) {
          baseQuery.reboot_required = rebootRequiredQueryValue(reboot_required);
        }
        if (os !== undefined) baseQuery.os = os;
        if (reset_cache !== undefined) baseQuery.reset_cache = resetCacheQueryValue(reset_cache);
        if (fields !== undefined) baseQuery.fields = fields;
        const result = await pagedFetch<unknown, unknown>(
          listPageFetcher(client, `/endpoints/managed/${encodeURIComponent(orgId)}`, baseQuery),
          {
            ...(cursor !== undefined ? { cursor } : {}),
            fingerprint: fp,
            pageSize: page_size ?? 200,
            ...(limit !== undefined ? { maxItems: limit } : {}),
            project: (it) => projectEndpoint(it, mode),
          },
        );
        return pagedListResult(result, response_format);
      }),
  );

  server.registerTool(
    "action1_endpoints_summary",
    {
      title: "Server-side aggregation over all endpoints",
      description:
        "Walks every endpoint and returns counts (total, by status/platform/OS/online, reboot_required). ~1 KB output regardless of fleet size.",
      inputSchema: z.object({
        ...orgIdShape,
        ...formatShape,
      }),
      outputSchema: objectOutputShape({
        total: "number",
        by_status: "object",
        by_platform: "object",
        by_os: "object",
        by_online_status: "object",
        fresh_last_seen: "number",
        stale_last_seen: "number",
        reboot_required: "number",
        windows: "number",
        macos: "number",
        linux: "number",
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ org_id, response_format }) =>
      runTool(async () => {
        const cfg = loadConfig();
        const orgId = resolveOrgId(org_id, cfg);
        const counters = {
          total: 0,
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
        // Stream the walk: only the counters are kept, never the fleet.
        for await (const ep of client.paginate<unknown>(
          `/endpoints/managed/${encodeURIComponent(orgId)}`,
          { limit: 200 },
        )) {
          counters.total += 1;
          if (!ep || typeof ep !== "object") continue;
          const e = ep as Record<string, unknown>;
          const v = endpointView(e);
          const count = (rec: Record<string, number>, key: string | undefined) => {
            const k = key ?? "Unknown";
            rec[k] = (rec[k] ?? 0) + 1;
          };
          count(counters.by_status, v.status);
          count(counters.by_platform, v.platform);
          count(counters.by_os, v.os);
          count(counters.by_online_status, v.onlineStatus);
          const conn = isEndpointActuallyOnline(e, cfg.lastSeenStaleMinutes);
          if (conn.online) counters.fresh_last_seen += 1;
          else counters.stale_last_seen += 1;
          if (endpointRebootRequired(e)) counters.reboot_required += 1;
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
      description:
        "Fetch the general info block for a single endpoint, plus derived platform and connectivity.online flags.",
      inputSchema: z.object({
        ...orgIdShape,
        ...formatShape,
        endpoint_id: endpointIdSchema,
      }),
      outputSchema: objectOutputShape({
        general: "object",
        platform: "string",
        connectivity: "object",
        source: "string",
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ org_id, endpoint_id, response_format }) =>
      runTool(async () => {
        const cfg = loadConfig();
        const orgId = resolveOrgId(org_id, cfg);
        const info = await fetchEndpointInfo(client, orgId, endpoint_id);
        const platform = detectPlatform(info.data);
        const connectivity = isEndpointActuallyOnline(info.data, cfg.lastSeenStaleMinutes);
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
      description:
        "Case-insensitive substring search restricted to hostname, user, OS and status fields. Walks the endpoint list page by page and matches client-side.",
      inputSchema: z.object({
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
      }),
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
        const useFields = new Set<EndpointSearchField>(
          fields ?? ["hostname", "user", "os", "status"],
        );
        const mode = projection ?? "compact";
        const fp = fingerprintQuery({
          orgId,
          query,
          fields: [...useFields].sort(),
          mode,
        });
        const needle = query.toLowerCase();
        // pagedFetch tracks the upstream position of every scanned
        // record, so a page that ends on the byte cap or on `limit`
        // resumes exactly at the first match not yet returned.
        const result = await pagedFetch<unknown, unknown>(
          listPageFetcher(client, `/endpoints/managed/${encodeURIComponent(orgId)}`),
          {
            ...(cursor !== undefined ? { cursor } : {}),
            fingerprint: fp,
            pageSize: 200,
            ...(limit !== undefined ? { maxItems: limit } : {}),
            filter: (it) =>
              endpointSearchValues(it, useFields).some((v) => v.toLowerCase().includes(needle)),
            project: (it) => projectEndpoint(it, mode),
          },
        );
        return pagedListResult(result, response_format);
      }),
  );

  server.registerTool(
    "action1_list_missing_updates",
    {
      title: "List missing updates for an endpoint",
      description:
        "Returns missing-update items for one endpoint. Each item.id can be passed to action1_deploy_update.",
      inputSchema: z.object({
        ...orgIdShape,
        ...formatShape,
        endpoint_id: endpointIdSchema,
        limit: z.number().int().min(1).max(2000).optional().describe("Max items to return."),
      }),
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
        return cappedListResultFromStream(
          client.paginate<unknown>(
            `/endpoints/managed/${encodeURIComponent(orgId)}/${encodeURIComponent(endpoint_id)}/missing-updates`,
            { limit: 200, ...(limit !== undefined ? { maxItems: limit } : {}) },
          ),
          response_format,
        );
      }),
  );

  server.registerTool(
    "action1_list_vulnerabilities",
    {
      title: "List vulnerabilities for an endpoint",
      description:
        "Returns vulnerability findings for one endpoint. Returns a clear 403 if the API key lacks the vulnerabilities scope.",
      inputSchema: z.object({
        ...orgIdShape,
        ...formatShape,
        endpoint_id: endpointIdSchema,
      }),
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
          return await cappedListResultFromStream(
            client.paginate<unknown>(
              `/endpoints/managed/${encodeURIComponent(orgId)}/${encodeURIComponent(endpoint_id)}/vulnerabilities`,
              { limit: 200 },
            ),
            response_format,
          );
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
