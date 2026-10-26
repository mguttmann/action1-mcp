# Contributing

Thanks for thinking about contributing to `action1-mcp`. The project is
small, opinionated and maintained by one person on a best-effort basis:
read this guide before opening a pull request to save us both time.
Everyone taking part follows the [Code of Conduct](../CODE_OF_CONDUCT.md).
Bug reports and feature requests use the issue templates; security
reports go to a private advisory (see
[`SECURITY.md`](SECURITY.md#reporting-a-vulnerability)).

## Project layout

```
src/
  index.ts                   # entry: CLI parsing, stdio | --http, --help, --version
  http.ts                    # Streamable HTTP app: rate limit, Host/Origin, token
  server.ts                  # McpServer setup, server instructions, registration
  config.ts                  # env validation (Zod), --help env table, org allowlist
  version.ts                 # server version, read from package.json
  client/
    auth.ts                  # OAuth2 + refresh_token + proactive refresh
    action1Client.ts         # fetch wrapper, retry, timeouts, path safety, errors
    endpointInfo.ts          # canonical /endpoint path + list-fallback
    pagination.ts, retry.ts, errors.ts (errors.ts redacts via logger)
  payloads/
    policyInstance.ts        # platform-neutral PolicyInstance (template) builder
    windowsPowerShell.ts     # Windows run_powershell builder (on policyInstance)
    macOsBash.ts             # macOS AutomationInstance builder (10 fields)
    shared.ts                # defaultName / humanize helpers (used by both)
  tools/
    *.ts                     # curated tools, grouped by area
    registry.ts              # strict inputs, toolset filter, tool_call logging
    destructiveGuard.ts      # env switches + confirm + dry_run, audit events
    orgScope.ts              # ACTION1_ALLOWED_ORG_IDS checks for bodies and raw paths
    raw.ts                   # action1_raw_request
    startAction.ts           # shared start path: OS routing, guard + POST, instance id
    helpers.ts               # jsonResult, runTool, orgIdShape, listOutputShape
    wrappers/                # high-level workflow wrappers
    generated/index.ts       # auto-generated tools (written by npm run codegen, committed)
    generated/runtime.ts     # hand-written shared runtime for the generated tools
  resources/
    index.ts                 # MCP resources (action1://...)
  prompts/
    index.ts                 # slash-prompts
  utils/
    logger.ts                # structured JSON-line stderr with redaction
    audit.ts                 # destructive_executed event, request body digest
    bearerAuth.ts            # constant-time bearer token check for --http
    requestContext.ts        # per-call request_id and counters for logging
    pii.ts                   # ACTION1_REDACT_PII masking
    csv.ts                   # CSV formula-injection defence
    markdownTable.ts, lastSeen.ts, osDetect.ts, filterOutput.ts
    cursor.ts                # buildCursor / parseCursor / pagedFetch
    capOutput.ts             # capItemList + endpoint projections
    format.ts                # humanise Action1 timestamps + display names
    sleep.ts                 # AbortSignal-aware setTimeout-Promise
  spec/
    generated.ts             # spec fields and enums curated tools read (npm run codegen)
    entities.ts              # tolerant readers per entity (spec name, then legacy name)
    time.ts                  # Action1 YYYY-MM-DD_HH-MM-SS timestamps
  codegen/
    generate.ts              # codegen entry point (npm run codegen)
    naming.ts                # verb-first heuristic + 3-pass conflict resolver
    outputSchema.ts          # 200-response → list / single / ok-status
    zodEmit.ts               # request-body and response schemas → Zod source
    curated-overrides.ts     # skip list, NAME_OVERRIDES, read-ish allowlist
    specContract.ts          # paths of the spec fields and enums curated tools read
    spec/
      openapi.json           # pinned Action1 OpenAPI spec
      openapi.sha256         # SHA-256 of the JSON, asserted by tests
      SOURCE.md              # provenance + refresh workflow
      known-undocumented-endpoints.json  # endpoints curated tools use outside the spec
  constants.ts               # CHARACTER_LIMIT, WIRE_LIMIT_BYTES, …
tests/unit/                  # Vitest, no network
tests/integration/           # SDK in-memory transport-pair tests
tests/security/              # destructive-guard truth table + redaction matrix
tests/performance/           # capItemList + markdown-table scaling
docs/                        # this guide and friends
evals/                       # evaluation questions for an LLM-driven harness
scripts/                     # spec fetch, coverage and permissions tables, MCPB build
```

## Local setup

```bash
git clone https://github.com/mguttmann/action1-mcp.git
cd action1-mcp
npm ci
cp .env.example .env  # fill in your Action1 credentials (live testing only)
npm run build         # tsc -> dist/ (no checks; use npm run check)
npm test              # all test categories
```

For live testing you also need credentials in `.env`. See
[`INSTALLATION.md`](INSTALLATION.md).

Node.js versions: the server itself runs on Node.js 22.12 or newer
(`engines` in `package.json`; the CI job `node-floor` builds, tests and
starts it on exactly 22.12). The development tools need a little more:
ESLint 10 requires Node.js 22.13 or newer on the 22 line, so use 22.13+
(or 24+) for `npm run lint` and `npm run check`.

Windows: `npm run build:mcpb` runs `bash scripts/build-mcpb.sh`. Run it
from Git Bash (part of Git for Windows), so `bash` is Git's and not the
WSL launcher. The CI job `cross-os` builds the bundle that way on
Windows and on macOS. The repository's `.gitattributes` keeps `*.sh`
files at LF line endings, which bash needs.

## Workflows

### Adding a curated tool

A curated tool is one where the OpenAPI spec doesn't capture the full
contract - typically because of a payload quirk, a workflow that spans
multiple HTTP calls, or a transformation we apply to the response.

1. Create or extend the file in `src/tools/` (e.g. `endpoints.ts`).
2. Use the conventions:
   - `...orgIdShape` if the tool needs an org.
   - `...destructiveGuardShape` and `...targetTypeShape` for destructive
     tools that target endpoints or endpoint groups.
   - `runTool(async () => …)` to map errors to MCP tool errors uniformly.
   - `runDestructive(args, { toolName, preview }, async () => …)` after
     building the payload, before sending it.
3. Add a registration call in `src/server.ts`.
4. Register the tool with a literal name, `server.registerTool("action1_...", ...)`,
   shaped `action1_<verb>_<resource>` (`tests/unit/naming.test.ts` lists
   the verbs and the few older names kept for compatibility).
   The codegen scans every `.ts` file under `src/tools/` (except
   `generated/`) for these names and drops a generated tool that would
   collide; run `npm run codegen` afterwards.
   `tests/integration/generatedTools.test.ts` fails if the scan and the
   tools the server actually registers disagree.
5. Read fields of Action1 records through `src/spec/entities.ts`, not
   with hand-written field names or enum literals. A field or enum the
   readers do not cover yet gets a path in `src/codegen/specContract.ts`,
   `npm run codegen`, and a reader that takes the spec name first;
   `tests/unit/specContract.test.ts` checks every used field and value
   against the spec. Build test records with `specExample` from
   `tests/helpers/specFixtures.ts`.
6. Call only documented spec paths. An undocumented path must be added to
   `src/codegen/spec/known-undocumented-endpoints.json` with a reason
   (`tests/unit/curatedPaths.test.ts` enforces this).
7. Write unit tests under `tests/unit/`. Cover both the happy path and
   each error branch.
8. Add the tool to `docs/USAGE.md` and (if relevant)
   `docs/EXAMPLES.md`.

### Adding a high-level wrapper

A wrapper composes one or more API calls into a single ergonomic tool
(e.g. `cve_remediation_plan` joins vulnerabilities and missing-updates).

1. Add a `register*` function to `src/tools/wrappers/index.ts`.
2. Register it in `registerWrapperTools` at the bottom of the file.
3. Document it in `docs/USAGE.md` under "High-level wrappers".

### Adding a Resource

Resources expose read-only context that hosts can pre-fetch (vs. tools
which the agent calls). Use them for "static" data: identity, catalogs,
snapshots.

1. Add a `server.registerResource(...)` block to
   `src/resources/index.ts`.
2. Pick the URI scheme: `action1://<noun>` for static, or
   `new ResourceTemplate("action1://<noun>/{param}", ...)` for templated.
3. Return `contents: [{ uri, mimeType: "application/json", text }]`.
4. Document the URI in the table in `docs/USAGE.md`.

### Adding a Slash-prompt

Prompts are user-triggered. Use them when a workflow takes 3+ tool calls
and the user shouldn't need to remember the order.

1. Add a `server.registerPrompt(...)` block to `src/prompts/index.ts`.
2. Define `argsSchema` as a Zod object - the args are *strings* in
   prompts (no booleans / numbers in the spec); coerce inside the
   prompt body if needed.
3. Return `messages: [{ role: "user", content: { type: "text", text } }]`
   where `text` walks Claude through the steps.
4. Default destructive operations to `dry_run: true`. Make the user
   say "go" before the actual mutation.
5. Document it in `docs/USAGE.md` under "Slash-prompts".

### Re-running codegen

Auto-generated tools live in `src/tools/generated/index.ts`. To check
whether Action1 serves a different spec than the pinned one:

```bash
npm run spec:check   # exit 0: unchanged, 1: drift (with a diff summary)
```

To adopt a new spec, follow "Refreshing the snapshot" in
[`src/codegen/spec/SOURCE.md`](../src/codegen/spec/SOURCE.md): `npm run
spec:fetch`, move the candidate over `openapi.json`, update the SHA, `npm
run codegen`, review the diff, `npm test`, and commit spec, SHA and
generated file together.

`tests/unit/specSha.test.ts` fails when the committed spec, its SHA and
the generated file disagree; the CI codegen-roundtrip job fails when the
committed generated file is not what `npm run codegen` produces.

Every POST / PUT / PATCH / DELETE operation becomes a destructive tool
(confirm + dry_run). The only way to emit one without the guard is a
reviewed entry in `READISH_OPERATION_IDS` in
`src/codegen/curated-overrides.ts`; `tests/integration/generatedTools.test.ts`
holds this invariant against the generated file.

### Adding a generated tool override

If a single auto-generated tool is wrong (e.g. the spec lies about a
parameter), the simplest fix is to:

1. Add the operationId to `SKIP_OPERATION_IDS` in
   `src/codegen/curated-overrides.ts` with a one-line comment explaining why.
2. Hand-curate the tool in `src/tools/<area>.ts` and register it from
   `src/server.ts`.
3. Update `docs/api-coverage.md` to note the override.

## Code style

- **Strict TypeScript.** `tsconfig.json` already sets `strict`,
  `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`,
  `exactOptionalPropertyTypes` is off (turning it on currently needs
  small fixes in our own client code, not in the SDK).
- **Zod for every tool input.** Use `.describe()` on every parameter -
  the description is the prompt the model reads.
- **No `any`.** ESLint reports `@typescript-eslint/no-explicit-any` as an
  error.
- **Dependencies are scrutinised.** Adding a runtime dep is a yellow
  flag - justify in the PR description.
- **No `console.log`.** Use the `log` helper from `src/utils/logger.ts`
  or write to `process.stderr` directly. Stdout is reserved for MCP.
- **Tool descriptions are prompt engineering.** Keep them tight. State
  what the tool does, what it returns, and (when ambiguous) when *not*
  to use it.

## Tests

- `npm test` runs `tests/unit/`, `tests/integration/`, `tests/security/` and
  `tests/performance/`. Add a test for any behaviour change; for a bug,
  write the failing test first.
- `tests/unit/docsConsistency.test.ts` checks the Markdown docs: relative
  links and anchors resolve, no hand-written tool or test counts, and
  `docs/_coverage_table.md` is current. After a codegen run, regenerate it
  with `node scripts/regenerate-coverage-table.mjs` (and
  `docs/permissions.md` with `node scripts/generate-permissions-table.mjs`).
- Tests are pure-logic; no live API. Mock `fetch` via
  `vi.stubGlobal("fetch", …)` (see `tests/unit/auth.test.ts`).
- Live smoke tests are documented in [`TESTING.md`](../TESTING.md). They
  require `.env` and your real Action1 credentials. They are not part of
  CI.
- The destructive-tool unit tests must continue to assert that the guard
  fires in all four configurations (no-env / no-confirm / dry-run /
  happy-path).

## Commit conventions

- One logical change per commit.
- Imperative mood subject ("Add X", not "Added X" or "Adds X").
- Body explains *why*, not *what* (the diff shows what).
- Commit under your own name and e-mail address.
- Trailers: `Co-Authored-By: ...` for pair programming or AI-assisted
  authorship.
- Messages and code comments are in English and describe the current
  behaviour and its reason; history belongs in the commit message, not
  in a comment.
- Don't include `.env`, `dist/`, `node_modules/`, or any real customer
  identifiers (endpoint UUIDs, hostnames, user names) in commit
  messages.

## Pre-commit secret scan

Before every commit:

```bash
git status --short  # sanity check
git diff --cached    # review the actual changes
```

For a quick scan against your own customer-identifier patterns, keep a
local (un-committed) `scripts/secret-scan.local.sh` similar to:

```bash
# DO NOT COMMIT THIS FILE - it contains your environment's identifiers.
patterns=(
  '<your-company-substring>'
  '<your-hostname-prefix>'
  '<your-api-key-substring>'
  '<your-org-uuid-prefix>'
)
for p in "${patterns[@]}"; do
  out=$(grep -RIn --exclude-dir=node_modules --exclude-dir=dist \
    --exclude-dir=.git --exclude='.env' "$p" .)
  [ -n "$out" ] && echo "MATCH '$p': $out"
done
```

If anything matches, do not commit until you've replaced the value with a
synthetic placeholder. `.env` is git-ignored - keep it that way.

## Pull requests

- Open against `main`. There is no `develop` / `release` branch.
- The PR description should answer: what changed, why, and how to test.
- The pull request template has the checklist. `npm run check` must pass
  (lint with 0 warnings, typecheck of source and tests, format check, tests). `npm run build`
  only compiles; it does not run the checks.
- For changes that affect the auto-generated tools (codegen behaviour,
  spec pin, skip list), include the regenerated `index.ts` in the same
  PR.

## Filing issues

- **Bug report**: use the template. Include the version
  (`node dist/index.js --version`, or the commit SHA), the MCP host, the
  exact tool call and the stderr output. Redact credentials and customer
  identifiers.
- **Feature request**: explain the workflow you're trying to express
  through the agent, not the API endpoint you want wrapped. We add
  endpoints when they unblock workflows.
- **Security report**: use the
  [private security advisory](https://github.com/mguttmann/action1-mcp/security/advisories/new),
  not a public issue.

## Releases

Releases are cut by the maintainer; the steps are in
[`FAQ.md`](FAQ.md#how-is-a-release-cut).

## License

MIT. By contributing, you agree your contributions are licensed under
the same terms. See [`LICENSE`](../LICENSE). The vendored Action1 spec is
not covered by the MIT License; see [`NOTICE`](../NOTICE).
