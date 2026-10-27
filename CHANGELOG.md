# Changelog

All notable changes to this project are documented in this file. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project adheres to [Semantic Versioning](https://semver.org).
Before 1.0, a minor version can contain breaking changes; they are listed
first in each release.

## [Unreleased]

## [0.6.2] - 2026-10-27

Release-pipeline fix. No change to tools, settings or behaviour.

### Fixed

- **npm publishing from the release workflow.** `release.yml` passed the
  tarball as `release/action1-mcp-server-*.tgz`, which npm reads as a
  GitHub `owner/repo` shorthand, so the 0.6.1 publish failed and 0.6.1
  exists only as a GitHub release (bundle and tarball), not on npm or in
  the MCP Registry. The path is now `./release/...`, and a test holds the
  `./` prefix. 0.6.2 is the first version published by the workflow with
  provenance.

## [0.6.1] - 2026-10-27

Distribution release: prepares npm distribution and the MCP Registry
listing. No change to tools, settings or behaviour. Its workflow publish
to npm failed, so 0.6.1 is a GitHub release only; see 0.6.2.

### Added

- **npm distribution.** The package is on npm as `action1-mcp-server`
  (0.6.0 was published by hand on 2026-10-27; from 0.6.1 on the release
  workflow publishes with provenance once `NPM_PUBLISH_ENABLED` is set).
  Any stdio MCP host can start it with `npx -y action1-mcp-server`,
  Claude Code with
  `claude mcp add action1 -e ACTION1_BASE_URL=... -- npx -y action1-mcp-server`.
  The MCPB bundle stays the recommended path for Claude Desktop.
- **MCP Registry lists the npm package.** `server.json` has a second
  package (`registryType` `npm`, `action1-mcp-server`, stdio, the same
  environment variables as the bundle), and `package.json` carries
  `mcpName` `io.github.mguttmann/action1-mcp`, which the registry checks
  against the server name. In `release.yml` the `mcp-registry` job now
  runs after `npm-publish` (a skipped publish does not block it). The
  `mcp-registry.yml` workflow sets the version of both packages, waits
  for npm after a publish in the same run, and drops the npm entry when
  npm does not serve the version with the right `mcpName` (publishing
  off, or versions before 0.6.1); its GitHub token is now set on the
  download step only.
- **MCP Registry listing.** `server.json` describes the server for the
  official MCP Registry as `io.github.mguttmann/action1-mcp`, with the
  MCPB release asset (download URL and SHA-256) as its package. The new
  workflow `mcp-registry.yml` publishes it through GitHub OIDC; the
  release workflow calls it for every stable tag after the GitHub
  release, and it can be started by hand for an existing tag. It takes
  version and hash from the release's `SHA256SUMS`, checks the asset
  against them, skips a version the registry already lists and runs a
  `mcp-publisher` pinned by version and SHA-256.
- **Glama listing.** `glama.json` names `mguttmann` as maintainer, so
  the owner can claim the listing on glama.ai.

### Documentation

- README, `docs/INSTALLATION.md` (new Option C: npm), FAQ, DEPLOYMENT,
  SECURITY, `mcpb/README.md` and the agent setup guide `CLAUDE.md` no
  longer say the package is unpublished: they name the npm package, the
  `npx` command for Claude Code and a generic stdio JSON configuration,
  and warn to install only the exact name `action1-mcp-server`.
  Credentials still go only into the MCPB wizard or the user's own
  shell or configuration, never into a chat.
- `docs/maintainers/repo-settings.md`: state of npm publishing (first
  publish by hand, trusted publisher configured, validated by the first
  workflow publish) and the npm entry of the registry listing.

## [0.6.0] - 2026-10-26

Hardening release before the repository goes public: safer defaults for
state changes and the HTTP transport, curated tools bound to the Action1
spec, complete list data, an audit trail, current dependencies without
known runtime advisories, a reproducible release chain, and
documentation that matches the code. Tool names, existing input
parameters, environment variable names, stdio as the default transport
and the default tool set are unchanged; one tool is new.

### Breaking changes

- **HTTP mode requires a token.** `--http` refuses to start without
  `MCP_HTTP_TOKEN`, also on `127.0.0.1`. For local development,
  `MCP_HTTP_ALLOW_NO_AUTH=true` runs without a token on loopback binds
  only and logs a warning. stdio and the MCPB bundle are unaffected.
- **Wildcard HTTP binds** (`0.0.0.0`, `::`) need the new
  `MCP_HTTP_ALLOWED_HOSTS`.
- **Account operations need a second switch.** Changes to users, roles,
  `PATCH /me`, the enterprise account, organizations and subscription
  requests, and every non-GET `action1_raw_request`, also need
  `ACTION1_ALLOW_ACCOUNT_OPS=true`. Without it they are refused at
  execution time; previews still work and the tools stay registered.
- **Strict tool inputs.** Unknown or misspelled arguments (for example
  `confrim`) are rejected with an "Unrecognized key" validation error
  instead of being dropped silently. All documented arguments stay valid.
- **Generated write tools validate the request body against the spec.** A
  body that misses a field the spec marks as required, or uses a value
  outside a spec enum, is rejected before it is sent (for example
  `action1_create_automation_instance` now requires `name`, `endpoints`
  and `actions` items with `template_id` and `name`). Unknown extra keys
  still pass through; PATCH bodies treat every top-level field as
  optional.
- **Generated tool parameters keep the spec enums** that are defined by
  `$ref` (`status`, `reboot_required`, `level`, `platform`, ...); a value
  outside the enum is rejected. `timefrom` / `timeto` accept the
  documented Action1 format `YYYY-MM-DD_HH-MM-SS` or ISO-8601 and are
  sent in the Action1 format.
- **Generated paging inputs are bounded.** `limit` must be an integer
  from 1 to 50000 and `from` an integer from 0; negative, zero or
  fractional values are rejected before the call. (`limit: 0` used to
  return a cursor that never advanced.)
- **Mutations are no longer retried after a 5xx or a connection reset.**
  POST/PUT/PATCH/DELETE from generated tools and `action1_raw_request` are
  retried only on 429 and on network errors before the request was sent,
  so a script, deployment, reboot or created resource cannot run twice.
  The error says the request was not retried and asks to verify the
  resulting state.
- **Every Action1 call has a time limit**, by default 60 s including
  retries (`ACTION1_REQUEST_TIMEOUT_MS`). Before, only the HTTP client
  defaults applied.
- **Redirects are refused.** Token and API requests fail on a 3xx answer
  instead of following it.
- **Cursors are checked.** A cursor that is invalid, truncated, edited, or
  was issued for another tool or other arguments returns an error instead
  of restarting at the first page.
- **Markdown list metadata** is printed as `key: value` lines below the
  table instead of one `_count=... · has_more=..._` line, and a Markdown
  page holds only the rows its table can show. `structuredContent` carries
  the same items as the text; `response_format: "json"` returns larger
  pages.
- **Unsafe API paths are refused** before any request and before the
  dry-run preview: empty segments (empty IDs, `//`, a trailing `/`), dot
  segments (also `%2e`-encoded), IDs containing `/` or `\`, and control
  characters. Resolved URLs must stay under the `ACTION1_BASE_URL` path.
- **Stricter configuration.** `PORT` / `--port` must be 1 to 65535,
  `ACTION1_DEFAULT_TIMEOUT_MINUTES` / `ACTION1_DEFAULT_RETRY_MINUTES`
  integers from 0 to 10080, and `--host` needs a value. These now abort
  startup in every mode, stdio included.
- **Unknown command-line arguments are refused.** An unknown argument or
  an invalid `--port` / `--host` value exits with code 2 and one message
  instead of starting the stdio server (a typo in `--http` used to start
  stdio). The documented launches (no arguments, `--stdio`, `--http`,
  `--port`, `--host`, `--help`, `--version`) are unaffected.
- **`action1_automations_summary` drops `by_template`.** Instance lists
  carry no `actions` (spec, and empty on the live API), so the field was
  always empty.
- **No MCP `logging` capability.** The server no longer advertises it or
  handles `logging/setLevel` (deprecated in MCP 2026-07-28; the server
  never sent log notifications). Logs stay on stderr, controlled by
  `ACTION1_LOG_LEVEL`.
- **`resources/read` failures are JSON-RPC errors** (InternalError with
  the upstream status and hint in `data`; ResourceNotFound for an
  upstream 404) instead of successful content holding an error JSON.
- **Execution tools validate more strictly.** `action1_execute_and_wait`
  `endpoint_id` must be an endpoint UUID (hex digits in either case, also
  in the published pattern); `success_exit_codes` on
  `action1_run_script` and `action1_execute_and_wait` must be digits
  separated by commas; digit-string `timeout_minutes` / `retry_minutes`
  above 10080 are rejected like numeric values.
- **The two package-upload tools** (`action1_init_software_upload`,
  `action1_upload_software_chunk`) return an explanatory error instead of
  sending a malformed request: Action1's upload needs request headers and
  a binary body this server does not send.
- **Node.js 22.12 or newer is required** (`engines.node` `>=22.12`, also
  declared in the MCPB manifest). Node 20, end of life since 2026-04-30,
  is no longer supported. CI tests Node 22, 24 and 26 and the exact
  floor 22.12; the dev tooling moves to vitest 5 (ADR 0001, addendum of
  2026-10-26) and needs Node 22.13 or newer (ESLint 10).

### Security

- All known advisories in runtime dependencies are resolved (MCP SDK
  GHSA-46jr-4wx8-v453 and GHSA-f897-62hf-6gxq, zod GHSA-mrhx-c7xc-m3w5,
  proxy-addr GHSA-jqcg-44mw-7w3h, body-parser CVE-2026-12590, qs, hono,
  fast-uri, ip-address). CI fails when a runtime dependency has a high or
  critical advisory.
- DNS rebinding on the HTTP transport is closed. The `Host` header is
  always checked (loopback names, the bind address and
  `MCP_HTTP_ALLOWED_HOSTS`; the port is ignored), and browser `Origin`
  headers are always checked (`MCP_HTTP_ALLOWED_ORIGINS` when set,
  otherwise loopback origins only). A foreign Host or Origin gets 403,
  with or without a token.
- Token and API requests never follow HTTP redirects
  (`redirect: "error"`), so the client secret, the bearer token and
  mutation bodies cannot reach another origin.
- `tools/call` arguments are capped at 100000 combined array elements and
  object members; larger payloads are rejected as invalid params.
- HTTP 500 responses are generic JSON-RPC errors with a `correlation_id`;
  details appear only in the server log.
- New `ACTION1_ALLOWED_ORG_IDS`: a comma-separated list of organization
  UUIDs. Any other organization (argument, resource URI,
  `action1_raw_request` path, also a query string written into that path
  such as `/endpoints/managed/{orgId}?orgId=...`, org IDs in request
  bodies and queries) is refused, and `ACTION1_ORG_ID` must be on the
  list. For every guarded mutation (curated, generated, raw) the org ids
  in the body are checked at any depth, with org id keys compared
  regardless of case and separators (`orgId`, `Org-ID`,
  `organization-id`, `targetOrganizationId`, `organisation_id`, ...),
  including settings, role and approval scopes. Mutations
  that are not bound to one allowed organization (enterprise paths,
  Enterprise or unbound scope entries) are refused unless
  `ACTION1_ALLOW_ENTERPRISE_OPS=true`; the refusal is logged as
  `destructive_refused` with reason `org_not_allowed`.
- Successful tool results and resource reads mask the values of
  credential-shaped keys (`client_secret`, `password`, `access_token`,
  `api_key`, ...) at any depth. Upstream bodies echoed in error texts (a
  start response without an instance id, the `raw_body` of a
  `no_instance_id` error, the last status of a timed-out poll, the
  response to a failed start of `action1_execute_and_wait`) are masked
  the same way: credentials always, personal data with
  `ACTION1_REDACT_PII`.
- The release workflow runs the full CI workflow on the tag commit,
  refuses tags whose commit is not on main, and never overwrites an
  existing GitHub release. Provenance attestation covers the MCPB, the
  npm tarball and both SBOMs.
- The agent setup guide (`CLAUDE.md`) no longer asks for the Action1
  client ID or secret in the chat; they go only into the Claude Desktop
  wizard, with a rotation hint for secrets that were pasted before.

### Added

- New tool `action1_create_approval` (`POST /updates/{orgId}/approvals`):
  approve or decline update packages in bulk. Destructive and guarded.
- `action1_run_script` accepts an optional `os` (`"windows"` or
  `"macos"`). It is required with `target_type: "EndpointGroup"`; for a
  single endpoint it must match the detected OS.
- `ACTION1_TOOLSETS` (`all`, `read`, `curated`; comma-separated values
  intersect) registers a smaller tool set. The default is still all
  tools.
- `ACTION1_REDACT_PII=true` masks personal data in tool results,
  resource reads and the JSON body of upstream error texts: user names,
  IP addresses (also `*_ip` keys such as `current_ip`), e-mail addresses
  (also `*_email` and `closure_requested_by`), MAC and other addresses
  (`*_address`, such as `external_address`), serial numbers, personal
  names and Active Directory (`AD_*`) fields. A test derives the
  personal-data properties from the vendored spec. Keys are compared
  with spaces and hyphens as `_`, so report row columns such as
  `User Name`, `IP Address` and `Logged On User` are masked too, and the
  matching columns of CSV exports are masked by their header.
- `ACTION1_REQUEST_TIMEOUT_MS` (default 60000) and
  `ACTION1_TOKEN_TIMEOUT_MS` (default 15000, per OAuth attempt). Transient
  token failures are retried a bounded number of times; credential errors
  are not.
- `MCP_HTTP_ALLOWED_HOSTS` and `MCP_HTTP_ALLOW_NO_AUTH` for the HTTP
  transport; `TRUST_PROXY` is part of the validated configuration.
- Operational logging and an audit trail on stderr: one `tool_call` line
  per call (tool, duration, outcome, upstream status, attempts, org,
  caller, error) with a `request_id` shared by every line of that call,
  `upstream_retry` lines, `guard_config` at startup, and the audit events
  `destructive_dry_run`, `destructive_refused` (with reason),
  `destructive_executed` (written right before the state-changing request
  is sent, with `body_sha256` of the request body; never when a
  pre-flight check such as the reboot connectivity probe aborts the
  call), `action_started`, and `http_auth_failed`, `http_host_rejected`,
  `http_origin_rejected` and `http_rate_limited` (throttled per client,
  never the token). The caller is `stdio`, or over HTTP the remote IP,
  user agent and a SHA-256 token id. Audit events are written regardless
  of `ACTION1_LOG_LEVEL`.
- `action1_execute_and_wait` and `action1_wait_for_automation` send MCP
  progress notifications after every poll when the client sends a
  `progressToken`. `action1_execute_and_wait` announces the
  `instance_id` right after the start: in an `action_started` audit line,
  and in a progress notification before the first poll.
- `GET /readyz` readiness endpoint (version, configuration and token
  state, 503 when not ready, no upstream call); `/healthz` reports the
  version.
- Named output-schema fields for generated tools (including the dry-run
  preview fields of destructive tools) and for the curated summary,
  result and plan tools.
- `src/spec`, generated from the spec by `npm run codegen`: the field
  names and enum values the curated tools read, with a contract test that
  checks each of them against the spec.
- `npm run live:shapes` (`scripts/live-shape-check.mjs`): a read-only,
  anonymized check of the record shapes a live tenant returns, for the
  tenant owner to run.
- CycloneDX SBOMs for the MCPB bundle
  (`dist/action1-mcp-<version>.mcpb.cdx.json`) and the npm tarball
  (`dist/action1-mcp-server-<version>.tgz.cdx.json`), both written by
  `scripts/build-mcpb.sh`, attached to GitHub releases and listed in
  `SHA256SUMS`. They carry the SHA-512 hash and registry URL of every
  component and are reproducible: the timestamp comes from
  `SOURCE_DATE_EPOCH`, the serial number is derived from the content.
- `docs/permissions.md`, generated from the permission tags of the pinned
  spec.
- `npm run spec:fetch` and `npm run spec:check`, and a weekly workflow
  that reports when Action1 serves a different spec than the pinned one.
- `--help` lists every environment variable from the same table the
  configuration is validated against; `--version` prints the version.
- Community files: `NOTICE`, `CODE_OF_CONDUCT.md`, issue and pull request
  templates, architecture decision records in `docs/adr/`.

### Changed

- Adopted the current Action1 OpenAPI spec (2026-10-26): one new
  operation, 429 responses, `orgIdOrAll` on more reads, CVSS 4.0 fields,
  and the NA-2 and UK regions in the server list.
- Migrated to the MCP TypeScript SDK v2 (`@modelcontextprotocol/server`,
  `@modelcontextprotocol/node`) and zod 4. The server serves MCP
  revision 2026-07-28 on stdio and HTTP next to the 2025 revisions;
  2025-06-18 and 2025-11-25 clients negotiate as before. Advertised
  schemas use JSON Schema draft 2020-12, integer inputs advertise
  safe-integer bounds, the v1-only `execution.taskSupport` field is gone,
  and validation messages follow zod 4 wording. See
  [ADR 0001](docs/adr/0001-mcp-sdk-version.md).
- HTTP transport: malformed JSON returns 400, a body over 1 MB 413,
  `GET`/`DELETE /mcp` 405 with `Allow: POST`, and a non-JSON content type
  415. JSON-RPC batches larger than 100 messages are rejected.
- Generated write tools carry request-body schemas from the spec;
  generated read tools list the documented response properties in their
  `outputSchema` (values unconstrained, so no response is rejected),
  without descriptions that only repeat a type name. These schemas make
  the `tools/list` answer larger than in 0.5.0; `ACTION1_TOOLSETS`
  registers a smaller set where the context budget matters.
- Paginated generated list tools return `has_more` and `next_cursor` on
  every call. `from` sets the start offset when no cursor is given, and
  `limit` caps the items of one call, also when the API returns more
  items than asked for.
- Generated tool titles are imperative ("List roles"), and descriptions no
  longer cut off complete sentences.
- Every generated POST/PUT/PATCH/DELETE operation is guarded unless it is
  on a reviewed allowlist (empty); the title heuristic is gone.
- Reads (GET/HEAD) also retry on undici header and body timeouts. Errors
  after `action1_execute_and_wait` started an action name the
  `instance_id` and point to `action1_wait_for_automation`.
- Every list walk, curated and generated, follows Action1's ResultPage
  envelope (`next_page` / `total_items`), so a server-capped page size no
  longer ends a walk early. `action1_endpoints_summary`,
  `action1_list_missing_updates`, `action1_list_vulnerabilities` and
  `action1_report_export` (json) stream their data instead of loading it
  all first.
- `action1_list_endpoints` accepts `reboot_required` as `Yes` / `No` in
  any case and sends the spec value, sends `reset_cache` as `Yes` / `No`,
  and describes `filter` as the spec's case-insensitive substring filter.
- `action1_audit_log_search` accepts `from_time` / `to_time` as
  `YYYY-MM-DD_HH-MM-SS` or ISO-8601, sends them to Action1 as `timefrom`
  / `timeto`, and scans a bounded number of pages per call (resumable
  with `next_cursor`).
- The MCPB bundle is listed as "Action1 MCP (Community)" with an
  unofficial-project notice, ships `LICENSE` and `NOTICE`, and shows
  "Allow destructive operations" as a checkbox (a boolean field; a value
  stored by an older bundle is still read). The bundle is bit-for-bit
  reproducible (sorted entries, fixed modes, one timestamp from
  `SOURCE_DATE_EPOCH`, by default the commit time), and its
  `server/package.json` no longer lists devDependencies.
- Configuration errors at start-up print one line per problem (no stack
  trace) before the JSON `fatal` record and exit with code 1.
- `npm run build` is plain `tsc` and emits no source maps, so the npm
  tarball no longer ships maps that point at `src/` files it does not
  contain. In 0.5.0 a `prebuild` step ran lint,
  typecheck and the unit tests first; run `npm run check` for those.
  `docs/DEPLOYMENT.md` runs `npm prune --omit=dev` after the build for
  production installs and updates.
- The npm publish job (still off by default) publishes the tarball built
  and checksummed by the build job and installs nothing while it holds
  `id-token`.
- The server version is read from `package.json` everywhere (initialize,
  `/healthz`, `--help`); the MCPB manifest is held to the same version
  by a test.
- Dependencies: express 4.22.3 or newer; dev tooling updated (ESLint 10,
  TypeScript 6.0, vitest 5, prettier 3.9, tsx 4.23, `@types/node` 22).

### Fixed

- The dry-run preview shows the request body at every depth. It cut
  values below six levels to `"[truncated]"`, which hid the update
  filters (`actions[].params.filters[].values[]`) of automation bodies
  from the person confirming them.
- `action1_cve_remediation_plan` with `cve_id` reads every affected
  endpoint; `max_items` capped the endpoint walk although it counts plan
  entries. A plan that leaves something out (more vulnerabilities than
  `max_items`, more affected endpoints than listed) now says so with
  `truncated: true` and a `warning`.
- `action1_automations_summary` reports `has_more: true` and a `note`
  when `max_scan` stopped the walk before the last instance, and the
  server instructions no longer say that it walks all data.
- The server instructions and the `auto_confirm_enabled` warning said
  that with `ACTION1_DESTRUCTIVE_AUTO_CONFIRM=true` `dry_run` defaults to
  false. It never did, in 0.5.0 neither: `dry_run` defaults to `true` in
  every mode, and auto-confirm only drops the per-call `confirm`. Both
  texts are now generated from the guard policy; the behaviour is
  unchanged.
- `action1_wait_for_automation` and `action1_execute_and_wait` treat the
  spec status `Warning` as final instead of polling until the timeout.
  `action1_automations_summary` reports `warning_count` and counts
  `Error` and `Stopped` as failures.
- `action1_endpoints_summary` counts endpoints with `reboot_required`
  `"Yes"` (the spec value).
- `action1_software_inventory_for_endpoint` `find_by_name` matches the
  spec's `fields.Name`; `find_by_name`, `action1_recurring_schedules` and
  `action1_audit_log_search` with filters search every upstream page,
  not only the first.
- `action1_audit_log_search` filters on the spec's `user_name`, `event`,
  `object_name` and `timestamp` format.
- `action1_cve_remediation_plan` reads `endpoint_id`, takes the fixing
  packages (id and version) from the CVE's `available_updates`, and marks
  each entry with `correlation`. The `endpoint_id` path uses the
  documented `GET /vulnerabilities/{orgId}?endpoint_id=`. It reports an
  error when reading missing updates fails (only 403/404 become a
  `warning`), and reads them once per endpoint.
- Client cancellation (`notifications/cancelled`) and a closed HTTP
  connection abort the upstream calls of every tool and resource read.
- `action1_run_script` with `target_type: "EndpointGroup"` works (with
  `os`); before, it always failed with a 404 lookup error. The
  `/run-script-fleetwide` prompt prescribes `os`.
- Markdown list output no longer drops rows, columns or the cursor without
  saying so; `next_cursor` is printed in full and resumes at the next row;
  hidden columns are named.
- `total` on the last page of a cursor walk is the total of the whole
  walk; it is omitted while more pages follow.
- `action1_search_endpoints` no longer skips matches at a page boundary
  and rejects cursors of other queries.
- The hint to pass `verbose: true` appears only when items were
  compacted, and only on tools that have the parameter.
- A single record larger than the page budget becomes a
  `__truncated_item` placeholder instead of an endless empty page; every
  result stays under the 1 MB host limit with visible truncation markers.
- A `.env` copied from `.env.example` starts: empty values count as unset
  everywhere (`HOST=` means `127.0.0.1`), and `ACTION1_LOG_LEVEL` is
  case-insensitive.
- The npm bin (`npx`, `npm install -g`) starts the server through the
  symlink npm creates instead of exiting silently.
- A non-JSON OAuth token response gives a clear `Action1AuthError`.
- The log throttle no longer drops notice, warning, error or critical
  lines; fatal startup errors and uncaught exceptions are logged as
  critical JSON lines.
- The auto-confirm startup warning also fires for values such as
  `TRUE ` and is logged once per process.
- `action1_execute_and_wait` reports a failed start with the Action1
  error text and the masked upstream response body. A 4xx start error
  no longer claims that the action may have started; that note stays for
  5xx answers, timeouts and connection errors.
- `ACTION1_LAST_SEEN_STALE_MINUTES` also applies to
  `connectivity.online` of `action1_get_endpoint` and to the fresh /
  stale counts of `action1_endpoints_summary`, not only to the offline
  check before an action.

### Removed

- The unused `OrgResolver` (organization names were never resolved;
  `org_id` takes a UUID).
- Obsolete `esbuild` and `hono` overrides.

### Documentation

- README: unofficial-project notice, maintenance status, validation
  status (the read-only live shape check of 2026-10-26, and which
  destructive tools were never run against a live tenant), MCPB from
  GitHub Releases as the main install path, all five Action1 regions;
  npm is marked as not published.
- FAQ: on the stateless 2025-era HTTP transport a call is cancelled by
  closing its HTTP request; a `notifications/cancelled` sent in a
  separate request does not reach it.
- CONTRIBUTING: the dev tools (ESLint 10) need Node 22.13 or newer while
  the runtime floor stays 22.12, and `build:mcpb` needs Git Bash on
  Windows.
- `docs/403-investigation.md` names the correct HTTP methods of the
  endpoint routes; ADR 0001 describes the production consumer only by
  its verified protocol behaviour.
- `CODE_OF_CONDUCT.md` names a confidential reporting route (a private
  GitHub security advisory or a request for a private channel), and
  `docs/maintainers/repo-settings.md` lists the prerequisites of npm
  provenance (public repository, first publish, trusted publisher).
- USAGE documents every curated tool and each of its parameters,
  including `action1_endpoints_summary` and
  `action1_automations_summary`; a test holds it to `tools/list` and
  checks the arguments of every documented tool call.
- SECURITY: supported versions, best-effort reporting, threat model with
  indirect prompt injection, data sent to the LLM provider, the audit
  events and their caller fields, the organization allowlist including
  enterprise-wide resources, the redirect policy, the served protocol
  revisions, the live shape check, correct auto-confirm semantics.
- DEPLOYMENT and INSTALLATION: working HTTP setup on loopback behind a
  reverse proxy with token, `MCP_HTTP_ALLOWED_HOSTS` and `TRUST_PROXY`; a
  hardened systemd unit; `/readyz`; the actual MCPB bundle contents.
  `docs/maintainers/repo-settings.md` lists the repository settings the
  workflows rely on.
- `docs/api-coverage-gaps.md` lists what the server does not cover,
  measured against the pinned spec, instead of a comparison with other
  projects.
- `NOTICE` excludes the vendored Action1 spec from the MIT License and
  names the Action1 trademark.
- A test flags hand-written tool, test and prompt counts in prose and
  checks relative links, anchors and the generated coverage table; others
  hold README's configuration table and the MCPB notes to the validated
  environment variables.

### Tests and CI

- A spec-backed fake Action1 API answers every documented operation from
  its OpenAPI 200 schema; registry-wide sweeps use it: the
  `action1_raw_request` guard over every method and spec path, a single
  send on an upstream 502 for every executable write tool, the org
  allowlist for every tool with `org_id`, `ACTION1_REDACT_PII` over every
  read tool, executed write, resource and upstream error text, and a
  schema smoke over every tool and resource. Every answer in
  `evals/action1-eval.xml` is checked against the running server.
- The E2E suite starts the bundle from the manifest's `mcp_config` like
  Claude Desktop does, runs a tool call against a local HTTPS stub,
  starts `--http` without and with a token, checks the SBOM hashes and
  that the tarball carries no source maps, and rebuilds once to compare
  checksums. ESLint also covers `tests/**` and `scripts/*.mjs`.
- The `tools/list` compatibility test compares tool and input names,
  required inputs, annotations, output schemas, resources, resource
  templates and prompt arguments with the v0.5.0 baseline.
- The tests are type-checked (`npm run typecheck:tests`,
  `tsconfig.test.json`). The guard, org scope, raw request, HTTP, PII
  and retry modules have per-file coverage floors. The tests are stable
  under parallel load. A test keeps em and en dashes out of the tracked
  files (the vendored Action1 spec excepted).
- CI: new jobs `node-floor` (exactly Node 22.12) and `cross-os` (bundle
  build and stdio start on Windows and macOS); E2E on Node 22 and 24;
  `npm audit signatures`; `mcpb-reproducible` also compares the SBOMs;
  every job has a time limit.

## [0.5.0] and earlier

0.5.0 (tag `v0.5.0`, 2026-06-14) was the first tagged release.
Versions 0.2 to 0.4 were development milestones without public tags; the
repository history was squashed into one commit before 0.5.0. In short,
those versions built up:

- curated tools for the Action1 workflows with quirks (macOS and Windows
  script payloads, endpoint detail path, script output filtering) and
  generated tools for every other operation of a pinned Action1 OpenAPI
  snapshot;
- verb-first generated tool names (`action1_update_endpoint` instead of
  path-derived names, from 0.3.0);
- the destructive guard (env switch, `confirm`, `dry_run` defaulting to
  `true`);
- stdio and stateless Streamable HTTP transports with a bearer token,
  body limit and rate limit, and an MCPB bundle;
- resources, slash prompts, `response_format` and output schemas on the
  tools, Markdown rendering with readable timestamps;
- redaction of credentials in logs and error texts, CSV and Markdown
  injection defences, `ACTION1_BASE_URL` validation;
- graceful shutdown, `Retry-After` and token-lifetime clamps, and the
  `ACTION1_LAST_SEEN_STALE_MINUTES` and `TRUST_PROXY` settings.

[Unreleased]: https://github.com/mguttmann/action1-mcp/compare/v0.6.2...HEAD
[0.6.2]: https://github.com/mguttmann/action1-mcp/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/mguttmann/action1-mcp/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/mguttmann/action1-mcp/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/mguttmann/action1-mcp/releases/tag/v0.5.0
