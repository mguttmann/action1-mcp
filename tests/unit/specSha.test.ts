import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("OpenAPI spec pinning", () => {
  const repoRoot = join(__dirname, "..", "..");

  it("openapi.json SHA matches the pinned value", () => {
    const buf = readFileSync(join(repoRoot, "src", "codegen", "spec", "openapi.json"));
    const sha = createHash("sha256").update(buf).digest("hex");
    const pinned = readFileSync(
      join(repoRoot, "src", "codegen", "spec", "openapi.sha256"),
      "utf8",
    ).trim();
    expect(sha).toBe(pinned);
  });

  it("generated index.ts references the same SHA in its header", () => {
    const code = readFileSync(join(repoRoot, "src", "tools", "generated", "index.ts"), "utf8");
    const pinned = readFileSync(
      join(repoRoot, "src", "codegen", "spec", "openapi.sha256"),
      "utf8",
    ).trim();
    expect(code).toContain(pinned);
  });

  it("SOURCE.md states the SHA and counts of the pinned file", () => {
    const specDir = join(repoRoot, "src", "codegen", "spec");
    const source = readFileSync(join(specDir, "SOURCE.md"), "utf8");
    const spec = JSON.parse(readFileSync(join(specDir, "openapi.json"), "utf8")) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const methods = ["get", "head", "post", "put", "patch", "delete", "options"];
    const operations = Object.values(spec.paths).reduce(
      (n, item) => n + Object.keys(item).filter((k) => methods.includes(k)).length,
      0,
    );
    const pinned = readFileSync(join(specDir, "openapi.sha256"), "utf8").trim();
    expect(source).toContain("- SHA-256: `" + pinned + "`");
    expect(source).toContain("- Paths: " + Object.keys(spec.paths).length + "\n");
    expect(source).toMatch(new RegExp("- Operations \\([^)]*\\): " + operations + "\\n"));
  });
});
