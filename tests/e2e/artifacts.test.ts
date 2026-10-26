import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { type IncomingMessage, request as httpRequest } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// End-to-end checks of the artifacts users actually run: the compiled
// stdio server (dist/index.js, what `node dist/index.js`, npx and the
// gateway start) and the MCPB bundle Claude Desktop installs. The suite
// runs the real scripts/build-mcpb.sh against a deliberately stale
// dist/ and inspects the produced .mcpb.

const root = fileURLToPath(new URL("../..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string;
  version: string;
};
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as {
  packages: Record<
    string,
    { version?: string; dev?: boolean; devOptional?: boolean; optional?: boolean }
  >;
};
const baseline = JSON.parse(
  readFileSync(join(root, "tests/fixtures/tools-list.baseline.json"), "utf8"),
) as { tools: Array<{ name: string }> };

const bundlePath = join(root, "dist", `action1-mcp-${pkg.version}.mcpb`);
let unpacked: string;

/** Every installed package below `dir`, keyed like package-lock.json. */
function installedPackages(dir: string, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  const nm = join(dir, "node_modules");
  if (!existsSync(nm)) return out;
  const visit = (pkgDir: string) => {
    const key = prefix + relative(dir, pkgDir).split("\\").join("/");
    const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
      version: string;
    };
    out.set(key, manifest.version);
    for (const [k, v] of installedPackages(pkgDir, `${key}/`)) out.set(k, v);
  };
  for (const entry of readdirSync(nm)) {
    if (entry.startsWith(".")) continue;
    if (entry.startsWith("@")) {
      for (const scoped of readdirSync(join(nm, entry))) visit(join(nm, entry, scoped));
    } else {
      visit(join(nm, entry));
    }
  }
  return out;
}

/** initialize + tools/list against a built entry, via the snapshot script. */
function toolNames(entry: string): string[] {
  const out = execFileSync(
    process.execPath,
    [join(root, "scripts/tools-list-snapshot.mjs"), "--entry", entry],
    { cwd: root, encoding: "utf8", timeout: 60_000 },
  );
  return (JSON.parse(out) as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
}

/**
 * SHA-256 of the release assets as release.yml lists them in SHA256SUMS:
 * the bundle and the SBOMs from dist/ plus the npm tarball (packed
 * without lifecycle scripts, so dist/ is not rebuilt).
 */
function releaseSums(): string {
  const packDir = mkdtempSync(join(tmpdir(), "action1-pack-e2e-"));
  try {
    execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", packDir], {
      cwd: root,
      stdio: "pipe",
    });
    const assets = [
      ...readdirSync(join(root, "dist"))
        .filter((f) => f.endsWith(".mcpb") || f.endsWith(".cdx.json"))
        .map((f) => join(root, "dist", f)),
      ...readdirSync(packDir).map((f) => join(packDir, f)),
    ];
    return assets
      .map(
        (f) =>
          `${createHash("sha256").update(readFileSync(f)).digest("hex")}  ${f.split(/[\\/]/).pop()}`,
      )
      .sort()
      .join("\n");
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
}

let firstBuildSums: string;

function walkFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split("\\").join("/"));
}

beforeAll(() => {
  // A checkout that was built before `git pull`: dist/ is not empty,
  // carries an entry point from the old build, a module that no longer
  // exists in src/, and a bundle from an earlier run.
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist/index.js"), "process.exit(42);\n");
  writeFileSync(join(root, "dist/stale-module.js"), "export const STALE = true;\n");
  writeFileSync(join(root, "dist/action1-mcp-0.0.1.mcpb"), "old bundle");

  execFileSync("bash", [join(root, "scripts/build-mcpb.sh")], {
    cwd: root,
    stdio: "inherit",
    timeout: 600_000,
  });

  firstBuildSums = releaseSums();

  unpacked = mkdtempSync(join(tmpdir(), "action1-mcpb-e2e-"));
  execFileSync("npx", ["--no-install", "mcpb", "unpack", bundlePath, unpacked], {
    cwd: root,
    stdio: "pipe",
  });
});

afterAll(() => {
  if (unpacked) rmSync(unpacked, { recursive: true, force: true });
});

describe("build:mcpb builds from a clean dist/", () => {
  it("removes leftovers of an earlier build", () => {
    expect(existsSync(join(root, "dist/stale-module.js"))).toBe(false);
    expect(existsSync(join(root, "dist/action1-mcp-0.0.1.mcpb"))).toBe(false);
    expect(readFileSync(join(root, "dist/index.js"), "utf8")).not.toContain("process.exit(42)");
  });

  it("ships only fresh runtime files: no stale module, no nested bundle, no codegen", () => {
    const files = walkFiles(unpacked);
    expect(files).toContain("server/index.js");
    expect(files.filter((f) => f.endsWith(".mcpb"))).toEqual([]);
    expect(files.filter((f) => f.startsWith("server/stale-module"))).toEqual([]);
    expect(files.filter((f) => f.startsWith("server/codegen/"))).toEqual([]);
    expect(readFileSync(join(unpacked, "server/index.js"), "utf8")).not.toContain(
      "process.exit(42)",
    );
  });
});

describe("MCPB bundle contents", () => {
  it("carries the package.json version in manifest and server/package.json", () => {
    const manifest = JSON.parse(readFileSync(join(unpacked, "manifest.json"), "utf8")) as {
      version: string;
    };
    const serverPkg = JSON.parse(readFileSync(join(unpacked, "server/package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    expect(manifest.version).toBe(pkg.version);
    expect(serverPkg).toMatchObject({ name: pkg.name, version: pkg.version });
  });

  it("installs exactly the runtime tree pinned in package-lock.json", () => {
    const installed = installedPackages(join(unpacked, "server"));
    const runtime = Object.entries(lock.packages).filter(
      ([k, v]) => k.startsWith("node_modules/") && !v.dev && !v.devOptional,
    );
    const required = runtime.filter(([, v]) => !v.optional).map(([k]) => k);
    const allowed = new Map(runtime.map(([k, v]) => [k, v.version]));
    expect(installed.size).toBeGreaterThan(0);
    for (const key of required) expect(installed.has(key), `${key} missing`).toBe(true);
    for (const [key, version] of installed) {
      expect(allowed.has(key), `${key} is not a runtime dependency in the lockfile`).toBe(true);
      expect(version, key).toBe(allowed.get(key));
    }
  });

  it("includes LICENSE, NOTICE (when the repo has one) and third-party notices", () => {
    expect(readFileSync(join(unpacked, "LICENSE"), "utf8")).toBe(
      readFileSync(join(root, "LICENSE"), "utf8"),
    );
    if (existsSync(join(root, "NOTICE"))) {
      expect(readFileSync(join(unpacked, "NOTICE"), "utf8")).toBe(
        readFileSync(join(root, "NOTICE"), "utf8"),
      );
    }
    const notices = readFileSync(join(unpacked, "THIRD_PARTY_NOTICES.md"), "utf8");
    const installed = installedPackages(join(unpacked, "server"));
    for (const [key, version] of installed) {
      const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
      expect(notices, key).toContain(`## ${name}@${version}`);
    }
  });
});

describe("MCPB SBOM", () => {
  it("lists exactly the packages installed in the bundle (CycloneDX)", () => {
    const sbomPath = join(root, "dist", `action1-mcp-${pkg.version}.mcpb.cdx.json`);
    const sbom = JSON.parse(readFileSync(sbomPath, "utf8")) as {
      bomFormat: string;
      metadata: { component: { name: string; version: string; type: string } };
      components: Array<{ name: string; version: string }>;
    };
    expect(sbom.bomFormat).toBe("CycloneDX");
    expect(sbom.metadata.component).toMatchObject({
      name: pkg.name,
      version: pkg.version,
      type: "application",
    });
    const listed = new Set(sbom.components.map((c) => `${c.name}@${c.version}`));
    const installed = new Set(
      [...installedPackages(join(unpacked, "server"))].map(
        ([key, version]) =>
          `${key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length)}@${version}`,
      ),
    );
    expect([...listed].sort()).toEqual([...installed].sort());
  });

  const sbomFiles = () => [
    join(root, "dist", `action1-mcp-${pkg.version}.mcpb.cdx.json`),
    join(root, "dist", `action1-mcp-server-${pkg.version}.tgz.cdx.json`),
  ];
  type Sbom = {
    serialNumber: string;
    metadata: { timestamp: string; component: { name: string; type: string } };
    components: Array<{
      name: string;
      version: string;
      hashes?: Array<{ alg: string; content: string }>;
      externalReferences?: Array<{ type: string; url: string }>;
    }>;
  };

  it("gives every component a SHA-512 hash and its registry tarball URL", () => {
    for (const file of sbomFiles()) {
      const sbom = JSON.parse(readFileSync(file, "utf8")) as Sbom;
      expect(sbom.components.length, file).toBeGreaterThan(0);
      const missing = sbom.components
        .filter(
          (c) =>
            !c.hashes?.some((h) => h.alg === "SHA-512" && /^[0-9a-f]{128}$/.test(h.content)) ||
            !c.externalReferences?.some(
              (r) => r.type === "distribution" && r.url.startsWith("https://registry.npmjs.org/"),
            ),
        )
        .map((c) => `${c.name}@${c.version}`);
      expect(missing, file).toEqual([]);
    }
  });

  it("writes an npm package SBOM with the same components", () => {
    const [bundle, library] = sbomFiles().map((f) => JSON.parse(readFileSync(f, "utf8")) as Sbom);
    expect(library!.metadata.component).toMatchObject({ name: pkg.name, type: "library" });
    const names = (s: Sbom) => s.components.map((c) => `${c.name}@${c.version}`).sort();
    expect(names(library!)).toEqual(names(bundle!));
  });

  it("derives serialNumber from the content and the timestamp from SOURCE_DATE_EPOCH", () => {
    const epoch = execFileSync("git", ["log", "-1", "--format=%ct"], {
      cwd: root,
      encoding: "utf8",
    });
    for (const file of sbomFiles()) {
      const sbom = JSON.parse(readFileSync(file, "utf8")) as Sbom;
      expect(sbom.metadata.timestamp, file).toBe(
        new Date(Number(epoch.trim()) * 1000).toISOString(),
      );
      const { serialNumber, ...rest } = sbom;
      const digest = createHash("sha256").update(JSON.stringify(rest)).digest("hex");
      expect(serialNumber, file).toBe(
        `urn:uuid:${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${((parseInt(digest[16]!, 16) & 0x3) | 0x8).toString(16)}${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
      );
    }
  });
});

describe("npm tarball", () => {
  it("ships no source map without its sources", () => {
    const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: root,
      encoding: "utf8",
    });
    const files = new Set(
      (JSON.parse(out) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map((f) => f.path),
    );
    expect(files.has("dist/index.js")).toBe(true);
    const problems: string[] = [];
    for (const f of files) {
      if (f.endsWith(".map")) {
        const map = JSON.parse(readFileSync(join(root, f), "utf8")) as {
          sources?: string[];
          sourceRoot?: string;
        };
        for (const src of map.sources ?? []) {
          const target = posix.normalize(posix.join(posix.dirname(f), map.sourceRoot ?? "", src));
          if (!files.has(target)) problems.push(`${f} -> ${target}`);
        }
      } else if (/\.(?:js|d\.ts)$/.test(f)) {
        const ref = /\/\/# sourceMappingURL=(\S+)\s*$/.exec(readFileSync(join(root, f), "utf8"));
        if (ref && !ref[1]!.startsWith("data:")) {
          const target = posix.normalize(posix.join(posix.dirname(f), ref[1]!));
          if (!files.has(target)) problems.push(`${f} -> ${target}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("built servers answer tools/list over stdio", () => {
  const expected = baseline.tools.map((t) => t.name);

  it("dist/index.js", () => {
    const names = toolNames(join(root, "dist/index.js"));
    expect(names).toEqual(expect.arrayContaining(expected));
  });

  it("the unpacked MCPB bundle (server/index.js)", () => {
    const names = toolNames(join(unpacked, "server/index.js"));
    expect(names).toEqual(expect.arrayContaining(expected));
  });
});

// Dummy answers for the install wizard. The base URL points at a closed
// local port, so no real Action1 API is reached. A user_config field
// without an entry here fails the test, so a new field gets a value.
const WIZARD_ANSWERS: Record<string, string> = {
  action1_base_url: "https://127.0.0.1:1/api/3.0",
  action1_org_id: "00000000-0000-0000-0000-000000000000",
  action1_client_id: "dummy-client-id",
  action1_client_secret: "dummy-client-secret",
  // Not the default, so a dropped or misspelled mapping is visible in
  // the server instructions.
  allow_destructive: "true",
};

interface McpConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Resolve manifest.server.mcp_config the way Claude Desktop does:
 * ${__dirname} is the unpacked bundle, ${user_config.<field>} the
 * wizard answer. A node server runs on the host's Node.js.
 */
function resolveMcpConfig(bundleDir: string): McpConfig {
  const manifest = JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8")) as {
    server: { mcp_config: McpConfig };
    user_config: Record<string, unknown>;
  };
  for (const field of Object.keys(manifest.user_config)) {
    expect(WIZARD_ANSWERS, `no dummy wizard answer for user_config.${field}`).toHaveProperty(field);
  }
  const subst = (v: string) =>
    v
      .replaceAll("${__dirname}", bundleDir)
      .replace(/\$\{user_config\.([a-z0-9_]+)\}/g, (_m, field: string) => {
        const answer = WIZARD_ANSWERS[field];
        if (answer === undefined) throw new Error(`unknown user_config.${field} in ${v}`);
        return answer;
      });
  const { command, args, env } = manifest.server.mcp_config;
  return {
    command: command === "node" ? process.execPath : command,
    args: args.map(subst),
    env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, subst(v)])),
  };
}

interface StdioSession {
  request<T>(method: string, params: unknown): Promise<T>;
  notify(method: string): void;
  close(): void;
}

/** A spawned stdio server, spoken to with newline-delimited JSON-RPC. */
function openStdio(cfg: McpConfig): StdioSession {
  const child = spawn(cfg.command, cfg.args, {
    cwd: tmpdir(),
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "", ...cfg.env },
  });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const replies = new Map<number, (msg: { result?: unknown; error?: unknown }) => void>();
  let buf = "";
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
      if (msg.id !== undefined) replies.get(msg.id)?.(msg);
    }
  });
  let nextId = 1;
  return {
    request: <T>(method: string, params: unknown) =>
      new Promise<T>((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(
          () => reject(new Error(`${method}: no reply (exit ${child.exitCode}).\n${stderr}`)),
          30_000,
        );
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`server exited with ${code} before ${method}.\n${stderr}`));
        });
        replies.set(id, (msg) => {
          clearTimeout(timer);
          if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
          else resolve(msg.result as T);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      }),
    notify: (method: string) => {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
    },
    close: () => {
      child.kill();
    },
  };
}

/** initialize + notifications/initialized; returns the instructions. */
async function initialize(session: StdioSession): Promise<string> {
  const init = await session.request<{ instructions?: string }>("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "claude-desktop-e2e", version: "1.0.0" },
  });
  session.notify("notifications/initialized");
  return init.instructions ?? "";
}

/** initialize + tools/list over newline-delimited JSON-RPC on stdio. */
async function startLikeClaudeDesktop(cfg: McpConfig): Promise<{
  instructions: string;
  tools: string[];
}> {
  const session = openStdio(cfg);
  try {
    const instructions = await initialize(session);
    const tools: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await session.request<{ tools: Array<{ name: string }>; nextCursor?: string }>(
        "tools/list",
        cursor ? { cursor } : {},
      );
      tools.push(...page.tools.map((t) => t.name));
      cursor = page.nextCursor;
    } while (cursor);
    return { instructions, tools };
  } finally {
    session.close();
  }
}

describe("the unpacked bundle starts from manifest.server.mcp_config", () => {
  it("receives every wizard answer under the env name the server reads", async () => {
    const cfg = resolveMcpConfig(unpacked);
    expect(cfg.args.join(" ")).not.toContain("${");
    expect(Object.values(cfg.env).join(" ")).not.toContain("${");

    const { instructions, tools } = await startLikeClaudeDesktop(cfg);
    // Required settings (base URL, client ID, client secret) under a
    // wrong name stop the server before initialize; the optional
    // destructive switch only shows in the instructions.
    expect(instructions).toContain("Destructive operations are enabled on this server");
    expect(tools).toEqual(expect.arrayContaining(baseline.tools.map((t) => t.name)));
  });
});

const ORG = "00000000-0000-0000-0000-0000000000e2";

/** A free loopback port from the OS (ephemeral range). */
async function freePort(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  const { port } = srv.address() as AddressInfo;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

describe("dist/index.js calls a tool against a local Action1 stub", () => {
  let stub: HttpsServer | undefined;
  let certDir: string | undefined;

  afterAll(async () => {
    if (stub) await new Promise<void>((resolve) => stub!.close(() => resolve()));
    if (certDir) rmSync(certDir, { recursive: true, force: true });
  });

  it("action1_list_organizations fetches a token, then the organizations", async () => {
    // ACTION1_BASE_URL must be https, so the stub gets a throwaway
    // self-signed certificate that only the child process trusts.
    certDir = mkdtempSync(join(tmpdir(), "action1-e2e-tls-"));
    const keyFile = join(certDir, "key.pem");
    const certFile = join(certDir, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyFile,
        "-out",
        certFile,
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { stdio: "pipe" },
    );
    const seen: string[] = [];
    stub = createHttpsServer(
      { key: readFileSync(keyFile), cert: readFileSync(certFile) },
      (req: IncomingMessage, res) => {
        seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ""}`);
        req.resume();
        res.setHeader("content-type", "application/json");
        if (req.method === "POST" && req.url === "/api/3.0/oauth2/token") {
          res.end(JSON.stringify({ access_token: "stub-token", expires_in: 3600 }));
        } else if (req.method === "GET" && req.url?.startsWith("/api/3.0/organizations")) {
          res.end(
            JSON.stringify({
              items: [{ id: ORG, name: "E2E Stub Org" }],
              total_items: 1,
              next_page: "",
            }),
          );
        } else {
          res.statusCode = 404;
          res.end("{}");
        }
      },
    );
    await new Promise<void>((resolve) => stub!.listen(0, "127.0.0.1", () => resolve()));
    const { port } = stub.address() as AddressInfo;

    const session = openStdio({
      command: process.execPath,
      args: [join(root, "dist/index.js")],
      env: {
        ACTION1_BASE_URL: `https://127.0.0.1:${port}/api/3.0`,
        ACTION1_CLIENT_ID: "e2e-client-id",
        ACTION1_CLIENT_SECRET: "e2e-client-secret",
        ACTION1_ORG_ID: ORG,
        NODE_EXTRA_CA_CERTS: certFile,
      },
    });
    try {
      await initialize(session);
      const result = await session.request<{
        isError?: boolean;
        content: Array<{ text?: string }>;
        structuredContent?: { items?: Array<{ name?: string }> };
      }>("tools/call", { name: "action1_list_organizations", arguments: {} });
      expect(result.isError ?? false, JSON.stringify(result)).toBe(false);
      expect(result.structuredContent?.items?.map((o) => o.name)).toEqual(["E2E Stub Org"]);
    } finally {
      session.close();
    }
    expect(seen.filter((l) => l.startsWith("POST /api/3.0/oauth2/token"))).toHaveLength(1);
    expect(
      seen.some(
        (l) => l.startsWith("GET /api/3.0/organizations") && l.endsWith("Bearer stub-token"),
      ),
    ).toBe(true);
  });
});

describe("dist/index.js --http", () => {
  const baseEnv = {
    PATH: process.env.PATH ?? "",
    ACTION1_BASE_URL: "https://127.0.0.1:1/api/3.0",
    ACTION1_CLIENT_ID: "dummy-client-id",
    ACTION1_CLIENT_SECRET: "dummy-client-secret",
    ACTION1_ORG_ID: ORG,
  };
  let child: ChildProcess | undefined;

  afterAll(() => {
    child?.kill();
  });

  it("refuses to start without MCP_HTTP_TOKEN", async () => {
    const port = await freePort();
    const r = spawnSync(
      process.execPath,
      [join(root, "dist/index.js"), "--http", "--host", "127.0.0.1", "--port", String(port)],
      { cwd: tmpdir(), env: baseEnv, encoding: "utf8", timeout: 30_000 },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("MCP_HTTP_TOKEN");
  });

  it("answers only with the bearer token and lists the baseline tools", async () => {
    const token = "e2e-http-token-0123456789abcdef";
    const port = await freePort();
    child = spawn(
      process.execPath,
      [join(root, "dist/index.js"), "--http", "--host", "127.0.0.1", "--port", String(port)],
      { cwd: tmpdir(), env: { ...baseEnv, MCP_HTTP_TOKEN: token }, stdio: "pipe" },
    );
    let stderr = "";
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no http_listening.\n${stderr}`)), 30_000);
      child!.stderr!.on("data", (d: Buffer) => {
        stderr += d.toString();
        if (stderr.includes("http_listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child!.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited with ${code}.\n${stderr}`));
      });
    });
    const post = (body: unknown, auth?: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            method: "POST",
            path: "/mcp",
            agent: false,
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "mcp-protocol-version": "2025-11-25",
              ...(auth ? { authorization: auth } : {}),
            },
          },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (c: string) => (text += c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify(body));
      });
    const list = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    expect((await post(list)).status).toBe(401);
    expect((await post(list, "Bearer wrong-token-0123456789abcdef")).status).toBe(401);
    const ok = await post(list, `Bearer ${token}`);
    expect(ok.status, ok.body).toBe(200);
    const names = (
      JSON.parse(ok.body) as { result: { tools: Array<{ name: string }> } }
    ).result.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(baseline.tools.map((t) => t.name)));
  });
});

// Last, because it rebuilds dist/ (with identical bytes when it passes).
describe("reproducible release assets", () => {
  it("a second clean build gives the same SHA256SUMS", () => {
    execFileSync("bash", [join(root, "scripts/build-mcpb.sh")], {
      cwd: root,
      stdio: "pipe",
      timeout: 600_000,
    });
    expect(releaseSums()).toBe(firstBuildSums);
  }, 600_000);
});
