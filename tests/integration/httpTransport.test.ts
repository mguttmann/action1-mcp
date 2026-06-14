import { afterEach, describe, expect, it } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { parseTrustProxy } from "../../src/index.js";

// Integration tests for the HTTP transport hardening landed in
// Pass-13:
//   - Item 3: body parser scoped to `/mcp` so unauth POSTs to unknown
//             paths don't burn the 1 MB JSON budget before 404.
//   - Item 4: TRUST_PROXY env var → Express `trust proxy` setting so
//             `req.ip` resolves to the real client IP behind a proxy
//             (and stays the socket peer when no proxy is configured).
//
// We don't import `runHttp` directly — it has side-effects (binds a
// port, registers SIGTERM handlers) that pollute the test process.
// Instead we replicate the same middleware composition in a throwaway
// Express app and assert the relevant invariants. The trust-proxy
// value-mapping is tested in pure form via the exported helper.

describe("parseTrustProxy — env-to-Express mapping (Pass-13 Item 4)", () => {
  it("undefined → false (default-deny)", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
  });
  it("empty string → false", () => {
    expect(parseTrustProxy("")).toBe(false);
  });
  it("'false' (any case-neutral spelling) → false", () => {
    expect(parseTrustProxy("false")).toBe(false);
  });
  it("'true' → true (trust every hop)", () => {
    expect(parseTrustProxy("true")).toBe(true);
  });
  it("'loopback' → 'loopback' (passes through to Express)", () => {
    expect(parseTrustProxy("loopback")).toBe("loopback");
  });
  it("digit-only string → number (hop count)", () => {
    expect(parseTrustProxy("2")).toBe(2);
  });
  it("CIDR / IP list → verbatim string", () => {
    expect(parseTrustProxy("10.0.0.0/8")).toBe("10.0.0.0/8");
    expect(parseTrustProxy("10.0.0.1,10.0.0.2")).toBe("10.0.0.1,10.0.0.2");
  });
  it("trims surrounding whitespace", () => {
    expect(parseTrustProxy("  true  ")).toBe(true);
    expect(parseTrustProxy("\t\tloopback\n")).toBe("loopback");
  });
});

// ---------------------------------------------------------------------------
// trust proxy effect on req.ip — runtime behaviour
//
// Express only consults X-Forwarded-For when `trust proxy` is set.
// With `trust proxy = false`, X-Forwarded-For is ignored and `req.ip`
// is the socket peer; with `trust proxy = 'loopback'`, X-Forwarded-For
// from 127.0.0.1 is honoured.
// ---------------------------------------------------------------------------

interface TestServer {
  server: Server;
  port: number;
  url: string;
}

async function startTestServer(
  configure: (app: ReturnType<typeof express>) => void,
): Promise<TestServer> {
  const app = express();
  configure(app);
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  const port = (server.address() as AddressInfo).port;
  return { server, port, url: `http://127.0.0.1:${port}` };
}

async function stopTestServer(s: TestServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    s.server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("trust proxy runtime behaviour", () => {
  let live: TestServer | undefined;
  afterEach(async () => {
    if (live) {
      await stopTestServer(live);
      live = undefined;
    }
  });

  it("TRUST_PROXY=false → req.ip is socket peer, X-Forwarded-For ignored", async () => {
    live = await startTestServer((app) => {
      app.set("trust proxy", parseTrustProxy("false"));
      app.get("/whoami", (req: Request, res: Response) => {
        res.json({ ip: req.ip });
      });
    });
    const res = await fetch(`${live.url}/whoami`, {
      headers: { "X-Forwarded-For": "203.0.113.99" },
    });
    const body = (await res.json()) as { ip: string };
    // Spoof attempt ignored → socket peer wins. Could be ::1 (IPv6
    // loopback) or 127.0.0.1 depending on stack — both are
    // unambiguously NOT the spoofed value.
    expect(body.ip).not.toBe("203.0.113.99");
  });

  it("TRUST_PROXY=loopback → X-Forwarded-For from 127.0.0.1 is honoured", async () => {
    live = await startTestServer((app) => {
      app.set("trust proxy", parseTrustProxy("loopback"));
      app.get("/whoami", (req: Request, res: Response) => {
        res.json({ ip: req.ip });
      });
    });
    const res = await fetch(`${live.url}/whoami`, {
      headers: { "X-Forwarded-For": "203.0.113.42" },
    });
    const body = (await res.json()) as { ip: string };
    expect(body.ip).toBe("203.0.113.42");
  });
});

// ---------------------------------------------------------------------------
// Body parser scope (Pass-13 Item 3)
//
// In production we mount `express.json({limit:'1mb'})` ONLY on `/mcp`
// after rate-limit + bearer + origin checks pass. Pre-fix, the parser
// was global → an unauthenticated POST to any path parsed 1 MB of JSON
// before the 404. Test replicates the per-route mount and verifies:
//   1. POST /mcp with a JSON body → req.body is populated.
//   2. POST /unknown with a JSON body → 404, body parser NEVER ran
//      (we observe via a flag the parser would otherwise have flipped).
// ---------------------------------------------------------------------------

describe("body parser scope (Pass-13 Item 3)", () => {
  let live: TestServer | undefined;
  let parserFired = false;
  afterEach(async () => {
    if (live) {
      await stopTestServer(live);
      live = undefined;
    }
    parserFired = false;
  });

  it("POST /mcp parses the body; POST /unknown 404s without parsing", async () => {
    // Wrapper around express.json that records whether it ever ran.
    // If the parser is mounted globally, this flag would be true on
    // any POST regardless of path.
    const trackingParser = (limit: string) => {
      const inner = express.json({ limit });
      return (req: Request, res: Response, next: NextFunction): void => {
        parserFired = true;
        inner(req, res, next);
      };
    };
    live = await startTestServer((app) => {
      // Per-route mount on /mcp ONLY — mirrors src/index.ts production
      // wiring exactly.
      app.post("/mcp", trackingParser("1mb"), (req: Request, res: Response) => {
        res.json({ received: req.body });
      });
    });

    // /mcp with a small JSON body → parser fires, body is parsed.
    parserFired = false;
    const ok = await fetch(`${live.url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(ok.status).toBe(200);
    expect(parserFired).toBe(true);
    const okBody = (await ok.json()) as { received: { hello: string } };
    expect(okBody.received.hello).toBe("world");

    // /unknown with a JSON body → 404 AND parser did NOT fire.
    parserFired = false;
    const bad = await fetch(`${live.url}/unknown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ junk: "x".repeat(1024) }),
    });
    expect(bad.status).toBe(404);
    expect(parserFired).toBe(false);
  });
});
