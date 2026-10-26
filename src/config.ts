import { z } from "zod";
import { currentRequestContext } from "./utils/requestContext.js";

const LOG_LEVELS = [
  "debug",
  "info",
  "notice",
  "warn",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
] as const;

const FLAG_VALUES = ["true", "1", "yes", "false", "0", "no"];

/** Strict boolean env flag: true/1/yes or false/0/no, case-insensitive. */
function flagEnv(name: string) {
  return z
    .string()
    .optional()
    .refine(
      (v) => v === undefined || FLAG_VALUES.includes(v.trim().toLowerCase()),
      `${name} must be one of: true / 1 / yes (to enable) or false / 0 / no / empty (to disable). Any other value aborts startup because it probably indicates a typo.`,
    );
}

/**
 * Minutes value for script-execution defaults. Kept as a digit string
 * because the payload builders pass it through verbatim; the range
 * matches the per-call `timeout_minutes` / `retry_minutes` inputs.
 */
function minutesEnv(name: string, fallback: string) {
  return z
    .string()
    .optional()
    .refine(
      (v) => v === undefined || (/^\d+$/.test(v) && Number(v) <= 10080),
      `${name} must be an integer number of minutes in [0, 10080].`,
    )
    .transform((v) => (v === undefined ? fallback : String(Number.parseInt(v, 10))));
}

function splitList(v: string | undefined): string[] {
  return v
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

/**
 * Normalise a host as it appears in a `Host` header or an allowlist
 * entry to a bare lowercase hostname: strips the port and the brackets
 * of an IPv6 literal (`[::1]:3000` -> `::1`, `Example.com:443` ->
 * `example.com`). A bare IPv6 literal without brackets is kept whole.
 */
export function normaliseHostname(raw: string): string {
  const v = raw.trim().toLowerCase();
  // Anything that is not `name`, `name:port`, `[v6]` or `[v6]:port` is
  // returned unchanged, so it can never match an allowlist entry.
  const bracketed = /^\[([^\]]+)\](?::\d*)?$/.exec(v);
  if (bracketed) return bracketed[1]!;
  const withPort = /^([^:]+):\d*$/.exec(v);
  if (withPort) return withPort[1]!;
  return v;
}

/**
 * Map the operator-supplied TRUST_PROXY env value to Express's
 * `trust proxy` setting. Behind nginx / Cloudflare / k8s ingress,
 * `req.ip` would otherwise be the proxy peer and every user would
 * share a rate-limit bucket. Operators MUST only set this when an
 * upstream proxy is the ONLY ingress: trusting X-Forwarded-For from
 * arbitrary clients lets them spoof `req.ip` and bypass per-IP rate
 * limits.
 *
 * Accepted values match Express's `trust proxy` setting:
 *   - 'false' (default): trust no proxy; `req.ip` = socket peer
 *   - 'true':            trust every proxy hop (X-Forwarded-For chain)
 *   - 'loopback':        trust 127.0.0.1 / ::1 / linklocal
 *   - integer (digits):  trust N hops from the socket peer
 *   - anything else:     passed through verbatim (CIDR / IP list)
 */
export function parseTrustProxy(raw: string | undefined): boolean | string | number {
  const v = (raw ?? "false").trim();
  if (v === "" || v === "false") return false;
  if (v === "true") return true;
  if (/^\d+$/.test(v)) return Number.parseInt(v, 10);
  return v;
}

/**
 * Values of ACTION1_TOOLSETS. `all` (the default) registers every tool;
 * `read` keeps only tools annotated readOnlyHint:true; `curated` keeps
 * only the hand-written tools (no generated per-operation tools).
 * Several values are combined as an intersection: `curated,read` is the
 * read-only subset of the curated tools.
 */
export const TOOLSETS = ["all", "read", "curated"] as const;
export type Toolset = (typeof TOOLSETS)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Default ACTION1_REQUEST_TIMEOUT_MS: budget for one API call including retries. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** Default ACTION1_TOKEN_TIMEOUT_MS: timeout for one OAuth token attempt. */
export const DEFAULT_TOKEN_TIMEOUT_MS = 15_000;
const TIMEOUT_MS_MIN = 1_000;
const TIMEOUT_MS_MAX = 600_000;

// Upper bound (ms) for one Action1 call, including its retries and
// back-off sleeps (request) or for one token request attempt (token).
function timeoutMsEnv(name: string, fallback: number) {
  return z
    .string()
    .optional()
    .refine((v) => {
      if (v === undefined) return true;
      if (!/^\d+$/.test(v)) return false;
      const n = Number.parseInt(v, 10);
      return n >= TIMEOUT_MS_MIN && n <= TIMEOUT_MS_MAX;
    }, `${name} must be an integer number of milliseconds in [${TIMEOUT_MS_MIN}, ${TIMEOUT_MS_MAX}].`)
    .transform((v) => (v === undefined ? fallback : Number.parseInt(v, 10)));
}

const EnvSchema = z.object({
  ACTION1_BASE_URL: z
    .string()
    .url()
    .refine(
      (u) => /^https:\/\//i.test(u),
      "ACTION1_BASE_URL must start with https://. Plain http exposes OAuth tokens to network observers; non-http schemes (file:, javascript:, ftp:) point the OAuth client at the wrong target.",
    )
    .refine((u) => {
      // Block obvious SSRF / metadata-service URLs. Operator
      // misconfiguration that points the server at AWS/GCP metadata
      // would otherwise leak the OAuth flow there.
      try {
        const host = new URL(u).hostname.toLowerCase();
        if (host === "169.254.169.254") return false; // AWS / GCP metadata
        if (host === "metadata.google.internal") return false;
        return true;
      } catch {
        return false;
      }
    }, "ACTION1_BASE_URL points at a known metadata-service host. Use the public Action1 API URL instead.")
    .transform((url) => url.replace(/\/+$/, "")),
  ACTION1_ORG_ID: z.string().min(1).optional(),
  ACTION1_CLIENT_ID: z.string().min(1),
  ACTION1_CLIENT_SECRET: z.string().min(1),
  ACTION1_DEFAULT_TIMEOUT_MINUTES: minutesEnv("ACTION1_DEFAULT_TIMEOUT_MINUTES", "10"),
  ACTION1_DEFAULT_RETRY_MINUTES: minutesEnv("ACTION1_DEFAULT_RETRY_MINUTES", "1440"),
  // Stale-threshold knob for the connectivity check that script /
  // reboot / execute_and_wait tools run before firing a destructive
  // action. Default 10 min; range 1..1440 (24h).
  ACTION1_LAST_SEEN_STALE_MINUTES: z
    .string()
    .optional()
    .refine((v) => {
      if (v === undefined) return true;
      if (!/^\d+$/.test(v)) return false;
      const n = Number.parseInt(v, 10);
      return n >= 1 && n <= 1440;
    }, "ACTION1_LAST_SEEN_STALE_MINUTES must be an integer in [1, 1440].")
    .transform((v) => (v === undefined ? 10 : Number.parseInt(v, 10))),
  ACTION1_LOG_LEVEL: z.preprocess(
    (v) => (typeof v === "string" ? v.trim().toLowerCase() : v),
    z.enum(LOG_LEVELS).optional(),
  ),
  ACTION1_ALLOW_DESTRUCTIVE: flagEnv("ACTION1_ALLOW_DESTRUCTIVE"),
  ACTION1_DESTRUCTIVE_AUTO_CONFIRM: flagEnv("ACTION1_DESTRUCTIVE_AUTO_CONFIRM"),
  ACTION1_ALLOW_ACCOUNT_OPS: flagEnv("ACTION1_ALLOW_ACCOUNT_OPS"),
  ACTION1_ALLOW_ENTERPRISE_OPS: flagEnv("ACTION1_ALLOW_ENTERPRISE_OPS"),
  ACTION1_ALLOWED_ORG_IDS: z
    .string()
    .optional()
    .transform((v) => splitList(v).map((id) => id.toLowerCase()))
    .refine(
      (ids) => ids.every((id) => UUID_RE.test(id)),
      "ACTION1_ALLOWED_ORG_IDS must be a comma-separated list of organization UUIDs.",
    ),
  ACTION1_TOOLSETS: z
    .string()
    .optional()
    .transform((v) => splitList(v).map((t) => t.toLowerCase()))
    .refine(
      (sets) => sets.every((t) => (TOOLSETS as readonly string[]).includes(t)),
      `ACTION1_TOOLSETS must be a comma-separated list of: ${TOOLSETS.join(", ")}.`,
    )
    .transform((sets) => sets as Toolset[]),
  ACTION1_REDACT_PII: flagEnv("ACTION1_REDACT_PII"),
  PORT: z
    .string()
    .optional()
    .refine(
      (v) => v === undefined || (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535),
      "PORT must be an integer in [1, 65535].",
    )
    .transform((v) => (v === undefined ? 3000 : Number.parseInt(v, 10))),
  HOST: z
    .string()
    .optional()
    .transform((v) => v ?? "127.0.0.1"),
  MCP_HTTP_TOKEN: z
    .string()
    .optional()
    .refine((v) => v === undefined || v.length >= 16, {
      message:
        "MCP_HTTP_TOKEN must be at least 16 non-whitespace characters (use `openssl rand -hex 32` to generate). Short tokens are brute-forceable in seconds.",
    }),
  MCP_HTTP_ALLOW_NO_AUTH: flagEnv("MCP_HTTP_ALLOW_NO_AUTH"),
  MCP_HTTP_ALLOWED_HOSTS: z
    .string()
    .optional()
    .transform((v) => splitList(v).map(normaliseHostname)),
  MCP_HTTP_ALLOWED_ORIGINS: z
    .string()
    .optional()
    .transform((v) => splitList(v)),
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v) => parseTrustProxy(v)),
  ACTION1_REQUEST_TIMEOUT_MS: timeoutMsEnv(
    "ACTION1_REQUEST_TIMEOUT_MS",
    DEFAULT_REQUEST_TIMEOUT_MS,
  ),
  ACTION1_TOKEN_TIMEOUT_MS: timeoutMsEnv("ACTION1_TOKEN_TIMEOUT_MS", DEFAULT_TOKEN_TIMEOUT_MS),
});

type EnvKey = keyof typeof EnvSchema.shape;

/** Section of `--help` an env var is listed under. */
export type EnvVarGroup = "required" | "recommended" | "optional" | "http";

/**
 * One-line documentation for every env var the schema reads. Typed
 * against the schema keys, so adding a key without documenting it is a
 * compile error. `--help` renders from this table and a unit test holds
 * `.env.example` to the same key set.
 */
export const ENV_VARS: Record<EnvKey, { group: EnvVarGroup; summary: string }> = {
  ACTION1_BASE_URL: {
    group: "required",
    summary: "Action1 API base URL, e.g. https://app.eu.action1.com/api/3.0",
  },
  ACTION1_CLIENT_ID: {
    group: "required",
    summary: "OAuth2 client id of the Action1 API credential",
  },
  ACTION1_CLIENT_SECRET: {
    group: "required",
    summary: "OAuth2 client secret of the Action1 API credential",
  },
  ACTION1_ORG_ID: {
    group: "recommended",
    summary: "Default organization id (otherwise every tool call must pass org_id)",
  },
  ACTION1_DEFAULT_TIMEOUT_MINUTES: {
    group: "optional",
    summary: "Default script timeout in minutes, 0..10080 (default 10)",
  },
  ACTION1_DEFAULT_RETRY_MINUTES: {
    group: "optional",
    summary: "Default retry window in minutes, 0..10080 (default 1440)",
  },
  ACTION1_LAST_SEEN_STALE_MINUTES: {
    group: "optional",
    summary: "Connectivity staleness threshold in minutes, 1..1440 (default 10)",
  },
  ACTION1_LOG_LEVEL: {
    group: "optional",
    summary: "debug | info | notice | warn | error | critical | alert | emergency (default info)",
  },
  ACTION1_ALLOW_DESTRUCTIVE: {
    group: "optional",
    summary: "Master switch for destructive tools: true/1/yes (default off)",
  },
  ACTION1_DESTRUCTIVE_AUTO_CONFIRM: {
    group: "optional",
    summary: "Isolated single-operator test setups only; see docs/SECURITY.md (default off)",
  },
  ACTION1_ALLOW_ACCOUNT_OPS: {
    group: "optional",
    summary:
      "Also allow account/identity mutations (users, roles, enterprise, organizations, subscription, raw_request writes): true/1/yes (default off)",
  },
  ACTION1_ALLOW_ENTERPRISE_OPS: {
    group: "optional",
    summary:
      "With ACTION1_ALLOWED_ORG_IDS set: also allow mutations not bound to one allowed org (enterprise paths and scopes): true/1/yes (default off)",
  },
  ACTION1_ALLOWED_ORG_IDS: {
    group: "recommended",
    summary:
      "Comma-separated org UUIDs tools may address; other org_id values are refused (default: any)",
  },
  ACTION1_TOOLSETS: {
    group: "optional",
    summary:
      "Tools to register: all | read | curated, comma-separated = intersection (default all)",
  },
  ACTION1_REDACT_PII: {
    group: "optional",
    summary:
      "Mask user names, IPs, MACs, addresses, serials, e-mail addresses and AD fields in tool output: true/1/yes (default off)",
  },
  ACTION1_REQUEST_TIMEOUT_MS: {
    group: "optional",
    summary: "Budget for one Action1 API call incl. retries, ms, 1000..600000 (default 60000)",
  },
  ACTION1_TOKEN_TIMEOUT_MS: {
    group: "optional",
    summary: "Timeout for one OAuth token attempt, ms, 1000..600000 (default 15000)",
  },
  PORT: { group: "http", summary: "Listen port, 1..65535 (default 3000)" },
  HOST: { group: "http", summary: "Bind address (default 127.0.0.1)" },
  MCP_HTTP_TOKEN: {
    group: "http",
    summary: "Required Bearer token, >= 16 chars (e.g. `openssl rand -hex 32`)",
  },
  MCP_HTTP_ALLOW_NO_AUTH: {
    group: "http",
    summary: "true = run without MCP_HTTP_TOKEN; loopback binds only, local development",
  },
  MCP_HTTP_ALLOWED_HOSTS: {
    group: "http",
    summary: "Extra Host header names to accept, comma-separated (required for 0.0.0.0 / ::)",
  },
  MCP_HTTP_ALLOWED_ORIGINS: {
    group: "http",
    summary: "Browser Origins to accept, comma-separated (default: loopback origins only)",
  },
  TRUST_PROXY: {
    group: "http",
    summary: "Express trust proxy: false | true | loopback | <hops> | CIDR list (default false)",
  },
};

/** Validated configuration, produced only by loadConfig(). */
export interface AppConfig {
  baseUrl: string;
  defaultOrgId: string | undefined;
  clientId: string;
  clientSecret: string;
  defaultTimeoutMinutes: string;
  defaultRetryMinutes: string;
  lastSeenStaleMinutes: number;
  /** Budget for one Action1 API call including retries (ACTION1_REQUEST_TIMEOUT_MS). */
  requestTimeoutMs?: number;
  /** Timeout for one token endpoint attempt (ACTION1_TOKEN_TIMEOUT_MS). */
  tokenTimeoutMs?: number;
  allowDestructive: boolean;
  destructiveAutoConfirm: boolean;
  /** ACTION1_ALLOW_ACCOUNT_OPS: account/identity mutations may execute. */
  allowAccountOps: boolean;
  /**
   * ACTION1_ALLOW_ENTERPRISE_OPS: while ACTION1_ALLOWED_ORG_IDS is set,
   * mutations that are not bound to one allowed organization may run.
   */
  allowEnterpriseOps?: boolean;
  /** ACTION1_ALLOWED_ORG_IDS, lowercased; empty = every org is allowed. */
  allowedOrgIds: string[];
  /** ACTION1_TOOLSETS; empty = all tools. */
  toolsets: Toolset[];
  /** ACTION1_REDACT_PII: mask personal data in tool output. */
  redactPii: boolean;
  http: {
    port: number;
    host: string;
    /** Exact Origin header values accepted; empty = loopback origins only. */
    allowedOrigins: string[];
    /** Extra Host header names accepted on top of loopback and the bind host. */
    allowedHosts: string[];
    token: string | undefined;
    /** Explicit opt-out of the Bearer token (loopback binds only). */
    allowNoAuth: boolean;
    trustProxy: boolean | string | number;
  };
}

let cached: AppConfig | undefined;

const CONFIG_HINT = "See .env.example for the required keys; empty values count as unset.";

/**
 * Invalid or missing settings. `issues` holds one self-contained line
 * per problem ("ACTION1_CLIENT_SECRET is not set."), worded so the
 * secret redactor leaves it alone, for the start-up message in index.ts.
 */
export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[], message?: string) {
    super(
      message ??
        `Invalid or missing environment configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}\n\n${CONFIG_HINT}`,
    );
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/** One issue line: "KEY is not set." or "KEY is invalid: <rule>". */
function issueLine(key: string, message: string, present: boolean): string {
  if (key === "") return message;
  if (!present) return `${key} is not set.`;
  const rule = message.startsWith(`${key} `) ? message.slice(key.length + 1) : message;
  return `${key} is invalid: ${rule}`;
}

/**
 * Read the schema keys from the environment, trimmed, with empty values
 * dropped. `node --env-file` sets a present-but-empty key (as in a
 * copied `.env.example`) to "", and an empty value must mean "use the
 * default", never "use the empty string".
 */
function readEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(EnvSchema.shape)) {
    const raw = source[key];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed !== "") out[key] = trimmed;
  }
  return out;
}

/**
 * Parse and validate the process environment once and cache the result.
 * Every reader of an ACTION1_* or HTTP setting goes through this
 * function, so all of them see the same trimmed, case-folded values.
 * Throws an Error listing every invalid or missing key; callers at
 * startup let it end the process.
 */
export function loadConfig(): AppConfig {
  if (cached) return cached;
  const raw = readEnv(process.env);
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => {
        const key = i.path.join(".");
        return issueLine(key, i.message, key in raw);
      }),
    );
  }
  const env = parsed.data;
  const allowedOrgIds = env.ACTION1_ALLOWED_ORG_IDS;
  if (
    env.ACTION1_ORG_ID !== undefined &&
    allowedOrgIds.length > 0 &&
    !allowedOrgIds.includes(env.ACTION1_ORG_ID.toLowerCase())
  ) {
    throw new ConfigError([
      "ACTION1_ORG_ID is invalid: the default organization is not listed in ACTION1_ALLOWED_ORG_IDS.",
    ]);
  }
  cached = {
    baseUrl: env.ACTION1_BASE_URL,
    defaultOrgId: env.ACTION1_ORG_ID,
    clientId: env.ACTION1_CLIENT_ID,
    clientSecret: env.ACTION1_CLIENT_SECRET,
    defaultTimeoutMinutes: env.ACTION1_DEFAULT_TIMEOUT_MINUTES,
    defaultRetryMinutes: env.ACTION1_DEFAULT_RETRY_MINUTES,
    lastSeenStaleMinutes: env.ACTION1_LAST_SEEN_STALE_MINUTES,
    requestTimeoutMs: env.ACTION1_REQUEST_TIMEOUT_MS,
    tokenTimeoutMs: env.ACTION1_TOKEN_TIMEOUT_MS,
    allowDestructive: parseFlag(env.ACTION1_ALLOW_DESTRUCTIVE),
    destructiveAutoConfirm: parseFlag(env.ACTION1_DESTRUCTIVE_AUTO_CONFIRM),
    allowAccountOps: parseFlag(env.ACTION1_ALLOW_ACCOUNT_OPS),
    allowEnterpriseOps: parseFlag(env.ACTION1_ALLOW_ENTERPRISE_OPS),
    allowedOrgIds,
    toolsets: env.ACTION1_TOOLSETS,
    redactPii: parseFlag(env.ACTION1_REDACT_PII),
    http: {
      port: env.PORT,
      host: env.HOST,
      allowedOrigins: env.MCP_HTTP_ALLOWED_ORIGINS,
      allowedHosts: env.MCP_HTTP_ALLOWED_HOSTS,
      token: env.MCP_HTTP_TOKEN,
      allowNoAuth: parseFlag(env.MCP_HTTP_ALLOW_NO_AUTH),
      trustProxy: env.TRUST_PROXY,
    },
  };
  return cached;
}

function parseFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

/**
 * The organization a tool call addresses: the `org_id` argument when
 * given, else ACTION1_ORG_ID. Throws when neither is set, or when
 * ACTION1_ALLOWED_ORG_IDS is set and the org is not on it. Records the
 * org in the current request context for the audit log.
 */
export function resolveOrgId(override: string | undefined, cfg: AppConfig = loadConfig()): string {
  const orgId = override ?? cfg.defaultOrgId;
  if (!orgId) {
    throw new Error(
      "No organization ID provided. Pass `org_id` to the tool or set ACTION1_ORG_ID in your environment.",
    );
  }
  assertOrgAllowed(orgId, cfg);
  const ctx = currentRequestContext();
  if (ctx) ctx.orgId = orgId;
  return orgId;
}

/**
 * Throw when ACTION1_ALLOWED_ORG_IDS is set and `orgId` is not on it.
 * No-op when the allowlist is empty (every org the API key can reach).
 */
export function assertOrgAllowed(orgId: string, cfg: AppConfig = loadConfig()): void {
  if (cfg.allowedOrgIds.length === 0) return;
  if (cfg.allowedOrgIds.includes(orgId.trim().toLowerCase())) return;
  throw new Error(
    `Refusing organization ${JSON.stringify(orgId)}: it is not listed in ACTION1_ALLOWED_ORG_IDS on this server. Use one of the allowed organizations, or ask the operator to add it.`,
  );
}

/** Drop the cached config so the next loadConfig() re-reads the environment (tests). */
export function resetConfigCache(): void {
  cached = undefined;
}
