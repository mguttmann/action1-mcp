import { z } from "zod";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import type { AppConfig, Toolset } from "../config.js";
import { log } from "../utils/logger.js";
import {
  runWithRequestContext,
  STDIO_CALLER,
  type CallerIdentity,
  type RequestContext,
} from "../utils/requestContext.js";
import { GENERATED_TOOL_MANIFEST } from "./generated/index.js";

// Server-wide registration policy and call instrumentation. Installed on
// a fresh McpServer before any tool is registered, so every tool, curated
// or generated, gets the same treatment from one place:
//   - ACTION1_TOOLSETS decides which tools are registered at all;
//   - input schemas are strict: an unknown or misspelled argument is a
//     validation error instead of being dropped silently;
//   - every tools/call writes one `tool_call` log event with a
//     correlation id shared by all log lines of that call.

const GENERATED_NAMES = new Set(GENERATED_TOOL_MANIFEST.map((t) => t.name));

interface ToolMeta {
  name: string;
  readOnly: boolean;
}

/**
 * Whether a tool belongs to the configured toolsets. An empty list or
 * `all` keeps every tool; `read` keeps readOnlyHint:true tools; `curated`
 * keeps tools that are not generated from the OpenAPI spec. Several
 * values combine as an intersection.
 */
export function toolSelected(toolsets: readonly Toolset[], tool: ToolMeta): boolean {
  for (const set of toolsets) {
    if (set === "read" && !tool.readOnly) return false;
    if (set === "curated" && GENERATED_NAMES.has(tool.name)) return false;
  }
  return true;
}

/**
 * Patch `server.registerTool` to apply ACTION1_TOOLSETS and to make every
 * object input schema strict. Must run before the first registration.
 */
export function applyToolPolicy(server: McpServer, cfg: Pick<AppConfig, "toolsets">): void {
  const register = server.registerTool.bind(server) as (
    name: string,
    config: { inputSchema?: unknown; annotations?: { readOnlyHint?: boolean } },
    cb: unknown,
  ) => unknown;
  const patched = (
    name: string,
    config: { inputSchema?: unknown; annotations?: { readOnlyHint?: boolean } },
    cb: unknown,
  ): unknown => {
    const readOnly = config.annotations?.readOnlyHint === true;
    if (!toolSelected(cfg.toolsets, { name, readOnly })) return undefined;
    const inputSchema =
      config.inputSchema instanceof z.ZodObject ? config.inputSchema.strict() : config.inputSchema;
    return register(name, { ...config, inputSchema }, cb);
  };
  server.registerTool = patched as typeof server.registerTool;
}

type ToolsCallHandler = (
  request: { params: { name: string } },
  ctx: unknown,
) => CallToolResult | Promise<CallToolResult>;

/** The cancellation signal the SDK hands to a request handler, if any. */
function requestSignal(ctx: unknown): AbortSignal | undefined {
  const signal = (ctx as { mcpReq?: { signal?: unknown } } | undefined)?.mcpReq?.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

/**
 * Wrap the SDK's tools/call handler (installed lazily on the first tool
 * registration) so each call runs in its own request context and ends
 * with one `tool_call` event. Covers input validation failures and
 * unknown tools too, because it wraps the whole request handler. The
 * resources/read handler gets a request context as well (without the
 * tool_call event), so its upstream calls carry the request signal.
 * Must run before the first registration.
 */
export function instrumentToolCalls(
  server: McpServer,
  caller: CallerIdentity = STDIO_CALLER,
): void {
  const protocol = server.server as unknown as {
    setRequestHandler: (method: string, ...rest: unknown[]) => void;
  };
  const setHandler = protocol.setRequestHandler.bind(protocol);
  protocol.setRequestHandler = (method: string, ...rest: unknown[]): void => {
    if (method === "tools/call" && rest.length === 1 && typeof rest[0] === "function") {
      const handler = rest[0] as ToolsCallHandler;
      setHandler(method, (request: { params: { name: string } }, ctx: unknown) =>
        runWithRequestContext(
          request.params.name,
          (rc) => timedCall(rc, () => handler(request, ctx)),
          requestSignal(ctx),
          caller,
        ),
      );
      return;
    }
    if (method === "resources/read" && rest.length === 1 && typeof rest[0] === "function") {
      const handler = rest[0] as (request: { params: { uri: string } }, ctx: unknown) => unknown;
      setHandler(method, (request: { params: { uri: string } }, ctx: unknown) =>
        runWithRequestContext(
          `resource:${request.params.uri}`,
          () => handler(request, ctx),
          requestSignal(ctx),
          caller,
        ),
      );
      return;
    }
    setHandler(method, ...rest);
  };
}

type Outcome = "ok" | "error" | "dry_run" | "refused";

async function timedCall(
  rc: RequestContext,
  call: () => CallToolResult | Promise<CallToolResult>,
): Promise<CallToolResult> {
  const started = performance.now();
  let outcome: Outcome = "error";
  let errorText: string | undefined;
  try {
    const result = await call();
    if (result.isError) {
      outcome = rc.guard === "refused" ? "refused" : "error";
      const first = result.content?.[0];
      if (first && first.type === "text") errorText = first.text.slice(0, 300);
    } else {
      outcome = rc.guard === "dry_run" ? "dry_run" : "ok";
    }
    return result;
  } catch (err) {
    errorText = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    throw err;
  } finally {
    const meta: Record<string, unknown> = {
      tool: rc.tool,
      duration_ms: Math.round(performance.now() - started),
      outcome,
      upstream_status: rc.upstreamStatus ?? null,
      attempts: rc.attempts,
      org: rc.orgId ?? null,
      caller: rc.caller ?? null,
    };
    if (errorText !== undefined) meta.error = errorText;
    if (outcome === "error") log.warn("tool_call", meta);
    else log.info("tool_call", meta);
  }
}
