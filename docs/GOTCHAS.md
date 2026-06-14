# Action1 API gotchas (repo-internal)

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
the **spec** array shape. The array remove shape is **not yet live-proven** —
PSAction1 also leaves the per-member remove body to the caller. If a live smoke
test 400s, capture the real body from the web console network tab and patch
`src/payloads/groupContents.ts`.

**Deferred smoke checklist:** create a throwaway group → add a test endpoint →
remove it → delete the group, against a non-production org with
`ACTION1_ALLOW_DESTRUCTIVE=true`.

## Custom endpoint attributes

Set via `PATCH /endpoints/managed/{org}/{endpoint}` (the `action1_update_endpoint`
tool) with a `custom:<name>` key, e.g. `{ "custom:AssetTag": "JW-00421" }`.
