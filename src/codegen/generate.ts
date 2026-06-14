#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDescriptionHintsMatchSpec,
  assertNameOverridesMatchSpec,
  descriptionHintFor,
  isSkipped,
  nameOverrideFor,
} from "./curated-overrides.js";
import { deriveToolNames, extractCuratedToolNames } from "./naming.js";
import { emitOutputSchema, inferOutputShape, type OutputShape } from "./outputSchema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const SPEC_PATH = join(REPO_ROOT, "src", "codegen", "spec", "openapi.json");
const SHA_PATH = join(REPO_ROOT, "src", "codegen", "spec", "openapi.sha256");
const OUT_DIR = join(REPO_ROOT, "src", "tools", "generated");
const OUT_FILE = join(OUT_DIR, "index.ts");
// Note: the codegen previously also wrote a `PINNED_SHA.ts` constant
// file next to `openapi.sha256`. That constant was never imported
// anywhere (verified via grep before removal) and the SHA-pinning
// invariant is fully covered by:
//   - `src/codegen/spec/openapi.sha256` (used by `checkSha`)
//   - `tests/unit/specSha.test.ts` (pins both the .sha256 file
//     and the SHA line embedded in the generated index.ts header)
// The dead writer was removed to keep one source of truth for the SHA.

// Curated tool source files. The codegen reads these and skips any
// auto-generated tool whose verb-first name would shadow a curated one.
const CURATED_SOURCE_FILES = [
  join(REPO_ROOT, "src", "tools", "orgs.ts"),
  join(REPO_ROOT, "src", "tools", "endpoints.ts"),
  join(REPO_ROOT, "src", "tools", "templates.ts"),
  join(REPO_ROOT, "src", "tools", "automations.ts"),
  join(REPO_ROOT, "src", "tools", "results.ts"),
  join(REPO_ROOT, "src", "tools", "workflows.ts"),
  join(REPO_ROOT, "src", "tools", "execution.ts"),
  join(REPO_ROOT, "src", "tools", "wrappers", "index.ts"),
  join(REPO_ROOT, "src", "tools", "groups.ts"),
];

interface OpenApiSpec {
  openapi: string;
  info?: { title?: string };
  paths: Record<string, Record<string, OperationObject>>;
  components: {
    parameters?: Record<string, ParameterObject>;
    schemas?: Record<string, SchemaObject>;
    requestBodies?: Record<string, RequestBodyObject>;
    responses?: Record<string, unknown>;
  };
}

interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: (ParameterObject | RefObject)[];
  requestBody?: RequestBodyObject | RefObject;
  responses?: Record<string, unknown>;
}

interface ParameterObject {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  description?: string;
  required?: boolean;
  schema?: SchemaObject;
}

interface SchemaObject {
  type?: string;
  format?: string;
  enum?: string[];
  description?: string;
  items?: SchemaObject | RefObject;
  $ref?: string;
}

interface RequestBodyObject {
  description?: string;
  required?: boolean;
  content?: Record<string, { schema?: SchemaObject | RefObject }>;
}

interface RefObject {
  $ref: string;
}

function isRef(v: unknown): v is RefObject {
  return Boolean(v) && typeof v === "object" && v !== null && "$ref" in v;
}

function deref<T>(spec: OpenApiSpec, value: T | RefObject): T {
  if (!isRef(value)) return value;
  const parts = value.$ref.replace(/^#\//, "").split("/");
  let cur: unknown = spec;
  for (const p of parts) {
    // nosemgrep: javascript.lang.security.audit.prototype-pollution.prototype-pollution-loop.prototype-pollution-loop -- read-only $ref traversal (cur = cur[p]); no write, so no prototype pollution. Input is the trusted build-time OpenAPI spec, not request data.
    cur = (cur as Record<string, unknown>)[p];
    if (cur === undefined) {
      throw new Error("Cannot resolve $ref " + value.$ref);
    }
  }
  return cur as T;
}

function snakeCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase()
    .replace(/__+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Claude Desktop / many MCP hosts cap tool names at 64 chars (per the
// remote-MCP protocol). Some Action1 operationIds blow past that once
// snake_cased. Apply a fixed list of progressive abbreviations until we
// fit. Order matters: longer / more-specific patterns first.
//
// The constant lives in `src/constants.ts` so the runtime and the
// codegen agree; importing it here avoids drift if the cap ever moves.
import { TOOL_NAME_MAX } from "../constants.js";
const ABBREVIATIONS: [RegExp, string][] = [
  [/_endpoint_results/g, "_results"],
  [/_deployment_statuses/g, "_deploy_statuses"],
  [/_remote_sessions/g, "_remote_sess"],
  [/_additional_actions/g, "_more_acts"],
  [/_endpoint_id/g, "_ep"],
  [/_instance_id/g, "_inst"],
  [/_automation_id/g, "_aut"],
  [/_session_id/g, "_sess"],
  [/_remediation_id/g, "_rem"],
  [/_package_id/g, "_pkg"],
  [/_version_id/g, "_ver"],
  [/_action_id/g, "_act"],
  [/_report_row_id/g, "_row"],
  [/_report_id/g, "_rep"],
  [/_org_id/g, "_org"],
];

// Claude Desktop renders tool titles inline above the description; a
// long title scrolls past the visible window and crowds the headline
// description. 80 chars matches the rendered-width sweet-spot
// (descriptions cap around 140, schema docs cap further) and prevents
// the spec's verbose summaries (e.g. "Detailed information on a
// specific vulnerability within an organization, including CVE
// details like attack vector.") from blowing past the layout.
const TOOL_TITLE_MAX = 80;

export function fitTitle(s: string): string {
  if (s.length <= TOOL_TITLE_MAX) return s;
  const slice = s.slice(0, TOOL_TITLE_MAX);
  // Backtrack to the previous whitespace so we cut on a word boundary.
  const lastSpace = slice.lastIndexOf(" ");
  let cut = lastSpace > 30 ? slice.slice(0, lastSpace) : slice;
  // Drop any trailing punctuation so we don't ship "foo bar,…".
  cut = cut.replace(/[.,;:!?]+$/, "").trimEnd();
  return cut + "…";
}

function fitToolName(name: string): string {
  if (name.length <= TOOL_NAME_MAX) return name;
  let result = name;
  for (const [from, to] of ABBREVIATIONS) {
    if (result.length <= TOOL_NAME_MAX) break;
    result = result.replace(from, to);
  }
  if (result.length > TOOL_NAME_MAX) {
    throw new Error(
      "Cannot fit tool name under " +
        TOOL_NAME_MAX +
        " chars after abbreviations: " +
        result +
        " (was: " +
        name +
        "). Add another abbreviation in src/codegen/generate.ts.",
    );
  }
  return result;
}

// Title-anchored read-ish detector. Only POST endpoints whose **title**
// (NOT description) clearly starts with a read verb get re-classified
// as read-only. The previous regex matched anywhere in title+description
// and falsely included endpoints like "Starting a new remote session"
// (matched "GET" in a follow-up GET reference) and "Create a automation
// schedule" (matched "list" in "list of endpoints"). Both bypassed the
// destructive guard.
//
// Whitelist approach instead of regex word-boundary: a POST is only
// "read-ish" if its title *begins* with one of these verbs.
const READONLY_TITLE_PREFIXES = [
  "list",
  "listing",
  "search",
  "searching",
  "query",
  "querying",
  "preview",
  "previewing",
  "validate",
  "validating",
  "count",
  "counting",
  "get",
  "getting",
  "fetch",
  "fetching",
  "check",
  "checking",
];

function isReadishPostTitle(title: string): boolean {
  const t = title.trim().toLowerCase();
  return READONLY_TITLE_PREFIXES.some(
    (prefix) => t === prefix || t.startsWith(prefix + " ") || t.startsWith(prefix + "ing "),
  );
}

interface OpDescriptor {
  name: string;
  operationId: string;
  method: string;
  path: string;
  title: string;
  description: string;
  tag: string;
  pathParams: ParameterObject[];
  queryParams: ParameterObject[];
  hasBody: boolean;
  bodyDescription: string;
  bodyRequired: boolean;
  bodySchemaName: string | null;
  hasPagination: boolean;
  isReadOnly: boolean;
  isDestructive: boolean;
  isIdempotent: boolean;
  outputShape: OutputShape;
  permissions: string;
}

function shaSync(p: string): string {
  const buf = readFileSync(p);
  const h = createHash("sha256");
  h.update(buf);
  return h.digest("hex");
}

function checkSha(): string {
  const expected = readFileSync(SHA_PATH, "utf8").trim();
  const actual = shaSync(SPEC_PATH);
  if (expected !== actual) {
    throw new Error(
      "Spec SHA mismatch. Expected " +
        expected +
        " but file is " +
        actual +
        ". The Action1 OpenAPI spec changed - review the diff and update src/codegen/spec/openapi.sha256 explicitly. Do not auto-update.",
    );
  }
  return actual;
}

// Words that, when they sit immediately before the trim point, indicate
// the cut landed mid-clause and the sentence is grammatically incomplete
// (e.g. "...all the default roles are." / "...the client then." /
// "...specified phrase in one of."). Adding these connectors to the
// incomplete-tail detector lets `trimToSentence` walk back one more
// sentence boundary or drop the tail entirely so the agent doesn't see
// dangling prose.
//
// The trailing pattern allows any combination of `.`, whitespace, and
// ellipsis-dots after the connector — because the lastSpace fallback
// produces "<word>..." which later gets collapsed to "<word>." by
// buildStructuredDescription. We need to catch both forms here so the
// detection works pre-collapse.
// Pass-10 review #3: connector list moved to its own module so test-
// side dynamic `import("...generate.js")` doesn't trigger this file's
// top-level `main()` (which writes generated/index.ts to disk).
export { INCOMPLETE_TAIL_CONNECTORS, INCOMPLETE_TAIL_RE } from "./connectors.js";
import { INCOMPLETE_TAIL_RE } from "./connectors.js";

/** Walk back to the previous full-sentence boundary inside `s` while the
 * tail still looks grammatically incomplete. Used after `trimToSentence`
 * picks a cut and we discover the cut itself landed on a connector. */
function dropIncompleteTail(s: string): string {
  let out = s.trim();
  // Strip any trailing ellipsis dots first so the boundary-walk operates
  // on a clean ".$" terminator.
  out = out.replace(/\.{2,}\s*$/g, ".").trim();
  let safety = 4;
  while (safety-- > 0 && INCOMPLETE_TAIL_RE.test(out)) {
    const dot = out.lastIndexOf(".", out.length - 2);
    if (dot < 0) {
      out = out.replace(INCOMPLETE_TAIL_RE, "").trim();
      break;
    }
    out = out.slice(0, dot + 1).trim();
  }
  return out;
}

/**
 * Word-boundary-safe cap for the assembled lead sentence. Previously
 * the lead got hard-sliced at 137 chars + "..." appended, which left
 * mid-word stubs ("...specified custom p...") that the post-processing
 * loop then collapsed to bogus full-stops ("...specified custom p.").
 *
 * Strategy: trim to maxChars, then backtrack one word via `\b\w+\.?$`
 * so the cut lands on a word boundary, then append a single ellipsis
 * character "…" (NOT three dots) so the post-processing connector
 * regex doesn't re-trigger.
 */
export function fitLead(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  let cut = s.slice(0, maxChars);
  // Drop a trailing partial word (so "specified custom packa" → "specified custom ")
  cut = cut.replace(/\s*\b\w+\.?$/, "");
  cut = cut.trimEnd();
  // Strip a trailing connector word if present so we don't ship
  // "...for specific…" mid-clause.
  cut = dropIncompleteTail(cut + ".");
  // dropIncompleteTail re-emits the period — strip it before adding "…".
  cut = cut.replace(/[.!?]+$/, "").trimEnd();
  return cut + "…";
}

/**
 * Trim a long description to a sentence boundary. Prefer cutting at the
 * first `. ` that lies past `minChars`; fall back to a hard `maxChars`
 * cap if no boundary is found.
 *
 * After the cut, if the trailing word is a connector (see
 * INCOMPLETE_TAIL_RE), walk back one or more sentence boundaries inside
 * the slice. Better to lose one extra sentence than ship "...the client
 * then." prose to the agent.
 */
function trimToSentence(s: string, minChars: number, maxChars: number): string {
  if (s.length <= minChars) return dropIncompleteTail(s);
  const slice = s.slice(0, maxChars);
  // Collect every boundary in the slice past `minChars`, then pick the
  // FIRST one whose preceding clause doesn't end on a connector. This
  // keeps descriptions short when a clean cut exists, but extends past
  // a bad cut when needed.
  const re = /[.!?](\s|$)/g;
  const boundaries: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice)) !== null) {
    if (m.index >= minChars) boundaries.push(m.index + 1);
  }
  for (const cutAt of boundaries) {
    const candidate = slice.slice(0, cutAt).trim();
    if (!INCOMPLETE_TAIL_RE.test(candidate)) return candidate;
  }
  if (boundaries.length > 0) {
    // All boundaries inside [minChars, maxChars] leave a connector tail.
    // Take the first boundary and aggressively strip the dangling tail.
    return dropIncompleteTail(slice.slice(0, boundaries[0]));
  }
  if (s.length <= maxChars) return dropIncompleteTail(s);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > minChars) {
    return dropIncompleteTail(slice.slice(0, lastSpace) + ".");
  }
  return slice.trim() + "...";
}

/**
 * Extract permission tags from the description's permission marker.
 * Action1's OpenAPI spec uses three slightly different forms:
 *   - `**Requires permission: \`x\`, \`y\`**`
 *   - `**Requires permissions: \`x\`, \`y\`**`
 *   - `**Requires one of the following permissions: \`x\`, \`y\`**`
 *
 * The regex covers all three. Without the "(one of the following)?"
 * branch, ~7 operations would silently lose their Permissions: footer
 * in the generated tool description.
 */
function extractPermissions(desc: string): { permissions: string; rest: string } {
  const re = /\*\*Requires(?: one of the following)? permissions?:[^*]*\*\*/i;
  const match = desc.match(re);
  if (!match) return { permissions: "", rest: desc };
  const codes = [...match[0].matchAll(/`([^`]+)`/g)].map((m2) => m2[1]!);
  const rest = desc.replace(re, "").trim();
  return { permissions: codes.join(", "), rest };
}

/**
 * Build the structured tool description following the skill best practice:
 *
 *   <summary>. <trimmed description>.
 *
 *   Args: a, b, c.
 *   Returns: <list-shape | single-object | ok-status>.
 *   Permissions: <comma-separated tags>.
 */
function buildStructuredDescription(
  summary: string,
  rawDescription: string,
  argNames: string[],
  outputShape: OutputShape,
  operationId: string,
): { description: string; permissions: string } {
  // Tool descriptions are repeated in EVERY tools/list response that
  // Claude Desktop loads into the agent context. Median tool was
  // 1.5 KB, summed across 134 generated tools that's ~200 KB just
  // for schema docs. We strip aggressively here:
  //  - lead: max ~120 chars (summary + at most one summary sentence)
  //  - drop the redundant "Args:" line (the schema lists args)
  //  - drop the "Returns:" boilerplate (output schema is structured)
  //  - keep "Permissions:" iff the spec gave one (gates 403 errors)
  const { permissions, rest } = extractPermissions(rawDescription);
  const cleanedRest = rest.replace(/\s+/g, " ").trim();
  let headline = trimToSentence(cleanedRest, 40, 100);
  if (summary && headline) {
    const norm = (s: string): string => s.replace(/[.!?]+$/, "").trim().toLowerCase();
    const firstSentenceMatch = headline.match(/^([^.!?]+[.!?])\s*(.*)$/);
    if (firstSentenceMatch) {
      const firstSentence = firstSentenceMatch[1] ?? "";
      const remainder = firstSentenceMatch[2] ?? "";
      if (norm(firstSentence) === norm(summary)) {
        headline = remainder.trim();
      }
    }
  }
  let lead = [summary, headline].filter(Boolean).join(". ").replace(/\.\s*\.+/g, ".");
  if (lead.length > 140) {
    lead = fitLead(lead, 140);
  }
  // Pass-4 Critical #1 (round 2): the headline returned by
  // trimToSentence can lose its trailing connector along with its
  // period ("...deployed on." → "...deployed"). Joining produces
  // "...deployed" without a closing dot. Naively appending "." would
  // recreate "...deployed on." after a re-test (the connector is
  // already gone, but adding "." would re-pattern-match). Workaround:
  // ensure terminator, then strip connector-tail, then re-terminate.
  // Iterate up to 3 times so a double-connector ("of the.") gets
  // collapsed to no-tail-and-then-period.
  //
  // Cluster-D fix: if the lead now ends on a "…" (single-char
  // ellipsis) from `fitLead`, leave it as-is — appending "." would
  // produce "…." which the post-collapse strips back to "…", but
  // would also re-trigger the connector regex. Skip the terminator
  // step when the lead already ends with the ellipsis character.
  for (let i = 0; i < 3; i += 1) {
    if (lead && !/[.!?…]$/.test(lead.trim())) lead = lead.trim() + ".";
    const stripped = dropIncompleteTail(lead);
    if (stripped === lead) break;
    lead = stripped;
  }
  if (lead && !/[.!?…]$/.test(lead.trim())) {
    lead = lead.trim() + ".";
  }
  // After dropIncompleteTail finishes, also catch short stub-words that
  // look like mid-word truncations the connector list doesn't cover
  // ("...specific v.", "...detailed inf.", "...for one of."). Any
  // trailing 1-4-letter lowercase word + period gets dropped and the
  // tail re-terminated with "…" so the agent sees an explicit
  // truncation marker instead of a stub.
  const stubRe = /\s+[a-z]{1,4}\.$/;
  if (stubRe.test(lead)) {
    lead = lead.replace(stubRe, "…");
  }

  // argNames is no longer rendered — left in the signature so callers
  // don't have to be updated. Same for outputShape.
  void argNames;
  void outputShape;

  // Optional curator-authored hint that prepends a sentence pointing
  // the agent at a curated sibling (Finding 3.3: missing_updates
  // curated/generated overlap). Hint sits in front of the lead so the
  // agent reads "Filtered/paginated variant of X. Use for ..." before
  // the spec summary.
  const hint = descriptionHintFor(operationId);

  const parts: string[] = [];
  if (hint) parts.push(hint);
  if (lead) parts.push(lead);
  if (permissions) parts.push("Perm: " + permissions + ".");
  return { description: parts.join(" "), permissions };
}

interface RawOp {
  op: OperationObject;
  method: string;
  path: string;
}

function describe(spec: OpenApiSpec): { ops: OpDescriptor[]; skipped: number } {
  // Build the full set of operationIds in the spec FIRST so we can
  // verify that every NAME_OVERRIDES key matches a real op. Without
  // this check the codegen used to silently emit heuristic names for
  // overrides whose key didn't match (Pass 2 audit found 8 such
  // dead-code overrides).
  const allOperationIds = new Set<string>();
  for (const methods of Object.values(spec.paths)) {
    for (const op of Object.values(methods)) {
      if (op.operationId) allOperationIds.add(op.operationId);
    }
  }
  assertNameOverridesMatchSpec(allOperationIds);
  assertDescriptionHintsMatchSpec(allOperationIds);

  const raws: RawOp[] = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [methodLc, op] of Object.entries(methods)) {
      const method = methodLc.toUpperCase();
      if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) continue;
      if (!op.operationId) continue;
      if (isSkipped(op.operationId)) continue;
      raws.push({ op, method, path });
    }
  }

  const curatedSources = CURATED_SOURCE_FILES.map((p) => readFileSync(p, "utf8"));
  const curatedToolNames = extractCuratedToolNames(curatedSources);

  const namesArr = deriveToolNames(
    raws.map((r) => ({ method: r.method, path: r.path })),
    curatedToolNames,
  );

  const out: OpDescriptor[] = [];
  let skipped = 0;
  for (let i = 0; i < raws.length; i += 1) {
    const { op, method, path } = raws[i]!;
    let naming = namesArr[i]!;
    // Hand-picked override wins over the heuristic. Used for
    // operations whose default name would be misleading or
    // semantically wrong (e.g. `action1_create_endpoint` for a
    // requery, or singleton GETs that the heuristic emits as
    // `list_*`).
    const override = op.operationId ? nameOverrideFor(op.operationId) : undefined;
    if (override) {
      // The override may itself collide with a curated name (intentional:
      // we want curated to win, override loses). Re-check.
      naming = {
        toolName: override,
        curatedConflict: curatedToolNames.has(override),
      };
    }
    if (naming.curatedConflict) {
      skipped += 1;
      continue;
    }

    const params: ParameterObject[] = (op.parameters ?? []).map((p) => deref(spec, p));
    const declaredPathParams = params.filter((p) => p.in === "path");
    const queryParams = params.filter((p) => p.in === "query");

    const declaredNames = new Set(declaredPathParams.map((p) => p.name));
    const templateNames = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
    const pathParams: ParameterObject[] = [...declaredPathParams];
    for (const t of templateNames) {
      if (!declaredNames.has(t)) {
        pathParams.push({
          name: t,
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Path parameter (synthesised: not declared in spec).",
        });
      }
    }

    const summary = (op.summary ?? op.operationId ?? "").trim();
    const rawDescription = op.description ?? "";

    const isReadOnly = method === "GET" || method === "HEAD";
    // Title-only check (NOT title+description): a POST endpoint whose
    // *title* begins with a read verb (e.g. "Search …", "Get …"). Avoids
    // false positives like "Starting a new remote session" or
    // "Create a automation schedule" (whose description happens to mention
    // "list of endpoints"), which would otherwise bypass the destructive
    // guard.
    const isReadishPost = method === "POST" && isReadishPostTitle(summary);
    void rawDescription;
    const isDestructive =
      !isReadOnly &&
      !isReadishPost &&
      (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE");
    const isIdempotent =
      method === "GET" || method === "HEAD" || method === "PUT" || method === "DELETE";

    const hasBody = Boolean(op.requestBody);
    let bodyDescription = "";
    let bodyRequired = false;
    let bodySchemaName: string | null = null;
    if (hasBody && op.requestBody) {
      const rb = deref(spec, op.requestBody);
      bodyRequired = rb.required ?? false;
      const schema = rb.content?.["application/json"]?.schema;
      if (schema) {
        const resolved = isRef(schema) ? schema.$ref.split("/").pop() : "object";
        bodySchemaName = resolved ?? null;
        bodyDescription = rb.description
          ? rb.description + " (schema: " + (resolved ?? "object") + ")"
          : "Request body (schema: " + (resolved ?? "object") + ")";
      } else {
        bodyDescription = rb.description ?? "Request body.";
      }
    }

    const rawHasPagination =
      queryParams.some((p) => p.name === "limit") &&
      queryParams.some((p) => p.name === "from");

    const outputShape = inferOutputShape(
      spec,
      op.responses,
      method,
      rawHasPagination,
    );

    // Pass-9: pagination-input args (auto_paginate, cursor) are only
    // meaningful when the response is also paginated. Non-JSON export
    // endpoints (CSV / HTML downloads — audit_export_get,
    // reportdata_*_export_get) accept `limit`+`from` as row-windowing
    // arguments but produce a single blob body. Emitting
    // `auto_paginate` / `cursor` on those is misleading — the agent
    // would set them expecting cursor-pagination semantics that
    // never engage. Drop pagination-args when the output is
    // single-shape OR ok-status.
    const hasPagination =
      rawHasPagination &&
      outputShape !== "single" &&
      outputShape !== "ok_status";

    // Build the input-arg names list for the structured description.
    const argNames: string[] = [];
    let hasOrgIdParam = false;
    for (const p of pathParams) {
      if (p.name === "orgId" || p.name === "orgIdOrAll") hasOrgIdParam = true;
    }
    if (hasOrgIdParam) argNames.push("org_id");
    for (const p of pathParams) {
      if (p.name === "orgId" || p.name === "orgIdOrAll") continue;
      argNames.push(snakeCase(p.name));
    }
    for (const p of queryParams) argNames.push(snakeCase(p.name));
    if (hasPagination) {
      argNames.push("auto_paginate", "cursor");
    }
    if (hasBody) argNames.push("body");
    if (isReadOnly) argNames.push("response_format", "verbose");
    if (isDestructive) argNames.push("confirm", "dry_run");

    const { description, permissions } = buildStructuredDescription(
      summary,
      rawDescription,
      argNames,
      outputShape,
      op.operationId!,
    );

    out.push({
      name: fitToolName(naming.toolName),
      operationId: op.operationId!,
      method,
      path,
      title: summary,
      description,
      tag: op.tags?.[0] ?? "uncategorised",
      pathParams,
      queryParams,
      hasBody,
      bodyDescription,
      bodyRequired,
      bodySchemaName,
      hasPagination,
      isReadOnly,
      isDestructive,
      isIdempotent,
      outputShape,
      permissions,
    });
  }
  return { ops: out, skipped };
}

function tsLiteral(s: string): string {
  return JSON.stringify(s);
}

// Param-description char cap. We previously used 60 which produced
// truncations like "Specify the severity level, e" — cutting a phrase
// mid-word ahead of the actual enum hint. 90 chars is enough for the
// common Action1 param descriptions (median ~50 chars) and gives room
// to fit "Specify the severity level, e.g. Critical." in full.
const PARAM_DESC_MAX = 90;

function emitParamSchema(p: ParameterObject): string {
  // Aggressive cap on param descriptions — these are the single
  // biggest contributor to tools/list payload bloat. We prefer a
  // sentence boundary (`. `) within the cap, fall back to a word
  // boundary, then to a hard char-cap.
  const fullDesc = (p.description ?? "").replace(/\s+/g, " ").trim();
  let desc = fullDesc;
  if (desc.length > PARAM_DESC_MAX) {
    // 1) sentence-boundary cut: prefer the first `. ` that lands inside
    //    the cap (keeps the description grammatically complete).
    const slice = desc.slice(0, PARAM_DESC_MAX);
    const sentenceCut = slice.search(/\.\s/);
    if (sentenceCut > 0) {
      desc = slice.slice(0, sentenceCut + 1);
    } else {
      // 2) word-boundary fallback: cut at last whitespace inside the cap
      //    to avoid mid-word truncation.
      const lastSpace = slice.lastIndexOf(" ");
      if (lastSpace > 30) {
        desc = slice.slice(0, lastSpace) + "...";
      } else {
        // 3) hard cap — extremely rare (single very long word).
        desc = desc.slice(0, PARAM_DESC_MAX - 3) + "...";
      }
    }
  }
  if (!desc) desc = p.name;
  const required = p.required ?? p.in === "path";
  let zod = zodFromSchema(p.schema);
  zod += ".describe(" + tsLiteral(desc) + ")";
  if (!required) zod += ".optional()";
  return snakeCase(p.name) + ": " + zod;
}

function zodFromSchema(s: SchemaObject | undefined): string {
  if (!s) {
    // Untyped query/path params land here. HTTP query-string semantics
    // are string-by-wire — emitting `z.unknown()` was a bug: the
    // runtime then ran the value through `toQueryValue` which would
    // `JSON.stringify` non-scalars and produce gibberish like
    // `?status={"foo":1}`. Default to `z.string()` so the agent sees
    // a stringly-typed schema, matching the actual wire format.
    if (typeof process !== "undefined" && process.stderr?.write) {
      // Codegen-time warning so a future maintainer sees that a spec
      // field lacks a type. Stays in stderr; doesn't fail the build.
      process.stderr.write(
        "codegen: untyped param schema — defaulting to z.string() (HTTP query-string semantics).\n",
      );
    }
    return "z.string()";
  }
  if (s.enum && s.enum.length) {
    return "z.enum([" + s.enum.map(tsLiteral).join(", ") + "])";
  }
  switch (s.type) {
    case "string":
      if (s.format === "uuid") return "z.string().uuid()";
      if (s.format === "date-time") return "z.string().datetime()";
      return "z.string()";
    case "integer":
      return "z.number().int()";
    case "number":
      return "z.number()";
    case "boolean":
      return "z.boolean()";
    case "array":
      return "z.array(" + (s.items ? zodFromSchema(isRef(s.items) ? undefined : s.items) : "z.string()") + ")";
    default:
      // Unknown OpenAPI `type` value — for query params, fall back to
      // the same string default for the same reason as the no-schema
      // branch above.
      return "z.string()";
  }
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_$]/g, "_");
}

function emitTool(op: OpDescriptor): string {
  const inputProps: string[] = [];

  // org override convention: every tool that has an orgId path param gets a
  // resolveOrgId fallback to ACTION1_ORG_ID, exposed as `org_id` (snake_case)
  // for consistency with the curated tools.
  let orgIdSourceName: string | undefined;
  for (const p of op.pathParams) {
    if (p.name === "orgId" || p.name === "orgIdOrAll") {
      orgIdSourceName = p.name;
    }
  }

  if (orgIdSourceName) {
    inputProps.push(
      'org_id: z.string().min(1).optional().describe("Org UUID.")',
    );
  }

  for (const p of op.pathParams) {
    if (p.name === orgIdSourceName) continue;
    inputProps.push(emitParamSchema(p));
  }

  for (const p of op.queryParams) {
    inputProps.push(emitParamSchema(p));
  }

  if (op.hasPagination) {
    inputProps.push(
      'auto_paginate: z.boolean().optional().describe("Walk all pages.")',
    );
    inputProps.push(
      'cursor: z.string().optional().describe("Pagination cursor.")',
    );
  }

  if (op.hasBody) {
    const required = op.bodyRequired;
    let bodyZod = "z.record(z.unknown())";
    if (!required) bodyZod += ".optional()";
    bodyZod += ".describe(" + tsLiteral(op.bodyDescription) + ")";
    inputProps.push("body: " + bodyZod);
  }

  // Read-only tools (GET/HEAD) get response_format + verbose flags.
  // Descriptions are kept tight: the agent already knows what these do
  // from the broader server-instructions; bloating every tool's schema
  // with the same prose costs context for zero added information.
  if (op.isReadOnly) {
    inputProps.push(
      'response_format: z.enum(["markdown","json"]).optional().describe("Output format. Default markdown.")',
    );
    inputProps.push(
      'verbose: z.boolean().optional().describe("Skip per-item compactor.")',
    );
  }

  if (op.isDestructive) {
    inputProps.push(
      'confirm: z.literal("YES").optional().describe("Required to execute. Exact string \\"YES\\".")',
    );
    inputProps.push(
      'dry_run: z.boolean().optional().describe("Default true (preview). Set false to execute.")',
    );
  }

  // All four annotations explicit, per the MCP-builder skill.
  const annotations: string[] = [
    "readOnlyHint: " + (op.isReadOnly ? "true" : "false"),
    "destructiveHint: " + (op.isDestructive ? "true" : "false"),
    "idempotentHint: " + (op.isIdempotent ? "true" : "false"),
    "openWorldHint: true",
  ];

  // Description is now structured (lead + Args/Returns/Permissions),
  // already capped in `buildStructuredDescription`. Pass it through
  // unmodified so we keep the labelled blocks.
  const titleEscaped = tsLiteral(fitTitle(op.title || op.name));
  const descEscaped = tsLiteral(op.description);

  // Build the path interpolation
  const pathExpr = buildPathExpression(op.path, orgIdSourceName);
  // Query params: send under their original spec name (the API expects `orgId`
  // not `org_id`) but read from args under the snake_case alias so the input
  // schema is consistent.
  const queryExpr = op.queryParams.length
    ? "{ " +
      op.queryParams
        .map((p) => `[${tsLiteral(p.name)}]: args[${tsLiteral(snakeCase(p.name))}]`)
        .join(", ") +
      " }"
    : "undefined";

  const outputSchemaName = emitOutputSchema(op.outputShape);

  const body =
    `  server.registerTool(\n` +
    `    ${tsLiteral(op.name)},\n` +
    `    {\n` +
    `      title: ${titleEscaped},\n` +
    `      description: ${descEscaped},\n` +
    (inputProps.length
      ? `      inputSchema: {\n        ${inputProps.join(",\n        ")},\n      },\n`
      : `      inputSchema: {},\n`) +
    `      outputSchema: ${outputSchemaName},\n` +
    `      annotations: { ${annotations.join(", ")} },\n` +
    `    },\n` +
    (inputProps.length === 0
      ? `    async (_rawArgs, extra) => {\n      const args = _rawArgs as Record<string, unknown>;\n      void args;\n`
      : `    async (rawArgs, extra) => {\n      const args = rawArgs as Record<string, unknown>;\n`) +
    `      return runGenerated({\n` +
    `        client,\n` +
    `        toolName: ${tsLiteral(op.name)},\n` +
    `        method: ${tsLiteral(op.method)},\n` +
    `        path: ${pathExpr},\n` +
    `        queryParams: ${queryExpr},\n` +
    `        body: ${op.hasBody ? "(args.body as Record<string, unknown> | undefined)" : "undefined"},\n` +
    `        autoPaginate: ${op.hasPagination ? "Boolean(args.auto_paginate)" : "false"},\n` +
    `        cursor: ${op.hasPagination ? "args.cursor as (string | undefined)" : "undefined"},\n` +
    `        destructive: ${op.isDestructive ? '{ confirm: args.confirm as ("YES" | undefined), dry_run: args.dry_run as (boolean | undefined) }' : "undefined"},\n` +
    `        responseFormat: ${op.isReadOnly ? 'args.response_format as ("markdown" | "json" | undefined)' : "undefined"},\n` +
    `        verbose: ${op.isReadOnly ? "(args.verbose as boolean | undefined)" : "undefined"},\n` +
    `        signal: extra?.signal,\n` +
    `      });\n` +
    `    },\n` +
    `  );`;

  return body;
}

function buildPathExpression(path: string, orgIdSourceName: string | undefined): string {
  const parts: string[] = [];
  let buf = "";
  let i = 0;
  while (i < path.length) {
    if (path[i] === "{") {
      if (buf) {
        parts.push(tsLiteral(buf));
        buf = "";
      }
      const end = path.indexOf("}", i);
      if (end < 0) throw new Error("Unbalanced { in path " + path);
      const name = path.slice(i + 1, end);
      const argExpr =
        name === orgIdSourceName
          ? "resolveOrgId(args.org_id as string | undefined)"
          : `args[${tsLiteral(snakeCase(name))}]`;
      parts.push("encodeURIComponent(String(" + argExpr + "))");
      i = end + 1;
    } else {
      buf += path[i];
      i += 1;
    }
  }
  if (buf) parts.push(tsLiteral(buf));
  return parts.length ? parts.join(" + ") : tsLiteral(path);
}

function emitFile(ops: OpDescriptor[], sha: string, skippedCount: number): string {
  const totalReadOnly = ops.filter((o) => o.isReadOnly).length;
  const totalDestructive = ops.filter((o) => o.isDestructive).length;
  const header =
    "// AUTO-GENERATED by src/codegen/generate.ts. Do not edit by hand.\n" +
    "// Source: src/codegen/spec/openapi.json (SHA: " +
    sha +
    ")\n" +
    "// Operations emitted: " +
    ops.length +
    " (read-only: " +
    totalReadOnly +
    ", destructive: " +
    totalDestructive +
    "; skipped due to curated-name conflict: " +
    skippedCount +
    ")\n\n" +
    'import { z } from "zod";\n' +
    'import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\n' +
    'import type { Action1Client } from "../../client/action1Client.js";\n' +
    'import { runGenerated } from "./runtime.js";\n' +
    'import { resolveOrgId } from "../../config.js";\n' +
    'import {\n  cursorListOutputShape,\n  listOutputShape,\n  okStatusOutputShape,\n  singleObjectOutputShape,\n} from "../helpers.js";\n\n';

  const tagBuckets = new Map<string, OpDescriptor[]>();
  for (const op of ops) {
    if (!tagBuckets.has(op.tag)) tagBuckets.set(op.tag, []);
    tagBuckets.get(op.tag)!.push(op);
  }

  // tagBuckets and ops.map(emitTool) below would emit duplicate tool blocks,
  // so we only use the per-op functions emitted later.
  const footer =
    "\n\nexport function registerGeneratedTools(server: McpServer, client: Action1Client): void {\n" +
    ops.map((o) => `  register_${safeName(o.operationId)}(server, client);`).join("\n") +
    "\n}\n";

  // Wrap each tool in its own function so import names line up
  const fns = ops
    .map((op) => {
      const sig =
        "function register_" +
        safeName(op.operationId) +
        "(server: McpServer, client: Action1Client): void {";
      return sig + "\n" + emitTool(op).split("\n").map((l) => "  " + l).join("\n") + "\n}";
    })
    .join("\n\n");

  return header + fns + footer;
}

function main(): void {
  const sha = checkSha();
  const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8")) as OpenApiSpec;
  const { ops, skipped } = describe(spec);
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const out = emitFile(ops, sha, skipped);
  writeFileSync(OUT_FILE, out, "utf8");
  process.stdout.write(
    "Generated " +
      ops.length +
      " tools to " +
      OUT_FILE +
      " (spec sha: " +
      sha.slice(0, 12) +
      "); skipped " +
      skipped +
      " due to curated-name conflicts.\n",
  );
}

// Only run codegen when invoked as a script (e.g. `tsx src/codegen/generate.ts`
// via `npm run codegen`). Skipping the side-effect on bare import lets unit
// tests dynamically `import("...generate.js")` the helpers (fitLead, fitTitle)
// without overwriting `src/tools/generated/index.ts` mid-run. Pass-10 review
// #3 originally split the connector list out for this reason; the helpers
// follow the same gating pattern.
const invokedAsScript =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (invokedAsScript) {
  main();
}
