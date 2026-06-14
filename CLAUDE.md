# CLAUDE.md — Agent Setup Instructions

> **Audience**: an AI coding agent (Claude in Claude Code, Cursor, etc.)
> that the human owner has pointed at this repo with a request like
> *"set this MCP up in my Claude Desktop"*.
>
> **Read this file fully before doing anything else.** Then execute the
> steps in order. Stop and ask the user only at the explicit points
> marked **`ASK USER`**.

---

## What this repo is

A Model Context Protocol (MCP) server that wraps the **Action1 RMM** REST
API. It exposes 166 tools (33 curated incl. 6 workflow wrappers + 133
auto-generated): PowerShell on Windows, Bash on macOS, deploy
updates, reboot endpoints, audit log search, CVE remediation, etc. to
any MCP host. The end goal of this setup is: **the user's Claude Desktop
gets the Action1 tools and the user can drive their fleet by chat.**

Project version, full feature list, and architecture: see
[`README.md`](README.md). Human install walkthrough: see
[`docs/INSTALLATION.md`](docs/INSTALLATION.md). This file is the
**agent-driven shortcut** of that walkthrough.

---

## Goal of this setup

Produce a single installable `.mcpb` bundle, install it into the user's
Claude Desktop, and verify it works. After this is done, the user can
chat with Claude Desktop and have Action1 tools available.

---

## Prerequisites (verify before building)

Run these checks. If anything is missing, **`ASK USER`** to install it
before proceeding — do **not** attempt to install Node or Claude Desktop
on the user's machine yourself.

```bash
node -v          # must print v20.x or higher
git --version    # any recent version
# Claude Desktop must already be installed (macOS/Windows app)
```

If `node -v` is < 20, stop and tell the user to install Node 20+ from
<https://nodejs.org> or via their package manager. Do not proceed.

---

## Step 1 — Build the MCPB bundle

Assuming the user has already cloned the repo (this file is in it), and
you are running in the repo root:

```bash
npm install
npm run build:mcpb
```

Expected output: a file at `dist/action1-mcp-<version>.mcpb` (e.g.
`dist/action1-mcp-0.5.0.mcpb`). The script prints the path on the last
line. Capture it for the next step.

If `npm install` fails: the user is offline, behind a corporate proxy,
or missing build tools. **`ASK USER`** to diagnose; do not retry blindly.

If `npm run build:mcpb` fails because `dist/` is empty: the script
auto-runs `npm run build` first, so this should not happen. If it
does, run `npm run build && npm run build:mcpb` manually.

---

## Step 2 — Collect Action1 credentials from the user

The bundle will prompt for these in a wizard, but **you should collect
them now** so the user is not blocked mid-install. **`ASK USER`** these
five values, in this order, with these exact hints:

| # | Field | Hint to give the user |
|---|---|---|
| 1 | **Action1 API base URL** | "EU instance? Use `https://app.eu.action1.com/api/3.0` (default). US? Use `https://app.action1.com/api/3.0`." |
| 2 | **Organization ID (UUID)** | "Log into the Action1 console. The URL contains the org UUID after `/org/`. Copy that." |
| 3 | **API client ID** | "Action1 console → Settings → API Credentials → create or copy an existing one. Looks like `api-key-…@action1.com`." |
| 4 | **API client secret** | "Shown **once** when the credential is created. If the user lost it, they must create a new credential — Action1 cannot recover it." |
| 5 | **Allow destructive ops?** | "`false` = read-only (recommended for first try). `true` = allow run-script / deploy / reboot tools to actually execute (still requires per-call `confirm: \"YES\"` and `dry_run: false`)." |

**Never write these values to any file in this repo.** They go into the
Claude Desktop wizard in Step 3 and live in Claude Desktop's own keychain
storage from there.

---

## Step 3 — Install the bundle into Claude Desktop

The `.mcpb` file from Step 1 is a self-contained Claude Desktop extension.
Tell the user to do **one** of:

- **Easiest**: double-click `dist/action1-mcp-<version>.mcpb` in
  Finder / Explorer.
- **Alternative**: drag the file onto the Claude Desktop window.
- **Alternative**: in Claude Desktop, open **Settings → Extensions →
  Install from file** and pick the `.mcpb`.

A wizard opens. The user fills in the five values from Step 2 and clicks
*Install*. Sensitive fields (client ID, client secret) are masked.

If Claude Desktop does not recognise `.mcpb` files: the user is on an
outdated version. Tell them to update Claude Desktop, then retry.

---

## Step 4 — Verify

After install, tell the user to:

1. **Restart Claude Desktop** (the connector menu refreshes on launch).
2. Open a new chat and ask: *"List the Action1 MCP tools you have."*
3. Expect 166 tools, all prefixed `action1_*`.
4. Run a read-only smoke test: *"Run `action1_list_organizations` and
   show me the result."* It should return the user's Action1 orgs.

If Step 4.3 returns 0 tools: the bundle did not install. Re-open Settings
→ Extensions and check that Action1 RMM is enabled.

If Step 4.4 returns a `401` / auth error: the client ID or secret is
wrong. Tell the user to re-open Settings → Extensions → Action1 RMM →
Configure, and re-enter the credentials.

If Step 4.4 returns a `403`: the API key lacks the required Action1
role. The user must grant their key the `view_organizations` permission
in Action1 console.

---

## Updating later

When the user wants the latest version of this MCP:

```bash
git pull
npm install
npm run build:mcpb
```

Then re-install the new `.mcpb` via Claude Desktop → Settings →
Extensions. Stored credentials carry over; the wizard will not re-prompt.

---

## What you should NOT do

- **Do not** create or modify any `.env` file in this repo. The MCPB
  install path uses Claude Desktop's own credential storage, not `.env`.
- **Do not** edit `claude_desktop_config.json` manually. That is the
  Option B path documented for power users in `docs/INSTALLATION.md`;
  this MCPB path is cleaner and what the user wants.
- **Do not** commit any secret you have collected from the user.
- **Do not** flip `ACTION1_ALLOW_DESTRUCTIVE` to `true` without explicit
  user consent. Default is `false` for a reason — the user can change
  it later in the Extensions UI.
- **Do not** try to test destructive tools (run script, deploy, reboot)
  during verification. Stick to read-only smoke tests.

---

## If anything goes wrong

1. Capture the exact error message (stderr from `npm`, error dialog
   from Claude Desktop).
2. Cross-check against [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).
3. If still stuck: tell the user, share the error, and ask whether to
   open an issue at <https://github.com/mguttmann/action1-mcp/issues>.

---

## Quick reference

| What | Where |
|---|---|
| Human install guide | [`docs/INSTALLATION.md`](docs/INSTALLATION.md) |
| Tool reference | [`docs/USAGE.md`](docs/USAGE.md) |
| End-to-end examples | [`docs/EXAMPLES.md`](docs/EXAMPLES.md) |
| Security / destructive guard | [`docs/SECURITY.md`](docs/SECURITY.md) |
| Troubleshooting | [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) |
| FAQ | [`docs/FAQ.md`](docs/FAQ.md) |
