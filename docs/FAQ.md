# FAQ and how-to

Frequently asked questions and short how-to recipes that don't fit a
single page elsewhere. Grouped by topic.

## Getting started

### Where do I get an Action1 API credential?

Sign in to your Action1 console → **Settings → API Credentials → Add
API Credentials**. Pick a role (smallest one that covers your needs is
best), give it a name, and copy both the `client_id`
(`api-key-...@action1.com`) and the `client_secret`. The secret is
shown **once** - store it in your password manager and in `.env`.

See [`INSTALLATION.md`](INSTALLATION.md#getting-action1-api-credentials)
for the full walkthrough.

### Which `ACTION1_BASE_URL` do I use?

Match the region of the credential:

| Action1 region | Base URL |
|---|---|
| Europe | `https://app.eu.action1.com/api/3.0` |
| North America | `https://app.action1.com/api/3.0` |
| North America 2 | `https://app.na-2.action1.com/api/3.0` |
| United Kingdom | `https://app.uk.action1.com/api/3.0` |
| Australia | `https://app.au.action1.com/api/3.0` |

A credential from one region gets 401 against another region's base
URL.

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

The easiest way is the MCPB bundle from the GitHub Releases page:
double-click it and fill in the wizard. For a source build instead, edit
`~/Library/Application Support/Claude/claude_desktop_config.json`
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

Yes. Run the HTTP transport on `127.0.0.1` behind a TLS-terminating
reverse proxy with `MCP_HTTP_TOKEN` and `MCP_HTTP_ALLOWED_HOSTS` set, then
add a custom connector in the Claude.ai settings pointing at
`https://yourhost/mcp` with an `Authorization: Bearer <token>` header.

See [`DEPLOYMENT.md § Reverse proxy`](DEPLOYMENT.md#reverse-proxy-with-tls-caddy-example).

### Does it work with Cursor / Continue.dev / Cody?

Yes, all stdio MCP-compliant clients work. Same command:
`node --env-file=/abs/.env /abs/dist/index.js`.
[`INSTALLATION.md § Cursor`](INSTALLATION.md#cursor) has the snippet.

### Can I run it without installing Node.js?

Yes, with the **MCPB bundle** (Claude Desktop only): download the
`.mcpb` from the GitHub Releases page and double-click it. Claude Desktop
runs it with its built-in Node.js.

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

In Claude Code: `Esc`. In Claude Desktop or Claude.ai: the stop button.
The server passes the cancellation to every in-flight Action1 request,
to paginated walks and to the polling loops; the tool usually returns
within one polling interval
(default 5 seconds). An action that Action1 already started keeps running
on the endpoint.

What counts as a cancellation depends on the transport. On stdio it is
the host's `notifications/cancelled`. On the stateless 2025-era HTTP
transport it is the client closing the HTTP request that carries the
call: every request is served by its own server instance, so a
`notifications/cancelled` sent in a separate request does not reach the
running call, which then runs to its end.

## Permissions and security

### How do I know which tools my API key can use?

Read `action1://me` (most hosts pre-fetch it on connect) or run
`/check-my-permissions`. Both show the role's permission list and
flag which tool families will 403.

### Why does `action1_list_vulnerabilities` return 403?

Your API credential's role lacks `view_vulnerabilities`. The fix is
in the Action1 console (the role settings), not in the MCP server.
[`permissions.md`](permissions.md) lists the permission every tool
needs.

### How do I prevent destructive calls in my deployment?

Don't set `ACTION1_ALLOW_DESTRUCTIVE`. Without that env switch, every
destructive tool refuses to execute regardless of what the agent passes;
previews and read-only tools still work. To hide the destructive tools
completely, set `ACTION1_TOOLSETS=read`. The strongest limit is an
Action1 role without write permissions.

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

Build from a release tag, fill in `.env`, set `MCP_HTTP_TOKEN`, run on
`127.0.0.1` and put a TLS-terminating reverse proxy in front. The exact
commands and the Caddy snippet are in
[`DEPLOYMENT.md`](DEPLOYMENT.md#bare-metal--vm).

### How is a release cut?

Releases are cut by the maintainer:

1. `npm version X.Y.Z --no-git-tag-version` (updates `package.json` and
   `package-lock.json`) and the same version in `mcpb/manifest.json`.
   The server reads its version from `package.json`;
   `tests/unit/serverContract.test.ts` fails if the manifest differs.
2. Move the `[Unreleased]` notes in `CHANGELOG.md` to a dated section.
3. `npm run check` and `npm run test:e2e` green, and
   `./scripts/inspector-smoke.sh` against a test tenant.
4. Tag `vX.Y.Z` on a commit of `main` and push the tag. The
   `release.yml` workflow fails unless the tag equals `v` plus the
   `package.json` version and its commit is on `main`, runs the whole CI
   workflow on that commit, builds the reproducible MCPB bundle and the
   npm tarball with a CycloneDX SBOM each, and creates the GitHub
   Release with these assets and `SHA256SUMS` (an existing release is
   never overwritten). Its npm publish job stays off until the
   repository variable `NPM_PUBLISH_ENABLED` is `true`. The repository
   settings it relies on are in
   [`maintainers/repo-settings.md`](maintainers/repo-settings.md).

## Troubleshooting

### I see "HTTP 401" on every call

OAuth token exchange failed. Check `ACTION1_CLIENT_ID`,
`ACTION1_CLIENT_SECRET`, `ACTION1_BASE_URL` for typos / region
mismatch. The structured logger emits
`refresh_token_failed_falling_back_to_client_credentials` and
`http_request_handler_failed` events on stderr - read those for
the exact API response.

### I see "spec SHA mismatch" after a `git pull`

The committed spec, its SHA and the generated tools disagree, usually
because a commit changed one without the others. Don't re-pin blindly:
review the diff, regenerate the tools (`npm run codegen`) and commit spec,
SHA and generated file together. Full recipe in
[`CONTRIBUTING.md`](CONTRIBUTING.md#re-running-codegen). Changes at
Action1 itself are reported by `npm run spec:check`, not by this test.

### Tool descriptions look fine but Claude picks the wrong tool

Two likely causes:

1. The tool's description doesn't say what it *doesn't* do (so the
   model assumes it does everything search-shaped). Tighten the
   description.
2. The `inputSchema` is too loose - `z.string()` for a UUID doesn't
   constrain the model. Use `z.string().uuid()` or `.regex(...)`.

### My destructive call fails with "Refusing destructive call"

The error names the gate that stopped it:

| Error message contains | Fix |
|---|---|
| `ACTION1_ALLOW_DESTRUCTIVE` | Set the env to `true`/`1`/`yes` and restart. |
| `Refusing account operation` | Users, roles, organizations, enterprise and `action1_raw_request` writes also need `ACTION1_ALLOW_ACCOUNT_OPS=true`. |
| `confirm` | Pass `confirm: "YES"` exactly (uppercase, no whitespace). |

Without `dry_run: false` the call only returns a preview. All gates must
pass at the same time. See
[`SECURITY.md § Destructive guard`](SECURITY.md#destructive-guard).

More failure modes in [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

## Anything else?

- **Open an issue**:
  <https://github.com/mguttmann/action1-mcp/issues>
- **Security advisory**:
  <https://github.com/mguttmann/action1-mcp/security/advisories/new>
- **Read the docs**:
  - [`INSTALLATION.md`](INSTALLATION.md) - set up
  - [`USAGE.md`](USAGE.md) - tool reference
  - [`EXAMPLES.md`](EXAMPLES.md) - recipes
  - [`DEPLOYMENT.md`](DEPLOYMENT.md) - production deploys
  - [`SECURITY.md`](SECURITY.md) - threat model
  - [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) - failure modes
  - [`CONTRIBUTING.md`](CONTRIBUTING.md) - development
