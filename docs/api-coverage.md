# API Coverage

This document maps every operation in the Action1 OpenAPI spec to a tool
exposed by this MCP server. The mapping is generated from the same pinned
spec used by the code generator (`src/codegen/spec/openapi.json`, SHA
pinned in `src/codegen/spec/openapi.sha256`).

## Summary

| Metric | Value |
|---|---:|
| Spec version | 3.1.0 (Action1 API 3.1.0, EU bundle) |
| Pinned spec SHA-256 | see `src/codegen/spec/openapi.sha256`; snapshot date and stats in [`SOURCE.md`](../src/codegen/spec/SOURCE.md) |
| Operations in spec, generated tool names, curated tools | counted in the header of [`_coverage_table.md`](_coverage_table.md), which `scripts/regenerate-coverage-table.mjs` writes from the spec and the generated index |
| Operations covered | every operation of the pinned snapshot (100 % of that snapshot, not of whatever Action1 serves today; `npm run spec:check` compares the two) |
| Operations without a generated tool | `oauth2_token` (used internally), the operations in `SKIP_OPERATION_IDS`, and operations whose generated name equals a curated tool name; listed as `skipped` / `skipped (curated)` in [`_coverage_table.md`](_coverage_table.md) |
| Operations with a tool that refuses to call Action1 | the two package-upload operations (`action1_init_software_upload`, `action1_upload_software_chunk`): they need request headers and a binary body the server does not send, so the tools return an explanatory error |
| High-level workflow wrappers | see the table below |

Operations without a standalone generated tool fall into two groups. The
generated [`_coverage_table.md`](_coverage_table.md) is the authoritative
list:

- **Explicit skips** in `SKIP_OPERATION_IDS`
  (`src/codegen/curated-overrides.ts`), each with a comment. `oauth2_token`
  (`POST /oauth2/token`) is invoked transparently by every other tool via
  `TokenProvider`; exposing it would let an agent bypass the proactive
  refresh, in-flight deduplication and refresh_token fallback. The group
  membership operation (`endpoints_groups_groupId_contents_post`) is
  replaced by the curated `action1_add_endpoint_to_group` and
  `action1_remove_endpoint_from_group`.
- **Name conflicts**: the code generator (`src/codegen/generate.ts`) scans
  the curated tool names and drops a generated tool whose name equals one
  of them, for example `endpoints_managed` (curated
  `action1_list_endpoints`) and `organizations_get` (curated
  `action1_list_organizations`). The header of
  `src/tools/generated/index.ts` states how many operations were dropped
  this way.

`POST /automations/instances/{orgId}` (operationId
`policies_instances_orgId_post`) **is** auto-generated as
`action1_create_automation_instance` (verb-first generated name). The
curated tools (e.g. `action1_run_powershell`, `action1_deploy_update`,
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
│ Curated tools + workflow wrappers                                    │
│ • script execution (Win + Mac + OS-aware), with target_type:Endpoint │
│   or EndpointGroup                                                    │
│ • execute_and_wait (POST + poll + filtered output)                    │
│ • get_endpoint with /general → canonical path + list-fallback         │
│ • CVE remediation plan, audit log search, software inventory, …      │
├──────────────────────────────────────────────────────────────────────┤
│ Auto-generated tools (verb-first names)                               │
│ • one tool per spec operation, snake_case input names                 │
│ • shared runtime: pagination, destructive guard, error mapping        │
│ • Action1 OpenAPI 3.1.0, SHA-pinned, regenerable                      │
├──────────────────────────────────────────────────────────────────────┤
│ Shared infrastructure                                                  │
│ • Action1Client (auth, retry, pagination, error mapping)               │
│ • TokenProvider (refresh_token fallback, 5-min proactive refresh)      │
│ • Three-layer destructive guard (env + confirm + dry_run)              │
│ • Structured stderr logger with auth-key redaction                     │
│ • Markdown auto-table renderer                                         │
└──────────────────────────────────────────────────────────────────────┘
```

Curated and generated tools share one namespace (`action1_<verb>_<noun>`).
A generated name that would collide with a curated one is dropped by the
generator, which also resolves collisions among generated names and
fails on any duplicate it cannot resolve, so a name never refers to two
tools.

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

→ See [`_coverage_table.md`](_coverage_table.md).

## Skip list rationale

Maintained in [`src/codegen/curated-overrides.ts`](../src/codegen/curated-overrides.ts),
with a reason next to each entry. The list is intentionally short: an
operation is skipped only when a generated tool would be wrong or unsafe
(token issuance) or could not express the spec's request (the array body
of the group membership operation).

`policies_instances_orgId_post` (POST /automations/instances/{orgId}) is
deliberately **not** skipped: its spec payload supports EndpointGroup
targets, multi-action batches, `MatchingFilters` / `UpdateRing` scopes and
library-script references, which the curated builders do not expose.

## Verification

- `npm run codegen` is idempotent: re-running on the same pinned spec
  produces byte-identical `src/tools/generated/index.ts`.
- `tests/unit/specSha.test.ts` fails the build if `openapi.json` SHA-256
  ever diverges from `openapi.sha256` (catches accidental edits of the
  committed snapshot). It cannot see upstream changes: that is the job of
  `npm run spec:check` and the weekly `.github/workflows/spec-drift.yml`
  job, which compare the live Swagger UI spec with the pin.
- The CI workflow at `.github/workflows/ci.yml` enforces a
  codegen-roundtrip check: every PR must regenerate cleanly with no
  uncommitted diff.
- `npx -y @modelcontextprotocol/inspector@2.12.0 --cli ... --method tools/list`
  returns the full curated + auto-generated set with annotations,
  inputSchemas, and (where applicable) outputSchemas.
