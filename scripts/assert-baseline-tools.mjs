#!/usr/bin/env node
// Fail when a tools/list snapshot misses a tool of the v0.5.0 baseline
// (tests/fixtures/tools-list.baseline.json). CI starts a built server
// with scripts/tools-list-snapshot.mjs and checks its output with this
// script; added tools are fine.
//
// Usage: node scripts/assert-baseline-tools.mjs <snapshot.json>
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = process.argv[2];
if (!file) {
  console.error("usage: assert-baseline-tools.mjs <snapshot.json>");
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseline = JSON.parse(
  readFileSync(path.join(root, "tests/fixtures/tools-list.baseline.json"), "utf8"),
);
const listed = new Set(JSON.parse(readFileSync(file, "utf8")).tools.map((t) => t.name));
const missing = baseline.tools.map((t) => t.name).filter((n) => !listed.has(n));
if (missing.length) {
  console.error("missing tools: " + missing.join(", "));
  process.exit(1);
}
console.log(`${listed.size} tools, every baseline tool present`);
