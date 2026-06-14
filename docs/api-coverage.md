# API Coverage

This document maps every operation in the Action1 OpenAPI spec to a tool
exposed by this MCP server. The mapping is generated from the same pinned
spec used by the code generator (`src/codegen/spec/openapi.json`, SHA
pinned in `src/codegen/spec/openapi.sha256`).

## Summary

| Metric | Value |
|---|---:|
| Spec version | 3.1.0 (Action1 API 3.1.0, EU bundle) |
| Pinned spec SHA-256 | `af75f1cc665b8d0ed2f6ed1992b1161f68a36c35013a2a1b168854185fc0eaed` |
| Operations in spec | **140** |
| Operations covered | **140 / 140 (100 %)** |
| Auto-generated tools (`src/tools/generated/`) | 133 |
| Operations replaced by curated infrastructure (no separate tool) | 6 (1 explicit skip `oauth2_token` + 5 curated-name conflicts: `endpoints_managed`, `endpoints_managed_endpointId`, `organizations_get`, `actions_templates_get`, `actions_templates_templateId_get` — see [`_coverage_table.md`](_coverage_table.md) "skipped (curated)" rows) |
| Curated tools (incl. 6 workflow wrappers) | 33 |
| High-level workflow wrappers | 6 |
| **Total tools** | **166** |

Six operations have **no** standalone auto-generated tool:

- `oauth2_token` (`POST /oauth2/token`) is the only **explicitly skipped**
  operation (`SKIP_OPERATION_IDS` in `src/codegen/curated-overrides.ts`).
  It's invoked transparently by every other tool via `TokenProvider`.
  Exposing it as a tool would let an agent bypass the proactive 5-minute
  refresh, in-flight deduplication, and refresh_token fallback that the
  provider implements.
- Five further operations are dropped at codegen-time because a curated
  tool of the same generated name already owns the semantics:
  `endpoints_managed`, `endpoints_managed_endpointId`, `organizations_get`,
  `actions_templates_get`, `actions_templates_templateId_get`. See the
  `skipped (curated)` rows in [`_coverage_table.md`](_coverage_table.md)
  for the exact paths and the curated tools that replace them.

`POST /automations/instances/{orgId}` (operationId
`policies_instances_orgId_post`) **is** auto-generated as
`action1_create_automation_instance` (verb-first generated name). The 33 curated tools (27 thematic + 6 wrappers, e.g.
`action1_run_powershell`, `action1_deploy_update`,
`action1_reboot_endpoint`) coexist with that generated tool: the curated
ones are the safe default for the common case (single endpoint, single
action, payload quirks pre-encoded), the generated one is available for
the long-tail variants (multi-action batches, MatchingFilters /
UpdateRing scopes, `run_script_id` library scripts, etc.).

## Architecture

Hybrid: a hand-curated layer of "smart" tools that encode payload quirks
and workflow conveniences, plus an auto-generated layer that exposes
every spec operation as a generic `action1_<operationId>` tool, plus six
high-level wrappers.

```
┌──────────────────────────────────────────────────────────────────────┐
│ Curated tools (27) + Workflow wrappers (6)                            │
│ • script execution (Win + Mac + OS-aware), with target_type:Endpoint │
│   or EndpointGroup                                                    │
│ • execute_and_wait (POST + poll + filtered output)                    │
│ • get_endpoint with /general → canonical path + list-fallback         │
│ • CVE remediation plan, audit log search, software inventory, …      │
├──────────────────────────────────────────────────────────────────────┤
│ Auto-generated tools (133, verb-first names)                          │
│ • one tool per spec operation, snake_case input names                 │
│ • shared runtime: pagination, destructive guard, error mapping        │
│ • Action1 OpenAPI 3.1.0, SHA-pinned, regenerable                      │
├──────────────────────────────────────────────────────────────────────┤
│ Shared infrastructure                                                  │
│ • Action1Client (auth, retry, pagination, error mapping)               │
│ • TokenProvider (refresh_token fallback, 5-min proactive refresh)      │
│ • OrgResolver (fuzzy name match, session cache)                        │
│ • Three-layer destructive guard (env + confirm + dry_run)              │
│ • Structured stderr logger with auth-key redaction                     │
│ • Markdown auto-table renderer                                         │
└──────────────────────────────────────────────────────────────────────┘
```

The skip list (`src/codegen/curated-overrides.ts`) only blocks
`oauth2_token`. Curated and auto-generated tools coexist by name (no
collisions; tool names are namespaced as `action1_<operationId>` for
generated and `action1_<verb>_<noun>` for curated).

## High-level workflow wrappers (`src/tools/wrappers/`)

These are not 1:1 with any spec operation; they orchestrate a small
fan-out across multiple endpoints to expose a common workflow as a single
tool.

| Tool | Backed by | Purpose |
|---|---|---|
| `action1_endpoint_groups_resolve` | `GET /endpoints/groups/{orgId}` | Fuzzy lookup of a group by name or UUID. |
| `action1_software_inventory_for_endpoint` | `GET /installed-software/{orgId}/data/{endpointId}` | Per-endpoint installed-software inventory with optional substring filter. |
| `action1_recurring_schedules` | `GET /automations/schedules/{orgId}` | List recurring automations with active-only / template / group filters. |
| `action1_audit_log_search` | `GET /audit/events` | Time-range and substring filter over the audit log. |
| `action1_report_export` | `GET /reports/all` + `/reportdata/{orgId}/{reportId}/{data,export}` | Resolve report by name, return rows or fetch CSV. |
| `action1_cve_remediation_plan` | `GET /vulnerabilities/{orgId}/...` + `/missing-updates` | Read-only correlation between vulnerabilities and available updates. |

## Full mapping table

The auto-generated mapping covers every operation in the spec, in
alphabetical order by path then method. It is regenerated on every
codegen run.

→ See [`_coverage_table.md`](_coverage_table.md) (140 rows).

## Skip list rationale

Maintained in [`src/codegen/curated-overrides.ts`](../src/codegen/curated-overrides.ts).
The list is intentionally minimal:

- **`oauth2_token`** — token issuance is invisible to all callers; handled
  by `TokenProvider` with proactive 5-min refresh, in-flight dedup, and a
  `refresh_token` fallback that survives a temporarily-revoked secret
  without re-exchanging client_credentials. Exposing it as a tool would
  let an agent bypass that machinery.

Note: `policies_instances_orgId_post` (POST /automations/instances/{orgId})
was previously skipped on the assumption that the curated tools fully
covered it. Audit feedback showed that the spec-defined payload supports
EndpointGroup targets, multi-action batches, `MatchingFilters` /
`UpdateRing` scopes, and library-script references — capabilities the
narrow curated builders did not expose. The operation is now
auto-generated, and the curated tools have been extended with a
`target_type` parameter for the Endpoint / EndpointGroup distinction.

## Verification

- `npm run codegen` is idempotent: re-running on the same pinned spec
  produces byte-identical `src/tools/generated/index.ts`.
- `tests/unit/specSha.test.ts` fails the build if `openapi.json` SHA-256
  ever diverges from `openapi.sha256` (catches accidental edits or
  upstream spec drift).
- The CI workflow at `.github/workflows/ci.yml` enforces a
  codegen-roundtrip check: every PR must regenerate cleanly with no
  uncommitted diff.
- `npx @modelcontextprotocol/inspector --cli ... --method tools/list`
  returns the full curated + auto-generated set with annotations,
  inputSchemas, and (where applicable) outputSchemas.
