# Usage Guide

This is a tool reference for the curated and wrapper layers. The
auto-generated tools follow a verb-first `action1_<verb>_<resource>` pattern
(e.g. `action1_create_organization`, `action1_get_endpoint`,
`action1_list_org_vulnerabilities`) and are listed in
[`api-coverage.md`](api-coverage.md). For the full machine-readable list,
ask your MCP host for `tools/list`.

## Conventions

Every tool that targets an organization accepts an optional **`org_id`**
parameter. If omitted, the value of `ACTION1_ORG_ID` from the server
environment is used. `org_id` takes a UUID; `action1_list_organizations`
lists them. With `ACTION1_ALLOWED_ORG_IDS` set, other organizations are
refused.

Every tool flagged `destructiveHint: true` requires the
[**three-layer destructive guard**](SECURITY.md#destructive-guard):

- `ACTION1_ALLOW_DESTRUCTIVE=true` in the server environment, **AND**
- for account operations (users, roles, `/me`, enterprise,
  organizations, subscription, `action1_raw_request` writes) also
  `ACTION1_ALLOW_ACCOUNT_OPS=true`, **AND**
- `confirm: "YES"` (exact, case-sensitive) on the call, **AND**
- `dry_run: false` (default is `true`: preview only).

Tool inputs are strict: an unknown or misspelled argument is a validation
error, not ignored.

The execution tools share these inputs:

- `endpoint_id`: the endpoint UUID, or the endpoint group ID when
  `target_type` is `"EndpointGroup"`.
- `target_type`: `"Endpoint"` (default) or `"EndpointGroup"` to run the
  action on every member of a group.
- `name`: a friendly name for the automation as shown in the Action1
  console.
- `timeout_minutes` / `retry_minutes` (script tools): per-action timeout
  and how long Action1 keeps retrying an offline endpoint, a number or a
  digit string from 0 to 10080. Defaults come from
  `ACTION1_DEFAULT_TIMEOUT_MINUTES` and `ACTION1_DEFAULT_RETRY_MINUTES`.
- `skip_connectivity_check` (where offered): skip the check that aborts
  when the endpoint looks offline (status plus `last_seen` older than
  `ACTION1_LAST_SEEN_STALE_MINUTES`). Not recommended; the action then
  queues until the endpoint checks in.

The polling tools take the `instance_id` that a start tool returned.

Every paginated read tool accepts `limit` (cap on the items one call
returns, an integer of at least 1). Paginated generated tools also accept
`from` (first record when no `cursor` is given, an integer of at least 0)
and `auto_paginate: true` (walk pages until `limit` or the size budget,
then continue with `next_cursor`).

Every list-shaped tool accepts an optional **`response_format`**:

- `"markdown"` (default) → renders `items` as a compact Markdown table
  with humanised timestamps and `name (id)` display columns. Token-cheap
  for the agent and human-readable in the UI.
- `"json"` → emits the raw structured JSON. Use this for programmatic
  filtering / aggregation over large datasets.

Single-object reads (e.g. `action1_get_endpoint`) default to compact
JSON because table rendering doesn't apply.

Every paginated response includes `count`, `has_more`, and
`next_cursor`, also a plain call of a generated list tool without
`cursor` or `auto_paginate`. When `has_more` is true, re-call the same tool with the
same arguments and `cursor` set to the previous `next_cursor` until it
returns false. `total` appears on the final page (the real number of
items across the whole walk) and is omitted while more pages follow.

A page holds what its output format can carry: in Markdown (the default)
the rows that fit the table text budget, in JSON up to ~400 KB of items.
`next_cursor` always points at the first item not yet returned, so
chaining cursors never skips or repeats items. A cursor that was
truncated, edited, or issued for other arguments is rejected with an
error; omit `cursor` to start over.

---

## Curated tools

### Discovery / read

#### `action1_list_organizations`

List every organization the configured API key can access. `admin: true`
keeps only the organizations on which the key has admin rights.

```jsonc
{
  "tool": "action1_list_organizations",
  "arguments": { "limit": 10 }
}
```

#### `action1_list_endpoints`

List managed endpoints for an organization. Returns hostname, status, OS,
primary user, last_seen, and the endpoint id needed by other tools.
Server-side filters: `status`, `online_status`, `update_status`,
`vulnerability_status`, `reboot_required` (`Yes` / `No`), `os`, and `filter`
(case-insensitive substring over all fields). `sortby` sets the sort key
(for example `name` or `last_seen`), `fields` asks Action1 for the extra
field sets `missing_updates` or `vulnerabilities` (or `*`), `page_size`
sets the upstream page size (1 to 500, default 200), and
`reset_cache: true` asks Action1 for a fresh page instead of a cached one.
`projection` shapes each row: `bare` (default, the identifying fields),
`compact` (adds the common detail fields) or `full` (the record as
Action1 returns it).

```jsonc
{
  "tool": "action1_list_endpoints",
  "arguments": { "page_size": 200, "limit": 1000 }
}
```

#### `action1_endpoints_summary`

Counts over the whole fleet without returning the endpoints: `total`,
`by_status`, `by_platform`, `by_os`, `by_online_status`,
`fresh_last_seen` / `stale_last_seen`, `reboot_required` and the
`windows` / `macos` / `linux` split from OS detection. The walk is
streamed, so the output stays small for any fleet size. Use it instead of
`action1_list_endpoints` for "how many" questions.

```jsonc
{
  "tool": "action1_endpoints_summary",
  "arguments": {}
}
```

#### `action1_get_endpoint`

Fetch the full endpoint info for one id. Auto-detects platform and computes
connectivity (`status` + `last_seen`-aware).

```jsonc
{
  "tool": "action1_get_endpoint",
  "arguments": { "endpoint_id": "<uuid>" }
}
```

Returns:

```jsonc
{
  "general": { /* full endpoint record */ },
  "platform": "windows",
  "connectivity": {
    "online": true,
    "reason": "Endpoint connected; last_seen 2 minutes ago.",
    "lastSeen": "2026-05-03_19-58-12",
    "lastSeenAgeMinutes": 2
  },
  "source": "canonical"
}
```

#### `action1_search_endpoints`

Substring search over hostname / user / OS / status across all endpoints.
`fields` restricts the match to some of these fields; `projection`
shapes each hit like in `action1_list_endpoints` (default `compact`).

```jsonc
{
  "tool": "action1_search_endpoints",
  "arguments": { "query": "win11", "fields": ["os"], "limit": 50 }
}
```

#### `action1_list_action_templates` / `action1_get_action_template`

Discover available templates and their parameters. `applicable_to`
filters the list to the templates that apply to a context URL;
`action1_get_action_template` takes the `template_id` from the list.

#### `action1_list_missing_updates`

Per-endpoint update list for the `endpoint_id` given. Each item has an
`id` you can pass to `action1_deploy_update`.

#### `action1_list_vulnerabilities`

Per-endpoint vulnerabilities for the `endpoint_id` given. Returns a
graceful 403 if the API key role lacks the `view_vulnerabilities`
permission.

#### `action1_list_recent_automations`

Most recent automation instances. Useful for picking up an `instance_id` of a
job started outside this MCP session.

#### `action1_automations_summary`

Counts over recent automation instances: `total_scanned`, `by_status`,
`success_count`, `warning_count` and `failure_count` (`Error` and
`Stopped` count as failures). There is no per-template count: the spec
omits `actions` from instance lists, and the live API returns them
empty. `max_scan` caps how many
instances are walked (1 to 10000, default 1000). When more instances
exist, the result has `has_more: true` and a `note`, and the counts
cover only the instances walked; raise `max_scan` for a complete count.

```jsonc
{
  "tool": "action1_automations_summary",
  "arguments": { "max_scan": 500 }
}
```

### Execution (destructive - guard required)

#### `action1_run_powershell`

Run a PowerShell script on a Windows endpoint. The optional
`success_exit_codes` (digits separated by commas) defaults to `"0"`;
override it only when the script deliberately exits with a non-zero
status (e.g. `"0,3010"` for a reboot-pending exit).

```jsonc
// Preview (default)
{
  "tool": "action1_run_powershell",
  "arguments": {
    "endpoint_id": "<uuid>",
    "script_text": "Get-ComputerInfo | Select-Object OsName,OsVersion"
  }
}

// Actually execute
// Server env: ACTION1_ALLOW_DESTRUCTIVE=true
{
  "tool": "action1_run_powershell",
  "arguments": {
    "endpoint_id": "<uuid>",
    "script_text": "Get-Date",
    "dry_run": false,
    "confirm": "YES"
  }
}
```

#### `action1_run_bash_macos`

Run a Bash script on a macOS endpoint. The full ten-field
`run_script` payload is filled in automatically - you only supply
`endpoint_id` and `script_text`.

#### `action1_run_script`

OS-aware wrapper. Looks up the endpoint, detects the platform, and dispatches
to PowerShell on Windows or Bash on macOS. Returns a clear error for Linux or
unknown platforms. The lookup also runs for `dry_run` previews, because the
preview body depends on the OS.

For a group, pass `target_type: "EndpointGroup"` and `os` (`"windows"` for
PowerShell, `"macos"` for Bash). A group has no single OS to detect, so `os`
is required there and no endpoint lookup or connectivity check runs. For a
single endpoint, `os` is optional and must match the detected platform.

```jsonc
{
  "tool": "action1_run_script",
  "arguments": {
    "endpoint_id": "<uuid>",
    "script_text": "echo hello",
    "dry_run": false,
    "confirm": "YES"
  }
}
```

`success_exit_codes` applies to PowerShell only and is ignored on macOS.
Set `skip_connectivity_check: true` to bypass the offline check (not
recommended).

#### `action1_reboot_endpoint`

Reboot an endpoint. Combine with `action1_wait_for_automation` to know when it
comes back. For a single endpoint the offline check runs first;
`skip_connectivity_check: true` sends the reboot anyway, and it fires on
the next check-in.

#### `action1_deploy_update`

Deploy specific updates by package id. Each entry of `updates` names a
`package_id` and the `version` to deploy, as the missing-update or
vulnerability tools list it (repository packages list `Latest`); it is
sent unchanged. Whether the API also accepts an empty string is not
documented ([GOTCHAS](GOTCHAS.md#deploy-update-version-latest-unverified)).
`reboot_after` is `no` (default), `if_required` or `yes`;
`display_summary` is an optional note shown in the Action1 console.

```jsonc
{
  "tool": "action1_deploy_update",
  "arguments": {
    "endpoint_id": "<uuid>",
    "updates": [
      { "package_id": "<package-id-1>", "version": "<version>" },
      { "package_id": "<package-id-2>", "version": "Latest" }
    ],
    "reboot_after": "if_required",
    "dry_run": false,
    "confirm": "YES"
  }
}
```

Get the package ids from `action1_list_missing_updates`.

#### `action1_deploy_package` / `action1_uninstall_program` / `action1_run_data_collection`

Generic template-based wrappers; pass the template-specific `params` object.
Inspect required parameters via `action1_get_action_template`.

### Polling / results

#### `action1_get_automation_status`

Status, percent_completed, timestamps for one automation instance
(`instance_id`).

#### `action1_get_automation_results`

Per-endpoint result rollup for one instance (`instance_id`).

#### `action1_get_automation_output`

Filtered script stdout for one endpoint (`endpoint_id`) of one instance
(`instance_id`). Strips
`Starting`/`Waiting`/`Completed` lifecycle markers automatically. Pass
`include_raw: true` to also return the unfiltered description list.

#### `action1_wait_for_automation`

Block until an instance reaches a final status (Success / Warning / Error / Stopped) or times out.
Default 5-minute timeout, 5-second polling interval. Returns the final status
and, if `endpoint_id` is set, the filtered script output. Sends an MCP
progress notification after every poll when the client requests progress.

```jsonc
{
  "tool": "action1_wait_for_automation",
  "arguments": {
    "instance_id": "<job-id>",
    "endpoint_id": "<uuid>",
    "timeout_seconds": 600,
    "poll_interval_seconds": 10
  }
}
```

### Workflow

#### `action1_execute_and_wait`

The most useful tool in the kit: starts an action, polls until it terminates,
returns the filtered output. When the client requests progress, the first
notification is sent right after the start, before any poll, and names the
`instance_id`; then one follows per poll. An error after the start names
the `instance_id` too, so the agent can keep waiting with
`action1_wait_for_automation` instead of starting the action again. The
start is also logged as an `action_started` audit line with the
`instance_id`. A client without progress support whose request timeout is
shorter than `timeout_seconds` should pass a lower `timeout_seconds` (the
error then names the instance) or use the start tools plus
`action1_wait_for_automation`. Auto-routes by OS for `mode: "script"` or runs a
named template for `mode: "template"` with its template `params`.
`success_exit_codes` (PowerShell only, default `"0"`), `timeout_seconds`
(default 300), `poll_interval_seconds` (default 5) and
`skip_connectivity_check` work as in the tools above.

```jsonc
// Run a script and wait for output
{
  "tool": "action1_execute_and_wait",
  "arguments": {
    "endpoint_id": "<uuid>",
    "mode": "script",
    "script_text": "Get-Date; hostname",
    "timeout_seconds": 300,
    "dry_run": false,
    "confirm": "YES"
  }
}

// Reboot and wait for the job to terminate
{
  "tool": "action1_execute_and_wait",
  "arguments": {
    "endpoint_id": "<uuid>",
    "mode": "template",
    "template_id": "reboot",
    "timeout_seconds": 600,
    "dry_run": false,
    "confirm": "YES"
  }
}
```

---

## High-level wrappers

### `action1_endpoint_groups_resolve`

Fuzzy lookup of an endpoint group. Tries exact id → exact name → starts-with →
contains.

```jsonc
{
  "tool": "action1_endpoint_groups_resolve",
  "arguments": { "query": "marketing-laptops" }
}
```

Returns `{ match_strategy, matches, total_groups }`.

### `action1_software_inventory_for_endpoint`

Installed-software list for one endpoint, optionally filtered by name.

```jsonc
{
  "tool": "action1_software_inventory_for_endpoint",
  "arguments": {
    "endpoint_id": "<uuid>",
    "find_by_name": "chrome"
  }
}
```

### `action1_recurring_schedules`

List recurring automations with optional filters: `active_only` drops
paused or disabled schedules, `template_id` matches the first action's
template, and `group_id_substring` matches the target group IDs.

```jsonc
{
  "tool": "action1_recurring_schedules",
  "arguments": { "active_only": true, "template_id": "deploy_update" }
}
```

### `action1_audit_log_search`

Time-range and substring search over the audit log. `from_time` /
`to_time` take `YYYY-MM-DD_HH-MM-SS` (UTC) or ISO-8601 and are also sent to
Action1 as `timefrom` / `timeto`. The substring filters match the user
name, the event name (`Login`, `View Report`, `POST`, ...) and the affected
object (name, URL or description), case-insensitively: `user_substring`,
`event_type_substring` and `target_substring`. One call scans a
bounded number of upstream pages; when it stops early it returns
`has_more: true` and a `next_cursor` that continues the scan.

```jsonc
{
  "tool": "action1_audit_log_search",
  "arguments": {
    "from_time": "2026-04-01T00:00:00Z",
    "user_substring": "admin",
    "event_type_substring": "login",
    "limit": 100
  }
}
```

Requires the `view_audit` permission on the API key role; returns a graceful
403 otherwise.

### `action1_report_export`

Resolve a report by name (or pass a UUID) and return rows or fetch the CSV
export.

```jsonc
// JSON rows
{
  "tool": "action1_report_export",
  "arguments": { "report": "Installed Software", "format": "json", "limit": 1000 }
}

// CSV
{
  "tool": "action1_report_export",
  "arguments": { "report": "Installed Software", "format": "csv" }
}
```

### `action1_cve_remediation_plan`

**Read-only** correlation between vulnerabilities and the updates that fix
them. Returns a plan as `[{ cve, affected_endpoints, candidate_packages,
correlation }]`. With `correlation: "cve"` the packages (`id`, `version`)
are the updates Action1 lists for that CVE; with
`correlation: "endpoint_missing_updates"` Action1 listed none, and the
packages are all missing updates of the affected endpoints. Hand the plan
to `action1_deploy_update` to act on it. Pass `cve_id` for one CVE or
`endpoint_id` for one endpoint (one of the two is required); `max_items`
caps the plan entries (default 50). With `cve_id` every affected endpoint
is read; `affected_endpoints` lists them up to a fixed cap. When the plan
leaves something out (more vulnerabilities than `max_items` on the
endpoint, more affected endpoints than listed), the result has
`truncated: true` and a `warning` saying what is missing.

```jsonc
{
  "tool": "action1_cve_remediation_plan",
  "arguments": { "cve_id": "CVE-2025-12345" }
}
```

---

### Endpoint group membership (destructive - guard required)

#### `action1_add_endpoint_to_group` / `action1_remove_endpoint_from_group`

Add or remove a single endpoint to/from an endpoint group. Both POST the spec's
discriminated **array** body to `/endpoints/groups/{org}/{group}/contents` - there
is no DELETE verb and no `/contents/{id}` sub-path:

- add → `[{ "method": "POST", "data": { "endpoint_id": "<uuid>", "type": "Endpoint" } }]`
- remove → `[{ "method": "DELETE", "endpoint_id": "<uuid>" }]` _(spec shape; not yet live-verified - see docs/GOTCHAS.md)_

Args: `group_id`, `endpoint_id` (UUID), plus the usual `confirm` / `dry_run`.
Add is idempotent (observed live); the remove shape follows the spec but has not yet been verified against a live tenant - see docs/GOTCHAS.md. (These replace the former generated `action1_modify_group_membership`,
which could only add.)

#### `action1_raw_request` (escape hatch)

Generic passthrough to any Action1 API path when no dedicated tool exists.
Arguments: `method` (`GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`),
`path` (starting with `/`, relative to `ACTION1_BASE_URL`), optional
`query` (an object of query parameters) and `body` (for non-GET methods).
`GET`/`HEAD` run free; `POST`/`PUT`/`PATCH`/`DELETE` require the full destructive
guard (`ACTION1_ALLOW_DESTRUCTIVE` + `confirm:"YES"` + `dry_run`) and, as
account operations, `ACTION1_ALLOW_ACCOUNT_OPS=true`. Bypasses
per-tool input schemas - prefer a dedicated tool when one exists.

#### Setting a custom endpoint attribute

`action1_update_endpoint` accepts an arbitrary body, including Action1's
`custom:<name>` convention:

```json
{ "name": "WKS-42", "comment": "finance laptop", "custom:AssetTag": "ASSET-0001" }
```

---

## Auto-generated tools

Every remaining Action1 API operation is exposed as `action1_<operationId>`.
Examples:

- `action1_list_endpoint_groups` - list endpoint groups.
- `action1_create_endpoint_group` - create endpoint group (destructive).
- `action1_list_roles` - list roles.
- `action1_list_logs` - fetch the activity log.
- `action1_get_org_subscription_usage` - usage statistics (may 403
  depending on role).

Patterns:

- **Path params** (e.g. `endpoint_id`, `cve_id`) are required and validated
  as strings.
- **Query params** are typed from the spec, including enums defined by
  reference (`status`, `reboot_required`, `level`, ...). Date-time
  parameters (`timefrom`, `timeto`) take `YYYY-MM-DD_HH-MM-SS` (UTC) or
  ISO-8601 and are sent in the Action1 format.
- **Bodies** for POST/PUT/PATCH are passed as a generic `body` object - see
  the tool description for the schema name. Use
  `action1_get_action_template` and the official Swagger UI at
  <https://app.eu.action1.com/apidocs/> to figure out the body shape.
- **`auto_paginate: true`** on tools whose backing endpoint takes
  `limit` + `from` walks pages until `limit` or the response size budget;
  `has_more` / `next_cursor` say whether and where to continue.
- **`confirm` + `dry_run`** are injected automatically on every destructive
  generated tool.

The generator's source of truth is `src/codegen/spec/openapi.json`. When
Action1 ships a new API version, regenerate (`npm run codegen`) and review
the diff.

---

## Common patterns

### Find which endpoints need a specific patch

```text
1. action1_list_endpoints              → list of endpoint ids
2. action1_list_missing_updates        → per endpoint, find {id, name} of the patch
3. action1_endpoint_groups_resolve     → optional: target by group instead of by ep
4. action1_deploy_update (dry_run)     → preview the deploy payload
5. action1_deploy_update (confirm=YES) → actually deploy
6. action1_wait_for_automation         → wait for completion
```

### Triage offline endpoints

```text
1. action1_list_endpoints              → all endpoints with status + last_seen
2. Filter client-side: status="Disconnected" or last_seen_age_minutes > 60
3. Per offline endpoint:
   - action1_get_endpoint               → freshest connectivity check
   - action1_audit_log_search target=<id> → recent activity
```

### Patch an entire group of Windows hosts (CVE-driven)

```text
1. action1_cve_remediation_plan cve_id=CVE-…   → read-only plan
2. Inspect candidate_packages for accuracy
3. action1_endpoint_groups_resolve query="windows-servers"  → group_id
4. POST a single policy_instance with endpoints=[{id: <group>, type: "EndpointGroup"}]
   either via action1_execute_and_wait mode="template" or via the auto-generated
   action1_create_automation_instance (after dry_run preview).
```

More end-to-end recipes in [`EXAMPLES.md`](EXAMPLES.md).

---

## Resources (`action1://`)

Resources are read-only context that an MCP host can pre-fetch on connect
or that an agent can read with `resources/read`. They are intended for
"static" or "snapshot" data - not for triggering actions.

| URI | What it returns |
|---|---|
| `action1://me` | The authenticated user record (`GET /me`). Includes role + permission list. Read this first to know which tool families will 403 with the current API key. |
| `action1://orgs` | All visible organizations (`GET /organizations`). |
| `action1://templates` | Action template catalog (`GET /automations/action-templates`). |
| `action1://reports` | Report catalog (`GET /reports/all`). Pair with `action1_report_export` to run a chosen report. |
| `action1://endpoints/{orgId}` | Live endpoint snapshot (`GET /endpoints/managed/{orgId}`). Pass `default` to use `ACTION1_ORG_ID`. |
| `action1://groups/{orgId}` | Endpoint-group catalog for the org (`GET /endpoints/groups/{orgId}`). Pass `default` to use `ACTION1_ORG_ID`. |
| `action1://vulnerabilities/{orgId}` | Org-wide CVE rollup (`GET /vulnerabilities/{orgId}`). May 403 if the role lacks `view_vulnerabilities`. Pass `default` to use `ACTION1_ORG_ID`. |

How a host invokes them:

```jsonc
// resources/list  → returns the static URIs above
// resources/templates/list → returns the {orgId}-templated URIs
// resources/read with uri="action1://me" → returns the JSON body
{
  "method": "resources/read",
  "params": { "uri": "action1://endpoints/default" }
}
```

In Claude Desktop / Claude.ai these surface as "drag-attachable" pieces
of context; in Claude Code you can `@`-mention them.

---

## Slash-prompts

Prompts are user-triggered workflows. Each one expands into a single
prompt message that walks Claude through a multi-step recipe using the
existing tools. They are deliberately conservative - every destructive
step stays in `dry_run` until you explicitly say go.

| Command | Args | Outline |
|---|---|---|
| `/patch-windows-fleet` | `group_query` | Resolve group → list missing updates → preview deploy → wait for confirm → execute. |
| `/audit-vulnerabilities` | `top_n?` | Read `action1://vulnerabilities/default` → rank → build remediation plan via `action1_cve_remediation_plan` → present a Markdown table, no execution. |
| `/triage-offline-endpoints` | `stale_minutes?` | Read `action1://endpoints/default` → filter by status / last_seen age → top-5 deep-dive via `action1_get_endpoint`. |
| `/run-script-fleetwide` | `group_query`, `script_text` | Validate read-only, resolve group, dry-run, wait for go, execute via `action1_run_script` with `target_type=EndpointGroup` and `os`. |
| `/software-inventory-sweep` | `software_name` | Per endpoint, call `action1_software_inventory_for_endpoint` with the substring. |
| `/check-my-permissions` | - | Read `action1://me` and report which tool families will 403 with the current role. |

How a host invokes them:

```jsonc
// prompts/list → returns the prompt names + arg schemas
// prompts/get with name="patch-windows-fleet" → returns the prompt body
{
  "method": "prompts/get",
  "params": {
    "name": "patch-windows-fleet",
    "arguments": { "group_query": "marketing-laptops" }
  }
}
```

In Claude Code these surface as `/`-commands; in Claude Desktop they
appear in the prompts menu.

---

## Output formatting

Tools that return `{items: [...]}` accept an optional
`response_format: "markdown"` (default) or `response_format: "json"`. The
default Markdown renderer humanises Action1 timestamps
(`YYYY-MM-DD_HH-MM-SS UTC` form), escapes Markdown-active characters in
cell values (defence against link/HTML injection in cell content), and
caps the table at ~25 KB of text. Nothing is dropped silently: columns
that do not fit the table are named in a `Columns not shown` line, rows
that do not fit are counted (paginated tools instead end the page there
and move `next_cursor`), and every other top-level field (`count`,
`total`, `has_more`, the full `next_cursor`, `note`, warnings) is
printed as a `key: value` line below the table.

```jsonc
{
  "tool": "action1_list_organizations",
  "arguments": { "response_format": "markdown" }
}

{
  "tool": "action1_list_organizations",
  "arguments": { "response_format": "json" }
}
```

Note: a separate `format: "json" | "csv"` parameter exists ONLY on
`action1_report_export` to choose between row data and the export-blob
endpoint - that is unrelated to `response_format`.

---

## Cancellation

The server honours the MCP host's cancellation (`notifications/cancelled`
on stdio, a closed connection on HTTP) for every tool and every resource
read: the request's signal is attached centrally to each Action1 call, so
the in-flight HTTP request aborts and no further page of a walk (list,
search, summary, export, `auto_paginate=true`) is fetched. The polling
loops of `action1_wait_for_automation` and `action1_execute_and_wait`
stop within one polling interval. An action that Action1 already started
keeps running on the endpoint.

---

## Logging

The server emits structured JSON-line logs to **stderr** with auto-redaction
for `Bearer …`, `api-key-…`, and any property whose key looks sensitive.
Configurable via:

- `ACTION1_LOG_LEVEL` env var (`debug` / `info` / `notice` / `warning` /
  `error` / `critical` / `alert` / `emergency`). Default `info`.

The server does not offer the MCP `logging` capability, so hosts cannot
change the level at runtime; change the env var and restart. Every tool
call writes one `tool_call` line; guarded operations write
`destructive_*` audit lines (see
[`SECURITY.md`](SECURITY.md#logging-and-audit-events)).
