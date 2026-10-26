# Deployment Guide

The server runs in two modes: **stdio** for local single-user use, and
**Streamable HTTP** for a shared deployment. Claude Desktop users can also
install the **MCPB bundle**. Pick the section that matches your setup.

## Decision matrix

| Use case | Recommended | Why |
|---|---|---|
| One person using Claude Code or Cursor on their workstation | **stdio** locally | No infrastructure; credentials stay on the user's machine. |
| A team using Claude.ai or another remote MCP client | **Streamable HTTP** on loopback behind a TLS reverse proxy | One deployment, one credential to rotate. Every client shares that credential (not multi-tenant). |
| Admins on Claude Desktop | **MCPB bundle** | Installed from a file; Claude Desktop asks for the settings and provides Node.js. |

## stdio (local)

Each user clones and builds the repo and points their MCP host at
`dist/index.js`. See [`INSTALLATION.md`](INSTALLATION.md).

## Streamable HTTP (hosted)

Stateless transport: one process serves many MCP clients. It always
requires a bearer token and checks the `Host` and `Origin` headers (see
[`SECURITY.md`](SECURITY.md#dns-rebinding-and-origin-validation)).

### Bare metal / VM

```bash
git clone https://github.com/mguttmann/action1-mcp.git
cd action1-mcp
git checkout v<version>            # a release tag
npm ci
npm run build
npm prune --omit=dev               # drop the build and test tooling
cp .env.example .env
chmod 600 .env
# Fill in ACTION1_BASE_URL, ACTION1_CLIENT_ID, ACTION1_CLIENT_SECRET,
# ACTION1_ORG_ID and ACTION1_ALLOWED_ORG_IDS in .env.

# Generate the shared secret for the MCP endpoint (GNU sed)
sed -i "s/^MCP_HTTP_TOKEN=.*/MCP_HTTP_TOKEN=$(openssl rand -hex 32)/" .env

node --env-file=.env dist/index.js --http --host 127.0.0.1 --port 3000
```

Check it from the same machine:

```bash
curl -s http://127.0.0.1:3000/healthz
# {"ok":true,"service":"action1-mcp-server","version":"<version>"}
curl -s http://127.0.0.1:3000/readyz
# {"ready":true,"service":"action1-mcp-server","version":"<version>","checks":{"config":"ok","token":"not_acquired"}}
```

`/healthz` is liveness (the process answers). `/readyz` is readiness: it
answers 503 with `ready: false` when the configuration no longer loads
(`checks.config: "invalid"`) or the most recent Action1 token request
failed and no valid token is cached (`checks.token: "failing"`).
`checks.token` is `not_acquired` until the first tool call fetches a
token, then `cached`. Neither endpoint calls Action1 or shows error
details; the cause of a failing token is in the log.

This starts read-only: `ACTION1_ALLOW_DESTRUCTIVE` is not set, so every
tool that changes state only returns previews. Turn it on only for a
deployment that is meant to change your fleet, and never on a server
reachable without TLS and the token.

The server refuses to start when the HTTP settings are unsafe:

- No `MCP_HTTP_TOKEN`:
  `Refusing to start: HTTP transport requires MCP_HTTP_TOKEN (>= 16 chars, ...)`.
  `MCP_HTTP_ALLOW_NO_AUTH=true` is accepted only on a loopback bind, for
  local development.
- A wildcard bind (`0.0.0.0`, `::`) without `MCP_HTTP_ALLOWED_HOSTS`:
  `Refusing to start: HTTP transport binds to the wildcard address ...`.

### Reverse proxy with TLS (Caddy example)

Put a TLS-terminating reverse proxy in front and keep the server on
`127.0.0.1`. Caddy is the shortest; nginx, traefik or Cloudflare Tunnel
work the same way.

```caddy
mcp.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Add to `.env`:

```dotenv
# The name clients use. Caddy forwards the original Host header.
MCP_HTTP_ALLOWED_HOSTS=mcp.example.com
# The proxy on this machine is the only client of the server; trust its
# X-Forwarded-For so the per-IP rate limit sees real client addresses.
TRUST_PROXY=loopback
```

Without `TRUST_PROXY`, every request seems to come from `127.0.0.1` and
all users share one rate-limit bucket (60 requests per minute). Set it
only when the proxy is the only way to reach the server.

With nginx, either forward the original host (`proxy_set_header Host
$host;`) and list it in `MCP_HTTP_ALLOWED_HOSTS`, or leave nginx's default
(`Host: 127.0.0.1:3000`), which the server accepts as its bind address.

If browser-based clients connect directly, add their exact origins to
`MCP_HTTP_ALLOWED_ORIGINS`; otherwise only loopback origins are accepted.
Clients that send no `Origin` header are not affected.

Connect from Claude.ai (Settings > Connectors > Add custom connector) or
another remote client with:

- URL: `https://mcp.example.com/mcp`
- Header: `Authorization: Bearer <MCP_HTTP_TOKEN value>`

### systemd unit

Keep the settings in a root-owned file that only systemd reads:

```bash
sudo install -d -m 700 /etc/action1-mcp
sudo install -m 600 -o root -g root /opt/action1-mcp/.env /etc/action1-mcp/env
```

`EnvironmentFile` takes plain `KEY=value` lines. Comments must be on their
own line (a `#` after a value becomes part of the value), and values are
not shell-expanded.

`/etc/systemd/system/action1-mcp.service`:

```ini
[Unit]
Description=action1-mcp HTTP transport
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=action1mcp
Group=action1mcp
WorkingDirectory=/opt/action1-mcp
EnvironmentFile=/etc/action1-mcp/env
ExecStart=/usr/bin/node /opt/action1-mcp/dist/index.js --http --host 127.0.0.1 --port 3000
Restart=on-failure
RestartSec=5s

# Hardening. Logs go to stderr (journald), so nothing needs write access.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallArchitectures=native
SystemCallFilter=@system-service
# Do not add MemoryDenyWriteExecute=true: Node's JIT needs it off.

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --home /opt/action1-mcp --shell /usr/sbin/nologin action1mcp
sudo systemctl daemon-reload
sudo systemctl enable --now action1-mcp
journalctl -u action1-mcp -f
systemd-analyze security action1-mcp   # review the remaining exposure
```

The hardening directives are a starting point; check them against your
distribution's systemd version.

## MCPB bundle (for Claude Desktop)

An MCPB bundle is a zip file that Claude Desktop installs as an extension.
Claude Desktop runs it with its built-in Node.js runtime and asks the user
for the settings declared in `mcpb/manifest.json` (base URL, organization
ID, client ID, client secret, allow-destructive checkbox). Account
operations, the organization allowlist and the other optional switches
are not exposed in the bundle, so they stay at their defaults.

### Build the bundle

```bash
npm ci
npm run build:mcpb
```

This runs `scripts/build-mcpb.sh`, which wipes and rebuilds `dist/`,
stages the bundle under `build/mcpb/` (manifest, `mcpb/README.md`,
`LICENSE`, `NOTICE`, a generated `THIRD_PARTY_NOTICES.md`, the compiled
server and its runtime dependencies installed with
`npm ci --omit=dev --ignore-scripts` from `package-lock.json`) and packs
it to `dist/action1-mcp-<version>.mcpb`. The `mcpb/` directory holds
only the manifest (`manifest.json`) and its README; Claude Desktop asks
for the credentials through the manifest's `user_config` fields on
install. The bundle contains no Node.js runtime and no credentials.

### Distribute

- The `release.yml` workflow builds the bundle and attaches
  `action1-mcp-<version>.mcpb` to the GitHub Release of every `v*.*.*`
  tag.
- Users double-click the file; Claude Desktop walks them through the
  settings.

See [`mcpb/README.md`](../mcpb/README.md) for the manifest layout.

## Cloudflare Workers (not supported)

The HTTP transport is stateless, which suits Workers, but the current
implementation (`src/http.ts`) is built on Express and `node:http` and does
not run on Workers unmodified. A port would replace `createHttpApp` with a
Workers `fetch` handler around `WebStandardStreamableHTTPServerTransport`
from `@modelcontextprotocol/server` and keep the same Host, Origin and
token checks.

## Production checklist

Before a shared deployment goes live:

- [ ] `ACTION1_BASE_URL`, `ACTION1_CLIENT_ID`, `ACTION1_CLIENT_SECRET`,
  `ACTION1_ORG_ID` come from a secret store or a root-only file
  (`chmod 600`), never from a repository.
- [ ] The Action1 credential's role has only the permissions the tools
  need ([`permissions.md`](permissions.md)).
- [ ] `ACTION1_ALLOWED_ORG_IDS` lists the organizations this deployment
  may touch.
- [ ] `MCP_HTTP_TOKEN` is 32 random bytes (`openssl rand -hex 32`).
- [ ] TLS is terminated by a reverse proxy; the server binds to
  `127.0.0.1` (or the container's loopback).
- [ ] `MCP_HTTP_ALLOWED_HOSTS` lists the public name, and `TRUST_PROXY`
  matches the proxy setup.
- [ ] `MCP_HTTP_ALLOWED_ORIGINS` is set if browser clients connect
  directly.
- [ ] `ACTION1_ALLOW_DESTRUCTIVE` is set on purpose. Leave it off for
  query-only deployments. `ACTION1_ALLOW_ACCOUNT_OPS` stays off unless
  the deployment must manage users, roles or organizations.
- [ ] `ACTION1_LOG_LEVEL` is set to the volume you want (`info` keeps
  the `tool_call` lines; the `destructive_*` and `http_*` audit lines are
  written at every level). Logs are collected and rotated by your
  platform (journald, Loki, ...).
- [ ] `/healthz` is wired into your liveness probe and `/readyz` into
  your readiness probe or uptime check; both report the version.
- [ ] Alerts on `destructive_executed`, `destructive_refused`, `critical`
  lines and repeated `tool_call` errors (see [Observability](#observability)).
- [ ] The API credential is rotated on a schedule (90 days is a
  reasonable default): issue a new one, update the configuration,
  restart, revoke the old one.
- [ ] The configuration file is backed up (the credentials are the only
  state).

## Updating

```bash
cd /opt/action1-mcp
git fetch --tags && git checkout v<new-version>
npm ci
npm run build
npm prune --omit=dev
sudo systemctl restart action1-mcp
```

Read the [`CHANGELOG`](../CHANGELOG.md) first: new versions can add
required settings (0.6.0 made `MCP_HTTP_TOKEN` mandatory for `--http`).

`tests/unit/specSha.test.ts` only checks that the committed spec snapshot
and its pinned SHA agree; it does not contact Action1. To find out whether
Action1 serves a different spec, run `npm run spec:check` (exit 1 with a
diff summary on drift). The refresh workflow is in
[`src/codegen/spec/SOURCE.md`](../src/codegen/spec/SOURCE.md).

## Rollback

The server keeps no state. Check out the previous tag, rebuild and
restart.

## Observability

The server writes structured JSON lines to **stderr** with credential
redaction; stdout carries only MCP JSON-RPC. Under systemd, stderr goes
to journald. Elsewhere, pipe it to your log collector:

```bash
node --env-file=.env dist/index.js --http 2>> /var/log/action1-mcp/server.log
```

The event list with fields is in
[`SECURITY.md`](SECURITY.md#logging-and-audit-events). Useful alerts:

- `destructive_executed`: a state change was sent to Action1, with the
  caller and a SHA-256 of the request body. Correlate with the
  `tool_call` line of the same `request_id` for the result.
- `http_auth_failed`, `http_host_rejected`, `http_origin_rejected`,
  `http_rate_limited`: rejected HTTP requests (token guessing, DNS
  rebinding attempts, floods), per client address.
- `destructive_refused`: something tried a state change that the
  configuration does not allow.
- `fatal`, `uncaught_exception`, `unhandled_rejection` (critical): the
  process is failing.
- `http_request_handler_failed`: an HTTP request failed inside the server;
  the client got a generic 500 with the same `correlation_id`.
- `upstream_retry` bursts and `tool_call` lines with `outcome: "error"`:
  Action1 is slow, rate-limiting or failing.
- `refresh_token_failed_falling_back_to_client_credentials`: once is fine
  (for example after rotation); a flood means Action1 rejects the
  credential.
