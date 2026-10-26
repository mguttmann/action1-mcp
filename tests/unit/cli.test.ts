import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENV_VARS } from "../../src/config.js";
import { helpText, isEntryPoint, parseArgs } from "../../src/index.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version: string;
};

/** Run the real entry point with `args` and only PATH (plus `env`) in the environment. */
function runCli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/index.ts", ...args], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
    input: "",
    timeout: 30_000,
  });
}

describe("--help", () => {
  it("lists every env var the config schema reads", () => {
    const text = helpText();
    for (const name of Object.keys(ENV_VARS)) expect(text).toContain(name);
  });
});

describe("parseArgs", () => {
  it("parses transport, port and host", () => {
    expect(parseArgs(["--http", "--port", "3001", "--host", "::1"])).toEqual({
      http: true,
      help: false,
      version: false,
      port: 3001,
      host: "::1",
    });
  });

  it.each([["abc"], ["0"], ["65536"], [""]])("rejects --port %j", (port) => {
    expect(() => parseArgs(["--http", "--port", port])).toThrow(/--port/);
  });

  it("rejects --host without a value", () => {
    expect(() => parseArgs(["--http", "--host"])).toThrow(/--host/);
    expect(() => parseArgs(["--http", "--host", "--port", "3001"])).toThrow(/--host/);
  });
});

describe("--version and unknown flags", () => {
  it("parses --version", () => {
    expect(parseArgs(["--version"]).version).toBe(true);
  });

  it.each([["--htp"], ["-x"], ["http"], ["--port=3000"]])(
    "rejects the unknown argument %j",
    (arg) => {
      expect(() => parseArgs([arg])).toThrow(new RegExp(`Unknown option '${arg}'.*--help`));
    },
  );

  it("--version prints the package version and exits 0 without any configuration", () => {
    const r = runCli(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(pkg.version);
  }, 40_000);

  it("an unknown flag exits 2 with one clear line and starts nothing", () => {
    const r = runCli(["--htp"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    const lines = r.stderr.split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Unknown option '--htp'");
    expect(lines[0]).not.toMatch(/^\s*at /);
  }, 40_000);
});

describe("start-up configuration errors", () => {
  it("print one clean line per issue, no stack trace, no [REDACTED], and exit 1", () => {
    const r = runCli([], { ACTION1_CLIENT_ID: "client-id-test" });
    expect(r.status).toBe(1);
    const lines = r.stderr.split("\n").filter((l) => l.trim());
    const plain = lines.filter((l) => !l.startsWith("{"));
    expect(plain.some((l) => l.includes("ACTION1_BASE_URL is not set"))).toBe(true);
    expect(plain.some((l) => l.includes("ACTION1_CLIENT_SECRET is not set"))).toBe(true);
    expect(plain.some((l) => l.includes("ACTION1_CLIENT_ID"))).toBe(false);
    expect(r.stderr).not.toContain("[REDACTED]");
    expect(r.stderr).not.toMatch(/\bat .*\.(?:ts|js):\d+/);
    expect(r.stderr).not.toContain('"stack"');
  }, 40_000);

  it("report an invalid value with the key and the rule", () => {
    const r = runCli([], {
      ACTION1_BASE_URL: "https://app.eu.action1.test/api/3.0",
      ACTION1_CLIENT_ID: "client-id-test",
      ACTION1_CLIENT_SECRET: "client-secret-test",
      ACTION1_LAST_SEEN_STALE_MINUTES: "0",
    });
    expect(r.status).toBe(1);
    const plain = r.stderr.split("\n").filter((l) => l.trim() && !l.startsWith("{"));
    expect(plain.some((l) => /ACTION1_LAST_SEEN_STALE_MINUTES is invalid: .*1440/.test(l))).toBe(
      true,
    );
    expect(r.stderr).not.toContain('"stack"');
  }, 40_000);

  it("an HTTP start-up refusal is reported the same way", () => {
    const r = runCli(["--http", "--host", "127.0.0.1", "--port", "1"], {
      ACTION1_BASE_URL: "https://app.eu.action1.test/api/3.0",
      ACTION1_CLIENT_ID: "client-id-test",
      ACTION1_CLIENT_SECRET: "client-secret-test",
    });
    expect(r.status).toBe(1);
    const plain = r.stderr.split("\n").filter((l) => l.trim() && !l.startsWith("{"));
    expect(plain.some((l) => l.includes("MCP_HTTP_TOKEN"))).toBe(true);
    expect(r.stderr).not.toContain('"stack"');
  }, 40_000);
});

describe("isEntryPoint", () => {
  it("is false for a missing or unresolvable argv[1]", () => {
    expect(isEntryPoint(undefined, import.meta.url)).toBe(false);
    expect(isEntryPoint("/definitely/not/here.js", import.meta.url)).toBe(false);
  });
});
