// A fake Action1 API that answers every documented operation from the
// vendored OpenAPI spec.
//
// A request is matched against the spec's path templates (method and
// path, literal segments preferred over parameters), and the answer is
// a minimal record of the operation's documented 200 response schema
// (`schemaExample`). List envelopes are closed (`next_page: ""`), so a
// walker stops after one page. A request to a path the spec does not
// document gets a 404 and is recorded with `template: undefined`, so a
// test can assert that tools only call documented operations.
//
// Sweeps over the tool registry use this stub so that a new operation
// in a refreshed spec is covered without a hand-written fixture.

import { vi } from "vitest";
import type { JsonSchema } from "../../src/codegen/zodEmit.js";
import { SPEC, schemaExample } from "./specFixtures.js";

const API_PREFIX = "/api/3.0";

interface SpecOperation {
  method: string;
  template: string;
  re: RegExp;
  literals: number;
  response: JsonSchema | undefined;
}

interface SpecDoc {
  paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
  components: { responses?: Record<string, unknown> };
}

const DOC = SPEC as unknown as SpecDoc;

function responseSchema(responses: Record<string, unknown> | undefined): JsonSchema | undefined {
  let ok = responses?.["200"] as { $ref?: string; content?: Record<string, unknown> } | undefined;
  if (ok?.$ref) {
    const name = /^#\/components\/responses\/(.+)$/.exec(ok.$ref)?.[1];
    ok = name ? (DOC.components.responses?.[name] as typeof ok) : undefined;
  }
  const json = ok?.content?.["application/json"] as { schema?: JsonSchema } | undefined;
  return json?.schema;
}

function buildOperations(): SpecOperation[] {
  const out: SpecOperation[] = [];
  for (const [template, item] of Object.entries(DOC.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!op || typeof op !== "object" || !("responses" in op)) continue;
      const segs = template.split("/");
      out.push({
        method: method.toUpperCase(),
        template,
        re: templateRe(template),
        literals: segs.filter((s) => s !== "" && !s.startsWith("{")).length,
        response: responseSchema(op.responses),
      });
    }
  }
  return out;
}

/** Every documented operation of the vendored spec. */
export const SPEC_OPERATIONS: readonly SpecOperation[] = buildOperations();

/**
 * Endpoints curated tools call although the spec does not document them
 * (src/codegen/spec/known-undocumented-endpoints.json, background in
 * docs/GOTCHAS.md), answered like their documented equivalent.
 */
export const KNOWN_UNDOCUMENTED_ALIASES: Readonly<Record<string, string>> = {
  "POST /policies/instances/{orgId}": "POST /automations/instances/{orgId}",
  "GET /endpoints/managed/{orgId}/{endpointId}/vulnerabilities": "GET /vulnerabilities/{orgId}",
};

function templateRe(template: string): RegExp {
  const pattern = template
    .split("/")
    .map((s) => (/^\{[^}]+\}$/.test(s) ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${pattern}$`, "i");
}

const ALIASES = Object.entries(KNOWN_UNDOCUMENTED_ALIASES).map(([from, to]) => {
  const [method, template] = from.split(" ") as [string, string];
  const [toMethod, toTemplate] = to.split(" ") as [string, string];
  return { method, template, re: templateRe(template), toMethod, toTemplate };
});

/** The known-undocumented endpoint a request hits, with its documented equivalent. */
function aliasFor(method: string, path: string) {
  return ALIASES.find((a) => a.method === method.toUpperCase() && a.re.test(path));
}

/**
 * The spec operation a request hits, or undefined for an undocumented
 * path. HEAD is answered like the GET of the same path.
 */
export function specOperationFor(method: string, path: string): SpecOperation | undefined {
  const m = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  return SPEC_OPERATIONS.filter((op) => op.method === m && op.re.test(path)).sort(
    (a, b) => b.literals - a.literals,
  )[0];
}

/** The documented 200 answer of an operation, with a closed list envelope. */
export function specResponseFor(op: SpecOperation | undefined): unknown {
  if (!op?.response) return {};
  const body = schemaExample(op.response);
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const obj = body as Record<string, unknown>;
    if ("next_page" in obj) obj.next_page = "";
    if ("prev_page" in obj) obj.prev_page = "";
    if (Array.isArray(obj.items) && "total_items" in obj) {
      obj.total_items = String(obj.items.length);
    }
  }
  return body;
}

/** One request the fake API received (token requests are not recorded). */
export interface StubCall {
  method: string;
  /** Path below the API base, e.g. `/endpoints/managed/<org>`. */
  path: string;
  query: URLSearchParams;
  body: unknown;
  /** Matched spec path template; undefined for an undocumented path. */
  template: string | undefined;
  /** Known-undocumented endpoint hit (answered like its documented equivalent). */
  knownUndocumented?: string;
}

export interface SpecStubOptions {
  /** HTTP status to answer instead of 200 (the body is then an error envelope). */
  status?: (call: StubCall) => number | undefined;
  /** Rewrite the documented answer before it is sent. */
  transform?: (body: unknown, call: StubCall) => unknown;
  /** Error body for a non-2xx `status`. */
  errorBody?: (call: StubCall) => unknown;
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Install the spec-backed fake API as the global fetch; returns the call log. */
export function stubSpecApi(opts: SpecStubOptions = {}): StubCall[] {
  const calls: StubCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const href = String(input);
      // The server's own token request is form-encoded and carries no
      // bearer token; an API call to the same path (raw_request) does.
      const auth = (init.headers as Record<string, string> | undefined)?.Authorization;
      if (href.endsWith("/oauth2/token") && auth === undefined) {
        return Response.json({ access_token: "tkn", expires_in: 3600 });
      }
      const url = new URL(href);
      const path = url.pathname.startsWith(API_PREFIX)
        ? url.pathname.slice(API_PREFIX.length)
        : url.pathname;
      const method = (init.method ?? "GET").toUpperCase();
      const alias = specOperationFor(method, path) ? undefined : aliasFor(method, path);
      const op = alias
        ? SPEC_OPERATIONS.find(
            (o) => o.method === alias.toMethod && o.template === alias.toTemplate,
          )
        : specOperationFor(method, path);
      const call: StubCall = {
        method,
        path,
        query: url.searchParams,
        body: typeof init.body === "string" ? parseBody(init.body) : undefined,
        template: alias ? undefined : op?.template,
        ...(alias ? { knownUndocumented: `${alias.method} ${alias.template}` } : {}),
      };
      calls.push(call);
      // A forced error status applies to undocumented paths too, so a
      // sweep over free-form paths sees the status it asked for.
      const status = opts.status?.(call);
      if (status !== undefined && status >= 300) {
        const body = opts.errorBody?.(call) ?? {
          type: "Error",
          status,
          developer_message: "stub error",
        };
        return Response.json(body, { status });
      }
      if (!op) return Response.json({ error: "undocumented path", path }, { status: 404 });
      const documented = specResponseFor(op);
      const body = opts.transform ? opts.transform(documented, call) : documented;
      return Response.json(body);
    }),
  );
  return calls;
}

/**
 * Transform for sweeps that call the waiting tools: automation instances
 * report a final status (the spec's first enum value is Pending, which
 * would keep a waiter polling until its timeout).
 */
export function finishAutomations(body: unknown, call: StubCall): unknown {
  if (!call.path.startsWith("/automations/instances/")) return body;
  if (body && typeof body === "object" && !Array.isArray(body) && "status" in body) {
    return { ...body, status: "Success" };
  }
  return body;
}
