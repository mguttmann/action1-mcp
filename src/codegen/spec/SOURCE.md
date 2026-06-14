# Action1 OpenAPI Spec — Source

This directory contains a snapshot of the Action1 OpenAPI specification, extracted verbatim from the bundled Swagger UI on the EU instance. It is the source of truth for the MCP code generator. Do not hand-edit `openapi.json`.

## Provenance

- Source URL: https://app.eu.action1.com/apidocs/
- JS asset URL: https://app.eu.action1.com/apidocs/assets/index-BB2OdqHE.js
- Extraction date: 2026-05-03
- Extraction method: brace-balanced walk over the Vite bundle, evaluated as a JS object literal in a `node:vm` sandbox, then `JSON.stringify`d with 2-space indentation. The spec was the value of a `const` declaration starting at byte offset 3945 of the bundle (`const i={openapi:"3.1.0",...}`).

## Snapshot stats

- File: `openapi.json`
- Byte size: 514275
- OpenAPI version: 3.1.0
- API version (info.version): 3.1.0
- Paths: 96
- Operations (sum of HTTP methods across all paths): 140
- SHA-256: `af75f1cc665b8d0ed2f6ed1992b1161f68a36c35013a2a1b168854185fc0eaed`

The SHA above matches the contents of `openapi.sha256` (lowercase hex, no trailing newline).

## Notes

- The bundled spec is identical between the EU instance (`app.eu.action1.com`) and the US instance (`app.action1.com`) per the prior 403 investigation in `docs/403-investigation.md`.
- The JSON has been pretty-printed (2-space indent) but is otherwise byte-equivalent to the object the bundle ships at runtime. No `$ref` dereferencing, no normalisation, no validation transforms.
- If Action1 ships a new bundle (the asset filename has a content hash, so the URL will change), re-run the extractor to refresh this snapshot and update the SHA.
