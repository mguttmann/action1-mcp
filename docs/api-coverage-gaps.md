# API coverage gaps

What this server does not do, or does only with a caveat, measured
against the pinned Action1 OpenAPI spec (`src/codegen/spec/openapi.json`)
and the code in this repository. How spec operations map to tools is in
[`api-coverage.md`](api-coverage.md); the Action1 quirks the curated tools
handle are in [`GOTCHAS.md`](GOTCHAS.md).

## Not available

- **Push events.** The pinned spec documents no webhook or event-stream
  endpoint. Follow an action by polling
  (`action1_wait_for_automation`, `action1_execute_and_wait`) and changes
  by reading the audit log (`action1_audit_log_search`,
  `action1_list_audit_events`).
- **Package uploads.** `action1_init_software_upload` and
  `action1_upload_software_chunk` are registered but return an
  explanatory error: Action1's upload needs request headers and a binary
  body that this server does not send. Upload packages in the Action1
  console.
- **Scripts on Linux.** The curated script tools (`action1_run_script`,
  `action1_execute_and_wait` in `script` mode) support Windows PowerShell
  and macOS Bash and refuse other platforms. Action templates and the
  generated automation tools are not limited this way.
- **Bulk endpoints.** Action1 has no batch or transaction endpoint. The
  bulk primitive is an endpoint group: pass `target_type:
  "EndpointGroup"` to the execution tools, and manage groups with
  `action1_endpoint_groups_resolve`, the group tools and
  `action1_add_endpoint_to_group` / `action1_remove_endpoint_from_group`.

## Available with a caveat

- **Undocumented endpoints.** Two curated paths are not in the spec
  (Windows script starts through `POST /policies/instances/{orgId}`, and a
  per-endpoint vulnerability path used only as a fallback). They are
  listed with their verification status in
  `src/codegen/spec/known-undocumented-endpoints.json`; a test fails when
  a curated tool uses another undocumented path.
- **Record shapes.** The curated tools read field names and enum values
  from the spec (`src/spec/entities.ts`) and also accept the names
  assumed before they were bound to the spec. A read-only live check on
  2026-10-26 found the spec shapes for every record it covered; audit
  events are not verified yet
  ([`TESTING.md`](../TESTING.md#live-shape-check-2026-10-26)). The
  tenant owner can repeat it with the read-only `npm run live:shapes`
  ([`TESTING.md`](../TESTING.md#live-shape-check-owner-only)).
- **Spec freshness.** Generated tools follow the pinned spec. A weekly
  workflow (`npm run spec:check`) reports when Action1 serves a different
  spec; adopting it is a deliberate change with `npm run codegen`.
- **Live validation.** Which destructive tools have never run against a
  live tenant is listed under
  [Validation status](../README.md#validation-status) in the README.
