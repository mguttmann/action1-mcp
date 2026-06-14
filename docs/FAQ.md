# FAQ &amp; HowTo

Frequently asked questions and short how-to recipes that don't fit a
single page elsewhere. Grouped by topic.

## Getting started

### Where do I get an Action1 API credential?

Sign in to your Action1 console → **Settings → API Credentials → Add
API Credentials**. Pick a role (smallest one that covers your needs is
best), give it a name, and copy both the `client_id`
(`api-key-...@action1.com`) and the `client_secret`. The secret is
shown **once** — store it in your password manager and in `.env`.

See [`INSTALLATION.md`](INSTALLATION.md#getting-action1-api-credentials)
for the full walkthrough.

### Which `ACTION1_BASE_URL` do I use?

Match the region of the credential:

| Action1 instance | Base URL |
|---|---|
| EU | `https://app.eu.action1.com/api/3.0` |
| US | `https://app.action1.com/api/3.0` |

A credential issued on EU will silently 401 against the US base URL
and vice versa.

### Do I need an org ID?

You don't *need* one if you always pass `org_id` per tool call, but
in practice every tool that touches an org will ask for it, and it's
much less typing to set `ACTION1_ORG_ID` in the env. To find it: call
`action1_list_organizations` once and copy the UUID.

### How do I find my endpoint IDs?

`action1_list_endpoints` for the full inventory. For a fuzzy lookup by
hostname / user: `action1_search_endpoints query="<substring>"`.

## Connecting

### How do I connect to Claude Code?

```bash
claude mcp add action1 -- node \
  --env-file=/abs/path/.env /abs/path/dist/index.js
```

Replace both paths with absolutes. `claude mcp list` should show it
after.

See [`INSTALLATION.md`](INSTALLATION.md#claude-code-cli) for scope
options (per-project vs. per-user) and HTTP transport.

### How do I connect to Claude Desktop?

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows) and
add to `mcpServers`:

```jsonc
"action1": {
  "command": "node",
  "args": ["--env-file=/abs/path/.env", "/abs/path/dist/index.js"]
}
```

Quit Claude Desktop completely (`Cmd+Q`), re-open. The tools appear in
the connector menu. Full guide:
[`INSTALLATION.md § Claude Desktop`](INSTALLATION.md#claude-desktop-macos--windows).

### Can I connect from Claude.ai (web)?

Yes — start the HTTP transport (`npm run start:http`) behind a
TLS-terminating reverse proxy with a strong `MCP_HTTP_TOKEN` set, then
add a custom connector in the Claude.ai settings pointing at
`https://yourhost/mcp` with an `Authorization: Bearer <token>` header.

See [`DEPLOYMENT.md § Reverse proxy`](DEPLOYMENT.md#reverse-proxy-with-tls-caddy-example).

### Does it work with Cursor / Continue.dev / Cody?

Yes, all stdio MCP-compliant clients work. Same command:
`node --env-file=/abs/.env /abs/dist/index.js`.
[`INSTALLATION.md § Cursor`](INSTALLATION.md#cursor) has the snippet.

### Can I run it without installing Node.js?

Yes — the **MCPB bundle** (Claude Desktop only): download the `.mcpb`
from the GitHub Releases page and double-click it. The bundle ships its
own Node runtime.

## Day-to-day usage

### How do I run a PowerShell on a Windows endpoint?

```jsonc
{ "tool": "action1_execute_and_wait",
  "arguments": {
    "endpoint_id": "<uuid>",
    "mode": "script",
    "script_text": "Get-Date; hostname",
    "dry_run": false,
    "confirm": "YES"
  }
}
```

This runs the script, polls until it terminates, and returns the
filtered output. With `dry_run: true` (default) you only see the
payload that *would* be sent.

### How do I patch a whole group of endpoints?

Two paths:

1. **Slash command** (in any host that surfaces them):
   `/patch-windows-fleet group_query="marketing-laptops"`. Claude
   walks through the steps.
2. **Manual**: `action1_endpoint_groups_resolve` to get the group
   UUID → `action1_deploy_update` with
   `target_type: "EndpointGroup"`. See
   [`EXAMPLES.md § 6`](EXAMPLES.md#6-patch-a-whole-group-of-endpoints-in-one-shot).

### How do I find which endpoints have a specific software installed?

```text
/software-inventory-sweep software_name="chrome"
```

Or manually: `action1_software_inventory_for_endpoint` for a single
endpoint, looped over the list from `action1_list_endpoints`.

### How do I trigger a reboot?

```jsonc
// Server env: ACTION1_ALLOW_DESTRUCTIVE=true
{ "tool": "action1_reboot_endpoint",
  "arguments": {
    "endpoint_id": "<uuid>",
    "dry_run": false,
    "confirm": "YES"
  }
}
```

Combine with `action1_wait_for_automation` if you need to know when
the endpoint comes back.

### How do I cancel a long-running tool?

In Claude Code: `Ctrl+C`. In Claude Desktop / Claude.ai: the
"stop generating" button. The server propagates the AbortSignal to
the polling loop and the in-flight HTTP request — typically the tool
returns within one polling interval (default 5 seconds).

## Permissions and security

### How do I know which tools my API key can use?

Read `action1://me` (most hosts pre-fetch it on connect) or run
`/check-my-permissions`. Both show the role's permission list and
flag which tool families will 403.

### Why does `action1_list_vulnerabilities` return 403?

Your API credential's role lacks `view_vulnerabilities`. The fix is
in the Action1 console (Settings → Roles), not in the MCP server.
Other 403-prone tools: `action1_list_audit_events`, `action1_export_audit_log`, `action1_audit_log_search` (need `view_audit`);
`action1_get_subscription`, `action1_get_subscription_usage`, `action1_get_org_subscription_usage` (need `manage_enterprise`);
`action1_list_users`, `action1_create_user`, `action1_update_user`, `action1_delete_user`, `action1_list_roles`, `action1_create_role`, `action1_update_role`, `action1_delete_role`, `action1_clone_role` (need `manage_users` / `manage_roles`).

### How do I prevent destructive calls in my deployment?

Don't set `ACTION1_ALLOW_DESTRUCTIVE`. Without that env switch,
every destructive tool refuses to mutate state regardless of what
the agent passes. Read-only tools still work.

### How do I rotate the API credential without downtime?

1. In the Action1 console, issue a new credential (don't revoke the
   old one yet).
2. Update `.env` on the server with the new `ACTION1_CLIENT_ID` and
   `ACTION1_CLIENT_SECRET`.
3. Restart the server.
4. Verify it works (call `action1_list_organizations` from your host).
5. Revoke the old credential.

## Hosting

### Should I run stdio or HTTP?

| Use case | Pick |
|---|---|
| One developer, one machine | stdio |
| Team sharing one Action1 setup | HTTP behind TLS + `MCP_HTTP_TOKEN` |
| Claude Desktop end-users | MCPB bundle |
| Container / k8s | HTTP mode (`node dist/index.js --http`) |

[`DEPLOYMENT.md § Decision matrix`](DEPLOYMENT.md#decision-matrix) has
more.

### What's the minimum to deploy on a server?

```bash
git clone https://github.com/mguttmann/action1-mcp.git
cd action1-mcp
npm ci && npm run build
cp .env.example .env  # fill in
echo "MCP_HTTP_TOKEN=$(openssl rand -hex 32)" >> .env
node --env-file=.env dist/index.js --http --host 127.0.0.1 --port 3000
```

Then put a TLS-terminating reverse proxy in front. Caddy snippet in
[`DEPLOYMENT.md § Reverse proxy`](DEPLOYMENT.md#reverse-proxy-with-tls-caddy-example).

### How do I cut a release?

```bash
git tag vX.Y.Z        # e.g. v0.4.2
git push origin vX.Y.Z
```

The `release.yml` workflow builds the MCPB bundle and attaches the
`.mcpb` to the GitHub Release notes. See
[`CONTRIBUTING.md § Re-running codegen`](CONTRIBUTING.md#re-running-codegen)
for the full release prep.

Before tagging:
1. Bump `package.json`, `mcpb/manifest.json`, and the version literal
   in `src/server.ts` (the MCP-handshake version clients see).
2. Run `npm install` to sync `package-lock.json`.
3. Update `CHANGELOG.md` with the new version section + footer link.
4. Verify `npm test` and `./scripts/inspector-smoke.sh` are green.

## Troubleshooting

### I see "HTTP 401" on every call

OAuth token exchange failed. Check `ACTION1_CLIENT_ID`,
`ACTION1_CLIENT_SECRET`, `ACTION1_BASE_URL` for typos / region
mismatch. The structured logger emits
`refresh_token_failed_falling_back_to_client_credentials` and
`http_request_handler_failed` events on stderr — read those for
the exact API response.

### I see "spec SHA mismatch" after a `git pull`

Action1 changed the OpenAPI spec upstream. Don't auto-update the
pin — review the diff, regenerate the tools (`npm run codegen`),
re-pin the SHA, and commit the lot. Full recipe in
[`CONTRIBUTING.md § Re-running codegen`](CONTRIBUTING.md#re-running-codegen).

### Tool descriptions look fine but Claude picks the wrong tool

Two likely causes:

1. The tool's description doesn't say what it *doesn't* do (so the
   model assumes it does everything search-shaped). Tighten the
   description.
2. The `inputSchema` is too loose — `z.string()` for a UUID doesn't
   constrain the model. Use `z.string().uuid()` or `.regex(...)`.

### My destructive call fails with "Refusing destructive call"

Three possible gates:

| Error message contains | Fix |
|---|---|
| `ACTION1_ALLOW_DESTRUCTIVE` | Set the env to `true`/`1`/`yes` and restart. |
| `confirm` | Pass `confirm: "YES"` exactly (uppercase, no whitespace). |
| `dry_run` | Default is `true`; pass `dry_run: false` to actually execute. |

All three must pass simultaneously. See
[`SECURITY.md § Destructive guard`](SECURITY.md#destructive-guard).

More failure modes in [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

## Anything else?

- **Open an issue**:
  <https://github.com/mguttmann/action1-mcp/issues>
- **Security advisory**:
  <https://github.com/mguttmann/action1-mcp/security/advisories/new>
- **Read the docs**:
  - [`INSTALLATION.md`](INSTALLATION.md) — set up
  - [`USAGE.md`](USAGE.md) — tool reference
  - [`EXAMPLES.md`](EXAMPLES.md) — recipes
  - [`DEPLOYMENT.md`](DEPLOYMENT.md) — production deploys
  - [`SECURITY.md`](SECURITY.md) — threat model
  - [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) — failure modes
  - [`CONTRIBUTING.md`](CONTRIBUTING.md) — development
