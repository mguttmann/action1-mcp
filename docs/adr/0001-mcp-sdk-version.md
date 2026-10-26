# ADR 0001: MCP TypeScript SDK v2, zod 4, Node runtime floor

- Status: accepted
- Date: 2026-10-26

## Context

v0.5.0 pinned `@modelcontextprotocol/sdk` 1.29.0 (range `^1.0.4`) and
`zod` 3.25. Both carried open advisories (SDK GHSA-46jr-4wx8-v453 and
GHSA-f897-62hf-6gxq, zod GHSA-mrhx-c7xc-m3w5, whose fix exists only in
zod 4). Two options:

- **A:** SDK v2 (`@modelcontextprotocol/server` + `@modelcontextprotocol/node`,
  zod 4). Stable since 2.0.0 (2026-07-27); implements the 2026-07-28 MCP
  spec as an opt-in and stays maintained.
- **B:** latest SDK v1 (1.32.x). v1 only receives security fixes until
  about 2027-01-27.

A was allowed only if all of these held. Each was checked:

1. **v2 is stable and the migration covers what this repo uses.**
   `@modelcontextprotocol/server` 2.4.0 is `latest` on npm. The official
   codemod (`@modelcontextprotocol/codemod` 2.4.0, `v1-to-v2`) migrated
   imports, `registerTool` (input, output schema, annotations),
   `registerResource` with `ResourceTemplate`, `registerPrompt`,
   handler context (`extra.signal` to `ctx.mcpReq.signal`), the stdio
   transport, `InMemoryTransport` for tests, and the stateless Streamable
   HTTP transport (`NodeStreamableHTTPServerTransport` with
   `sessionIdGenerator: undefined` and `enableJsonResponse: true`). The
   remaining manual work was zod 4 API changes (`z.record` needs a key
   schema) and the code generator.
2. **Older protocol revisions keep working.** A production stdio
   consumer sends `protocolVersion: "2025-11-25"` and accepts 2024-11-05,
   2025-03-26, 2025-06-18 and 2025-11-25. SDK v2 lists 2025-11-25,
   2025-06-18, 2025-03-26, 2024-11-05 and 2024-10-07 as supported.
   `tests/integration/protocolVersions.test.ts` initializes with
   2025-06-18 and 2025-11-25 and expects the same revision back. A manual
   end-to-end run of that consumer against the built stdio server
   negotiated 2025-11-25, listed all tools and validated the structured
   output of a tool call against its output schema.
3. **Same tool surface, all tests green.** `tools/list` was captured from
   the v0.5.0 build before any change
   (`tests/fixtures/tools-list.baseline.json`, written by
   `scripts/tools-list-snapshot.mjs`). After the migration the snapshot
   (tool names, input property names, required lists, annotations,
   output schema presence, resources, resource templates, prompts) is
   identical, and the full test suite passes.
   `tests/integration/toolsListBaseline.test.ts` keeps failing on a
   breaking change against that snapshot (a removed tool, input property,
   resource or prompt argument, a new required input, a changed
   annotation, a dropped output schema); additions pass.

## Decision

Option A: SDK v2 (`@modelcontextprotocol/server` ^2.4.0,
`@modelcontextprotocol/node` ^2.1.2, `@modelcontextprotocol/client` as a
dev dependency for tests) with zod ^4.6.7.

- The server keeps `server.connect(...)`, so it negotiates the 2025-era
  revisions only. Serving 2026-07-28 (`serveStdio` / `createMcpHandler`)
  is a later, separate change; it must keep accepting the older
  revisions. (Done in 0.6.0, see "Serving 2026-07-28" below.)
- `maxToolInputElements` is set (`MAX_TOOL_INPUT_ELEMENTS` in
  `src/server.ts`), because the SDK only applies the GHSA-46jr fix when a
  cap is configured.
- Express stays on 4.x (supported upstream; SDK v2 no longer pulls in
  Express 5, so only one Express major is in the tree) with
  `@types/express` 4.

### Node baseline

Superseded by "Node baseline 22.12 (2026-10-26)" below.

Node 20 is end of life since 2026-04-30, and the plan was to declare
`>=22.12`. At first `engines.node` stayed `>=20` instead, so that a
consumer building this server from source on Node 20 kept working: CI
tested 20, 22 and 24, codegen and release built on Node 24, and dev
tooling that requires Node 22 or newer (vitest 5) was not adopted.

## Consequences

- Advertised JSON schemas now use draft 2020-12 (`$schema`). The v1-only
  `execution.taskSupport` field is gone from `tools/list`. (A later change
  in 0.6.0 made tool inputs strict: unknown arguments are rejected and the
  input schemas carry `additionalProperties: false` again.)
- The MCP `logging` capability and `logging/setLevel` were dropped in a
  later change in 0.6.0 (deprecated in MCP 2026-07-28; the server never
  sent log notifications). Logs go to stderr only.
- Validation error texts follow zod 4 wording.
- `npm audit --omit=dev` reports 0 vulnerabilities; CI enforces
  `--audit-level=high` for runtime dependencies.
- The undocumented `overrides` for `esbuild` and `hono` are removed: the
  regular resolution already lands on versions without advisories, and
  `npm audit` guards against regressions.
- v2 support for Node 20 is declared by the SDK (`engines >=20`); if a
  later SDK release drops Node 20, the Node 20 constraint above blocks
  that upgrade. (Moot since the addendum "Node baseline 22.12" below.)

## Serving 2026-07-28 (2026-10-26)

SDK 2.4.0 serves the 2026-07-28 revision (`server/discover`, the
per-request `_meta` envelope) through two entries that also serve the
2025 revisions from the same server factory:

- **stdio:** `serveStdio(factory, { legacy: "serve" })` replaces
  `server.connect(new StdioServerTransport())` (`startStdio` in
  `src/index.ts`). The client's opening message decides the era: an
  `initialize` request pins the connection to a 2025-era instance, served
  exactly as the hand-wired transport served it; a 2026-07-28 opening
  gets a modern instance. Both instances share one Action1 client.
- **HTTP:** `POST /mcp` keeps the existing middleware (rate limit,
  Host/Origin, bearer token, 1 MB JSON body). After that, `isLegacyRequest`
  routes 2025-era requests to the unchanged stateless
  `NodeStreamableHTTPServerTransport` with JSON responses, and everything
  else to `createMcpHandler(factory, { legacy: "reject" })`. The caller
  identity for the audit log reaches the modern factory through
  `authInfo.extra`.

Proof that older clients keep working:
`tests/integration/protocolVersions.test.ts` drives the real stdio
wiring with raw `initialize` requests for 2025-06-18 and 2025-11-25
(same revision back, tools/list served) and a client pinned to
2026-07-28 (tools/list, a tool call with the server's request context
and audit instrumentation). `tests/integration/httpModernProtocol.test.ts`
does the same over HTTP for a 2025 client and a pinned 2026-07-28
client, including the bearer check, and
`tests/integration/httpTransport.test.ts` keeps covering the 2025 HTTP
path unchanged. Not verified here: a manual run of the production
stdio consumer against this build; it sends `initialize` with
2025-11-25, which is the path the tests cover.

## Node baseline 22.12 (2026-10-26)

Node 20 is end of life since 2026-04-30, so the Node 20 constraint in
"Node baseline" above is dropped. The decision rests on that end of
life alone: a consumer that still runs Node 20 stays on 0.5.x until it
moves to Node 22.12 or newer.

Decision:

- `engines.node` is `>=22.12` in `package.json`, the lockfile root and
  the MCPB manifest (`compatibility.runtimes.node`, held to `engines` by
  `tests/unit/mcpbManifest.test.ts`). 22.12 is the oldest release the
  test runner supports (vitest 5: `^22.12.0 || ^24.0.0 || >=26.0.0`).
  The lint tooling needs a little more (ESLint 10: Node 22.13 or newer
  on the 22 line); the runtime floor is unaffected, see
  `docs/CONTRIBUTING.md`.
- CI tests Node 22, 24 and 26, and the `node-floor` job builds, tests
  and starts the server on exactly 22.12; the production install check
  (`deploy-path`) runs on 22, the oldest supported line; E2E runs on 22
  and 24; codegen, coverage and release stay on 24.
- vitest 5 and `@vitest/coverage-v8` 5 replace vitest 4;
  `@types/node` follows the oldest supported line (22).
- TypeScript stays on 6.0: typescript-eslint 8.72 supports TypeScript
  below 6.1 only.

The consequence about SDK support for Node 20 above is moot: the SDK
declares `engines >=20`, which includes the new floor.
