# API Coverage Gaps & Second-Wave Roadmap

> **Status (v0.4.1):** the bullet-pointed "second wave" candidates from the
> earlier draft of this document have largely been delivered. Auto-generation
> from the OpenAPI spec exposes every endpoint listed in section (A)
> automatically; the high-level wrappers cover the workflow shortcuts. See
> [`api-coverage.md`](api-coverage.md) for the canonical coverage statement.
> This document is now mostly historical: it documents the cross-repo
> comparison and the rationale for the hybrid architecture. Items marked
> "delivered" below have a corresponding tool in v0.4.1.

What this document is: a survey of Action1 REST API capabilities the MCP
server may not yet expose ergonomically, plus a comparison against four
sibling Action1 / MCP projects on GitHub.

What it is not: a vulnerability disclosure or a complaint that anything is
broken.

## Sources

The Action1 OpenAPI spec is bundled (not exposed as a flat JSON) inside the
Swagger UI's JS asset, so the authoritative endpoint catalog used here is
re-derived from the URI lookup table inside the official PowerShell module
[PSAction1](https://github.com/Action1Corp/PSAction1) (`PSAction1.psm1`),
cross-checked against:

- <https://www.action1.com/api-documentation/>
- <https://www.action1.com/api-documentation/how-action1-api-works/>
- <https://www.action1.com/api-documentation/querying-extended-data/>
- <https://www.action1.com/api-documentation/filtering-data/>
- <https://www.action1.com/api-documentation/api-credentials/>
- <https://www.action1.com/documentation/> (and sub-pages on custom
  attributes, remote actions, alerts, users-and-roles)

## What the API actually exposes

Re-derived endpoint inventory (PSAction1 URI table + product docs):

### Read paths

- `GET /Me` — auth/session identity, role, defaults
- `GET /organizations`
- `GET /endpoints/managed/{org}` — list endpoints (covered)
- `GET /endpoints/managed/{org}/{id}` — get one endpoint (covered, after
  the `/general` fix)
- `GET /endpoints/groups/{org}` and `/{org}/{id}/contents` — endpoint
  groups + members
- `GET /endpoints/discovery/{org}` — unmanaged / discovery candidates
- `GET /apps/{org}/data` and `/data/{endpoint_id}` — installed software
  inventory per endpoint
- `GET /policies/schedules/{org}` — recurring "automations" (cron-like
  scheduled runs)
- `GET /policies/instances/{org}` and `/{org}/{id}` — one-off run instances
- `GET /policies/instances/{org}/{id}/endpoint_results`
- `GET /automations/instances/{org}` and `?endpoint_id={id}` (covered for
  list-recent; the per-endpoint filter we don't use)
- `GET /reports/all` — list built-in/custom reports
- `GET /reportdata/{org}/{report_id}/data` — structured report rows
- `GET /reportdata/{org}/{report_id}/export` — CSV export
- `GET /scripts/all` — Action1 Script Library
- `GET /packages/all` and `/packages/all/{id}` (+ `?fields=versions`)
- `GET /software-repository/all/{pkg}/{ver}/upload?platform=…` — chunked
  package upload entry
- `GET /Vulnerabilities/{org}` — org-wide CVE rollup (we cover only the
  per-endpoint variant)
- `GET /updates/{org}`
- `GET /logs/{org}` — audit log
- `GET /setting_templates/{org}` — advanced settings templates

### Write paths (PSAction1 conventions)

- `POST /policies/schedules/{org}` — create recurring automation
- `POST /policies/instances/{org}` — fire a run-now (covered — every
  Win/Mac/template execution we have flows through this)
- `POST /endpoints/groups/{org}` and `PATCH/DELETE /…/{id}` — group CRUD
- `POST /endpoints/groups/{org}/{id}/contents` — group membership
- `POST /organizations` — create org (MSP scenarios only)
- `PATCH /policies/schedules/{org}/{id}` and `DELETE` — modify/delete
  recurring automation
- `PATCH /endpoints/managed/{org}/{id}` — rename, comment, set custom
  attributes (`{"custom:Attr Name": value}`)
- `DELETE /endpoints/managed/{org}/{id}` — decommission
- `POST /reportdata/{org}/{id}/requery` — force report data refresh
- `POST /apps/{org}/requery/{endpoint_id}` — force inventory refresh
- `POST /updates/installed/{org}/requery`

## (A) Endpoints missing from the MCP

| Path / Method | Purpose | Relevance | Effort | Why useful |
|---|---|:-:|:-:|---|
| `GET /Me` | Auth identity, role, defaults | High | S | One-line health/auth check; lets Claude self-describe permissions before suggesting actions. |
| `GET /reports/all` | List built-in / custom reports | High | S | Discovery for the report data path. |
| `GET /reportdata/{org}/{rep}/data` | Structured report rows + drill-down | **High** | M | One feature unlocks software inventory, installed updates, AD info, hardware, services — without writing per-domain tools. |
| `GET /reportdata/{org}/{rep}/export` | CSV export | High | S | Cheapest path to bulk-pull data the MCP doesn't model. |
| `POST /reportdata/.../requery`, `/apps/.../requery/{ep}`, `/updates/installed/{org}/requery` | Force data refresh | Medium | S | Pairs with our existing `wait_for` polling pattern. |
| `GET /apps/{org}/data` and `/data/{ep}` | Installed software inventory per endpoint | **High** | S | "Is Chrome installed on host X?" today requires PowerShell shell-out. With this it's one list call. |
| `GET /scripts/all` | Action1 Script Library | High | S | Lets Claude pick a vetted library script instead of always shipping inline PS/Bash. |
| `GET /endpoints/groups/{org}` (+ `/{id}/contents`) | List endpoint groups + members | **High** | S | Group IDs are accepted by every existing run/deploy tool's `endpoints[]` array — groups are the canonical bulk target. |
| `POST /endpoints/groups/{org}` / `PATCH` / `DELETE` (+ `…/contents`) | Group CRUD + dynamic include/exclude filters | **High** | M | Lets Claude build dynamic populations (e.g. *all Windows 11 boxes missing CVE-X*) and reuse them across runs. |
| `GET /endpoints/discovery/{org}` | Unmanaged / discovery candidates | Medium | S | Useful for fleet-hygiene questions. |
| `GET /Vulnerabilities/{org}` (org-level) | CVE rollup across the org, not just per endpoint | High | S | Today we have per-endpoint only; org-level rollup is the natural starting point. |
| CVE-based remediation builder (synthesises `POST /policies/instances`) | Map CVEs → packages, target endpoints/groups, fire one remediation policy | **High** | M | Most "agentic" win — Claude lists vulns, then fixes them. |
| `GET /policies/schedules/{org}` + `POST/PATCH/DELETE` | Recurring automations (weekly patch windows) | High | M | The MCP only fires one-offs today; persistent schedules are how customers actually run patch maintenance. |
| `GET /logs/{org}` | Audit log | Medium | S | Compliance, RCA, "who deployed X". |
| `GET /setting_templates/{org}` | Setting templates | Low | S | Mainly internal scaffolding. |
| `GET /packages/all/{id}` (+ versions) and `/software-repository/.../upload` | Package detail / version list / chunked upload | Medium | S–L | Read is cheap. Upload is non-trivial (multipart + ranged PUTs). |
| `PATCH /endpoints/managed/{org}/{id}` (rename, comment) | Light fleet management | Medium | S | Renaming endpoints from chat. |
| `PATCH /endpoints/managed/{org}/{id}` with `{"custom:Attr Name": value}` | Set custom attribute | High | S | One-call CMDB tagging. |
| `DELETE /endpoints/managed/{org}/{id}` | Decommission endpoint | Medium | S | Offboarding flows. |
| `POST /organizations` | Create org (MSP) | Low | S | Niche unless tenant is MSP. |

## (B) Action templates beyond the eight known

The MCP currently knows: `run_powershell`, `run_script`, `run_command`,
`reboot`, `deploy_update`, `deploy_package`, `uninstall_program`,
`run_data_collection` (eight templates).

Cross-referencing PSAction1, the public `remote-actions/` doc, and the
Swagger UI references, **no additional fireable action templates were
found**. Notable absences worth flagging:

- **Wake-on-LAN** exists as a feature but appears to be a heartbeat-driven
  scheduler property (`retry_minutes`, "endpoint becomes available"
  semantics in PSAction1), not a directly-fireable template.
- **Remote Desktop** is browser-initiated only — no API verb is exposed
  for it. The `/endpoints/managed/{org}/{ep}/remote-sessions` paths
  manage *existing* sessions but do not start new ones.
- **Service control / registry / file transfer / shutdown** — none surface
  as templates. They are achievable only by sending PowerShell or Bash via
  `run_powershell` / `run_script`.

Net new templates to add as tools: **none**.

## (C) Query parameters not yet used

The Action1 docs page on
[Querying Extended Data](https://www.action1.com/api-documentation/querying-extended-data/)
and
[Filtering Data](https://www.action1.com/api-documentation/filtering-data/)
documents:

| Parameter | Where | What | Effort |
|---|---|---|:-:|
| `fields=*` / `fields=#` / `fields=name1,name2` | `endpoints/managed`, `endpoints/groups/.../contents`, `packages/all`, `packages/all/{id}`, `updates/all`, `updates/{org}` | Returns extended/computed fields like `missing_critical_updates`, `missing_other_updates`, `versions`, `outdated_endpoints`. URL-encoded (`%2A`, `%23`). | S |
| `limit=` / `from=` | All collection endpoints | Pagination — already used. | — |
| `next_page` / `prev_page` | All collection responses | Cursor-style follow-up — we currently use `from` only. | S |
| Equality filters (e.g. `?security_severity=Important&approval_status=New`) | Updates and other collections | Server-side filtering — AND-joined equality only. | S |
| `endpoint_id={id}` | `/automations/instances/{org}` | Scope automation history to one endpoint. | S |

No documented sort operator and no documented complex filter language.

## (D) Webhooks / event streaming

**No webhook or event-stream API exists** in Action1. The Alerts feature
delivers email only (rate-limited at 10/hour/endpoint/rule); the docs
explicitly omit any API/webhook surface. PSAction1 has zero hooks-related
URI. The closest patterns the MCP can use are polling
`/policies/instances/{org}/{id}/endpoint_results` (already implemented as
`wait_for_automation`) and `/logs/{org}` (not yet implemented).

No second-wave tool can be built here without product changes from Action1.

## (E) Bulk operations

Action1 does not expose bulk *operation* endpoints beyond what is already
used. The patterns are:

1. `endpoints: [{id, type: Endpoint|EndpointGroup}, …]` arrays inside
   policy instances — already used.
2. **Endpoint groups** themselves — passing one group ID and letting the
   action fan out is the bulk primitive Action1 actually intends.
3. Server-side CVE deduplication — posting many CVEs that resolve to one
   patch is collapsed automatically (PSAction1's `AddCVE` helper does this
   client-side too).

There is no `/bulk` endpoint, no batch-of-mixed-operations endpoint, and no
transaction wrapper.

## Status of the second-wave roadmap (originally drafted in v0.1)

1. **Endpoint Groups CRUD + targeting** — **delivered in v0.4.1.**
   `action1_endpoint_groups_resolve` (curated wrapper) plus the auto-generated
   `action1_list_endpoint_groups`, `action1_create_endpoint_group`,
   `action1_list_group_contents`, the curated `action1_add_endpoint_to_group` /
   `action1_remove_endpoint_from_group`, `action1_update_group`,
   `action1_delete_group`. Every
   curated execution tool now also accepts `target_type: "EndpointGroup"`
   for bulk fan-out.
2. **Reports surface** — **delivered in v0.4.1.** `action1_report_export`
   wrapper plus `action1_list_reports`, `action1_create_report`,
   `action1_list_report_data`, and `action1_get_export_for_report`
   auto-generated tools.
3. **Software inventory per endpoint** — **delivered in v0.4.1.**
   `action1_software_inventory_for_endpoint` wrapper plus
   `action1_list_installed_software_data`, `action1_list_installed_software_errors`,
   `action1_requery_installed_software_for_endpoint`, and
   `action1_requery_installed_software_for_org` for refreshing.
4. **CVE-based remediation builder** — **delivered in v0.4.1.**
   `action1_cve_remediation_plan` (read-only correlator) plus
   `action1_list_org_vulnerabilities` (org-wide with all 13 filter params),
   `action1_list_vulnerabilities` (per-endpoint), `action1_list_cve_endpoints`,
   `action1_list_cve_remediations`, `action1_get_cve`, `action1_get_cve_description`,
   and the spec-conformant `action1_deploy_update` body shape.
5. **Recurring automations CRUD** — **delivered in v0.4.1** via the
   auto-generated `action1_list_automation_schedules`,
   `action1_create_automation_schedule`, `action1_update_automation`,
   and `action1_delete_automation`. The
   `action1_recurring_schedules` wrapper layers a friendlier filter over
   the read path.

Honourable mentions:

- `set_custom_attribute` — auto-generated as `action1_update_endpoint`
  (PATCH on managed endpoint).
- `list_audit_logs` — delivered as `action1_audit_log_search` (wrapper)
  plus `action1_list_audit_events` (auto-gen).
- `list_scripts` — delivered as `action1_list_scripts` (auto-gen).
- `fields=*` + cursor pagination on every existing read tool
  — auto-generated tools forward arbitrary query params, so this is
  reachable today; ergonomic wrappers are open.

## Comparative observation: other Action1 / MCP projects

Cross-repo survey of four similar projects on GitHub:

| Repo | Lang / SDK | Transport | Tools | Coverage strategy |
|---|---|---|:-:|---|
| [dimer47/action1-cli](https://github.com/dimer47/action1-cli) | Go (`mcp-go`) | stdio | ~50 | Hand-curated, generic POST/GET pass-through (caller hand-builds bodies). |
| [pts211/action1-mcp-server](https://github.com/pts211/action1-mcp-server) | TS (`@modelcontextprotocol/sdk`) | stdio | 139 | **Spec-driven**: bundles `A1ApiDocs3.0NA.json` (96 paths, 140 ops), generates one tool per operation via `$ref`-resolving Zod converter. |
| [ghively/Action1MCP](https://github.com/ghively/Action1MCP) | TS | stdio | ~17 | Doc-driven; 7 generic CRUD tools + ~10 helpers, descriptor table in `endpoints.ts`. |
| [DavidS-GPC/mcp-action1](https://github.com/DavidS-GPC/mcp-action1) | TS (`axios`) | stdio + HTTP/SSE | 11 | Curated; smallest surface, dual transport, session-scoped org cache. |
| **action1-mcp (this repo)** | TS (`@modelcontextprotocol/sdk`) | stdio + Streamable HTTP | 22 | Curated, **quirk-encoded** (Mac 10-field payload, Win `success_exit_codes`, last_seen parser, output filter, `/general` fix). |

### Quirks: who handles what

| Concern | Ours | dimer47 | pts211 | ghively | DavidS |
|---|:-:|:-:|:-:|:-:|:-:|
| macOS Bash 10-field payload encoded server-side | ✅ | ⚠ caller-supplied | ⚠ caller-supplied | ❌ no exec tool | ❌ Mac unsupported |
| Windows `success_exit_codes` enforced | ✅ | ⚠ caller-supplied | ⚠ caller-supplied | n/a | ❌ **likely broken** — script-run posts no `success_exit_codes`, API rejects |
| `last_seen` underscore format parsed | ✅ | ❌ | ❌ | ❌ (returns raw string; agent misreads as ISO) | ❌ |
| Output filter (`Starting`/`Waiting`/`Completed` stripped) | ✅ | ❌ | ❌ | ❌ | ❌ |
| `/general` 403 handled correctly (canonical path) | ✅ | ❌ | ❌ | ❌ (declared as subresource, bubbles 403) | ❌ |

In short: **no other Action1 MCP project encodes the Mac payload, the
last_seen format, or the output filter.** Anything driven by an LLM agent
through those projects will silently produce malformed Mac actions, mis-read
freshness, and pollute its context with lifecycle prose.

### Patterns worth borrowing (ROI-ordered)

1. **Three-layer destructive guard** (pts211, ghively): env switch
   `ACTION1_ALLOW_DESTRUCTIVE=true` *plus* per-call `confirm: "YES"` *plus*
   `dry_run: true` mode that returns the exact `{method, url, redacted-headers, body}` that
   would be sent. This is a strong fit for our `run_powershell` /
   `run_bash_macos` / `reboot_endpoint` / `deploy_*` / `uninstall_program`
   surface. Effort: S.
2. **Refresh_token fallback in OAuth** (pts211, dimer47): try the refresh
   token first, only re-exchange `client_credentials` if that fails.
   Survives a temporarily-revoked secret without dropping all sessions.
   Our current implementation only uses `client_credentials`. Effort: S.
3. **Session-scoped org cache with fuzzy-name match** (DavidS):
   `resolveOrg("Acme")` → exact-id → exact-name → contains-match against
   `/organizations`, cached per session. Removes UUID toil for the agent.
   Effort: S.
4. **Structured stderr logger with redaction** (ghively): JSON-to-stderr
   with a `REDACT_KEYS` list (`authorization`, `token`, `secret`, …) that
   recursively scrubs any meta. Stdout is reserved for MCP JSON-RPC, so
   accidentally logging a Bearer token is a real risk. Effort: S.
5. **Markdown auto-table renderer for `{items:[...]}` responses** (pts211):
   detects columns, caps at ~25 KB, returns a much nicer agent read than
   raw JSON. Effort: S.
6. **Spec-driven `action1_raw_*` family as a *complement*** (pts211): not a
   replacement for our 33 curated tools — the spec mis-shapes Mac/Windows
   script payloads — but it could expose the long tail (RBAC, audit,
   deployers, report subscriptions, vulnerability remediation CRUD) without
   us hand-coding 100+ more tools. Effort: M–L.

### Bugs in other repos that our quirks-encoding already prevents

- **`DavidS-GPC/mcp-action1` `run_script`** posts `{name, script_id,
  endpoint_ids, run_once:true}` to `/policies/instances/{org}` with no
  `success_exit_codes`. Our payload builder always emits `"0"` by default.
- **`pts211/action1-mcp-server` and `dimer47/action1-cli`** punt the Mac
  payload to free-form JSON. The agent must know all ten fields including
  `run_script_language="Bash"`, `platform="Mac"`,
  `reboot_options.auto_reboot="no"`, the four empty-string `condition_*`
  fields, etc. Without a server-side encoder, agent-driven Mac execution
  will silently emit malformed automations and the API will reply *"not
  applicable to Mac platform"*. Our `buildMacOsBashPayload` removes that
  failure mode entirely.
- **`ghively/Action1MCP` `list_endpoints_simple`** returns `last_seen` as
  the raw underscore string. The agent then reasons about it as ISO-8601
  (which `Date.parse` returns `NaN` for) and gets freshness wrong. Our
  `parseTimestamp` normalises both formats.
- **All four** declare `/endpoints/managed/{orgId}/{endpointId}/general`
  as a real path. On a restricted API key role they all 403. Ours calls
  the canonical path (`/endpoints/managed/{orgId}/{endpointId}`) and falls
  back to the list scan as defence-in-depth.

### Capabilities those repos have that we don't

These overlap heavily with the gaps already listed above, but the
comparison surfaces a few additional areas worth noting:

| Feature | Source | Relevance | Effort |
|---|---|:-:|:-:|
| RBAC / audit / permissions / role-users tools | dimer47 (~10 tools) | Medium — compliance flows | M |
| Software-repository CRUD + chunked upload | dimer47, pts211 | Low — agents rarely author packages | L |
| Report subscriptions + drill-down + CSV export | dimer47, pts211 | Medium — already in our roadmap (Reports surface) | S–M |
| Vulnerability remediation CRUD (`POST/PATCH/DELETE /vulnerabilities/{org}/{cve}/remediations`) | pts211 | Medium — natural follow-up to our list_vulnerabilities (when scope is granted) | M |
| Remote session start / get / switch-monitor | dimer47, pts211, ghively | Low — interactive flow, awkward via MCP | S |
| `HTTP + legacy SSE` transport alongside stdio | DavidS | Low for now, high if we ever ship hosted | M (we already have stateless Streamable HTTP) |

