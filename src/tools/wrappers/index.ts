import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Action1Client } from "../../client/action1Client.js";
import { resolveOrgId } from "../../config.js";
import { collect, listPageFetcher, parsePageEnvelope } from "../../client/pagination.js";
import {
  cursorInputShape,
  cursorListOutputShape,
  endpointIdSchema,
  errorResult,
  formatShape,
  jsonResult,
  orgIdShape,
  pagedListResult,
  runTool,
  objectOutputShape,
} from "../helpers.js";
import { capItemStream } from "../../utils/capOutput.js";
import { sanitizeCsvFormulas } from "../../utils/csv.js";
import { piiRedactionEnabled, redactPii } from "../../utils/pii.js";
import { fingerprintQuery, pagedFetch } from "../../utils/cursor.js";
import { Action1ApiError } from "../../client/errors.js";
import {
  auditEventView,
  endpointGroupRef,
  reportRef,
  installedSoftwareName,
  missingUpdateId,
  scheduleInactive,
  scheduleTargets,
  scheduleTemplateIds,
  vulnerabilityCveId,
  vulnerabilityPackages,
  vulnerableEndpointId,
  type PackageCandidate,
} from "../../spec/entities.js";
import { action1TimeSchema, parseAction1Time, toAction1Time } from "../../spec/time.js";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const READONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function fuzzyFind<T extends { id: string; name: string }>(
  items: T[],
  query: string,
): { matches: T[]; how: "exact-id" | "exact-name" | "starts-with" | "contains" | "none" } {
  if (UUID_RE.test(query)) {
    const m = items.find((i) => i.id.toLowerCase() === query.toLowerCase());
    return { matches: m ? [m] : [], how: m ? "exact-id" : "none" };
  }
  const lc = query.toLowerCase();
  const exact = items.filter((i) => i.name.toLowerCase() === lc);
  if (exact.length) return { matches: exact, how: "exact-name" };
  const starts = items.filter((i) => i.name.toLowerCase().startsWith(lc));
  if (starts.length) return { matches: starts, how: "starts-with" };
  const contains = items.filter((i) => i.name.toLowerCase().includes(lc));
  if (contains.length) return { matches: contains, how: "contains" };
  return { matches: [], how: "none" };
}

export function registerWrapperTools(server: McpServer, client: Action1Client): void {
  registerEndpointGroupsResolve(server, client);
  registerSoftwareInventoryForEndpoint(server, client);
  registerRecurringSchedules(server, client);
  registerAuditLogSearch(server, client);
  registerReportExport(server, client);
  registerCveRemediationPlan(server, client);
}

function registerEndpointGroupsResolve(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_endpoint_groups_resolve",
    {
      title: "Resolve endpoint group by name (fuzzy)",
      description:
        "Look up an endpoint group by name or UUID using exact-id/exact-name/starts-with/contains.",
      inputSchema: z.object({
        ...orgIdShape,
        ...formatShape,
        query: z.string().min(1).describe("Group name fragment or UUID."),
      }),
      outputSchema: objectOutputShape({
        match_strategy: "string",
        matches: "array",
        total_groups: "number",
      }),
      annotations: READONLY_ANNOTATIONS,
    },
    async ({ org_id, query, response_format }) =>
      runTool(async () => {
        const orgId = resolveOrgId(org_id);
        const groups = await collect(
          client.paginate<{ id?: unknown; name?: unknown }>(
            "/endpoints/groups/" + encodeURIComponent(orgId),
            { limit: 200 },
          ),
        );
        const typed = groups
          .map(endpointGroupRef)
          .filter((g): g is { id: string; name: string } => g !== undefined);
        const { matches, how } = fuzzyFind(typed, query);
        return jsonResult(
          { match_strategy: how, matches, total_groups: typed.length },
          { match_strategy: how, matches, total_groups: typed.length },
          response_format,
        );
      }),
  );
}

function registerSoftwareInventoryForEndpoint(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_software_inventory_for_endpoint",
    {
      title: "List installed software for an endpoint",
      description:
        "Fetch installed-software inventory for one endpoint, with optional name substring filter.",
      inputSchema: z.object({
        ...orgIdShape,
        ...cursorInputShape,
        ...formatShape,
        endpoint_id: endpointIdSchema,
        find_by_name: z.string().optional().describe("Substring filter on application name."),
      }),
      outputSchema: cursorListOutputShape,
      annotations: READONLY_ANNOTATIONS,
    },
    async ({ org_id, cursor, endpoint_id, find_by_name, limit, response_format }) =>
      runTool(async () => {
        const orgId = resolveOrgId(org_id);
        const fp = fingerprintQuery({ orgId, endpoint_id, find_by_name: find_by_name ?? "" });
        const lc = find_by_name?.toLowerCase();
        const result = await pagedFetch<unknown>(
          listPageFetcher(
            client,
            "/installed-software/" +
              encodeURIComponent(orgId) +
              "/data/" +
              encodeURIComponent(endpoint_id),
          ),
          {
            ...(cursor !== undefined ? { cursor } : {}),
            fingerprint: fp,
            ...(limit !== undefined ? { maxItems: limit } : {}),
            // Filter inside pagedFetch (not inside fetchPage) so the
            // cursor tracks upstream positions and a filtered page does
            // not end the walk after the first upstream page.
            ...(lc
              ? {
                  filter: (it: unknown) =>
                    installedSoftwareName(it)?.toLowerCase().includes(lc) ?? false,
                }
              : {}),
          },
        );
        return pagedListResult(result, response_format);
      }),
  );
}

function registerRecurringSchedules(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_recurring_schedules",
    {
      title: "List recurring automation schedules (read)",
      description:
        "List recurring automations with optional client-side filters (status, template_id, group id substring).",
      inputSchema: z.object({
        ...orgIdShape,
        ...cursorInputShape,
        ...formatShape,
        active_only: z.boolean().optional().describe("Drop paused/disabled schedules."),
        template_id: z.string().optional().describe("Filter by first action template_id."),
        group_id_substring: z.string().optional().describe("Filter by target group id substring."),
      }),
      outputSchema: cursorListOutputShape,
      annotations: READONLY_ANNOTATIONS,
    },
    async ({
      org_id,
      cursor,
      limit,
      active_only,
      template_id,
      group_id_substring,
      response_format,
    }) =>
      runTool(async () => {
        const orgId = resolveOrgId(org_id);
        const fp = fingerprintQuery({
          orgId,
          active_only: active_only ?? false,
          template_id: template_id ?? "",
          group_id_substring: group_id_substring ?? "",
        });
        const matchesFilters = (it: unknown): boolean => {
          if (!it || typeof it !== "object") return false;
          if (active_only && scheduleInactive(it)) return false;
          if (template_id && !scheduleTemplateIds(it).includes(template_id)) return false;
          if (group_id_substring) {
            const matches = scheduleTargets(it).some(
              (t) => t.id.includes(group_id_substring) && t.type === "EndpointGroup",
            );
            if (!matches) return false;
          }
          return true;
        };
        const result = await pagedFetch<unknown>(
          listPageFetcher(client, "/automations/schedules/" + encodeURIComponent(orgId)),
          {
            ...(cursor !== undefined ? { cursor } : {}),
            fingerprint: fp,
            ...(limit !== undefined ? { maxItems: limit } : {}),
            filter: matchesFilters,
          },
        );
        return pagedListResult(result, response_format);
      }),
  );
}

/**
 * Most upstream pages one action1_audit_log_search call scans. A narrow
 * filter over a long audit log otherwise walks the whole log in one
 * call; past this bound the call returns `has_more: true` and a cursor
 * that continues the scan.
 */
export const AUDIT_SEARCH_MAX_PAGES = 10;

function registerAuditLogSearch(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_audit_log_search",
    {
      title: "Search the audit log",
      description:
        "Search /audit/events with an optional time window (sent to Action1 as timefrom/timeto) and case-insensitive substring filters on user, event and object.",
      inputSchema: z.object({
        ...cursorInputShape,
        ...formatShape,
        from_time: action1TimeSchema
          .optional()
          .describe("Lower bound: YYYY-MM-DD_HH-MM-SS (UTC) or ISO-8601."),
        to_time: action1TimeSchema
          .optional()
          .describe("Upper bound: YYYY-MM-DD_HH-MM-SS (UTC) or ISO-8601."),
        user_substring: z.string().optional().describe("Filter by user name."),
        event_type_substring: z
          .string()
          .optional()
          .describe("Filter by event name (e.g. Login, View Report, POST)."),
        target_substring: z
          .string()
          .optional()
          .describe("Filter by affected object (name, URL or description)."),
      }),
      outputSchema: cursorListOutputShape,
      annotations: READONLY_ANNOTATIONS,
    },
    async (args) =>
      runTool(async () => {
        const fp = fingerprintQuery({
          from_time: args.from_time ?? "",
          to_time: args.to_time ?? "",
          user_substring: args.user_substring ?? "",
          event_type_substring: args.event_type_substring ?? "",
          target_substring: args.target_substring ?? "",
        });
        const fromMs = args.from_time ? parseAction1Time(args.from_time) : undefined;
        const toMs = args.to_time ? parseAction1Time(args.to_time) : undefined;
        const timeFilterActive = fromMs !== undefined || toMs !== undefined;
        // The window also goes upstream in the documented format, so
        // Action1 can skip the rest of the log; the local check below
        // stays in case the server ignores it.
        const upstream: Record<string, string> = {};
        const timefrom = args.from_time ? toAction1Time(args.from_time) : undefined;
        const timeto = args.to_time ? toAction1Time(args.to_time) : undefined;
        if (timefrom) upstream.timefrom = timefrom;
        if (timeto) upstream.timeto = timeto;
        const userLc = args.user_substring?.toLowerCase();
        const typeLc = args.event_type_substring?.toLowerCase();
        const targetLc = args.target_substring?.toLowerCase();
        const matches = (values: string[], lc: string | undefined): boolean =>
          !lc || values.some((v) => v.toLowerCase().includes(lc));
        // When a time filter is active, a record whose timestamp cannot
        // be parsed cannot be placed inside or outside the window. It is
        // dropped and counted, so the agent can see that upstream
        // timestamps changed format instead of getting it silently
        // included or excluded.
        let droppedUnparseableTimestamps = 0;
        const matchesFilters = (it: unknown): boolean => {
          if (!it || typeof it !== "object") return false;
          const ev = auditEventView(it);
          const ts = ev.timestamp !== undefined ? parseAction1Time(ev.timestamp) : undefined;
          if (timeFilterActive && ts === undefined) {
            droppedUnparseableTimestamps += 1;
            return false;
          }
          if (fromMs !== undefined && ts !== undefined && ts < fromMs) return false;
          if (toMs !== undefined && ts !== undefined && ts > toMs) return false;
          return (
            matches(ev.users, userLc) && matches(ev.events, typeLc) && matches(ev.targets, targetLc)
          );
        };
        const result = await pagedFetch<unknown>(
          listPageFetcher(client, "/audit/events", upstream),
          {
            ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
            fingerprint: fp,
            ...(args.limit !== undefined ? { maxItems: args.limit } : {}),
            filter: matchesFilters,
            maxPages: AUDIT_SEARCH_MAX_PAGES,
          },
        );
        // The drop counter is a fault-detection signal: it goes into both
        // channels (the Markdown renderer prints every top-level field).
        return pagedListResult(
          result,
          args.response_format,
          undefined,
          droppedUnparseableTimestamps > 0
            ? { dropped_unparseable_timestamps: droppedUnparseableTimestamps }
            : undefined,
        );
      }),
  );
}

function registerReportExport(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_report_export",
    {
      title: "Run a report and return its data or CSV export",
      description: "Resolve a report by name or UUID, then return JSON rows or a CSV export blob.",
      inputSchema: z.object({
        ...orgIdShape,
        ...formatShape,
        report: z.string().min(1).describe("Report id or name fragment."),
        format: z.enum(["json", "csv"]).default("json").describe("'json' rows or 'csv' blob."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .describe("Max rows when format='json'."),
      }),
      outputSchema: objectOutputShape({
        format: "string",
        report_id: "string",
        items: "array",
        count: "number",
        total: "number",
        truncated: "number | boolean",
        content: "string",
        note: "string",
      }),
      annotations: READONLY_ANNOTATIONS,
    },
    async ({ org_id, report, format, limit, response_format }) =>
      runTool(async () => {
        const orgId = resolveOrgId(org_id);
        let reportId = report;
        if (!UUID_RE.test(report)) {
          const reports = await collect(client.paginate<unknown>("/reports/all", { limit: 100 }));
          const typed = reports
            .map(reportRef)
            .filter((r): r is { id: string; name: string } => r !== undefined);
          const { matches, how } = fuzzyFind(typed, report);
          if (matches.length === 0) {
            return errorResult(
              `Report "${report}" not found among ${typed.length} reports. Pass a UUID or refine the name.`,
            );
          }
          if (matches.length > 1) {
            return errorResult(
              `Report "${report}" matched ${matches.length} reports (strategy: ${how}): ${matches.map((m) => m.name).join(", ")}. Refine the name or pass a UUID.`,
            );
          }
          reportId = matches[0]!.id;
        }
        if (format === "csv") {
          const data = await client.request<unknown>(
            "/reportdata/" +
              encodeURIComponent(orgId) +
              "/" +
              encodeURIComponent(reportId) +
              "/export",
          );
          // A text body is masked by the client under ACTION1_REDACT_PII;
          // a JSON body is masked here, since jsonResult cannot see into
          // the serialised string.
          const csvTextRaw =
            typeof data === "string"
              ? data
              : JSON.stringify(piiRedactionEnabled() ? redactPii(data) : data);
          // CSV-injection defence: cells starting with `=`, `+`, `-`, `@`,
          // tab, or carriage-return are interpreted as formulas by Excel
          // and other spreadsheets. Prefix them with a single quote so
          // the tools that download the export and open it as CSV don't
          // accidentally execute attacker-controlled formulas. The leading
          // quote is conventionally accepted by Excel as a literal-text
          // marker.
          const csvText = sanitizeCsvFormulas(csvTextRaw);
          const CSV_CAP = 400_000;
          const truncated = csvText.length > CSV_CAP;
          const content = truncated ? csvText.slice(0, CSV_CAP) : csvText;
          const payload: Record<string, unknown> = {
            format: "csv",
            report_id: reportId,
            content,
            content_bytes: content.length,
            sanitized: "csv-formula-prefix-applied",
          };
          if (truncated) {
            payload.truncated_bytes = csvText.length - CSV_CAP;
            payload.note =
              "CSV output truncated to fit the 1 MB host limit. Pass format='json' with `limit` for paginated rows, or fetch the report directly via the Action1 console.";
          }
          return jsonResult(
            payload,
            { format: "csv", report_id: reportId, truncated },
            response_format,
          );
        }
        // Stream the rows: only what fits the budget is kept in memory,
        // the rest is counted so `total` stays exact.
        const cap = await capItemStream(
          client.paginate<unknown>(
            "/reportdata/" +
              encodeURIComponent(orgId) +
              "/" +
              encodeURIComponent(reportId) +
              "/data",
            { limit: 200, ...(limit !== undefined ? { maxItems: limit } : {}) },
          ),
          { project: (row) => row },
        );
        const payload: Record<string, unknown> = {
          format: "json",
          report_id: reportId,
          items: cap.items,
          count: cap.returned,
          total: cap.total,
        };
        const notes: string[] = [];
        if (cap.truncated > 0) {
          payload.truncated = cap.truncated;
          notes.push(
            "Output truncated to fit the 1 MB host limit. Use format='csv' for a single string export, or pass `limit` for a smaller subset.",
          );
        }
        if (cap.note !== undefined) notes.push(cap.note);
        if (notes.length > 0) payload.note = notes.join(" ");
        return jsonResult(payload, payload, response_format);
      }),
  );
}

type Correlation = "cve" | "endpoint_missing_updates";

interface PlanEntry {
  cve: string;
  affected_endpoints: string[];
  candidate_packages: { id: string; version?: string; source: string }[];
  /**
   * How candidate_packages were found: `cve` = the updates Action1 lists
   * as fixing this CVE (`software[].available_updates`);
   * `endpoint_missing_updates` = no CVE-specific update was listed, so
   * these are all missing updates of the affected endpoints.
   */
  correlation: Correlation;
}

const dedupePackages = (pkgs: PackageCandidate[]): PackageCandidate[] => {
  const seen = new Map<string, PackageCandidate>();
  for (const p of pkgs) if (!seen.has(p.id)) seen.set(p.id, p);
  return [...seen.values()];
};

/**
 * Most endpoint ids one CVE plan entry lists (about 200 KB of ids, within
 * the response budget); the walk itself counts all of them.
 */
const AFFECTED_ENDPOINTS_CAP = 5000;

const is403or404 = (err: unknown): err is Action1ApiError =>
  err instanceof Action1ApiError && (err.status === 403 || err.status === 404);

function registerCveRemediationPlan(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_cve_remediation_plan",
    {
      title: "Build a remediation plan for a CVE or an endpoint (read-only)",
      description:
        "Read-only correlation of vulnerabilities and the updates that fix them. Does NOT execute; pass the result to action1_deploy_update.",
      inputSchema: z.object({
        ...orgIdShape,
        ...formatShape,
        cve_id: z.string().optional().describe("Plan for one CVE id."),
        endpoint_id: endpointIdSchema.optional().describe("Plan for one endpoint."),
        max_items: z.number().int().min(1).max(500).default(50).describe("Max plan entries."),
      }),
      outputSchema: objectOutputShape({
        plan: "array",
        count: "number",
        truncated: "boolean",
        warning: "string",
      }),
      annotations: READONLY_ANNOTATIONS,
    },
    async ({ org_id, cve_id, endpoint_id, max_items, response_format }) =>
      runTool(async () => {
        const orgId = resolveOrgId(org_id);
        if (!cve_id && !endpoint_id) {
          return errorResult("Pass either cve_id or endpoint_id.");
        }
        const plan: PlanEntry[] = [];
        const warnings: string[] = [];
        let truncated = false;
        const candidates = new CandidatePackages(client, orgId);
        const entry = async (
          cve: string,
          affected: string[],
          fixes: PackageCandidate[],
        ): Promise<PlanEntry> => {
          if (fixes.length > 0) {
            return {
              cve,
              affected_endpoints: affected,
              candidate_packages: dedupePackages(fixes).map((p) => ({ ...p, source: "cve" })),
              correlation: "cve",
            };
          }
          return {
            cve,
            affected_endpoints: affected,
            candidate_packages: await candidates.forEndpoints(affected.slice(0, 10)),
            correlation: "endpoint_missing_updates",
          };
        };

        if (cve_id) {
          const cvePath =
            "/vulnerabilities/" + encodeURIComponent(orgId) + "/" + encodeURIComponent(cve_id);
          // Every affected endpoint is walked: max_items counts plan
          // entries, and the cve_id path has one. Only the id list kept
          // for the output is bounded, and saying so is part of it.
          const affected: string[] = [];
          let affectedTotal = 0;
          let fixes: PackageCandidate[] = [];
          for await (const row of client.paginate<unknown>(cvePath + "/endpoints", {
            limit: 200,
          })) {
            fixes = dedupePackages([...fixes, ...vulnerabilityPackages(row)]);
            const id = vulnerableEndpointId(row);
            if (typeof id !== "string") continue;
            affectedTotal += 1;
            if (affected.length < AFFECTED_ENDPOINTS_CAP) affected.push(id);
          }
          if (affectedTotal > affected.length) {
            truncated = true;
            warnings.push(
              `affected_endpoints lists the first ${affected.length} of ${affectedTotal} affected endpoints; the plan does not cover the rest`,
            );
          }
          if (fixes.length === 0 && affected.length > 0) {
            // The endpoint rows carry no update list: ask the CVE itself.
            try {
              fixes = vulnerabilityPackages(await client.request<unknown>(cvePath));
            } catch (err) {
              if (!is403or404(err)) throw err;
              warnings.push(
                `vulnerability ${cve_id} returned ${err.status}; plan may be incomplete`,
              );
            }
          }
          plan.push(await entry(cve_id, affected, fixes));
        }

        if (endpoint_id) {
          // Only 403 / 404 become a warning. Other errors (5xx, network,
          // schema mismatches) bubble up: an empty result for a 403 would
          // be indistinguishable from "no vulns", and the agent would
          // conclude "nothing to do" when the real problem is a
          // credential scope.
          let vulns: unknown[] = [];
          try {
            // One more than max_items tells whether the list goes on.
            vulns = await endpointVulnerabilities(client, orgId, endpoint_id, max_items + 1);
          } catch (err) {
            if (!is403or404(err)) throw err;
            warnings.push(
              `vulnerabilities endpoint returned ${err.status}; plan may be incomplete`,
            );
          }
          if (vulns.length > max_items) {
            truncated = true;
            warnings.push(
              `the endpoint has more than max_items (${max_items}) vulnerabilities; the plan covers the first ${max_items}, raise max_items for the rest`,
            );
          }
          for (const v of vulns.slice(0, max_items)) {
            const cve = vulnerabilityCveId(v);
            if (cve === undefined) continue;
            plan.push(await entry(cve, [endpoint_id], vulnerabilityPackages(v)));
          }
        }

        const note =
          "Read-only output. To act, pass candidate_packages[*].id (and version, when given) to action1_deploy_update with confirm: 'YES' and dry_run: false. Entries with correlation 'endpoint_missing_updates' list every missing update of the endpoint, not only fixes for this CVE.";
        const payload: Record<string, unknown> = { plan, note, truncated };
        const structured: Record<string, unknown> = { plan, count: plan.length, truncated };
        warnings.push(...candidates.warnings);
        if (warnings.length > 0) {
          payload.warning = warnings.join("; ");
          structured.warning = payload.warning;
        }
        return jsonResult(payload, structured, response_format);
      }),
  );
}

/**
 * Vulnerabilities of one endpoint from the documented
 * `GET /vulnerabilities/{orgId}?endpoint_id=`. When that answers 404,
 * the older per-endpoint path (not in the spec, see docs/GOTCHAS.md) is
 * tried once.
 */
async function endpointVulnerabilities(
  client: Action1Client,
  orgId: string,
  endpointId: string,
  maxItems: number,
): Promise<unknown[]> {
  try {
    return await collect(
      client.paginate<unknown>("/vulnerabilities/" + encodeURIComponent(orgId), {
        limit: 200,
        maxItems,
        query: { endpoint_id: endpointId },
      }),
    );
  } catch (err) {
    if (!(err instanceof Action1ApiError && err.status === 404)) throw err;
  }
  const legacy = await client.request<unknown>(
    "/endpoints/managed/" +
      encodeURIComponent(orgId) +
      "/" +
      encodeURIComponent(endpointId) +
      "/vulnerabilities",
  );
  return parsePageEnvelope<unknown>(legacy).items;
}

/**
 * Missing-update lookups for the remediation plan, cached per endpoint
 * (the endpoint path asks once per CVE for the same endpoint). Only a
 * 403 / 404 becomes a warning in the plan; every other failure (5xx,
 * network, 401) propagates, so an unreadable endpoint is never shown as
 * "no candidate packages".
 */
class CandidatePackages {
  readonly warnings: string[] = [];
  private readonly cache = new Map<string, unknown[]>();

  constructor(
    private readonly client: Action1Client,
    private readonly orgId: string,
  ) {}

  async forEndpoints(endpointIds: string[]): Promise<{ id: string; source: string }[]> {
    const seen = new Map<string, { id: string; source: string }>();
    for (const ep of endpointIds.slice(0, 5)) {
      for (const u of await this.missingUpdates(ep)) {
        const id = missingUpdateId(u);
        if (id !== undefined && !seen.has(id)) seen.set(id, { id, source: ep });
      }
    }
    return [...seen.values()];
  }

  private async missingUpdates(ep: string): Promise<unknown[]> {
    const cached = this.cache.get(ep);
    if (cached) return cached;
    let updates: unknown[];
    try {
      updates = await collect(
        this.client.paginate<unknown>(
          "/endpoints/managed/" +
            encodeURIComponent(this.orgId) +
            "/" +
            encodeURIComponent(ep) +
            "/missing-updates",
          { limit: 100, maxItems: 100 },
        ),
      );
    } catch (err) {
      if (is403or404(err)) {
        this.warnings.push(
          `missing-updates for endpoint ${ep} returned ${err.status}; candidate_packages may be incomplete`,
        );
        updates = [];
      } else {
        throw err;
      }
    }
    this.cache.set(ep, updates);
    return updates;
  }
}
