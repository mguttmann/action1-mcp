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
    const code = readFileSync(
      join(repoRoot, "src", "tools", "generated", "index.ts"),
      "utf8",
    );
    const pinned = readFileSync(
      join(repoRoot, "src", "codegen", "spec", "openapi.sha256"),
      "utf8",
    ).trim();
    expect(code).toContain(pinned);
  });
});
