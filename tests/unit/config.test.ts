import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../../src/config.js";

// Pass-2 audit found that BASE_URL validation was a Pass-1 fix but
// without tests. These pin the SSRF / metadata / non-https rejections
// so a refactor can't silently weaken them.

const REQUIRED = {
  ACTION1_CLIENT_ID: "x",
  ACTION1_CLIENT_SECRET: "y",
  ACTION1_ORG_ID: "00000000-0000-0000-0000-000000000001",
};

function setEnv(vars: Record<string, string | undefined>): void {
  for (const k of Object.keys(REQUIRED)) delete process.env[k];
  delete process.env.ACTION1_BASE_URL;
  delete process.env.MCP_HTTP_TOKEN;
  delete process.env.MCP_HTTP_ALLOWED_ORIGINS;
  delete process.env.PORT;
  delete process.env.HOST;
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfigCache();
}

describe("config — BASE_URL validation", () => {
  beforeEach(() => {
    Object.assign(process.env, REQUIRED);
  });
  afterEach(() => {
    setEnv({});
  });

  it("accepts a valid https URL", () => {
    setEnv({ ...REQUIRED, ACTION1_BASE_URL: "https://app.eu.action1.com/api/3.0" });
    expect(() => loadConfig()).not.toThrow();
  });

  it("accepts https with port and path", () => {
    setEnv({ ...REQUIRED, ACTION1_BASE_URL: "https://app.action1.local:8443/api/3.0/" });
    expect(loadConfig().baseUrl).toBe("https://app.action1.local:8443/api/3.0");
  });

  it("rejects http:// (clear-text would leak OAuth tokens)", () => {
    setEnv({ ...REQUIRED, ACTION1_BASE_URL: "http://app.eu.action1.com/api/3.0" });
    expect(() => loadConfig()).toThrow(/https/);
  });

  it("rejects javascript: scheme", () => {
    setEnv({ ...REQUIRED, ACTION1_BASE_URL: "javascript:alert(1)" });
    expect(() => loadConfig()).toThrow();
  });

  it("rejects file:// scheme", () => {
    setEnv({ ...REQUIRED, ACTION1_BASE_URL: "file:///etc/passwd" });
    expect(() => loadConfig()).toThrow();
  });

  it("rejects ftp:// scheme", () => {
    setEnv({ ...REQUIRED, ACTION1_BASE_URL: "ftp://app.action1.com" });
    expect(() => loadConfig()).toThrow();
  });

  it("rejects AWS metadata host (SSRF guard)", () => {
    setEnv({ ...REQUIRED, ACTION1_BASE_URL: "https://169.254.169.254/api/3.0" });
    expect(() => loadConfig()).toThrow(/metadata-service host/i);
  });

  it("rejects GCP metadata.google.internal", () => {
    setEnv({ ...REQUIRED, ACTION1_BASE_URL: "https://metadata.google.internal/api/3.0" });
    expect(() => loadConfig()).toThrow(/metadata-service host/i);
  });

  it("strips trailing slashes from BASE_URL", () => {
    setEnv({ ...REQUIRED, ACTION1_BASE_URL: "https://app.eu.action1.com/api/3.0////" });
    expect(loadConfig().baseUrl).toBe("https://app.eu.action1.com/api/3.0");
  });
});

// Pass-4 review: pin the MCP_HTTP_TOKEN edge-cases (whitespace-only,
// trailing whitespace, mid-whitespace, too-short) so a refactor of the
// refine+transform can't silently weaken the auth surface.
describe("config — MCP_HTTP_TOKEN validation", () => {
  beforeEach(() => {
    Object.assign(process.env, REQUIRED);
    process.env.ACTION1_BASE_URL = "https://app.eu.action1.com/api/3.0";
  });
  afterEach(() => {
    setEnv({});
  });

  it("accepts a 16+ char token", () => {
    setEnv({
      ...REQUIRED,
      ACTION1_BASE_URL: "https://app.eu.action1.com/api/3.0",
      MCP_HTTP_TOKEN: "abcdef0123456789abcdef0123",
    });
    expect(loadConfig().http.token).toBe("abcdef0123456789abcdef0123");
  });

  it("rejects a 15-char token", () => {
    setEnv({
      ...REQUIRED,
      ACTION1_BASE_URL: "https://app.eu.action1.com/api/3.0",
      MCP_HTTP_TOKEN: "abcdef012345678",
    });
    expect(() => loadConfig()).toThrow(/at least 16/i);
  });

  it("rejects a whitespace-only token (16 spaces)", () => {
    setEnv({
      ...REQUIRED,
      ACTION1_BASE_URL: "https://app.eu.action1.com/api/3.0",
      MCP_HTTP_TOKEN: "                ",
    });
    // 16 spaces: trim → "", length 0 → falls through transform → undefined.
    // No throw, but token is silently treated as "not set".
    expect(loadConfig().http.token).toBeUndefined();
  });

  it("trims trailing whitespace before length-check (16+padded passes)", () => {
    setEnv({
      ...REQUIRED,
      ACTION1_BASE_URL: "https://app.eu.action1.com/api/3.0",
      MCP_HTTP_TOKEN: "abcdef0123456789  ",
    });
    expect(loadConfig().http.token).toBe("abcdef0123456789");
  });

  it("rejects 16 chars padded down to <16 by trim", () => {
    setEnv({
      ...REQUIRED,
      ACTION1_BASE_URL: "https://app.eu.action1.com/api/3.0",
      MCP_HTTP_TOKEN: "shorttoken      ",
    });
    expect(() => loadConfig()).toThrow(/at least 16/i);
  });

  it("trims leading whitespace before length-check", () => {
    // Pass-6 review: symmetric to the trailing-whitespace test —
    // leading whitespace must also be stripped so a pasted token
    // doesn't get bitten by an invisible space.
    setEnv({
      ...REQUIRED,
      ACTION1_BASE_URL: "https://app.eu.action1.com/api/3.0",
      MCP_HTTP_TOKEN: "  abcdef0123456789",
    });
    expect(loadConfig().http.token).toBe("abcdef0123456789");
  });

  it("trims tab/newline whitespace, not just spaces", () => {
    setEnv({
      ...REQUIRED,
      ACTION1_BASE_URL: "https://app.eu.action1.com/api/3.0",
      MCP_HTTP_TOKEN: "\tabcdef0123456789\n",
    });
    expect(loadConfig().http.token).toBe("abcdef0123456789");
  });

  it("treats an unset MCP_HTTP_TOKEN as undefined", () => {
    setEnv({
      ...REQUIRED,
      ACTION1_BASE_URL: "https://app.eu.action1.com/api/3.0",
    });
    expect(loadConfig().http.token).toBeUndefined();
  });
});
