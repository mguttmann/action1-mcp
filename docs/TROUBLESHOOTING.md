# Troubleshooting

Common failure modes and how to fix them.

## Setup / install

### `npm run build` fails with `Cannot find module @modelcontextprotocol/sdk`

You skipped `npm install`. Run it from the repo root:

```bash
npm install
npm run build
```

### `tests/unit/specSha.test.ts` fails

Either:

1. Someone edited `src/codegen/spec/openapi.json` directly without updating
   `openapi.sha256`. Don't do that — see
   [`CONTRIBUTING.md`](CONTRIBUTING.md) for the codegen regeneration
   workflow.
2. The Action1 OpenAPI spec changed upstream. Pull the latest, re-extract
   per the SOURCE.md notes, regenerate `openapi.sha256`, run `npm run codegen`,
   commit the lot.

### TypeScript build errors after a fresh clone

```bash
rm -rf dist node_modules
npm install
npm run build
```

If the error mentions `@modelcontextprotocol/sdk` types, the SDK update
broke something. Open an issue with the full TypeScript error and the
output of `npm ls @modelcontextprotocol/sdk`.

## Runtime

### `Invalid or missing environment configuration`

Something is missing or empty in `.env`. The error message lists every
field. Required minimum:

```
ACTION1_BASE_URL=https://app.eu.action1.com/api/3.0
ACTION1_CLIENT_ID=api-key-...@action1.com
ACTION1_CLIENT_SECRET=...
```

`ACTION1_ORG_ID` is optional only if every tool call passes `org_id`
explicitly. In practice you want it set.

### Every tool returns `HTTP 401`

The OAuth token exchange is failing. Check:

1. `ACTION1_CLIENT_ID` and `ACTION1_CLIENT_SECRET` match what's in the
   Action1 console (no trailing whitespace).
2. The credential isn't expired or disabled.
3. `ACTION1_BASE_URL` matches the region of the credential. EU credentials
   on `app.action1.com` (US) silently 401.

The structured logger emits `refresh_token_failed_falling_back_to_client_credentials`
and `http_request_handler_failed` events on stderr — read those for the
exact response body Action1 returned.

### Some tools return `HTTP 403` with a `Forbidden` hint

The API credential's role lacks the permission for that operation.
Action1 documents permissions at <https://www.action1.com/documentation/permissions/>.
Common pairs:

| Tool | Permission needed |
|---|---|
| `action1_list_vulnerabilities`, anything under `/vulnerabilities/` | `view_vulnerabilities` |
| `action1_audit_log_search`, anything under `/audit/` | `view_audit` |
| `action1_get_subscription`, `action1_get_subscription_usage`, `action1_get_org_subscription_usage`, `action1_request_enterprise_quote`, `action1_request_enterprise_trial` | `manage_enterprise` |
| `action1_list_users`, `action1_create_user`, `action1_update_user`, `action1_delete_user`, `action1_list_roles`, `action1_create_role`, `action1_update_role`, `action1_delete_role`, `action1_clone_role` | `manage_users` / `manage_roles` |
| Any destructive `action1_*` | `run_automations` (+ `manage_*` for the area) |

The fix is to update the credential's role in the Action1 console, not the
MCP server.

### `action1_get_endpoint` returns `HTTP 403`

This was a code bug — fixed in v0.2 by switching to the canonical path
(`/endpoints/managed/{org}/{ep}`). If you're still seeing it on the latest
build, your role lacks `view_endpoints`. Verify with
`action1_get_me` (returns the credential's role + permissions).

### `action1_run_bash_macos` reports `"not applicable to Mac platform"`

You're on a stale build. The full ten-field `run_script` payload has
been encoded in `src/payloads/macOsBash.ts` since v0.1. Run
`git pull && npm install && npm run build`. If it still happens on the
latest commit, open an issue with the full request body — it's a real
regression and we need a HAR trace from the Action1 web console to
diff against.

### `action1_run_powershell` returns `at least one valid success exit code must be specified`

Either:

1. You explicitly passed `success_exit_codes: ""` (empty). Don't.
2. Bug in the payload builder. Should not happen — open an issue.

### Tools intermittently fail with `ENOTFOUND` or `EAI_AGAIN`

DNS hiccup. The retry layer (5 attempts, exponential backoff up to 4 s)
should recover. If it fails after retries, your DNS is genuinely broken or
the Action1 API is unreachable from the server — try `dig app.eu.action1.com`
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

### Output contains `Starting`, `Waiting`, `Completed` lines

You're using the auto-generated tool
(`action1_get_automation_script_output`) which returns the raw response.
Use the curated `action1_get_automation_output` instead — it strips
those lifecycle markers automatically.

### `auto_paginate=true` returns more / fewer items than expected

Check the caller-supplied `limit`. With `auto_paginate=true`, `limit` is
treated as `maxItems` (cap on the total returned). Without it, the runtime
pages until the API returns an empty page.

If you set neither, you'll get the entire collection — which can be
thousands of items for `action1_list_audit_events` or
`action1_list_logs`.

## HTTP transport

### `Bearer token required` (HTTP 401)

`MCP_HTTP_TOKEN` is set in the server env but the client did not send the
header. Add to your client's connector config:

```
Authorization: Bearer <token-value>
```

### `Origin not allowed` (HTTP 403)

The browser sent an `Origin` header that's not in `MCP_HTTP_ALLOWED_ORIGINS`.
Either add the origin (e.g. `https://claude.ai`) or — if no browser
clients connect — leave the allowlist empty.

### Server refuses to start: `Refusing to start: HTTP transport binds to non-loopback host '...' without a Bearer token`

You started the HTTP transport on a non-loopback host without setting
`MCP_HTTP_TOKEN`. The server hard-fails at startup rather than running
an unauthenticated public endpoint. Fix either:

- Set `MCP_HTTP_TOKEN` to a value with at least 16 non-whitespace
  characters (recommended: `openssl rand -hex 32`), or
- Bind to loopback with `--host 127.0.0.1` and front the server with a
  reverse proxy that handles auth.

### `/healthz` returns `200` but `/mcp` 404s

You're hitting an HTTP path that's not registered. The only endpoints
served are `GET /healthz` and `POST /mcp`. Check your URL.

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

### `logging/setLevel` does nothing

The server honours it but emits to **stderr**. Some hosts (Claude
Desktop without dev-tools open) don't surface stderr. Either run with
`--http` and watch the process output, or set
`ACTION1_LOG_LEVEL=debug` in the env up-front.

## MCP host integration

### Claude Code says "no tools loaded" after `claude mcp add`

Run `claude mcp list` and check the status column. If it shows `error`,
the server is failing to start — try the same command in a regular
terminal (`node --env-file=/abs/path/.env /abs/path/dist/index.js`) to
see the error message. Common causes:

- Wrong absolute path.
- `--env-file` flag requires Node 20+.
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

1. Check the URL is HTTPS (Claude.ai refuses plain HTTP).
2. Check the `Authorization: Bearer <token>` header is set in the
   connector's "Headers" section.
3. Try `curl -X POST https://your-host/mcp -H "Authorization: Bearer X"`
   from your laptop — if that returns `200`, the issue is on Claude.ai's
   side, not yours.

## Codegen & spec

### `npm run codegen` produces a different `index.ts` than what's committed

The OpenAPI spec changed without updating the SHA pin. Run the SHA-update
workflow in `CONTRIBUTING.md`. If the spec hasn't changed, then the
generator's behaviour did — `git diff` to see what.

### `Spec SHA mismatch` error from codegen

The pinned SHA in `openapi.sha256` doesn't match the actual file. Don't
auto-fix this — review `git log src/codegen/spec/openapi.json` to see
when the file changed and why. Re-pin only after a deliberate review.

## Still stuck

- Search the issue tracker:
  <https://github.com/mguttmann/action1-mcp/issues>
- Open a new issue with: server version (`npm ls action1-mcp-server` or commit
  SHA), Node version (`node --version`), MCP host + version, the exact
  command you ran, the full stderr output, and a redacted reproduction.
