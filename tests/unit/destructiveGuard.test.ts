import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkDestructiveGuard } from "../../src/tools/destructiveGuard.js";
import { resetConfigCache } from "../../src/config.js";

const ctx = {
  toolName: "action1_test",
  preview: { method: "POST", path: "/test", body: { hello: "world" } },
};

beforeAll(() => {
  // checkDestructiveGuard now reads its env flags through loadConfig(),
  // which needs the mandatory ACTION1_* vars present even for a unit
  // test that only exercises the destructive-guard code path.
  process.env.ACTION1_BASE_URL = "https://app.eu.action1.test/api/3.0";
  process.env.ACTION1_CLIENT_ID = "client-id-test";
  process.env.ACTION1_CLIENT_SECRET = "client-secret-test";
});

describe("checkDestructiveGuard", () => {
  let oldEnv: string | undefined;
  let oldAuto: string | undefined;
  beforeEach(() => {
    oldEnv = process.env.ACTION1_ALLOW_DESTRUCTIVE;
    oldAuto = process.env.ACTION1_DESTRUCTIVE_AUTO_CONFIRM;
    // Re-read env on every test: the cached singleton would otherwise
    // leak state between cases (we mutate ACTION1_ALLOW_DESTRUCTIVE per
    // test and the parsed `allowDestructive` flag is computed once).
    resetConfigCache();
  });
  afterEach(() => {
    if (oldEnv === undefined) delete process.env.ACTION1_ALLOW_DESTRUCTIVE;
    else process.env.ACTION1_ALLOW_DESTRUCTIVE = oldEnv;
    if (oldAuto === undefined) delete process.env.ACTION1_DESTRUCTIVE_AUTO_CONFIRM;
    else process.env.ACTION1_DESTRUCTIVE_AUTO_CONFIRM = oldAuto;
    resetConfigCache();
  });

  it("returns dry-run preview when dry_run is true (default)", () => {
    const r = checkDestructiveGuard({}, ctx);
    expect(r).not.toBeNull();
    expect(r!.isError).toBeFalsy();
    expect(r!.structuredContent?.dry_run).toBe(true);
    expect(r!.structuredContent?.tool).toBe("action1_test");
  });

  it("rejects when env is missing even with confirm=YES and dry_run=false", () => {
    delete process.env.ACTION1_ALLOW_DESTRUCTIVE;
    const r = checkDestructiveGuard({ confirm: "YES", dry_run: false }, ctx);
    expect(r).not.toBeNull();
    expect(r!.isError).toBe(true);
    const text = (r!.content[0] as { text: string }).text;
    expect(text).toContain("ACTION1_ALLOW_DESTRUCTIVE");
  });

  it("rejects when confirm is missing", () => {
    process.env.ACTION1_ALLOW_DESTRUCTIVE = "true";
    const r = checkDestructiveGuard({ dry_run: false }, ctx);
    expect(r).not.toBeNull();
    expect(r!.isError).toBe(true);
    expect((r!.content[0] as { text: string }).text).toContain("confirm");
  });

  it("missing-confirm error message hints at common typos", () => {
    // Pass-4 review: the typo-detection function was dead code; instead
    // the error message itself mentions common typos so the agent can
    // self-correct without the server doing key-fuzzing.
    process.env.ACTION1_ALLOW_DESTRUCTIVE = "true";
    const r = checkDestructiveGuard({ dry_run: false }, ctx);
    const text = (r!.content[0] as { text: string }).text;
    expect(text).toContain("confrim");
    expect(text).toContain("silently dropped");
  });

  it("returns null (proceed) when env=true, confirm=YES, dry_run=false", () => {
    process.env.ACTION1_ALLOW_DESTRUCTIVE = "true";
    const r = checkDestructiveGuard({ confirm: "YES", dry_run: false }, ctx);
    expect(r).toBeNull();
  });

  it("treats env values 'true' / '1' / 'yes' as allowed", () => {
    for (const v of ["true", "1", "yes", "TRUE", "Yes"]) {
      process.env.ACTION1_ALLOW_DESTRUCTIVE = v;
      resetConfigCache();
      expect(checkDestructiveGuard({ confirm: "YES", dry_run: false }, ctx)).toBeNull();
    }
  });

  it("parses 'TRUE\\n' (pasted-from-.env trailing newline) as allowed", () => {
    // Pass-N audit: the old `process.env.X.toLowerCase() === "true"`
    // check refused `"TRUE\n"` silently because the literal compare
    // included the newline character. Now we route through
    // loadConfig() which trims before comparing, so the most common
    // .env-paste footgun resolves to true as intended.
    process.env.ACTION1_ALLOW_DESTRUCTIVE = "TRUE\n";
    resetConfigCache();
    expect(checkDestructiveGuard({ confirm: "YES", dry_run: false }, ctx)).toBeNull();
  });

  it("also tolerates surrounding whitespace on the auto-confirm flag", () => {
    process.env.ACTION1_ALLOW_DESTRUCTIVE = "true";
    process.env.ACTION1_DESTRUCTIVE_AUTO_CONFIRM = " yes \n";
    resetConfigCache();
    // With auto-confirm parsed correctly, the bare `dry_run: false` call
    // proceeds without `confirm: "YES"`.
    expect(checkDestructiveGuard({ dry_run: false }, ctx)).toBeNull();
  });

  it("AUTO_CONFIRM=true with dry_run=false waives the per-call confirm but still requires env", () => {
    // Pass-4 audit hardened the auto-confirm path: dry_run is NEVER
    // auto-flipped, only the per-call `confirm: \"YES\"` requirement
    // is waived. So with explicit dry_run=false and env=true, the
    // call proceeds without confirm.
    process.env.ACTION1_ALLOW_DESTRUCTIVE = "true";
    process.env.ACTION1_DESTRUCTIVE_AUTO_CONFIRM = "true";
    expect(checkDestructiveGuard({ dry_run: false }, ctx)).toBeNull();
  });

  it("AUTO_CONFIRM=true does NOT auto-flip dry_run; bare call still previews", () => {
    process.env.ACTION1_ALLOW_DESTRUCTIVE = "true";
    process.env.ACTION1_DESTRUCTIVE_AUTO_CONFIRM = "true";
    // No dry_run passed → defaults to true → preview (NOT executed).
    // This is the safety-net: dry_run-by-default survives auto-confirm.
    const r = checkDestructiveGuard({}, ctx);
    expect(r).not.toBeNull();
    expect(r!.structuredContent?.dry_run).toBe(true);
  });

  it("AUTO_CONFIRM=true still respects an explicit dry_run=true request", () => {
    process.env.ACTION1_ALLOW_DESTRUCTIVE = "true";
    process.env.ACTION1_DESTRUCTIVE_AUTO_CONFIRM = "true";
    const r = checkDestructiveGuard({ dry_run: true }, ctx);
    expect(r).not.toBeNull();
    expect(r!.structuredContent?.dry_run).toBe(true);
  });

  it("AUTO_CONFIRM=true does not bypass the env-allow gate (with explicit dry_run=false)", () => {
    delete process.env.ACTION1_ALLOW_DESTRUCTIVE;
    process.env.ACTION1_DESTRUCTIVE_AUTO_CONFIRM = "true";
    // Force past the dry_run preview to actually exercise the env gate.
    const r = checkDestructiveGuard({ dry_run: false }, ctx);
    expect(r).not.toBeNull();
    expect(r!.isError).toBe(true);
    expect((r!.content[0] as { text: string }).text).toContain("ACTION1_ALLOW_DESTRUCTIVE");
  });
});
