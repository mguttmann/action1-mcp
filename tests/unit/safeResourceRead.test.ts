import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Action1ApiError } from "../../src/client/errors.js";
import { resetConfigCache } from "../../src/config.js";
import { safeResourceRead } from "../../src/resources/index.js";

// `safeResourceRead` is the wrapper that catches Action1 API errors
// during a `resources/read` and returns a structured `{error, status?,
// hint?}` JSON payload INSTEAD OF letting the error bubble up as a
// JSON-RPC `-32603`. Pass-3 audit flagged that this code path was
// untested — these tests pin it. This rewrite imports the REAL
// implementation from src/resources/index.ts (previously the test
// re-implemented the function, which let the production implementation
// drift undetected).

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

describe("safeResourceRead — error contract", () => {
  it("returns the body verbatim on success", async () => {
    const out = await safeResourceRead("action1://test", async () => '{"foo":"bar"}');
    expect(out.contents).toHaveLength(1);
    expect(out.contents[0]?.text).toBe('{"foo":"bar"}');
    expect(out.contents[0]?.mimeType).toBe("application/json");
    expect(out.contents[0]?.uri).toBe("action1://test");
  });

  it("converts Action1ApiError into a structured JSON payload", async () => {
    const out = await safeResourceRead("action1://x", async () => {
      throw new Action1ApiError({
        status: 403,
        url: "https://app.eu.action1.test/api/3.0/vulnerabilities/orgX",
        method: "GET",
        body: "permission denied",
        hint: "API key may lack the vulnerabilities scope.",
      });
    });
    const payload = JSON.parse(out.contents[0]!.text) as Record<string, unknown>;
    expect(payload.error).toBe("resource_read_failed");
    expect(payload.status).toBe(403);
    expect(payload.hint).toContain("vulnerabilities scope");
  });

  it("converts a generic Error into a structured JSON payload", async () => {
    const out = await safeResourceRead("action1://x", async () => {
      throw new Error("something else broke");
    });
    const payload = JSON.parse(out.contents[0]!.text) as Record<string, unknown>;
    expect(payload.error).toBe("resource_read_failed");
    expect(payload.message).toBe("something else broke");
    expect(payload.status).toBeUndefined();
  });

  it("converts a non-Error throw value into a structured JSON payload", async () => {
    const out = await safeResourceRead("action1://x", async () => {
      throw "string-only-error";
    });
    const payload = JSON.parse(out.contents[0]!.text) as Record<string, unknown>;
    expect(payload.error).toBe("resource_read_failed");
    expect(payload.message).toBe("string-only-error");
  });

  it("never throws — even nested rejections become structured payloads", async () => {
    await expect(
      safeResourceRead("action1://x", async () => {
        throw new Action1ApiError({
          status: 500,
          url: "https://app.eu.action1.test/api/3.0/orgs",
          method: "GET",
          body: "",
        });
      }),
    ).resolves.toBeDefined();
  });

  it("Action1ApiError without a hint still produces a structured payload", async () => {
    const out = await safeResourceRead("action1://x", async () => {
      throw new Action1ApiError({
        status: 500,
        url: "https://app.eu.action1.test/api/3.0/orgs",
        method: "GET",
        body: "internal",
      });
    });
    const payload = JSON.parse(out.contents[0]!.text) as Record<string, unknown>;
    expect(payload.error).toBe("resource_read_failed");
    expect(payload.status).toBe(500);
    expect(payload.hint).toBeUndefined();
  });
});
