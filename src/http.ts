import { createHash, randomUUID } from "node:crypto";
import {
  NodeStreamableHTTPServerTransport,
  toNodeHandler,
  toWebRequest,
} from "@modelcontextprotocol/node";
import { createMcpHandler, isLegacyRequest, type McpServer } from "@modelcontextprotocol/server";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { Action1Client } from "./client/action1Client.js";
import { ConfigError, loadConfig, normaliseHostname, type AppConfig } from "./config.js";
import { buildServer, SERVER_VERSION } from "./server.js";
import { checkBearerHeader } from "./utils/bearerAuth.js";
import { log } from "./utils/logger.js";
import type { CallerIdentity } from "./utils/requestContext.js";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);
const WILDCARD_HOSTNAMES = new Set(["0.0.0.0", "::"]);

// Bare-bones in-memory rate limit. Each remote IP gets `max` requests
// per `windowMs` rolling window; once exceeded the request is rejected
// with 429 BEFORE the Host/Origin and Bearer checks run, so token
// guesses cannot iterate through the keyspace for free. In-process
// state fits the single-replica deployments this server targets.
const DEFAULT_RATE_WINDOW_MS = 60_000;
const DEFAULT_RATE_MAX = 60;
const RATE_CLEANUP_INTERVAL_MS = 5 * 60_000;
// Hard cap on the bucket map so a burst of unique IPs between cleanup
// ticks cannot blow up RSS; the oldest bucket is evicted first.
const RATE_MAP_MAX_ENTRIES = 10_000;

// Rejection audit lines (http_auth_failed, http_host_rejected,
// http_origin_rejected, http_rate_limited) are written at most once per
// event, reason and peer per window; the next line reports how many
// were suppressed in between. Bounded like the rate-limit map.
const REJECTION_LOG_WINDOW_MS = 60_000;
const REJECTION_LOG_MAX_ENTRIES = 10_000;
const USER_AGENT_MAX_CHARS = 200;

/** Short, non-reversible id of a bearer token for logs (SHA-256 prefix). */
export function tokenId(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

export interface HttpAppDeps {
  /** Upstream client shared by all requests (one OAuth token cache). */
  client?: Action1Client;
  /** Builds the per-request MCP server; tests inject failures here. */
  serverFactory?: (client: Action1Client, caller: CallerIdentity) => McpServer;
  rateLimit?: { max: number; windowMs: number };
}

function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname);
}

/** A start-up refusal reported like an invalid setting (one line, no stack). */
function startupRefusal(message: string): ConfigError {
  return new ConfigError([message], message);
}

/**
 * Throws when the HTTP settings must not be served. Called by
 * createHttpApp, so a misconfigured app can never be built.
 */
export function assertHttpStartupConfig(http: AppConfig["http"]): void {
  const bind = normaliseHostname(http.host);
  if (!http.token) {
    if (!http.allowNoAuth) {
      throw startupRefusal(
        "Refusing to start: HTTP transport requires MCP_HTTP_TOKEN (>= 16 chars, e.g. `openssl rand -hex 32`). " +
          "For local development on a loopback bind only, MCP_HTTP_ALLOW_NO_AUTH=true disables authentication.",
      );
    }
    if (!isLoopback(bind)) {
      throw startupRefusal(
        `Refusing to start: MCP_HTTP_ALLOW_NO_AUTH=true is only accepted on a loopback bind (127.0.0.1 / localhost / ::1), not on '${http.host}'. Set MCP_HTTP_TOKEN.`,
      );
    }
  }
  if (WILDCARD_HOSTNAMES.has(bind) && http.allowedHosts.length === 0) {
    throw startupRefusal(
      `Refusing to start: HTTP transport binds to the wildcard address '${http.host}' but MCP_HTTP_ALLOWED_HOSTS is empty. ` +
        "List the hostnames clients use to reach this server (e.g. MCP_HTTP_ALLOWED_HOSTS=mcp.example.com); every other Host header is rejected.",
    );
  }
}

function jsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message, ...(data ? { data } : {}) },
    id: null,
  });
}

function sendInternalError(res: Response, err: unknown): void {
  const correlationId = randomUUID();
  log.error("http_request_handler_failed", {
    correlation_id: correlationId,
    error: err instanceof Error ? err.message : String(err),
  });
  if (!res.headersSent) {
    jsonRpcError(res, 500, -32603, "Internal server error", { correlation_id: correlationId });
  }
}

/**
 * Build the Express app that serves Streamable HTTP (stateless, JSON
 * responses) on POST /mcp. Pure: no listen(), no signal handlers, so
 * tests exercise exactly the middleware chain production runs.
 *
 * Request pipeline on /mcp:
 *   1. rate limit     drop excess before doing real work
 *   2. Host + Origin  DNS-rebinding defence, regardless of auth
 *   3. Bearer token   constant-time compare (POST only)
 *   4. JSON body      1 MB limit, parsed only after 1-3 passed
 *   5. MCP handler    one McpServer per request (the SDK binds a server
 *                     instance to one transport); the Action1Client and
 *                     its token cache are shared
 */
export function createHttpApp(cfg: AppConfig, deps: HttpAppDeps = {}): Express {
  const http = cfg.http;
  assertHttpStartupConfig(http);
  if (!http.token) {
    log.warn("http_auth_disabled", {
      env: "MCP_HTTP_ALLOW_NO_AUTH",
      effect:
        "POST /mcp accepts requests without a Bearer token: every local process (and any reverse proxy in front of this port) gets full tool access. Local development only.",
    });
  }

  const client = deps.client ?? new Action1Client(cfg);
  const serverFactory =
    deps.serverFactory ??
    ((c: Action1Client, caller: CallerIdentity) => buildServer(c, { config: cfg, caller }).server);
  const acceptedTokenId = http.token ? tokenId(http.token) : undefined;

  const peerOf = (req: Request): string => req.ip ?? req.socket.remoteAddress ?? "unknown";

  const callerOf = (req: Request): CallerIdentity => {
    const caller: CallerIdentity = { transport: "http", remote_ip: peerOf(req) };
    const ua = req.headers["user-agent"];
    if (typeof ua === "string" && ua !== "") caller.user_agent = ua.slice(0, USER_AGENT_MAX_CHARS);
    if (acceptedTokenId) caller.token_id = acceptedTokenId;
    return caller;
  };

  const rejectionLog = new Map<string, { windowStart: number; suppressed: number }>();
  const logRejection = (
    req: Request,
    event: string,
    status: number,
    extra: Record<string, string> = {},
  ): void => {
    const ip = peerOf(req);
    const key = `${event}|${extra.reason ?? ""}|${ip}`;
    const now = Date.now();
    const entry = rejectionLog.get(key);
    if (entry && now - entry.windowStart < REJECTION_LOG_WINDOW_MS) {
      entry.suppressed += 1;
      return;
    }
    if (!entry && rejectionLog.size >= REJECTION_LOG_MAX_ENTRIES) {
      const oldestKey = rejectionLog.keys().next().value;
      if (oldestKey !== undefined) rejectionLog.delete(oldestKey);
    }
    rejectionLog.delete(key);
    rejectionLog.set(key, { windowStart: now, suppressed: 0 });
    const ua = req.headers["user-agent"];
    log.audit(event, {
      status,
      remote_ip: ip,
      ...(typeof ua === "string" && ua !== ""
        ? { user_agent: ua.slice(0, USER_AGENT_MAX_CHARS) }
        : {}),
      ...extra,
      suppressed_since_last: entry?.suppressed ?? 0,
    });
  };
  const rateMax = deps.rateLimit?.max ?? DEFAULT_RATE_MAX;
  const rateWindowMs = deps.rateLimit?.windowMs ?? DEFAULT_RATE_WINDOW_MS;

  // Host names a legitimate request can carry. A DNS-rebinding page
  // reaches us under the attacker's own hostname, which is never in
  // this set. Ports are ignored: they add nothing against rebinding and
  // vary behind proxies.
  const allowedHostnames = new Set<string>(LOOPBACK_HOSTNAMES);
  const bind = normaliseHostname(http.host);
  if (!WILDCARD_HOSTNAMES.has(bind)) allowedHostnames.add(bind);
  for (const h of http.allowedHosts) allowedHostnames.add(h);

  const originAllowed = (origin: string): boolean => {
    if (http.allowedOrigins.length > 0) return http.allowedOrigins.includes(origin);
    try {
      return isLoopback(normaliseHostname(new URL(origin).hostname));
    } catch {
      return false; // "null" (opaque origin) and garbage
    }
  };

  const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap.entries()) {
      if (entry.resetAt < now) rateLimitMap.delete(ip);
    }
  }, RATE_CLEANUP_INTERVAL_MS).unref();

  const rateLimit = (req: Request, res: Response, next: NextFunction): void => {
    // `req.ip` honours the `trust proxy` setting (TRUST_PROXY).
    const ip = peerOf(req);
    const now = Date.now();
    const entry = rateLimitMap.get(ip);
    if (!entry || entry.resetAt <= now) {
      if (!entry && rateLimitMap.size >= RATE_MAP_MAX_ENTRIES) {
        const oldestKey = rateLimitMap.keys().next().value;
        if (oldestKey !== undefined) rateLimitMap.delete(oldestKey);
      }
      rateLimitMap.set(ip, { count: 1, resetAt: now + rateWindowMs });
      next();
      return;
    }
    entry.count += 1;
    if (entry.count > rateMax) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      logRejection(req, "http_rate_limited", 429);
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({
        error: "rate_limit_exceeded",
        message: `Too many requests. Limit: ${rateMax} req/${rateWindowMs / 1000}s.`,
        retry_after: retryAfter,
      });
      return;
    }
    next();
  };

  const checkHostAndOrigin = (req: Request, res: Response, next: NextFunction): void => {
    const hostHeader = req.headers.host;
    if (!hostHeader || !allowedHostnames.has(normaliseHostname(hostHeader))) {
      logRejection(req, "http_host_rejected", 403, { host: (hostHeader ?? "").slice(0, 255) });
      res.status(403).json({
        error:
          "Host header not allowed. Add the hostname to MCP_HTTP_ALLOWED_HOSTS if it is yours.",
      });
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !originAllowed(origin)) {
      logRejection(req, "http_origin_rejected", 403, { origin: origin.slice(0, 255) });
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }
    next();
  };

  const requireBearer = (req: Request, res: Response, next: NextFunction): void => {
    if (!http.token) {
      next();
      return;
    }
    const verdict = checkBearerHeader(req.headers.authorization, http.token);
    if (verdict === "ok") {
      next();
      return;
    }
    logRejection(req, "http_auth_failed", 401, { reason: verdict });
    res.status(401).json({
      error: verdict === "missing" ? "Bearer token required" : "Invalid bearer token",
    });
  };

  const app = express();
  app.set("trust proxy", http.trustProxy);
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    // Liveness only; deliberately says nothing about auth configuration.
    res.json({ ok: true, service: "action1-mcp-server", version: SERVER_VERSION });
  });

  app.get("/readyz", (_req, res) => {
    // Readiness without an upstream call: the configuration the tools
    // read at call time must load, and the Action1 token must not be in
    // a failing state. Like /healthz it reveals no error details.
    let config: "ok" | "invalid" = "ok";
    try {
      loadConfig();
    } catch {
      config = "invalid";
    }
    const token = client.tokens.state();
    const ready = config === "ok" && token !== "failing";
    res.status(ready ? 200 : 503).json({
      ready,
      service: "action1-mcp-server",
      version: SERVER_VERSION,
      checks: { config, token },
    });
  });

  app.use("/mcp", rateLimit, checkHostAndOrigin);

  // MCP 2026-07-28 (server/discover and the per-request envelope). The
  // 2025-era requests keep the hand-wired stateless transport below, so
  // existing clients see exactly the previous behaviour. The caller
  // identity reaches the per-request factory through authInfo.extra.
  const modern = createMcpHandler(
    (ctx) => {
      const caller = ctx.authInfo?.extra?.caller as CallerIdentity | undefined;
      return serverFactory(client, caller ?? { transport: "http" });
    },
    {
      legacy: "reject",
      onerror: (error) => log.warn("http_modern_handler_error", { error: error.message }),
    },
  );
  const modernNode = toNodeHandler(modern, {
    onerror: (error) => log.warn("http_modern_handler_error", { error: error.message }),
  });

  app.post(
    "/mcp",
    requireBearer,
    express.json({ limit: "1mb" }),
    (req: Request, res: Response): void => {
      void (async () => {
        try {
          if (!(await isLegacyRequest(await toWebRequest(req, req.body), req.body))) {
            (req as Request & { auth?: unknown }).auth = {
              token: "",
              clientId: "http",
              scopes: [],
              extra: { caller: callerOf(req) },
            };
            await modernNode(req, res, req.body);
            return;
          }
          const server = serverFactory(client, callerOf(req));
          const transport = new NodeStreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
          });
          res.on("close", () => {
            void transport.close();
            void server.close();
          });
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
        } catch (err) {
          sendInternalError(res, err);
        }
      })();
    },
  );

  // Stateless server: no SSE stream to open (GET) and no session to
  // terminate (DELETE), so the spec answer is 405.
  app.all("/mcp", (_req, res) => {
    res.setHeader("Allow", "POST");
    jsonRpcError(res, 405, -32000, "Method not allowed.");
  });

  // Last-resort error handler: body-parser failures and anything thrown
  // synchronously. Never echoes internal error text or stack traces.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const type = (err as { type?: unknown } | null)?.type;
    if (type === "entity.parse.failed") {
      jsonRpcError(res, 400, -32700, "Parse error: request body is not valid JSON.");
      return;
    }
    if (type === "entity.too.large") {
      jsonRpcError(res, 413, -32600, "Request body exceeds the 1 MB limit.");
      return;
    }
    sendInternalError(res, err);
  });

  return app;
}
