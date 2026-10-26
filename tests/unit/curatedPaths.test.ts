import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Curated tools build their request paths by hand, so the pinned spec and
// the codegen roundtrip do not cover them. This test scans the curated
// sources for Action1 path literals and requires each one to be either a
// documented spec path or listed in known-undocumented-endpoints.json,
// so a curated tool cannot silently depend on an undocumented endpoint.

const ROOT = join(__dirname, "..", "..");
const SPEC_DIR = join(ROOT, "src", "codegen", "spec");

interface KnownEntry {
  method: string;
  path: string;
}

const spec = JSON.parse(readFileSync(join(SPEC_DIR, "openapi.json"), "utf8")) as {
  paths: Record<string, unknown>;
};
const known = (
  JSON.parse(readFileSync(join(SPEC_DIR, "known-undocumented-endpoints.json"), "utf8")) as {
    endpoints: KnownEntry[];
  }
).endpoints;

/** `{orgId}` and `${encodeURIComponent(x)}` both become `{}`. */
const normalize = (p: string): string => p.replace(/\{[^}]*\}/g, "{}");
const specPaths = new Set(Object.keys(spec.paths).map(normalize));
const knownPaths = new Set(known.map((k) => normalize(k.path)));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "generated" && e.name !== "codegen") out.push(...sourceFiles(full));
    } else if (e.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Action1 path literals in a source file, with interpolations collapsed to `{}`. */
function pathLiterals(src: string): string[] {
  const flat = src
    .replace(/\$\{encodeURIComponent\([^()]*\)\}/g, "{}")
    .replace(/["'`]\s*\+\s*encodeURIComponent\([^()]*\)\s*\+\s*["'`]/g, "{}")
    .replace(/["'`]\s*\+\s*encodeURIComponent\([^()]*\)(?=\s*[,)])/g, '{}"');
  return [...flat.matchAll(/["'`](\/[a-z][a-z0-9-]*(?:\/(?:[A-Za-z0-9_.-]+|\{\}))+)["'`?]/g)].map(
    (m) => m[1]!,
  );
}

const used = new Map<string, string[]>();
for (const f of sourceFiles(join(ROOT, "src"))) {
  for (const p of pathLiterals(readFileSync(f, "utf8"))) {
    used.set(p, [...(used.get(p) ?? []), f.slice(ROOT.length + 1)]);
  }
}

describe("curated tool paths vs the pinned spec", () => {
  it("the scanner finds the curated paths (sanity)", () => {
    expect(used.has("/endpoints/managed/{}")).toBe(true);
    expect(pathLiterals('"/a/" + encodeURIComponent(x) + "/b"')).toEqual(["/a/{}/b"]);
  });

  it("every curated path is documented or on the known-undocumented list", () => {
    const offenders = [...used.entries()]
      .filter(([p]) => !specPaths.has(p) && !knownPaths.has(p))
      .map(([p, files]) => `${p} (${[...new Set(files)].join(", ")})`);
    expect(offenders).toEqual([]);
  });

  it("every known-undocumented entry is still undocumented and still used", () => {
    for (const k of known) {
      const p = normalize(k.path);
      expect(specPaths.has(p), `${k.path} is now in the spec: remove it from the list`).toBe(false);
      expect(used.has(p), `${k.path} is no longer used: remove it from the list`).toBe(true);
    }
  });
});
