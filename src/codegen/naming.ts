// Verb-first tool-naming heuristic for the Action1 codegen.
//
// Action1's OpenAPI operationIds are path-shaped (e.g. `endpoints_managed`,
// `endpoints_managed_endpointId`). Snake-casing them produces noun-first
// names (`action1_endpoints_managed_endpoint_id`) instead of this server's
// `action1_<verb>_<resource>` rule (tests/unit/naming.test.ts).
//
// This module re-derives a verb-first name from `(method, path)` instead.
// The heuristic is intentionally conservative: when in doubt, fall back
// to a longer form rather than collide with another tool.

const SCOPE_PARAMS = new Set(["orgId", "orgIdOrAll"]);

// Path segments that are pure namespacing (`/data-sources/all`,
// `/endpoints/managed/{orgId}`) - they don't carry resource semantics
// and should be transparent to naming.
const NAMESPACE_NAMES = new Set(["all", "managed", "custom"]);

// When a literal segment trails a path-id parameter, it's almost always
// either an action verb (`/{id}/move`) or a sub-collection name
// (`/{id}/versions`). This set distinguishes the verbs.
const ACTION_VERBS = new Set([
  "move",
  "clone",
  "stop",
  "start",
  "requery",
  "export",
  "drilldown",
  "upload",
  "revoke_closure",
  "request_closure",
  "match_conflicts",
]);

// Generic-sounding leaf words that benefit from a parent-path qualifier
// when standing alone as a collection (e.g. `/x/{orgId}/data` - the
// "data" alone is meaningless; we prefer "x_data").
const GENERIC_LEAF = new Set([
  "data",
  "errors",
  "events",
  "export",
  "quote",
  "trial",
  "custom",
  "all",
  "requery",
  "revoke_closure",
  "request_closure",
]);

// Action1 uses some words that don't follow standard English plural
// rules; encode them explicitly.
const IRREGULAR: Record<string, [string, string]> = {
  // [singular, plural]
  me: ["me", "me"],
  search: ["search", "search"],
  status: ["status", "statuses"],
  enterprise: ["enterprise", "enterprises"],
  data: ["data", "data"],
  software_repository: ["software_repository", "software_repository"],
  software: ["software", "software"],
  reportdata: ["report_data", "report_data"],
  oauth2: ["oauth2", "oauth2"],
  subscription: ["subscription", "subscriptions"],
  permissions: ["permission", "permissions"],
  installed_software: ["installed_software", "installed_software"],
};

export function toSnake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase()
    .replace(/__+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function splitSingularPlural(seg: string): [string, string] {
  const sn = toSnake(seg);
  if (sn in IRREGULAR) return IRREGULAR[sn]!;
  if (sn.endsWith("ies") && sn.length > 3) return [sn.slice(0, -3) + "y", sn];
  if (sn.endsWith("sses")) return [sn.slice(0, -2), sn];
  if (sn.endsWith("xes") && !sn.endsWith("axes")) return [sn.slice(0, -2), sn];
  if (sn.endsWith("us") || sn.endsWith("ss")) return [sn, sn];
  if (sn.endsWith("s") && sn.length > 1 && !sn.endsWith("us")) return [sn.slice(0, -1), sn];
  return [sn, sn + "s"];
}

function isParam(seg: string): boolean {
  return seg.startsWith("{") && seg.endsWith("}");
}

function paramName(seg: string): string {
  return seg.slice(1, -1);
}

function resourceFromParam(p: string): string {
  let n = p.replace(/(_id|Id|_ID)$/, "");
  n = n.replace(/(_or_all|OrAll)$/, "");
  const sn = toSnake(n);
  // Generic param names like "id", "type", "name", "key" don't carry
  // resource semantics; let the caller substitute a parent literal.
  if (sn === "" || sn === "id" || sn === "type" || sn === "name" || sn === "key") {
    return "";
  }
  return splitSingularPlural(sn)[0];
}

/** Avoid stutters like "package_packages" or "endpoint_endpoint". */
function joinAvoidStutter(prefix: string, suffix: string): string {
  if (!prefix) return suffix;
  if (!suffix) return prefix;
  if (suffix.startsWith(prefix + "_") || suffix === prefix) return suffix;
  if (prefix.endsWith("_" + suffix) || prefix === suffix) return prefix;
  // Singular-form stutter: prefix=package, suffix=packages
  const [pSing] = splitSingularPlural(prefix);
  const [sSing, sPlur] = splitSingularPlural(suffix);
  if (pSing === sSing) return suffix;
  if (suffix === sPlur && prefix === sSing) return suffix;
  return prefix + "_" + suffix;
}

/**
 * For paths like `/automations/schedules/{}/{automationId}`, the parent
 * literal "automations" matches the resource "automation" (from the param)
 * - that's a stutter. The disambiguator is the *second* meaningful
 * literal ("schedules" -> "schedule"). Returns null when no second-tier
 * literal exists.
 */
function secondaryDisambiguator(
  meaningfulLiterals: string[],
  excludeResource: string,
): string | null {
  for (let i = 1; i < meaningfulLiterals.length; i += 1) {
    const lit = meaningfulLiterals[i]!;
    const [sing] = splitSingularPlural(lit);
    if (sing !== excludeResource) return sing;
  }
  // Even the leaf literal can serve when meaningful_literals.length===1
  // and it's the same word (e.g. "/automations" only) - give up.
  return null;
}

interface NameContext {
  segs: string[];
  literalSegs: string[];
  meaningfulLiterals: string[]; // literals with NAMESPACE_NAMES filtered
  lastSeg: string;
  lastIsParam: boolean;
  lastParamName: string | null;
  lastIsScope: boolean;
  lastLit: string | null;
  secondToLastIsParam: boolean;
  // Last non-scope param in the path (the "resource id" we're addressing).
  lastResourceIdParam: string | null;
  // Second-to-last non-scope param (the immediate parent resource).
  secondLastResourceIdParam: string | null;
}

function buildContext(path: string): NameContext {
  const segs = path.replace(/^\/+|\/+$/g, "").split("/");
  const literalSegs = segs.filter((s) => !isParam(s)).map(toSnake);
  const meaningfulLiterals = literalSegs.filter((s) => !NAMESPACE_NAMES.has(s));
  const lastSeg = segs[segs.length - 1] ?? "";
  const lastIsParam = isParam(lastSeg);
  const lastParamName = lastIsParam ? paramName(lastSeg) : null;
  const lastIsScope = lastIsParam && lastParamName != null && SCOPE_PARAMS.has(lastParamName);
  const lastLit = !lastIsParam ? toSnake(lastSeg) : null;
  const secondToLastSeg = segs.length >= 2 ? segs[segs.length - 2]! : "";
  const secondToLastIsParam = isParam(secondToLastSeg);

  let lastResourceIdParam: string | null = null;
  let secondLastResourceIdParam: string | null = null;
  for (let i = segs.length - 1; i >= 0; i -= 1) {
    const s = segs[i]!;
    if (!isParam(s)) continue;
    const n = paramName(s);
    if (SCOPE_PARAMS.has(n)) continue;
    if (lastResourceIdParam === null) {
      lastResourceIdParam = n;
    } else if (secondLastResourceIdParam === null) {
      secondLastResourceIdParam = n;
      break;
    }
  }
  return {
    segs,
    literalSegs,
    meaningfulLiterals,
    lastSeg,
    lastIsParam,
    lastParamName,
    lastIsScope,
    lastLit,
    secondToLastIsParam,
    lastResourceIdParam,
    secondLastResourceIdParam,
  };
}

function deriveBaseName(method: string, ctx: NameContext, prefixParent: boolean): string {
  const {
    segs,
    meaningfulLiterals,
    lastIsParam,
    lastParamName,
    lastIsScope,
    lastLit,
    secondToLastIsParam,
    lastResourceIdParam,
  } = ctx;

  // CASE: empty path
  if (segs.length === 0 || (segs.length === 1 && segs[0] === "")) {
    return "list_resources";
  }

  // Helper: parent qualifier - first meaningful literal as singular.
  function parentQualifier(): string | null {
    if (meaningfulLiterals.length === 0) return null;
    return splitSingularPlural(meaningfulLiterals[0]!)[0];
  }

  // Helper: stronger disambiguator. Walks ALL meaningful literals and
  // returns a singular-form path (joined with `_`). Used when the simple
  // parentQualifier collides with the resource (e.g.
  // `/automations/schedules/{}/{automationId}` and
  // `/automations/instances/{}/{automationId}` both have parent
  // "automation" - but their second-tier literals "schedules" vs
  // "instances" set them apart).
  function fullPathQualifier(excludeResource: string): string | null {
    const parts = meaningfulLiterals
      .map((s) => splitSingularPlural(s)[0])
      .filter((s) => s !== excludeResource);
    if (parts.length === 0) return null;
    return parts.join("_");
  }

  // CASE 1: path ends in scope param (orgId, orgIdOrAll). The resource is
  // a collection within that org; figure it out from meaningful literals.
  if (lastIsScope) {
    if (meaningfulLiterals.length === 0) return "list_resources";
    let coll: string;
    if (meaningfulLiterals.length === 1) {
      coll = meaningfulLiterals[0]!;
    } else {
      const parent = meaningfulLiterals[0]!;
      const leaf = meaningfulLiterals[meaningfulLiterals.length - 1]!;
      if (parent !== leaf) {
        const pSing = splitSingularPlural(parent)[0];
        coll = leaf.startsWith(pSing) ? leaf : `${pSing}_${leaf}`;
      } else {
        coll = leaf;
      }
    }
    const [sing, plur] = splitSingularPlural(coll);
    return verbForCollection(method, sing, plur);
  }

  // CASE 2: ends in a real resource-id param (e.g. endpointId, packageId).
  if (lastIsParam && lastParamName !== null && !SCOPE_PARAMS.has(lastParamName)) {
    let baseRes = resourceFromParam(lastParamName);
    if (!baseRes) {
      // Generic param ("{id}", "{type}"); fall back to the closest
      // meaningful literal as the resource name.
      const fallback =
        meaningfulLiterals.length > 0
          ? splitSingularPlural(meaningfulLiterals[meaningfulLiterals.length - 1]!)[0]
          : "resource";
      baseRes = fallback;
    } else if (meaningfulLiterals.length > 0) {
      // When the parent literal is more descriptive than the param-derived
      // resource (e.g. `/CVE-descriptions/{cveId}` → param resource "cve"
      // but parent literal "cve_descriptions" → use "cve_description"),
      // prefer the literal.
      const lastLitSing = splitSingularPlural(
        meaningfulLiterals[meaningfulLiterals.length - 1]!,
      )[0];
      if (lastLitSing.includes(baseRes) && lastLitSing !== baseRes) {
        baseRes = lastLitSing;
      }
    }
    let res = baseRes;
    if (prefixParent) {
      const pq = parentQualifier();
      if (pq) {
        const candidate = joinAvoidStutter(pq, res);
        if (candidate === res) {
          // Stutter (parent matches resource) - disambiguate by appending
          // the *kind* literal (e.g. "schedule" or "instance" for an
          // /automations/schedules/{}/{automationId} path).
          const kind = secondaryDisambiguator(meaningfulLiterals, baseRes);
          if (kind) res = `${baseRes}_${kind}`;
        } else {
          res = candidate;
        }
      }
    }
    return verbForResource(method, res);
  }

  // CASE 3 & 4: literal trail after a non-scope param (i.e. action verb or
  // sub-collection).
  if (!lastIsParam && secondToLastIsParam && lastLit !== null) {
    if (ACTION_VERBS.has(lastLit)) {
      let res = lastResourceIdParam !== null ? resourceFromParam(lastResourceIdParam) : null;
      if (res === null) {
        // No resource-id; fall back to first meaningful literal
        const mfl = meaningfulLiterals[0] ?? "resource";
        res = splitSingularPlural(mfl)[0];
      }
      const baseRes = res;
      if (prefixParent) {
        const pq = parentQualifier();
        if (pq) {
          const candidate = joinAvoidStutter(pq, res);
          if (candidate === res) {
            const full = fullPathQualifier(baseRes);
            if (full) res = joinAvoidStutter(full, res);
          } else {
            res = candidate;
          }
        }
      }
      return verbForAction(method, lastLit, res);
    }
    // Sub-collection
    let [subSing, subPlur] = splitSingularPlural(lastLit);
    const parent = lastResourceIdParam !== null ? resourceFromParam(lastResourceIdParam) : null;
    if (parent) {
      subSing = joinAvoidStutter(parent, subSing);
      subPlur = joinAvoidStutter(parent, subPlur);
    } else if (
      // No real resource-id parent (only orgId scope) and the leaf is
      // generic (e.g. "data", "errors") - pull the first meaningful
      // literal in for context.
      GENERIC_LEAF.has(lastLit) &&
      meaningfulLiterals.length >= 1 &&
      meaningfulLiterals[0] !== lastLit
    ) {
      const ctx = splitSingularPlural(meaningfulLiterals[0]!)[0];
      if (!subSing.startsWith(ctx)) {
        subSing = `${ctx}_${subSing}`;
        subPlur = `${ctx}_${subPlur}`;
      }
    }
    if (prefixParent) {
      const pq = parentQualifier();
      if (pq && !subSing.startsWith(pq + "_") && pq !== subSing) {
        const candS = joinAvoidStutter(pq, subSing);
        const candP = joinAvoidStutter(pq, subPlur);
        if (candS === subSing && candP === subPlur) {
          const full = fullPathQualifier(subSing);
          if (full) {
            subSing = joinAvoidStutter(full, subSing);
            subPlur = joinAvoidStutter(full, subPlur);
          }
        } else {
          subSing = candS;
          subPlur = candP;
        }
      }
    }
    return verbForCollection(method, subSing, subPlur);
  }

  // CASE 5: literal trail with no preceding param (e.g. /me, /reports/all,
  // /audit/events).
  if (!lastIsParam && lastLit !== null) {
    let collection = lastLit;
    if (NAMESPACE_NAMES.has(collection)) {
      // Walk back to find a non-namespace literal
      for (let i = segs.length - 2; i >= 0; i -= 1) {
        const s = segs[i]!;
        if (isParam(s)) continue;
        const sn = toSnake(s);
        if (NAMESPACE_NAMES.has(sn)) continue;
        collection = sn;
        break;
      }
    }
    // If collection is a generic leaf word, prepend the first meaningful
    // literal for context.
    if (
      meaningfulLiterals.length >= 2 &&
      GENERIC_LEAF.has(collection) &&
      meaningfulLiterals[0]! !== collection
    ) {
      const pSing = splitSingularPlural(meaningfulLiterals[0]!)[0];
      if (!collection.startsWith(pSing)) {
        collection = `${pSing}_${collection}`;
      }
    }
    let [sing, plur] = splitSingularPlural(collection);
    // Disambiguation prefix: prepend an additional meaningful literal that
    // sits BETWEEN the first one and the leaf, when present (e.g.
    // /subscription/usage/enterprise -> "usage" between "subscription" and
    // "enterprise").
    if (prefixParent && meaningfulLiterals.length >= 2) {
      const leafSnake = collection;
      const middle = meaningfulLiterals
        .filter((s) => s !== leafSnake)
        .map((s) => splitSingularPlural(s)[0]);
      if (middle.length > 0) {
        const prefix = middle.join("_");
        if (!sing.startsWith(prefix)) {
          sing = joinAvoidStutter(prefix, sing);
          plur = joinAvoidStutter(prefix, plur);
        }
      }
    }
    return verbForCollection(method, sing, plur);
  }

  return "list_resources";
}

function verbForResource(method: string, resource: string): string {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return `get_${resource}`;
  if (m === "POST") return `create_${resource}`;
  if (m === "PATCH" || m === "PUT") return `update_${resource}`;
  if (m === "DELETE") return `delete_${resource}`;
  return `${m.toLowerCase()}_${resource}`;
}

function verbForCollection(method: string, sing: string, plur: string): string {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return `list_${plur}`;
  if (m === "POST") return `create_${sing}`;
  if (m === "PATCH" || m === "PUT") return `update_${sing}`;
  if (m === "DELETE") return `delete_${sing}`;
  return `${m.toLowerCase()}_${plur}`;
}

function verbForAction(method: string, action: string, resource: string): string {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return `get_${action}_for_${resource}`;
  if (m === "DELETE") return `delete_${action}_for_${resource}`;
  // POST / PUT / PATCH
  return `${action}_${resource}`;
}

export interface NamingResult {
  /** Final tool name (with `action1_` prefix). */
  toolName: string;
  /** True if the tool collides with a curated name and must be skipped. */
  curatedConflict: boolean;
}

/**
 * Compute verb-first tool names for a list of (method, path) pairs.
 *
 * - First pass: derive minimal name for each.
 * - Second pass: any name collision triggers re-derivation with a parent
 *   qualifier prepended.
 * - Third pass: any STILL-colliding name gets the HTTP method appended as
 *   a tiebreaker (rare; only happens when path/method genuinely fight,
 *   like POST vs PUT to the same `/upload` endpoint).
 * - Fourth pass: names that match a curated tool name are flagged
 *   curatedConflict=true so the codegen can skip them.
 */
export function deriveToolNames(
  ops: { method: string; path: string }[],
  curatedToolNames: Set<string>,
): NamingResult[] {
  // Pass 1
  const ctxs = ops.map((o) => buildContext(o.path));
  const pass1 = ops.map((o, i) => "action1_" + deriveBaseName(o.method, ctxs[i]!, false));

  const counts1 = countBy(pass1);

  // Pass 2: re-derive only the colliders with prefixParent=true.
  const pass2 = ops.map((o, i) => {
    const name = pass1[i]!;
    if ((counts1.get(name) ?? 0) > 1) {
      return "action1_" + deriveBaseName(o.method, ctxs[i]!, true);
    }
    return name;
  });

  const counts2 = countBy(pass2);

  // Pass 3: lingering collisions get method suffix.
  const pass3 = pass2.map((name, i) => {
    if ((counts2.get(name) ?? 0) > 1) {
      return name + "_" + ops[i]!.method.toLowerCase();
    }
    return name;
  });

  return pass3.map((toolName) => ({
    toolName,
    curatedConflict: curatedToolNames.has(toolName),
  }));
}

function countBy(arr: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of arr) m.set(v, (m.get(v) ?? 0) + 1);
  return m;
}

/**
 * Reads the curated tool source files and extracts their tool names. The
 * codegen uses this set to skip operations whose verb-first name would
 * collide with a curated tool.
 */
export function extractCuratedToolNames(sources: string[]): Set<string> {
  const out = new Set<string>();
  // Match: server.registerTool(\n    "name",
  // or:    server.registerTool("name",
  // and tools registered through a helper with a spec object:
  //         registerTemplateTool(server, client, { name: "action1_x", ... })
  const patterns = [/server\.registerTool\(\s*"([^"]+)"/g, /\bname:\s*"(action1_[a-z0-9_]+)"/g];
  for (const src of sources) {
    for (const re of patterns) {
      for (const m of src.matchAll(re)) out.add(m[1]!);
    }
  }
  return out;
}
