# Installation Guide

This document walks you through installing **action1-mcp-server** and connecting it to
the MCP host of your choice. Pick the section that matches your setup.

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | ≥ 20 | Native `fetch`, `--env-file` and `node:test` rely on this. |
| npm | bundled with Node | Or `pnpm` / `yarn` if you prefer. |
| An Action1 account | any tier | Cloud or trial. |
| API credentials | `client_id` + `client_secret` | Issued in *Settings → API Credentials*. See [Getting credentials](#getting-action1-api-credentials). |

`git` is recommended but not required — you can also download the repo as a tarball.

## Getting Action1 API credentials

1. Sign in to your Action1 console.
2. Navigate to **Settings → API Credentials**.
3. Click **Add API Credentials**, give it a descriptive name (e.g. `claude-mcp`).
4. Assign the **role** for this credential. The role determines which API
   operations succeed; the same role you'd give a human user. For full
   read-write the built-in *Owner* role works; for read-only smoke testing pick
   a role with `view_endpoints`, `view_automations`, `view_reports` and friends.
5. Copy the `client_id` (looks like `api-key-...@action1.com`) and the
   `client_secret`. The secret is shown **once** — store it securely.
6. Note your base URL. Most installations are on the EU instance
   (`https://app.eu.action1.com/api/3.0`) or the US instance
   (`https://app.action1.com/api/3.0`).
7. Note your `org_id`. Either fetch it later via `action1_list_organizations`,
   or copy it from the URL path when you're inside an organization in the
   console.

## Step 1: Install the server

### Option A — clone the repo (recommended for now)

```bash
git clone https://github.com/mguttmann/action1-mcp.git
cd action1-mcp
npm install
npm run build
```

This produces `dist/index.js`, the executable entry point.

### Option B — npx (when published to npm)

```bash
npx -y action1-mcp-server@latest
```

> Status: not on npm yet. Use the clone-and-build path until the first npm release tag.

## Step 2: Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```dotenv
ACTION1_BASE_URL=https://app.eu.action1.com/api/3.0
ACTION1_ORG_ID=<your-org-uuid>
ACTION1_CLIENT_ID=api-key-...@action1.com
ACTION1_CLIENT_SECRET=<your-secret>
# Optional
ACTION1_DEFAULT_TIMEOUT_MINUTES=10
ACTION1_DEFAULT_RETRY_MINUTES=1440
ACTION1_LOG_LEVEL=info
ACTION1_ALLOW_DESTRUCTIVE=false   # set to true to permit destructive operations
```

`.env` is in `.gitignore` and never committed — keep it that way.

## Step 3: Smoke test

Before wiring up an MCP host, run the Inspector locally.

```bash
npm run inspector
```

This launches the MCP Inspector against the built stdio server. In the UI,
click **Tools → tools/list** — you should see all curated + auto-generated tools. Try
`action1_list_organizations` (no parameters needed). If it returns your org,
your install is good.

For headless verification:

```bash
node --env-file=.env dist/index.js --help
```

…prints the CLI help. To run a one-shot tool call:

```bash
npx @modelcontextprotocol/inspector --cli \
  node --env-file=.env dist/index.js \
  --method tools/call --tool-name action1_list_organizations
```

## Step 4: Connect to your MCP host

### Claude Code (CLI)

```bash
# stdio (recommended for local use)
claude mcp add action1 -- node --env-file=/abs/path/to/action1-mcp/.env /abs/path/to/action1-mcp/dist/index.js

# scope: user (everywhere) or project (current repo)
claude mcp add --scope user action1 -- node --env-file=/abs/path/to/.env /abs/path/to/dist/index.js
```

Verify with `claude mcp list`. In a Claude Code session, type
`/mcp` to see the loaded servers and their tools.

### Claude Desktop (macOS / Windows)

Two installation paths. **Option A is recommended** — Claude Desktop
prompts the user for credentials on first launch, no `.env` file or
absolute-path config-editing required.

#### Option A — MCPB one-click install (recommended)

1. **Prerequisites on your machine**:
   - Node.js ≥ 20 (`node -v`)
   - `git`
   - Claude Desktop installed

2. **Clone, install, build the bundle**:

   ```bash
   git clone https://github.com/mguttmann/action1-mcp.git
   cd action1-mcp
   npm install
   npm run build:mcpb
   ```

   This produces `dist/action1-mcp-<version>.mcpb` (e.g.
   `dist/action1-mcp-0.5.0.mcpb`).

3. **Install into Claude Desktop**:
   - Double-click the `.mcpb` file, **or** drag it onto the Claude
     Desktop window, **or** open Claude Desktop → Settings →
     Extensions → *Install from file* and pick the `.mcpb`.

4. **Fill in credentials** in the wizard that appears. Fields:

   | Field | Where to get it |
   |---|---|
   | **Action1 API base URL** | EU: `https://app.eu.action1.com/api/3.0` (default). US: `https://app.action1.com/api/3.0`. |
   | **Default organization ID** | Action1 console URL contains the UUID after `/org/`. |
   | **API client ID** | Action1 console → Settings → API Credentials → looks like `api-key-…@action1.com`. |
   | **API client secret** | Shown **once** when you create the credential — store it in a password manager. |
   | **Allow destructive operations** | Leave `false` for read-only safety. Set `true` only if this Claude session should be able to run scripts / deploy updates / reboot. Even when `true`, every destructive call still requires per-call `confirm: "YES"` and `dry_run: false`. |

5. **Restart Claude Desktop** if the tools do not appear immediately.
   Open a new chat and type `What MCP tools are available?` — you
   should see ~166 `action1_*` tools. Try `action1_list_organizations`
   as a read-only smoke test.

> **Updating later**: `git pull && npm install && npm run build:mcpb`,
> then re-install the new `.mcpb` from Claude Desktop's Extensions UI.
> Credentials carry over.

#### Option B — manual JSON config (advanced)

Use this only if you need to point at a specific build, run from a
non-standard path, or prefer environment-variable management.

Edit your config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add to the `mcpServers` map:

```jsonc
{
  "mcpServers": {
    "action1": {
      "command": "node",
      "args": [
        "--env-file=/absolute/path/to/action1-mcp/.env",
        "/absolute/path/to/action1-mcp/dist/index.js"
      ]
    }
  }
}
```

Restart Claude Desktop. The tools appear in the connector menu.

> **Note**: Claude Desktop ignores remote-HTTP MCP servers placed in this file.

### Claude.ai (web)

Claude.ai supports MCP through *Custom Connectors* (Settings → Connectors → Add
custom connector). This requires the **Streamable HTTP** transport.

```bash
# On your server
ACTION1_ALLOW_DESTRUCTIVE=true \
  node --env-file=.env dist/index.js --http --port 3000 --host 0.0.0.0
```

In Claude.ai:

1. Settings → Connectors → **Add custom connector**.
2. URL: `https://your-host:3000/mcp` (must be HTTPS in production).
3. Auth: add a static `Authorization: Bearer <token>` header if you front the
   server with a reverse proxy (recommended — Action1 credentials should not
   be reachable from the public internet without auth).

See [`DEPLOYMENT.md`](DEPLOYMENT.md) for a TLS + reverse-proxy template.

### Cursor

Cursor reads `~/.cursor/mcp.json` (per-user) or `.cursor/mcp.json` (per-repo).

```jsonc
{
  "mcpServers": {
    "action1": {
      "command": "node",
      "args": [
        "--env-file=/abs/path/to/.env",
        "/abs/path/to/dist/index.js"
      ]
    }
  }
}
```

Restart Cursor; tools appear in the chat UI.

### Continue.dev / Cody / generic stdio clients

Any MCP-compliant client that speaks stdio works. The command-line is always:

```bash
node --env-file=/abs/path/.env /abs/path/dist/index.js
```

For HTTP clients:

```bash
node --env-file=.env dist/index.js --http
# default endpoint: http://127.0.0.1:3000/mcp
```

## Step 5: Verify connectivity

In your MCP host, ask:

> List my Action1 organizations.

Claude (or any other MCP-aware model) will call `action1_list_organizations`.
You should see your organization in the response. If you don't:

1. Check `ACTION1_BASE_URL` matches your region's instance.
2. Check `ACTION1_CLIENT_ID` and `ACTION1_CLIENT_SECRET` are right (no
   trailing whitespace in `.env`).
3. Look at the server's stderr — the structured logger prints auth events.
4. Read [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

## Updating

```bash
cd action1-mcp
git pull
npm install
npm run build
```

Restart your MCP host. The tool list refreshes on next connect.

If the Action1 OpenAPI spec has changed since your last update, the
`tests/unit/specSha.test.ts` test will fail with a SHA mismatch. That's a
deliberate signal to review the upstream changes before regenerating —
[`CONTRIBUTING.md`](CONTRIBUTING.md) explains the codegen workflow.

## Uninstall

- Remove the server entry from your MCP host's config.
- Delete the cloned repo directory.
- Optionally revoke the API credential in the Action1 console.

---

## Frequently asked install questions

### Do I need to clone the repo, or is there a one-click installer?

Two install paths, in order of friction:

1. **MCPB bundle (Claude Desktop only)** — once a release is cut, a
   `.mcpb` is attached to the GitHub Release. Double-click it. Claude
   Desktop walks you through filling in credentials. Zero terminal
   contact.
2. **Clone + build** — what this guide describes. Required if you
   want to develop / contribute / run from `main` ahead of a release.

### Does the server stay running, or does it spawn per call?

stdio mode: one process per MCP-host connection, lives as long as the
host is connected. HTTP mode: one long-running process serves many
hosts; new `McpServer` per request internally for isolation.

### Where does the server log?

Always **stderr**. Stdout is reserved for MCP JSON-RPC traffic. To see
logs:
- Claude Code: open the developer console (`/dev` in newer versions).
- Claude Desktop: enable developer tools in settings.
- HTTP mode: just watch the process output (`journalctl -u
  action1-mcp`, etc.).

Set `ACTION1_LOG_LEVEL=debug` for verbose traces.

### Can I run multiple instances at once?

Yes. Each instance needs its own `.env` (or env vars) and, in HTTP
mode, its own port. Useful for connecting two different Action1
organizations to the same Claude session simultaneously — register them
under different MCP names (`action1-prod`, `action1-staging`).

### How do I update?

```bash
cd action1-mcp
git pull
npm install     # picks up dependency changes
npm run build
```

Restart the MCP host. The tool list is reloaded on the next connect.

If `tests/unit/specSha.test.ts` fails after the pull, the upstream
Action1 spec changed and someone re-pinned it. Don't blindly
auto-fix — read the commit history first.

### How do I check the install worked?

In your MCP host, ask Claude:

> List my Action1 organizations.

You should see your org. If you don't, walk through
[`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

For a headless smoke:

```bash
ACTION1_BASE_URL=... ACTION1_CLIENT_ID=... ACTION1_CLIENT_SECRET=... \
  ACTION1_ORG_ID=... \
  npx @modelcontextprotocol/inspector --cli node dist/index.js \
    --method tools/list | jq '.tools | length'
# expected: 166 (33 curated incl. 6 wrappers + 133 generated)
```

### Can I disable the auto-generated tools and only use the curated ones?

Not via configuration today. If you really want to, comment out
`registerGeneratedTools(server, client)` in `src/server.ts` and
rebuild — you keep the 33 curated tools (27 thematic + 6 workflow wrappers).

### Can I add my own tools?

Yes — see [`CONTRIBUTING.md`](CONTRIBUTING.md). Either fork or layer
your own server that wraps this one's `Action1Client` directly.

## Other resources

- [`USAGE.md`](USAGE.md) — what each tool does.
- [`EXAMPLES.md`](EXAMPLES.md) — copy-paste recipes.
- [`FAQ.md`](FAQ.md) — broader Q&amp;A across topics.
- [`DEPLOYMENT.md`](DEPLOYMENT.md) — production hosting.
- [`SECURITY.md`](SECURITY.md) — threat model + safeguards.
- [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) — failure modes.
