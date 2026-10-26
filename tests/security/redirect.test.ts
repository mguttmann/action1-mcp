import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Action1Client } from "../../src/client/action1Client.js";
import { TokenProvider } from "../../src/client/auth.js";
import type { AppConfig } from "../../src/config.js";

// A redirect from the configured Action1 host must never carry the
// client secret, the bearer token or a mutation body to another origin.
// Both fetch paths (token request and API request) use redirect:"error":
// the foreign origin must not see a single request.

interface Seen {
  method: string;
  url: string;
  body: string;
}

const servers: Server[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<number> {
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return (server.address() as AddressInfo).port;
}

/** Foreign origin: records everything it receives. */
async function foreign(): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const port = await listen((req, res, body) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access_token: "evil", expires_in: 3600, stolen: true }));
  });
  return { port, seen };
}

function cfgFor(port: number): AppConfig {
  return {
    baseUrl: `http://127.0.0.1:${port}/api/3.0`,
    defaultOrgId: "00000000-0000-0000-0000-000000000001",
    clientId: "cid",
    clientSecret: "SUPERSECRET",
    defaultTimeoutMinutes: "10",
    defaultRetryMinutes: "1440",
    lastSeenStaleMinutes: 10,
    allowDestructive: false,
    destructiveAutoConfirm: false,
    allowAccountOps: false,
    allowedOrgIds: [],
    toolsets: [],
    redactPii: false,
    requestTimeoutMs: 5_000,
    tokenTimeoutMs: 2_000,
    http: {
      port: 0,
      host: "127.0.0.1",
      allowedOrigins: [],
      allowedHosts: [],
      token: undefined,
      allowNoAuth: false,
      trustProxy: false,
    },
  };
}

describe("redirects to a foreign origin are refused", () => {
  it("the token request does not follow a 307 (client secret stays home)", async () => {
    const evil = await foreign();
    const port = await listen((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${evil.port}/api/3.0/oauth2/token` });
      res.end();
    });
    const tokens = new TokenProvider(cfgFor(port));
    await expect(tokens.getAccessToken()).rejects.toThrow(/redirect/i);
    expect(evil.seen).toEqual([]);
  });

  it("an API mutation does not follow a 307 (body and response stay home)", async () => {
    const evil = await foreign();
    const port = await listen((req, res) => {
      if (req.url?.endsWith("/oauth2/token")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "tkn", expires_in: 3600 }));
        return;
      }
      res.writeHead(307, { location: `http://127.0.0.1:${evil.port}${req.url ?? "/"}` });
      res.end();
    });
    const client = new Action1Client(cfgFor(port));
    const err = await client
      .request("/endpoints/managed/o1", { method: "POST", body: { a: 1 }, retry: false })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/redirect/i);
    expect(evil.seen).toEqual([]);
  });

  it("a GET does not follow a 307 either and is not retried", async () => {
    const evil = await foreign();
    let hits = 0;
    const port = await listen((req, res) => {
      if (req.url?.endsWith("/oauth2/token")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "tkn", expires_in: 3600 }));
        return;
      }
      hits += 1;
      res.writeHead(307, { location: `http://127.0.0.1:${evil.port}${req.url ?? "/"}` });
      res.end();
    });
    const client = new Action1Client(cfgFor(port));
    await expect(client.request("/organizations")).rejects.toThrow(/redirect/i);
    expect(evil.seen).toEqual([]);
    expect(hits).toBe(1);
  });
});

// scripts/live-shape-check.mjs does its own fetch calls with the owner's
// real credentials. It insists on an https base URL, so the stub below
// only rewrites that URL to a local http listener and hands the script's
// own RequestInit to the real fetch, which then follows or refuses the
// redirect exactly as it would against the live host.
const script = (await import("../../scripts/live-shape-check.mjs")) as {
  run: (opts: { out: string; env: Record<string, string> }) => Promise<unknown>;
};

describe("live shape check refuses redirects", () => {
  const realFetch = globalThis.fetch;
  const HTTPS = "https://action1.redirect.test";

  function routeTo(port: number): void {
    vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) =>
      realFetch(String(input).replace(HTTPS, `http://127.0.0.1:${port}`), init),
    );
  }

  const env = {
    ACTION1_BASE_URL: `${HTTPS}/api/3.0`,
    ACTION1_CLIENT_ID: "cid",
    ACTION1_CLIENT_SECRET: "SUPERSECRET",
    ACTION1_ORG_ID: "00000000-0000-0000-0000-000000000001",
  };
  const out = (): string => join(mkdtempSync(join(tmpdir(), "live-shape-redirect-")), "r.json");

  it("the token request does not follow a 307 (client secret stays home)", async () => {
    const evil = await foreign();
    const port = await listen((req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${evil.port}${req.url ?? "/"}` });
      res.end();
    });
    routeTo(port);
    await expect(script.run({ out: out(), env })).rejects.toThrow();
    expect(evil.seen).toEqual([]);
  });

  it("the GET probes do not follow a 307 either", async () => {
    const evil = await foreign();
    let hits = 0;
    const port = await listen((req, res) => {
      if (req.url?.endsWith("/oauth2/token")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "tkn", expires_in: 3600 }));
        return;
      }
      hits += 1;
      res.writeHead(307, { location: `http://127.0.0.1:${evil.port}${req.url ?? "/"}` });
      res.end();
    });
    routeTo(port);
    await script.run({ out: out(), env });
    expect(hits).toBeGreaterThan(0);
    expect(evil.seen).toEqual([]);
  });
});

// The same leak came back once through a new fetch call (the live shape
// script), so the class is guarded here: every fetch call in src/ and
// scripts/ must refuse redirects. The only exception is the spec
// download, which sends no credentials.
describe("every fetch call refuses redirects", () => {
  const CREDENTIAL_FREE = new Set(["scripts/fetch-spec.mjs"]);
  const root = new URL("../../", import.meta.url);

  function files(dir: string): string[] {
    return readdirSync(new URL(dir, root)).flatMap((name) => {
      const rel = `${dir}/${name}`;
      if (statSync(new URL(rel, root)).isDirectory()) return files(rel);
      return /\.(?:ts|mjs|js)$/.test(name) ? [rel] : [];
    });
  }

  it('passes redirect: "error" in each fetch call', () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const rel of [...files("src"), ...files("scripts")]) {
      if (CREDENTIAL_FREE.has(rel)) continue;
      const src = readFileSync(new URL(rel, root), "utf8");
      for (const m of src.matchAll(/\bfetch\(/g)) {
        // The call's arguments: up to the matching closing parenthesis.
        let depth = 0;
        let end = m.index + m[0].length - 1;
        for (; end < src.length; end++) {
          if (src[end] === "(") depth++;
          else if (src[end] === ")" && --depth === 0) break;
        }
        seen++;
        if (!/redirect:\s*"error"/.test(src.slice(m.index, end))) {
          offenders.push(`${rel}:${src.slice(0, m.index).split("\n").length}`);
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
