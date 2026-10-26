import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractCuratedToolNames } from "../../src/codegen/naming.js";
import * as coverage from "../../scripts/regenerate-coverage-table.mjs";

// Facts in the Markdown docs drifted repeatedly (tool and test counts,
// dead links, a coverage table whose curated count no longer matched
// the server). These checks hold the docs to the repository itself.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", "server"]);

function markdownFiles(dir: string = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...markdownFiles(p));
    else if (entry.endsWith(".md")) out.push(p);
  }
  return out;
}

/** Lines outside fenced code blocks, with their 1-based line numbers. */
function proseLines(text: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  let fenced = false;
  text.split("\n").forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (!fenced) out.push([i + 1, line]);
  });
  return out;
}

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function anchorsOf(file: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const [, line] of proseLines(readFileSync(file, "utf8"))) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = slug(m[1]!);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

const GENERATED_DOCS = new Set(["docs/_coverage_table.md", "docs/permissions.md"]);
const files = markdownFiles();
const rel = (f: string) => relative(root, f).split("\\").join("/");

describe("Markdown docs", () => {
  it("finds the docs", () => {
    expect(files.map(rel)).toEqual(expect.arrayContaining(["README.md", "docs/SECURITY.md"]));
  });

  it("relative links point at existing files and headings", () => {
    const broken: string[] = [];
    for (const file of files) {
      for (const [n, line] of proseLines(readFileSync(file, "utf8"))) {
        // Inline code spans are not links.
        const text = line.replace(/`[^`]*`/g, "");
        for (const m of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
          const target = m[1]!;
          if (/^(https?:|mailto:)/i.test(target)) continue;
          const [pathPart, anchor] = target.split("#") as [string, string | undefined];
          const dest = pathPart === "" ? file : resolve(dirname(file), decodeURI(pathPart));
          if (!existsSync(dest)) {
            broken.push(`${rel(file)}:${n} -> ${target} (missing file)`);
            continue;
          }
          if (anchor && dest.endsWith(".md") && !anchorsOf(dest).has(anchor.toLowerCase())) {
            broken.push(`${rel(file)}:${n} -> ${target} (missing heading)`);
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("state no hand-written tool, test or question counts", () => {
    // Counts belong to generated docs (docs/_coverage_table.md) or to the
    // live server (tools/list); hand-written copies went stale.
    const countRe =
      /(?<![\w.])\d+\s+(?:MCP\s+|curated\s+|auto-generated\s+|generated\s+|thematic\s+)?(?:tools|tests|test files|qa_pairs|questions|curated|auto-generated|wrappers|resources|slash-prompts|prompts)\b(?!\/)/i;
    const hits: string[] = [];
    for (const file of files) {
      if (GENERATED_DOCS.has(rel(file))) continue;
      for (const [n, line] of proseLines(readFileSync(file, "utf8"))) {
        if (countRe.test(line)) hits.push(`${rel(file)}:${n}: ${line.trim()}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("use a <version> placeholder instead of a hard-coded bundle version", () => {
    const hits: string[] = [];
    for (const file of files) {
      if (rel(file) === "CHANGELOG.md") continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/action1-mcp-\d+\.\d+\.\d+\.mcpb/.test(line)) hits.push(`${rel(file)}:${i + 1}`);
        });
    }
    expect(hits).toEqual([]);
  });
});

describe("docs/_coverage_table.md", () => {
  it("is up to date (run node scripts/regenerate-coverage-table.mjs)", () => {
    expect(readFileSync(coverage.OUT_PATH, "utf8")).toBe(coverage.renderFromRepo());
  });

  it("counts curated tools the same way the code generator does", () => {
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) {
          if (entry !== "generated") walk(p);
        } else if (entry.endsWith(".ts")) sources.push(readFileSync(p, "utf8"));
      }
    };
    walk(join(root, "src", "tools"));
    const fromGenerator = [...extractCuratedToolNames(sources)].sort();
    const fromScript = [...(coverage.curatedToolNamesFromRepo as () => Set<string>)()].sort();
    expect(fromScript).toEqual(fromGenerator);
  });
});

// Em and en dashes came back into code, tests and docs after earlier
// clean-ups; the project writes plain hyphens. The vendored Action1 spec
// is upstream text and stays byte for byte as fetched.
describe("tracked files", () => {
  it("contain no em or en dashes (U+2014, U+2013)", () => {
    const vendored = new Set(["src/codegen/spec/openapi.json"]);
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
      .split("\0")
      .filter((f) => f !== "" && !vendored.has(f) && existsSync(join(root, f)));
    expect(files.length).toBeGreaterThan(0);
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(join(root, f), "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/[\u2013\u2014]/.test(line)) hits.push(`${f}:${i + 1}`);
        });
    }
    expect(hits).toEqual([]);
  });
});
