# ADR 0002: Curated tools plus tools generated from a vendored, pinned spec

- Status: accepted
- Date: 2026-10-26 (records a decision made before 0.3.0)

## Context

The Action1 REST API has well over a hundred operations. Most of them are
plain CRUD that an LLM can call from the OpenAPI description alone. A few
common workflows are not: macOS scripts need a ten-field payload,
PowerShell needs non-empty success exit codes, `last_seen` is not ISO-8601,
script output carries lifecycle markers. Writing every operation by hand
would not scale; generating everything would ship the quirks to the model.

Action1 publishes the spec only inside the bundle of its Swagger UI page,
not as a downloadable file.

## Decision

- **Two tool layers.** Hand-written ("curated") tools cover the workflows
  with quirks and the high-level wrappers. Every other operation gets a
  generated tool (`src/codegen/generate.ts`).
- **Curated wins.** The generator scans the curated tool names and drops a
  generated tool with the same name; operations that must not get a
  generated tool are listed with a reason in `SKIP_OPERATION_IDS`.
- **Vendored, pinned spec.** `scripts/fetch-spec.mjs` extracts the spec
  from the Swagger UI bundle; it is committed unchanged in
  `src/codegen/spec/openapi.json` with its SHA-256. The generated code is
  committed, so a spec update is a reviewable diff, and CI checks that
  regeneration produces no change.
- **Drift is detected, not assumed away.** The SHA test only ties the
  generated code to the committed spec. `npm run spec:check` and a weekly
  workflow compare the committed spec with the one Action1 serves.

## Consequences

- The spec is Action1's work and is not covered by this project's MIT
  License; `NOTICE` says so. Whether Action1 permits redistributing it is
  an open question for the maintainer.
- Curated tools may call endpoints the spec does not document. They must
  be listed in `known-undocumented-endpoints.json`
  (`tests/unit/curatedPaths.test.ts`), see `docs/GOTCHAS.md`.
- Tool counts change with every spec update; docs link to the generated
  `docs/_coverage_table.md` instead of repeating numbers.
