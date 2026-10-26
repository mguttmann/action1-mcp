# Examples

End-to-end recipes for common Action1 RMM workflows. Copy them as starting
points; substitute your endpoint / group / org IDs.

Every recipe starts with the model already connected to `action1-mcp-server` via
your MCP host. Tool inputs are JSON; how you express them in chat depends
on the host (Claude Code understands `/tool` invocations; Claude Desktop
inline-renders the tool list; Claude.ai shows them in the connector).

## 1. List all online macOS endpoints

> "List every macOS endpoint that has been online in the last 5 minutes."

```jsonc
{ "tool": "action1_list_endpoints", "arguments": { "page_size": 200, "limit": 1000 } }
```

The model filters the returned items client-side using the `OS`,
`platform`, `status`, and `last_seen` fields.

For a more targeted call:

```jsonc
{
  "tool": "action1_search_endpoints",
  "arguments": { "query": "mac", "fields": ["os"], "limit": 50 }
}
```

## 2. Run a read-only PowerShell on one Windows endpoint and get the output

> "On endpoint X, tell me the OS version and the time of the last reboot."

```jsonc
{
  "tool": "action1_execute_and_wait",
  "arguments": {
    "endpoint_id": "<uuid>",
    "mode": "script",
    "script_text": "(Get-ComputerInfo).OsName; (Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime",
    "timeout_seconds": 120,
    "dry_run": false,
    "confirm": "YES"
  }
}
```

`Get-Date`, `Get-ComputerInfo`, `Get-CimInstance`, `Get-Service`,
`Get-Process`, `Get-WinEvent` are all read-only - no `Set-*` /
`Stop-*` / `New-*` / `Remove-*` cmdlets.

## 3. Same on macOS

```jsonc
{
  "tool": "action1_execute_and_wait",
  "arguments": {
    "endpoint_id": "<mac-uuid>",
    "mode": "script",
    "script_text": "sw_vers; uptime; df -h /",
    "timeout_seconds": 120,
    "dry_run": false,
    "confirm": "YES"
  }
}
```

`echo`, `hostname`, `uname`, `sw_vers`, `system_profiler`, `pmset -g`,
`df`, `ps`, `ls`, `cat`, `lpstat`, `dscl . -read`, `ifconfig`,
`networksetup -listallhardwareports` are all read-only.

## 4. Find every endpoint missing a specific Chrome update

> "Which endpoints still need to deploy Chrome 126.0.6478.115?"

```text
1. action1_list_endpoints                 → list of all endpoint ids
2. For each (or paginated):
     action1_list_missing_updates         → check whether the package id is in items
3. Sort / collect by endpoint name and display.
```

The model walks the list itself. For 500+ endpoints, ask for a sampled
subset first and then iterate.

## 5. Patch a single endpoint with a specific update

```jsonc
// 1. Find the package id
{
  "tool": "action1_list_missing_updates",
  "arguments": { "endpoint_id": "<uuid>", "limit": 50 }
}

// 2. Preview the deploy
{
  "tool": "action1_deploy_update",
  "arguments": {
    "endpoint_id": "<uuid>",
    "updates": [
      { "package_id": "Google_Google_Chrome_1570243626751_builtin",
        "version": "126.0.6478.115" }
    ],
    "reboot_after": "if_required"
  }
}

// 3. Actually deploy
{
  "tool": "action1_deploy_update",
  "arguments": {
    "endpoint_id": "<uuid>",
    "updates": [
      { "package_id": "Google_Google_Chrome_1570243626751_builtin",
        "version": "126.0.6478.115" }
    ],
    "reboot_after": "if_required",
    "dry_run": false,
    "confirm": "YES"
  }
}
```

## 6. Patch a whole group of endpoints in one shot

```jsonc
// 1. Find the group
{
  "tool": "action1_endpoint_groups_resolve",
  "arguments": { "query": "marketing-laptops" }
}
// returns { matches: [{ id: "<group-uuid>", name: "Marketing Laptops" }], ... }

// 2. Preview a deploy targeting the group
{
  "tool": "action1_deploy_update",
  "arguments": {
    "endpoint_id": "<group-uuid>",
    "target_type": "EndpointGroup",
    "updates": [{ "package_id": "<pkg-id>", "version": "<version>" }]
  }
}
```

`target_type: "EndpointGroup"` is supported on these curated execution
tools: `action1_run_powershell`, `action1_run_bash_macos`,
`action1_run_script` (with `os: "windows"` or `os: "macos"`, required for
groups), `action1_reboot_endpoint`, `action1_deploy_update`,
`action1_deploy_package`, `action1_uninstall_program`,
`action1_run_data_collection`. `action1_execute_and_wait` targets a single
endpoint only.

## 7. Build a CVE remediation plan

> "Build me a plan to remediate CVE-2024-12345 across the fleet."

```jsonc
{
  "tool": "action1_cve_remediation_plan",
  "arguments": { "cve_id": "CVE-2024-12345" }
}
```

Returns `{ plan: [{ cve, affected_endpoints: [...], candidate_packages: [...], correlation }] }`.
`correlation: "cve"` means the packages are the updates Action1 lists for
the CVE. The plan is **read-only** - pass `candidate_packages[*].id` and
`version` into `action1_deploy_update` to act on it.

## 8. Audit who changed what last week

API writes appear in the audit log as `POST`, `PATCH` or `DELETE` events;
the target filter matches the affected object, its URL or the description.

```jsonc
{
  "tool": "action1_audit_log_search",
  "arguments": {
    "from_time": "2026-04-26T00:00:00Z",
    "to_time": "2026-05-03_00-00-00",
    "event_type_substring": "post",
    "target_substring": "automations"
  }
}
```

Requires the `view_audit` permission on the API credential's role.

## 9. Software inventory for a single endpoint

```jsonc
{
  "tool": "action1_software_inventory_for_endpoint",
  "arguments": { "endpoint_id": "<uuid>", "find_by_name": "chrome" }
}
```

## 10. Triage: which endpoints look offline?

```jsonc
{
  "tool": "action1_list_endpoints",
  "arguments": { "page_size": 500, "limit": 5000 }
}
```

The model filters client-side using `status` and `last_seen` (the
parser handles Action1's `YYYY-MM-DD_HH-MM-SS` UTC format). Then for
suspicious entries:

```jsonc
{ "tool": "action1_get_endpoint", "arguments": { "endpoint_id": "<uuid>" } }
```

The response includes `connectivity.online` and a human-readable
`connectivity.reason`.

## 11. Run a script library item by id

> "Run the 'Disable Telemetry' script in our Action1 library on group X."

```jsonc
// 1. Find the script id
{ "tool": "action1_list_scripts", "arguments": {} }

// 2. Use the auto-generated POST to /automations/instances/{org} for the
//    library-script template. Body shape comes from the spec - preview
//    first, then submit with confirm.
{
  "tool": "action1_create_automation_instance",
  "arguments": {
    "body": {
      "name": "Disable Telemetry",
      "retry_minutes": 1440,
      "endpoints": [{ "id": "<group-uuid>", "type": "EndpointGroup" }],
      "actions": [{
        "name": "Run Script",
        "template_id": "run_script",
        "params": { "run_script_id": "<script-uuid>" }
      }]
    },
    "dry_run": true
  }
}
```

Use the auto-generated tool when the curated layer doesn't fit (multi-action
batches, library scripts, MatchingFilters scope deploys, UpdateRing template).

## 12. Generate a CSV report

```jsonc
// 1. Pick a report
{ "tool": "action1_report_export", "arguments": { "report": "Installed Software", "format": "csv" } }

// 2. Or list reports first
{ "tool": "action1_list_reports", "arguments": {} }
```

## 13. Reboot a sacrificial endpoint (with all gates)

```jsonc
// Server env: ACTION1_ALLOW_DESTRUCTIVE=true
{
  "tool": "action1_reboot_endpoint",
  "arguments": {
    "endpoint_id": "<sacrificial-uuid>",
    "dry_run": false,
    "confirm": "YES"
  }
}

// Then wait for it to come back
{
  "tool": "action1_wait_for_automation",
  "arguments": {
    "instance_id": "<id-from-previous-call>",
    "timeout_seconds": 900
  }
}
```

## 14. Read your role's permissions before doing anything

> "What permissions do I have on this Action1 instance?"

```jsonc
// Resource read (preferred - most hosts pre-fetch this)
{ "method": "resources/read",
  "params": { "uri": "action1://me" } }

// Or as a slash command (Claude Code / Desktop)
/check-my-permissions
```

Returns the user record with `system_role` and a `roles` URL. The
`/check-my-permissions` prompt expands this into a Markdown report of
which tool families will 403.

## 15. One-click patch via the slash-prompt

> "Patch all the marketing-team Windows machines."

```text
/patch-windows-fleet group_query="marketing"
```

Claude resolves the group, lists missing updates, previews the deploy
in dry-run, shows you the payload, waits for your "go", then deploys
with the destructive guard satisfied.

## 16. Survey vulnerabilities without touching anything

```text
/audit-vulnerabilities top_n=20
```

Reads `action1://vulnerabilities/default`, ranks by severity + endpoint
count, builds a remediation plan via `action1_cve_remediation_plan` -
no execution, just a Markdown table you can act on later.

## Tips for prompting the model

- **Always be specific about the target.** "Reboot the QA jumphost" is
  better than "reboot a server" - the model will (correctly) refuse to
  guess.
- **Ask for `dry_run: true` first** when you're not sure. It returns the
  exact payload the server would send.
- **Use group IDs whenever possible.** Action1 deduplicates and fans
  out internally, and the model only has to track one ID instead of N.
- **Tell the model your constraints.** "Patch only Windows 11 endpoints
  that have been online in the last hour" gives it enough to filter
  before any destructive call.
