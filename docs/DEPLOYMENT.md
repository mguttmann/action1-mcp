# Deployment Guide

This server runs in two modes — **stdio** for local single-user use, and
**Streamable HTTP** for hosted multi-user / shared-team setups. Pick the
section that matches your topology.

## Decision matrix

| Use case | Recommended | Why |
|---|---|---|
| One developer using Claude Code or Cursor on their workstation | **stdio** locally | Zero infra, credentials stay on the user's box. |
| One MSP team using Claude.ai / Claude Desktop with custom connectors | **Streamable HTTP** behind reverse proxy with `MCP_HTTP_TOKEN` and TLS | Single deployment, no per-user setup, central rotation of API key. |
| Non-engineer admins on Claude Desktop | **MCPB bundle** | One-click install in Claude Desktop, no Node required. |

## stdio (local)

The simplest deployment. Each user has the repo cloned, builds it, and points
their MCP host at `dist/index.js`. See [`INSTALLATION.md`](INSTALLATION.md).

## Streamable HTTP (hosted)

Stateless, per-request transport. One process serves many concurrent MCP
clients.

### Bare metal / VM

```bash
git clone https://github.com/mguttmann/action1-mcp.git
cd action1-mcp
npm ci
npm run build
cp .env.example .env  # edit with your Action1 credentials

# Generate a strong shared secret for the MCP endpoint
openssl rand -hex 32 >> .env  # paste as MCP_HTTP_TOKEN=<value>

ACTION1_ALLOW_DESTRUCTIVE=true \
  node --env-file=.env dist/index.js --http --host 0.0.0.0 --port 3000
```

> **Never bind to a public address without `MCP_HTTP_TOKEN` set.** Since
> v0.4.0 the server refuses to start with a clear error message
> (`Refusing to start: HTTP transport binds to non-loopback host '...' without
> a Bearer token. Set MCP_HTTP_TOKEN (>=16 chars, e.g. \`openssl rand -hex
> 32\`), or bind to 127.0.0.1 / localhost.`). Production deployments
> must front the server with a reverse proxy that terminates TLS AND
> set the token explicitly.

### Reverse proxy with TLS (Caddy example)

Recommended for any deployment reachable from outside `127.0.0.1`. Caddy is
the simplest; nginx / traefik / Cloudflare Tunnel work equivalently.

```caddy
mcp.example.com {
  reverse_proxy 127.0.0.1:3000

  # Health check with auth bypass
  @health path /healthz
  handle @health {
    reverse_proxy 127.0.0.1:3000
  }
}
```

Behind that, run the server with `--host 127.0.0.1` so it is only reachable
through the proxy. Connect from Claude.ai with:

- URL: `https://mcp.example.com/mcp`
- Header: `Authorization: Bearer <MCP_HTTP_TOKEN value>`

### systemd unit

`/etc/systemd/system/action1-mcp.service`:

```ini
[Unit]
Description=action1-mcp HTTP transport
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=action1mcp
WorkingDirectory=/opt/action1-mcp
EnvironmentFile=/opt/action1-mcp/.env
ExecStart=/usr/bin/node /opt/action1-mcp/dist/index.js --http --host 127.0.0.1 --port 3000
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/log/action1-mcp

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now action1-mcp
journalctl -u action1-mcp -f
```

## MCPB bundle (for Claude Desktop)

Anthropic's MCPB format packages the server, its dependencies, and the Node
runtime as a single double-clickable installer. Best path for non-engineers
who use Claude Desktop daily.

### Build the bundle

```bash
npm run build:mcpb
```

This runs `scripts/build-mcpb.sh`, which builds `dist/`, stages the
runtime under `mcpb/server/`, and packs the bundle to
`dist/action1-mcp-<version>.mcpb`. The `mcpb/` directory holds the
manifest (`manifest.json`), the icon, and a template `.env` that Claude
Desktop fills in via prompts on first install.

### Distribute

- Email / share-link the `.mcpb` file.
- Recipient double-clicks it. Claude Desktop walks them through the
  per-credential setup.

> Status: MCPB packaging is shipped — the `release.yml` workflow's MCPB
> job builds and attaches `action1-mcp-<version>.mcpb` to every
> `v*.*.*` GitHub Release. See [`mcpb/README.md`](../mcpb/README.md) for
> the manifest layout and local build recipe.

## Cloudflare Workers (planned)

The Streamable HTTP transport is stateless, which makes it a natural fit for
Workers. A Workers-native scaffold is on the roadmap; today the Express
implementation depends on `node:http` and won't run unmodified on Workers.

If you're keen to deploy on Workers now, port `src/index.ts::runHttp` to use
`WebStandardStreamableHTTPServerTransport` from the SDK and a Workers
`fetch` handler. Expect ~50 lines of glue code.

## Production checklist

Before you flip a deployment from "internal smoke test" to "team production":

- [ ] `ACTION1_BASE_URL`, `ACTION1_CLIENT_ID`, `ACTION1_CLIENT_SECRET`,
  `ACTION1_ORG_ID` set from a secret manager (not a `.env` checked into a repo).
- [ ] `MCP_HTTP_TOKEN` set to a 32+ byte random secret.
- [ ] TLS terminated upstream of the server.
- [ ] Bound to `127.0.0.1` (or container loopback) when behind a proxy.
- [ ] `MCP_HTTP_ALLOWED_ORIGINS` set if browser clients (Claude.ai, Claude
  Desktop with web preview) will connect — otherwise leave empty to allow
  non-browser callers and skip the origin check entirely.
- [ ] `ACTION1_ALLOW_DESTRUCTIVE` set deliberately. Default to `false` for
  query-only deployments; set `true` only for environments where running
  PowerShell on Windows endpoints is intended.
- [ ] `ACTION1_LOG_LEVEL=info` in normal operation; bump to `debug` only for
  triage. Log rotation handled by your platform (journald, Loki, etc.).
- [ ] `/healthz` wired into your platform's liveness probe.
- [ ] API credential rotated on a schedule (90 days is a reasonable default).
  Action1 supports rotation without downtime — issue a new credential, update
  `.env`, restart the server, then revoke the old one.
- [ ] Audit log capturing every destructive call. The structured stderr logs
  are JSON; pipe them to your central log store and alert on every
  `destructive_*` event.
- [ ] Backup-and-restore plan for the `.env` (the credentials are the only
  state).

## Updating

```bash
cd /opt/action1-mcp
git fetch && git checkout <new-tag>
npm ci
npm run build
systemctl restart action1-mcp
```

If `tests/unit/specSha.test.ts` fails after a `git pull`, the upstream Action1
spec changed. Read `docs/CONTRIBUTING.md` for the regeneration workflow.

## Rollback

The server is stateless. To roll back, check out the previous tag, rebuild,
and restart. There's no schema migration to undo.

## Observability

The server emits structured JSON-line logs to **stderr** with auto-redaction
for `Bearer <token>`, `api-key-…` patterns, and any property whose key looks
like `authorization` / `*_token` / `*_secret`. Stdout is reserved for MCP
JSON-RPC and never logs.

Pipe stderr to your log aggregator:

```bash
node dist/index.js --http 2>&1 | tee /var/log/action1-mcp/server.log | logger -t action1-mcp
```

Useful event names to alert on:

- `Refusing to start: HTTP transport binds to non-loopback host '...'
  without a Bearer token.` — the server now hard-fails on this
  misconfiguration instead of warn-only-and-continue. Set
  `MCP_HTTP_TOKEN` (>=16 chars) or bind to `127.0.0.1`/`localhost`.
- `http_request_handler_failed` — uncaught error during a request.
- `refresh_token_failed_falling_back_to_client_credentials` — once is fine
  (e.g. after rotation); a flood means Action1 is rejecting your
  client_credentials, check the secret.
