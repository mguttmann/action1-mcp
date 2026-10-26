# Troubleshooting

Common failure modes and how to fix them.

## Setup / install

### `npm run build` fails with `Cannot find module @modelcontextprotocol/server`

You skipped `npm install`. Run it from the repo root:

```bash
npm install
npm run build
```

### `tests/unit/specSha.test.ts` fails

`src/codegen/spec/openapi.json`, `openapi.sha256` and the generated tools
no longer match: someone edited the spec or the SHA without regenerating.
Do not edit the spec by hand; follow the refresh workflow in
[`src/codegen/spec/SOURCE.md`](../src/codegen/spec/SOURCE.md) and
[`CONTRIBUTING.md`](CONTRIBUTING.md#re-running-codegen).

This test never contacts Action1. Whether Action1 serves a different spec
is reported by `npm run spec:check`.

### TypeScript build errors after a fresh clone

```bash
rm -rf dist node_modules
npm install
npm run build
```

If the error mentions `@modelcontextprotocol/server` types, the SDK update
broke something. Open an issue with the full TypeScript error and the
output of `npm ls @modelcontextprotocol/server`.

## Runtime

### `Invalid or missing environment configuration` / `... is not set.`

Something is missing or invalid in the environment. At start-up the
server prints one line per problem (`action1-mcp: ACTION1_CLIENT_SECRET is
not set.`, `action1-mcp: PORT is invalid: ...`) followed by a JSON
`fatal` log line, and exits with code 1. Empty values count as unset.
Required minimum:

```
ACTION1_BASE_URL=https://app.eu.action1.com/api/3.0
ACTION1_CLIENT_ID=api-key-...@action1.com
ACTION1_CLIENT_SECRET=...
```

`ACTION1_ORG_ID` is optional only if every tool call passes `org_id`
explicitly. In practice you want it set. With `ACTION1_ALLOWED_ORG_IDS`
set, `ACTION1_ORG_ID` must be on that list.

Typos in the boolean switches (`ACTION1_ALLOW_DESTRUCTIVE=ture`) and
out-of-range numbers (`PORT`, the timeout and minute settings) also abort
startup, on purpose.

### Every tool returns `HTTP 401`

The OAuth token exchange is failing. Check:

1. `ACTION1_CLIENT_ID` and `ACTION1_CLIENT_SECRET` match what's in the
   Action1 console (no trailing whitespace).
2. The credential isn't expired or disabled.
3. `ACTION1_BASE_URL` matches the region of the credential. EU credentials
   on `app.action1.com` (US) silently 401.

The structured logger emits `refresh_token_failed_falling_back_to_client_credentials`
and `http_request_handler_failed` events on stderr - read those for the
exact response body Action1 returned.

### Some tools return `HTTP 403` with a `Forbidden` hint

The API credential's role lacks the permission for that operation.
[`permissions.md`](permissions.md) lists the permission of every
operation and tool, generated from the Action1 spec. For example, the
vulnerability tools need `view_vulnerabilities` and the audit tools
`view_audit`.

The fix is to update the credential's role in the Action1 console, not the
MCP server. The `action1://me` resource and the `/check-my-permissions`
prompt show what the current role allows.

### `action1_get_endpoint` returns `HTTP 403`

This was a code bug - fixed in v0.2 by switching to the canonical path
(`/endpoints/managed/{org}/{ep}`). If you're still seeing it on the latest
build, your role lacks `view_endpoints`. Verify with
`action1_get_me` (returns the credential's role + permissions).

### `action1_run_bash_macos` reports `"not applicable to Mac platform"`

You're on a stale build. The full ten-field `run_script` payload has
been encoded in `src/payloads/macOsBash.ts` since v0.1. Run
`git pull && npm install && npm run build`. If it still happens on the
latest commit, open an issue with the full request body - it's a real
regression and we need a HAR trace from the Action1 web console to
diff against.

### `action1_run_powershell` returns `at least one valid success exit code must be specified`

Either:

1. You explicitly passed `success_exit_codes: ""` (empty). Don't.
2. Bug in the payload builder. Should not happen - open an issue.

### A destructive call is refused

The error names what is missing:

| Message contains | Fix |
|---|---|
| `ACTION1_ALLOW_DESTRUCTIVE` | The operator must set `ACTION1_ALLOW_DESTRUCTIVE=true` and restart. |
| `Refusing account operation` | Users, roles, `/me`, enterprise, organizations, subscription and `action1_raw_request` writes also need `ACTION1_ALLOW_ACCOUNT_OPS=true`. |
| `Refusing organization` | The organization is not in `ACTION1_ALLOWED_ORG_IDS`; use an allowed one or ask the operator to add it. |
| `ACTION1_ALLOW_ENTERPRISE_OPS` | With `ACTION1_ALLOWED_ORG_IDS` set, a change that is not bound to one allowed organization needs `ACTION1_ALLOW_ENTERPRISE_OPS=true`. |
| `confirm` | Pass `confirm: "YES"` exactly. |

Without `dry_run: false` a destructive tool only returns a preview; that
is not an error.

### `Refusing organization "...": it is not listed in ACTION1_ALLOWED_ORG_IDS`

The server only addresses the organizations in `ACTION1_ALLOWED_ORG_IDS`.
Use one of them, or add the organization to the list and restart.
`action1_raw_request` additionally only reaches documented API paths
while the list is set (`Refusing path ...`).

### `Unrecognized key` validation error

Tool inputs are strict: an unknown or misspelled argument (for example
`confrim`) is rejected instead of being ignored. Use the argument names
from the tool's input schema.

### Tools intermittently fail with `ENOTFOUND` or `EAI_AGAIN`

DNS hiccup. The request never left the server, so the retry layer retries
it automatically with exponential backoff, for reads and mutations alike.
If it fails after retries, your DNS is genuinely broken or
the Action1 API is unreachable from the server - try `dig app.eu.action1.com`
and `curl -I https://app.eu.action1.com/api/3.0/`.

### Long-running automation tools (`wait_for_automation`, `execute_and_wait`) appear to hang

The server polls every 5 seconds (configurable via
`poll_interval_seconds`) and aborts after `timeout_seconds` (default
300). If a tool is stuck:

1. Check the endpoint is actually online:
   `action1_get_endpoint` → `connectivity.online`.
2. Check the instance status manually:
   `action1_get_automation_status` with the `instance_id`.
3. If the endpoint went offline mid-run, Action1 keeps the action queued
   for `retry_minutes` (default 1440 = 24h) waiting for it to come back.
   The MCP polls only as long as `timeout_seconds` allows; lower it to
   abort earlier.

Both tools send an MCP progress notification after every poll when the
client requests progress (a `progressToken` in the request `_meta`).
Clients that reset their request timeout on progress can then wait
longer than their default request timeout. If `execute_and_wait` fails
after the action started, the error names the `instance_id`: continue
with `action1_wait_for_automation` for that instance instead of running
the action again.

### A tool fails with "timed out after ... ms (ACTION1_REQUEST_TIMEOUT_MS)"

Action1 did not answer within `ACTION1_REQUEST_TIMEOUT_MS` (this bound
covers the whole call including retries). Raise the value if Action1 is
slow for that call. A timed-out mutation may still have been processed
by Action1: check the resulting state before re-issuing it.

### Output contains `Starting`, `Waiting`, `Completed` lines

You're using the auto-generated tool
(`action1_get_automation_script_output`) which returns the raw response.
Use the curated `action1_get_automation_output` instead - it strips
those lifecycle markers automatically.

### `auto_paginate=true` returns more / fewer items than expected

Check the caller-supplied `limit`: it caps the items of one call, with or
without `auto_paginate`. With `auto_paginate=true` the runtime walks pages
until `limit` or the response size budget, then returns `has_more: true`
and a `next_cursor`; call again with that cursor for the rest. `from` sets
the first record only when no `cursor` is given.

## HTTP transport

### `Bearer token required` / `Invalid bearer token` (HTTP 401)

The client did not send the token, or sent a different one. Add to the
client's connector configuration:

```
Authorization: Bearer <MCP_HTTP_TOKEN value>
```

### `Host header not allowed` (HTTP 403)

The request's `Host` header is not a loopback name, not the bind address
and not in `MCP_HTTP_ALLOWED_HOSTS`. Behind a reverse proxy that forwards
the original host (Caddy does), add the public name:
`MCP_HTTP_ALLOWED_HOSTS=mcp.example.com`. This check is the DNS-rebinding
defence; do not work around it.

### `Origin not allowed` (HTTP 403)

A browser sent an `Origin` header that is not accepted. Without
`MCP_HTTP_ALLOWED_ORIGINS` only loopback origins are accepted; add the
exact origin of your browser client to the list.

### Server refuses to start: `Refusing to start: HTTP transport requires MCP_HTTP_TOKEN`

`--http` always needs a token, also on `127.0.0.1`. Set `MCP_HTTP_TOKEN`
to at least 16 characters (recommended: `openssl rand -hex 32`). For local
development only, `MCP_HTTP_ALLOW_NO_AUTH=true` runs without a token on a
loopback bind.

### Server refuses to start: `... binds to the wildcard address ... but MCP_HTTP_ALLOWED_HOSTS is empty`

With `--host 0.0.0.0` or `::` the server cannot know its own name. List
the hostnames clients use in `MCP_HTTP_ALLOWED_HOSTS`. Better: bind to
`127.0.0.1` behind a reverse proxy.

### `/mcp` answers 405 or 404

Only `POST /mcp`, `GET /healthz` and `GET /readyz` are served. `GET` and `DELETE` on
`/mcp` return 405 (the server is stateless and opens no event stream);
other paths return 404. A `POST` with a content type other than JSON gets
415.

### Every HTTP user shares one rate limit

Behind a reverse proxy all requests come from the proxy's address. Set
`TRUST_PROXY=loopback` (proxy on the same machine) so the limit of 60
requests per minute applies per client.

## Resources & prompts

### `resources/list` is empty in my host

Some MCP hosts only fetch resources that match a pre-declared
capability. Confirm your host supports the `resources` capability
(Claude Code ≥ 1.0, Claude Desktop ≥ 0.9, Cursor latest). If the host
calls `resources/list` we serve four static URIs (`action1://me`,
`action1://orgs`, `action1://templates`, `action1://reports`); the three
templated URIs (`action1://endpoints/{orgId}`,
`action1://groups/{orgId}`, `action1://vulnerabilities/{orgId}`) come
back from `resources/templates/list`.

### Reading `action1://vulnerabilities/default` fails with 403

The role on your API credential lacks `view_vulnerabilities`. Either
update the role in the Action1 console or remove the resource from your
host's pre-fetch list.

### Slash-prompts are not visible in my host

Claude Code shows them via `/`-completion. Claude Desktop has a
"prompts" menu in the connector UI. Cursor has a slash menu. If they
don't appear, restart the host (the prompt list is read at connect
time only).

### I cannot change the log level from my MCP host

The server does not offer the MCP `logging` capability. Logs always go to
**stderr** as JSON lines; set the level with `ACTION1_LOG_LEVEL` (for
example `debug`) and restart. Where to find stderr per host:
[`INSTALLATION.md`](INSTALLATION.md#where-does-the-server-log).

## MCP host integration

### Claude Code says "no tools loaded" after `claude mcp add`

Run `claude mcp list` and check the status column. If it shows `error`,
the server is failing to start - try the same command in a regular
terminal (`node --env-file=/abs/path/.env /abs/path/dist/index.js`) to
see the error message. Common causes:

- Wrong absolute path.
- Node older than 22.12, the supported minimum (check `node -v`).
- `.env` permissions wrong (must be readable by the user running Claude
  Code).

### Claude Desktop config edited but tools don't appear

Quit Claude Desktop fully (Cmd+Q on macOS, not just close-window) and
restart. The config is read on startup only.

### Cursor doesn't pick up `.cursor/mcp.json`

Cursor reads either `~/.cursor/mcp.json` (per-user) or
`<repo>/.cursor/mcp.json` (per-repo). Confirm which one you edited and
restart Cursor.

### Claude.ai custom connector says "connection failed"

In the connector test:

1. Check the URL is HTTPS and ends in `/mcp` (Claude.ai refuses plain
   HTTP).
2. Check the `Authorization: Bearer <token>` header in the connector
   settings.
3. From your laptop, `curl https://your-host/healthz` must return
   `{"ok":true,...}`. Then send an initialize request:

   ```bash
   curl -s -X POST https://your-host/mcp \
     -H "Authorization: Bearer <token>" \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
   ```

   A JSON-RPC `result` means the server side works. A 403 points at
   `MCP_HTTP_ALLOWED_HOSTS`, a 401 at the token.

## Codegen & spec

### `npm run codegen` produces a different `index.ts` than what's committed

Either the spec changed without regenerating (run the refresh workflow in
[`CONTRIBUTING.md`](CONTRIBUTING.md#re-running-codegen)), or the
generator's behaviour changed: `git diff` shows what.

### `Spec SHA mismatch` error from codegen

The pinned SHA in `openapi.sha256` doesn't match the actual file. Don't
auto-fix this: review `git log src/codegen/spec/openapi.json` to see
when the file changed and why. Re-pin only after a deliberate review.

## Still stuck

- Search the issue tracker:
  <https://github.com/mguttmann/action1-mcp/issues>
- Open a new issue with: server version (`node dist/index.js --version`,
  or the commit SHA), Node version
  (`node --version`), MCP host and version, the exact command you ran,
  the stderr output and a reproduction. Remove credentials and customer
  identifiers first.
