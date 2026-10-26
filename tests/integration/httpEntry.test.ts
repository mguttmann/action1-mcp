import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// End-to-end check of the real `--http` entry point (stateless
// Streamable HTTP with JSON responses), started as a child process on
// an ephemeral loopback port with dummy credentials. Guards the SDK
// transport wiring in src/index.ts and src/http.ts.

const TOKEN = "entry-test-token-0123456789abcdef";

const root = fileURLToPath(new URL("../..", import.meta.url));
let child: ChildProcess;
let base: string;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(
    process.execPath,
    ["--import", "tsx", "src/index.ts", "--http", "--port", String(port), "--host", "127.0.0.1"],
    {
      cwd: root,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        PATH: process.env.PATH ?? "",
        ACTION1_BASE_URL: "https://127.0.0.1:1/api/3.0",
        ACTION1_CLIENT_ID: "dummy",
        ACTION1_CLIENT_SECRET: "dummy",
        ACTION1_ORG_ID: "00000000-0000-0000-0000-000000000001",
        ACTION1_LOG_LEVEL: "error",
        MCP_HTTP_TOKEN: TOKEN,
      },
    },
  );
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error("HTTP server did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
}, 30_000);

afterAll(() => {
  child?.kill();
});

async function rpc(body: unknown, protocolVersion?: string): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${TOKEN}`,
      ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("--http entry point", () => {
  it("rejects requests without the Bearer token", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("answers initialize with the requested protocol revision as JSON", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "http-test", version: "0.0.0" },
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const json = (await res.json()) as { result: { protocolVersion: string } };
    expect(json.result.protocolVersion).toBe("2025-11-25");
  });

  it("serves tools/list statelessly", async () => {
    const res = await rpc(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      "2025-11-25",
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { result: { tools: unknown[] } };
    expect(json.result.tools.length).toBeGreaterThan(0);
  });
});
