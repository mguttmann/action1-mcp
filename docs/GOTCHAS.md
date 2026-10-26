# Action1 API gotchas

## Endpoint group membership: one POST does both add and remove

`POST /endpoints/groups/{org}/{group}/contents` is add **and** remove. The body is
an **array** of items discriminated by a `method` field
(`EndpointGroupContentsPayload` in the pinned spec):

- add → `[{ "method": "POST", "data": { "endpoint_id": "<uuid>", "type": "Endpoint" } }]`
- remove → `[{ "method": "DELETE", "endpoint_id": "<uuid>" }]`

There is **no** DELETE verb and **no** `/contents/{endpointId}` sub-path. Wrong
field names (`action`, `add`/`remove`, `items`, `endpoints`, `members`, `join`)
return `400 "Property name 'X' is invalid or cannot be set"`.

### Spec-vs-live divergence (unverified)

A live add was observed to also accept a bare object `{ "id": "<uuid>", "type":
"Endpoint" }` (field `id`, not array, not `endpoint_id`). The curated tools send
the **spec** array shape. The array remove shape is **not yet live-proven** -
PSAction1 also leaves the per-member remove body to the caller. If a live smoke
test 400s, capture the real body from the web console network tab and patch
`src/payloads/groupContents.ts`.

**Deferred smoke checklist:** create a throwaway group → add a test endpoint →
remove it → delete the group, against a non-production org with
`ACTION1_ALLOW_DESTRUCTIVE=true`.

## Custom endpoint attributes

Set via `PATCH /endpoints/managed/{org}/{endpoint}` (the `action1_update_endpoint`
tool) with a `custom:<name>` key, e.g. `{ "custom:AssetTag": "ASSET-0001" }`.

## Endpoints the curated tools use outside the pinned spec

Two paths that curated tools call are not in the pinned OpenAPI spec. They are
listed in `src/codegen/spec/known-undocumented-endpoints.json`;
`tests/unit/curatedPaths.test.ts` fails if a curated tool starts using another
undocumented path, and `npm run spec:check` reports whether a listed path shows
up in the live spec.

### `POST /policies/instances/{orgId}` (Windows run-now)

`action1_run_powershell`, `action1_run_script` (Windows branch),
`action1_reboot_endpoint`, the deploy / uninstall / data-collection tools and
`action1_execute_and_wait` (Windows) post to `/policies/instances/{org}`. The spec
only documents `/automations/instances/{orgId}`; `/policies/...` is the older
name that PSAction1 still uses. It is not a guess: the live smokes in
`TESTING.md` (rows 12 and 14) ran Windows scripts through this path, and the
macOS payload is known to need the documented `/automations/instances` path
(see `src/payloads/macOsBash.ts`). Moving the Windows tools to the documented
path is the long-term fix, but it changes the request of the most destructive
tools and needs a live re-test against a sacrificial endpoint first, so it is
not done blind. If Action1 retires the alias, these tools fail with a 404 while
macOS keeps working; switch the path in `src/tools/execution.ts` and
`src/tools/workflows.ts` and re-run the smokes.

### `GET /endpoints/managed/{orgId}/{endpointId}/vulnerabilities` (unverified)

`action1_list_vulnerabilities` reads per-endpoint vulnerabilities from this
path. It is not in the spec, and the only live observation (`TESTING.md` row
8) was a 403 from a key without the vulnerabilities permission, so it is not
proven that the path returns data. The documented equivalent is
`GET /vulnerabilities/{orgId}?endpoint_id=<id>` (`action1_list_org_vulnerabilities`
with `endpoint_id`). `action1_cve_remediation_plan` (with `endpoint_id`) uses
the documented list and falls back to this path only when that answers 404.

## Record shapes: spec first, assumed names second

Curated tools read Action1 records through `src/spec/entities.ts`, by the
field names and enum values of the pinned spec (for example
`reboot_required: "Yes"`, audit events with `user_name`, `event`,
`object_name` and `timestamp` in `YYYY-MM-DD_HH-MM-SS`, installed software
under `fields.Name`, the automation status `Warning`). Each reader also
accepts the name the tools assumed before (`yes`, `user`, `event_type`,
`time`, top-level `name`, `Failed`). A read-only live check on
2026-10-26 found the spec shape for every record it covered and none of
the legacy names; audit events were not covered
([TESTING](../TESTING.md#live-shape-check-2026-10-26)). The legacy
fallbacks stay because none of them can shadow a spec field the live
records carry. `npm run live:shapes` (see `TESTING.md`) repeats the
check without exposing record values.

## Deploy update version `Latest` (unverified)

`action1_deploy_update` sends each `updates[]` entry as
`{ "<package_id>": "<version>" }` in the `deploy_update` params
(`DeployUpdateSpecified.packages`), unchanged. The spec describes that
value only as "Update version to be deployed"; it documents no empty
string for "newest". It does list `Latest` as the only version of
repository-package missing updates, and the live vulnerability rows
carry `available_updates[].version: "Latest"` for Windows updates, which
`action1_cve_remediation_plan` hands on as a candidate. Whether a deploy
with `Latest` (or with an empty string) succeeds has not been tried: it
needs a real deploy against a test endpoint.
