# Testing

Five layers:

1. **Unit tests** (`tests/unit/`, Vitest) — pure logic, no network. Run on every build.
2. **Integration tests** (`tests/integration/`) — drive the McpServer
   through the SDK's in-memory transport pair so we exercise tool /
   resource / prompt registration end-to-end without booting an actual
   transport.
3. **Security tests** (`tests/security/`) — destructive-guard truth
   table (9 hand-picked input combinations covering distinct logic paths) + redaction matrix for the structured
   logger.
4. **Performance tests** (`tests/performance/`) — `capItemList` and
   `maybeRenderMarkdownTable` scaling on 5k–10k-item inputs.
5. **Smoke tests** (manual) — exercise the live API with a populated
   `.env`. Not in CI.

## Unit + integration + security + performance

```bash
npm test                  # all four categories — 527 tests
npm run test:unit         # 37 files
npm run test:integration  # 4 files (MCP-protocol round-trip via the SDK in-memory pair)
npm run test:security     # destructiveGuard.matrix + redaction
npm run test:performance  # capItemList + markdownTable scaling
```

Coverage:

| File | What it locks down |
|---|---|
| `tests/unit/auth.test.ts` | Token cache reuse, 5-min refresh lead, concurrent in-flight dedup, manual invalidate. |
| `tests/unit/macOsBash.payload.test.ts` | All ten Mac-specific `run_script` fields are present and typed correctly. |
| `tests/unit/windowsPowerShell.payload.test.ts` | `success_exit_codes` is never empty; defaults are correct. |
| `tests/unit/filterOutput.test.ts` | Status-marker filter, edge cases. |
| `tests/unit/lastSeen.test.ts` | Stale-`last_seen` detection, including Action1's non-ISO format. |
| `tests/unit/osDetect.test.ts` | Platform classification across vendor strings, including Action1's uppercase `OS`. |
| `tests/unit/pagination.test.ts` | `paginate` walks pages and respects `maxItems`; envelope parser. |
| `tests/unit/runtime.test.ts` | Generated-tool runtime: query/path forwarding, auto_paginate, destructive guard short-circuit. |
| `tests/unit/wrappers.test.ts` | `fuzzyFind` + UUID_RE behaviour. |
| `tests/unit/logger.test.ts` | redactString / redact patterns + setLogLevel roundtrip. |
| `tests/unit/destructiveGuard.test.ts` | Three-layer guard happy paths. |
| `tests/unit/markdownTable.test.ts` | Markdown rendering: headers, escaping, truncation. |
| `tests/unit/capOutput.test.ts` | capItemList binary-search trim, compact endpoint projection. |
| `tests/unit/specSha.test.ts` | Pinned spec SHA matches the source file + generated header. |
| `tests/integration/server.test.ts` | tools/list, resources/list, prompts/list, annotation invariants, destructive-tool requires-confirm. |
| `tests/security/destructiveGuard.matrix.test.ts` | 9-case truth table covering distinct branches of env × auto-confirm × confirm × dry_run. |
| `tests/security/redaction.test.ts` | Bearer / api-key / sk-* / password / authorization patterns + recursion + truncation. |
| `tests/performance/cap.test.ts` | 10k-item capItemList in <500 ms, 5k-row markdown table under 25 KB / 200 ms. |

Latest run: **527/527 passing** (`npm test`).

## Inspector schema-validation smoke (`scripts/inspector-smoke.sh`)

Runs the live MCP-Inspector CLI against ~18 read-only and destructive
(dry-run) tools and flags any `Output validation error` /
`Structured content does not match` / register-time crash. This catches
schema bugs that unit tests can't see — TypeScript treats both sides of
the structured-content contract as `Record<string, unknown>`, so a tool
that returns `{ total, by_status, ... }` against an `outputSchema`
declaring only `{ data?: ... }` only fails at runtime under the SDK
validator.

```bash
npm run build
./scripts/inspector-smoke.sh   # exits 0 if every tool's schema is healthy
```

The script is deliberately tiny — runs in under a minute against a
populated `.env`. Add it to your release checklist.

## Live API smoke tests

Live runs against the configured Action1 instance with `.env` populated. Test endpoints live in
`.env` only and never enter the repo. Online-only endpoint IDs are picked at runtime via
`list_endpoints` + connectivity heuristic; they are referenced in this file as `<EP_WIN>` and
`<EP_MAC>` and never written out. All findings are anonymised — counts and structural facts only.

### Read-only smokes (round 1)

| # | Test | Tool / call | Pass | Notes |
|---|---|---|:-:|---|
| 1 | Auth | first read call triggers OAuth; subsequent reads use cache | ✅ | `expires_in: 3600`. No second `POST /oauth2/token`. Refresh lead and dedup verified by unit test. |
| 2 | Read smoke | `list_organizations`, `list_endpoints` (limit 5), `get_endpoint` | ✅ | Org list non-empty. Endpoint list returns 5 items with the expected fields (`id`, `status`, `last_seen`, `OS`, `platform`, `online_status`). |
| 3 | Pagination | `list_endpoints` with `limit=5` page 1 vs page 2 (`from=5`) | ✅ | Page 1 ∩ Page 2 = ∅. |
| 4 | Get endpoint (initial) | `get_endpoint` — was failing with 403 on `/general` | ✅ (after path fix) | See Bugs 3 + 4 below. |
| 5 | Search endpoints | query=`mac`, query=`win` | ✅ | Mac query yields only Mac-platform results; Win query yields only Windows. |
| 6 | Templates | `list_action_templates`, `get_action_template` | ✅ | All 8 expected template ids present. Detail call returns full schema. |
| 7 | Missing updates | `list_missing_updates` (limit 5) | ✅ | Items returned with `id` field usable by `deploy_update`. |
| 8 | Vulnerabilities (403) | `list_vulnerabilities` | ✅ | Returns a structured tool error with the `vulnerabilities scope` hint. No crash. |
| 9 | Recent automations | `list_recent_automations` (limit 10) | ✅ | 10 items with terminal `status` and `percent_completed: 100` on the most recent. |
| 10 | Inspector — `tools/list` | CLI `tools/list` | ✅ | All 22 curated v0.1 tools listed with full schemas, descriptions, and annotations. (Now 166 with the verb-first refactor — see Wave 3.) |
| 11 | Connectivity heuristic | `is_endpoint_actually_online` against live data | ✅ | Correctly flags `Disconnected` endpoints offline. With the `last_seen`-format fix, fresh endpoints recognised online. |

### Live-execution smokes (round 2 — read-only commands only)

A connected Windows and a connected macOS endpoint were located via
`list_endpoints` + the connectivity heuristic (status=Connected and
last_seen ≤ 10 min). Only read-only commands were sent; no system state was
mutated, no files written, no destructive templates invoked.

| # | Test | Tool / call | Pass | Notes |
|---|---|---|:-:|---|
| 12 | Win execution | `execute_and_wait` mode=`script` on `<EP_WIN>` with `Write-Output "smoke-ok"; Get-Date; hostname; (Get-ComputerInfo).OsName` | ✅ | Final status `Success`, `percent_completed: 100`. Output contains `smoke-ok` plus 3 expected lines. None of `Starting`/`Waiting`/`Completed` appear in the filtered output. |
| 13 | Mac execution | `execute_and_wait` mode=`script` on `<EP_MAC>` with `echo smoke-ok; hostname; uname -a; sw_vers -productVersion` | ✅ | Final status `Success`, `percent_completed: 100`. Output contains `smoke-ok`, `Darwin`, and a version-shaped line. **Stop-condition (`"not applicable to Mac platform"`) did not trigger** — the macOS payload builder is correct end-to-end. |
| 14 | OS-aware wrapper | `run_script` (no wait) on `<EP_WIN>` and `<EP_MAC>` | ✅ | Both calls returned `instance_id`. Reported `platform: windows` for the Windows host (routed to `/policies/instances`) and `platform: macos` for the Mac host (routed to `/automations/instances`). |
| 15 | Timeout abort | `execute_and_wait` with a `Start-Sleep`-based 30 s read-only loop and `timeout_seconds: 10` | ✅ | Tool returned `isError: true` after ~15 s wall time with the message *"Polling exceeded 10s. Aborted to avoid runaway loop. Use action1_get_automation_status to inspect manually."* No hang, no leaked Polling. |

### Tests deferred (no live execution this round)

None. All execution smokes from the original plan have been completed read-only.
Destructive templates (`reboot`, `deploy_*`, `uninstall_program`) were intentionally
not exercised; they are structurally covered by the payload-builder unit tests and
will be validated against a sacrificial endpoint when one is available.

### Wave 3: 100% coverage smokes

After the verb-first refactor landed (133 generated + 27 thematic curated incl. 6 workflow wrappers = 166 tools).

| # | Test | Result | Notes |
|---|---|:-:|---|
| 16 | Inspector `tools/list` with the verb-first layer | ✅ | 166 tools listed (33 curated incl. 6 wrappers, 133 generated). All have valid annotations and inputSchema. |
| 17 | 10 random GET ops via auto-generated tools | ✅ 8 / ✅ 2 (graceful 403) | `organizations_get`, `me`, `endpoints_groups_org_id`, `policies_schedules_org_id_get`, `roles_get`, `permissions_get`, `enterprise_get`, `me_subscriptions_get` returned 200 with structured items. `license_enterprise_get` and `license_usage_enterprise_get` returned **graceful 403** with the standard scope hint — these endpoints sit under `/subscription/...`, which our automation API key role does not include. |
| 18 | `action1_endpoint_groups_resolve` | ✅ | Returns `{ match_strategy, matches, total_groups }`. |
| 19 | `action1_recurring_schedules` | ✅ | Returns 0 schedules in the configured org (none currently scheduled). |
| 20 | `action1_audit_log_search` | ✅ graceful 403 | `/audit/events` is gated by the `view_audit` permission, which our key does not carry. Tool surfaces a clear 403 hint. |
| 21 | `auto_paginate=true` on `action1_endpoints_managed` | ✅ | Returns 163 endpoints, matching the count from `action1_list_endpoints`. |
| 22 | Destructive guard — default invocation | ✅ | `dry_run` defaults to `true`. Tool returns a preview with `dry_run: true, tool, would_send: { method, path, body }`. No HTTP call made. |
| 23 | Destructive guard — `dry_run: false` without `ACTION1_ALLOW_DESTRUCTIVE` | ✅ | Tool rejects with the env-switch hint. No HTTP call. |
| 24 | Destructive guard — `dry_run: false`, `confirm: "YES"`, env not set | ✅ | Tool rejects on env (env is checked before confirm). No HTTP call. |
| 25 | Destructive guard — env=true + confirm="YES" + dry_run=false on a connected Windows endpoint with a read-only `Write-Output` script | ✅ | Returns `instance_id`, action started successfully. Read-only payload only. |
| 26 | Spec SHA pin | ✅ | `tests/unit/specSha.test.ts` confirms `openapi.json` SHA matches the pinned `openapi.sha256` and that the generated `index.ts` references that SHA in its header. |

## Bugs caught and fixed during smoke testing

The live runs surfaced four real defects. All are now fixed and covered by tests
or live verification.

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| 1 | `is_endpoint_actually_online` never compared `last_seen` against the threshold even for fresh endpoints. | Action1 emits `last_seen` as `YYYY-MM-DD_HH-MM-SS` (UTC), not ISO-8601. `Date.parse` returned `NaN`, so the staleness branch never fired. | `parseTimestamp` in `src/utils/lastSeen.ts` accepts both ISO and Action1's underscore format. New unit test in `tests/unit/lastSeen.test.ts`. |
| 2 | `detectPlatform` would fail when the only available field was `OS` (uppercase) without a sibling `platform` string. | Lookup map used hard-coded lowercase keys. | Field lookup is now case-insensitive in `src/utils/osDetect.ts`. New unit test asserts that `OS: "Windows 11 (25H2)"` and `OS: "macOS Sonoma 14.7.3"` resolve correctly. |
| 3 | `action1_get_endpoint` always failed with HTTP 403. | We were calling `/endpoints/managed/{org}/{ep}/general`. | (Initially) added a list-fallback. Then **see bug 4**. |
| 4 | The `/general` path itself does not exist in the Action1 OpenAPI spec — it is a UI-routing artifact in `self` URLs. The canonical detail path is `/endpoints/managed/{org}/{ep}` (no suffix), and it returns 200 with the full Endpoint schema using the same `view_endpoints` permission as listing. | We followed the `self` URL value blindly. | `fetchEndpointInfo` now calls the canonical path first; list-fallback retained as defence-in-depth. Live `get_endpoint` now reports `source: "canonical"`. Full investigation in `docs/403-investigation.md`. |

## Edge cases worth poking later

- Run a deliberately long PowerShell command on a Windows host with a tight
  `timeout_minutes` and verify the action-side timeout (Action1's, not the
  MCP's polling timeout) surfaces cleanly.
- Stop the Windows Update service on a target, then run `run_script`. Status
  should drop to disconnected and `is_endpoint_actually_online` should reject
  the run with a clear message.
- Destructive templates (`reboot`, `deploy_*`, `uninstall_program`) — these
  exist in the MCP but were intentionally not invoked in smoke testing.
  Schedule one round on a sacrificial endpoint when available.
