import { z } from "zod";

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
  ACTION1_DEFAULT_TIMEOUT_MINUTES: z
    .string()
    .optional()
    .transform((v) => v ?? "10"),
  ACTION1_DEFAULT_RETRY_MINUTES: z
    .string()
    .optional()
    .transform((v) => v ?? "1440"),
  PORT: z
    .string()
    .optional()
    .transform((v) => (v ? Number.parseInt(v, 10) : 3000)),
  HOST: z
    .string()
    .optional()
    .transform((v) => v ?? "127.0.0.1"),
  MCP_HTTP_ALLOWED_ORIGINS: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    ),
  MCP_HTTP_TOKEN: z
    .string()
    .optional()
    .refine(
      // Pass-4 review: also reject whitespace-only tokens. The previous
      // `length >= 16` accepted "                " (16 spaces); now we
      // demand 16 non-whitespace characters. Production hosts that paste
      // a token from a shell prompt occasionally pick up trailing
      // whitespace — the trim catches both common foot-guns.
      (v) => {
        if (v === undefined) return true;
        const trimmed = v.trim();
        return trimmed.length === 0 || trimmed.length >= 16;
      },
      {
        message:
          "MCP_HTTP_TOKEN must be at least 16 non-whitespace characters (use `openssl rand -hex 32` to generate). Short or whitespace-only tokens are brute-forceable in seconds.",
      },
    )
    .transform((v) => {
      const trimmed = v?.trim();
      return trimmed && trimmed.length ? trimmed : undefined;
    }),
  ACTION1_LOG_LEVEL: z
    .enum([
      "debug",
      "info",
      "notice",
      "warn",
      "warning",
      "error",
      "critical",
      "alert",
      "emergency",
    ])
    .optional(),
  ACTION1_ALLOW_DESTRUCTIVE: z
    .string()
    .optional()
    .refine(
      // Pass-N audit: also trim before comparing. Values pasted from a
      // multi-line `.env` file routinely carry trailing whitespace
      // (newline / CR) that defeated the strict lowercase compare.
      (v) =>
        v === undefined ||
        ["true", "1", "yes", "false", "0", "no", ""].includes(
          v.trim().toLowerCase(),
        ),
      "ACTION1_ALLOW_DESTRUCTIVE must be one of: true / 1 / yes (to enable) or false / 0 / no / empty (to disable). Anything else is treated as disabled and probably indicates a typo.",
    ),
  ACTION1_DESTRUCTIVE_AUTO_CONFIRM: z
    .string()
    .optional()
    .refine(
      (v) =>
        v === undefined ||
        ["true", "1", "yes", "false", "0", "no", ""].includes(
          v.trim().toLowerCase(),
        ),
      "ACTION1_DESTRUCTIVE_AUTO_CONFIRM must be true / 1 / yes or false / 0 / no / empty.",
    ),
  // Stale-threshold knob for the connectivity check that script /
  // reboot / execute_and_wait tools run before firing a destructive
  // action. Default 10 min; range 1..1440 (24h). Use a higher value on
  // networks where endpoints check in every 30+ minutes — the default
  // would otherwise mis-classify a perfectly healthy endpoint as
  // unreachable.
  ACTION1_LAST_SEEN_STALE_MINUTES: z
    .string()
    .optional()
    .refine(
      (v) => {
        if (v === undefined || v === "") return true;
        if (!/^\d+$/.test(v)) return false;
        const n = Number.parseInt(v, 10);
        return n >= 1 && n <= 1440;
      },
      "ACTION1_LAST_SEEN_STALE_MINUTES must be an integer in [1, 1440].",
    )
    .transform((v) => (v && v.length > 0 ? Number.parseInt(v, 10) : 10)),
});

export interface AppConfig {
  baseUrl: string;
  defaultOrgId: string | undefined;
  clientId: string;
  clientSecret: string;
  defaultTimeoutMinutes: string;
  defaultRetryMinutes: string;
  lastSeenStaleMinutes: number;
  allowDestructive: boolean;
  destructiveAutoConfirm: boolean;
  http: {
    port: number;
    host: string;
    allowedOrigins: string[];
    token: string | undefined;
  };
}

let cached: AppConfig | undefined;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid or missing environment configuration:\n${issues}\n\n` +
        `See .env.example for required keys. Copy it to .env and fill in your Action1 credentials.`,
    );
  }
  const env = parsed.data;
  // The two destructive-mode env knobs are read here once via the
  // same Zod-parsed pipeline (trimmed, case-folded) instead of being
  // re-parsed via `process.env.X.toLowerCase()` per call. That made
  // values like `"TRUE\n"` (pasted from a multi-line .env file) fail
  // the lowercase comparison silently — pasted whitespace or a
  // mixed-case capitalisation would refuse the call. Centralising
  // here keeps the check consistent with the rest of the config.
  const allowDestructive = parseFlag(env.ACTION1_ALLOW_DESTRUCTIVE);
  const destructiveAutoConfirm = parseFlag(env.ACTION1_DESTRUCTIVE_AUTO_CONFIRM);
  cached = {
    baseUrl: env.ACTION1_BASE_URL,
    defaultOrgId: env.ACTION1_ORG_ID,
    clientId: env.ACTION1_CLIENT_ID,
    clientSecret: env.ACTION1_CLIENT_SECRET,
    defaultTimeoutMinutes: env.ACTION1_DEFAULT_TIMEOUT_MINUTES,
    defaultRetryMinutes: env.ACTION1_DEFAULT_RETRY_MINUTES,
    lastSeenStaleMinutes: env.ACTION1_LAST_SEEN_STALE_MINUTES,
    allowDestructive,
    destructiveAutoConfirm,
    http: {
      port: env.PORT,
      host: env.HOST,
      allowedOrigins: env.MCP_HTTP_ALLOWED_ORIGINS,
      token: env.MCP_HTTP_TOKEN,
    },
  };
  return cached;
}

function parseFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

export function resolveOrgId(override: string | undefined, cfg: AppConfig = loadConfig()): string {
  const orgId = override ?? cfg.defaultOrgId;
  if (!orgId) {
    throw new Error(
      "No organization ID provided. Pass `org_id` to the tool or set ACTION1_ORG_ID in your environment.",
    );
  }
  return orgId;
}

export function resetConfigCache(): void {
  cached = undefined;
}
