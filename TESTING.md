# Testing

Six layers:

1. **Unit tests** (`tests/unit/`, Vitest): pure logic, no network. They run
   in CI on every push and pull request.
2. **Integration tests** (`tests/integration/`): drive the server through
   the MCP SDK client (in-memory transport, the stdio entry point or the
   real HTTP app on an ephemeral port) with mocked Action1 responses, so
   tool, resource and prompt registration, the guard and the transports
   are exercised end to end.
3. **Security tests** (`tests/security/`): the destructive-guard truth
   table, redaction of logs, errors and dry-run previews, CSV injection.
4. **Performance tests** (`tests/performance/`): size caps and Markdown
   rendering on inputs with thousands of items, measured as work
   (serialised characters, cell reads), not wall-clock time.
5. **Artifact E2E** (`tests/e2e/`, `npm run test:e2e`, CI jobs `e2e (22)` and `e2e (24)`):
   runs `scripts/build-mcpb.sh`, checks the bundle contents and the
   CycloneDX SBOMs (components against `package-lock.json`, hashes,
   registry URLs), checks that the npm tarball ships no source map
   without its sources, starts `dist/index.js` and the unpacked bundle
   over stdio with dummy credentials (initialize + tools/list), and
   starts the bundle once more exactly from its manifest `mcp_config`,
   as Claude Desktop does. `dist/index.js` also runs a tool call against
   a local HTTPS stub of the Action1 API (a throwaway self-signed
   certificate from `openssl`), and `--http` is started once without
   `MCP_HTTP_TOKEN` (must refuse) and once with it (401 without the
   token, tools/list with it). A second clean build must give the same
   SHA-256 for the bundle, the SBOMs and the npm tarball.
   Not part of `npm test`: it needs registry access for `npm ci`.
6. **Live smoke tests** (manual): exercise a real Action1 tenant with a
   populated `.env`. Not in CI. The read-only
   [live shape check](#live-shape-check-owner-only) belongs here too.

Coverage: `npm run test:coverage` (CI job `coverage`) fails when line,
statement, function or branch coverage drops below the thresholds in
`vitest.config.ts`: global ones, and per-file floors for the
destructive guard, the org scope check, the raw request tool, the HTTP
transport, PII masking and the retry loop.

## Automated tests

```bash
npm test                  # all four automated categories
npm run test:unit
npm run test:integration  # MCP protocol round trips
npm run test:security     # guard truth table, redaction
npm run test:performance  # size caps and rendering at scale
```

CI runs lint, the typechecks of source and tests, the tests and the
build on Node 22, 24 and 26, build, tests and a server start on exactly
Node 22.12 (the `engines` floor), plus format check, coverage with
per-file floors, artifact E2E on Node 22 and 24, `npm audit` and
`npm audit signatures`, the production install from
`docs/DEPLOYMENT.md` (build, `npm prune --omit=dev`, audit and start of
the pruned tree), two MCPB builds whose bundle and SBOMs must be byte
identical, a bundle build and stdio start on Windows and macOS, the
codegen roundtrip and a gitleaks history scan. Every job has a timeout.
A release tag runs the same workflow on the tag commit.

Some files and what they lock down:

| File | What it locks down |
|---|---|
| `tests/unit/auth.test.ts` | Token cache reuse, refresh lead time, concurrent in-flight dedup, invalidation, `expires_in` clamp. |
| `tests/unit/macOsBash.payload.test.ts` | All ten Mac-specific `run_script` fields are present and typed correctly. |
| `tests/unit/windowsPowerShell.payload.test.ts` | `success_exit_codes` is never empty; defaults are correct. |
| `tests/unit/policyInstance.payload.test.ts` | Template envelope (`endpoints`, `actions`, params passthrough). |
| `tests/unit/filterOutput.test.ts` | Status-marker filter, edge cases. |
| `tests/unit/lastSeen.test.ts` | Stale-`last_seen` detection, including Action1's non-ISO format. |
| `tests/unit/osDetect.test.ts` | Platform classification across vendor strings, including Action1's uppercase `OS`. |
| `tests/unit/pagination.test.ts` | Page walking, `maxItems`, envelope parsing, termination rules. |
| `tests/unit/runtime.test.ts` | Generated-tool runtime: query/path forwarding, auto_paginate, guard short-circuit. |
| `tests/unit/clientReliability.test.ts` | Retry policy per HTTP method, request timeout, path safety. |
| `tests/unit/destructiveGuard.test.ts` | Guard decisions, env flag parsing, auto-confirm. |
| `tests/unit/markdownTable.test.ts` | Markdown rendering: headers, escaping, truncation. |
| `tests/unit/specSha.test.ts` | Pinned spec SHA matches the spec file and the generated header. |
| `tests/unit/specContract.test.ts` | Every field and enum value the curated readers (`src/spec/entities.ts`) use exists in the spec; `src/spec/generated.ts` is current; readers accept the spec shape and the previously assumed one. |
| `tests/integration/specShapes.test.ts` | Curated tools on records built from the spec schemas (`tests/helpers/specFixtures.ts`): statuses, reboot counts, software, CVE plan, audit search, ResultPage paging, parameter enums and time format, output schemas. |
| `tests/unit/docsConsistency.test.ts` | Docs: relative links and anchors resolve, no hand-written counts, coverage table current. |
| `tests/integration/usageDocs.test.ts` | `docs/USAGE.md` names every curated tool and each of its input parameters; every documented tool call uses only tools and arguments `tools/list` accepts. |
| `tests/unit/mcpbManifest.test.ts` | The MCPB `mcp_config` maps known env vars from defined wizard fields, switches are booleans, and README's configuration table and the MCPB notes follow `ENV_VARS` in `src/config.ts`. |
| `tests/unit/noReviewReferences.test.ts` | Code, tests and docs carry no review finding ids or pass labels (BACKLOG.md excepted). |
| `tests/integration/server.test.ts` | tools/list, resources, prompts, annotation and output-schema invariants, tool calls with stubbed fetch. |
| `tests/integration/generatedTools.test.ts` | Every generated tool that changes state is guarded when called through MCP. |
| `tests/integration/toolsListBaseline.test.ts` | The v0.5.0 surface stays compatible for existing clients: no tool, input property, resource, resource template or prompt argument disappears, no input or prompt argument becomes newly required, baseline annotations and output schemas stay. Additions pass. |
| `tests/integration/httpTransport.test.ts` | The production HTTP app: token, Host and Origin checks, limits, error responses. |
| `tests/integration/runScriptFleetwide.test.ts` | `/run-script-fleetwide` prompt flow: the prescribed `action1_run_script` group call previews and executes with a group target. |
| `tests/security/destructiveGuard.matrix.test.ts` | Truth table over the env switches (including account operations), auto-confirm, `confirm` and `dry_run`. |
| `tests/security/redaction.test.ts` | Bearer / api-key / sk-* / password / authorization patterns, recursion, truncation. |
| `tests/security/orgAllowlist.test.ts` | `ACTION1_ALLOWED_ORG_IDS` on mutation bodies at any depth and the fail-closed rule for enterprise-wide mutations. |
| `tests/security/pii.test.ts` | `ACTION1_REDACT_PII` key set derived from the spec, report column names and CSV export columns, tool results, resource reads and error bodies. |
| `tests/security/redirect.test.ts` | Token and API requests (server and `scripts/live-shape-check.mjs`) do not follow a redirect to another origin; every credential-carrying `fetch` call passes `redirect: "error"`. |
| `tests/integration/auditTrail.test.ts` | Audit events with caller and body digest, written regardless of the log level; `destructive_executed` only for a request that is sent; HTTP rejections logged without the token. |
| `tests/integration/cancellation.test.ts` | Client cancellation aborts the upstream calls of tools and resource reads. |
| `tests/performance/cap.test.ts` | Large item lists are capped with linear serialisation work; large Markdown tables stay within the size budget and read only the rows they render. |

## Inspector schema smoke (`scripts/inspector-smoke.sh`)

Runs the MCP Inspector CLI against a set of read-only and destructive
(dry-run) tools on a real Action1 tenant and flags any
`Output validation error`, `Structured content does not match` or
registration crash. Output-schema mismatches only show up at runtime, so
run it before a release:

```bash
npm run build
./scripts/inspector-smoke.sh   # exits 0 if every tool's schema is healthy
```

It needs a populated `.env` and takes about a minute.

## Live shape check (owner only)

The curated tools read Action1 records by the field names and enum
values of the vendored OpenAPI spec (`src/spec/entities.ts`) and also
accept the names they assumed before. Whether the live API returns the
spec shape (for example `reboot_required: "Yes"`, audit events with
`user_name` and `timestamp` in `YYYY-MM-DD_HH-MM-SS`, installed software
under `fields.Name`, the `Warning` automation status) is checked by
`scripts/live-shape-check.mjs` (results of the first check below):

```bash
node --env-file=.env scripts/live-shape-check.mjs [--out live-shape-report.json]
# or, with ACTION1_* exported in the shell:
npm run live:shapes
```

- It requests a token and then sends GET requests only, each with a
  small `limit`, to the endpoints the curated tools read (organizations,
  endpoints, missing updates, vulnerabilities, installed software,
  automation instances and schedules, templates, groups, reports, audit
  events, and the audit time filter in both formats). It never starts
  an automation or changes anything.
- The report (`live-shape-report.json`, git-ignored) holds key paths,
  HTTP statuses, envelope facts, the distinct values of a fixed list of
  enum-like fields, timestamp formats with digits replaced by `9`, and
  per request the keys that differ from the spec schema. It holds no
  ids, names or other record values; ids it follows up (an endpoint, a
  CVE, an instance) stay in memory.
- `tests/unit/liveShapeCheck.test.ts` runs the script against a stubbed
  API only, to hold the GET-only and no-values properties.

Read the report for `live_keys_not_in_spec` and `enum_values`. If the
live shape matches the spec, the legacy names in `src/spec/entities.ts`
can be dropped; if it does not, the readers there are the one place to
adjust.

## Live shape check 2026-10-26

A read-only check of the live API (GET requests only, small `limit`,
no automation started, nothing changed) compared the returned shapes
with the vendored spec. Only field paths, types, enum words and
timestamp masks were noted; no record values were recorded.

- Verified, spec shape and none of the legacy names: endpoints (also
  inside group contents), organization vulnerabilities and the
  endpoints of a CVE, installed software (organization list and per
  endpoint), automation instances and schedules, missing updates of an
  endpoint, endpoint groups, and both list envelopes (`ResultPage` with
  `next_page`, `ResultPageAbridged` without it). `total_items` comes as a
  string, sometimes as a lower bound such as `25+`, and a page shorter
  than its `limit` can still carry `next_page`;
  `tests/unit/pagination.test.ts` holds both cases.
- Automation instance lists return `actions` empty, so
  `action1_automations_summary` no longer reports a per-template count.
- Pending: audit events. The key used lacks `view_audit`, so
  `GET /audit/events` answered 403 and the audit field names and
  timestamp format remain unverified.
- Not checkable read-only: whether `action1_deploy_update` accepts the
  version `Latest` (see [GOTCHAS](docs/GOTCHAS.md#deploy-update-version-latest-unverified)).

## Live API smoke tests

These runs used a real Action1 tenant with `.env` populated. They were
made while versions 0.1 to 0.3 were developed; the dates were not
recorded, and they have not been repeated for later versions. Endpoint
IDs were picked at runtime and are written here as `<EP_WIN>` and
`<EP_MAC>`. Results are anonymised: structural facts only.

The API credential used had a role without the vulnerabilities, audit
and subscription permissions, which is why some rows show a 403.

### Read-only smokes (round 1, v0.1 tool set)

| # | Test | Tool / call | Pass | Notes |
|---|---|---|:-:|---|
| 1 | Auth | first read call triggers OAuth; subsequent reads use cache | ✅ | `expires_in: 3600`. No second `POST /oauth2/token`. Refresh lead and dedup verified by unit test. |
| 2 | Read smoke | `list_organizations`, `list_endpoints` (limit 5), `get_endpoint` | ✅ | Org list non-empty. Endpoint list returns 5 items with the expected fields (`id`, `status`, `last_seen`, `OS`, `platform`, `online_status`). |
| 3 | Pagination | `list_endpoints` with `limit=5` page 1 vs page 2 (`from=5`) | ✅ | Page 1 and page 2 do not overlap. |
| 4 | Get endpoint (initial) | `get_endpoint`, which failed with 403 on `/general` | ✅ (after path fix) | See bugs 3 and 4 below. |
| 5 | Search endpoints | query=`mac`, query=`win` | ✅ | Mac query yields only Mac-platform results; Win query yields only Windows. |
| 6 | Templates | `list_action_templates`, `get_action_template` | ✅ | All 8 expected template ids present. Detail call returns full schema. |
| 7 | Missing updates | `list_missing_updates` (limit 5) | ✅ | Items returned with `id` field usable by `deploy_update`. |
| 8 | Vulnerabilities (403) | `list_vulnerabilities` | ✅ | Returns a structured tool error with the vulnerabilities permission hint. No crash. |
| 9 | Recent automations | `list_recent_automations` (limit 10) | ✅ | 10 items with terminal `status` and `percent_completed: 100` on the most recent. |
| 10 | Inspector `tools/list` | CLI `tools/list` | ✅ | All curated tools of v0.1 listed with full schemas, descriptions and annotations. |
| 11 | Connectivity heuristic | `is_endpoint_actually_online` against live data | ✅ | Correctly flags `Disconnected` endpoints offline. With the `last_seen`-format fix, fresh endpoints recognised online. |

### Live-execution smokes (round 2, read-only commands only)

A connected Windows and a connected macOS endpoint were located via
`list_endpoints` and the connectivity heuristic (status=Connected and
last_seen within 10 minutes). Only read-only commands were sent; no system
state was changed, no files written, no destructive templates invoked.

| # | Test | Tool / call | Pass | Notes |
|---|---|---|:-:|---|
| 12 | Win execution | `execute_and_wait` mode=`script` on `<EP_WIN>` with `Write-Output "smoke-ok"; Get-Date; hostname; (Get-ComputerInfo).OsName` | ✅ | Final status `Success`, `percent_completed: 100`. Output contains `smoke-ok` plus 3 expected lines. None of `Starting`/`Waiting`/`Completed` appear in the filtered output. |
| 13 | Mac execution | `execute_and_wait` mode=`script` on `<EP_MAC>` with `echo smoke-ok; hostname; uname -a; sw_vers -productVersion` | ✅ | Final status `Success`, `percent_completed: 100`. Output contains `smoke-ok`, `Darwin`, and a version-shaped line. The `"not applicable to Mac platform"` error did not occur: the macOS payload builder works end to end. |
| 14 | OS-aware wrapper | `run_script` (no wait) on `<EP_WIN>` and `<EP_MAC>` | ✅ | Both calls returned `instance_id`. Reported `platform: windows` for the Windows host (routed to `/policies/instances`) and `platform: macos` for the Mac host (routed to `/automations/instances`). |
| 15 | Timeout abort | `execute_and_wait` with a `Start-Sleep`-based 30 s read-only loop and `timeout_seconds: 10` | ✅ | Tool returned `isError: true` after ~15 s wall time with the message *"Polling exceeded 10s. Aborted to avoid runaway loop. Use action1_get_automation_status to inspect manually."* No hang, no leaked polling. |

### Not run live

Destructive templates (`reboot`, `deploy_update`, `deploy_package`,
`uninstall_program`, `run_data_collection`), group membership changes,
group-targeted scripts and all generated tools that change state were not
exercised against a live tenant. Their payloads are covered by unit and
integration tests against the spec; they should be validated on a
sacrificial endpoint before you rely on them. The README lists them under
[Validation status](README.md#validation-status).

### Round 3: generated tools after the 0.3.0 rename

Tool names in this round are the names of that time; the current names
are given where they changed.

| # | Test | Result | Notes |
|---|---|:-:|---|
| 16 | Inspector `tools/list` with the verb-first layer | ✅ | All curated and generated tools listed; all have valid annotations and inputSchema. |
| 17 | 10 GET operations via generated tools | ✅ 8 / ✅ 2 (graceful 403) | `GET /organizations` (now the curated `action1_list_organizations`), `GET /me` (`action1_get_me`), `GET /endpoints/groups/{orgId}` (`action1_list_endpoint_groups`), `GET /automations/schedules/{orgId}` (`action1_list_automation_schedules`), `GET /roles` (`action1_list_roles`), `GET /permissions` (`action1_list_permissions`), `GET /enterprise` (`action1_get_enterprise`), `GET /me/report-subscriptions` (`action1_list_report_subscriptions`) returned 200 with structured items. `GET /subscription/enterprise` (`action1_get_subscription`) and `GET /subscription/usage/enterprise` (`action1_get_subscription_usage`) returned a **graceful 403** with the standard permission hint (role without subscription permissions). |
| 18 | `action1_endpoint_groups_resolve` | ✅ | Returns `{ match_strategy, matches, total_groups }`. |
| 19 | `action1_recurring_schedules` | ✅ | Returns an empty list (no schedules in the test organization). |
| 20 | `action1_audit_log_search` | ✅ graceful 403 | `/audit/events` needs `view_audit`, which the test role did not have. Clear 403 hint. |
| 21 | `auto_paginate=true` on the generated `GET /endpoints/managed/{orgId}` tool (today covered by the curated `action1_list_endpoints`) | ✅ | Returned the same number of endpoints as `action1_list_endpoints`. |
| 22 | Destructive guard: default invocation | ✅ | `dry_run` defaults to `true`. Tool returns a preview with `dry_run: true, tool, would_send: { method, path, body }`. No HTTP call made. |
| 23 | Destructive guard: `dry_run: false` without `ACTION1_ALLOW_DESTRUCTIVE` | ✅ | Tool rejects with the env-switch hint. No HTTP call. |
| 24 | Destructive guard: `dry_run: false`, `confirm: "YES"`, env not set | ✅ | Tool rejects on env (env is checked before confirm). No HTTP call. |
| 25 | Destructive guard: env=true + confirm="YES" + dry_run=false on a connected Windows endpoint with a read-only `Write-Output` script | ✅ | Returns `instance_id`, action started. Read-only payload only. |
| 26 | Spec SHA pin | ✅ | `tests/unit/specSha.test.ts` confirms `openapi.json` matches the pinned `openapi.sha256` and that the generated `index.ts` references that SHA in its header. |

## Bugs caught and fixed during smoke testing

The live runs surfaced four real defects. All are fixed and covered by
tests or live verification.

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| 1 | `is_endpoint_actually_online` never compared `last_seen` against the threshold even for fresh endpoints. | Action1 emits `last_seen` as `YYYY-MM-DD_HH-MM-SS` (UTC), not ISO-8601. `Date.parse` returned `NaN`, so the staleness branch never fired. | `parseTimestamp` in `src/utils/lastSeen.ts` accepts both ISO and Action1's underscore format. Unit test in `tests/unit/lastSeen.test.ts`. |
| 2 | `detectPlatform` failed when the only available field was `OS` (uppercase) without a sibling `platform` string. | Lookup map used hard-coded lowercase keys. | Field lookup is case-insensitive in `src/utils/osDetect.ts`. A unit test asserts that `OS: "Windows 11 (25H2)"` and `OS: "macOS Sonoma 14.7.3"` resolve correctly. |
| 3 | `action1_get_endpoint` always failed with HTTP 403. | It called `/endpoints/managed/{org}/{ep}/general`. | First a list fallback was added; then see bug 4. |
| 4 | The `/general` path does not exist in the Action1 OpenAPI spec; it is a UI-routing artifact in `self` URLs. The canonical detail path is `/endpoints/managed/{org}/{ep}` (no suffix), which returns 200 with the full Endpoint schema under the same `view_endpoints` permission as listing. | The `self` URL value was followed blindly. | `fetchEndpointInfo` calls the canonical path first; the list fallback stays as defence in depth. Live `get_endpoint` reports `source: "canonical"`. Investigation in `docs/403-investigation.md`. |

## Edge cases worth poking later

- Run a deliberately long PowerShell command on a Windows host with a
  tight `timeout_minutes` and verify that the action-side timeout
  (Action1's, not the MCP's polling timeout) surfaces cleanly.
- Stop the agent service on a target, then run `run_script`. Status
  should drop to disconnected and `is_endpoint_actually_online` should
  reject the run with a clear message.
- The destructive templates listed under [Not run live](#not-run-live) on
  a sacrificial endpoint.
