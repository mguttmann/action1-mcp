import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  OUT_PATH,
  SPEC_PATH,
  permissionsOf,
  renderFromRepo,
} from "../../scripts/generate-permissions-table.mjs";

// docs/permissions.md is generated from the permission tags of the
// pinned OpenAPI spec. A hand-maintained table named permissions that
// do not exist (view_organizations, manage_actions, ...).

type PermsOf = (d: string | undefined) => { anyOf: boolean; perms: string[] };

const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8")) as {
  paths: Record<string, Record<string, { description?: string }>>;
};
const specPerms = new Set<string>();
for (const item of Object.values(spec.paths)) {
  for (const op of Object.values(item)) {
    for (const p of (permissionsOf as PermsOf)(op.description).perms) specPerms.add(p);
  }
}

describe("docs/permissions.md", () => {
  it("is up to date with the spec (run node scripts/generate-permissions-table.mjs)", () => {
    expect(readFileSync(OUT_PATH, "utf8")).toBe(renderFromRepo());
  });

  it("names only permissions that exist in the spec", () => {
    const doc = readFileSync(OUT_PATH, "utf8");
    const named = [
      ...doc.matchAll(/`((?:view|manage|run|use|approve|assign|remote)_[a-z_]+)`/g),
    ].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((p) => !specPerms.has(p))).toEqual([]);
  });

  it("the 403 hints in src/client/errors.ts name only permissions from the spec", () => {
    const src = readFileSync(new URL("../../src/client/errors.ts", import.meta.url), "utf8");
    const named = [...src.matchAll(/\(((?:view|manage|run|use)_[a-z_]+)\)/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((p) => !specPerms.has(p))).toEqual([]);
  });
});
