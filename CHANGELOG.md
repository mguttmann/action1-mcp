# Changelog

All notable changes to this project are documented in this file. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project adheres to [Semantic Versioning](https://semver.org).

## [Unreleased]

### Changed

- Documentation reconciled to the current tool/test surface for the public release: **166 tools** (133 auto-generated + 33 curated incl. 6 workflow wrappers), **527 tests** across 48 files (37 unit / 4 integration / 6 security / 1 performance), **12** eval qa_pairs, **7** resources, **6** slash-prompts.
- **Stale / incorrect tool names fixed** in the guides
  (`action1_list_endpoint_details` → `action1_get_automation_script_output`,
  `action1_create_subscription_{quote,trial}` →
  `action1_request_enterprise_{quote,trial}`, `action1_export_report` →
  `action1_get_export_for_report`, plus the group/schedule CRUD names in
  the api-coverage-gaps roadmap recap).

## [0.5.0] — 2026-05 — Full-codebase audit (Pass-13)

Minor release. Five-agent parallel audit of the full ~19k-LOC source
tree (auth/HTTP, tool handlers, redaction, codegen, tests) closed
7 Critical + 30 Important findings; test count grew 424 → 498 (+74).
Also closes 5 moderate `npm audit` findings via the vitest 2 → 4 bump.

### Changed

- **HTTP transport now uses a single `Action1Client` per process**
  (was: one per request). Token cache + refresh-coalescing were
  effectively dead in HTTP mode — every request hit `/oauth2/token`
  fresh. Now `buildServer(existingClient?)` accepts an injected client;
  `runHttp()` builds one before `app.listen()`. stdio path unchanged.
- **SIGTERM / SIGINT graceful shutdown** in both transports. HTTP
  drains in-flight requests via `server.close()` with a 25 s hard
  ceiling. k8s rolling deploys + `docker stop` no longer drop active
  sessions.
- **Express body parser scoped to `POST /mcp`** (was: global `app.use`).
  Unauthenticated requests to non-existent paths no longer parse a
  1 MB JSON body before 404. Closes a DoS amplifier.
- **`TRUST_PROXY` env knob** for reverse-proxy deployments. Without it,
  `req.ip` resolves to the proxy and the rate-limit lumps all real
  users into one bucket. Values: `false` (default) | `true` |
  `loopback` | CIDR. Operators should only enable for trusted upstream
  proxies.
- **`Retry-After` clamped to 60 s** at the retry layer. A malicious or
  buggy upstream returning `Retry-After: 86400` previously pinned the
  client for 24 h; now emits a `retry_after_clamped` warn-log.
- **`expires_in` clamped to 60 s … 24 h** in the OAuth token cache.
  Defends against `expires_in: 0` (cache-thrash) and `expires_in:
  99999999` (stale token forever).
- **`ACTION1_LAST_SEEN_STALE_MINUTES` env knob** (default 10, range
  1–1440). Was hardcoded; endpoints that check in every 15 min were
  incorrectly flagged offline.
- **`action1_reboot_endpoint` now does the connectivity check** (was:
  silently queued reboots for offline endpoints — they'd fire days
  later when the box came back online). `skip_connectivity_check`
  param to bypass.
- **`timeout_minutes` / `retry_minutes` accept both `number` and
  digit-string** (was: inconsistent — one number, one string regex).
- **Redaction patterns extended**: `x-action1-token`, `cookie`,
  `set-cookie`, bare `token` keys + cookie-shape value pattern. Pass-13
  found Action1's own primary header was not in the redact set.
- **`Action1ApiError.body` redacted at construction** (was: only at
  `toToolErrorText()` render time). Defence-in-depth — downstream
  consumers reading `err.body` directly now see the redacted form.
- **`OrgResolver` 5-min TTL + working `invalidate()`**. Long-running
  servers no longer hold stale org lists across hours of API-key
  rotations.
- **Prompt-injection defence**: argument length caps (`script_text`
  ≤ 8 KB, other args ≤ 512), triple-backtick fence escape via ZWSP,
  user input now wrapped in `<<<USER INPUT BEGIN/END>>>` block placed
  **after** the workflow steps.
- **Compactor honours `verbose: true` in cursor / `auto_paginate`
  mode** (was: paginated path bypassed `compactItem` entirely; the
  documented opt-out had no effect on bulk reads).
- **Generated tool descriptions no longer truncate mid-word**. Witness
  cases like `"specific v."`, `"detailed inf."`, `"specific custom p."`
  are gone — `fitLead` now backtracks to a word boundary and appends a
  single-char ellipsis.
- **Codegen `query` param fallback `z.unknown()` → `z.string()`**
  (matches HTTP query-string semantics; 52 → 41 unknown-typed
  parameters in the generated tools). Avoids `?status={"foo":1}`
  requests reaching the API.

### Fixed

- **`asStartedJob` returned success-shape with `instance_id: undefined`**
  on parse failures. Downstream `wait_for_automation` calls got an
  undefined ID and surfaced an opaque 404. Now `errorResult`.
- **`waitForInstance` Running + 100 % short-circuit** treated mid-flight
  uploads as terminal. Removed; only `TERMINAL_STATUSES` terminate.
- **`audit_log_search` time-range filter bypassed items with
  unparseable timestamps**. Now drops them and surfaces a
  `dropped_unparseable_timestamps` counter.
- **`filterOutput` substring-match silently dropped legit lines**
  containing the word "Completed" (e.g. `"Completed CVE remediation:
  3 packages"`). Now anchored — `/^(Starting|Waiting|Completed)(:|\s*$)/`.
- **`destructiveGuard` re-parsed `process.env` directly**. A trailing
  `\n` in `ACTION1_ALLOW_DESTRUCTIVE` (common from `.env` paste)
  silently disabled the env switch. Now reads via `loadConfig()`'s
  Zod-validated trim+lowercase pipeline.
- **`cve_remediation_plan` swallowed 403 → `plan: []`** silently. Now
  surfaces a `warning` field on 403/404 so the agent can distinguish
  "no scope" from "no vulns".
- **`pagedFetch` O(n²) re-stringification** of the full accumulator on
  every item → running-bytes counter (matches `capItemList`).
- **`compactItem` was not idempotent** — second pass re-truncated the
  already-truncated marker. Now guards on the marker suffix.
- **`vi.restoreAllMocks()` was called at module-load time** in
  `tests/unit/runtime.test.ts` instead of `afterEach` — no cleanup
  between tests. Hoisted into `afterEach` for both describes.
- **`tests/integration/server.test.ts` did not check `outputSchema`
  per tool** (the exact bug class Pass-3 fixed in production). Loop
  now asserts `outputSchema.type === "object"`.
- **`tests/integration/server.test.ts` pinned tool count `> 20`**
  (real total is 164). Tightened to ≥ 160 with curated/generated
  splits.
- **`tests/unit/loggerThrottle.test.ts` was wall-clock-dependent** —
  2 000 sequential log calls could cross a minute boundary on slow CI
  and double the budget. Now uses `vi.useFakeTimers()`.

### Removed

- **`src/codegen/spec/PINNED_SHA.ts`**. Dead code — generated on every
  codegen run but imported nowhere. SHA drift is still caught by
  `openapi.sha256` + `tests/unit/specSha.test.ts`.
- **`auth` field in `/healthz` response**. Disclosed the auth mode
  (`"bearer"` vs `"none"`); attacker could detect via 401-probe anyway,
  but no reason to make it free.

### Internal

- **vitest 2.1.8 → 4.1.6** (`npm audit fix --force`). Closes 5 moderate
  vulnerabilities in transitive `vite` / `esbuild`. Dev-only; nothing
  ships in `dist/`. All 498 tests pass on v4 unchanged.
- **`vitest.config.ts` coverage thresholds** (75 / 70 / 60 / 75)
  configured but opt-in via `--coverage` — CI unchanged. Requires
  `@vitest/coverage-v8` peer-install before first run.
- **12 weak-assertion sharpenings** in `tests/integration/server.test.ts`:
  `.toBeFalsy()` → `.toBe(false)`, `.toBeDefined()` → `typeof object +
  notNull`, `.toBeTruthy()` → `typeof string + length > 0`.

### Acknowledged limitations (deferred to a later pass)

- **OAuth token request still form-encoded** (spec says JSON +
  `grant_type`). Works against the current Action1 tenant; spec
  hardening would break the cold-cache acquisition. Marked as TODO with
  Pass-13 reference; will switch with tenant-side verification.
- **POST/PUT/PATCH body schemas in generated tools remain
  `z.record(z.unknown())`**. Generating Zod from OpenAPI component
  schemas is a non-trivial codegen rewrite. Curated tools have proper
  schemas. Documented in CONTRIBUTING.
- **`deploy_package` / `uninstall_program` `params` shape** stays loose
  because the agent is expected to consult `action1_get_action_template`
  for the per-template field set. Capped at 100 keys to limit blast
  radius.

---

## [0.4.2] — 2026-05 — Doku-Sync Round 2 (Pass-12)

Patch release. Pure documentation fixes — no code behaviour changes.

### Fixed
- `docs/DEPLOYMENT.md` § HTTP transport: the
  "logs a warning but does not refuse" wording was a stale Pre-Pass-4
  description. Pass-11 fixed SECURITY.md and TROUBLESHOOTING.md but
  missed this third occurrence. Now matches the actual hard-fail
  behaviour with the exact error message from `src/index.ts:91-97`.
- `docs/FAQ.md` § How do I cut a release? was hard-coded to `v0.3.0`.
  Now generic `vX.Y.Z` with a 4-step pre-tag checklist (version-string
  sync across package.json + manifest.json + server.ts, lockfile sync,
  CHANGELOG update, test + smoke verify) to prevent the
  Pass-11-class drift from recurring.

---

## [0.4.1] — 2026-05 — Doku-Sync nach Pass-10

Patch release. Pure documentation and version-string fixes — no code
behaviour changes.

### Fixed
- `src/server.ts` MCP-handshake-version was still 0.3.0 — clients saw a
  stale version even though the git tag was v0.4.0.
- `mcpb/manifest.json` MCPB bundle version + `long_description`
  ("24 curated" → "30 curated tools incl. 6 workflow wrappers").
- Doku-drift across README, TESTING, CONTRIBUTING, INSTALLATION,
  SECURITY, DEPLOYMENT, TROUBLESHOOTING, FAQ, api-coverage-gaps, and
  .env.example: 170 → 348 test counts, v0.3 → v0.4.1 status,
  hard-fail wording for the non-loopback bind (Pass-4 behaviour change
  that the docs hadn't caught up with).
- `.env.example` now documents the MCP_HTTP_TOKEN ≥16-char rule.

### Internal
- CHANGELOG footer-links added for `[0.4.0]` and `[0.4.1]`.

---

## [0.4.0] — 2026-05 — Audit-Wellen Pass-4 bis Pass-10

Ten review passes since 0.3.0 closed 76 findings and added 137 tests
(218 → 348). The net behaviour-level changes operators should be aware
of are below; all internal refactors (schema-passthrough, codegen
description quality, test coverage) are captured in commit history.

### Changed

- **HTTP Bearer-Auth: token compared post-trim on both sides** (Pass-4 +
  Pass-7). `MCP_HTTP_TOKEN` whitespace is now stripped before length /
  timing-safe compare; the captured Authorization-header token is
  trimmed symmetrically. Whitespace-only headers (e.g. `Bearer    `)
  now return `401 "Bearer token required"` (was `401 "Invalid bearer
  token"`). Same status code — only the error string differs, so
  log-greps for either message should be updated.
- **Non-loopback HTTP bind without a Bearer token: hard-fails on
  startup** (Pass-4). Previously emitted a `warn` and ran anyway. Set
  `MCP_HTTP_TOKEN=<16-char-or-longer>` to bind to anything other than
  `127.0.0.1` / `localhost` / `::1`.
- **`ACTION1_DESTRUCTIVE_AUTO_CONFIRM` no longer flips `dry_run`** to
  false (Pass-4). Auto-confirm only waives the per-call
  `confirm: "YES"` requirement; `dry_run` keeps defaulting to `true`.
  A bare `tool({})` call in auto-confirm mode is therefore still a
  preview. Set `dry_run: false` explicitly to execute.
- **Network-transient errors are now auto-retried** (Pass-9). Previously
  `ECONNRESET` / `ENOTFOUND` / `EAI_AGAIN` etc. were wrapped as
  `Action1ApiError(status=0)` and silently dropped through
  `shouldRetry`. They now follow the same backoff schedule as 429 / 5xx.
- **Export endpoints (CSV / audit-log download) lost their pagination
  args** (Pass-9). `action1_get_export_for_report` /
  `action1_export_audit_log` previously advertised `auto_paginate` /
  `cursor` even though the response is a single CSV blob. Those args
  are gone; the API still accepts `limit` / `from` for row windowing.

### Fixed

- **Output-schema mismatches** for ~30 tools (Pass-3 + Pass-4). The
  shared `singleObjectOutputShape` / `okStatusOutputShape` schemas now
  use `.passthrough()`, so structured-content with extra envelope keys
  (`id`, `type`, `next`, etc.) validates cleanly.
- **`capItemList` worst-case from O(n² log n) to O(n)** (Pass-4) via a
  single-pass byte-cost accumulator. Plus a structured placeholder for
  single-record-over-cap instead of the previous silent empty list.
- **TokenProvider 401 race**: a 401 mid-flight now triggers
  `tokens.invalidate()` plus a one-shot retry with a fresh token,
  guarded by a flag against infinite loops (Pass-4).
- **Pagination termination** uses `hasMore` / `total` envelope hints
  before falling back to the length heuristic (Pass-4), preventing
  early termination when a server-side filter produced a short mid
  page.
- **Tool descriptions** no longer emit mid-sentence connector tails
  ("…deployed on. Perm:") thanks to an iterative drop-and-re-terminate
  loop in the codegen (Pass-5 + Pass-6).
- **Tool collision** `action1_list_missing_updates` (curated) vs
  `action1_list_endpoint_missing_updates` (generated): the generated
  variant now leads with `"Filtered/paginated variant of
  action1_list_missing_updates (curated). Use for severity/
  approval_status/sortby filtering."` (Pass-4).

### Added (operator-visible)

- **`scripts/inspector-smoke.sh`** smoke-test runner that hits a real
  Action1 instance via Inspector-CLI and flags any schema or registration
  mismatch (Pass-3). Add it to your release checklist.
- **Operator WARN logs** when destructive auto-confirm or dynamic
  toolsets are active at start-up (Pass-4 + Pass-5).
- **Per-item compactor** for list responses: embedded scripts,
  100-entry CVE walls, and EULA blocks are placeholder-replaced by
  default to keep host-context budgets sane. Pass `verbose: true` on
  any read-only tool to receive the raw upstream record (Pass-2 +
  Pass-4).

### Internal

- **137 new tests** across 10 review passes (218 → 348). New suites:
  `action1Client`, `errorsHint`, `safeResourceRead`, `outputSchemas`,
  `bearerAuth`, `capOutputLinear`, `loggerThrottle`, `osDetectServer`,
  `orgCache`, `endpointInfo`, `prompts`, `inferOutputShape`, plus
  extensive expansions of `pagination`, `destructiveGuard`, `config`,
  and `auth`.
- **`src/codegen/connectors.ts`**: extracted from `generate.ts` so the
  connector list can be imported without triggering codegen's top-
  level `main()` write-to-disk effect.
- **`RetryOverride` type**: callers can pass `{maxAttempts, baseDelayMs}`
  partials instead of the previous boolean-only override (which
  silently ignored object values).

---

## [0.3.0] — 2026-05

### BREAKING — auto-generated tool names

Every auto-generated tool was renamed from a path-derived form (e.g.
`action1_endpoints_managed_endpointId_patch`,
`action1_organizations_post`) to a **verb-first** form
(`action1_update_endpoint`, `action1_create_organization`). 134
generated tools are now emitted under the new names; 5 are skipped to
make room for the curated tools that already cover the same surface.

If your workflows refer to old names, here are the most common
migrations:

| Old name | New name |
|---|---|
| `action1_endpoints_managed_endpointId_patch` | `action1_update_endpoint` |
| `action1_endpoints_managed_endpointId_move` | `action1_move_endpoint` |
| `action1_endpoints_groups_orgId` | `action1_list_endpoint_groups` |
| `action1_endpoints_groups_orgId_post` | `action1_create_endpoint_group` |
| `action1_endpoints_groups_groupId_contents_get` | `action1_list_group_contents` |
| `action1_organizations_post` | `action1_create_organization` |
| `action1_policies_schedules_orgId_automationId_get` | `action1_get_automation_schedule` |
| `action1_policies_instances_orgId_automationId_get` | `action1_get_automation_instance` |
| `action1_policies_instances_orgId_post` | `action1_create_automation_instance` |
| `action1_cve_descriptions_cveId_get` | `action1_get_cve_description` |
| `action1_audit_events_get` | `action1_list_audit_events` |
| `action1_audit_export_get` | `action1_export_audit_log` |
| `action1_scripts_get` | `action1_list_scripts` |
| `action1_logs_orgId_get` | `action1_list_logs` |
| `action1_roles_get` | `action1_list_roles` |
| `action1_users_get` | `action1_list_users` |
| `action1_me` | `action1_get_me` |
| `action1_search_orgId_get` | `action1_search` |
| `action1_subscription_enterprise_get` | `action1_get_subscription` |
| `action1_subscription_usage_enterprise_get` | `action1_get_subscription_usage` |
| `action1_subscription_usage_organizations_orgId_get` | `action1_get_org_subscription_usage` |
| `action1_endpoints_agent_installation_orgId_installType_get` | `action1_get_agent_install_url` |
| `action1_endpoints_connector_installation_orgId_windowsEXE_get` | `action1_get_windows_deployer_url` |
| `action1_endpoints_status_orgId_get` | `action1_get_endpoints_onboarded_status` |
| `action1_endpoints_discovery_orgId_get` | `action1_get_endpoint_discovery_settings` |
| `action1_apps_orgId_requery_endpointId_post` | `action1_requery_installed_software_for_endpoint` |
| `action1_apps_orgId_requery_post` | `action1_requery_installed_software_for_org` |
| `action1_vulnerabilities_orgId_get` | `action1_list_org_vulnerabilities` |
| `action1_endpoints_groups_groupId_contents_post` | `action1_modify_group_membership` |
| `action1_packages_all_post` | `action1_create_package` |
| `action1_license_enterprise_trial_post` | `action1_request_enterprise_trial` |
| `action1_license_enterprise_quote_post` | `action1_request_enterprise_quote` |
| `action1_enterprise_request_closure` | `action1_request_enterprise_closure` |
| `action1_enterprise_revoke_closure` | `action1_revoke_enterprise_closure` |
| `action1_audit_events_id_get` | `action1_get_audit_event` |

The naming heuristic lives in `src/codegen/naming.ts`; per-operation
hand-overrides for the trickier cases live in
`src/codegen/curated-overrides.ts` (`NAME_OVERRIDES`). The codegen
runs a 3-pass conflict resolver (parent qualifier, then HTTP method
suffix as last resort) so duplicates can never silently bypass curated
tools.

The 30 curated tool names (e.g. `action1_list_endpoints`,
`action1_run_powershell`, `action1_execute_and_wait`) are unchanged
and remain the recommended path for the common workflows.

Total tool surface: **164** (was 167). The 3-tool drop is from 6
operations now covered by curated tools (which gain extra Action1
filter params — see "Added" below) minus 3 new tools added in this
release (`action1_endpoints_summary`, `action1_automations_summary`,
`action1_list_org_vulnerabilities`).

The "100 % skill conformance" pass. Touches every tool registration,
adds three new test categories, normalises naming, and lands a number
of long-standing audit items in one shot.

### Added

- **`response_format` on every list-shaped tool** (`markdown` default,
  `json` opt-in). Plumbed through `cappedListResult` /
  `pagedListResult` / `jsonResult`.
- **Markdown rendering humanises Action1 timestamps**
  (`YYYY-MM-DD_HH-MM-SS UTC`) and trims the `name (id)` form for
  display columns. New helper module `src/utils/format.ts`.
- **Centralised constants** in `src/constants.ts`
  (`CHARACTER_LIMIT = 25_000`, `WIRE_LIMIT_BYTES = 400_000`,
  `LAST_SEEN_FRESH_SECONDS = 600`, …). Replaces the duplicate
  hard-codes in `markdownTable.ts` and `capOutput.ts`.
- **Two new MCP resources** — `action1://groups/{orgId}` and
  `action1://reports`.
- **Resource cap-and-truncate** — every list-shaped resource is now
  capped at ~400 KB and emits a structured truncation note pointing at
  the equivalent paginated tool.
- **Skill-format Tool descriptions** with `Args / Returns / Examples /
  Error Handling` sections on all curated tools.
- **All four annotations explicit** on every tool (`readOnlyHint`,
  `destructiveHint`, `idempotentHint`, `openWorldHint`).
- **Skill-format evaluation suite** in `evals/action1-eval.xml` with
  10 multi-hop questions and a README explaining the
  operator-fill-in flow.
- **Three new test categories** — integration (`tests/integration/`,
  driving the McpServer through the SDK in-memory transport pair),
  security (`tests/security/`, destructive-guard truth table +
  redaction matrix), performance (`tests/performance/`, capItemList /
  markdown-table scaling). 170 tests up from 85.
- **`actionableError(message, suggestion)` helper** + `runTool` now
  branches `z.ZodError` and `AbortError` into actionable messages.
- **`okStatusOutputShape`** in `src/tools/helpers.ts` for destructive
  endpoints whose 200 response carries no meaningful body.
- **Server-side filter coverage on curated `action1_list_endpoints`** —
  9 new filter params (`sortby`, `filter`, `status`, `online_status`,
  `update_status`, `vulnerability_status`, `reboot_required`, `os`,
  `reset_cache`) forwarded directly to the Action1 API, so the agent
  no longer has to walk the full list just to filter.
- **`admin` filter on `action1_list_organizations`** and
  **`applicable_to` filter on `action1_list_action_templates`** —
  small but completes the 1:1 parameter coverage of the curated tools'
  underlying OpenAPI ops.
- **Org-wide vulnerabilities tool** —
  `action1_list_org_vulnerabilities` (auto-generated) exposes the
  org-level `/vulnerabilities/{orgId}` endpoint with all 13 server-side
  filter params (CVE-IDs, score range, published date, remediation
  status, …), separate from the per-endpoint
  `action1_list_vulnerabilities` curated tool.
- **`action1_endpoints_summary`** and **`action1_automations_summary`**
  curated aggregation tools — server-side counters that walk the full
  data set and return ~1 KB of metrics instead of paginating through
  thousands of items just to count.
- **Markdown-injection defence in cell rendering** —
  `escapePipes` now also escapes `[`, `]`, `<`, `>`, `\\` and CR/LF in
  every cell value. Defuses `[link](url)`, image, and HTML-tag
  injection vectors when an Action1 string contains
  attacker-controlled Markdown syntax.
- **CSV-injection defence in `action1_report_export`** — cells whose
  first non-whitespace character is `=`, `+`, `-`, `@`, TAB, or CR get
  prefixed with a single quote so Excel / Google Sheets honour them as
  literal text rather than formulas.
- **`outputSchema` on every curated tool** — execute / wait / get-* /
  summary / wrapper tools all now declare their result shape (one of
  `cursorListOutputShape`, `listOutputShape`, `singleObjectOutputShape`,
  `okStatusOutputShape`).
- **`safeResourceRead` wrapper** on every MCP resource — downstream
  errors return a structured `{ error, status?, hint? }` JSON payload
  instead of bubbling up as a JSON-RPC `-32603` (which some hosts
  render as a hard crash).
- **Permission tag extraction now catches the
  "Requires one of the following permissions:" form** — the previous
  regex missed it, so 7 generated tools were silently losing their
  Permissions: footer in the structured description.
- **Centralised `defaultName` / `humanize` helpers** in
  `src/payloads/shared.ts` (was duplicated in the Win/Mac payload
  builders). Plus a centralised `sleep(ms, signal?)` helper in
  `src/utils/sleep.ts` (was duplicated in `client/retry.ts` and
  `tools/workflows.ts`).
- **170 tests across 4 categories** (was 85) — added `cursor.test.ts`
  (12 tests for buildCursor / parseCursor / fingerprintQuery /
  pagedFetch incl. fingerprint-mismatch and byte-cap) and
  `retry.test.ts` (9 tests for `withRetry` and
  `isTransientNetworkError`).

### Changed

- **Server name → `action1-mcp-server`** (per skill convention
  `{service}-mcp-server`). Touches `package.json`, `src/server.ts`,
  `mcpb/manifest.json`, the `/healthz` `service` field.
- **Bumped to v0.3.0** across `package.json`, `src/server.ts`,
  `mcpb/manifest.json`.
- **HTTP body limit lowered to 1 MB** (was 4 MB). Matches the MCP host
  per-message wire limit.
- **HTTP transport hard-fails on non-loopback bind without an Origin
  allowlist** (was: warn-only). Skill DNS-rebinding guidance.
- **HTTP transport now also validates the `Host` header** when an
  Origin allowlist is configured. Closes the second half of the
  DNS-rebinding gap that origin-only checks leave open.
- **Origin / Host check now runs BEFORE bearer-auth** (was: after).
  Stops DNS-rebinding probes from even reaching the auth layer.
- **Loopback recognition handles `[::1]`** (the bracketed IPv6 form
  used in URL bind-strings), not just `::1`.
- **`ACTION1_BASE_URL` requires `https://`** and rejects known
  metadata-service hosts (169.254.169.254, metadata.google.internal).
  Defence against operator misconfiguration that would send OAuth
  tokens unencrypted or to a wrong endpoint.
- **Logger redaction expanded** — bare JWTs (no `Bearer ` prefix) and
  URL-embedded basic-auth credentials (`https://user:pw@host`) now
  match the redact patterns.
- **`Action1ApiError.toToolErrorText()` and `Action1AuthError`
  constructor** now run their body through `redactString` before
  composing the tool-output message — removes a subtle credential-leak
  path where a 401 response body that echoed `client_id` could land in
  the LLM's view of the tool error.
- **`action1_list_vulnerabilities` now wraps in `runTool`** — the
  re-throw branch was bypassing the standard error pipeline.
- **`action1_search_endpoints` uses `buildCursor()` for next-cursor
  emission** — was hand-rolling the base64 of `{from, q}`, drifting
  silently from `parseCursor`'s contract.
- **Refresh-token cache is cleared after a refresh failure** so we
  don't keep retrying a known-dead refresh token until the next cold
  cache expiry.
- **Generated POST tools whose title doesn't begin with a read-verb
  no longer get classified as read-ish**. The previous regex matched
  on `title + description`, which meant POST endpoints whose
  description happened to mention "list" or "GET" (e.g.
  "/policies/schedules/{}/post" → title "Create a automation
  schedule", description "list of endpoints") were silently bypassing
  the destructive guard. Now the check is a strict allowlist on the
  title prefix only — no false positives.
- **`pagedListResult` / `cappedListResult` always emit `total`** on
  successful responses (was: optional). Skill pagination shape.
- **README** rewritten to reflect skill conformance, the new test
  surface, and the rate-limit / required-permissions sections.

### Fixed

- **Markdown table truncation could overshoot the cap by ~50 bytes**
  due to the trailing "more rows omitted" + meta-line. The renderer
  now reserves a 200-byte trailer budget so the output stays under the
  cap.
- **Codegen agent / runtime alignment** — runtime accepts an optional
  `responseFormat` parameter routed to the result helpers (was: hard
  default).
- **Slash-prompts updated to the verb-first tool names** —
  `/patch-windows-fleet` and `/check-my-permissions` referenced
  pre-rename tool names that no longer exist.
- **Type-safe filtering** in `src/tools/wrappers/index.ts` — replaced
  `.filter(...).map(g => ({ id: g.id as string }))` patterns with
  proper type predicates so TypeScript narrows the result without the
  `as` cast.
- **`as unknown as { ... }` double-casts removed** from
  `src/client/action1Client.ts` — `Action1ApiError` now declares the
  `retryAfterMs` / `code` / `cause` fields directly so the wrappers
  don't need to bypass the type system.
- **`@typescript-eslint/no-explicit-any` upgraded from warn → error**
  in `eslint.config.js`. The codebase already had no `any` usage; this
  prevents accidental introduction.

### Acknowledged limitation

- **`.strict()` Zod input schemas** are documented but not enforced —
  the SDK's high-level `registerTool` API surfaces a `ZodRawShape`
  which is `z.object(shape).safeParse(...)`-d *non*-strictly. Passing
  `z.object(shape).strict()` instead would honour strict but the
  handler's `args` becomes `unknown` (per the SDK overload), losing
  type inference. The skill's typo concern is mitigated in practice
  because our destructive guard checks the actual `confirm` field —
  silent extras don't bypass the gate. See the comment block in
  `src/tools/helpers.ts` for the full trade-off.

## [0.2.0]

Initial public release. 100 % Action1 OpenAPI 3.1.0 coverage with
pinned SHA, hybrid architecture (curated + auto-generated + workflow
wrappers), three-layer destructive guard, stdio + Streamable HTTP
transports, Docker / GHCR / MCPB packaging, CI on Node 20 + 22.

[Unreleased]: https://github.com/mguttmann/action1-mcp/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/mguttmann/action1-mcp/releases/tag/v0.5.0
[0.4.2]: https://github.com/mguttmann/action1-mcp/releases/tag/v0.4.2
[0.4.1]: https://github.com/mguttmann/action1-mcp/releases/tag/v0.4.1
[0.4.0]: https://github.com/mguttmann/action1-mcp/releases/tag/v0.4.0
[0.3.0]: https://github.com/mguttmann/action1-mcp/releases/tag/v0.3.0
[0.2.0]: https://github.com/mguttmann/action1-mcp/releases/tag/v0.2.0
