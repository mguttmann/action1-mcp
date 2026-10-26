# ADR 0004: Stateless Streamable HTTP with mandatory token and Host/Origin checks

- Status: accepted
- Date: 2026-10-26 (token requirement and Host checks changed in 0.6.0)

## Context

Teams want one shared deployment (for Claude.ai custom connectors or a
gateway) instead of a stdio process per user. An HTTP endpoint on
loopback is still reachable from a browser through DNS rebinding, and an
endpoint behind a reverse proxy cannot tell local from remote callers.

## Decision

- **Stateless.** Each `POST /mcp` builds a fresh MCP server instance (the
  SDK binds a server to one transport) that shares one `Action1Client`
  and its token cache. There are no sessions; `GET` and `DELETE` on
  `/mcp` return 405.
- **Token always required.** `--http` refuses to start without
  `MCP_HTTP_TOKEN`, also on loopback. The only exception is the explicit
  `MCP_HTTP_ALLOW_NO_AUTH=true` on a loopback bind for local development.
- **Host and Origin always checked**, before the token: `Host` must be a
  loopback name, the bind address or listed in `MCP_HTTP_ALLOWED_HOSTS`
  (mandatory for wildcard binds); a present `Origin` must be loopback or
  listed in `MCP_HTTP_ALLOWED_ORIGINS`.
- **TLS and public exposure are the proxy's job.** The documented setup is
  a loopback bind behind a TLS reverse proxy with `TRUST_PROXY` set.

## Consequences

- All HTTP clients share one Action1 identity; the deployment is not
  multi-tenant. `ACTION1_ALLOWED_ORG_IDS` limits the organizations.
- 0.6.0 is a breaking change for HTTP users who ran without a token.
- Responses are plain JSON (no server-sent event stream).
