#!/usr/bin/env node
/**
 * Code generator for the auto-generated Action1 tools.
 *
 * Run: `npm run codegen` (tsx src/codegen/generate.ts). Commit the spec,
 * its SHA and the generated file together; CI's codegen-roundtrip job
 * re-runs this script and fails on any uncommitted difference.
 *
 * Inputs:
 *   - src/codegen/spec/openapi.json    pinned Action1 OpenAPI 3.1 spec
 *                                      (refresh: scripts/fetch-spec.mjs,
 *                                      see src/codegen/spec/SOURCE.md)
 *   - src/codegen/spec/openapi.sha256  expected SHA-256 of openapi.json
 *   - src/codegen/curated-overrides.ts skip list, name overrides,
 *                                      description hints, read-ish allowlist
 *   - src/tools/** (except generated/) curated tool names, so a generated
 *                                      tool never shadows a curated one
 * Output:
 *   - src/tools/generated/index.ts     one registerTool call per operation,
 *                                      plus GENERATED_TOOL_MANIFEST and
 *                                      GENERATED_SKIPPED_OPERATIONS
 *   - src/spec/generated.ts            field names and enum values the
 *                                      curated tools read (paths in
 *                                      src/codegen/specContract.ts)
 *
 * The run aborts (nothing is written) when:
 *   - the spec SHA does not match openapi.sha256 (no silent spec drift),
 *   - a NAME_OVERRIDES / OPERATION_DESCRIPTION_HINTS key is not an
 *     operationId of the spec, or a READISH_OPERATION_IDS key is not a POST,
 *   - a tool name cannot be shortened to the MCP 64-character limit,
 *   - two emitted tools would get the same name,
 *   - a path in src/codegen/specContract.ts no longer resolves.
 *
 * Invariants the generated file keeps (tested in
 * tests/integration/generatedTools.test.ts): every POST/PUT/PATCH/DELETE
 * operation is a destructive tool unless it is on READISH_OPERATION_IDS;
 * operations the runtime cannot send correctly (non-JSON request body or
 * required request headers) are emitted as tools that return an error
 * instead of calling Action1.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDescriptionHintsMatchSpec,
  assertNameOverridesMatchSpec,
  assertReadishOperationsMatchSpec,
  descriptionHintFor,
  isSkipped,
  nameOverrideFor,
  READISH_OPERATION_IDS,
} from "./curated-overrides.js";
import { deriveToolNames, extractCuratedToolNames } from "./naming.js";
import { inferOutputShape, outputSchemaSource, type OutputShape } from "./outputSchema.js";
import { resolveContract, specModuleSource } from "./specContract.js";
import { bodyZodSource, capDescription, paramZodSource, type ParamZod } from "./zodEmit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const SPEC_PATH = join(REPO_ROOT, "src", "codegen", "spec", "openapi.json");
const SHA_PATH = join(REPO_ROOT, "src", "codegen", "spec", "openapi.sha256");
const OUT_DIR = join(REPO_ROOT, "src", "tools", "generated");
const OUT_FILE = join(OUT_DIR, "index.ts");
const SPEC_MODULE_FILE = join(REPO_ROOT, "src", "spec", "generated.ts");
// The SHA pin has one source of truth, `src/codegen/spec/openapi.sha256`:
// `checkSha` compares the spec against it (it is never written here), and
// `tests/unit/specSha.test.ts` pins both the .sha256 file and the SHA line
// embedded in the generated index.ts header.

// Curated tools live anywhere under src/tools/ except generated/. The
// codegen scans every .ts file there (no hand-maintained file list) and
// skips any auto-generated tool whose name would shadow a curated one.
// tests/integration/generatedTools.test.ts cross-checks the scanned set
// against the tools the real server registers, so a registration the
// scanner cannot see fails the test instead of crashing the server at
// startup with a duplicate-name error.
const TOOLS_DIR = join(REPO_ROOT, "src", "tools");

export function curatedSourceFiles(dir: string = TOOLS_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full === OUT_DIR) continue;
      out.push(...curatedSourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out.sort();
}

/** Names of all curated tools, read from the curated source files. */
export function curatedToolNames(): Set<string> {
  return extractCuratedToolNames(curatedSourceFiles().map((p) => readFileSync(p, "utf8")));
}

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
import { MAX_LIST_LIMIT, TOOL_NAME_MAX } from "../constants.js";
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

// Spec titles mix imperative ("Get user") and gerund ("Getting a
// specific role") forms. Tool titles are normalised to the imperative.
// Explicit map instead of stemming so an unknown word is left alone.
const GERUND_TO_IMPERATIVE: Record<string, string> = {
  Applying: "Apply",
  Assigning: "Assign",
  Changing: "Change",
  Checking: "Check",
  Cloning: "Clone",
  Closing: "Close",
  Creating: "Create",
  Deleting: "Delete",
  Drilling: "Drill",
  Exporting: "Export",
  Getting: "Get",
  Listing: "List",
  Moving: "Move",
  Requesting: "Request",
  Revoking: "Revoke",
  Searching: "Search",
  Starting: "Start",
  Stopping: "Stop",
  Switching: "Switch",
  Unassigning: "Unassign",
  Updating: "Update",
};

/**
 * Normalise a spec summary into a tool title: drop the vendor's "TBD:"
 * placeholder prefix and a trailing period, and turn a leading gerund
 * into the imperative ("Listing roles" -> "List roles").
 */
export function normalizeTitle(summary: string): string {
  let t = summary
    .trim()
    .replace(/^TBD:\s*/i, "")
    .replace(/\.+$/, "")
    .trim();
  const m = /^([A-Z][a-z]+)\b(.*)$/.exec(t);
  const imperative = m ? GERUND_TO_IMPERATIVE[m[1]!] : undefined;
  if (m && imperative) t = imperative + (m[2] ?? "");
  return t;
}

/**
 * Destructive classification of one operation. GET/HEAD are read-only;
 * every other method is destructive unless the operationId is on the
 * reviewed READISH_OPERATION_IDS allowlist (POST only). Titles are never
 * consulted: a misleading title must not remove the guard.
 */
export function classifyOperation(
  method: string,
  operationId: string,
): { isReadOnly: boolean; isDestructive: boolean } {
  const m = method.toUpperCase();
  const isReadOnly = m === "GET" || m === "HEAD";
  const isReadish = m === "POST" && READISH_OPERATION_IDS.has(operationId);
  return { isReadOnly, isDestructive: !isReadOnly && !isReadish };
}

/**
 * Why the generated runtime cannot perform this operation, or null. The
 * runtime sends JSON bodies only and no custom request headers, so a
 * non-JSON request body or a required header parameter would produce a
 * request Action1 rejects (or misreads).
 */
export function unsupportedReason(
  toolName: string,
  bodyContentTypes: string[],
  requiredHeaders: string[],
): string | null {
  const nonJson = bodyContentTypes.filter((ct) => !/^application\/json\b/i.test(ct));
  const problems: string[] = [];
  if (bodyContentTypes.length > 0 && nonJson.length === bodyContentTypes.length) {
    problems.push("a request body of type " + nonJson.join(" / "));
  }
  if (requiredHeaders.length > 0) {
    problems.push("the request header(s) " + requiredHeaders.join(", "));
  }
  if (problems.length === 0) return null;
  return (
    toolName +
    " is not supported by this MCP server: the Action1 endpoint needs " +
    problems.join(" and ") +
    ", which this server does not send. Use the Action1 console for this step."
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
  bodyZod: string;
  unsupported: string | null;
  hasPagination: boolean;
  isReadOnly: boolean;
  isDestructive: boolean;
  isIdempotent: boolean;
  outputShape: OutputShape;
  outputSchema: string;
  permissions: string;
  /** Zod source per parameter (`in:name`), from paramZodSource. */
  paramZod: Map<string, ParamZod>;
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
// ellipsis-dots after the connector - because the lastSpace fallback
// produces "<word>..." which later gets collapsed to "<word>." by
// buildStructuredDescription. We need to catch both forms here so the
// detection works pre-collapse.
// The connector list lives in its own module so tests can import it
// without loading this file, whose top-level `main()` writes
// generated/index.ts to disk.
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
 * Word-boundary-safe cap for the assembled lead sentence. A hard slice
 * would leave mid-word stubs ("...specified custom p...") that the
 * post-processing loop then collapses to bogus full-stops
 * ("...specified custom p.").
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
  // dropIncompleteTail re-emits the period - strip it before adding "…".
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
 * Build the structured tool description:
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
  // Claude Desktop loads into the agent context, so across all
  // generated tools verbose descriptions add up to a large share of
  // the payload. We strip aggressively here:
  //  - lead: max ~120 chars (summary + at most one summary sentence)
  //  - drop the redundant "Args:" line (the schema lists args)
  //  - drop the "Returns:" boilerplate (output schema is structured)
  //  - keep "Permissions:" iff the spec gave one (gates 403 errors)
  const { permissions, rest } = extractPermissions(rawDescription);
  const cleanedRest = rest.replace(/\s+/g, " ").trim();
  let headline = trimToSentence(cleanedRest, 40, 100);
  if (summary && headline) {
    const norm = (s: string): string =>
      s
        .replace(/[.!?]+$/, "")
        .trim()
        .toLowerCase();
    const firstSentenceMatch = headline.match(/^([^.!?]+[.!?])\s*(.*)$/);
    if (firstSentenceMatch) {
      const firstSentence = firstSentenceMatch[1] ?? "";
      const remainder = firstSentenceMatch[2] ?? "";
      if (norm(firstSentence) === norm(summary)) {
        headline = remainder.trim();
      }
    }
  }
  let lead = [summary, headline]
    .filter(Boolean)
    .join(". ")
    .replace(/\.\s*\.+/g, ".");
  if (lead.length > 140) {
    // Prefer the last full sentence that fits; cut mid-sentence (with
    // an ellipsis) only when no sentence boundary lies past 40 chars.
    const window = lead.slice(0, 141);
    let boundary = -1;
    for (const m of window.matchAll(/[.!?](?=\s|$)/g)) {
      if (m.index >= 40) boundary = m.index;
    }
    lead = boundary > 0 ? lead.slice(0, boundary + 1) : fitLead(lead, 140);
  }
  // The headline returned by
  // trimToSentence can lose its trailing connector along with its
  // period ("...deployed on." → "...deployed"). Joining produces
  // "...deployed" without a closing dot. Naively appending "." would
  // recreate "...deployed on." after a re-test (the connector is
  // already gone, but adding "." would re-pattern-match). Workaround:
  // ensure terminator, then strip connector-tail, then re-terminate.
  // Iterate up to 3 times so a double-connector ("of the.") gets
  // collapsed to no-tail-and-then-period.
  //
  // A lead that ends on a "…" (single-char ellipsis) from `fitLead`
  // is left as-is - appending "." would
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
  //
  // Only when the short word is NOT a genuine sentence end of the spec
  // text: "Creates a new role." must keep "role." and not become
  // "Creates a new…".
  const stubRe = /\s+([a-z]{1,4}\.)$/;
  const stub = stubRe.exec(lead);
  if (stub && !endsSentenceIn(stub[1]!, summary + " " + cleanedRest)) {
    lead = lead.replace(stubRe, "…");
  }

  // argNames and outputShape are not rendered (the input and output
  // schemas carry them); the parameters stay for the callers.
  void argNames;
  void outputShape;

  // Optional curator-authored hint that prepends a sentence pointing
  // the agent at a curated sibling (e.g. the missing_updates
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

/** True when `word` (e.g. "role.") appears in `source` followed by whitespace or the end. */
function endsSentenceIn(word: string, source: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("(^|\\s)" + escaped + "(\\s|$)").test(source.replace(/\s+/g, " "));
}

interface RawOp {
  op: OperationObject;
  method: string;
  path: string;
}

export interface SkippedOp {
  operationId: string;
  method: string;
  path: string;
  /** The curated tool that covers this operation. */
  toolName: string;
}

function describe(spec: OpenApiSpec): { ops: OpDescriptor[]; skipped: SkippedOp[] } {
  // Build the full set of operationIds in the spec FIRST so we can
  // verify that every NAME_OVERRIDES key matches a real op. Without
  // this check an override whose key does not match would be dead code
  // and the heuristic name would be emitted silently.
  const allOperationIds = new Set<string>();
  for (const methods of Object.values(spec.paths)) {
    for (const op of Object.values(methods)) {
      if (op.operationId) allOperationIds.add(op.operationId);
    }
  }
  assertNameOverridesMatchSpec(allOperationIds);
  assertDescriptionHintsMatchSpec(allOperationIds);
  const postOperationIds = new Set<string>();
  for (const methods of Object.values(spec.paths)) {
    if (methods.post?.operationId) postOperationIds.add(methods.post.operationId);
  }
  assertReadishOperationsMatchSpec(postOperationIds);

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

  const curatedNames = curatedToolNames();

  const namesArr = deriveToolNames(
    raws.map((r) => ({ method: r.method, path: r.path })),
    curatedNames,
  );

  const out: OpDescriptor[] = [];
  const skipped: SkippedOp[] = [];
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
        curatedConflict: curatedNames.has(override),
      };
    }
    if (naming.curatedConflict) {
      skipped.push({ operationId: op.operationId!, method, path, toolName: naming.toolName });
      continue;
    }
    const toolName = fitToolName(naming.toolName);

    const params: ParameterObject[] = (op.parameters ?? []).map((p) => deref(spec, p));
    const requiredHeaders = params
      .filter((p) => p.in === "header" && p.required)
      .map((p) => p.name);
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

    const paramZod = new Map<string, ParamZod>();
    for (const p of [...pathParams, ...queryParams]) {
      const paging = p.in === "query" ? PAGING_PARAM_ZOD[p.name] : undefined;
      paramZod.set(
        paramKey(p),
        paging ? { zod: paging, action1Time: false } : paramZodSource(spec, p.schema),
      );
    }

    const summary = normalizeTitle(op.summary ?? op.operationId ?? "");
    const rawDescription = op.description ?? "";

    const { isReadOnly, isDestructive } = classifyOperation(method, op.operationId!);
    const isIdempotent =
      method === "GET" || method === "HEAD" || method === "PUT" || method === "DELETE";

    const hasBody = Boolean(op.requestBody);
    let bodyDescription = "";
    let bodyRequired = false;
    let bodyZod = "z.unknown()";
    let bodyContentTypes: string[] = [];
    if (hasBody && op.requestBody) {
      const rb = deref(spec, op.requestBody);
      bodyRequired = rb.required ?? false;
      bodyContentTypes = Object.keys(rb.content ?? {});
      const jsonSchema = rb.content?.["application/json"]?.schema;
      const schema = jsonSchema ?? rb.content?.[bodyContentTypes[0] ?? ""]?.schema;
      if (schema) {
        const name = isRef(schema) ? schema.$ref.split("/").pop() : undefined;
        bodyZod = bodyZodSource(spec, schema, method);
        bodyDescription = capDescription(rb.description) || "Request body";
        if (name) bodyDescription += " (schema: " + name + ")";
        else if (!jsonSchema) bodyDescription += " (" + bodyContentTypes.join(", ") + ")";
      } else {
        bodyDescription = rb.description ?? "Request body.";
      }
      // An empty JSON body ({"type": "null"} in the spec) carries nothing.
      if (bodyZod === "z.null()") bodyZod = "z.unknown()";
    }
    const unsupported = unsupportedReason(toolName, bodyContentTypes, requiredHeaders);

    const rawHasPagination =
      queryParams.some((p) => p.name === "limit") && queryParams.some((p) => p.name === "from");

    const outputShape = inferOutputShape(spec, op.responses, method, rawHasPagination);
    const outputSchema = outputSchemaSource(
      spec,
      op.responses,
      outputShape,
      classifyOperation(method, op.operationId!).isDestructive,
    );

    // Pagination-input args (auto_paginate, cursor) are only
    // meaningful when the response is also paginated. Non-JSON export
    // endpoints (CSV / HTML downloads - audit_export_get,
    // reportdata_*_export_get) accept `limit`+`from` as row-windowing
    // arguments but produce a single blob body. Emitting
    // `auto_paginate` / `cursor` on those is misleading - the agent
    // would set them expecting cursor-pagination semantics that
    // never engage. Drop pagination-args when the output is
    // single-shape OR ok-status.
    const hasPagination =
      rawHasPagination && outputShape !== "single" && outputShape !== "ok_status";

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

    const built = buildStructuredDescription(
      summary,
      rawDescription,
      argNames,
      outputShape,
      op.operationId!,
    );
    const permissions = built.permissions;
    const description = unsupported
      ? "Not supported by this server (see error text). " + built.description
      : built.description;

    out.push({
      name: toolName,
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
      bodyZod,
      unsupported,
      hasPagination,
      isReadOnly,
      isDestructive,
      isIdempotent,
      outputShape,
      outputSchema,
      permissions,
      paramZod,
    });
  }
  const seen = new Set<string>();
  for (const o of out) {
    if (seen.has(o.name)) throw new Error("Duplicate generated tool name: " + o.name);
    seen.add(o.name);
  }
  return { ops: out, skipped };
}

/**
 * Paging query inputs. The spec types `limit` as a number with minimum 1
 * and `from` as an integer without bounds; both count records, so they
 * are advertised and enforced as integers, `limit` within
 * [1, MAX_LIST_LIMIT] and `from` from 0, and invalid values never reach
 * the API.
 */
const PAGING_PARAM_ZOD: Record<string, string> = {
  limit: `z.number().int().min(1).max(${MAX_LIST_LIMIT})`,
  from: "z.number().int().min(0)",
};

function tsLiteral(s: string): string {
  return JSON.stringify(s);
}

function paramKey(p: ParameterObject): string {
  return p.in + ":" + p.name;
}

function emitParamSchema(p: ParameterObject, op: OpDescriptor): string {
  // Param descriptions are the single biggest contributor to tools/list
  // payload size; capDescription keeps them at a sentence or word
  // boundary within 90 characters.
  const desc = capDescription(p.description) || p.name;
  const required = p.required ?? p.in === "path";
  let zod = op.paramZod.get(paramKey(p))?.zod ?? "z.string()";
  zod += ".describe(" + tsLiteral(desc) + ")";
  if (!required) zod += ".optional()";
  return snakeCase(p.name) + ": " + zod;
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
    inputProps.push('org_id: z.string().min(1).optional().describe("Org UUID.")');
  }

  for (const p of op.pathParams) {
    if (p.name === orgIdSourceName) continue;
    inputProps.push(emitParamSchema(p, op));
  }

  for (const p of op.queryParams) {
    inputProps.push(emitParamSchema(p, op));
  }

  if (op.hasPagination) {
    // List contract (src/tools/generated/runtime.ts): every call reports
    // has_more / next_cursor; limit caps the items of one call.
    inputProps.push(
      'auto_paginate: z.boolean().optional().describe("Walk pages until limit or the size budget; then continue with next_cursor.")',
    );
    inputProps.push(
      'cursor: z.string().optional().describe("next_cursor of the previous call; takes precedence over from.")',
    );
  }

  if (op.hasBody) {
    let bodyZod = op.bodyZod;
    // Unsupported operations never send the body; keep the property so
    // existing callers stay schema-compatible, but do not require it.
    if (!op.bodyRequired || op.unsupported) bodyZod += ".optional()";
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
    inputProps.push('verbose: z.boolean().optional().describe("Skip per-item compactor.")');
  }

  if (op.isDestructive) {
    inputProps.push(
      'confirm: z.literal("YES").optional().describe("Required to execute. Exact string \\"YES\\".")',
    );
    inputProps.push(
      'dry_run: z.boolean().optional().describe("Default true (preview). Set false to execute.")',
    );
  }

  // All four annotations are always set explicitly, so hosts never fall
  // back to their own defaults.
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
        .map((p) => {
          const arg = `args[${tsLiteral(snakeCase(p.name))}]`;
          // Date-time values go out in the documented Action1 format.
          const value = op.paramZod.get(paramKey(p))?.action1Time
            ? `action1TimeQuery(${arg})`
            : arg;
          return `[${tsLiteral(p.name)}]: ${value}`;
        })
        .join(", ") +
      " }"
    : "undefined";

  const outputSchemaName = op.outputSchema;

  const body =
    `  server.registerTool(\n` +
    `    ${tsLiteral(op.name)},\n` +
    `    {\n` +
    `      title: ${titleEscaped},\n` +
    `      description: ${descEscaped},\n` +
    (inputProps.length
      ? `      inputSchema: z.object({\n        ${inputProps.join(",\n        ")},\n      }),\n`
      : `      inputSchema: z.object({}),\n`) +
    `      outputSchema: ${outputSchemaName},\n` +
    `      annotations: { ${annotations.join(", ")} },\n` +
    `    },\n` +
    (op.unsupported
      ? `    () => Promise.resolve(errorResult(${tsLiteral(op.unsupported)})),\n  );`
      : handlerSource(op, pathExpr, queryExpr, inputProps.length > 0));

  return body;
}

function handlerSource(
  op: OpDescriptor,
  pathExpr: string,
  queryExpr: string,
  hasInputs: boolean,
): string {
  return (
    (!hasInputs
      ? `    async (_rawArgs, ctx) => {\n      const args = _rawArgs as Record<string, unknown>;\n      void args;\n`
      : `    async (rawArgs, ctx) => {\n      const args = rawArgs as Record<string, unknown>;\n`) +
    `      return runGenerated({\n` +
    `        client,\n` +
    `        toolName: ${tsLiteral(op.name)},\n` +
    `        method: ${tsLiteral(op.method)},\n` +
    `        path: ${pathExpr},\n` +
    `        queryParams: ${queryExpr},\n` +
    `        body: ${op.hasBody ? "args.body" : "undefined"},\n` +
    `        autoPaginate: ${op.hasPagination ? "Boolean(args.auto_paginate)" : "false"},\n` +
    `        cursor: ${op.hasPagination ? "args.cursor as (string | undefined)" : "undefined"},\n` +
    `        paginated: ${op.hasPagination ? "true" : "false"},\n` +
    `        destructive: ${op.isDestructive ? '{ confirm: args.confirm as ("YES" | undefined), dry_run: args.dry_run as (boolean | undefined) }' : "undefined"},\n` +
    `        responseFormat: ${op.isReadOnly ? 'args.response_format as ("markdown" | "json" | undefined)' : "undefined"},\n` +
    `        verbose: ${op.isReadOnly ? "(args.verbose as boolean | undefined)" : "undefined"},\n` +
    `        signal: ctx.mcpReq.signal,\n` +
    `      });\n` +
    `    },\n` +
    `  );`
  );
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

function emitFile(ops: OpDescriptor[], sha: string, skipped: SkippedOp[]): string {
  const skippedCount = skipped.length;
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
    'import type { McpServer } from "@modelcontextprotocol/server";\n' +
    'import type { Action1Client } from "../../client/action1Client.js";\n' +
    'import { runGenerated } from "./runtime.js";\n' +
    'import { resolveOrgId } from "../../config.js";\n' +
    (ops.some((o) => [...o.paramZod.values()].some((z) => z.action1Time))
      ? 'import { action1TimeQuery, action1TimeSchema } from "../../spec/time.js";\n'
      : "") +
    helpersImport(ops) +
    manifestSource(ops, skipped);

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
        "(server: McpServer, " +
        (op.unsupported ? "_client" : "client") +
        ": Action1Client): void {";
      return (
        sig +
        "\n" +
        emitTool(op)
          .split("\n")
          .map((l) => "  " + l)
          .join("\n") +
        "\n}"
      );
    })
    .join("\n\n");

  return header + fns + footer;
}

/** Import of the helpers the emitted tools use (only those, so lint stays clean). */
function helpersImport(ops: OpDescriptor[]): string {
  const candidates = [
    "cursorListOutputShape",
    "listOutputShape",
    "okStatusOutputShape",
    "singleObjectOutputShape",
  ];
  const used = candidates.filter((name) =>
    ops.some((o) => new RegExp("\\b" + name + "\\b").test(o.outputSchema)),
  );
  if (ops.some((o) => o.unsupported)) used.push("errorResult");
  used.sort();
  return "import {\n" + used.map((n) => "  " + n + ",\n").join("") + '} from "../helpers.js";\n\n';
}

function manifestSource(ops: OpDescriptor[], skipped: SkippedOp[]): string {
  const row = (fields: Record<string, unknown>): string =>
    "  { " +
    Object.entries(fields)
      .map(([k, v]) => k + ": " + JSON.stringify(v))
      .join(", ") +
    " },";
  return (
    "/** One entry per emitted tool, in registration order. */\n" +
    "export interface GeneratedToolMeta {\n" +
    "  name: string;\n  operationId: string;\n  method: string;\n  path: string;\n" +
    "  destructive: boolean;\n  unsupported: boolean;\n}\n\n" +
    "export const GENERATED_TOOL_MANIFEST: readonly GeneratedToolMeta[] = [\n" +
    ops
      .map((o) =>
        row({
          name: o.name,
          operationId: o.operationId,
          method: o.method,
          path: o.path,
          destructive: o.isDestructive,
          unsupported: o.unsupported !== null,
        }),
      )
      .join("\n") +
    "\n];\n\n" +
    "/** Spec operations not emitted because a curated tool of the same name covers them. */\n" +
    "export const GENERATED_SKIPPED_OPERATIONS: readonly {\n" +
    "  operationId: string;\n  method: string;\n  path: string;\n  toolName: string;\n}[] = [\n" +
    skipped.map((sk) => row({ ...sk })).join("\n") +
    "\n];\n\n"
  );
}

async function main(): Promise<void> {
  const sha = checkSha();
  const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8")) as OpenApiSpec;
  const { ops, skipped } = describe(spec);
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  // Format with the repo's Prettier config so the committed file passes
  // `npm run format:check` and the CI codegen roundtrip at the same time.
  const prettier = await import("prettier");
  const options = await prettier.resolveConfig(OUT_FILE);
  const out = await prettier.format(emitFile(ops, sha, skipped), {
    ...options,
    filepath: OUT_FILE,
  });
  // Field names and enum values the curated tools read (src/spec/).
  // Resolved before anything is written, so a contract path that no
  // longer exists in the spec aborts the run.
  const specModule = await prettier.format(specModuleSource(resolveContract(spec), sha), {
    ...(await prettier.resolveConfig(SPEC_MODULE_FILE)),
    filepath: SPEC_MODULE_FILE,
  });
  writeFileSync(OUT_FILE, out, "utf8");
  mkdirSync(dirname(SPEC_MODULE_FILE), { recursive: true });
  writeFileSync(SPEC_MODULE_FILE, specModule, "utf8");
  process.stdout.write(
    "Generated " +
      ops.length +
      " tools to " +
      OUT_FILE +
      " (spec sha: " +
      sha.slice(0, 12) +
      "); skipped " +
      skipped.length +
      " due to curated-name conflicts.\n",
  );
}

// Only run codegen when invoked as a script (e.g. `tsx src/codegen/generate.ts`
// via `npm run codegen`). Skipping the side-effect on bare import lets unit
// tests dynamically `import("...generate.js")` the helpers (fitLead, fitTitle)
// without overwriting `src/tools/generated/index.ts` mid-run.
const invokedAsScript =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (invokedAsScript) {
  main().catch((err: unknown) => {
    process.stderr.write(String(err instanceof Error ? (err.stack ?? err.message) : err) + "\n");
    process.exit(1);
  });
}
