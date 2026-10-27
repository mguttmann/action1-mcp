# Repository settings (maintainers)

The workflows in `.github/workflows/` assume the GitHub settings below.
A workflow cannot set them itself; the repository owner applies them
once, in the web UI or with the `gh api` calls shown. Some features
(rulesets and private vulnerability reporting on a private repository,
CodeQL on a private repository) depend on the repository being public
or on the GitHub plan.

`tests/unit/releaseChain.test.ts` fails when a job is added to
`ci.yml` without being listed in the required checks below.

## 1. Ruleset for `main`

Settings > Rules > Rulesets > New branch ruleset.

- Name `main`, enforcement **Active**, target **Default branch**,
  bypass actor **Repository admin** (the single maintainer pushes
  directly; outside contributions go through pull requests and the
  required checks).
- **Restrict deletions** and **Block force pushes**.
- **Require a pull request before merging** (required approvals 0 while
  there is a single maintainer; raise it with a second one).
- **Require status checks to pass**, with **Require branches to be up to
  date before merging**. Required checks (job names of
  `.github/workflows/ci.yml`, GitHub Actions as the source):
  - `test (22)`, `test (24)`, `test (26)`
  - `node-floor`
  - `format`
  - `coverage`
  - `audit`
  - `deploy-path`
  - `mcpb-reproducible`
  - `codegen-roundtrip`
  - `e2e (22)`, `e2e (24)`
  - `cross-os (windows-latest)`, `cross-os (macos-latest)`
  - `gitleaks`

The same set runs again on every release tag: `release.yml` calls
`ci.yml` on the tag commit and refuses a tag whose commit is not on
`main`.

```bash
gh api -X POST repos/{owner}/{repo}/rulesets --input - <<'EOF'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [ { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" } ],
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "test (22)" }, { "context": "test (24)" }, { "context": "test (26)" },
          { "context": "node-floor" },
          { "context": "format" }, { "context": "coverage" }, { "context": "audit" },
          { "context": "deploy-path" }, { "context": "mcpb-reproducible" },
          { "context": "codegen-roundtrip" },
          { "context": "e2e (22)" }, { "context": "e2e (24)" },
          { "context": "cross-os (windows-latest)" }, { "context": "cross-os (macos-latest)" },
          { "context": "gitleaks" }
        ] } }
  ]
}
EOF
```

## 2. Ruleset for release tags

Settings > Rules > Rulesets > New tag ruleset: name `release-tags`,
enforcement **Active**, target pattern `v*`, bypass actor **Repository
admin**, rules **Restrict creations**, **Restrict updates**, **Restrict
deletions**. A published tag then cannot be moved to another commit.

## 3. Actions

Settings > Actions > General:

- **Workflow permissions**: *Read repository contents and packages
  permissions*. Every workflow declares its own minimal `permissions`;
  only the `github-release`, `mcp-registry` and `npm-publish` jobs of
  `release.yml` and `mcp-registry.yml` (`id-token: write`, also when
  started by hand) ask for more.
- **Allow GitHub Actions to create and approve pull requests**: off.
- **Actions permissions**: allow actions created by GitHub (all actions
  in use are `actions/*`, pinned by commit SHA).
- **Fork pull request workflows**: require approval for all outside
  collaborators.

```bash
gh api -X PUT repos/{owner}/{repo}/actions/permissions/workflow \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
```

## 4. Code security

Settings > Code security:

- **Private vulnerability reporting**: on (the confidential channel
  `docs/SECURITY.md` points to).
- **Dependabot alerts** and **Dependabot security updates**: on.
  Version updates are configured in `.github/dependabot.yml`.
- **Secret scanning** with **push protection**: on. The `gitleaks` job
  scans the full history in CI as well.
- **CodeQL**: default setup for JavaScript/TypeScript and GitHub
  Actions. After its first run, add its check to the `main` ruleset.

```bash
gh api -X PUT repos/{owner}/{repo}/private-vulnerability-reporting
gh api -X PUT repos/{owner}/{repo}/vulnerability-alerts
gh api -X PUT repos/{owner}/{repo}/automated-security-fixes
```

## 5. npm publishing

State on 2026-10-27: the package `action1-mcp-server` exists on npm
(0.6.0, published by hand on 2026-10-27 without provenance), and the
trusted publisher for this repository and workflow `release.yml` is
configured. The trusted publisher is validated only by the first
workflow publish: set `NPM_PUBLISH_ENABLED` to `true` before pushing the
next release tag and check that the `npm-publish` job succeeds and the
version on npmjs.com shows a provenance statement.

The workflow publishes only when both are done:

- On npmjs.com, a trusted publisher for the package: this repository,
  workflow `release.yml` (done).
- The repository variable `NPM_PUBLISH_ENABLED` is `true`.

The `npm-publish` job then publishes the tarball the `build` job packed,
after the GitHub release exists, with provenance. The `mcp-registry`
job waits for it: the registry accepts the npm package of `server.json`
only when npm serves that version with `mcpName`
`io.github.mguttmann/action1-mcp` (from `package.json`). With the
variable off, `npm-publish` is skipped and the registry entry lists the
bundle only.

Prerequisites, in this order (steps 1 to 3 are done):

1. **Public repository.** npm creates provenance statements only for
   packages built from a public source repository; a publish with
   `--provenance` from a private repository fails. Make the repository
   public before the first workflow publish.
2. **First publish by hand.** The trusted publisher is a setting of an
   existing package on npmjs.com, so the package must exist first.
   Publish the first version manually from a maintainer account with
   two-factor authentication (`npm publish --access public`, ideally
   with the tarball of a release); this also reserves the name. That
   version carries no provenance.
3. **Trusted publisher.** On npmjs.com, package settings, add the
   GitHub Actions trusted publisher: owner and repository of this
   repository, workflow file `release.yml`, no environment (the
   `npm-publish` job declares none). The job needs no `NPM_TOKEN`; it
   checks that its npm is 11.5.1 or newer, which trusted publishing
   requires.
4. **Switch on.** Set `NPM_PUBLISH_ENABLED` to `true`. From the next
   release tag on, the job publishes with provenance through OIDC.
   Optionally, in the package settings, disallow token-based publishing
   afterwards so only the workflow can publish.

## 6. MCP Registry

`server.json` describes the server for the official MCP Registry
(`registry.modelcontextprotocol.io`) as `io.github.<owner>/action1-mcp`.
The `mcp-registry` job of `release.yml` (stable tags only, after the
GitHub release) runs `.github/workflows/mcp-registry.yml`, which can
also be started by hand for an existing tag (Actions > MCP Registry >
Run workflow, inputs `tag` and `npm-published`). No repository setting
and no secret is needed:

- Authentication is GitHub OIDC (`id-token: write`); the registry grants
  the namespace `io.github.<repository owner>/*`.
- The workflow takes version, download URL and `fileSha256` from the
  release (tag and `SHA256SUMS`) and checks the asset against
  `SHA256SUMS`; a version the registry already lists is skipped, because
  registry versions are permanent.
- `server.json` lists two packages: the MCPB asset and the npm package
  `action1-mcp-server`. The registry checks the npm version's `mcpName`
  against the server name. The workflow keeps the npm entry only when
  npm serves the version with that `mcpName`; after a publish in the
  same run (`npm-published: true`) it waits for npm and fails if the
  version does not appear. Only versions from 0.6.2 on carry `mcpName` on
  npm (0.6.0 has none, 0.6.1 was never published there), so a
  hand-started run for older tags lists the bundle only.
- The MCPB asset must stay publicly downloadable: the registry checks
  the URL (GitHub release asset, `mcp` in the URL) when publishing.
- `mcp-publisher` is pinned by version and SHA-256 in the workflow
  (`MCP_PUBLISHER_VERSION`, `MCP_PUBLISHER_SHA256`, value from the
  registry release's `registry_<version>_checksums.txt`).

A listed version can be marked deprecated or deleted with
`mcp-publisher status` after a `mcp-publisher login github`; it cannot
be replaced.

## 7. Glama

Glama lists the repository at
`https://glama.ai/mcp/servers/<owner>/action1-mcp` on its own. The
`glama.json` in the repository root names the GitHub users who may
maintain that listing (`maintainers`); Glama reads it only during its
"Claim" flow, so after a change to the file the maintainer runs the
claim again. Signed in on glama.ai with GitHub as a listed maintainer,
claim the listing on its page.

Glama's tool inspection runs the server in a container built from a
form in the listing's admin area (Node.js version, build steps, start
command, an environment JSON schema and placeholder values), not from a
file in the repository. The server answers `tools/list` without calling
the Action1 API, so placeholders are enough (an `https://` URL for
`ACTION1_BASE_URL`, any non-empty client ID and secret); never enter a
real API credential there.

## Check the result

```bash
gh api repos/{owner}/{repo}/rulesets
gh api repos/{owner}/{repo}/actions/permissions/workflow
gh api repos/{owner}/{repo}/private-vulnerability-reporting
gh api repos/{owner}/{repo}/vulnerability-alerts   # 204 when on
```
