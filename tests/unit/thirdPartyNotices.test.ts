import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// scripts/third-party-notices.mjs writes the bundle's
// THIRD_PARTY_NOTICES.md and is the license gate for what ships in the
// MCPB bundle (scripts/build-mcpb.sh runs it on the bundled tree).

const script = fileURLToPath(new URL("../../scripts/third-party-notices.mjs", import.meta.url));
let dir: string;

function addPackage(rel: string, manifest: Record<string, unknown>, files: Record<string, string>) {
  const pkgDir = join(dir, rel);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify(manifest));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(pkgDir, name), text);
}

function run(out: string) {
  return spawnSync(process.execPath, [script, dir, out], { encoding: "utf8" });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "action1-notices-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("third-party-notices", () => {
  it("lists every installed package, nested and scoped, with its license files", () => {
    addPackage(
      "node_modules/alpha",
      { name: "alpha", version: "1.0.0", license: "MIT" },
      {
        LICENSE: "MIT text of alpha",
      },
    );
    addPackage(
      "node_modules/@scope/beta",
      { name: "@scope/beta", version: "2.1.0", license: "Apache-2.0" },
      {
        "LICENSE.txt": "Apache text",
        NOTICE: "beta notice",
      },
    );
    addPackage(
      "node_modules/alpha/node_modules/gamma",
      { name: "gamma", version: "0.1.0", license: "(MIT OR GPL-3.0)" },
      {},
    );
    const out = join(dir, "NOTICES.md");
    const r = run(out);
    expect(r.status, r.stderr).toBe(0);
    const text = readFileSync(out, "utf8");
    expect(text).toContain("## alpha@1.0.0\n\nLicense: MIT");
    expect(text).toContain("MIT text of alpha");
    expect(text).toContain("## @scope/beta@2.1.0\n\nLicense: Apache-2.0");
    expect(text).toContain("beta notice");
    expect(text).toContain("## gamma@0.1.0\n\nLicense: (MIT OR GPL-3.0)");
  });

  it("fails and writes nothing when a package license is not on the allowlist", () => {
    addPackage("node_modules/alpha", { name: "alpha", version: "1.0.0", license: "MIT" }, {});
    addPackage(
      "node_modules/copyleft",
      { name: "copyleft", version: "3.0.0", license: "GPL-3.0" },
      {},
    );
    const out = join(dir, "NOTICES.md");
    const r = run(out);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("license not on the allowlist: copyleft@3.0.0 (GPL-3.0)");
    expect(existsSync(out)).toBe(false);
  });

  it("treats a package without a license field as not allowed", () => {
    addPackage("node_modules/mystery", { name: "mystery", version: "1.0.0" }, {});
    const r = run(join(dir, "NOTICES.md"));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("mystery@1.0.0 (UNKNOWN)");
  });
});
