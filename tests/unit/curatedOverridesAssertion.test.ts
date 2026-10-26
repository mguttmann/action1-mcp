import { describe, expect, it } from "vitest";
import {
  NAME_OVERRIDES,
  assertNameOverridesMatchSpec,
} from "../../src/codegen/curated-overrides.js";

// The codegen-time guard fails the build when a
// NAME_OVERRIDES key doesn't match a real operationId in the spec.
// These tests pin both branches.

describe("assertNameOverridesMatchSpec", () => {
  it("passes when every override key is in the operationId set", () => {
    const ops = new Set(Object.keys(NAME_OVERRIDES));
    expect(() => assertNameOverridesMatchSpec(ops)).not.toThrow();
  });

  it("throws with stale-keys message when an override key is missing", () => {
    const ops = new Set(Object.keys(NAME_OVERRIDES));
    // Drop the first key - that simulates a typo or spec-rename.
    const firstKey = Object.keys(NAME_OVERRIDES)[0]!;
    ops.delete(firstKey);
    expect(() => assertNameOverridesMatchSpec(ops)).toThrowError(/Stale NAME_OVERRIDES/);
    expect(() => assertNameOverridesMatchSpec(ops)).toThrowError(new RegExp(firstKey));
  });

  it("throws with all stale keys listed when several are missing", () => {
    const ops = new Set<string>(); // empty: every key is stale
    let caught: Error | null = null;
    try {
      assertNameOverridesMatchSpec(ops);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    for (const key of Object.keys(NAME_OVERRIDES)) {
      expect(caught!.message).toContain(key);
    }
  });
});
