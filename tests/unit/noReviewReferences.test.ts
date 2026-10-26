import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Code, tests and docs describe current behaviour. Finding ids of
// unpublished reviews and pass labels mean nothing to a reader of the
// public tree; the history belongs in commit messages. BACKLOG.md is
// the one file that keeps a review reference per open item.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", "build", "spec"]);
const SKIP_FILES = new Set(["BACKLOG.md", "tests/unit/noReviewReferences.test.ts"]);
// Git-ignored build output inside a scanned directory (staging area of
// builds before 0.6.0); it is not part of the tree.
const SKIP_PATHS = new Set(["mcpb/server"]);
const EXTENSIONS = [".ts", ".mjs", ".js", ".sh", ".md", ".yml", ".yaml", ".json"];

const LENSES = [
  "core-runtime",
  "tools-codegen",
  "sec-app",
  "sec-infra",
  "supply-chain(?:-\\d{4})?",
  "architecture",
  "errors-observability",
  "testing",
  "docs-accuracy",
  "docs-onboarding",
  "docs-oss",
  "comments",
  "api-design",
  "data-layer",
  "deps",
  "deps-devex",
  "config-devex",
  "licensing",
  "runtime-design",
  "security",
  "quality",
  "compat",
];
const REFERENCE = new RegExp(
  [
    `\\b(?:r2-)?(?:${LENSES.join("|")})-\\d+\\b`,
    "\\bP\\d-[A-Z]\\b",
    "\\baudit \\d{4}-\\d{2}-\\d{2}\\b",
    "\\bwave ?\\d\\b",
    "\\b(?:Pass|Critical|Security) #\\d+\\b",
    "\\bPass-\\d+\\b",
  ].join("|"),
);

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    if (SKIP_PATHS.has(relative(root, p).split("\\").join("/"))) continue;
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (EXTENSIONS.some((e) => entry.endsWith(e))) out.push(p);
  }
  return out;
}

describe("no references to review findings outside BACKLOG.md", () => {
  it("src, tests, scripts, docs and the root docs", () => {
    const scanned = [
      ...["src", "tests", "scripts", "docs", "mcpb", "evals", ".github"].flatMap((d) =>
        files(join(root, d)),
      ),
      ...readdirSync(root)
        .filter((f) => f.endsWith(".md"))
        .map((f) => join(root, f)),
    ].filter((f) => !SKIP_FILES.has(relative(root, f).split("\\").join("/")));
    expect(scanned.length).toBeGreaterThan(0);
    const hits: string[] = [];
    for (const f of scanned) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const m = REFERENCE.exec(line);
          if (m) hits.push(`${relative(root, f)}:${i + 1}: ${m[0]}`);
        });
    }
    expect(hits).toEqual([]);
  });
});
