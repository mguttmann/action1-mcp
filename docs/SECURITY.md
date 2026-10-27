# Security Guide

`action1-mcp` is a privileged tool. With a suitable Action1 role it can run
arbitrary PowerShell or Bash on every Windows and macOS endpoint Action1
manages, deploy and uninstall software, reboot machines, and change users,
roles and organizations. Treat it like console access to your fleet.

This is an unofficial project, not affiliated with Action1.

## Supported versions

| Version | Security fixes |
|---|---|
| 0.6.x | yes |
| < 0.6 | no, please upgrade |

Only the latest minor release receives fixes.

## Reporting a vulnerability

Report vulnerabilities privately through a GitHub security advisory:
<https://github.com/mguttmann/action1-mcp/security/advisories/new>. Do not
open a public issue. If that page is not available to you, open an issue
that only asks for a private contact, without details.

Please include:

- Steps to reproduce (a malformed payload, a missing redaction case, an
  auth bypass).
- The affected version (`node dist/index.js --version` prints it) or commit.
- The smallest patch that addresses it, if you have one.

This is a one-maintainer project. Reports are handled on a best-effort
basis and take priority over all other work, but there is no guaranteed
response or fix time. You will be credited in the release notes unless
you prefer not to be.

## Threat model

| Adversary or risk | Concern | Mitigation |
|---|---|---|
| Instructions hidden in Action1 data (indirect prompt injection) | Hostnames, software names, script output or audit texts contain text that makes the model call a destructive tool | The model sets `confirm` and `dry_run` itself, so they do not help here. What holds: `ACTION1_ALLOW_DESTRUCTIVE` and `ACTION1_ALLOW_ACCOUNT_OPS` (server env), `ACTION1_ALLOWED_ORG_IDS`, `ACTION1_TOOLSETS=read`, the Action1 role of the credential, and the MCP host's per-tool approval. The server instructions tell the model to treat Action1 data as data. |
| Model mistake | Unintended destructive call | `dry_run` defaults to `true` (preview only), `confirm: "YES"` is required, the env switch is off by default. |
| Network attacker, malicious web page (DNS rebinding) | Reach or hijack the HTTP transport | Bearer token required for `--http`; `Host` and `Origin` are checked on every request; TLS at a reverse proxy; bind to loopback behind the proxy. |
| Credential exposure | Client secret ends up in chat transcripts, logs or the repo | The agent setup guide (`CLAUDE.md`) never asks for credentials in chat; the MCPB wizard stores them; logs and error texts are redacted; `.env` is git-ignored. |
| Operator misconfiguration | Public bind without auth, typos in switches | The HTTP transport refuses to start without a token (or on a wildcard bind without `MCP_HTTP_ALLOWED_HOSTS`); invalid switch values abort startup; production checklist in [`DEPLOYMENT.md`](DEPLOYMENT.md). |
| Supply-chain compromise | Token or payload theft through a dependency | Few runtime dependencies, lockfile, CI fails on high or critical advisories in runtime dependencies, Dependabot updates, secret scanning config for the repo. |
| Look-alike packages | Someone publishes a package with a similar name | The npm package is `action1-mcp-server` (registry name `io.github.mguttmann/action1-mcp`); install only that exact name, this repository or its GitHub Releases. |

## Destructive guard

Every tool flagged `destructiveHint: true` (curated and generated alike)
executes only when all of these hold:

```
ACTION1_ALLOW_DESTRUCTIVE=true    server env, restart required
ACTION1_ALLOW_ACCOUNT_OPS=true    server env, only for account operations
confirm: "YES"                    per call, exact and case-sensitive
dry_run: false                    per call, the default is true (preview)
```

The default `dry_run: true` returns a preview of the exact `{method, path,
body}` that would be sent, at any nesting depth; only credential-shaped
keys and secret-shaped text are masked. The checks for an execution run in this order:
master switch, account-operation switch, then `confirm`. A refused call
names the missing switch or argument.

**Account operations** need the second switch `ACTION1_ALLOW_ACCOUNT_OPS`:
every non-GET call on paths under `/users`, `/roles`, `/enterprise`,
`/organizations` or `/subscription`, `PATCH /me`, and every non-GET
`action1_raw_request`. Turning on destructive tools for patching therefore
does not also allow creating users or changing roles.

The env switches are deliberate friction: someone who controls the server
environment decides that this deployment may change state. The per-call
arguments are friction for the model, not a security boundary.

A preview never sends a mutating request, but a few tools need a read-only
lookup to build it. `action1_run_script` against a single endpoint and
`action1_execute_and_wait` read the endpoint
(`GET /endpoints/managed/{org}/{endpoint}`, with a list fallback) before
the guard, because the preview body depends on the endpoint's OS; the same
read feeds the offline-abort check. `action1_run_script` with
`target_type: "EndpointGroup"` takes the OS from its `os` argument and
makes no upstream call for a preview. `action1_reboot_endpoint` runs its
connectivity probe only after the guard, so its preview makes no upstream
call either.

### Limiting what the model can reach

- `ACTION1_ALLOWED_ORG_IDS`: a comma-separated list of organization UUIDs.
  Any other organization is refused, whether it comes from an `org_id`
  argument, a resource URI, an `action1_raw_request` path or an org ID
  inside a request body or query (also a query string written into the
  raw request path). `ACTION1_ORG_ID` must be on the list.
  `GET /organizations` still lists every organization the credential can
  see, and reads of enterprise-wide resources (script library, settings,
  data sources, custom reports, audit events) are not filtered.
- For every guarded call (curated, generated and raw) the allowlist also
  covers the request body at any depth: org id keys
  (`organization_id`, `target_organization_id`, ..., compared without
  case and separators, so `orgId`, `Org-ID` and `organizationId` match
  too) and scope entries
  (settings `scope`, role `include_scope` / `exclude_scope`, update
  `scoped_approvals`; type `Organization` names its org in `object` or
  `organization_id`). A body nested too deeply to check is refused.
- While the allowlist is set, a mutation must be bound to an allowed
  organization: its path contains an allowed org id and every scope
  entry names one. An `organization_id` binds only `Organization`,
  `Report` and `AdvancedSettingTemplate` entries; an Enterprise, Group or
  other entry stays unbound even when it carries one. Enterprise-wide mutations (`/settings/all`,
  `/scripts/all`, `/data-sources/all`, `/reports/all/custom`, `/roles`,
  `/users`, `/enterprise`, `/organizations`, `/me`, Enterprise or Group
  scope entries) are refused, previews included, unless
  `ACTION1_ALLOW_ENTERPRISE_OPS=true`. Org ids in the body are still
  checked with that switch on.
- `ACTION1_TOOLSETS=read` registers only read-only tools; `curated`
  registers only the hand-written tools. Values combine as an
  intersection (`curated,read`).
- Your MCP host's tool approval. Keep approval on for destructive tools;
  do not mark them "always allow".
- The Action1 role of the API credential. It is the only boundary inside
  Action1 itself.

### Auto-confirm mode (`ACTION1_DESTRUCTIVE_AUTO_CONFIRM=true`)

For isolated single-operator test setups (a local Claude Desktop, a
sandbox VM), typing `confirm: "YES"` on every call is friction without a
security benefit. With `ACTION1_DESTRUCTIVE_AUTO_CONFIRM=true`:

- `confirm: "YES"` is no longer required.
- `dry_run` still defaults to `true`. A call executes only with
  `dry_run: false`.
- `ACTION1_ALLOW_DESTRUCTIVE=true` is still required, and
  `ACTION1_ALLOW_ACCOUNT_OPS=true` for account operations.

Do not set it in shared or production deployments. The server logs an
`auto_confirm_enabled` warning at startup when it is on.

## API credential management

- The Action1 `client_id` and `client_secret` are issued in *Settings > API
  Credentials* and bound to an Action1 role. Pick the smallest role that
  covers what you need; the server cannot go beyond the role.
  [`permissions.md`](permissions.md) lists the permission each operation
  needs, generated from the spec.
- Never pipe a credential with the *Owner* role through an agent unless
  you know exactly which tools that agent can call.
- Never paste the client secret into a chat with an AI assistant. If it
  happened, treat the secret as exposed and rotate it.
- Rotate credentials on a schedule (90 days is a reasonable default). Issue
  a new credential, update the server configuration, restart, then revoke
  the old one.

## Data sent to the LLM provider

Tool results and resource reads go to the MCP host and, from there, to the
host's LLM provider as part of the conversation. They can contain personal
data:

- Endpoint records: the logged-in user, IP and MAC addresses, serial
  numbers, Active Directory OU and group names.
- `/me` and user tools: e-mail addresses and names of Action1 users.
- Script output, audit events and inventory data: whatever the endpoint
  or Action1 returns.

If these are personal data of your employees or customers, sending them to
an LLM provider is a processing of personal data (for example under the
GDPR). Check that your agreement with the provider and your internal rules
cover it. `ACTION1_REDACT_PII=true` replaces the values of personal-data
keys with `[REDACTED:pii]` in every tool result (text and structured
content), every resource read and every JSON upstream body an error text
echoes (HTTP error bodies, a start response without an instance id, the
last status of a timed-out poll).
Keys are compared after spaces and hyphens become `_`, so the column
display names of report rows (`fields["User Name"]`,
`fields["IP Address"]`, `fields["Logged On User"]`) are masked like the
spec keys. In CSV exports (`action1_report_export` with `format: "csv"`,
the generated export tools, `action1_raw_request`) the cells of every
column whose header matches are masked. Masked keys (case-insensitive
unless noted):

- IP addresses: `ip`, `*_ip` (such as `current_ip`), `ip_address`,
  `ipv4`, `ipv6`.
- E-mail: `email`, `e_mail`, `*_email` (such as `customer_email`),
  `email_address`, and `closure_requested_by`.
- Addresses: `address`, `*_address` (such as `external_address`,
  `mac_address`).
- Active Directory: every key starting with `AD_` (case-sensitive, such
  as `AD_organization_unit`, `AD_security_groups`).
- People and devices: `user`, `users`, `username`, `user_name`, `login`,
  `logged_in_user`, `logged_on_user` (also with a prefix, such as
  `Last Logged On User`), `first_name`, `last_name`, `full_name`,
  `phone`, `mac`, `serial`, `serial_number`.

`tests/security/pii.test.ts` derives the personal-data properties from
the vendored Action1 OpenAPI spec (every `format: email`, `ipv4` or
`ipv6` property plus the names above) and fails when one is not masked,
so a spec refresh that adds such a field is caught. Masking does not
inspect free text such as hostnames, script output or non-JSON error
bodies, and report columns whose display name none of the rules above
matches stay visible (the live report column names are not verified).

Secret-shaped values (tokens, passwords) are redacted in logs, error texts
and dry-run previews. In successful tool results and resource reads, the
values of credential-shaped keys (the key patterns listed under
[Redaction](#redaction), such as `client_secret`, `password`,
`access_token`, `api_key`) are replaced with `[REDACTED]` at any depth.
Free text is not inspected: a script that prints a secret puts that
secret into the conversation.
Do not pass secrets in script bodies; use Action1's variables or the
target machine's environment instead.

## HTTP transport hardening

- **`MCP_HTTP_TOKEN` is required** for `--http`, also on `127.0.0.1`.
  Without it the server refuses to start. For local development only,
  `MCP_HTTP_ALLOW_NO_AUTH=true` runs without a token on a loopback bind and
  logs a warning.
- The token needs at least 16 characters; use 32 random bytes
  (`openssl rand -hex 32`). The comparison is constant-time.
- HTTP mode serves every client with the same Action1 credential. It is
  not multi-tenant: whoever has the token can do what the credential and
  the guard allow. Use `ACTION1_ALLOWED_ORG_IDS` to limit the
  organizations.
- Terminate TLS at a reverse proxy (Caddy, nginx, traefik, Cloudflare
  Tunnel, a load balancer) and bind the server to `127.0.0.1` behind it.
  Set `TRUST_PROXY=loopback` there so the per-IP rate limit sees client
  addresses.
- Request bodies are limited to 1 MB (413 above that); each client IP gets
  60 requests per minute.
- Error responses are generic; details go to the server log with a
  `correlation_id`.

## DNS rebinding and origin validation

Every request to `/mcp` passes these checks, in this order:

1. Rate limit per client IP.
2. `Host` header. Accepted names: `localhost`, `127.0.0.1`, `::1`, the
   bind address (unless it is a wildcard) and the names in
   `MCP_HTTP_ALLOWED_HOSTS`. The port is ignored. A wildcard bind
   (`0.0.0.0`, `::`) requires `MCP_HTTP_ALLOWED_HOSTS`.
3. `Origin` header, when present. Accepted: the values in
   `MCP_HTTP_ALLOWED_ORIGINS`, or loopback origins when that list is
   empty. Requests without `Origin` (CLI clients, server-side clients) are
   not affected.
4. Bearer token.

A foreign `Host` or `Origin` gets 403 before the token is checked, with or
without a token. A DNS-rebinding page reaches the server under the
attacker's own hostname, which is never accepted.

## Logging and audit events

Stderr carries one JSON line per event; stdout is reserved for MCP
JSON-RPC. Lines written during a tool call share a `request_id`.

| Event | Level | Meaning |
|---|---|---|
| `tool_call` | info (warn on error) | One per call: `tool`, `duration_ms`, `outcome` (`ok`, `error`, `dry_run`, `refused`), `upstream_status`, `attempts`, `org`, `caller`, `error` (first 300 characters). |
| `destructive_dry_run` | info | A guarded tool returned a preview. |
| `destructive_refused` | audit (notice) | A guarded call was refused; `reason` is `destructive_disabled`, `account_ops_disabled`, `confirm_missing`, `config_invalid` or `org_not_allowed` (`ACTION1_ALLOWED_ORG_IDS`). Carries `tool`, `method`, `path`, `org`, `caller`. |
| `destructive_executed` | audit (notice) | A state-changing request of a guarded call is about to be sent to Action1: written right before the request leaves the server, once per request, never when a pre-flight check (for example the reboot connectivity check) aborts the call. Carries `tool`, `method`, `path`, `org`, `account_op`, `caller` and `body_sha256` (SHA-256 of the JSON body as sent, `null` without a body). Its result is in the `tool_call` line with the same `request_id`. |
| `action_started` | audit (notice) | `action1_execute_and_wait` started an action: `tool`, `instance_id`, `org`, `endpoint_id`, written before polling begins. |
| `http_auth_failed` | audit (notice) | HTTP 401: `reason` is `missing` or `invalid`. Never contains the presented token. |
| `http_host_rejected`, `http_origin_rejected` | audit (notice) | HTTP 403 for a foreign `Host` or `Origin`, with the rejected value. |
| `http_rate_limited` | audit (notice) | HTTP 429 from the per-IP rate limit. |
| `upstream_retry` | warn | A request to Action1 is retried. |
| `guard_config` | info | Guard settings at startup. |
| `auto_confirm_enabled` | warn | Auto-confirm is on. |
| `fatal`, `uncaught_exception`, `unhandled_rejection` | critical | The process is failing. |

`caller` identifies who sent the MCP request: `{"transport":"stdio"}`
for stdio; over HTTP `transport: "http"`, `remote_ip` (the peer address
after `TRUST_PROXY`), `user_agent` (first 200 characters) and `token_id`,
the first 12 hex characters of the SHA-256 of the accepted bearer token
(never the token). All HTTP clients share one token, so `token_id`
distinguishes tokens across a rotation, not people; `remote_ip` and
`user_agent` are what tells clients apart. The `http_*` lines carry
`status`, `remote_ip` and `user_agent`; they are written at most once per
event, reason and client address per minute, and the next line reports
the suppressed repeats in `suppressed_since_last`.

Audit events are written regardless of `ACTION1_LOG_LEVEL` and are never
throttled by the logger, so lowering the log level does not remove them.
Other notice and higher lines are never throttled either.

Tool arguments and tool results are not logged. Logs do contain tool
names, organization IDs, API paths (including endpoint IDs) and the start
of error messages. Treat shipped logs as business data.

### Redaction

The redactor scrubs log lines and error texts:

- `Bearer ...` substrings (case-insensitive).
- `api-key-...@action1.com` substrings.
- `sk-...` secret tokens (16 or more characters).
- Bare JWTs (`eyJ...eyJ...<sig>`), for refresh tokens echoed in unusual
  fields.
- Credentials embedded in URLs (`https://user:password@host`).
- JSON or form-encoded `client_secret`, `refresh_token`, `access_token`,
  `api_key` and `password` values that an OAuth server might echo into an
  error body. The field name stays; the value becomes `[REDACTED]`.
- Any property whose key contains `authorization`, `api[_-]?key`,
  `access[_-]?token`, `refresh[_-]?token`, `id[_-]?token`,
  `client[_-]?secret`, `password` or the word `bearer`, or that is
  exactly `secret`, `token`, `cookie`, `set-cookie` or `x-action1-token`
  (case-insensitive; `REDACT_KEY_PATTERNS` in `src/utils/logger.ts`).

`Action1ApiError` and `Action1AuthError` run their body through the same
redactor before it becomes a tool error, so an Action1 error body that
echoes `client_id` does not reach the model.

If you add logging, use the `log` helper from `src/utils/logger.ts` or
write to `process.stderr`. Never use `console.log`: stdout carries the MCP
protocol.

## Repository hygiene

1. `.env` is in `.gitignore`. Never commit it; `git check-ignore .env`
   should print the matching rule.
2. `.gitleaks.toml` and `.github/secret_scanning.yml` configure secret
   scanning. They exclude the vendored spec (it contains Action1's own
   example credentials) and the fake secrets in tests. `CONTRIBUTING.md`
   describes a local scan for your own identifiers before committing.
3. `tests/unit/specSha.test.ts` fails when `src/codegen/spec/openapi.json`
   changes without a matching `openapi.sha256` and regenerated tools. It
   cannot see changes at Action1; `npm run spec:check` and the weekly
   spec-drift workflow do that.
4. Generated tools live in `src/tools/generated/` and are committed, so a
   spec update shows up as a reviewable diff.

## Known limits

- The Action1 role is the only authorisation boundary inside Action1. If
  an analyst may list endpoints but not run PowerShell, give them a
  credential with a read-only role instead of relying on
  `ACTION1_ALLOW_DESTRUCTIVE=false` alone.
- The guard decides which tools may execute, not what their inputs do. It
  cannot stop an allowed `Remove-Item C:\`. Do not use the model as a
  security boundary.
- The server does not throttle outbound calls beyond Action1's own limits.
  A looping agent can hit Action1's 429 threshold; the retry layer
  recovers, and the burst shows up in Action1's audit trail.

## Rate limits and retries

Action1 does not publish a rate limit. The retry policy in
`src/client/action1Client.ts` depends on the HTTP method:

- Reads (GET/HEAD) are retried on 429, 5xx and transient transport errors
  (DNS hiccups, ECONNRESET, ETIMEDOUT), with exponential backoff or the
  server's `Retry-After` (capped at 60 s).
- Mutations (POST/PUT/PATCH/DELETE) are retried only on 429 and on errors
  before the request was sent (DNS failure, connection refused, connect
  timeout). A 5xx or a reset after sending may mean Action1 already
  executed the mutation, so re-sending it could run a script, deployment
  or reboot twice.
- Other 4xx responses are not retried; they become a tool error with a
  hint derived from the response.
- Every call is bounded by `ACTION1_REQUEST_TIMEOUT_MS`, retries included.
- Multi-page walks are sequential. Mass actions sent with
  `target_type: "EndpointGroup"` are one API call; Action1 fans out
  server-side.

## Base URL validation

`ACTION1_BASE_URL` is validated at startup:

1. It must be a valid URL.
2. It must use `https://`. Plain HTTP would expose OAuth tokens;
   `file://`, `javascript:` and `ftp://` are rejected.
3. Its hostname must not be a known cloud metadata host
   (`169.254.169.254`, `metadata.google.internal`).

Resolved request URLs must stay under the base URL path; paths with empty
or dot segments are refused before any request.

## Redirects

The OAuth token request and every API request are sent with
`redirect: "error"`: a 3xx answer is never followed and the call fails
with an error. The client secret, the bearer token and mutation bodies
therefore only ever reach the origin of `ACTION1_BASE_URL`, and a
response from another host never reaches the model. The owner script
`scripts/live-shape-check.mjs` sends its token and GET requests the same
way, and a test fails when any `fetch` call in `src/` or `scripts/`
lacks this option (the credential-free spec download excepted).

## Protocol versions

The server negotiates the MCP revisions 2025-06-18 and 2025-11-25 (and
the older 2025-era revisions the SDK accepts) through `initialize`, and
serves the 2026-07-28 revision (`server/discover`, per-request envelope)
next to them, over stdio and HTTP. Both eras use the same server
factory, so the guard, the org allowlist, redaction and the audit events
are identical. Over HTTP every request passes the same rate limit,
`Host` / `Origin` check and bearer token first. Details and the tests
that hold this: [ADR 0001](adr/0001-mcp-sdk-version.md#serving-2026-07-28-2026-10-26).

## Live shape check

`npm run live:shapes` (`scripts/live-shape-check.mjs`) lets the owner of
a tenant check which record shapes the live API returns. It is
read-only: one OAuth token request and GET requests with a small
`limit` on the endpoints the curated tools read, nothing else. The
report (`live-shape-report.json`, git-ignored) holds key paths, enum-like
words and timestamp formats with digits replaced, never record values;
ids picked at runtime stay in memory. No CI job or release step runs it
against a tenant; its unit test uses a stubbed API. Review the report before sharing it: enum words such as status
names are tenant data too. See
[`TESTING.md`](../TESTING.md#live-shape-check-owner-only).

## Output sanitisation

Two output channels could carry attacker-shaped Action1 strings:

- **Markdown table renderer** (`src/utils/markdownTable.ts`): cell values
  get `[`, `]`, `<`, `>`, `\`, `|`, `&`, CR and LF escaped. This defuses
  Markdown links (`[click](https://attacker)`), HTML tags and
  entity-encoded variants (`&#60;script&#62;`). Metadata below the table
  (`note`, `next_cursor`, envelope fields) is not escaped, but line breaks
  are collapsed so a value cannot open a heading or a new block.
- **CSV report export** (`sanitizeCsvFormulas` in `src/utils/csv.ts`):
  cells whose first non-whitespace character is `=`, `+`, `-`, `@`, TAB or
  CR get a leading `'`, so spreadsheets treat them as text. Numbers and
  phone numbers such as `-100` and `+44 1234` stay unchanged.

Most hosts render Markdown safely; both defences protect against hosts
that do not.

## Token cache invalidation

When the OAuth refresh-token flow fails (for example because the refresh
token expired), the cached tokens are dropped immediately and the server
falls back to a fresh client-credentials token. A dead refresh token is
not retried on every later call.
