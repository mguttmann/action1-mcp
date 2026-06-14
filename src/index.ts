#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { pathToFileURL } from "node:url";
import { Action1Client } from "./client/action1Client.js";
import { buildServer } from "./server.js";
import { loadConfig } from "./config.js";
import { log } from "./utils/logger.js";
import { checkBearerHeader } from "./utils/bearerAuth.js";

/**
 * Map the operator-supplied TRUST_PROXY env value to Express's
 * `trust proxy` setting. Behind nginx / Cloudflare / k8s ingress,
 * `req.ip` would otherwise be the proxy peer and every user would
 * share a rate-limit bucket. Operators MUST only set this when an
 * upstream proxy is the ONLY ingress — trusting X-Forwarded-For from
 * arbitrary clients lets them spoof `req.ip` and bypass per-IP rate
 * limits.
 *
 * Accepted values match Express's `trust proxy` setting:
 *   - 'false' (default): trust no proxy; `req.ip` = socket peer
 *   - 'true':            trust every proxy hop (X-Forwarded-For chain)
 *   - 'loopback':        trust 127.0.0.1 / ::1 / linklocal
 *   - integer (digits):  trust N hops from the socket peer
 *   - anything else:     passed through verbatim (CIDR / IP list)
 *
 * Exported for unit-tests so a documentation change to the accepted
 * value-set is observable instead of silently coerced.
 */
export function parseTrustProxy(
  raw: string | undefined,
): boolean | string | number {
  const v = (raw ?? "false").trim();
  if (v === "" || v === "false") return false;
  if (v === "true") return true;
  if (/^\d+$/.test(v)) return Number.parseInt(v, 10);
  return v;
}

interface CliArgs {
  http: boolean;
  port?: number;
  host?: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { http: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--http") args.http = true;
    else if (a === "--stdio") args.http = false;
    else if (a === "--port" && argv[i + 1]) {
      args.port = Number.parseInt(argv[++i]!, 10);
    } else if (a === "--host" && argv[i + 1]) {
      args.host = argv[++i];
    } else if (a === "--help" || a === "-h") {
      args.help = true;
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(
    [
      "action1-mcp - MCP server for the Action1 RMM REST API",
      "",
      "Usage:",
      "  action1-mcp                 Start with stdio transport (default).",
      "  action1-mcp --http          Start with Streamable HTTP transport (stateless).",
      "  action1-mcp --http --port 3000 --host 127.0.0.1",
      "",
      "Environment:",
      "  Required:    ACTION1_BASE_URL, ACTION1_CLIENT_ID, ACTION1_CLIENT_SECRET",
      "  Recommended: ACTION1_ORG_ID  (otherwise every tool call must pass org_id)",
      "  Optional:    ACTION1_DEFAULT_TIMEOUT_MINUTES, ACTION1_DEFAULT_RETRY_MINUTES,",
      "               ACTION1_LOG_LEVEL, ACTION1_ALLOW_DESTRUCTIVE,",
      "               PORT, HOST, MCP_HTTP_ALLOWED_ORIGINS, MCP_HTTP_TOKEN",
      "",
      "See .env.example for descriptions.",
      "",
    ].join("\n"),
  );
}

async function runStdio(): Promise<void> {
  const { server } = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // SIGTERM/SIGINT must exit cleanly so `docker stop` / k8s rolling
  // deploys terminate without spurious non-zero exit codes. There are
  // no in-flight HTTP requests to drain on the stdio path (each tool
  // call settles inline on the JSON-RPC stream before the next read);
  // a simple `process.exit(0)` matches what the SDK expects.
  const shutdown = (sig: string): void => {
    log.info("shutdown_signal", { signal: sig, transport: "stdio" });
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Bare-bones in-memory rate-limit for the HTTP transport. Each remote
// IP gets RATE_MAX requests per RATE_WINDOW_MS rolling window — once
// exceeded the request is rejected with 429 BEFORE the bearer check
// runs, so brute-force token guesses cannot iterate through the
// keyspace for free. Defence-in-depth on top of `checkBearerHeader`'s
// constant-time compare. In-process Map is fine for the single-replica
// MCP deployments this server targets; a multi-replica deployment
// would want a shared store (Redis), but that's out of scope here.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;
const RATE_CLEANUP_INTERVAL_MS = 5 * 60_000;
// Hard cap on the per-IP bucket map so a burst of unique IPs between
// cleanup ticks can't blow up RSS. When this size is exceeded we evict
// the oldest entry (insertion order, which Map iteration preserves) on
// every new insert. Sized to comfortably cover the per-process load
// this server targets (single-replica MCP host) with headroom.
const RATE_MAP_MAX_ENTRIES = 10_000;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function rateLimit(req: Request, res: Response, next: NextFunction): void {
  // `req.ip` honours `app.set('trust proxy', …)` when configured. If
  // TRUST_PROXY is left at the default 'false', `req.ip` is the socket
  // peer — what we want for a directly-exposed MCP server. Behind nginx
  // / Cloudflare / ingress, the operator should set TRUST_PROXY to the
  // appropriate value (e.g. 'loopback' or a CIDR) so X-Forwarded-For is
  // honoured instead of all users sharing the proxy's IP. Fall back to
  // `socket.remoteAddress` defensively in case Express hasn't populated
  // `req.ip` (custom transports, malformed requests).
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  // `<= now` (not `< now`): an entry whose window expires at exactly
  // `now` should reset, not be re-incremented against a stale ceiling.
  if (!entry || entry.resetAt <= now) {
    // Evict oldest before insert when at the cap. Maps preserve
    // insertion order; the first key returned by `keys()` is the oldest
    // bucket. This bounds memory in the worst case (many short-lived
    // distinct IPs) without breaking the rate-limit semantics for hot
    // IPs (they get re-inserted at the end on every increment via
    // `set`, so they don't bubble to the front).
    if (!entry && rateLimitMap.size >= RATE_MAP_MAX_ENTRIES) {
      const oldestKey = rateLimitMap.keys().next().value;
      if (oldestKey !== undefined) rateLimitMap.delete(oldestKey);
    }
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    next();
    return;
  }
  entry.count += 1;
  if (entry.count > RATE_MAX) {
    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({
      error: "rate_limit_exceeded",
      message: `Too many requests from ${ip}. Limit: ${RATE_MAX} req/${RATE_WINDOW_MS / 1000}s.`,
      retry_after: retryAfter,
    });
    return;
  }
  next();
}

// Periodic cleanup of stale rate-limit entries so the map doesn't grow
// unbounded under churn from many short-lived client IPs. `.unref()`
// lets the Node process exit cleanly even though the timer is still
// scheduled.
function startRateLimitCleanup(): NodeJS.Timeout {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap.entries()) {
      if (entry.resetAt < now) rateLimitMap.delete(ip);
    }
  }, RATE_CLEANUP_INTERVAL_MS);
  timer.unref();
  return timer;
}

function runHttp(opts: { port?: number; host?: string }): Promise<void> {
  const cfg = loadConfig();
  const port = opts.port ?? cfg.http.port;
  const host = opts.host ?? cfg.http.host;
  const allowedOrigins = cfg.http.allowedOrigins;
  const expectedToken = cfg.http.token;
  // Action1Client is built ONCE per HTTP server lifetime so the
  // TokenProvider cache is shared across requests. Previously
  // `buildServer()` was called per-request inside the /mcp handler,
  // which re-instantiated Action1Client (and its TokenProvider) every
  // time and forced an OAuth token round-trip on every tool call. The
  // McpServer itself is still per-request (stateless transport), but
  // the upstream-facing client is now reused.
  const sharedClient = new Action1Client(cfg);

  // Treat the various loopback spellings as equivalent. `[::1]` (the
  // bracketed IPv6 form used in URL bind-strings) is also loopback even
  // though it differs textually from "::1".
  const normalisedHost = host.replace(/^\[|\]$/g, "");
  const isLoopback =
    normalisedHost === "127.0.0.1" ||
    normalisedHost === "localhost" ||
    normalisedHost === "::1";
  // IPv6 hosts (containing `:`) appear in the `Host:` header
  // bracketed: `Host: [::1]:3000`. We accept either `::1:port` (without
  // brackets) or `[::1]:port` (with brackets) — both spellings get
  // added to expectedHosts when an Origin allowlist is active.
  const isIpv6Host = normalisedHost.includes(":");
  // Hard-fail when running on a non-loopback bind without a Bearer
  // token. Pass-4 audit (Security #2.5) flagged the prior warn-only
  // behaviour: operators could shoot themselves in the foot with an
  // unauthenticated public HTTP server. The Origin allowlist alone is
  // not sufficient — Origin is a same-origin-policy hint, not a
  // server-enforced authentication layer. Loopback binds remain
  // unauthenticated-by-default since they're only reachable from
  // localhost.
  if (!expectedToken && !isLoopback) {
    throw new Error(
      "Refusing to start: HTTP transport binds to non-loopback host '" +
        host +
        "' without a Bearer token. Set MCP_HTTP_TOKEN (>=16 chars, e.g. `openssl rand -hex 32`), or bind to 127.0.0.1 / localhost.",
    );
  }
  // Hard-fail when running on a non-loopback bind without an Origin
  // allowlist: the Origin check would no-op and the server would accept
  // cross-site fetches. This catches a misconfiguration that the
  // skill's DNS-rebinding guidance specifically calls out.
  if (!isLoopback && allowedOrigins.length === 0) {
    throw new Error(
      "Refusing to start: HTTP transport binds to non-loopback host '" +
        host +
        "' but MCP_HTTP_ALLOWED_ORIGINS is empty. Set the allowlist explicitly (e.g. MCP_HTTP_ALLOWED_ORIGINS=https://example.internal) to prevent DNS-rebinding attacks, or bind to 127.0.0.1.",
    );
  }

  const requireBearer = (req: Request, res: Response, next: NextFunction): void => {
    if (!expectedToken) {
      next();
      return;
    }
    const verdict = checkBearerHeader(req.headers.authorization, expectedToken);
    if (verdict === "ok") {
      next();
      return;
    }
    res
      .status(401)
      .json({
        error:
          verdict === "missing"
            ? "Bearer token required"
            : "Invalid bearer token",
      });
  };

  const app = express();
  app.set("trust proxy", parseTrustProxy(process.env.TRUST_PROXY));

  // Per-route 1 MB JSON parser. Previously mounted globally via
  // `app.use(express.json(...))`, which parsed bodies on every route
  // — including unauthenticated POSTs to non-existent paths (DoS
  // amplifier: 1 MB of JSON parsed before a 404). Now only `/mcp`
  // parses bodies, and only AFTER rate-limit + bearer + origin checks
  // pass.

  app.get("/healthz", (_req, res) => {
    // No `auth` field — leaking whether bearer auth is configured is
    // a tiny information disclosure with no operational value. Path
    // existence + 200 OK is enough to satisfy load-balancer probes.
    res.json({ ok: true, service: "action1-mcp-server" });
  });

  // Build the expected Host-header set for DNS-rebinding defence.
  // Browsers send `Host: <attacker-controlled-name>` when the victim
  // is tricked via DNS-rebinding into pointing an attacker DNS at our
  // loopback IP. Validating the Host header against the configured
  // bind ensures the request was intended for us.
  const expectedHosts = new Set<string>();
  expectedHosts.add(`${normalisedHost}:${port}`);
  expectedHosts.add(`localhost:${port}`);
  expectedHosts.add(`127.0.0.1:${port}`);
  if (isIpv6Host) {
    // Browsers send IPv6 hosts bracketed: `Host: [::1]:3000`. Add
    // both spellings of the *configured* host. The literal `[::1]`
    // hardcoded entry is only added when the bind itself is on `::1`
    // — otherwise it would be a stray loopback whitelist on a non-
    // loopback bind (Pass-3 audit finding).
    expectedHosts.add(`[${normalisedHost}]:${port}`);
    if (normalisedHost === "::1") expectedHosts.add(`[::1]:${port}`);
  }
  if (port === 80 || port === 443) {
    expectedHosts.add(normalisedHost);
    expectedHosts.add("localhost");
    expectedHosts.add("127.0.0.1");
    if (isIpv6Host) {
      expectedHosts.add(`[${normalisedHost}]`);
      if (normalisedHost === "::1") expectedHosts.add("[::1]");
    }
  }

  const checkOriginAndHost = (req: Request, res: Response): boolean => {
    // Origin first, then Host — both run BEFORE the bearer check so
    // DNS-rebinding attempts can't even reach the auth layer (skill
    // best-practice for HTTP transport).
    const origin = req.headers.origin;
    if (origin && allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) {
      res.status(403).json({ error: "Origin not allowed" });
      return false;
    }
    const hostHeader = req.headers.host;
    if (hostHeader && !expectedHosts.has(hostHeader)) {
      // Only enforce strict Host-match when an allowlist has been
      // configured (i.e. operator opted into the stricter mode by
      // setting MCP_HTTP_ALLOWED_ORIGINS). Loopback-only deployments
      // without an allowlist see only the warn-fallback above.
      if (allowedOrigins.length > 0) {
        res.status(403).json({ error: "Host header not allowed" });
        return false;
      }
    }
    return true;
  };

  // Start the rate-limit cleanup timer once per HTTP server instance.
  startRateLimitCleanup();

  // Middleware order matters here:
  //   1. rateLimit        — drop excess BEFORE doing real work.
  //   2. origin+host      — DNS-rebinding defence BEFORE auth so an
  //                         attacker can't probe the bearer surface.
  //   3. requireBearer    — auth, constant-time compare.
  //   4. express.json     — body parser LAST so unauth / blocked
  //                         requests don't consume the 1 MB budget
  //                         (Pass-13 audit #3). 1 MB matches the
  //                         MCP host wire limit; bigger payloads
  //                         can't be processed downstream anyway.
  //   5. handler
  app.post(
    "/mcp",
    rateLimit,
    (req: Request, res: Response, next: NextFunction): void => {
      if (!checkOriginAndHost(req, res)) return;
      requireBearer(req, res, next);
    },
    express.json({ limit: "1mb" }),
    (req: Request, res: Response) => {
      const { server } = buildServer(sharedClient);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      void (async () => {
        try {
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
        } catch (err) {
          log.error("http_request_handler_failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          if (!res.headersSent) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
          }
        }
      })();
    },
  );

  return new Promise<void>((resolve, reject) => {
    const httpServer = app.listen(port, host, () => {
      log.info("http_listening", {
        url: `http://${host}:${port}/mcp`,
        auth: expectedToken ? "bearer" : "none",
      });
    });
    httpServer.on("error", reject);
    httpServer.on("close", resolve);

    // Graceful shutdown for k8s rolling deploys / `docker stop` /
    // CTRL-C. `httpServer.close()` stops accepting new connections
    // and lets in-flight requests settle. The 25 s safety timer hard-
    // exits if a stuck request would keep the process alive past the
    // standard 30 s SIGKILL grace window — `.unref()` so the timer
    // itself doesn't pin the event loop in the happy path.
    const shutdown = (sig: string): void => {
      log.info("shutdown_signal", { signal: sig, transport: "http" });
      httpServer.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 25_000).unref();
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (args.http) {
    await runHttp({
      ...(args.port !== undefined ? { port: args.port } : {}),
      ...(args.host !== undefined ? { host: args.host } : {}),
    });
  } else {
    await runStdio();
  }
}

// Only auto-run when executed as the CLI entry point — not when this
// module is imported (e.g. by unit-tests pulling `parseTrustProxy`).
// `import.meta.url` resolves to the ESM URL of this file; `argv[1]` is
// the absolute path Node was launched with. On POSIX the two compare
// trivially as strings, but on Windows the path uses backslashes and a
// non-canonical drive-letter case (`c:\...`) while `import.meta.url`
// is RFC 8089 canonical (`file:///C:/...`). `pathToFileURL` is Node's
// platform-aware converter and gives a stable, comparable URL on both.
const invokedAsEntry =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsEntry) {
  main().catch((err) => {
    process.stderr.write(
      `Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
