# Investigation: HTTP 403 on `/endpoints/managed/{org}/{ep}/general`

## TL;DR

**The path is wrong.** `/general` is **not** a documented Action1 API operation;
it is a UI-routing artifact that appears in the `self` URL of list responses.
The canonical singular detail path per the official Action1 OpenAPI spec is

```
GET /endpoints/managed/{orgId}/{endpointId}
```

(without any trailing `/general`). It returns the same `Endpoint` schema as one
item in `/endpoints/managed/{orgId}` and requires only the `view_endpoints`
permission - the same permission as listing.

The 403 was the API rejecting a non-routed path, not a permission gap. No role
change in the Action1 admin console is required.

## Verdict

(c) We were calling the wrong path. The canonical fetch works as soon as the
trailing `/general` segment is dropped.

This is **not** something the Action1 admin can or should fix by granting a
permission - there is no separate "Endpoint Details" or "Endpoint Inventory"
permission in the Action1 catalog.

## Findings

The Action1 OpenAPI spec (Swagger UI bundle, embedded in the JS asset) defines
exactly six paths under `/endpoints/managed/...`. None of them carries a
`/general` segment:

- `GET /endpoints/managed/{orgId}` - list endpoints
- `GET`, `PATCH`, `DELETE /endpoints/managed/{orgId}/{endpointId}` - get
  a single endpoint, change its name or comment, delete it
- `GET /endpoints/managed/{orgId}/{endpointId}/missing-updates`
- `POST /endpoints/managed/{orgId}/{endpointId}/move` - move the endpoint
  to another organization
- `POST /endpoints/managed/{orgId}/{endpointId}/remote-sessions` - start a
  remote session
- `GET`, `PATCH /endpoints/managed/{orgId}/{endpointId}/remote-sessions/{sessionId}`

The bundled spec is identical for the EU and US instances.

The documented detail operation's spec text reads (verbatim):

> `GET /endpoints/managed/{orgId}/{endpointId}` - *"Getting a specific
> endpoint"* - *"Requires permission: `view_endpoints`. Obtains current
> information about the endpoint with the specified ID."*

The list operation requires the same permission. So if listing works, the
detail call at the canonical path works too.

The official PowerShell module
[PSAction1](https://github.com/Action1Corp/PSAction1) confirms this. The URI
lookup table in `PSAction1.psm1` defines:

```
G_Endpoint = /endpoints/managed/{Org}/{Object_ID}
```

- with no `/general` suffix. PSAction1 ignores the `/general` value emitted
inside `self` URLs and always calls the bare path.

The Action1
[Permissions catalog](https://www.action1.com/documentation/permissions/)
lists exactly three endpoint-related permissions:

| Permission | Covers |
|---|---|
| **View Endpoints** | View endpoints *and* their details (missing updates, vulnerabilities, installed software, automation history). |
| **Manage Endpoints** | Mutating operations on endpoints. |
| **Manage Endpoint Attributes** | Set custom attributes. |

There is no separate "View Endpoint Details" permission. The
[API Credentials docs](https://www.action1.com/api-documentation/api-credentials/)
make it explicit that API keys are role-bound the same way human users are -
no API-only scope to flip.

The `/general` segment is most likely an artifact of the Action1 web console's
tabbed UI ("General" / "Missing Updates" / "Vulnerabilities" / etc., described
on the
[Managed Endpoints](https://www.action1.com/documentation/managed-endpoints/)
documentation page). It survives in the API's HATEOAS `self` URL but does not
correspond to a REST resource.

## Live verification

Against the EU instance with our existing API key:

```
GET /endpoints/managed/{org}/{ep}            -> 200 (Endpoint schema)
GET /endpoints/managed/{org}/{ep}/general    -> 403
```

The 200 response carries every field we need (`id`, `status`, `last_seen`,
`OS`, `platform`, `agent_version`, `online_status`, etc.) - i.e. the same
fields that appear in the list response.

## Resolution applied

`src/client/endpointInfo.ts::fetchEndpointInfo` now calls the canonical path
first. The list-fallback is kept as a defence-in-depth path in case a future
deployment surfaces a different permission boundary (e.g. an API key with
`view_endpoints` revoked but list cached upstream); the structured response
labels the source as `"canonical"` or `"list-fallback"` so callers can tell
which path produced the data.

Tools that previously surfaced `source: "general"` now surface
`source: "canonical"` when the documented path succeeds.

## Sources

- Action1 EU Swagger UI: <https://app.eu.action1.com/apidocs/>
- Action1 US Swagger UI: <https://app.action1.com/apidocs/>
- Permissions catalog:
  <https://www.action1.com/documentation/permissions/>
- API Credentials & roles:
  <https://www.action1.com/api-documentation/api-credentials/>
- Managed Endpoints UI doc (mentions the "General" pane):
  <https://www.action1.com/documentation/managed-endpoints/>
- PSAction1 source (URI table around `PSAction1.psm1` lines 30-66, README
  example around line 219): <https://github.com/Action1Corp/PSAction1>

## Recommendation

Closed by code change. The canonical path is now the primary call; the
list-fallback remains as a safety net but is unnecessary in steady state. No
admin action is required.
