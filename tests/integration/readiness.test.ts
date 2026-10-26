import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Action1Client } from "../../src/client/action1Client.js";
import { loadConfig, resetConfigCache } from "../../src/config.js";
import { createHttpApp } from "../../src/http.js";
import { SERVER_VERSION } from "../../src/version.js";

// GET /readyz: readiness for load balancers and orchestrators. Reports
// the version, whether the configuration loads and the state of the
// cached Action1 token, without calling Action1.

const ENV = {
  ACTION1_BASE_URL: "https://app.eu.action1.test/api/3.0",
  ACTION1_CLIENT_ID: "client-id-test",
  ACTION1_CLIENT_SECRET: "client-secret-test",
  ACTION1_ORG_ID: "00000000-0000-0000-0000-000000000001",
};
const TOKEN = "readyz-test-token-0123456789abcdef";

let saved: NodeJS.ProcessEnv;
let live: Server | undefined;

beforeEach(() => {
  saved = { ...process.env };
  Object.assign(process.env, ENV);
  resetConfigCache();
});

afterEach(async () => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  resetConfigCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (live) {
    const s = live;
    live = undefined;
    await new Promise<void>((r) => s.close(() => r()));
  }
});

async function start(client: Action1Client): Promise<number> {
  const base = loadConfig();
  const app = createHttpApp(
    { ...base, http: { ...base.http, host: "127.0.0.1", token: TOKEN } },
    { client },
  );
  live = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return (live.address() as AddressInfo).port;
}

function get(
  port: number,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method: "GET", path, headers: { host: `127.0.0.1:${port}` } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(text) as Record<string, unknown>,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("GET /readyz", () => {
  it("is ready with a valid config before any token was fetched, and makes no upstream call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const client = new Action1Client(loadConfig());
    const port = await start(client);
    const r = await get(port, "/readyz");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ready: true,
      service: "action1-mcp-server",
      version: SERVER_VERSION,
      checks: { config: "ok", token: "not_acquired" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports a cached token after a successful acquisition", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ access_token: "tkn", expires_in: 3600 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const client = new Action1Client(loadConfig());
    await client.tokens.getAccessToken();
    const port = await start(client);
    const r = await get(port, "/readyz");
    expect(r.status).toBe(200);
    expect(r.body.checks).toEqual({ config: "ok", token: "cached" });
  });

  it("is not ready (503) while token acquisition fails, without leaking the error text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad client secret xyz", { status: 401 })),
    );
    const client = new Action1Client(loadConfig());
    await client.tokens.getAccessToken().catch(() => undefined);
    const port = await start(client);
    const r = await get(port, "/readyz");
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ ready: false, checks: { config: "ok", token: "failing" } });
    expect(JSON.stringify(r.body)).not.toContain("xyz");
  });

  it("is not ready (503) when the configuration no longer loads", async () => {
    const client = new Action1Client(loadConfig());
    const port = await start(client);
    delete process.env.ACTION1_CLIENT_SECRET;
    resetConfigCache();
    const r = await get(port, "/readyz");
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ ready: false, checks: { config: "invalid" } });
  });
});
