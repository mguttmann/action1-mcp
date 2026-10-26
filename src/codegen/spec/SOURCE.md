# Action1 OpenAPI Spec - Source

This directory contains a snapshot of the Action1 OpenAPI specification, extracted verbatim from the bundled Swagger UI on the EU instance. It is the source of truth for the MCP code generator. Do not hand-edit `openapi.json`.

The spec is Action1's work, vendored here unchanged so the generator can run offline and reproducibly. This project is unofficial and not affiliated with or endorsed by Action1.

## Provenance

- Source URL: https://app.eu.action1.com/apidocs/
- JS asset URL: https://app.eu.action1.com/apidocs/assets/index-CI0bLlX8.js
- Extraction date: 2026-10-26
- Extraction method: `scripts/fetch-spec.mjs`. It reads the Swagger UI page, takes the `assets/index-<hash>.js` entry script, finds the object literal starting with `{openapi:"3.1.0"`, walks it brace-balanced (string and template-literal aware), evaluates only that literal in an empty `node:vm` context and writes `JSON.stringify(spec, null, 2)` without a trailing newline.

## Snapshot stats

- File: `openapi.json`
- OpenAPI version: 3.1.0
- API version (info.version): 3.1.0
- Paths: 97
- Operations (sum of HTTP methods across all paths): 141
- SHA-256: `0871804cf4ee1e66387dfcb604c9adec13c3649536f491e7bca6cfd2a18cf171`

The SHA above matches `openapi.sha256` (lowercase hex, no trailing newline). `tests/unit/specSha.test.ts` checks that the file matches the pin and that the generated `src/tools/generated/index.ts` was built from it.

Changes since the previous snapshot (2026-05-03, asset `index-BB2OdqHE.js`, 96 paths / 140 operations): new `POST /updates/{orgId}/approvals` (bulk approval, top-level array body), `429` responses on every operation, `orgIdOrAll` on more read operations, CVSS 4.0 fields on vulnerability schemas, and the server list now names the NA-2 and UK regions.

## Drift detection

The pin only proves that the committed file is the one the generator used. Whether Action1 still serves the same spec is checked separately:

- `npm run spec:check` fetches the live spec and exits 0 when it matches the pinned SHA, 1 with a summary of added, removed and changed operations and schemas when it drifted, and 2 when the page could not be fetched or parsed. It also reports each entry of `known-undocumented-endpoints.json` against the live spec.
- `.github/workflows/spec-drift.yml` runs the same check weekly (and on demand). A red run means: refresh the snapshot.

## Refreshing the snapshot

```bash
npm run spec:fetch                      # writes openapi.candidate.json (git-ignored) and prints its SHA and stats
mv src/codegen/spec/openapi.candidate.json src/codegen/spec/openapi.json
shasum -a 256 src/codegen/spec/openapi.json | awk '{printf "%s", $1}' > src/codegen/spec/openapi.sha256
npm run codegen                         # fails on stale overrides or name collisions; fix and re-run
npm test                                # invariants: guard on every mutating op, tools/list baseline
```

Then update this file (asset name, date, stats, SHA, notable changes), review the diff of `src/tools/generated/index.ts`, and commit spec, SHA and generated file together. Never update the SHA without regenerating.

## Known undocumented endpoints

`known-undocumented-endpoints.json` lists endpoints that curated tools call although the spec does not document them (see `docs/GOTCHAS.md`). `tests/unit/curatedPaths.test.ts` fails when a curated tool uses an undocumented path that is not on that list, or when a listed path becomes documented or unused.

## Vendor example values

The spec contains example values that Action1 publishes in its public Swagger UI, among them API client IDs in the `api-key-<uuid>@action1.com` format, a `client_secret`, access and refresh tokens (JWTs) and passwords. They are part of the vendor documentation, not credentials of this project. Secret scanners flag them; `.gitleaks.toml` and `.github/secret_scanning.yml` exclude this file for that reason.

## Notes

- The bundled spec is identical between the EU instance (`app.eu.action1.com`) and the US instance (`app.action1.com`) per the prior 403 investigation in `docs/403-investigation.md`.
- The JSON is pretty-printed (2-space indent) but otherwise the object the bundle ships at runtime. No `$ref` dereferencing, no normalisation, no validation transforms.
