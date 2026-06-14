import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkDestructiveGuard } from "../../src/tools/destructiveGuard.js";

// Hand-picked truth-table for the three-layer destructive guard. Full
// 4-axis Cartesian product would be 2 (env) × 2 (auto) × 2 (confirm)
// × 3 (dry_run) = 24 cases; many of those collapse onto the same
// branch. We pick the 9 that actually exercise distinct logic paths
// (defaults vs explicit settings, env on/off, auto-confirm interaction)
// so the suite is fast and each row reads as a unique scenario rather
// than a parameter-grid cell.

const PREVIEW = { method: "POST", path: "/p", body: { hello: "world" } };
const CTX = { toolName: "action1_test_tool", preview: PREVIEW };

interface Case {
  env: boolean;
  auto: boolean;
  confirm: "YES" | undefined;
  dry_run: boolean | undefined;
  // expected outcome:
  //   "preview"  → dry_run path (returns a CallToolResult with
  //                structuredContent.dry_run = true)
  //   "refuse"   → returns isError CallToolResult
  //   "allow"    → returns null (perform should be called)
  expected: "preview" | "refuse" | "allow";
  why: string;
}

const CASES: Case[] = [
  // dry_run defaults — Pass-4 audit: dry_run-by-default applies in
  // BOTH normal AND auto-confirm modes. Auto-confirm only collapses
  // the per-call `confirm: "YES"` requirement, not the preview-by-
  // default behaviour. A bare call always previews.
  { env: true, auto: false, confirm: undefined, dry_run: undefined, expected: "preview", why: "default dry_run=true in normal mode" },
  { env: true, auto: true, confirm: undefined, dry_run: undefined, expected: "preview", why: "auto-confirm still respects default dry_run=true" },

  // explicit dry_run=true always previews
  { env: true, auto: false, confirm: "YES", dry_run: true, expected: "preview", why: "dry_run=true always wins" },
  { env: false, auto: false, confirm: "YES", dry_run: true, expected: "preview", why: "preview ignores env (no API call)" },

  // confirm='YES' + dry_run=false + env=true → allow
  { env: true, auto: false, confirm: "YES", dry_run: false, expected: "allow", why: "all three layers satisfied" },

  // confirm missing + dry_run=false + env=true → refuse
  { env: true, auto: false, confirm: undefined, dry_run: false, expected: "refuse", why: "missing per-call confirm" },

  // confirm='YES' + dry_run=false + env=false → refuse
  { env: false, auto: false, confirm: "YES", dry_run: false, expected: "refuse", why: "env switch off" },

  // auto-confirm bypasses confirm but still respects env (must use
  // explicit dry_run=false to actually exercise the env gate; bare
  // calls just preview).
  { env: false, auto: true, confirm: undefined, dry_run: false, expected: "refuse", why: "auto-confirm without env" },
  { env: true, auto: true, confirm: undefined, dry_run: false, expected: "allow", why: "auto-confirm with env, dry_run=false" },
];

describe("destructive guard truth table", () => {
  beforeEach(() => {
    delete process.env.ACTION1_ALLOW_DESTRUCTIVE;
    delete process.env.ACTION1_DESTRUCTIVE_AUTO_CONFIRM;
  });
  afterEach(() => {
    delete process.env.ACTION1_ALLOW_DESTRUCTIVE;
    delete process.env.ACTION1_DESTRUCTIVE_AUTO_CONFIRM;
  });

  for (const c of CASES) {
    it(`env=${c.env} auto=${c.auto} confirm=${c.confirm ?? "∅"} dry_run=${c.dry_run ?? "∅"} → ${c.expected} (${c.why})`, () => {
      if (c.env) process.env.ACTION1_ALLOW_DESTRUCTIVE = "true";
      if (c.auto) process.env.ACTION1_DESTRUCTIVE_AUTO_CONFIRM = "true";
      const guard = checkDestructiveGuard(
        { confirm: c.confirm, dry_run: c.dry_run },
        CTX,
      );
      if (c.expected === "allow") {
        expect(guard).toBeNull();
        return;
      }
      expect(guard).not.toBeNull();
      if (c.expected === "preview") {
        expect(guard?.isError).toBeFalsy();
        const sc = (guard?.structuredContent ?? {}) as Record<string, unknown>;
        expect(sc.dry_run).toBe(true);
        expect(sc.tool).toBe("action1_test_tool");
        return;
      }
      // refuse
      expect(guard?.isError).toBe(true);
    });
  }
});
