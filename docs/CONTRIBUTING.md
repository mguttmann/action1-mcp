# Contributing

Thanks for thinking about contributing to `action1-mcp`. The project is
small and opinionated — read this guide before opening a pull request to
save us both time.

## Project layout

```
src/
  index.ts                   # entry: stdio | --http transport selection
  server.ts                  # McpServer setup + tool registration order
  config.ts                  # env validation (Zod), org-id resolution
  client/
    auth.ts                  # OAuth2 + refresh_token + 5-min refresh
    action1Client.ts         # fetch wrapper, retry, pagination, error mapping
    endpointInfo.ts          # canonical /endpoint path + list-fallback
    orgCache.ts              # session-scoped fuzzy org-name resolver
    pagination.ts, retry.ts, errors.ts (errors.ts redacts via logger)
  payloads/
    windowsPowerShell.ts     # Windows PolicyInstance builder
    macOsBash.ts             # macOS AutomationInstance builder (10 fields)
    shared.ts                # defaultName / humanize helpers (used by both)
  tools/
    *.ts                     # 27 curated tools (+ 6 in wrappers/)
    destructiveGuard.ts      # env + confirm + dry_run middleware
    helpers.ts               # jsonResult, runTool, orgIdShape, listOutputShape
    wrappers/                # 6 high-level workflow wrappers
    generated/               # 133 auto-generated tools (committed; verb-first names)
  resources/
    index.ts                 # 7 MCP resources (action1://...) with safeResourceRead
  prompts/
    index.ts                 # 6 slash-prompts
  utils/
    logger.ts                # structured JSON-line stderr with redaction +
                             # MCP logging/setLevel mutator
    markdownTable.ts, lastSeen.ts, osDetect.ts, filterOutput.ts
    cursor.ts                # buildCursor / parseCursor / pagedFetch
    capOutput.ts             # capItemList + endpoint projections
    format.ts                # humanise Action1 timestamps + display names
    sleep.ts                 # AbortSignal-aware setTimeout-Promise
  codegen/
    generate.ts              # codegen entry point (npm run codegen)
    naming.ts                # verb-first heuristic + 3-pass conflict resolver
    outputSchema.ts          # 200-response → list / single / ok-status
    curated-overrides.ts     # operationId skip list + NAME_OVERRIDES
    spec/
      openapi.json           # pinned Action1 OpenAPI spec
      openapi.sha256         # SHA-256 of the JSON, asserted by tests
      SOURCE.md              # provenance
  constants.ts               # CHARACTER_LIMIT, WIRE_LIMIT_BYTES, …
tests/unit/                  # Vitest, no network
tests/integration/           # SDK in-memory transport-pair tests
tests/security/              # destructive-guard truth table + redaction matrix
tests/performance/           # capItemList + markdown-table scaling
docs/                        # this guide and friends
evals/                       # 12 multi-hop questions for the skill harness
```

## Local setup

```bash
git clone https://github.com/mguttmann/action1-mcp.git
cd action1-mcp
npm install
cp .env.example .env  # fill in your Action1 credentials
npm run build         # tsc → dist/
npm test              # 527 tests across 4 categories
```

For live testing you also need credentials in `.env`. See
[`INSTALLATION.md`](INSTALLATION.md).

## Workflows

### Adding a curated tool

A curated tool is one where the OpenAPI spec doesn't capture the full
contract — typically because of a payload quirk, a workflow that spans
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
4. Write unit tests under `tests/unit/`. Cover both the happy path and
   each error branch.
5. Add the tool to `docs/USAGE.md` and (if relevant)
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
2. Define `argsSchema` as a Zod object — the args are *strings* in
   prompts (no booleans / numbers in the spec); coerce inside the
   prompt body if needed.
3. Return `messages: [{ role: "user", content: { type: "text", text } }]`
   where `text` walks Claude through the steps.
4. Default destructive operations to `dry_run: true`. Make the user
   say "go" before the actual mutation.
5. Document it in `docs/USAGE.md` under "Slash-prompts".

### Re-running codegen

Auto-generated tools live in `src/tools/generated/index.ts`. When the
Action1 OpenAPI spec changes:

```bash
# 1. Pull the new spec into src/codegen/spec/openapi.json
#    (manual step — the bundle is JS-embedded, see SOURCE.md for
#    the extraction recipe)

# 2. Update the SHA pin
shasum -a 256 src/codegen/spec/openapi.json | awk '{print $1}' > src/codegen/spec/openapi.sha256

# 3. Regenerate the tools
npm run codegen

# 4. Verify the diff is what you expect
git diff src/tools/generated/index.ts

# 5. Run tests + build
npm test && npm run build

# 6. Commit spec + sha + generated as one atomic change
git add src/codegen/spec/ src/tools/generated/
git commit -m "Refresh Action1 OpenAPI spec to <date>"
```

The `tests/unit/specSha.test.ts` test enforces step 2 — if you forget,
the test fails with a SHA mismatch and the build refuses to proceed.

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
  `exactOptionalPropertyTypes` is off (it's incompatible with the SDK
  in 1.29 — keep an eye on it).
- **Zod for every tool input.** Use `.describe()` on every parameter —
  the description is the prompt the model reads.
- **No `any`.** ESLint enforces `@typescript-eslint/no-explicit-any` as a
  warning; don't introduce new ones.
- **Dependencies are scrutinised.** Adding a runtime dep is a yellow
  flag — justify in the PR description.
- **No `console.log`.** Use the `log` helper from `src/utils/logger.ts`
  or write to `process.stderr` directly. Stdout is reserved for MCP.
- **Tool descriptions are prompt engineering.** Keep them tight. State
  what the tool does, what it returns, and (when ambiguous) when *not*
  to use it.

## Tests

- `npm test` runs all 527 tests across `tests/unit/`, `tests/integration/`, `tests/security/`, `tests/performance/`. Add tests for any behaviour change.
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
- Trailers: `Co-Authored-By: ...` for pair programming or AI-assisted
  authorship.
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
synthetic placeholder. `.env` is git-ignored — keep it that way.

## Pull requests

- Open against `main`. There is no `develop` / `release` branch.
- The PR description should answer: what changed, why, and how to test.
- Tests must pass (`npm test`) and the build must produce 0 lint
  warnings (`npm run build`).
- For changes that affect the auto-generated tools (codegen behaviour,
  spec pin, skip list), include the regenerated `index.ts` in the same
  PR.

## Filing issues

- **Bug report**: include the version (commit SHA), the MCP host, the
  exact tool call, and the full stderr output. Redact your real
  credentials and customer identifiers.
- **Feature request**: explain the workflow you're trying to express
  through the agent, not the API endpoint you want wrapped. We add
  endpoints when they unblock workflows.
- **Security report**: use the
  [private security advisory](https://github.com/mguttmann/action1-mcp/security/advisories/new),
  not a public issue.

## License

MIT. By contributing, you agree your contributions are licensed under
the same terms. See [`LICENSE`](../LICENSE).
