# Backlog: open items

Items that are known and deliberately not fixed in 0.6.0: minor defects,
hardening without a reproduced failure, test gaps, deliberate decisions,
and steps only the repository owner can take. The next change that
touches an area reads its items first and takes the matching ones
along; the change that fixes an item removes it. Each line says what is
open and why.

## Runtime, protocol and HTTP

- Execute-and-wait without progress support: a client that neither requests progress nor resets its timeout loses the `instance_id` when its request timeout is shorter than `timeout_seconds`. A fix needs a start/status split or a new tool parameter, which changes the public tool surface; USAGE advises a lower `timeout_seconds` or the start tools plus `action1_wait_for_automation`.
- Metrics: there is no metrics endpoint (request counters, latency). `/healthz` and `/readyz` cover liveness and readiness; metrics would be new surface.
- Injected config only partly used: `buildServer({ config })` feeds the instructions, tool sets and client, but the guard, org scope and PII masking read `loadConfig()`. The production entry points pass the same config, so only callers of the exported factory with a different config are affected.
- Fixed HTTP rate limit: the per-IP limit is not configurable, so clients behind one gateway or one cloud egress address share a bucket. Needs a validated env var and a DEPLOYMENT note.
- SDK internals: tool-call instrumentation and the tool-set policy wrap SDK methods; a future 2.x release could drop the `tool_call` lines without a startup warning.
- Wildcard bind aliases: only `0.0.0.0` and `::` count as wildcard binds for the `MCP_HTTP_ALLOWED_HOSTS` startup rule; `::0` and similar spellings pass it. The Host check still applies, so this is no rebinding hole.
- Single HTTP token: one static token without a rotation overlap or per-client tokens, and the `Bearer` scheme is matched case-sensitively.
- Out-of-band confirmation: the model sets `confirm` and `dry_run` itself; an elicitation-based confirmation for clients that support it is not built.
- Server per HTTP request (decision): every HTTP request builds a server; SDK v2 forbids reusing one server across transports, so there is no pooling. No test holds a measurement.
- Cancellation on the stateless 2025 HTTP path (decision): a `notifications/cancelled` sent in a separate request does not reach the running call; closing the call's HTTP request cancels it (FAQ). A cross-request cancel registry is not built, because request ids are unique per client only and a cancel could hit another client's call that shares the token.
- Long-running memory: the bounded maps of the HTTP transport are tested for eviction, but there is no long-running RSS measurement.
- Pagination without progress check (hardening): a list walk trusts the envelope and the page length; it has no repeated-page check or page cap for endpoints the spec marks as not paged (`/reports/all`, `/automations/action-templates`). Live behaviour is unverified.
- Resource size: `action1://endpoints/{orgId}` and `action1://vulnerabilities/{orgId}` load the whole list before capping the output.
- Endpoint search: `action1_search_endpoints` walks the list client-side and does not use the spec's server-side `filter` as a pre-filter, because its live semantics are unverified and a wrong guess would drop matches.
- Audit search event filter: `action1_audit_log_search` does not send `event` upstream; the spec parameter takes exact comma-separated names while the tool filters on a substring.
- Readiness probe exposure: `/readyz` answers without the bearer token and outside the Host/Origin check, and shows the version, whether the config loads and the token state (`cached`, `failing`, `not_acquired`), which tells anyone who reaches the port whether the Action1 credential works.
- Readiness config check: the `config` check of `/readyz` in `src/http.ts` is always `ok` once the server has started, so it adds no signal.
- PII masking depth: `redactPii` in `src/utils/pii.ts` stops at depth 32 while `redactSecretKeys` goes to 256; Action1 responses are not that deep, so the gap is theoretical.
- PII column names: `isPiiKey` in `src/utils/pii.ts` does not match headers such as `Last User`, `Primary User` or `Last Logon User`, so those report and CSV columns stay visible with `ACTION1_REDACT_PII`.
- PII in quoted CSV headers: a quoted header that contains a comma (`"User Name, Login"`) normalises to a name no rule matches, so its column is not masked.
- CSV line endings (cosmetic): `redactPiiInCsv` joins all records with the first line ending it saw, so a CSV with mixed `\n` and `\r\n` comes back with one kind.
- Org scope key spelling (hardening): `isOrgKey` in `src/tools/orgScope.ts` strips only whitespace, `_`, `.` and `-`, so bracketed query or body keys such as `org_id[]` or `orgId[0]` do not match `ORG_KEY` and pass the `ACTION1_ALLOWED_ORG_IDS` check in `action1_raw_request`. Whether Action1 reads such keys as an org id is unverified.
- Capped page cursor: when the upstream returns more items than `limit`, the generated list runtime (`src/tools/generated/runtime.ts`) sets `next_cursor` to `from + limit`; an upstream that also ignores `from` would return the same items again as the next page. The cursor path made the same assumption before.

## Tools and code generation

- Live record shapes, audit events (spec binding): the read-only live check of 2026-10-26 confirmed the spec shape for every other record the readers in `src/spec/entities.ts` use (`TESTING.md`); audit events stay unverified until the key has `view_audit`. The legacy fallbacks stay deliberately, since none can shadow a live spec field.
- Deploy update version `Latest` (unverified): `action1_deploy_update` passes `Latest` from vulnerability and missing-update rows through unchanged; whether the API accepts it (or an empty string) needs a real deploy against a test endpoint (`docs/GOTCHAS.md`).
- Tool surface: destructive tools stay visible without `ACTION1_ALLOW_DESTRUCTIVE` (previews work), near-duplicate pairs remain (`list_missing_updates` / `list_endpoint_missing_updates`, `audit_log_search` / `list_audit_events`), and `tools/list` is large; `ACTION1_TOOLSETS` is the lever.
- Tool names: older names that break the `action1_<verb>_<resource>` rule stay, because consumers call tools by name and the baseline test forbids renames; the naming test grandfathers exactly these.
- Curated output schemas: the curated tools listed in `CURATED_WITHOUT_SHAPE` (`tests/integration/specShapes.test.ts`) still have an open output schema; whoever touches their files shrinks that list.
- Execute-and-wait start path (structure): `action1_execute_and_wait` starts its action through its own POST and instance id parsing instead of the shared start path in `src/tools/startAction.ts`. Its error texts now match (masked body, no "may have started" on a 4xx), but the two paths can drift.
- Polling deadline: the poll loop in `src/tools/workflows.ts` sleeps a full interval without clamping it to the deadline, so `timeout_seconds` can be exceeded by up to one interval.
- Start error classification: the execute-and-wait start path in `src/tools/workflows.ts` treats every 4xx as "nothing started", including a 408 that a proxy or load balancer can send after forwarding the request, so the "may have started" hint is dropped in that case. No damage reproduced.
- Stale comment: the comment above `cursorListOutputShape` in `src/tools/helpers.ts` contradicts the current list contract.
- Generated list envelope: for generated list tools without `limit`/`from` paging, the `{ items: [...] }` branch in `src/tools/generated/runtime.ts` caps on its own path, so a list can look different depending on the envelope form. Paged tools share `pagedListResult` on every path.
- Wrapper module: `fuzzyFind` and the wrapper tools share one file in `src/tools/wrappers/index.ts`.
- Preview of query parameters: the dry-run preview and the audit line of a mutating call show method, path and body, not its query parameters.
- Credential key patterns: `private_key`, `*_secret`, `passphrase` and `credentials` are not in the redactor's key list.
- Generated descriptions: some generated descriptions still end in a sentence fragment or start with a stray quote.
- Upload tools: `action1_init_software_upload` and `action1_upload_software_chunk` are registered although they always return an explanatory error.
- Schema portability: generated output schemas emit `additionalProperties: {}`, which strict hosts report as warnings.
- CVE plan endpoint route: the CVE plan of one endpoint falls back to the legacy route only on a 404, and no test covers that fallback. Whether the live API honours `endpoint_id` on `GET /vulnerabilities/{orgId}` is unverified; if it ignored the filter with a 200, every CVE of the organization would be planned for that endpoint. `scripts/live-shape-check.mjs` should probe it before a release relies on it.
- CVE plan package versions: `dedupePackages` in `src/tools/wrappers/index.ts` keys on `package_id` only, so when one package appears with several versions in `software[].available_updates`, only the first version stays in `candidate_packages`, which may not be the version that fixes the CVE on every affected endpoint.
- Reboot filter spelling: `action1_list_endpoints` accepts `Yes`/`No` in any case and maps them to the spec value, while the generated `action1_list_group_contents` accepts only `Yes`/`No` (documented as a breaking change, but inconsistent between two similar tools).

## Tests

- Compatibility baseline: `toolsListBaseline.test.ts` compares names, required inputs, annotations, output schemas, resources and prompts with the v0.5.0 fixture, but not input types or enum values (several were narrowed on purpose in 0.6.0 and are listed as breaking changes).
- HTTP edge cases: no test for the 1 MB body limit, the `Host` of a wildcard bind or the `Retry-After` value.
- E2E and the working tree: the E2E writes into the repository's `dist/` before rebuilding it; a failed build leaves a stub there.
- Mutation tests: the guard, org scope, raw request, HTTP, PII and retry modules have per-file coverage floors, but there are no mutation tests, and the logger has no floor of its own.
- Real waits: the jitter test and the progress tests wait in real time.
- Log noise: tests write the real logger's JSON lines to stderr.
- Start without retry: no test pins that the start POST of an action is sent once on a 429.
- Equivalent mutants: the origin and base-path invariant in `buildUrl` (`src/client/action1Client.ts`) yields equivalent mutants, so mutation scores there need a manual note.
- Report column names (unverified): CSV and report masking matches column headers by name; the real Action1 report column names are unverified, and a column whose display name matches no rule stays visible (SECURITY.md says so).
- CVE plan endpoint cap: the cap on `affected_endpoints` in the CVE plan has no test of its own.
- Test helpers: `tests/integration/generatedTools.test.ts` keeps its own copy of the input sampler in `tests/helpers/toolArgs.ts`, and the bounded-state test repeats the map cap of `src/http.ts` instead of importing it.

## CI, release and supply chain

- Windows CI (built, not yet run): the `cross-os` job builds the bundle with Git Bash and starts it on `windows-latest`; it has only run on macOS so far. The first CI run on GitHub shows whether a path or tool trips on Windows.
- Spec fetch: `scripts/fetch-spec.mjs` evaluates the literal extracted from Action1's Swagger UI with `node:vm`, which is no sandbox.
- Release signing and concurrency: the `.mcpb` is not signed with `mcpb sign`, and `release.yml` has no concurrency group.
- Release notes: GitHub releases use `--generate-notes` instead of the CHANGELOG section, and nothing checks that the section exists for the tag.
- Build scripts: `scripts/*.mjs` are linted but not type-checked or formatted, and there is no shellcheck.
- Dependabot: the majors held back on purpose (typescript, express, `@types/express`) are not ignored, and vitest and `@vitest/coverage-v8` are not grouped.
- Install scripts: there is no `allowScripts` policy for `esbuild` and `fsevents`.
- MCP Registry workflow (built, not yet run; it can only run once it is on `main`): the lookup that skips an already listed version does not pass `include_deleted`, so a version set to `deleted` with `mcp-publisher status` makes a re-run fail at publish instead of skipping; a hand-started run takes the static fields of `server.json` from whatever branch it is started on, not necessarily `main`; the test does not compare the committed `fileSha256` with the release (the workflow overwrites it).
- MCP Registry workflow hardening (red team minors): set `GH_TOKEN`/`GH_REPO` only on the download step so `mcp-publisher` never sees them; a hand-started run from any branch can bring its own workflow file and still gets a namespace-wide OIDC token (inherent to write access; consider restricting dispatch to `main`); align the `npm-publish` line in the `release.yml` header comment; mention the registry as a source in `docs/INSTALLATION.md`.
- Glama listing docs (review minors): the field list of Glama's admin build form in `docs/maintainers/repo-settings.md` section 7 comes from a third-party maintainer checklist, not from Glama's own docs, so check it at the first use; the README line on `glama.json` sits under "MCP Registry" although Glama is a separate directory; the intro of `repo-settings.md` speaks of GitHub settings while sections 6 and 7 cover outside listings.
- Tools outside the lockfile: the pinned Inspector (`npx`) and the gitleaks version in `ci.yml` are not tracked by Dependabot.
- Bundle metadata: the MCPB manifest's `compatibility` block declares only the Node range (no `platforms`, no `claude_desktop`), and the bundled README is the developer build guide.
- Bundle wizard: the MCPB wizard does not offer `ACTION1_ALLOWED_ORG_IDS`, `ACTION1_TOOLSETS` or `ACTION1_REDACT_PII`.
- Build-tool advisories: `@anthropic-ai/mcpb` brings dev-only advisories (node-forge, tmp, zod 3) without a fix; there is no `tmp` override, exception register or full-tree audit. The tool is not deployed (`npm prune --omit=dev`).
- npm package tree: there is no shrinkwrap, so an npm install resolves the runtime tree anew within the declared ranges, while the bundle ships the locked tree its SBOM describes.
- Majors held back (decision): typescript stays on 6.0 because typescript-eslint supports typescript below 6.1 only.
- Release date: CHANGELOG dates 0.6.0 although no tag exists yet; set the date when tagging.
- Vendored spec text: `src/codegen/spec/openapi.json` contains en dashes from Action1's own descriptions; it stays byte for byte as fetched, and the dash check in `tests/unit/docsConsistency.test.ts` skips it.
- Example environment: the comments in `.env.example` are written by hand; its key set is held by a test, its texts are not.

## Owner steps (repository, accounts, history)

- Repository settings: ruleset with required checks on `main` and release tags (the check names changed: `node-floor`, `e2e (22)`, `e2e (24)`, `cross-os (windows-latest)`, `cross-os (macos-latest)` replace the single `e2e`), workflow permissions read, CodeQL, Dependabot, private vulnerability reporting. Recommendation: apply [`docs/maintainers/repo-settings.md`](docs/maintainers/repo-settings.md) when the repository goes public. While the repository is private, macOS and Windows runner minutes count with a multiplier; if minutes run short, limit `cross-os` to push and schedule.
- Vulnerability reporting: the advisory link in SECURITY, README and CODE_OF_CONDUCT works only after private vulnerability reporting is enabled; check the link after enabling it.
- Branch history: earlier commits of the release branch carry an internal path and the maintainer's work e-mail in commit metadata. Recommendation: squash or rewrite the branch under the chosen public identity before it reaches `main`.
- Live smoke before the tag: 0.6.0 has only the read-only live shape check. Recommendation: run `./scripts/inspector-smoke.sh` and `npm run live:shapes` read-only against a test tenant and record the result in `TESTING.md` before tagging.
- npm name: the package name is not reserved on npm. Recommendation: reserve it with the first manual publish (`docs/maintainers/repo-settings.md`, section 5) before the repository goes public, or open the publish gate at the same time.
- Consumers on the old history: a consumer that pins a commit of the history before the 0.5.0 squash should move to the release commit of 0.6.0 and check a fresh recursive clone.
- Initial commit author (decision): the first commit keeps its author; new commits use the maintainer identity, and there is no DCO sign-off requirement. The v0.6.0 tag needs the owner's go.
- Vendored spec (decision): the Action1 spec stays vendored under `NOTICE`, outside the MIT grant.
- Code owners: there is no `CODEOWNERS` file; with one maintainer it adds little.
