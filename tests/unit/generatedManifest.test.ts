import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GENERATED_SKIPPED_OPERATIONS,
  GENERATED_TOOL_MANIFEST,
} from "../../src/tools/generated/index.js";
import { parseGeneratedManifest } from "../../scripts/generated-manifest.mjs";

// The doc generators read the manifest from the source text of the
// committed generated file. They must see exactly what the module exports,
// whatever layout the code generator's formatter chose.
describe("parseGeneratedManifest on the committed generated index", () => {
  const source = readFileSync(
    join(__dirname, "..", "..", "src", "tools", "generated", "index.ts"),
    "utf8",
  );
  const parsed = parseGeneratedManifest(source);

  it("returns every manifest entry", () => {
    expect(parsed.tools).toEqual(GENERATED_TOOL_MANIFEST.map((t) => ({ ...t })));
  });

  it("returns every skipped operation", () => {
    expect(parsed.skipped).toEqual(GENERATED_SKIPPED_OPERATIONS.map((s) => ({ ...s })));
  });
});
