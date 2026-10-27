# Installation Guide

This guide installs **action1-mcp-server** and connects it to the MCP host
of your choice. Pick the section that matches your setup.

This is an unofficial project, not affiliated with or endorsed by Action1.

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 22.12 or newer | `engines` in `package.json`; CI tests 22, 24 and 26. `npm run inspector` needs 22.19 or newer. Not needed for the MCPB bundle in Claude Desktop. |
| npm | bundled with Node | `npm ci` installs exactly the versions in `package-lock.json`. |
| An Action1 account | any tier | Cloud or trial. |
| API credentials | `client_id` + `client_secret` | Issued in *Settings > API Credentials*. See [Getting credentials](#getting-action1-api-credentials). |

## Getting Action1 API credentials

1. Sign in to your Action1 console.
2. Open **Settings > API Credentials**.
3. Click **Add API Credentials** and give it a descriptive name (e.g.
   `claude-mcp`).
4. Assign a **role**. The role decides which API operations succeed.
   Start with a read-only role; [`permissions.md`](permissions.md) lists
   the permission each tool needs. Avoid the *Owner* role.
5. Copy the `client_id` (looks like `api-key-...@action1.com`) and the
   `client_secret`. The secret is shown **once**; store it in a password
   manager. Do not paste it into a chat with an AI assistant.
6. Note the base URL of your region:

   | Region | Base URL |
   |---|---|
   | Europe | `https://app.eu.action1.com/api/3.0` |
   | North America | `https://app.action1.com/api/3.0` |
   | North America 2 | `https://app.na-2.action1.com/api/3.0` |
   | United Kingdom | `https://app.uk.action1.com/api/3.0` |
   | Australia | `https://app.au.action1.com/api/3.0` |

7. Note your `org_id`: copy it from the console URL inside an
   organization, or call `action1_list_organizations` later.

## Step 1: Install the server

### Option A: MCPB bundle for Claude Desktop

Download `action1-mcp-<version>.mcpb` from the project's
[GitHub Releases](https://github.com/mguttmann/action1-mcp/releases) and
continue with [Claude Desktop](#claude-desktop-macos--windows). No Node.js
installation is needed.

### Option B: from source (every MCP host)

```bash
git clone https://github.com/mguttmann/action1-mcp.git
cd action1-mcp
npm ci
npm run build
```

`npm run build` compiles to `dist/` (TypeScript only; `npm run check`
runs lint, typecheck, format check and the tests). `dist/index.js` is the entry point.

### Option C: npm (npx)

The package is on npm as
[`action1-mcp-server`](https://www.npmjs.com/package/action1-mcp-server);
its command is `action1-mcp`. Install only that exact name: packages with
similar names are not this project. With `npx` the MCP host fetches and
starts it, so there is nothing to clone or build:

```bash
npx -y action1-mcp-server --help         # prints the version and the settings
npx -y action1-mcp-server@<version> ...  # a pinned version
```

The settings come from the environment the MCP host passes to the
process (the `env` block of its configuration, or `-e` for Claude Code);
see [Claude Code](#claude-code-cli) and
[generic stdio clients](#continuedev--cody--generic-stdio-clients). Steps
2 and 3 below are for the source install.

From 0.6.1 on, releases published to npm are also listed in the official
[MCP Registry](https://registry.modelcontextprotocol.io) as
`io.github.mguttmann/action1-mcp`, next to the MCPB bundle. Hosts that
install from the registry ask for the same environment variables.

## Step 2: Configure environment (source install)

```bash
cp .env.example .env
chmod 600 .env
```

Edit `.env`:

```dotenv
ACTION1_BASE_URL=https://app.eu.action1.com/api/3.0
ACTION1_ORG_ID=<your-org-uuid>
ACTION1_CLIENT_ID=api-key-...@action1.com
ACTION1_CLIENT_SECRET=<your-secret>
# Recommended: only these organizations may be addressed
ACTION1_ALLOWED_ORG_IDS=<your-org-uuid>
# Leave off for read-only use; true allows tools that change state
ACTION1_ALLOW_DESTRUCTIVE=false
```

Keep comments on their own line. Empty values mean "use the default".
`.env` is in `.gitignore`; keep it that way. All settings are listed in
the [README](../README.md#configuration) and in
`node dist/index.js --help`.

## Step 3: Smoke test (source install)

```bash
node --env-file=.env dist/index.js --help
```

prints the version and the settings. To open the MCP Inspector against the
built server (Node 22.19 or newer):

```bash
npm run inspector
```

In the UI, open **Tools** and list them: you should see the `action1_*`
tools. Call `action1_list_organizations` (no parameters); if it returns
your organization, the install works.

One-shot call from the command line:

```bash
npx -y @modelcontextprotocol/inspector@2.12.0 --cli \
  node --env-file=.env dist/index.js \
  --method tools/call --tool-name action1_list_organizations
```

## Step 4: Connect to your MCP host

### Claude Code (CLI)

From npm (Option C): `-e` sets each environment variable for the server.
Type the values in your own shell, never into a chat; Claude Code stores
them in its configuration (`~/.claude.json` for the local and user
scopes, `.mcp.json` in the repository for the project scope, so do not
use the project scope with real credentials).

```bash
claude mcp add action1 \
  -e ACTION1_BASE_URL=https://app.eu.action1.com/api/3.0 \
  -e ACTION1_ORG_ID=<your-org-uuid> \
  -e ACTION1_CLIENT_ID=<client-id> \
  -e ACTION1_CLIENT_SECRET=<client-secret> \
  -e ACTION1_ALLOWED_ORG_IDS=<your-org-uuid> \
  -- npx -y action1-mcp-server
```

From source (Option B), with the `.env` file of Step 2:

```bash
# stdio (recommended for local use)
claude mcp add action1 -- node --env-file=/abs/path/to/action1-mcp/.env /abs/path/to/action1-mcp/dist/index.js

# scope: user (everywhere) or project (current repo)
claude mcp add --scope user action1 -- node --env-file=/abs/path/to/.env /abs/path/to/dist/index.js
```

Verify with `claude mcp list`. In a Claude Code session, `/mcp` shows the
loaded servers and their tools.

### Claude Desktop (macOS / Windows)

Two installation paths. **Option A is recommended**: Claude Desktop asks
for the settings on install, no `.env` file or config editing needed.

#### Option A: MCPB bundle (recommended)

1. **Get the bundle**: download `action1-mcp-<version>.mcpb` from the
   [GitHub Releases](https://github.com/mguttmann/action1-mcp/releases),
   or build it from source:

   ```bash
   git clone https://github.com/mguttmann/action1-mcp.git
   cd action1-mcp
   npm ci
   npm run build:mcpb        # writes dist/action1-mcp-<version>.mcpb
   ```

   On Windows, run the build in Git Bash (part of Git for Windows): the
   build script needs bash.

2. **Install into Claude Desktop**: double-click the `.mcpb` file, drag it
   onto the Claude Desktop window, or open Settings > Extensions >
   *Install from file*.

3. **Fill in the wizard**:

   | Field | Where to get it |
   |---|---|
   | **Action1 API base URL** | Your region, see [Getting credentials](#getting-action1-api-credentials). Default: Europe. |
   | **Default organization ID** | The organization UUID from the console URL. |
   | **API client ID** | Action1 console > Settings > API Credentials, looks like `api-key-...@action1.com`. |
   | **API client secret** | Shown **once** when you create the credential. |
   | **Allow destructive operations** | A checkbox. Leave it unchecked for read-only use. Checked, tools that change state may execute, still only with per-call `confirm: "YES"` and `dry_run: false`. |

   Type the client ID and secret only into this dialog. Account
   operations (users, roles, organizations, enterprise) stay disabled in
   the bundle.

4. **Restart Claude Desktop** if the tools do not appear. In a new chat,
   ask *"What Action1 tools are available?"*: you should see a long list
   of `action1_*` tools. Try `action1_list_organizations` as a read-only
   smoke test.

> **Updating later**: download or build the new `.mcpb` and install it
> again from Settings > Extensions. Settings carry over.

#### Option B: manual JSON config (advanced)

Use this only to run a specific build or to manage the configuration
yourself.

Edit the config file:

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

Quit and restart Claude Desktop. The tools appear in the connector menu.

> **Note**: Claude Desktop ignores remote HTTP MCP servers in this file.

### Claude.ai (web)

Claude.ai connects to remote MCP servers through *Custom Connectors*
(Settings > Connectors > Add custom connector). That needs the
**Streamable HTTP** transport on a server reachable over HTTPS.

Run the server on loopback behind a TLS reverse proxy, as described in
[`DEPLOYMENT.md`](DEPLOYMENT.md#streamable-http-hosted):

```bash
# On your server; .env contains MCP_HTTP_TOKEN, MCP_HTTP_ALLOWED_HOSTS and TRUST_PROXY
node --env-file=.env dist/index.js --http --host 127.0.0.1 --port 3000
```

In Claude.ai:

1. Settings > Connectors > **Add custom connector**.
2. URL: `https://<your-public-name>/mcp` (the reverse proxy, not port 3000
   directly).
3. Add the request header `Authorization: Bearer <MCP_HTTP_TOKEN value>`.

Do not bind the server to `0.0.0.0` without a proxy, and do not enable
`ACTION1_ALLOW_DESTRUCTIVE` on a server you have not secured with TLS, a
token and `ACTION1_ALLOWED_ORG_IDS`.

### Cursor

Cursor reads `~/.cursor/mcp.json` (per user) or `.cursor/mcp.json` (per
repository).

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

Restart Cursor; the tools appear in the chat UI.

### Continue.dev / Cody / generic stdio clients

Any MCP client that speaks stdio works. From npm, the usual JSON
configuration (`mcpServers` in Claude Desktop, Cursor and most other
hosts) is:

```json
{
  "mcpServers": {
    "action1": {
      "command": "npx",
      "args": ["-y", "action1-mcp-server"],
      "env": {
        "ACTION1_BASE_URL": "https://app.eu.action1.com/api/3.0",
        "ACTION1_ORG_ID": "<your-org-uuid>",
        "ACTION1_CLIENT_ID": "<client-id>",
        "ACTION1_CLIENT_SECRET": "<client-secret>",
        "ACTION1_ALLOWED_ORG_IDS": "<your-org-uuid>"
      }
    }
  }
}
```

This file then holds the credential: keep it readable for your user
only and out of version control. From source, the command line is:

```bash
node --env-file=/abs/path/.env /abs/path/dist/index.js
```

For HTTP clients, `--http` needs `MCP_HTTP_TOKEN` in the environment:

```bash
node --env-file=.env dist/index.js --http
# endpoint: http://127.0.0.1:3000/mcp, header Authorization: Bearer <token>
```

For a quick local test without a token, `MCP_HTTP_ALLOW_NO_AUTH=true`
works on a loopback bind only.

## Step 5: Verify connectivity

In your MCP host, ask:

> List my Action1 organizations.

The model calls `action1_list_organizations`. You should see your
organization. If not:

1. Check that `ACTION1_BASE_URL` is your region.
2. Check `ACTION1_CLIENT_ID` and `ACTION1_CLIENT_SECRET`.
3. Read the server's stderr: the structured logger prints auth and tool
   events.
4. Read [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

## Updating

npx keeps a fetched version in its cache. To move an npx setup to the
newest release, use `action1-mcp-server@latest` in the host's command
once (or pin `action1-mcp-server@<version>`) and restart the host. For a
source install:

```bash
cd action1-mcp
git pull
npm ci
npm run build
```

Restart your MCP host; the tool list refreshes on the next connect. Read
the [`CHANGELOG`](../CHANGELOG.md) for changed settings.

Action1 can change its API independently of this project. `npm run
spec:check` compares the pinned spec with the one Action1 serves; the
tests only check that the committed spec and the generated tools match
each other. [`CONTRIBUTING.md`](CONTRIBUTING.md#re-running-codegen)
explains how to adopt a new spec.

## Uninstall

- Remove the server entry from your MCP host's configuration (or the
  extension from Claude Desktop).
- Delete the cloned repository (source install).
- Revoke the API credential in the Action1 console if you no longer need
  it.

---

## Frequently asked install questions

### Do I need to clone the repo, or is there a one-click installer?

1. **MCPB bundle (Claude Desktop only)**: download the `.mcpb` from the
   GitHub Release and double-click it. No terminal needed.
2. **npm (`npx -y action1-mcp-server`)**: any stdio host, no clone or
   build; needs Node.js.
3. **Clone and build**: to run a version ahead of the latest release, or
   to change the code.

### Does the server stay running, or does it start per call?

stdio mode: one process per MCP host connection, alive while the host is
connected. HTTP mode: one long-running process serves many clients and
creates a fresh MCP server instance per request.

### Where does the server log?

Always to **stderr**; stdout is reserved for MCP JSON-RPC. To see the
logs:

- Claude Code: start it with `claude --debug`.
- Claude Desktop: the MCP log files in `~/Library/Logs/Claude/` (macOS)
  or `%APPDATA%\Claude\logs` (Windows).
- HTTP mode: the process output (`journalctl -u action1-mcp`, ...).

Set `ACTION1_LOG_LEVEL=debug` for more detail.

### Can I run multiple instances at once?

Yes. Each instance needs its own environment and, in HTTP mode, its own
port. This connects two Action1 organizations or credentials to the same
host; register them under different names (`action1-prod`,
`action1-staging`).

### How do I check the install worked without a chat?

```bash
npx -y @modelcontextprotocol/inspector@2.12.0 --cli \
  node --env-file=.env dist/index.js --method tools/list | jq '.tools | length'
```

A non-zero number means the server starts and registers its tools.

### Can I hide the generated tools and only use the curated ones?

Yes: `ACTION1_TOOLSETS=curated`. `ACTION1_TOOLSETS=read` keeps only
read-only tools, and `curated,read` combines both.

### Can I add my own tools?

Yes, see [`CONTRIBUTING.md`](CONTRIBUTING.md). Either fork or build your
own server around this one's `Action1Client`.

## Other resources

- [`USAGE.md`](USAGE.md): what each tool does.
- [`EXAMPLES.md`](EXAMPLES.md): copy-paste recipes.
- [`FAQ.md`](FAQ.md): questions across topics.
- [`DEPLOYMENT.md`](DEPLOYMENT.md): production hosting.
- [`SECURITY.md`](SECURITY.md): threat model and safeguards.
- [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md): failure modes.
