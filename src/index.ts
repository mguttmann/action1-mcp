#!/usr/bin/env node
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { Transport } from "@modelcontextprotocol/server";
import { realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { buildServer } from "./server.js";
import { Action1Client } from "./client/action1Client.js";
import { ConfigError, ENV_VARS, loadConfig, type EnvVarGroup } from "./config.js";
import { createHttpApp } from "./http.js";
import { log, logFatal } from "./utils/logger.js";
import { SERVER_VERSION } from "./version.js";

// Re-exported for callers and tests that imported it from the entry point.
export { parseTrustProxy } from "./config.js";

interface CliArgs {
  http: boolean;
  port?: number;
  host?: string;
  help: boolean;
  version: boolean;
}

/** A command line the server does not understand (exit code 2). */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { http: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--http") args.http = true;
    else if (a === "--stdio") args.http = false;
    else if (a === "--port") {
      const raw = argv[++i] ?? "";
      const port = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : NaN;
      if (!(port >= 1 && port <= 65535)) {
        throw new UsageError(`Invalid --port '${raw}': expected an integer in [1, 65535].`);
      }
      args.port = port;
    } else if (a === "--host") {
      const raw = (argv[++i] ?? "").trim();
      if (raw === "" || raw.startsWith("--")) {
        throw new UsageError("Invalid --host: expected a bind address such as 127.0.0.1.");
      }
      args.host = raw;
    } else if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a === "--version") {
      args.version = true;
    } else {
      throw new UsageError(`Unknown option '${a}'. Run action1-mcp --help for the options.`);
    }
  }
  return args;
}

const GROUP_TITLES: Record<EnvVarGroup, string> = {
  required: "Required",
  recommended: "Recommended",
  optional: "Optional",
  http: "HTTP transport (--http only)",
};

/** Help text; the environment section is rendered from the config schema docs. */
export function helpText(): string {
  const names = Object.keys(ENV_VARS) as (keyof typeof ENV_VARS)[];
  const width = Math.max(...names.map((n) => n.length));
  const lines = [
    `action1-mcp ${SERVER_VERSION} - MCP server for the Action1 RMM REST API (unofficial)`,
    "",
    "Usage:",
    "  action1-mcp                 Start with stdio transport (default).",
    "  action1-mcp --http          Start with Streamable HTTP transport (stateless, POST /mcp).",
    "  action1-mcp --http --port 3000 --host 127.0.0.1",
    "  action1-mcp --help          Show this help.",
    "  action1-mcp --version       Print the version.",
    "",
    "Environment:",
  ];
  for (const group of Object.keys(GROUP_TITLES) as EnvVarGroup[]) {
    lines.push(`  ${GROUP_TITLES[group]}:`);
    for (const name of names) {
      const meta = ENV_VARS[name];
      if (meta.group === group) lines.push(`    ${name.padEnd(width)}  ${meta.summary}`);
    }
  }
  lines.push(
    "",
    "Empty values count as unset. See .env.example and docs/SECURITY.md for details.",
    "",
  );
  return lines.join("\n");
}

/**
 * Serve MCP over stdio. `serveStdio` decides the protocol era from the
 * client's opening message: an `initialize` request (2025-11-25,
 * 2025-06-18 and older revisions) pins the connection to a 2025-era
 * server exactly as a hand-wired `server.connect` did; a 2026-07-28
 * client (`server/discover`, per-request envelope) gets a modern-era
 * instance. Both come from the same buildServer factory and share one
 * Action1 client (one token cache). `transport` replaces the process
 * pipes (tests).
 */
export function startStdio(options: { transport?: Transport } = {}): StdioServerHandle {
  const cfg = loadConfig();
  const client = new Action1Client(cfg);
  return serveStdio(() => buildServer(client, { config: cfg }).server, {
    legacy: "serve",
    ...(options.transport ? { transport: options.transport } : {}),
    onerror: (error) => log.warn("stdio_transport_error", { error: error.message }),
  });
}

function runStdio(): void {
  startStdio();
  // SIGTERM/SIGINT must exit cleanly so `docker stop` / k8s rolling
  // deploys terminate without spurious non-zero exit codes. There are
  // no in-flight HTTP requests to drain on the stdio path.
  const shutdown = (sig: string): void => {
    log.info("shutdown_signal", { signal: sig, transport: "stdio" });
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

function runHttp(opts: { port?: number; host?: string }): Promise<void> {
  const base = loadConfig();
  const cfg = {
    ...base,
    http: { ...base.http, port: opts.port ?? base.http.port, host: opts.host ?? base.http.host },
  };
  const app = createHttpApp(cfg);

  return new Promise<void>((resolve, reject) => {
    const httpServer = app.listen(cfg.http.port, cfg.http.host, () => {
      const { port } = httpServer.address() as AddressInfo;
      const shownHost = cfg.http.host.includes(":") ? `[${cfg.http.host}]` : cfg.http.host;
      log.info("http_listening", {
        url: `http://${shownHost}:${port}/mcp`,
        auth: cfg.http.token ? "bearer" : "none",
      });
    });
    httpServer.on("error", reject);
    httpServer.on("close", resolve);

    // Graceful shutdown for k8s rolling deploys / `docker stop` /
    // CTRL-C: stop accepting connections, let in-flight requests
    // settle, hard-exit after 25 s (inside the usual 30 s grace).
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
    process.stdout.write(helpText());
    return;
  }
  if (args.version) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }
  if (args.http) {
    await runHttp({
      ...(args.port !== undefined ? { port: args.port } : {}),
      ...(args.host !== undefined ? { host: args.host } : {}),
    });
  } else {
    runStdio();
  }
}

/**
 * True when this module is the process entry point (and not imported,
 * e.g. by tests). `import.meta.url` is the resolved real path of this
 * file, while `argv[1]` is the path Node was started with: for an npm
 * bin that is a symlink (`node_modules/.bin/action1-mcp`), and on macOS
 * temp paths run through the /var -> /private/var link. Resolving
 * argv[1] with realpathSync makes both sides comparable; pathToFileURL
 * handles Windows drive letters and separators.
 */
export function isEntryPoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (typeof argv1 !== "string" || argv1 === "") return false;
  try {
    return pathToFileURL(realpathSync(argv1)).href === moduleUrl;
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  // Every way the process can die writes one JSON log line first, so
  // log pipelines that parse stderr as JSON lines see the cause.
  process.on("uncaughtException", (err) => {
    logFatal("uncaught_exception", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logFatal("unhandled_rejection", reason);
    process.exit(1);
  });
  main().catch((err: unknown) => {
    if (err instanceof UsageError) {
      process.stderr.write(`action1-mcp: ${err.message}\n`);
      process.exit(2);
    }
    if (err instanceof ConfigError) {
      // One readable line per problem for the operator, then the JSON
      // record for log pipelines, without a stack trace: a missing
      // setting is not a crash.
      for (const issue of err.issues) process.stderr.write(`action1-mcp: ${issue}\n`);
      logFatal("fatal", `Invalid configuration: ${err.issues.join(" ")}`);
      process.exit(1);
    }
    logFatal("fatal", err);
    process.exit(1);
  });
}
