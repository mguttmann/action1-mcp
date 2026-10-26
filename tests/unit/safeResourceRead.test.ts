import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ProtocolError, ResourceNotFoundError } from "@modelcontextprotocol/server";
import { Action1ApiError } from "../../src/client/errors.js";
import { resetConfigCache } from "../../src/config.js";
import { safeResourceRead } from "../../src/resources/index.js";

// Resource read failures are JSON-RPC errors (MCP spec): an upstream 404
// is the SDK's ResourceNotFoundError, everything else InternalError (-32603)
// with the upstream status and hint in `data`. A failed read must never
// come back as successful content.

beforeAll(() => {
  process.env.ACTION1_BASE_URL = "https://app.eu.action1.test/api/3.0";
  process.env.ACTION1_CLIENT_ID = "x";
  process.env.ACTION1_CLIENT_SECRET = "y";
  process.env.ACTION1_ORG_ID = "00000000-0000-0000-0000-000000000001";
  resetConfigCache();
});

afterAll(() => {
  delete process.env.ACTION1_BASE_URL;
  delete process.env.ACTION1_CLIENT_ID;
  delete process.env.ACTION1_CLIENT_SECRET;
  delete process.env.ACTION1_ORG_ID;
  resetConfigCache();
});

function apiError(status: number, hint?: string): Action1ApiError {
  return new Action1ApiError({
    status,
    url: "https://app.eu.action1.test/api/3.0/vulnerabilities/orgX",
    method: "GET",
    body: "permission denied",
    ...(hint ? { hint } : {}),
  });
}

describe("safeResourceRead - error contract", () => {
  it("returns the body verbatim on success", async () => {
    const out = await safeResourceRead("action1://test", async () => '{"foo":"bar"}');
    expect(out.contents).toEqual([
      { uri: "action1://test", mimeType: "application/json", text: '{"foo":"bar"}' },
    ]);
  });

  it("an upstream 403 is a JSON-RPC InternalError with status and hint in data", async () => {
    const err = await safeResourceRead("action1://x", async () => {
      throw apiError(403, "API key may lack the vulnerabilities scope.");
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProtocolError);
    const pe = err as ProtocolError;
    expect(pe.code).toBe(-32603);
    expect(pe.data).toMatchObject({ uri: "action1://x", status: 403 });
    expect((pe.data as { hint: string }).hint).toContain("vulnerabilities scope");
  });

  it("an upstream 404 is the SDK's ResourceNotFoundError", async () => {
    const err = await safeResourceRead("action1://x", async () => {
      throw apiError(404);
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResourceNotFoundError);
    expect((err as ResourceNotFoundError).uri).toBe("action1://x");
  });

  it("a generic Error and a non-Error throw become InternalError", async () => {
    for (const thrown of [new Error("something else broke"), "string-only-error"]) {
      const err = await safeResourceRead("action1://x", async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- a non-Error throw is the case under test
        throw thrown;
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProtocolError);
      expect((err as ProtocolError).code).toBe(-32603);
      expect((err as Error).message).toContain(thrown instanceof Error ? thrown.message : thrown);
    }
  });
});

describe("resources/read over MCP", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a 403 from Action1 reaches the client as a JSON-RPC error, not as content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/oauth2/token")) {
          return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("forbidden", { status: 403 });
      }),
    );
    const { buildServer } = await import("../../src/server.js");
    const { Client } = await import("@modelcontextprotocol/client");
    const { InMemoryTransport } = await import("@modelcontextprotocol/server");
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const built = buildServer();
    await built.server.connect(serverTx);
    const client = new Client({ name: "res-test", version: "0.0.0" });
    await client.connect(clientTx);
    try {
      const err = await client
        .readResource({ uri: "action1://vulnerabilities/default" })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as { code?: number }).code).toBe(-32603);
      expect((err as Error).message).toContain("403");
    } finally {
      await client.close();
      await built.server.close();
    }
  });
});
