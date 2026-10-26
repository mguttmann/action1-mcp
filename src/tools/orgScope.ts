import { assertOrgAllowed, loadConfig, type AppConfig } from "../config.js";

// ACTION1_ALLOWED_ORG_IDS enforcement for values that do not pass
// through resolveOrgId: org ids inside request bodies and query strings
// (e.g. `target_organization_id` of a move, `organization_ids` of a
// role) and the free-form path of action1_raw_request. All checks are
// no-ops while the allowlist is empty.

// Keys are compared after lowercasing and dropping separators (`_`, `-`,
// `.`, spaces), so orgId, org_id, Org-ID, organizationId,
// organization-id and targetOrganizationId all match: an unusual
// spelling must not carry an org id past the check.
const ORG_KEY = /^(?:target)?(?:org|organi[sz]ation)ids?$/;

function isOrgKey(key: string): boolean {
  return ORG_KEY.test(key.toLowerCase().replace(/[\s_.-]+/g, ""));
}
// Far deeper than any Action1 request body (the deepest spec body names
// an org at depth 4). A body nested deeper is refused while the
// allowlist is set, because it could hide an org id from the check.
const MAX_DEPTH = 64;
// Array keys whose entries are scope objects ({type, object,
// organization_id}): settings `scope`, role `include_scope` and
// `exclude_scope`, update `scoped_approvals`.
const SCOPE_LIST_KEY = /(?:^|_)scopes?$|^scoped_/i;

class TooDeepError extends Error {
  constructor() {
    super(
      "Refusing request: the body is nested too deeply to check its organizations against ACTION1_ALLOWED_ORG_IDS.",
    );
  }
}

interface OrgFindings {
  /** Organization ids named in the payload. */
  ids: string[];
  /** Scope entries not bound to one organization (Enterprise, Group, ...). */
  unbound: string[];
}

/**
 * Throw when a body or query object names an organization outside
 * ACTION1_ALLOWED_ORG_IDS under an org id key (org_id, orgId,
 * organization_id(s), target_organization_id, ...), at any depth.
 */
export function assertPayloadOrgsAllowed(payload: unknown, cfg?: AppConfig): void {
  const found: OrgFindings = { ids: [], unbound: [] };
  let tooDeep: TooDeepError | undefined;
  try {
    collectOrgs(payload, 0, found, false);
  } catch (err) {
    if (!(err instanceof TooDeepError)) throw err;
    tooDeep = err;
  }
  // The configuration is only read when there is something to check.
  if (found.ids.length === 0 && tooDeep === undefined) return;
  const config = cfg ?? loadConfig();
  if (config.allowedOrgIds.length === 0) return;
  if (tooDeep) throw tooDeep;
  for (const id of found.ids) assertOrgAllowed(id, config);
}

function collectOrgs(value: unknown, depth: number, out: OrgFindings, inScopeList: boolean): void {
  if (value === null || typeof value !== "object") return;
  if (depth > MAX_DEPTH) throw new TooDeepError();
  if (Array.isArray(value)) {
    for (const v of value) collectOrgs(v, depth + 1, out, inScopeList);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (inScopeList) noteScopeEntry(obj, out);
  for (const [key, v] of Object.entries(obj)) {
    if (isOrgKey(key)) {
      for (const id of Array.isArray(v) ? v : [v]) {
        if (typeof id === "string" || typeof id === "number") out.ids.push(String(id));
      }
    } else {
      collectOrgs(v, depth + 1, out, Array.isArray(v) && SCOPE_LIST_KEY.test(key));
    }
  }
}

// Scope types whose entries the spec binds to one organization through
// organization_id (RolePermissionScope: "Supported for Report and
// AdvancedSettingTemplate scopes"). Organization entries are bound by
// their own org id.
const ORG_ID_BOUND_TYPE = /^(?:organization|report|advancedsettingtemplate)$/i;

/**
 * One scope entry ({type, object, organization_id}). Type Organization
 * names its org in `object` (settings, roles) or `organization_id`
 * (update approvals). Report and AdvancedSettingTemplate entries are
 * bound to an organization only when they carry organization_id. Any
 * other type (Enterprise, Group, AdHocScript, a missing type) is never
 * bound, even with an organization_id: the spec gives those entries no
 * such field, so it would not limit them to one organization.
 */
function noteScopeEntry(entry: Record<string, unknown>, out: OrgFindings): void {
  const type = typeof entry.type === "string" ? entry.type : "";
  if (/^organization$/i.test(type) && typeof entry.object === "string" && entry.object !== "") {
    out.ids.push(entry.object);
    return;
  }
  const orgKey = Object.keys(entry).find((k) => isOrgKey(k));
  const hasOrg = orgKey !== undefined && entry[orgKey] !== undefined && entry[orgKey] !== null;
  if (hasOrg && ORG_ID_BOUND_TYPE.test(type)) return;
  out.unbound.push(type === "" ? "a scope entry without type" : `a ${type} scope entry`);
}

/**
 * ACTION1_ALLOWED_ORG_IDS for one state-changing request, applied by the
 * destructive guard to every guarded call (curated, generated and raw):
 *
 * - every organization the body names, at any depth, under an org id key
 *   or in a scope entry, must be allowed (also with
 *   ACTION1_ALLOW_ENTERPRISE_OPS);
 * - the request must be bound to an allowed organization: its path must
 *   contain an allowed org id, and every scope entry must name an
 *   organization. Enterprise-wide mutations (paths such as /settings/all,
 *   /scripts/all, /roles, /enterprise, Enterprise or Group scope entries)
 *   fail closed unless ACTION1_ALLOW_ENTERPRISE_OPS is on.
 *
 * No-op while the allowlist is empty and for GET/HEAD.
 */
export function assertMutationOrgScope(
  request: { method: string; path: string; body?: unknown },
  cfg: AppConfig = loadConfig(),
): void {
  if (cfg.allowedOrgIds.length === 0) return;
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return;
  const found: OrgFindings = { ids: [], unbound: [] };
  collectOrgs(request.body, 0, found, false);
  for (const id of found.ids) assertOrgAllowed(id, cfg);
  if (cfg.allowEnterpriseOps) return;
  const pathOnly = request.path.split(/[?#]/, 1)[0] ?? "";
  const pathBound = pathOnly.split("/").some((seg) => {
    try {
      return cfg.allowedOrgIds.includes(decodeURIComponent(seg).toLowerCase());
    } catch {
      return false;
    }
  });
  const reasons = [...(pathBound ? [] : ["its path names no allowed organization"])];
  if (found.unbound.length > 0) reasons.push(`the body contains ${found.unbound[0]}`);
  if (reasons.length === 0) return;
  throw new Error(
    `Refusing ${method} ${pathOnly}: ACTION1_ALLOWED_ORG_IDS is set and this change is not bound to an allowed organization (${reasons.join("; ")}), so it could affect other organizations. The operator can allow enterprise-wide changes with ACTION1_ALLOW_ENTERPRISE_OPS=true.`,
  );
}

/** An OpenAPI path template such as `/endpoints/managed/{orgId}`. */
export interface PathTemplate {
  path: string;
}

function templateRegex(template: string): { re: RegExp; params: string[] } {
  const params: string[] = [];
  const pattern = template
    .split("/")
    .map((seg) => {
      const m = /^\{([^}]+)\}$/.exec(seg);
      if (m) {
        params.push(m[1]!);
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { re: new RegExp(`^${pattern}$`, "i"), params };
}

/**
 * Check the org id of a free-form API path against
 * ACTION1_ALLOWED_ORG_IDS by matching it against the documented path
 * templates. While the allowlist is set, a path that matches no
 * documented template is refused, because its org cannot be checked.
 */
export function assertPathOrgAllowed(
  path: string,
  templates: readonly PathTemplate[],
  cfg: AppConfig = loadConfig(),
): void {
  if (cfg.allowedOrgIds.length === 0) return;
  const pathOnly = path.split(/[?#]/, 1)[0] ?? "";
  let matched = false;
  for (const t of templates) {
    const { re, params } = templateRegex(t.path);
    const m = re.exec(pathOnly);
    if (!m) continue;
    matched = true;
    const idx = params.indexOf("orgId");
    if (idx >= 0) assertOrgAllowed(decodeURIComponent(m[idx + 1]!), cfg);
  }
  if (!matched) {
    throw new Error(
      `Refusing path ${JSON.stringify(pathOnly)}: ACTION1_ALLOWED_ORG_IDS is set, so action1_raw_request only reaches documented Action1 API paths whose organization can be checked.`,
    );
  }
}
