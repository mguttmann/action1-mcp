# action1-mcp-server

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522.12-brightgreen)

An unofficial [Model Context Protocol (MCP)](https://modelcontextprotocol.io)
server for the [Action1 RMM](https://www.action1.com/) REST API. It lets
Claude (or any other MCP host) query your Action1 fleet, run PowerShell on
Windows and Bash on macOS, deploy updates, reboot endpoints, search audit
trails and build CVE remediation plans, with a guard that keeps state
changes off unless you switch them on.

> **Unofficial project.** This server is not affiliated with, endorsed by,
> sponsored by or supported by Action1 Corporation. "Action1" is a
> trademark of Action1 Corporation. See [`NOTICE`](NOTICE).

## Status

Every operation of the pinned Action1 OpenAPI snapshot is reachable
through a tool (see [What is covered](#what-is-covered)). The server
speaks stdio and Streamable HTTP and ships as an MCPB bundle for Claude
Desktop and as the npm package `action1-mcp-server`. Releases and their changes: [`CHANGELOG.md`](CHANGELOG.md).

### Validation status

Read this before you let an agent change anything in your fleet.

- **Automated tests** (`npm test`) run against mocked Action1 responses:
  unit tests, MCP protocol round trips through the SDK client, the
  destructive-guard truth table, redaction and size limits. Every
  generated tool that changes state is driven through MCP to prove it is
  guarded. These tests run in CI on Node 22, 24 and 26.
- **Live runs against a real Action1 tenant** are recorded in
  [`TESTING.md`](TESTING.md). They were made while versions 0.1 to 0.3 were
  developed and were not dated. They cover the read tools (organizations,
  endpoints, pagination, templates, missing updates), read-only script
  execution on Windows and macOS (`action1_execute_and_wait`,
  `action1_run_script`) and the guard's refusal paths.
- **Read-only live shape check (2026-10-26)** for 0.6.0: GET requests
  against a real tenant compared the returned record shapes with the
  vendored spec. Endpoints, vulnerabilities, installed software,
  automation instances and schedules, missing updates, endpoint groups
  and both list envelopes match the spec; audit events are still
  unverified (the key lacked `view_audit`). Details in
  [`TESTING.md`](TESTING.md#live-shape-check-2026-10-26). Apart from this
  check, the changes in 0.6.0 are covered by the automated tests only; a
  live smoke run of the 0.6.0 tools is pending.
- **Never run against a live tenant:** `action1_reboot_endpoint`,
  `action1_deploy_update`, `action1_deploy_package`,
  `action1_uninstall_program`, `action1_run_data_collection`, removing an
  endpoint from a group, `action1_run_script` with
  `target_type: "EndpointGroup"`, every generated tool that changes state,
  and every account operation (users, roles, organizations, enterprise).
  Their request bodies follow the Action1 OpenAPI spec and are checked by
  tests, but nobody has confirmed that Action1 accepts them. Try them on
  a test endpoint first and look at the dry-run preview before you
  execute.

### Maintenance status

- Maintained on a best-effort basis by one maintainer
  ([@mguttmann](https://github.com/mguttmann)) in spare time. The author
  uses it in production. There is no support contract and no guaranteed
  response time.
- Security fixes take priority over features. Report vulnerabilities
  privately (see [Security](#security)).
- Dependency updates come from Dependabot; CI fails when a runtime
  dependency has a known high or critical advisory. A weekly job reports
  when Action1 serves a different API spec than the pinned snapshot.
- Only the latest minor release gets fixes.
- Issues and pull requests are welcome; see
  [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) and the
  [Code of Conduct](CODE_OF_CONDUCT.md).

## Why this project

Action1 has a clean REST API, but a few quirks silently produce wrong
results when an LLM calls it naively:

- macOS Bash actions need a ten-field `run_script` payload; the API
  answers `not applicable to Mac platform` for any missing field.
- Windows PowerShell actions need a non-empty `success_exit_codes`.
- `last_seen` is `YYYY-MM-DD_HH-MM-SS` (UTC), not ISO-8601, so `Date.parse`
  returns `NaN`. The server parses it and renders it readable.
- The `self` URL of a list item contains a `/general` segment that is not
  a real REST resource.
- Script output is interleaved with `Starting` / `Waiting` / `Completed`
  lifecycle markers that need to be filtered.
- `OS` is upper-case and `platform` lower-case, and both can carry the
  platform string; one detector normalises them.

The curated tools encode all of these. What the server does not cover is
listed in [`docs/api-coverage-gaps.md`](docs/api-coverage-gaps.md).

## Install

### Claude Desktop: MCPB bundle (recommended)

1. Download `action1-mcp-<version>.mcpb` from the project's
   [GitHub Releases](https://github.com/mguttmann/action1-mcp/releases).
   The release workflow attaches it to every version tag.
2. Double-click it (or drag it onto Claude Desktop, or use Settings >
   Extensions > Install from file).
3. Fill in the wizard: API base URL of your region, organization ID,
   client ID and client secret, and whether destructive operations are
   allowed (leave this off at first).

Claude Desktop runs the bundle with its built-in Node.js. Details and
troubleshooting: [`docs/INSTALLATION.md`](docs/INSTALLATION.md#claude-desktop-macos--windows).

### MCP Registry

The release workflow lists each stable release in the official
[MCP Registry](https://registry.modelcontextprotocol.io) as
`io.github.mguttmann/action1-mcp`: the bundle (download URL and SHA-256
of the release asset) and, from 0.6.1 on, the npm package
`action1-mcp-server`, both with the same environment variables. MCP hosts and
directories that read the registry can install it from there. Only that
name is this project; Action1 servers under other namespaces are
different code.

`glama.json` names the maintainer of the
[Glama listing](https://glama.ai/mcp/servers/mguttmann/action1-mcp).

### From source (any MCP host)

Requires Node.js 22.12 or newer (`engines` in `package.json`); CI tests
Node 22, 24 and 26.

```bash
git clone https://github.com/mguttmann/action1-mcp.git
cd action1-mcp
npm ci
cp .env.example .env             # fill in your Action1 credentials
npm run build                    # compiles to dist/ (tsc only)
```

Attach it to Claude Code:

```bash
claude mcp add action1 -- node --env-file=$(pwd)/.env $(pwd)/dist/index.js
```

`npm run inspector` opens the MCP Inspector against the built server
(needs Node 22.19 or newer). Other hosts (Claude Desktop with a JSON
config, Claude.ai, Cursor, Continue.dev, Cody) are covered in
[`docs/INSTALLATION.md`](docs/INSTALLATION.md).

### npm (npx, any stdio MCP host)

The server is published on npm as
[`action1-mcp-server`](https://www.npmjs.com/package/action1-mcp-server)
(command `action1-mcp`). Only that exact name is this project. `npx`
fetches and runs it, so no clone or build is needed; Node.js 22.12 or
newer must be installed.

Attach it to Claude Code (the values land in Claude Code's own
configuration; type them in your shell, never into a chat):

```bash
claude mcp add action1 \
  -e ACTION1_BASE_URL=https://app.eu.action1.com/api/3.0 \
  -e ACTION1_ORG_ID=<your-org-uuid> \
  -e ACTION1_CLIENT_ID=<client-id> \
  -e ACTION1_CLIENT_SECRET=<client-secret> \
  -- npx -y action1-mcp-server
```

Any other stdio host takes the same command in its JSON configuration:

```json
{
  "mcpServers": {
    "action1": {
      "command": "npx",
      "args": ["-y", "action1-mcp-server"],
      "env": {
        "ACTION1_BASE_URL": "https://app.eu.action1.com/api/3.0",
        "ACTION1_ORG_ID": "<your-org-uuid>",
        "ACTION1_CLIENT_ID": "<client-id>",
        "ACTION1_CLIENT_SECRET": "<client-secret>"
      }
    }
  }
}
```

A configuration file with these values holds the credential: keep it
readable for your user only and out of version control.
`action1-mcp-server@<version>` pins a version. For Claude Desktop the
MCPB bundle stays the recommended path: its wizard keeps the client ID
and secret in Claude Desktop's secure storage. More hosts and options:
[`docs/INSTALLATION.md`](docs/INSTALLATION.md#option-c-npm-npx).

## What is covered

- **Generated tools:** every operation of the pinned Action1 OpenAPI
  snapshot (date in [`src/codegen/spec/SOURCE.md`](src/codegen/spec/SOURCE.md))
  becomes a verb-first tool such as `action1_list_endpoint_groups`,
  unless a curated tool covers it. Exceptions: `POST /oauth2/token` is
  used internally and not exposed, and the two package-upload operations
  return an explanatory error because they need a binary body. The full
  mapping is generated into [`docs/_coverage_table.md`](docs/_coverage_table.md);
  [`docs/api-coverage.md`](docs/api-coverage.md) explains it.
- **Curated tools** for the common workflows, including high-level
  wrappers (CVE remediation plan, audit log search, software inventory,
  recurring schedules, report export, group resolver).
- **Resources** (`action1://me`, `action1://orgs`, `action1://templates`,
  `action1://reports`, `action1://endpoints/{orgId}`,
  `action1://groups/{orgId}`, `action1://vulnerabilities/{orgId}`) for
  hosts that pre-fetch context.
- **Slash prompts** for multi-step jobs (`/patch-windows-fleet`,
  `/audit-vulnerabilities`, `/triage-offline-endpoints`,
  `/run-script-fleetwide`, `/software-inventory-sweep`,
  `/check-my-permissions`).

`tests/unit/specSha.test.ts` ties the generated tools to the pinned
snapshot. It does not see changes at Action1; `npm run spec:check` and a
weekly CI job compare the snapshot with the spec Action1 serves.

## Highlights

- **Guarded state changes.** Tools that change state need
  `ACTION1_ALLOW_DESTRUCTIVE=true`, default to a dry-run preview and need
  `confirm: "YES"` to execute. Account operations need a second switch.
  See [Destructive guard](#destructive-guard).
- **Scoping.** `ACTION1_ALLOWED_ORG_IDS` limits which organizations the
  tools may address; `ACTION1_TOOLSETS=read` registers only read-only
  tools.
- **Output for agents.** Every read-only tool accepts `response_format`
  (`markdown` default, `json`); every tool sets all four MCP annotations
  and declares an `outputSchema`. Paginated results carry `count`,
  `has_more`, `next_cursor`, and `total` on the final page. Results stay
  under the 1 MB host limit with visible truncation notes.
- **Strict inputs.** Unknown or misspelled arguments are rejected with a
  validation error instead of being ignored.
- **Auth.** OAuth2 client credentials with proactive refresh, deduplicated
  concurrent token requests and a refresh-token fallback.
- **Transport safety.** Reads (GET/HEAD) are retried on network errors,
  HTTP 5xx and 429 (honouring `Retry-After`). Mutations are sent once and
  retried only on 429 or when the connection failed before the request
  was sent, so a retry never runs an action twice. Every Action1 call is
  bounded by `ACTION1_REQUEST_TIMEOUT_MS`.
- **Two transports.** stdio (default) and stateless Streamable HTTP, both
  serving MCP 2026-07-28 next to the 2025 revisions
  ([ADR 0001](docs/adr/0001-mcp-sdk-version.md)). HTTP
  requires a bearer token, checks `Host` and `Origin` against DNS
  rebinding, limits bodies to 1 MB and rate-limits per client IP.
- **Logs.** Structured JSON lines on stderr with credential redaction, one
  `tool_call` line per call and audit lines for guarded operations.
  Stdout is reserved for MCP.

## Architecture

```
+----------------------------------------------------------------------+
| Curated tools and workflow wrappers                                  |
|  - script execution (Windows, macOS, OS-aware routing)               |
|  - execute_and_wait (start + poll + filtered output)                 |
|  - get_endpoint (canonical path + list fallback)                     |
|  - CVE remediation plan, audit log search, software inventory, ...   |
+----------------------------------------------------------------------+
| Generated tools                                                      |
|  - one tool per remaining spec operation, verb-first snake_case      |
|  - shared runtime: pagination, destructive guard, error mapping      |
|  - Action1 OpenAPI 3.1 snapshot, SHA-pinned (spec/openapi.sha256)    |
+----------------------------------------------------------------------+
| Shared infrastructure                                                |
|  - Action1Client (auth, retry, timeouts, path safety, error mapping) |
|  - TokenProvider (refresh_token fallback, proactive refresh)         |
|  - destructive guard, org allowlist, toolset filter                  |
|  - structured stderr logger with redaction                           |
|  - Markdown table renderer, response size budgets                    |
+----------------------------------------------------------------------+
```

When a generated tool would get the same name as a curated tool, the code
generator (`src/codegen/generate.ts`) drops the generated one; operations
listed in `SKIP_OPERATION_IDS` (`src/codegen/curated-overrides.ts`) are
skipped as well. Design decisions are recorded in
[`docs/adr/`](docs/adr/README.md).

## Configuration

All configuration is via environment variables. Copy
[`.env.example`](.env.example) to `.env` and fill it in; empty values mean
"use the default". `node dist/index.js --help` lists the same variables.

| Variable | Default | Description |
|---|---|---|
| `ACTION1_BASE_URL` | required | API base URL of your region, see below. |
| `ACTION1_CLIENT_ID` | required | OAuth2 client ID from Action1 > Settings > API Credentials. |
| `ACTION1_CLIENT_SECRET` | required | OAuth2 client secret, shown once when the credential is created. |
| `ACTION1_ORG_ID` | unset | Default organization UUID; tools can override it with `org_id`. Recommended. |
| `ACTION1_ALLOWED_ORG_IDS` | any | Comma-separated organization UUIDs the tools may address; others are refused. Recommended for HTTP and shared setups. |
| `ACTION1_ALLOW_ENTERPRISE_OPS` | `false` | With `ACTION1_ALLOWED_ORG_IDS` set: also allows mutations not bound to one allowed organization (enterprise settings, script library, roles, users, Enterprise scopes). |
| `ACTION1_ALLOW_DESTRUCTIVE` | `false` | `true` / `1` / `yes` allows tools that change state to execute. |
| `ACTION1_ALLOW_ACCOUNT_OPS` | `false` | Also allows account operations: changes to users, roles, `/me`, the enterprise account, organizations and subscriptions, and every non-GET `action1_raw_request`. |
| `ACTION1_DESTRUCTIVE_AUTO_CONFIRM` | `false` | Isolated single-operator setups only: drops the per-call `confirm: "YES"`. `dry_run` still defaults to `true`. |
| `ACTION1_TOOLSETS` | `all` | `all`, `read` (read-only tools) or `curated` (no generated tools); comma-separated values intersect. |
| `ACTION1_REDACT_PII` | `false` | Masks user names, IP and MAC addresses, other addresses, serial numbers, e-mail addresses, Active Directory fields and personal names in tool output (also report columns such as `User Name` and CSV export columns), resource reads and upstream error bodies. Rules and limits: [SECURITY.md](docs/SECURITY.md). |
| `ACTION1_DEFAULT_TIMEOUT_MINUTES` | `10` | Default script timeout, 0 to 10080. |
| `ACTION1_DEFAULT_RETRY_MINUTES` | `1440` | How long Action1 retries an action for an offline endpoint, 0 to 10080. |
| `ACTION1_LAST_SEEN_STALE_MINUTES` | `10` | Minutes since `last_seen` before an endpoint counts as offline, 1 to 1440: the offline check before an action, `connectivity.online` of `action1_get_endpoint` and the fresh / stale counts of `action1_endpoints_summary`. |
| `ACTION1_REQUEST_TIMEOUT_MS` | `60000` | Budget for one Action1 API call including retries, 1000 to 600000. |
| `ACTION1_TOKEN_TIMEOUT_MS` | `15000` | Timeout for one OAuth token attempt, 1000 to 600000. |
| `ACTION1_LOG_LEVEL` | `info` | `debug`, `info`, `notice`, `warn`, `error`, `critical`, `alert` or `emergency` (case-insensitive). |
| `PORT` | `3000` | HTTP mode: listen port. |
| `HOST` | `127.0.0.1` | HTTP mode: bind address. |
| `MCP_HTTP_TOKEN` | required for `--http` | Bearer token clients must send, at least 16 characters (`openssl rand -hex 32`). |
| `MCP_HTTP_ALLOW_NO_AUTH` | `false` | HTTP mode without a token; loopback binds only, local development. |
| `MCP_HTTP_ALLOWED_HOSTS` | loopback and bind address | Extra `Host` names to accept, e.g. the public name behind a reverse proxy. Required for `0.0.0.0` / `::`. |
| `MCP_HTTP_ALLOWED_ORIGINS` | loopback origins | Browser `Origin` values to accept. |
| `TRUST_PROXY` | `false` | Express `trust proxy`: `false`, `true`, `loopback`, a hop count or a CIDR list. Set `loopback` behind a local reverse proxy so the rate limit sees real client IPs. |

Action1 regions (`ACTION1_BASE_URL`):

| Region | Base URL |
|---|---|
| Europe | `https://app.eu.action1.com/api/3.0` |
| North America | `https://app.action1.com/api/3.0` |
| North America 2 | `https://app.na-2.action1.com/api/3.0` |
| United Kingdom | `https://app.uk.action1.com/api/3.0` |
| Australia | `https://app.au.action1.com/api/3.0` |

## Connecting to MCP hosts

| Host | Transport | Doc |
|---|---|---|
| Claude Code (CLI) | stdio | [INSTALLATION: Claude Code](docs/INSTALLATION.md#claude-code-cli) |
| Claude Desktop (macOS / Windows) | MCPB bundle or stdio | [INSTALLATION: Claude Desktop](docs/INSTALLATION.md#claude-desktop-macos--windows) |
| Claude.ai (web) | Streamable HTTP | [INSTALLATION: Claude.ai](docs/INSTALLATION.md#claudeai-web) |
| Cursor | stdio | [INSTALLATION: Cursor](docs/INSTALLATION.md#cursor) |
| Continue.dev / Cody | stdio | [INSTALLATION: generic](docs/INSTALLATION.md#continuedev--cody--generic-stdio-clients) |

## Tools

[`docs/USAGE.md`](docs/USAGE.md) is the tool reference and
[`docs/EXAMPLES.md`](docs/EXAMPLES.md) has end-to-end recipes. The curated
layer in short:

### Discovery (read-only)

`action1_list_organizations`, `action1_list_endpoints`,
`action1_endpoints_summary` (server-side counters, small output regardless
of fleet size), `action1_get_endpoint` (canonical path with list fallback,
plus derived `platform` and `connectivity.online`),
`action1_search_endpoints` (substring filter on hostname, user, OS,
status), `action1_list_action_templates`, `action1_get_action_template`,
`action1_list_missing_updates`, `action1_list_vulnerabilities`,
`action1_list_recent_automations`, `action1_automations_summary`.

### Execution (destructive, guarded)

`action1_run_powershell` (Windows; fills `success_exit_codes`),
`action1_run_bash_macos` (macOS; fills the ten `run_script` fields),
`action1_run_script` (routes by OS), `action1_reboot_endpoint`,
`action1_deploy_update`, `action1_deploy_package`,
`action1_uninstall_program`, `action1_run_data_collection`. All accept
`target_type: "Endpoint"` (default) or `"EndpointGroup"`;
`action1_run_script` then also needs `os` (`"windows"` or `"macos"`),
because a group has no single OS to detect.

### Polling and results (read-only)

`action1_get_automation_status`, `action1_get_automation_results`,
`action1_get_automation_output` (filters lifecycle markers),
`action1_wait_for_automation`.

### Workflows (destructive, guarded)

`action1_execute_and_wait`: start an action, poll until it ends and return
the filtered output. Routes by OS in `mode: "script"` or runs a named
template in `mode: "template"`.

### High-level wrappers

`action1_endpoint_groups_resolve` (fuzzy group name to UUID),
`action1_software_inventory_for_endpoint`, `action1_recurring_schedules`,
`action1_audit_log_search`, `action1_report_export`,
`action1_cve_remediation_plan`.

### Generated

Every remaining Action1 API operation as a verb-first snake_case tool;
input parameter names are normalised to `snake_case`. See
[`docs/api-coverage.md`](docs/api-coverage.md).

## Destructive guard

A tool flagged `destructiveHint: true` executes only when all of these
hold:

```
ACTION1_ALLOW_DESTRUCTIVE=true    server env, restart required
ACTION1_ALLOW_ACCOUNT_OPS=true    server env, only for account operations
confirm: "YES"                    per call, exact (waived by auto-confirm)
dry_run: false                    per call, the default is true (preview)
```

```jsonc
// Preview only (default)
{ "tool": "action1_run_powershell",
  "arguments": { "endpoint_id": "<uuid>", "script_text": "Get-Date" } }
// -> { "dry_run": true, "would_send": { method, path, body } }

// Execute (server env: ACTION1_ALLOW_DESTRUCTIVE=true)
{ "tool": "action1_run_powershell",
  "arguments": { "endpoint_id": "<uuid>", "script_text": "Get-Date",
                 "dry_run": false, "confirm": "YES" } }
```

`confirm` and `dry_run` are arguments the model sets itself. They stop
accidents, not a model that follows instructions hidden in Action1 data
(hostnames, script output, audit texts). The controls that hold against
that are the ones the model cannot change: the environment switches,
`ACTION1_ALLOWED_ORG_IDS`, `ACTION1_TOOLSETS=read`, the role of the API
credential, and your MCP host's per-tool approval. Do not "always allow"
destructive tools in your host. See [`docs/SECURITY.md`](docs/SECURITY.md)
for the threat model.

## Examples

More in [`docs/EXAMPLES.md`](docs/EXAMPLES.md):

```text
# 1. Fleet health check
> "How many endpoints are online and how many need a reboot?"
  agent -> action1_endpoints_summary

# 2. Read-only PowerShell on one Windows host
> "What's the OS build of <hostname>? Run Get-ComputerInfo OsBuildNumber."
  agent -> action1_search_endpoints { query: "<hostname>", fields: ["hostname"] }
  agent -> action1_run_powershell { endpoint_id: <uuid>,
             script_text: "Get-ComputerInfo OsBuildNumber",
             dry_run: false, confirm: "YES" }
  agent -> action1_wait_for_automation { instance_id: <id>, endpoint_id: <uuid> }

# 3. CVE remediation plan
> "What's needed to remediate CVE-2024-XXXX?"
  agent -> action1_cve_remediation_plan { cve_id: "CVE-2024-XXXX" }
  agent -> action1_deploy_update { ... }   (after operator confirmation)
```

## Rate limits

Action1 does not publish a rate limit. During development about 10
requests per second on the EU instance did not trigger HTTP 429; that is
an observation, not a guarantee. If Action1 answers 429:

- The client honours `Retry-After` (capped at 60 s), for reads and
  mutations alike, because a 429 means the request was not processed.
- For mass actions prefer `target_type: "EndpointGroup"` over one call per
  endpoint; Action1 fans out server-side.

The server has no outgoing throttle and does not cache list responses.
The retry policy is in [`src/client/action1Client.ts`](src/client/action1Client.ts).

## Required Action1 permissions

The tools can only do what the role of the API credential allows.
[`docs/permissions.md`](docs/permissions.md) lists the permission each
operation needs, generated from the permission tags in the pinned spec.
Grant only what the tools you use need. Read `action1://me` or run the
`/check-my-permissions` prompt to see what the configured credential can
do before an agent tries a destructive operation.

## Documentation

| File | What it covers |
|---|---|
| [`docs/INSTALLATION.md`](docs/INSTALLATION.md) | Step-by-step setup for every supported MCP host. |
| [`docs/USAGE.md`](docs/USAGE.md) | Tool reference for the curated and wrapper layers, resources, prompts, output format, cancellation, logging. |
| [`docs/EXAMPLES.md`](docs/EXAMPLES.md) | End-to-end recipes (patching, triage, CVE remediation). |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | stdio, HTTP behind a reverse proxy, systemd, MCPB, production checklist. |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Threat model, destructive guard, data flow to the LLM, reporting vulnerabilities. |
| [`docs/permissions.md`](docs/permissions.md) | Action1 permission per operation and tool (generated). |
| [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) | Common failure modes and fixes. |
| [`docs/FAQ.md`](docs/FAQ.md) | Questions across topics. |
| [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) | Development setup, codegen workflow, tests, pull requests. |
| [`docs/api-coverage.md`](docs/api-coverage.md) | How spec operations map to tools; full table in [`docs/_coverage_table.md`](docs/_coverage_table.md). |
| [`docs/api-coverage-gaps.md`](docs/api-coverage-gaps.md) | What the server does not cover, or covers only with a caveat. |
| [`docs/GOTCHAS.md`](docs/GOTCHAS.md) | Action1 API quirks and the undocumented endpoints the curated tools use. |
| [`docs/adr/`](docs/adr/README.md) | Architecture decision records. |
| [`docs/403-investigation.md`](docs/403-investigation.md) | Why `/general` is not a real path. |
| [`evals/`](evals/README.md) | Evaluation questions for an LLM-driven harness. |
| [`TESTING.md`](TESTING.md) | Test layers and the live-run record. |
| [`CHANGELOG.md`](CHANGELOG.md) | Release notes. |

## Development

```bash
npm run dev               # tsx watch (stdio)
npm run typecheck         # source
npm run typecheck:tests   # tests (tsconfig.test.json)
npm run lint
npm test                  # all test categories
npm run test:unit
npm run test:integration  # MCP protocol round trips
npm run test:security     # destructive-guard truth table, redaction
npm run test:performance  # size limits and rendering at scale
npm run test:coverage     # tests with the coverage thresholds from vitest.config.ts
npm run test:e2e          # builds the MCPB bundle, starts the built servers over stdio
npm run check             # lint, both typechecks, format check, tests (what CI gates on)
npm run codegen           # regenerate src/tools/generated/index.ts from the spec
npm run spec:check        # compare the pinned spec with the one Action1 serves
npm run inspector         # MCP Inspector against the built stdio server
```

The macOS payload-builder tests are deliberately strict: they protect the
reverse-engineered field set. If you change the payload, update the test.

## Roadmap

Open candidates (see also
[`docs/api-coverage-gaps.md`](docs/api-coverage-gaps.md)):

- npm releases with provenance from the release workflow (trusted
  publisher configured; the first workflow publish is pending).
- Live validation of the destructive tools listed under
  [Validation status](#validation-status) on a test endpoint.
- A Cloudflare Workers deployment of the HTTP transport.

## Security

See [`docs/SECURITY.md`](docs/SECURITY.md). Report vulnerabilities through
a private security advisory at
<https://github.com/mguttmann/action1-mcp/security/advisories/new>, not in
a public issue.

## License

[MIT](LICENSE) © 2026 mguttmann, with one exception: the vendored Action1
API specification in `src/codegen/spec/openapi.json` belongs to Action1
Corporation and is not covered by the MIT License. See [`NOTICE`](NOTICE).

## Acknowledgements

- The MCP community at <https://modelcontextprotocol.io>.
- Anthropic's
  [`mcp-builder`](https://github.com/anthropics/skills/tree/main/skills/mcp-builder)
  guide, which shaped the tool design and the evaluation format.
- The other open-source Action1 integrations whose code I read while
  scoping this one, in particular
  [`dimer47/action1-cli`](https://github.com/dimer47/action1-cli),
  [`pts211/action1-mcp-server`](https://github.com/pts211/action1-mcp-server)
  and [`ghively/Action1MCP`](https://github.com/ghively/Action1MCP).
