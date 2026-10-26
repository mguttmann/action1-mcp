import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_VARS, loadConfig, normaliseHostname, resetConfigCache } from "../../src/config.js";

// Env handling as an operator meets it: `cp .env.example .env`, fill in
// the required keys, start with `node --env-file=.env`. Node sets every
// key that is present but empty to "", so empty strings must behave
// exactly like unset keys. Numeric and host values are validated so a
// typo fails at startup instead of reaching Action1 or `listen()`.

const root = fileURLToPath(new URL("../..", import.meta.url));
const ENV_EXAMPLE = readFileSync(`${root}.env.example`, "utf8");

const DUMMY_REQUIRED = {
  ACTION1_BASE_URL: "https://app.eu.action1.com/api/3.0",
  ACTION1_CLIENT_ID: "api-key-dummy@action1.com",
  ACTION1_CLIENT_SECRET: "dummy-secret",
};

let saved: NodeJS.ProcessEnv;

function useEnv(vars: Record<string, string>): void {
  for (const k of Object.keys(ENV_VARS)) delete process.env[k];
  Object.assign(process.env, vars);
  resetConfigCache();
}

beforeEach(() => {
  saved = { ...process.env };
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in saved)) delete process.env[k];
  }
  Object.assign(process.env, saved);
  resetConfigCache();
});

describe("config - the real .env.example", () => {
  it("loads with only the required keys filled in (empty optional keys count as unset)", () => {
    const fromFile = parseEnv(ENV_EXAMPLE) as Record<string, string>;
    useEnv({ ...fromFile, ...DUMMY_REQUIRED });
    const cfg = loadConfig();
    expect(cfg.defaultOrgId).toBeUndefined();
    expect(cfg.http.host).toBe("127.0.0.1");
    expect(cfg.http.port).toBe(3000);
    expect(cfg.http.token).toBeUndefined();
    expect(cfg.http.allowedOrigins).toEqual([]);
    expect(cfg.http.allowedHosts).toEqual([]);
    expect(cfg.http.allowNoAuth).toBe(false);
    expect(cfg.http.trustProxy).toBe(false);
    expect(cfg.allowDestructive).toBe(false);
    expect(cfg.destructiveAutoConfirm).toBe(false);
    expect(cfg.lastSeenStaleMinutes).toBe(10);
  });

  it("lists exactly the env vars the config schema reads", () => {
    const keysInFile = Object.keys(parseEnv(ENV_EXAMPLE)).sort();
    expect(keysInFile).toEqual(Object.keys(ENV_VARS).sort());
  });
});

describe("config - empty strings behave like unset keys", () => {
  it("HOST= falls back to 127.0.0.1 instead of binding every interface", () => {
    useEnv({ ...DUMMY_REQUIRED, HOST: "" });
    expect(loadConfig().http.host).toBe("127.0.0.1");
  });

  it("whitespace-only values are unset too", () => {
    useEnv({ ...DUMMY_REQUIRED, HOST: "  ", ACTION1_ORG_ID: " ", PORT: " " });
    const cfg = loadConfig();
    expect(cfg.http.host).toBe("127.0.0.1");
    expect(cfg.defaultOrgId).toBeUndefined();
    expect(cfg.http.port).toBe(3000);
  });

  it("empty ACTION1_LOG_LEVEL and ACTION1_ORG_ID are accepted", () => {
    useEnv({ ...DUMMY_REQUIRED, ACTION1_LOG_LEVEL: "", ACTION1_ORG_ID: "" });
    expect(() => loadConfig()).not.toThrow();
  });

  it("an empty required key still fails with a clear message", () => {
    useEnv({ ...DUMMY_REQUIRED, ACTION1_CLIENT_SECRET: "" });
    expect(() => loadConfig()).toThrow(/ACTION1_CLIENT_SECRET/);
  });
});

describe("config - ACTION1_LOG_LEVEL", () => {
  it("is case-insensitive like the logger", () => {
    useEnv({ ...DUMMY_REQUIRED, ACTION1_LOG_LEVEL: "INFO" });
    expect(() => loadConfig()).not.toThrow();
    useEnv({ ...DUMMY_REQUIRED, ACTION1_LOG_LEVEL: " Warning " });
    expect(() => loadConfig()).not.toThrow();
  });

  it("still rejects unknown levels", () => {
    useEnv({ ...DUMMY_REQUIRED, ACTION1_LOG_LEVEL: "loud" });
    expect(() => loadConfig()).toThrow(/ACTION1_LOG_LEVEL/);
  });
});

describe("config - numeric validation", () => {
  it.each(["abc", "0", "65536", "80.5", "-1"])("rejects PORT=%s", (port) => {
    useEnv({ ...DUMMY_REQUIRED, PORT: port });
    expect(() => loadConfig()).toThrow(/PORT/);
  });

  it("accepts a valid PORT", () => {
    useEnv({ ...DUMMY_REQUIRED, PORT: "38123" });
    expect(loadConfig().http.port).toBe(38123);
  });

  it.each([
    ["ACTION1_DEFAULT_TIMEOUT_MINUTES", "banana"],
    ["ACTION1_DEFAULT_TIMEOUT_MINUTES", "10m"],
    ["ACTION1_DEFAULT_RETRY_MINUTES", "-5"],
    ["ACTION1_DEFAULT_RETRY_MINUTES", "10081"],
  ])("rejects %s=%s", (key, value) => {
    useEnv({ ...DUMMY_REQUIRED, [key]: value });
    expect(() => loadConfig()).toThrow(new RegExp(key));
  });

  it("keeps the documented defaults and accepts valid minute values", () => {
    useEnv({ ...DUMMY_REQUIRED });
    expect(loadConfig().defaultTimeoutMinutes).toBe("10");
    expect(loadConfig().defaultRetryMinutes).toBe("1440");
    useEnv({
      ...DUMMY_REQUIRED,
      ACTION1_DEFAULT_TIMEOUT_MINUTES: "30",
      ACTION1_DEFAULT_RETRY_MINUTES: "0",
    });
    expect(loadConfig().defaultTimeoutMinutes).toBe("30");
    expect(loadConfig().defaultRetryMinutes).toBe("0");
  });
});

describe("config - ACTION1_ALLOW_DESTRUCTIVE message matches behaviour", () => {
  it("a typo aborts startup and the message says so", () => {
    useEnv({ ...DUMMY_REQUIRED, ACTION1_ALLOW_DESTRUCTIVE: "ture" });
    expect(() => loadConfig()).toThrow(/aborts startup/);
    expect(() => loadConfig()).not.toThrow(/treated as disabled/);
  });
});

describe("config - HTTP settings", () => {
  it("normalises MCP_HTTP_ALLOWED_HOSTS to lowercase hostnames without port", () => {
    useEnv({
      ...DUMMY_REQUIRED,
      MCP_HTTP_ALLOWED_HOSTS: "MCP.Example.com, other.example:443 ,[fd00::1]:8443,,",
    });
    expect(loadConfig().http.allowedHosts).toEqual(["mcp.example.com", "other.example", "fd00::1"]);
  });

  it("parses MCP_HTTP_ALLOW_NO_AUTH as a strict flag", () => {
    useEnv({ ...DUMMY_REQUIRED, MCP_HTTP_ALLOW_NO_AUTH: "TRUE" });
    expect(loadConfig().http.allowNoAuth).toBe(true);
    useEnv({ ...DUMMY_REQUIRED, MCP_HTTP_ALLOW_NO_AUTH: "maybe" });
    expect(() => loadConfig()).toThrow(/MCP_HTTP_ALLOW_NO_AUTH/);
  });

  it("maps TRUST_PROXY into the config", () => {
    useEnv({ ...DUMMY_REQUIRED, TRUST_PROXY: "loopback" });
    expect(loadConfig().http.trustProxy).toBe("loopback");
  });
});

describe("normaliseHostname", () => {
  it.each([
    ["localhost:3000", "localhost"],
    ["LOCALHOST", "localhost"],
    ["[::1]:3000", "::1"],
    ["[::1]", "::1"],
    ["::1", "::1"],
    ["mcp.example.com:443", "mcp.example.com"],
    // Malformed values stay unchanged and therefore never match.
    ["localhost:x@evil.example", "localhost:x@evil.example"],
    ["[::1]evil", "[::1]evil"],
  ])("%s -> %s", (raw, expected) => {
    expect(normaliseHostname(raw)).toBe(expected);
  });
});
