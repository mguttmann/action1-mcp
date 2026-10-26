# CLAUDE.md: Agent Setup Instructions

> **Audience**: an AI coding agent (Claude Code, Cursor, etc.) that the
> owner of this checkout has pointed at the repo with a request like
> *"set this MCP up in my Claude Desktop"*.
>
> **When the user asks for that setup,** read this file fully before
> doing anything else, then execute the steps in order. Stop and ask the
> user only at the points marked **`ASK USER`**. For development work on
> the code itself, follow [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md)
> instead; the setup rules below (no `.env`, no tests of state-changing
> tools) apply to the setup only.

---

## What this repo is

An unofficial Model Context Protocol (MCP) server for the **Action1 RMM**
REST API (not affiliated with or endorsed by Action1). It exposes
`action1_*` tools to any MCP host: PowerShell on Windows, Bash on macOS,
update deployment, endpoint reboots, audit log search, CVE remediation
and every other operation of the Action1 API. The goal of this setup:
**the user's Claude Desktop gets the Action1 tools and the user can query
and manage their fleet by chat.**

Feature list and architecture: [`README.md`](README.md). Human install
walkthrough: [`docs/INSTALLATION.md`](docs/INSTALLATION.md). This file is
the agent-driven shortcut of that walkthrough.

**This server can run code on every managed endpoint.** Treat the
Action1 credentials like domain-admin passwords.

---

## Goal of this setup

Get an installable `.mcpb` bundle, install it into the user's Claude
Desktop and verify it works with a read-only call.

---

## Prerequisites (verify before building)

Run these checks. If anything is missing, **`ASK USER`** to install it.
Do **not** install Node or Claude Desktop on the user's machine yourself.

```bash
node -v          # must be v22.12 or newer
git --version    # any recent version
# Claude Desktop must already be installed (macOS or Windows app)
```

If `node -v` is below v22.12, stop and tell the user to install a
current LTS release (Node 22.12 or newer, or 24) from
<https://nodejs.org> or their package manager.

If the user only wants to install a released version, building is not
needed: the `.mcpb` for each release is attached to the project's GitHub
Releases page. Ask whether they prefer that before building.

---

## Step 1: Build the MCPB bundle

In the repo root:

```bash
npm ci
npm run build:mcpb
```

Expected output: `dist/action1-mcp-<version>.mcpb`. The script prints the
path on its last lines; capture it for Step 3.

If `npm ci` fails: the user is offline, behind a corporate proxy, or
missing build tools. **`ASK USER`** to diagnose; do not retry blindly.

`npm run build:mcpb` always does a clean build (it wipes `dist/` and
compiles from scratch) and installs the bundle's runtime dependencies
from `package-lock.json`, so it needs registry access just like
`npm ci`.

---

## Step 2: Prepare the credentials (never through the chat)

The bundle's install wizard asks for the credentials itself and stores
the sensitive ones in Claude Desktop's secure storage. **Never ask the
user to paste the API client ID or client secret into the chat, never
read them from a file, and never accept them if the user offers them.**
Anything typed into the chat ends up in transcripts and logs; this
credential can run code on the whole fleet.

Tell the user to have these ready for the wizard in Step 3:

| # | Wizard field | What to tell the user |
|---|---|---|
| 1 | **Action1 API base URL** | Their region: Europe `https://app.eu.action1.com/api/3.0` (default), North America `https://app.action1.com/api/3.0`, North America 2 `https://app.na-2.action1.com/api/3.0`, United Kingdom `https://app.uk.action1.com/api/3.0`, Australia `https://app.au.action1.com/api/3.0`. |
| 2 | **Organization ID (UUID)** | In the Action1 console, the URL contains the organization UUID. Not a secret, but there is no need to share it with you either. |
| 3 | **API client ID** | Action1 console > Settings > API Credentials: create a credential or use an existing one. Looks like `api-key-...@action1.com`. Type it only into the wizard. |
| 4 | **API client secret** | Shown **once** when the credential is created; if it is lost, create a new credential. Type it only into the wizard. |
| 5 | **Allow destructive operations** | A checkbox. Leave it unchecked (read-only) for the first install. Checked, tools that change state may execute, still only with per-call `confirm: "YES"` and `dry_run: false`. |

Recommend a credential whose Action1 role has only the permissions the
user needs ([`docs/permissions.md`](docs/permissions.md) lists them per
tool). A read-only role is enough for a first test.

**If the client ID or secret was ever pasted into a chat** (this one or
any other), tell the user to treat it as exposed: create a new API
credential in the Action1 console, use the new one in the wizard, and
delete the old one.

Never write credentials to any file in this repo and never commit them.

---

## Step 3: Install the bundle into Claude Desktop

Tell the user to do **one** of:

- Double-click `dist/action1-mcp-<version>.mcpb` in Finder / Explorer.
- Drag the file onto the Claude Desktop window.
- In Claude Desktop, open **Settings > Extensions > Install from file**
  and pick the `.mcpb`.

The wizard opens. The user fills in the fields from Step 2 and clicks
*Install*. The client ID and secret fields are masked.

If Claude Desktop does not recognise `.mcpb` files, the user is on an
outdated version: update Claude Desktop, then retry.

---

## Step 4: Verify

Tell the user to:

1. **Restart Claude Desktop** (the connector list refreshes on launch).
2. Open a new chat and ask: *"List the Action1 MCP tools you have."*
3. Expect a long list of tools, all prefixed `action1_`.
4. Run a read-only smoke test: *"Run `action1_list_organizations` and show
   me the result."* It should return the user's Action1 organizations.

If step 3 returns no tools: the bundle did not install. Re-open
Settings > Extensions and check that the Action1 extension is enabled.

If step 4 returns a `401` / auth error: the client ID or secret is wrong,
or the base URL is for another region. Tell the user to open Settings >
Extensions > the Action1 extension > Configure and re-enter the values
(again directly in the dialog, not in the chat).

If step 4 returns a `403`: the credential's role lacks a permission for
that call. Point the user to [`docs/permissions.md`](docs/permissions.md)
and have them check the role in the Action1 console. Asking Claude to
read the `action1://me` resource or to run the `/check-my-permissions`
prompt shows which permissions the role has.

---

## Updating later

When the user wants the latest version:

```bash
git pull
npm ci
npm run build:mcpb
```

Then re-install the new `.mcpb` via Claude Desktop > Settings >
Extensions. Stored settings carry over; the wizard does not ask again.

---

## What you should NOT do

- **Do not** ask for, read, store or repeat the Action1 client ID or
  client secret. They go into the wizard only.
- **Do not** create or modify any `.env` file in this repo. The MCPB path
  uses Claude Desktop's own storage.
- **Do not** edit `claude_desktop_config.json` manually. That is the
  power-user path in `docs/INSTALLATION.md`; the MCPB path is what the
  user wants.
- **Do not** check "Allow destructive operations" without the user's
  explicit decision; unchecked is the safe default and can be changed
  later in the Extensions UI.
- **Do not** test tools that change state (run script, deploy, reboot)
  during verification. Stick to read-only calls.
- **Do not** install anything named like this project from npm; it is
  not published there.

---

## If anything goes wrong

1. Capture the exact error message (stderr from `npm`, the error dialog
   from Claude Desktop). Remove credentials and customer data from it.
2. Check [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).
3. If still stuck: tell the user, share the redacted error, and ask
   whether to open an issue at
   <https://github.com/mguttmann/action1-mcp/issues>.

---

## Quick reference

| What | Where |
|---|---|
| Human install guide | [`docs/INSTALLATION.md`](docs/INSTALLATION.md) |
| Tool reference | [`docs/USAGE.md`](docs/USAGE.md) |
| End-to-end examples | [`docs/EXAMPLES.md`](docs/EXAMPLES.md) |
| Permissions per tool | [`docs/permissions.md`](docs/permissions.md) |
| Security and destructive guard | [`docs/SECURITY.md`](docs/SECURITY.md) |
| Troubleshooting | [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) |
| FAQ | [`docs/FAQ.md`](docs/FAQ.md) |
