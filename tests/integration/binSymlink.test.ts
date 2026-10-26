import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// `npm install -g` and `npx` start the server through a symlink
// (node_modules/.bin/action1-mcp -> ../action1-mcp-server/dist/index.js).
// The entry-point guard used to compare the symlink path with the real
// module path, so the bin exited 0 without starting. This test compiles
// the real dist output and starts it through such a symlink.

const root = fileURLToPath(new URL("../..", import.meta.url));
let work: string;
let bin: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "action1-mcp-bin-"));
  execFileSync(
    process.execPath,
    [join(root, "node_modules/typescript/bin/tsc"), "-p", root, "--outDir", join(work, "dist")],
    { stdio: "pipe" },
  );
  // Same module context as the published package: ESM, deps resolvable.
  writeFileSync(join(work, "package.json"), JSON.stringify({ type: "module" }));
  symlinkSync(join(root, "node_modules"), join(work, "node_modules"), "dir");
  mkdirSync(join(work, "bin"));
  bin = join(work, "bin", "action1-mcp");
  symlinkSync(join(work, "dist", "index.js"), bin);
}, 120_000);

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

function startViaSymlink(
  args: string[],
  stdin?: string,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "",
        ACTION1_BASE_URL: "https://127.0.0.1:1/api/3.0",
        ACTION1_CLIENT_ID: "dummy",
        ACTION1_CLIENT_SECRET: "dummy",
        ACTION1_LOG_LEVEL: "error",
      },
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
      // stdio server: one JSON-RPC answer is enough, then stop it.
      if (stdin !== undefined && stdout.includes("\n")) child.kill();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
    if (stdin !== undefined) child.stdin.write(stdin);
    else child.stdin.end();
    setTimeout(() => child.kill(), 15_000).unref();
  });
}

describe("bin started through a symlink", () => {
  it("answers initialize over stdio", async () => {
    const init = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "symlink-test", version: "0.0.0" },
      },
    });
    const { stdout } = await startViaSymlink([], `${init}\n`);
    const first = JSON.parse(stdout.split("\n")[0]!) as {
      id: number;
      result: { serverInfo: { name: string } };
    };
    expect(first.id).toBe(1);
    expect(first.result.serverInfo.name).toBe("action1-mcp-server");
  }, 30_000);

  it("prints --help", async () => {
    const { code, stdout } = await startViaSymlink(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/MCP_HTTP_TOKEN/);
  }, 30_000);
});
