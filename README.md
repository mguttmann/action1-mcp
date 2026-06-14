# action1-mcp-server

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)
![Coverage](https://img.shields.io/badge/Action1%20API-100%25-success)
![Tools](https://img.shields.io/badge/MCP%20tools-166%20%2833%20curated%20%2B%20133%20generated%29-informational)
![Tests](https://img.shields.io/badge/tests-527%20across%204%20categories-brightgreen)

A production-grade [Model Context Protocol (MCP)](https://modelcontextprotocol.io)
server for the [Action1 RMM](https://www.action1.com/) REST API. Wraps the
entire Action1 API surface so that Claude (or any other MCP host) can run
PowerShell on Windows, Bash on macOS, deploy updates, reboot endpoints,
search audit trails, build CVE remediation plans, and more — all via
natural language and with a three-layer destructive guard so the LLM
cannot accidentally mutate production state.

> **Status:** v0.5.0 — 100 % coverage of the pinned Action1 OpenAPI 3.1.0
> spec, exposed as **166 tools** (33 curated incl. 6 workflow wrappers +
> 133 auto-generated) with pinned SHA, hybrid architecture, three-layer
> destructive guard,
> stdio and Streamable HTTP transports, MCPB bundle, CI.
> Full conformance pass against the Anthropic
> [`mcp-builder` skill best practices](https://github.com/anthropics/skills/tree/main/skills/mcp-builder)
> (server name, tool annotations, response_format, output schemas,
> Markdown rendering, character limits, evaluation suite).

## Why this project

Action1 has a clean REST API but a thick layer of LLM-unfriendly quirks
that, if unhandled, silently produce wrong results:

- macOS Bash actions need a **ten-field `run_script` payload** the API
  returns `not applicable to Mac platform` for any field that is missing.
- Windows PowerShell actions need a **non-empty `success_exit_codes`**.
- `last_seen` is `YYYY-MM-DD_HH-MM-SS` (UTC), not ISO-8601 — `Date.parse`
  returns `NaN` (we render it human-readable in Markdown output).
- The `self` URL of a list-endpoint includes a `/general` segment that is
  **not** a real REST resource.
- The script-output stream is interleaved with `Starting` / `Waiting` /
  `Completed` lifecycle markers that need to be filtered.
- `OS` is upper-case, `platform` is lower-case, both can carry the
  platform string; we normalise via a single detector.

This server encodes all of those. See
[`docs/api-coverage-gaps.md`](docs/api-coverage-gaps.md) §"Cross-repo
comparison" for what other Action1 MCP projects miss.

## Highlights

- **100 % API coverage** — every operation in the pinned Action1 OpenAPI
  3.1.0 spec is reachable through exactly one MCP tool. Mapping in
  [`docs/api-coverage.md`](docs/api-coverage.md). The pin is enforced by
  a unit test (`tests/unit/specSha.test.ts`) so an upstream spec change
  fails the build instead of silently rotting the surface.
- **Hybrid architecture** — hand-curated tools that encode the quirks
  above + auto-generated tools from the spec + high-level workflow
  wrappers (CVE remediation plan, audit log search, software inventory,
  recurring schedules, report export, group resolver).
- **MCP-protocol completeness** — beyond tools, the server also ships:
  - **7 Resources** (`action1://me`, `://orgs`, `://templates`,
    `://reports`, `://endpoints/{orgId}`, `://groups/{orgId}`,
    `://vulnerabilities/{orgId}`) for hosts that pre-fetch context. All
    list-shaped resources are capped to fit the 1 MB host limit and emit
    a truncation note when the cap fires.
  - **6 Slash-Prompts** (`/patch-windows-fleet`, `/audit-vulnerabilities`,
    `/triage-offline-endpoints`, `/run-script-fleetwide`,
    `/software-inventory-sweep`, `/check-my-permissions`) for
    one-click workflows.
  - **`logging/setLevel`** — clients can dynamically bump or lower
    verbosity at runtime.
  - **Cancellation propagation** — long-running tools (`auto_paginate`,
    `wait_for_automation`, `execute_and_wait`) honour the host's
    AbortSignal.
  - **`outputSchema`** declared on every list-shaped read tool for
    client-side validation.
- **Skill-conformant tools** — every tool emits `response_format`
  (`markdown` default, `json` opt-in), a structured description with
  `Args / Returns / Examples / Error Handling` sections, all four
  annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
  `openWorldHint`) explicitly set, and `total` / `count` /
  `next_cursor` / `has_more` on every paginated response.
- **Markdown rendering with humanised values** — Action1 timestamps
  (`YYYY-MM-DD_HH-MM-SS`) render as `YYYY-MM-DD HH:MM:SS UTC`; ID
  columns lead the table; per-tool `CHARACTER_LIMIT = 25_000` keeps
  agent context lean.
- **Three-layer destructive guard** — `ACTION1_ALLOW_DESTRUCTIVE` env
  switch + per-call `confirm: "YES"` + `dry_run: true` (default). The LLM
  cannot accidentally mutate production state. Optional
  `ACTION1_DESTRUCTIVE_AUTO_CONFIRM` for isolated single-operator
  setups (still requires the env switch).
- **Sound auth** — OAuth2 client-credentials with proactive 5-minute
  refresh, in-flight deduplication of concurrent token requests, and
  refresh_token-first fallback when re-acquiring.
- **Robust transport** — retry with exponential backoff for DNS hiccups,
  HTTP 5xx, and 429 (honors `Retry-After`). Pagination walks `limit`/`from`
  transparently with caller-supplied caps.
- **Both transports** — stdio (default; for local Claude Code / Cursor /
  Claude Desktop) + Streamable HTTP, stateless (for hosted Claude.ai
  custom connectors / team setups). HTTP transport supports bearer-token
  auth via `MCP_HTTP_TOKEN` (constant-time compare), a 1 MB body limit,
  and **hard-fails on non-loopback bind without an Origin allowlist**.
- **Distribution** — MCPB bundle for Claude Desktop one-click
  install, npm publish-ready.
- **Observability** — structured JSON-line logs to stderr with
  auto-redaction of `Bearer …`, `api-key-…`, and any property whose
  key looks sensitive (`authorization`, `*_token`, `*_secret`,
  `password`, …). Stdout reserved for MCP JSON-RPC.
- **Strict TypeScript** with Zod input schemas on every tool. **527
  tests across 4 categories** (unit / integration / security / performance).

## Quickstart

```bash
git clone https://github.com/mguttmann/action1-mcp.git
cd action1-mcp
npm install
cp .env.example .env             # edit with your Action1 credentials
npm run build
npm run inspector                # opens MCP Inspector against the built server
```

Or attach directly to Claude Code:

```bash
claude mcp add action1 -- node --env-file=$(pwd)/.env $(pwd)/dist/index.js
```

For the full installation walkthrough — including Claude Desktop, Claude.ai,
Cursor, Continue.dev, and Cody — see [`docs/INSTALLATION.md`](docs/INSTALLATION.md).

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│ Curated tools + Workflow wrappers                                     │
│ • script execution (Win + Mac + OS-aware)                             │
│ • execute_and_wait (POST + poll + filtered output)                    │
│ • get_endpoint with /general → canonical path + list-fallback         │
│ • CVE remediation plan, audit log search, software inventory, …      │
├──────────────────────────────────────────────────────────────────────┤
│ Auto-generated tools                                                  │
│ • one tool per remaining spec operation, verb-first snake_case names  │
│ • shared runtime: pagination, destructive guard, error mapping        │
│ • Action1 OpenAPI 3.1.0 pinned at SHA af75f1cc…                       │
├──────────────────────────────────────────────────────────────────────┤
│ Shared infrastructure                                                  │
│ • Action1Client (auth, retry, pagination, error mapping)               │
│ • TokenProvider (refresh_token fallback, 5-min proactive refresh)      │
│ • OrgResolver (fuzzy name match, session cache)                        │
│ • Three-layer destructive guard (env + confirm + dry_run)              │
│ • Structured stderr logger with auto-key redaction                     │
│ • Markdown auto-table renderer (humanises Action1 timestamps)          │
│ • Per-tool CHARACTER_LIMIT = 25_000 + WIRE_LIMIT_BYTES = 400_000       │
└──────────────────────────────────────────────────────────────────────┘
```

When a curated tool and an auto-generated tool address the same path, the
curated one wins by name and the auto-generated one is suppressed via
`src/codegen/curated-overrides.ts`. See
[`docs/api-coverage.md`](docs/api-coverage.md) for the full mapping.

## Configuration

All configuration is via environment variables; copy
[`.env.example`](.env.example) to `.env` and fill in.

| Variable | Required | Default | Description |
|---|:-:|---|---|
| `ACTION1_BASE_URL` | yes | — | Region-specific instance, e.g. `https://app.eu.action1.com/api/3.0`. |
| `ACTION1_CLIENT_ID` | yes | — | OAuth2 client id from Action1 → Settings → API Credentials. |
| `ACTION1_CLIENT_SECRET` | yes | — | OAuth2 client secret. Shown once at credential creation. |
| `ACTION1_ORG_ID` | recommended | — | Default org UUID. Each tool can override via `org_id`. |
| `ACTION1_DEFAULT_TIMEOUT_MINUTES` | no | `10` | Per-action timeout (PowerShell, etc.). |
| `ACTION1_DEFAULT_RETRY_MINUTES` | no | `1440` | Window during which Action1 retries when an endpoint is offline. |
| `ACTION1_LOG_LEVEL` | no | `info` | One of `debug`, `info`, `notice`, `warn`, `warning`, `error`, `critical`, `alert`, `emergency`. |
| `ACTION1_LAST_SEEN_STALE_MINUTES` | no | `10` | Minutes since `last_seen` before an endpoint is treated as offline (range 1–1440). Tune up for fleets that check in infrequently. |
| `ACTION1_ALLOW_DESTRUCTIVE` | no | `false` | Set to `true` / `1` / `yes` to allow tools with `destructiveHint: true` to mutate state. |
| `ACTION1_DESTRUCTIVE_AUTO_CONFIRM` | no | `false` | Single-operator only: waives the per-call `confirm: "YES"` requirement. `dry_run` still defaults to `true` — pass `dry_run: false` to actually execute. Still requires `ACTION1_ALLOW_DESTRUCTIVE=true`. |
| `PORT` | no | `3000` | HTTP transport port. |
| `HOST` | no | `127.0.0.1` | HTTP transport host. |
| `MCP_HTTP_TOKEN` | no | unset | Required `Authorization: Bearer <token>` on `/mcp` when set. **Strongly recommended for any non-loopback bind.** |
| `MCP_HTTP_ALLOWED_ORIGINS` | no | unset | Comma-separated allowlist for browser `Origin` headers. **Required when binding to a non-loopback host** — the server hard-fails to start otherwise. |
| `TRUST_PROXY` | no | `false` | Reverse-proxy hop trust for correct client IPs in rate-limiting. One of `false` / `true` / `loopback` / a CIDR. Enable only for trusted upstream proxies. |

## Connecting to MCP hosts

| Host | Transport | Doc |
|---|---|---|
| Claude Code (CLI) | stdio | [INSTALLATION § Claude Code](docs/INSTALLATION.md#claude-code-cli) |
| Claude Desktop (macOS / Windows) | stdio | [INSTALLATION § Claude Desktop](docs/INSTALLATION.md#claude-desktop-macos--windows) |
| Claude.ai (web) | Streamable HTTP | [INSTALLATION § Claude.ai](docs/INSTALLATION.md#claudeai-web) |
| Cursor | stdio | [INSTALLATION § Cursor](docs/INSTALLATION.md#cursor) |
| Continue.dev / Cody | stdio | [INSTALLATION § generic](docs/INSTALLATION.md#continuedev--cody--generic-stdio-clients) |

## Tools

See [`docs/USAGE.md`](docs/USAGE.md) for the full tool reference and
[`docs/EXAMPLES.md`](docs/EXAMPLES.md) for end-to-end recipes.

A summary of the curated layer (the auto-generated layer is the long
tail and is documented operation-by-operation in `docs/api-coverage.md`):

### Discovery (read-only)

`action1_list_organizations`, `action1_list_endpoints`,
`action1_endpoints_summary` (server-side aggregation: ~1 KB regardless
of fleet size), `action1_get_endpoint` (with /general → canonical
path fallback, plus derived `platform` and `connectivity.online`),
`action1_search_endpoints` (substring filter on hostname / user / OS /
status), `action1_list_action_templates`, `action1_get_action_template`,
`action1_list_missing_updates`, `action1_list_vulnerabilities` (graceful
403 if scope absent), `action1_list_recent_automations`,
`action1_automations_summary`.

### Execution (destructive — guard required)

`action1_run_powershell` (Windows; auto-fills `success_exit_codes`),
`action1_run_bash_macos` (macOS; auto-fills the ten `run_script` fields),
`action1_run_script` (auto-routes by OS), `action1_reboot_endpoint`,
`action1_deploy_update` (spec-conformant `{scope, packages, reboot_options}`),
`action1_deploy_package`, `action1_uninstall_program`,
`action1_run_data_collection`. All accept `target_type: "Endpoint"` (default)
or `"EndpointGroup"` for bulk fan-out.

### Polling / results (read-only)

`action1_get_automation_status`, `action1_get_automation_results`,
`action1_get_automation_output` (filters `Starting`/`Waiting`/`Completed`),
`action1_wait_for_automation`.

### Workflows (destructive)

`action1_execute_and_wait` — start an action, poll until it terminates,
return the filtered output. Auto-routes by OS for `mode: "script"` or runs
a named template for `mode: "template"`.

### High-level wrappers

`action1_endpoint_groups_resolve` (fuzzy name → UUID),
`action1_software_inventory_for_endpoint`, `action1_recurring_schedules`,
`action1_audit_log_search`, `action1_report_export`,
`action1_cve_remediation_plan`.

### Auto-generated

Every remaining Action1 API operation as a verb-first snake_case tool.
See [`docs/api-coverage.md`](docs/api-coverage.md). All input parameter
names are normalised to `snake_case` for consistency with the curated
layer.

## Resources

Seven MCP resources for hosts that pre-fetch context:

| URI | Purpose |
|---|---|
| `action1://me` | The authenticated identity / role / permissions. Use this as a startup probe to know which tool families will 403. |
| `action1://orgs` | All visible organizations. |
| `action1://templates` | Action template catalog. |
| `action1://reports` | Report catalog. |
| `action1://endpoints/{orgId}` | Live endpoint snapshot per org. Pass `default` to use `ACTION1_ORG_ID`. |
| `action1://groups/{orgId}` | Endpoint groups. |
| `action1://vulnerabilities/{orgId}` | Org-wide CVE rollup. May 403 if the role lacks `view_vulnerabilities`. |

All list-shaped resources are capped at ~400 KB and emit a truncation
note when the cap fires; the equivalent paginated tool gives unbounded
data via cursor chaining.

## Slash-prompts

Six host-surfaced workflows for the most common day-to-day jobs:

| Prompt | Args | What it does |
|---|---|---|
| `/patch-windows-fleet` | `group_query` | Resolves the group, lists missing updates, previews and (after confirmation) deploys. |
| `/audit-vulnerabilities` | `top_n?` | Surveys org-wide vulnerabilities, ranks the worst, presents a remediation plan. |
| `/triage-offline-endpoints` | `stale_minutes?` | Walks the inventory, surfaces endpoints whose `status` or `last_seen` are stale. |
| `/run-script-fleetwide` | `group_query`, `script_text` | Validates the script is read-only, dispatches via OS-aware routing, streams output. |
| `/software-inventory-sweep` | `software_name` | Searches every endpoint's installed software for a substring match. |
| `/check-my-permissions` | — | Reads `action1://me` and reports which tool families will 403 with the current role. |

## Destructive guard

Every tool flagged `destructiveHint: true` enforces three independent gates:

```
ACTION1_ALLOW_DESTRUCTIVE=true   ← server env, restart-required
        AND
confirm: "YES"                    ← exact, case-sensitive
        AND
dry_run: false                    ← default is true → preview-only
```

```jsonc
// Preview only (default)
{ "tool": "action1_run_powershell",
  "arguments": { "endpoint_id": "<uuid>", "script_text": "Get-Date" } }
// → returns { "dry_run": true, "would_send": { method, path, body } }

// Actually execute (server env: ACTION1_ALLOW_DESTRUCTIVE=true)
{ "tool": "action1_run_powershell",
  "arguments": { "endpoint_id": "<uuid>", "script_text": "Get-Date",
                 "dry_run": false, "confirm": "YES" } }
```

Single-operator setups can opt into `ACTION1_DESTRUCTIVE_AUTO_CONFIRM=true`,
which waives only the per-call `confirm: "YES"` requirement — `dry_run`
still defaults to `true`, so a bare call is still a preview; pass
`dry_run: false` to execute. The env switch is still required, and the
server logs a loud warning at start-up when this mode is on.

See [`docs/SECURITY.md`](docs/SECURITY.md) for the full threat model.

## Examples

Three quick workflows; many more in [`docs/EXAMPLES.md`](docs/EXAMPLES.md):

```text
# 1. Fleet health check
> "How many endpoints are online and how many need a reboot?"

  agent → action1_endpoints_summary
  result → { total: 1247, fresh_last_seen: 1130, reboot_required: 38, ... }

# 2. Run a read-only PowerShell on a specific Win11 host
> "What's the OS build of <hostname>? Run `Get-ComputerInfo OsBuildNumber`."

  agent → action1_search_endpoints { query: "<hostname>", fields: ["hostname"] }
  agent → action1_run_powershell {
            endpoint_id: <uuid>,
            script_text: "Get-ComputerInfo OsBuildNumber",
            dry_run: false, confirm: "YES" }
  agent → action1_wait_for_automation { instance_id: <id>, endpoint_id: <uuid> }

# 3. Build a CVE remediation plan
> "What's needed to remediate CVE-2024-XXXX?"

  agent → action1_cve_remediation_plan { cve_id: "CVE-2024-XXXX" }
  result → { plan: [{ cve, affected_endpoints, candidate_packages }], ... }
  agent → action1_deploy_update { ... } (after operator confirmation)
```

## Rate limits

Action1's REST API does not publish a hard rate-limit ceiling. In
practice we observe ~10 requests per second sustained without 429s on
the EU instance. If you do hit 429:

- The retry wrapper honours `Retry-After` automatically.
- Token-bucket-style throttling on `auto_paginate` calls keeps a
  multi-page list walk under ~5 RPS.
- For mass-fan-out actions, prefer `target_type: "EndpointGroup"` over
  individual per-endpoint POSTs — Action1 fans out server-side.

The server does NOT pre-emptively cache list responses; consecutive
calls always hit the API. See [`src/client/retry.ts`](src/client/retry.ts)
for the retry policy.

## Required Action1 permissions

The MCP server's tool surface respects whatever role the API key
carries. Common scopes:

| Tool family | Required permission |
|---|---|
| Discovery (orgs, endpoints, templates, automations) | `view_endpoints`, `view_organizations`, `view_action_templates` |
| Software inventory | `view_installed_software` |
| Missing updates | `view_endpoints` (often suffices) |
| Vulnerabilities | `view_vulnerabilities` (commonly missing on automation-only keys) |
| Audit log | `view_audit` |
| Reports | `view_reports` |
| Execute scripts / deploy / reboot | `manage_actions`, `manage_endpoints` |
| Manage schedules | `manage_schedules` |

Use `action1://me` or the `/check-my-permissions` slash prompt to
confirm what the configured key can do *before* the agent starts
attempting destructive operations.

## Documentation

| File | What it covers |
|---|---|
| [`docs/INSTALLATION.md`](docs/INSTALLATION.md) | Step-by-step for every supported MCP host, plus install FAQ. |
| [`docs/FAQ.md`](docs/FAQ.md) | Cross-topic FAQ + how-to recipes. |
| [`docs/USAGE.md`](docs/USAGE.md) | Tool reference for curated + wrapper layers, plus Resources, Prompts, output-format, cancellation, logging. |
| [`docs/EXAMPLES.md`](docs/EXAMPLES.md) | End-to-end recipes (patching, triage, CVE remediation, etc.). |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | stdio / HTTP / systemd / MCPB / Cloudflare Workers, plus the production checklist. |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Threat model, destructive guard, credential rotation, redaction, rate limits. |
| [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) | Common failure modes and fixes. |
| [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) | Codegen workflow, test layout, commit conventions. |
| [`docs/api-coverage.md`](docs/api-coverage.md) | The full operation-to-tool mapping (166 tools over the pinned spec). |
| [`docs/api-coverage-gaps.md`](docs/api-coverage-gaps.md) | Cross-repo comparison and capability gaps. |
| [`docs/403-investigation.md`](docs/403-investigation.md) | Why `/general` is not a real path. |
| [`evals/`](evals/) | Skill-format evaluation suite (12 multi-hop questions, harness-runnable). |
| [`TESTING.md`](TESTING.md) | Unit / integration / security / performance tests, smoke tests, live-run results (anonymised). |

## Development

```bash
npm run dev               # tsx watch (stdio)
npm run typecheck
npm run lint
npm test                  # 527 tests across all categories
npm run test:unit         # 37 files
npm run test:integration  # MCP-protocol round-trip tests
npm run test:security     # destructive-guard truth table, redaction matrix
npm run test:performance  # capItemList / markdownTable scaling
npm run codegen           # regenerate src/tools/generated/index.ts from the spec
npm run inspector         # MCP Inspector against the built stdio server
```

The macOS payload-builder unit tests are intentionally strict — they
protect against silent regressions of the reverse-engineered field set.
If you change the payload, update the snapshot.

## Roadmap

Tracked in [`docs/api-coverage-gaps.md`](docs/api-coverage-gaps.md) §
"Recommended second-wave roadmap":

- Endpoint groups CRUD + targeting (mostly delivered via auto-gen + the
  `target_type` parameter on curated tools).
- Reports surface (delivered via the auto-gen + `action1_report_export`
  wrapper).
- Software inventory per endpoint (delivered via
  `action1_software_inventory_for_endpoint`).
- CVE-based remediation builder (delivered via
  `action1_cve_remediation_plan`).
- Recurring automations CRUD (delivered via auto-gen).

Open candidates:

- Streamable HTTP "Sampling" / "Elicitation" support if user demand
  appears.
- Cloudflare Workers reference deployment.
- Bundle the generated `_coverage_table.md` into the npm package.

## Security

See [`docs/SECURITY.md`](docs/SECURITY.md). Report vulnerabilities via the
private security advisory at
<https://github.com/mguttmann/action1-mcp/security/advisories/new>.

## License

[MIT](LICENSE) © 2026 mguttmann

## Acknowledgements

- The Action1 team for shipping a clean OpenAPI bundle.
- The MCP community at <https://modelcontextprotocol.io>.
- The Anthropic
  [`mcp-builder`](https://github.com/anthropics/skills/tree/main/skills/mcp-builder)
  skill, whose Quality Checklist this server follows.
- The four sibling projects whose code I read while scoping this one:
  [`dimer47/action1-cli`](https://github.com/dimer47/action1-cli),
  [`pts211/action1-mcp-server`](https://github.com/pts211/action1-mcp-server),
  [`ghively/Action1MCP`](https://github.com/ghively/Action1MCP),
  [`DavidS-GPC/mcp-action1`](https://github.com/DavidS-GPC/mcp-action1).
  Cross-repo notes in
  [`docs/api-coverage-gaps.md`](docs/api-coverage-gaps.md).
