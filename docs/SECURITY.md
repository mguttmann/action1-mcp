# Security Guide

`action1-mcp` is a privileged tool — it can run arbitrary PowerShell or Bash
on every Windows / macOS endpoint Action1 manages, deploy software,
uninstall, and reboot machines. Treat it as you would treat console access
to your fleet.

## Threat model

| Adversary | Concern | Mitigation |
|---|---|---|
| Malicious or buggy LLM | Unintended destructive call | **Three-layer destructive guard**: env switch + per-call confirm + dry_run default. |
| Network attacker on the LAN | Read or hijack the HTTP transport | TLS upstream + `MCP_HTTP_TOKEN` bearer auth + bind to loopback when proxied. |
| Supply-chain compromise of a dependency | Token / payload theft | Stderr logger redacts tokens; minimal dependency set; pin the OpenAPI spec SHA. |
| Operator misconfiguration | Public binding without auth | Server refuses to start on a non-loopback bind without `MCP_HTTP_TOKEN`; production checklist in `DEPLOYMENT.md`. |
| Insider with repo access | Read committed credentials | `.env` is git-ignored; pre-commit secret scan in `CONTRIBUTING.md`. |

## Destructive guard

Every tool flagged `destructiveHint: true` (curated and auto-generated alike)
enforces three independent gates:

```
ACTION1_ALLOW_DESTRUCTIVE=true   ← server env, restart-required
        AND
confirm: "YES"                    ← exact, case-sensitive
        AND
dry_run: false                    ← default is true → preview-only
```

The default `dry_run: true` returns a JSON preview of the exact `{method,
path, body}` that *would* be sent. Passing `dry_run: false` without
`confirm: "YES"` is rejected with a clear hint. Passing both without
`ACTION1_ALLOW_DESTRUCTIVE=true` is rejected at the env-switch layer.

The env layer is a deliberate friction point: it requires either an SRE
deciding "this deployment is allowed to mutate state" or an explicit
operator action (`export ACTION1_ALLOW_DESTRUCTIVE=true`) per shell session.
That makes accidental destruction in a query-only deployment impossible.

### Auto-confirm mode (`ACTION1_DESTRUCTIVE_AUTO_CONFIRM=true`)

For isolated **single-operator test setups** — a local Claude Desktop, a
sandbox VM — having to type "with confirm YES and dry_run false"
on every prompt becomes friction without a security benefit (the
operator already controls the environment). Setting
`ACTION1_DESTRUCTIVE_AUTO_CONFIRM=true` collapses the per-call layers:

- `dry_run` defaults to `false` (was `true`).
- `confirm: "YES"` is no longer required; missing confirm is treated as
  "YES".
- `ACTION1_ALLOW_DESTRUCTIVE=true` is **still required** as the master
  switch.
- Callers can still pass `dry_run: true` explicitly to force a preview.

**Do not set this in shared, multi-tenant, or production deployments.**
It removes two of the three guard layers; only the env switch remains.
The startup logger emits an `auto_confirm_enabled` warning when this is
on, so misconfiguration is visible in your log aggregator.

## API credential management

- The Action1 `client_id` + `client_secret` are issued in *Settings → API
  Credentials* and **role-bound** to a specific Action1 role. Pick the
  smallest role that covers what you need; the server cannot escalate beyond
  the role.
- Read-only deployments (e.g. an analyst asking Claude to summarise patch
  status) only need `view_endpoints`, `view_automations`,
  `view_installed_software`, `view_reports`. They do *not* need
  `manage_endpoints`, `run_automations`, or `manage_*`.
- Read-write deployments (e.g. an SRE driving patch deployments through
  Claude) need `run_automations` and `manage_endpoints` *plus* the per-area
  permissions for the templates they actually call.
- **Never** issue a credential with the *Owner* role and pipe it through an
  agent unless you understand exactly which tools that agent can invoke.
- Rotate credentials on a fixed schedule (90 days is a reasonable default).
  Action1 supports zero-downtime rotation — issue a new credential, update
  the server's `.env`, restart, then revoke the old one.

## HTTP transport hardening

- **Always set `MCP_HTTP_TOKEN`** when binding to anything other than
  `127.0.0.1` / `localhost` / `::1`. If you bind to a non-loopback host
  without `MCP_HTTP_TOKEN` set, the server refuses to start with a clear
  error message pointing at the missing env var.
- `src/config.ts` enforces a minimum of 16 non-whitespace characters
  for `MCP_HTTP_TOKEN` (short or whitespace-only tokens are
  brute-forceable in seconds). 32 bytes (256 bit) of entropy remains
  the recommended best practice — generate with `openssl rand -hex 32`.
- Token comparison is constant-time (`node:crypto.timingSafeEqual`) to
  prevent timing-based discovery.
- Terminate TLS at a reverse proxy (Caddy, nginx, traefik, Cloudflare
  Tunnel, AWS ALB). Do not run the Express server on a public port without
  a TLS terminator in front.
- `MCP_HTTP_ALLOWED_ORIGINS` is a CORS-style allowlist for browser
  callers. Empty list (default) means *no Origin check applies* — useful
  when only non-browser clients (Claude Code CLI, MCP Inspector) connect.
  Set it explicitly when browser clients (Claude.ai web, Claude Desktop
  custom connectors) are part of your topology.

## Logging & redaction

Stderr emits one JSON line per event. The redactor scrubs:

- `Bearer …` substrings (case-insensitive).
- `api-key-…@action1.com` substrings.
- `sk-…` (16+ char) secret tokens.
- Bare JWTs (`eyJ…eyJ…<sig>`) — covers refresh-tokens echoed in
  non-standard fields, since OAuth2 servers occasionally echo them in
  error bodies.
- URL-embedded basic-auth credentials (`https://user:password@host`).
- JSON / form-encoded credential key-value pairs that an upstream
  OAuth-server might echo verbatim into a 4xx body —
  `client_secret`, `refresh_token`, `access_token`, `api_key`,
  `password`. The field name is preserved for debug-readability;
  only the value gets `[REDACTED]`.
- Any property whose key matches `authorization`, `api[_-]?key`,
  `access[_-]?token`, `refresh[_-]?token`, `client[_-]?secret`, `secret`,
  `password`, `bearer`.

The same redactor runs on the *tool-output* path: `Action1ApiError.toToolErrorText()`
and `Action1AuthError`'s constructor pipe their body through
`redactString` before composing the user-visible error message. This
means a 4xx body that echoes `client_id` (which the Action1 OAuth
endpoint occasionally does) cannot leak into the LLM's view of the
tool error.

Stdout is reserved for MCP JSON-RPC traffic and never used for logging.
This invariant is required by the MCP protocol — accidentally logging to
stdout corrupts the transport.

If you add custom logging, use the `log` helper from `src/utils/logger.ts`
or write to `process.stderr` directly. Do not use `console.log`.

### What still leaks

- Action1 endpoint hostnames, user names, and machine inventory data
  travel through the logger when at `debug` level. The redactor masks
  credentials, not customer data. If you ship logs off-host, treat them
  like other PII / business data.
- Tool input payloads (e.g. PowerShell scripts in `action1_run_powershell`)
  are not logged by default but appear in destructive-guard previews.
  Don't pass secrets in script bodies — use Action1's *Variables* or
  bake secrets into the target machine's environment instead.

## Repository hygiene

The repo enforces these constraints; review them before contributing:

1. `.env` is in `.gitignore`. Never commit. `git check-ignore .env`
   should print the matching gitignore line.
2. The pre-commit secret-scan in `CONTRIBUTING.md` rejects any commit
   that contains the test fixtures' anonymisation patterns
   (`api-key-*@action1.com`, known org / endpoint / hostname / user
   patterns from previous work).
3. The `tests/unit/specSha.test.ts` test rejects any change to
   `src/codegen/spec/openapi.json` without a paired update to
   `openapi.sha256`. This catches accidental edits and forces a review
   when the upstream Action1 spec changes.
4. Generated tools live in `src/tools/generated/` and are committed.
   This makes diffs review-able when the spec changes.

## Reporting a vulnerability

Open a private security advisory at
<https://github.com/mguttmann/action1-mcp/security/advisories/new> rather
than a public issue. Provide:

- Repro steps (a malformed payload, a missing redaction case, an auth
  bypass).
- Affected version / commit SHA.
- The smallest patch that addresses it, if known.

We aim to acknowledge within 72 hours and ship a fix within 14 days for
high-severity issues.

## Known limits

- Action1's API key role is the only authorisation boundary; the server
  cannot impose finer-grained per-tool permissions beyond what the role
  grants. If you need an analyst to be able to *list* endpoints but not
  *run* PowerShell, issue them an Action1 credential with the
  read-only role rather than relying on `ACTION1_ALLOW_DESTRUCTIVE=false`
  alone.
- The destructive guard cannot prevent an authorised user from running
  `Remove-Item C:\` — it gates *which tools* are reachable, not what those
  tools' inputs do. Do not use the LLM as a security boundary.
- The server does not currently rate-limit outbound calls beyond what
  Action1's API enforces. A misbehaving agent loop can trip Action1's 429
  threshold; the retry layer recovers, but the burst is visible to
  Action1's audit trail.

## Rate limits

Action1 does not publish a hard rate-limit ceiling. In practice we
observe ~10 requests per second sustained on the EU instance without
429s. When the API does return 429:

- The retry wrapper in `src/client/retry.ts` honours `Retry-After`
  automatically and backs off exponentially otherwise (250ms / 500ms /
  1s / 2s / 4s, capped at 5 attempts). Transport errors (DNS hiccups,
  ECONNRESET, ETIMEDOUT) are also retried.
- 4xx responses other than 429 are *not* retried — they're returned
  verbatim with a structured tool error including the actionable hint
  derived from the body / URL.
- Multi-page list walks via `auto_paginate: true` and the curated
  cursor tools naturally serialise calls — there is no concurrent
  fan-out over pages.
- Mass actions (deploy / reboot across an EndpointGroup) are sent as a
  *single* API call with `target_type: "EndpointGroup"`; Action1 fans
  out server-side, so we never make N per-endpoint POSTs.

For HTTP transport specifically, the body is capped at 1 MB
(`express.json({ limit: "1mb" })`); larger payloads are rejected with
413 Payload Too Large before they reach the MCP server.

## DNS rebinding & origin validation

When the HTTP transport binds to a non-loopback host, the server
**hard-fails to start** unless `MCP_HTTP_ALLOWED_ORIGINS` is set. The
allowlist is checked against the `Origin` header on every `/mcp` POST;
mismatches return 403. This implements the skill's DNS-rebinding
guidance literally — a missing allowlist on a public bind would be a
silent bypass otherwise.

In addition to the Origin check, the server validates the `Host`
header against the actual bind target (`expectedHosts`). A DNS-rebinding
attacker may control DNS but cannot forge the `Host` header; this is
the second half of the defence. IPv6 bind hosts are accepted in both
`::1:port` and `[::1]:port` forms (the bracketed form is what
browsers send).

**Order of checks** on every `/mcp` POST:

1. Origin allowlist (if configured)
2. Host header (always when the allowlist is configured)
3. Bearer token (`MCP_HTTP_TOKEN`, constant-time compare)

A failed Origin / Host check returns 403 before the auth layer even
runs, so DNS-rebinding probes can't even reach the Bearer check.

## Base URL validation

`ACTION1_BASE_URL` is validated at server startup with three layered
checks:

1. Must be a syntactically valid URL (Zod `z.string().url()`).
2. Must use the `https://` scheme. Plain HTTP exposes OAuth tokens to
   network observers; `file://`, `javascript:`, `ftp://` are
   rejected.
3. Hostname must NOT match a known cloud-metadata host
   (`169.254.169.254`, `metadata.google.internal`). This blocks
   accidental SSRF if an operator misconfigures the URL on a cloud VM.

These checks live in `src/config.ts`'s Zod schema and run once at
boot.

## Output sanitisation

The MCP server controls two output channels that an attacker-shaped
Action1 string could weaponise:

- **Markdown table renderer** (`src/utils/markdownTable.ts`): cell
  values get `[`, `]`, `<`, `>`, `\\`, `|`, `&`, CR, LF escaped before
  emission. Defuses Markdown-link injection
  (`[click](https://attacker)`), HTML-tag injection, and
  HTML-entity-decoded-bypass attempts (`&#60;script&#62;`).
- **CSV report export** (`action1_report_export`'s
  `sanitizeCsvFormulas`): cells whose first non-whitespace character
  is `=`, `+`, `-`, `@`, TAB, or CR get prefixed with `'` so Excel /
  Google Sheets honour them as literal text rather than formulas. The
  prefix is **not** applied to leading-`+`/`-` numeric or
  phone-number patterns, so `-100` and `+44 1234` pass through
  unchanged.

Neither defence is needed in 2026's typical Claude Desktop client
(which renders Markdown safely), but they're defence-in-depth against
unknown / future MCP hosts.

## Token cache invalidation

When the OAuth refresh-token flow fails (e.g. the refresh-token has
expired), the server-side cache is invalidated immediately, NOT just
the offending token returned. Without this, a dead refresh-token would
be retried on every cold-cache lookup until it eventually rotated. The
fall-through path issues a fresh client-credentials token and stores
its (new) refresh-token.
