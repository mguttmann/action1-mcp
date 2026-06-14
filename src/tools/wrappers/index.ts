import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Action1Client } from "../../client/action1Client.js";
import { resolveOrgId } from "../../config.js";
import { collect } from "../../client/pagination.js";
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
  singleObjectOutputShape,
} from "../helpers.js";
import { capItemList } from "../../utils/capOutput.js";
import { fingerprintQuery, pagedFetch } from "../../utils/cursor.js";
import { Action1ApiError } from "../../client/errors.js";

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
      description: "Look up an endpoint group by name or UUID using exact-id/exact-name/starts-with/contains.",
      inputSchema: {
        ...orgIdShape,
        ...formatShape,
        query: z.string().min(1).describe("Group name fragment or UUID."),
      },
      outputSchema: singleObjectOutputShape,
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
          .filter((g): g is { id: string; name: string } =>
            typeof g.id === "string" && typeof g.name === "string",
          )
          .map((g) => ({ id: g.id, name: g.name }));
        const { matches, how } = fuzzyFind(typed, query);
        return jsonResult(
          { match_strategy: how, matches, total_groups: typed.length },
          { match_strategy: how, matches, total_groups: typed.length },
          response_format,
        );
      }),
  );
}

function registerSoftwareInventoryForEndpoint(
  server: McpServer,
  client: Action1Client,
): void {
  server.registerTool(
    "action1_software_inventory_for_endpoint",
    {
      title: "List installed software for an endpoint",
      description: "Fetch installed-software inventory for one endpoint, with optional name substring filter.",
      inputSchema: {
        ...orgIdShape,
        ...cursorInputShape,
        ...formatShape,
        endpoint_id: endpointIdSchema,
        find_by_name: z
          .string()
          .optional()
          .describe("Substring filter on application name."),
      },
      outputSchema: cursorListOutputShape,
      annotations: READONLY_ANNOTATIONS,
    },
    async ({ org_id, cursor, endpoint_id, find_by_name, limit, response_format }) =>
      runTool(async () => {
        const orgId = resolveOrgId(org_id);
        const fp = fingerprintQuery({ orgId, endpoint_id, find_by_name: find_by_name ?? "" });
        const lc = find_by_name?.toLowerCase();
        const result = await pagedFetch<unknown>(
          async ({ from, limit: pageLimit }) => {
            const raw = (await client.request<unknown>(
              "/installed-software/" +
                encodeURIComponent(orgId) +
                "/data/" +
                encodeURIComponent(endpoint_id),
              { query: { limit: pageLimit, from } },
            )) as { items?: unknown[] } | unknown[];
            const items = Array.isArray(raw) ? raw : (raw.items ?? []);
            const filtered = lc
              ? items.filter((it) => {
                  if (!it || typeof it !== "object") return false;
                  const obj = it as Record<string, unknown>;
                  const name =
                    (typeof obj.name === "string" ? obj.name : undefined) ??
                    (typeof obj.display_name === "string" ? obj.display_name : undefined) ??
                    (typeof obj.product_name === "string" ? obj.product_name : undefined);
                  return name ? name.toLowerCase().includes(lc) : false;
                })
              : items;
            return { items: filtered, hasMore: items.length === pageLimit };
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
}

function registerRecurringSchedules(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_recurring_schedules",
    {
      title: "List recurring automation schedules (read)",
      description: "List recurring automations with optional client-side filters (status, template_id, group id substring).",
      inputSchema: {
        ...orgIdShape,
        ...cursorInputShape,
        ...formatShape,
        active_only: z
          .boolean()
          .optional()
          .describe("Drop paused/disabled schedules."),
        template_id: z
          .string()
          .optional()
          .describe("Filter by first action template_id."),
        group_id_substring: z
          .string()
          .optional()
          .describe("Filter by target group id substring."),
      },
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
          const obj = it as Record<string, unknown>;
          if (active_only) {
            const status =
              typeof obj.status === "string"
                ? obj.status
                : typeof obj.settings === "string"
                  ? obj.settings
                  : undefined;
            if (status && /(paused|disabled|stopped)/i.test(status)) return false;
          }
          if (template_id) {
            const actions = obj.actions as Array<Record<string, unknown>> | undefined;
            const ids = (actions ?? []).map((a) => a.template_id);
            if (!ids.includes(template_id)) return false;
          }
          if (group_id_substring) {
            const eps = obj.endpoints as Array<Record<string, unknown>> | undefined;
            const matches = (eps ?? []).some(
              (e) =>
                typeof e.id === "string" &&
                e.id.includes(group_id_substring) &&
                e.type === "EndpointGroup",
            );
            if (!matches) return false;
          }
          return true;
        };
        const result = await pagedFetch<unknown>(
          async ({ from, limit: pageLimit }) => {
            const raw = (await client.request<unknown>(
              "/automations/schedules/" + encodeURIComponent(orgId),
              { query: { limit: pageLimit, from } },
            )) as { items?: unknown[] } | unknown[];
            const items = Array.isArray(raw) ? raw : (raw.items ?? []);
            return { items: items.filter(matchesFilters), hasMore: items.length === pageLimit };
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
}

function registerAuditLogSearch(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_audit_log_search",
    {
      title: "Search the audit log",
      description: "Search /audit/events with optional time range and client-side substring filters.",
      inputSchema: {
        ...cursorInputShape,
        ...formatShape,
        from_time: z
          .string()
          .datetime()
          .optional()
          .describe("ISO-8601 lower bound."),
        to_time: z
          .string()
          .datetime()
          .optional()
          .describe("ISO-8601 upper bound."),
        user_substring: z
          .string()
          .optional()
          .describe("Filter by user."),
        event_type_substring: z
          .string()
          .optional()
          .describe("Filter by event_type."),
        target_substring: z
          .string()
          .optional()
          .describe("Filter by target."),
      },
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
        const fromMs = args.from_time ? Date.parse(args.from_time) : undefined;
        const toMs = args.to_time ? Date.parse(args.to_time) : undefined;
        const timeFilterActive = fromMs !== undefined || toMs !== undefined;
        const userLc = args.user_substring?.toLowerCase();
        const typeLc = args.event_type_substring?.toLowerCase();
        const targetLc = args.target_substring?.toLowerCase();
        // Pass-N audit: when a time filter is active and a record's
        // timestamp is unparseable, the previous implementation let it
        // through (`!Number.isNaN(ts) && ts < fromMs` short-circuited
        // to "no match" on NaN). That meant unparseable items bypassed
        // the time window silently. We now drop them AND surface a
        // counter so the agent can detect upstream timestamp regressions.
        let droppedUnparseableTimestamps = 0;
        const matchesFilters = (it: unknown): boolean => {
          if (!it || typeof it !== "object") return false;
          const obj = it as Record<string, unknown>;
          const ts =
            typeof obj.time === "string"
              ? Date.parse(obj.time)
              : typeof obj.timestamp === "string"
                ? Date.parse(obj.timestamp)
                : NaN;
          if (timeFilterActive && Number.isNaN(ts)) {
            droppedUnparseableTimestamps += 1;
            return false;
          }
          if (fromMs !== undefined && ts < fromMs) return false;
          if (toMs !== undefined && ts > toMs) return false;
          const matchString = (key: string, lc: string | undefined): boolean => {
            if (!lc) return true;
            const v = obj[key];
            return typeof v === "string" && v.toLowerCase().includes(lc);
          };
          if (!matchString("user", userLc)) return false;
          if (!matchString("event_type", typeLc)) return false;
          if (!matchString("target", targetLc)) return false;
          return true;
        };
        const result = await pagedFetch<unknown>(
          async ({ from, limit: pageLimit }) => {
            const raw = (await client.request<unknown>("/audit/events", {
              query: { limit: pageLimit, from },
            })) as { items?: unknown[] } | unknown[];
            const items = Array.isArray(raw) ? raw : (raw.items ?? []);
            return { items: items.filter(matchesFilters), hasMore: items.length === pageLimit };
          },
          {
            ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
            fingerprint: fp,
            ...(args.limit !== undefined ? { maxItems: args.limit } : {}),
          },
        );
        const base = pagedListResult(result, args.response_format);
        if (droppedUnparseableTimestamps > 0 && base.structuredContent) {
          // Surface the drop-counter both in structuredContent (where
          // schema-aware hosts inspect it) and in the text block (so
          // non-structured hosts still see it). The pagedListResult
          // already serialised the text block, so we re-serialise from
          // the patched structuredContent to keep both in sync.
          const sc = base.structuredContent as Record<string, unknown>;
          sc.dropped_unparseable_timestamps = droppedUnparseableTimestamps;
          const first = base.content?.[0];
          if (first && first.type === "text") {
            // Best-effort: re-emit a JSON serialisation of the patched
            // structured payload. For markdown output the patched
            // counter ends up as a JSON dump instead of a table; that's
            // a deliberate trade-off — the counter is a fault-detection
            // signal that takes precedence over rendering polish.
            first.text = JSON.stringify(sc);
          }
        }
        return base;
      }),
  );
}

function registerReportExport(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_report_export",
    {
      title: "Run a report and return its data or CSV export",
      description: "Resolve a report by name or UUID, then return JSON rows or a CSV export blob.",
      inputSchema: {
        ...orgIdShape,
        ...formatShape,
        report: z.string().min(1).describe("Report id or name fragment."),
        format: z
          .enum(["json", "csv"])
          .default("json")
          .describe("'json' rows or 'csv' blob."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .describe("Max rows when format='json'."),
      },
      outputSchema: singleObjectOutputShape,
      annotations: READONLY_ANNOTATIONS,
    },
    async ({ org_id, report, format, limit, response_format }) =>
      runTool(async () => {
        const orgId = resolveOrgId(org_id);
        let reportId = report;
        if (!UUID_RE.test(report)) {
          const reports = await collect(client.paginate<unknown>("/reports/all", { limit: 100 }));
          const typed = reports
            .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
            .filter((r): r is { id: string; name: string } & Record<string, unknown> =>
              typeof r.id === "string" && typeof r.name === "string",
            )
            .map((r) => ({ id: r.id, name: r.name }));
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
            "/reportdata/" + encodeURIComponent(orgId) + "/" + encodeURIComponent(reportId) + "/export",
          );
          const csvTextRaw = typeof data === "string" ? data : JSON.stringify(data);
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
        const items = await collect(
          client.paginate<unknown>(
            "/reportdata/" + encodeURIComponent(orgId) + "/" + encodeURIComponent(reportId) + "/data",
            { limit: 200, ...(limit !== undefined ? { maxItems: limit } : {}) },
          ),
        );
        const cap = capItemList(items as Record<string, unknown>[]);
        const payload: Record<string, unknown> = {
          format: "json",
          report_id: reportId,
          items: cap.items,
          count: cap.returned,
          total: cap.total,
        };
        if (cap.truncated > 0) {
          payload.truncated = cap.truncated;
          payload.note =
            "Output truncated to fit the 1 MB host limit. Use format='csv' for a single string export, or pass `limit` for a smaller subset.";
        }
        return jsonResult(payload, payload, response_format);
      }),
  );
}

function registerCveRemediationPlan(server: McpServer, client: Action1Client): void {
  server.registerTool(
    "action1_cve_remediation_plan",
    {
      title: "Build a remediation plan for a CVE or an endpoint (read-only)",
      description: "Read-only correlation of vulnerabilities and missing updates. Does NOT execute; pass the result to action1_deploy_update.",
      inputSchema: {
        ...orgIdShape,
        ...formatShape,
        cve_id: z.string().optional().describe("Plan for one CVE id."),
        endpoint_id: endpointIdSchema.optional().describe("Plan for one endpoint."),
        max_items: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(50)
          .describe("Max plan entries."),
      },
      outputSchema: singleObjectOutputShape,
      annotations: READONLY_ANNOTATIONS,
    },
    async ({ org_id, cve_id, endpoint_id, max_items, response_format }) =>
      runTool(async () => {
        const orgId = resolveOrgId(org_id);
        if (!cve_id && !endpoint_id) {
          return errorResult("Pass either cve_id or endpoint_id.");
        }
        const plan: {
          cve: string;
          affected_endpoints: string[];
          candidate_packages: { id: string; source: string }[];
        }[] = [];

        if (cve_id) {
          const epList = await collect(
            client.paginate<unknown>(
              "/vulnerabilities/" +
                encodeURIComponent(orgId) +
                "/" +
                encodeURIComponent(cve_id) +
                "/endpoints",
              { limit: 200, maxItems: max_items },
            ),
          );
          const affected = epList
            .map((e) => (e && typeof e === "object" ? (e as Record<string, unknown>).id : undefined))
            .filter((v): v is string => typeof v === "string");
          const packages = await collectCandidatePackages(client, orgId, affected.slice(0, 10));
          plan.push({ cve: cve_id, affected_endpoints: affected, candidate_packages: packages });
        }

        let vulnerabilitiesWarning: string | undefined;
        if (endpoint_id) {
          // Only swallow auth/missing-endpoint errors (403 / 404) and
          // surface them as a warning. Other errors (5xx, network,
          // schema mismatches) need to bubble up — the previous
          // blanket `.catch(() => ({ items: [] }))` made a 403 visually
          // indistinguishable from "no vulns" and caused the agent to
          // emit an empty plan for an endpoint it actually couldn't
          // read. The agent then concluded "nothing to do" when the
          // real problem was a credential scope.
          let vulnsRaw: { items?: unknown[] } = { items: [] };
          try {
            vulnsRaw = await client.request<{ items?: unknown[] }>(
              "/endpoints/managed/" +
                encodeURIComponent(orgId) +
                "/" +
                encodeURIComponent(endpoint_id) +
                "/vulnerabilities",
            );
          } catch (err) {
            if (
              err instanceof Action1ApiError &&
              (err.status === 403 || err.status === 404)
            ) {
              vulnerabilitiesWarning = `vulnerabilities endpoint returned ${err.status}; plan may be incomplete`;
              vulnsRaw = { items: [] };
            } else {
              throw err;
            }
          }
          const cveIds = (vulnsRaw.items ?? [])
            .map((v) =>
              v && typeof v === "object" ? (v as Record<string, unknown>).cve_id : undefined,
            )
            .filter((v): v is string => typeof v === "string")
            .slice(0, max_items);
          for (const cve of cveIds) {
            const packages = await collectCandidatePackages(client, orgId, [endpoint_id]);
            plan.push({
              cve,
              affected_endpoints: [endpoint_id],
              candidate_packages: packages,
            });
          }
        }

        const note =
          "Read-only output. To act, pass candidate_packages[*].id to action1_deploy_update with confirm: 'YES' and dry_run: false.";
        const payload: Record<string, unknown> = { plan, note };
        const structured: Record<string, unknown> = { plan, count: plan.length };
        if (vulnerabilitiesWarning !== undefined) {
          payload.warning = vulnerabilitiesWarning;
          structured.warning = vulnerabilitiesWarning;
        }
        return jsonResult(payload, structured, response_format);
      }),
  );
}

async function collectCandidatePackages(
  client: Action1Client,
  orgId: string,
  endpointIds: string[],
): Promise<{ id: string; source: string }[]> {
  const seen = new Map<string, { id: string; source: string }>();
  for (const ep of endpointIds.slice(0, 5)) {
    try {
      const updates = await collect(
        client.paginate<unknown>(
          "/endpoints/managed/" +
            encodeURIComponent(orgId) +
            "/" +
            encodeURIComponent(ep) +
            "/missing-updates",
          { limit: 100, maxItems: 100 },
        ),
      );
      for (const u of updates) {
        if (u && typeof u === "object") {
          const obj = u as Record<string, unknown>;
          if (typeof obj.id === "string" && !seen.has(obj.id)) {
            seen.set(obj.id, { id: obj.id, source: ep });
          }
        }
      }
    } catch {
      // best-effort
    }
  }
  return [...seen.values()];
}

/**
 * Defuse Excel / spreadsheet formula-injection in a CSV blob. Any cell
 * whose first non-whitespace character is one of `= + - @ TAB CR` is
 * interpreted as a formula by Excel, Google Sheets, etc. Prefixing
 * with a single quote (`'`) is the conventional CSV-injection defence
 * — Excel honours it as a literal-text marker on import.
 *
 * Implementation notes:
 *   - Pass-2 audit found: `"  =cmd|x"` (leading whitespace) bypassed
 *     the original `^[=+\-@\t\r]` regex because Excel ignores leading
 *     whitespace before formula chars. Same for NBSP and other
 *     Unicode whitespace. We now check the trimmed content.
 *   - Pass-2 audit also found: `-100` and `+44 1234` were flagged as
 *     formulas, corrupting valid numeric / phone data. We restrict
 *     `+`/`-` triggering to cases where the *next* char is also a
 *     formula-trigger (`=`, `+`, etc.) or a function-name letter, not
 *     a digit. Negative numbers and phone numbers therefore pass
 *     through unchanged.
 *   - RFC-4180 quoting is partially supported: a leading `"` opens a
 *     quoted cell that may contain commas. We do a slightly smarter
 *     split that respects quotes; full embedded-CRLF handling is out
 *     of scope (Action1's exports are line-oriented).
 */
export function sanitizeCsvFormulas(csv: string): string {
  if (!csv) return csv;
  return csv
    .split("\n")
    .map((line) => splitCsvLineRespectingQuotes(line).map(sanitizeCell).join(","))
    .join("\n");
}

const FORMULA_HAZARD_FIRST = /[=@\t\r]/;
const FORMULA_HAZARD_PLUS_MINUS = /[+\-]/;

function isHazardousCell(inner: string): boolean {
  // Trim leading whitespace (incl. NBSP / ZWSP / RTL marks).
  const trimmed = inner.replace(/^[\s ​‎‏]+/, "");
  if (!trimmed) return false;
  // Pass-3 audit: an embedded CR / LF followed by a formula-trigger
  // can be re-interpreted by Excel as a soft-newline that starts a
  // fresh formula — flag even when the first char is benign.
  if (/[\r\n][=+\-@]/.test(trimmed)) return true;
  const first = trimmed.charAt(0);
  if (FORMULA_HAZARD_FIRST.test(first)) return true;
  if (FORMULA_HAZARD_PLUS_MINUS.test(first)) {
    // `+`/`-` is hazardous only if it isn't followed by a digit /
    // dot / space (numeric / phone-number pattern). I.e.
    // `+cmd`/`-=cmd`/`-+1` are formulas; `+44`/`-100`/`-1.5e3`/`+ 7`
    // are data.
    const next = trimmed.charAt(1);
    return Boolean(next) && !/[0-9. ]/.test(next);
  }
  return false;
}

function sanitizeCell(cell: string): string {
  if (!cell) return cell;
  const isQuoted = cell.length >= 2 && cell.startsWith('"') && cell.endsWith('"');
  const inner = isQuoted ? cell.slice(1, -1) : cell;
  if (isHazardousCell(inner)) {
    const safe = "'" + inner;
    return isQuoted ? `"${safe}"` : safe;
  }
  return cell;
}

/**
 * Split a CSV line on commas while respecting double-quoted cells. A
 * `""` inside a quoted cell is the RFC-4180 escape for a literal `"`.
 * This is intentionally simpler than a full CSV parser — embedded
 * CRLF is not handled, but Action1's exports never contain it in
 * practice.
 */
function splitCsvLineRespectingQuotes(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line.charAt(i);
    if (inQuote) {
      if (c === '"' && line.charAt(i + 1) === '"') {
        current += '""';
        i += 1;
      } else if (c === '"') {
        inQuote = false;
        current += c;
      } else {
        current += c;
      }
    } else if (c === '"') {
      inQuote = true;
      current += c;
    } else if (c === ",") {
      cells.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  cells.push(current);
  return cells;
}
