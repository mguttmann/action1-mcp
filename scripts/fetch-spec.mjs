#!/usr/bin/env node
// Extract the Action1 OpenAPI spec from the public Swagger UI bundle and
// compare it with the pinned snapshot in src/codegen/spec/.
//
// Action1 does not publish a flat openapi.json. The Swagger UI at
// https://app.eu.action1.com/apidocs/ ships the spec as a JavaScript object
// literal (`const x={openapi:"3.1.0",...}`) inside its Vite bundle
// `assets/index-<hash>.js`. This script:
//   1. fetches the Swagger UI HTML and finds the current index-*.js asset,
//   2. fetches that asset,
//   3. finds the object literal starting with `{openapi:"3.1.0"` and walks
//      it brace-balanced (string and template-literal aware),
//   4. evaluates only that literal in an empty `node:vm` context,
//   5. serialises it with JSON.stringify(spec, null, 2) (no trailing newline),
//      which is the exact format of the pinned openapi.json.
//
// Usage:
//   node scripts/fetch-spec.mjs --fetch [--out <file>]
//       Write the live spec to <file> (default
//       src/codegen/spec/openapi.candidate.json, git-ignored) and print its
//       stats and SHA-256. Never touches the pinned openapi.json.
//   node scripts/fetch-spec.mjs --check
//       Exit 0 when the live spec is byte-identical to the pinned SHA,
//       exit 1 with a diff summary when it drifted, exit 2 on fetch or
//       extraction errors. Also reports the status of every entry in
//       src/codegen/spec/known-undocumented-endpoints.json.
//   --url <swagger-ui-url>   override the Swagger UI URL (default EU instance)
//
// npm scripts: `npm run spec:fetch`, `npm run spec:check`.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_DIR = path.join(ROOT, "src", "codegen", "spec");
export const DEFAULT_URL = "https://app.eu.action1.com/apidocs/";
const SPEC_START = '{openapi:"3.1.0"';

/** Find the Vite entry asset (`assets/index-<hash>.js`) in the Swagger UI HTML. */
export function findIndexAsset(html, baseUrl) {
  const m = html.match(/<script[^>]*\bsrc="([^"]*\/assets\/index-[^"/]+\.js)"/);
  if (!m) throw new Error("No assets/index-*.js script tag found in " + baseUrl);
  return new URL(m[1], baseUrl).toString();
}

/**
 * Return the source text of the object literal that starts with
 * `{openapi:"3.1.0"` in `js`. Walks braces while skipping the contents of
 * '...', "..." and `...` literals (including escapes), so braces inside
 * description strings do not end the walk early.
 */
export function extractSpecLiteral(js) {
  const start = js.indexOf(SPEC_START);
  if (start < 0) throw new Error("Spec literal " + SPEC_START + " not found in bundle");
  let depth = 0;
  let i = start;
  while (i < js.length) {
    const c = js[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(js, i, c);
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return js.slice(start, i + 1);
    }
    i += 1;
  }
  throw new Error("Unbalanced braces: spec literal never closes");
}

function skipString(js, i, quote) {
  let j = i + 1;
  while (j < js.length) {
    const c = js[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (quote === "`" && c === "$" && js[j + 1] === "{") {
      throw new Error("Template literal with ${...} inside the spec literal is not supported");
    }
    if (c === quote) return j + 1;
    j += 1;
  }
  throw new Error("Unterminated string literal starting at offset " + i);
}

/** Evaluate the literal in an empty context and return the pretty JSON text. */
export function literalToJson(literal) {
  const value = vm.runInNewContext("(" + literal + ")", Object.create(null), { timeout: 5000 });
  return JSON.stringify(value, null, 2);
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

const METHODS = ["get", "head", "post", "put", "patch", "delete", "options"];

export function operations(spec) {
  const out = new Map();
  for (const [p, item] of Object.entries(spec.paths ?? {})) {
    for (const m of METHODS) {
      if (item[m]) out.set(m.toUpperCase() + " " + p, item[m]);
    }
  }
  return out;
}

export function specStats(spec) {
  return {
    paths: Object.keys(spec.paths ?? {}).length,
    operations: operations(spec).size,
    schemas: Object.keys(spec.components?.schemas ?? {}).length,
  };
}

/** Human-readable summary of what changed between two parsed specs. */
export function diffSummary(oldSpec, newSpec) {
  const lines = [];
  const a = operations(oldSpec);
  const b = operations(newSpec);
  const added = [...b.keys()].filter((k) => !a.has(k)).sort();
  const removed = [...a.keys()].filter((k) => !b.has(k)).sort();
  const changed = [...b.keys()]
    .filter((k) => a.has(k) && JSON.stringify(a.get(k)) !== JSON.stringify(b.get(k)))
    .sort();
  const sa = oldSpec.components?.schemas ?? {};
  const sb = newSpec.components?.schemas ?? {};
  const schemasAdded = Object.keys(sb)
    .filter((k) => !(k in sa))
    .sort();
  const schemasRemoved = Object.keys(sa)
    .filter((k) => !(k in sb))
    .sort();
  const schemasChanged = Object.keys(sb)
    .filter((k) => k in sa && JSON.stringify(sa[k]) !== JSON.stringify(sb[k]))
    .sort();
  const os = specStats(oldSpec);
  const ns = specStats(newSpec);
  lines.push(
    `paths ${os.paths} -> ${ns.paths}, operations ${os.operations} -> ${ns.operations}, schemas ${os.schemas} -> ${ns.schemas}`,
  );
  const list = (label, items) => {
    if (items.length === 0) return;
    lines.push(`${label} (${items.length}):`);
    for (const it of items) lines.push("  " + it);
  };
  list("operations added", added);
  list("operations removed", removed);
  list("operations changed", changed);
  list("schemas added", schemasAdded);
  list("schemas removed", schemasRemoved);
  list("schemas changed", schemasChanged);
  return lines.join("\n");
}

/** Status of each known-undocumented endpoint against a spec. */
export function undocumentedStatus(spec, entries) {
  const ops = operations(spec);
  return entries.map((e) => ({
    ...e,
    documented: ops.has(e.method.toUpperCase() + " " + e.path),
  }));
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": "action1-mcp spec-fetch" } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

export async function fetchLiveSpec(url = DEFAULT_URL) {
  const html = await fetchText(url);
  const assetUrl = findIndexAsset(html, url);
  const js = await fetchText(assetUrl);
  const json = literalToJson(extractSpecLiteral(js));
  return { assetUrl, json, sha: sha256(json) };
}

function readKnownUndocumented() {
  const file = path.join(SPEC_DIR, "known-undocumented-endpoints.json");
  return JSON.parse(readFileSync(file, "utf8")).endpoints;
}

async function main(argv) {
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const url = opt("--url") ?? DEFAULT_URL;
  const mode = argv.includes("--check") ? "check" : argv.includes("--fetch") ? "fetch" : null;
  if (!mode) {
    process.stderr.write("usage: fetch-spec.mjs --fetch [--out <file>] | --check [--url <url>]\n");
    return 2;
  }
  let live;
  try {
    live = await fetchLiveSpec(url);
  } catch (err) {
    process.stderr.write("spec fetch failed: " + (err instanceof Error ? err.message : err) + "\n");
    return 2;
  }
  const liveSpec = JSON.parse(live.json);
  const stats = specStats(liveSpec);
  process.stdout.write(
    `asset: ${live.assetUrl}\nsha256: ${live.sha}\npaths: ${stats.paths}, operations: ${stats.operations}, schemas: ${stats.schemas}\n`,
  );

  if (mode === "fetch") {
    const out = path.resolve(opt("--out") ?? path.join(SPEC_DIR, "openapi.candidate.json"));
    writeFileSync(out, live.json, "utf8");
    process.stdout.write(`wrote ${out}\n`);
    return 0;
  }

  const pinnedSha = readFileSync(path.join(SPEC_DIR, "openapi.sha256"), "utf8").trim();
  const pinnedSpec = JSON.parse(readFileSync(path.join(SPEC_DIR, "openapi.json"), "utf8"));
  for (const s of undocumentedStatus(liveSpec, readKnownUndocumented())) {
    process.stdout.write(
      `known-undocumented ${s.method} ${s.path}: ${s.documented ? "NOW DOCUMENTED, review the list" : "still undocumented"}\n`,
    );
  }
  if (live.sha === pinnedSha) {
    process.stdout.write("spec: live spec matches the pinned SHA\n");
    return 0;
  }
  process.stdout.write(`spec: DRIFT, pinned ${pinnedSha} but live is ${live.sha}\n`);
  process.stdout.write(diffSummary(pinnedSpec, liveSpec) + "\n");
  process.stdout.write(
    "Refresh: npm run spec:fetch, review the candidate, then follow src/codegen/spec/SOURCE.md.\n",
  );
  return 1;
}

const invokedAsScript =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(String(err?.stack ?? err) + "\n");
      process.exit(2);
    },
  );
}
