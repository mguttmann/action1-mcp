import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../../src/config.js";
import { checkDestructiveGuard } from "../../src/tools/destructiveGuard.js";

// Full truth table of the destructive guard, run through the production
// path: the env flags are read by loadConfig() (with a valid config and
// a reset cache), exactly as in a running server. A second block runs
// without a loadable config and checks that execution then fails closed.
//
// Axes: ACTION1_ALLOW_DESTRUCTIVE x ACTION1_DESTRUCTIVE_AUTO_CONFIRM x
// ACTION1_ALLOW_ACCOUNT_OPS x confirm x dry_run x kind of operation.

const REQUIRED = {
  ACTION1_BASE_URL: "https://app.eu.action1.test/api/3.0",
  ACTION1_CLIENT_ID: "client-id-test",
  ACTION1_CLIENT_SECRET: "client-secret-test",
};
const FLAGS = [
  "ACTION1_ALLOW_DESTRUCTIVE",
  "ACTION1_DESTRUCTIVE_AUTO_CONFIRM",
  "ACTION1_ALLOW_ACCOUNT_OPS",
] as const;

const OPS = {
  ordinary: {
    toolName: "action1_test_tool",
    preview: { method: "POST", path: "/endpoints/groups/o1" },
  },
  account: { toolName: "action1_delete_user", preview: { method: "DELETE", path: "/users/u1" } },
} as const;

type Expected = "preview" | "refuse" | "allow";

interface Case {
  env: boolean;
  auto: boolean;
  accountOps: boolean;
  confirm: "YES" | undefined;
  dry_run: boolean | undefined;
  op: keyof typeof OPS;
}

// The specification, written as rules (not as a copy of the guard code):
//   - dry_run defaults to true in every mode; a preview never executes;
//   - executing needs the master switch;
//   - account operations also need ACTION1_ALLOW_ACCOUNT_OPS;
//   - confirm:"YES" is required unless auto-confirm is on.
function expected(c: Case): Expected {
  if (c.dry_run ?? true) return "preview";
  if (!c.env) return "refuse";
  if (c.op === "account" && !c.accountOps) return "refuse";
  if (c.confirm !== "YES" && !c.auto) return "refuse";
  return "allow";
}

const CASES: Case[] = [];
for (const env of [false, true])
  for (const auto of [false, true])
    for (const accountOps of [false, true])
      for (const confirm of [undefined, "YES"] as const)
        for (const dry_run of [undefined, true, false])
          for (const op of ["ordinary", "account"] as const)
            CASES.push({ env, auto, accountOps, confirm, dry_run, op });

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  for (const k of [...FLAGS, ...Object.keys(REQUIRED)]) delete process.env[k];
  resetConfigCache();
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  resetConfigCache();
});

function check(result: ReturnType<typeof checkDestructiveGuard>, want: Expected, tool: string) {
  if (want === "allow") {
    expect(result).toBeNull();
    return;
  }
  expect(result).not.toBeNull();
  if (want === "preview") {
    expect(result?.isError).toBeFalsy();
    const sc = (result?.structuredContent ?? {}) as Record<string, unknown>;
    expect(sc.dry_run).toBe(true);
    expect(sc.tool).toBe(tool);
    return;
  }
  expect(result?.isError).toBe(true);
}

describe("destructive guard truth table (flags via loadConfig)", () => {
  it("covers every combination of the six axes", () => {
    expect(CASES).toHaveLength(2 * 2 * 2 * 2 * 3 * 2);
  });

  for (const c of CASES) {
    const want = expected(c);
    it(`env=${c.env} auto=${c.auto} accountOps=${c.accountOps} confirm=${c.confirm ?? "-"} dry_run=${c.dry_run ?? "-"} op=${c.op} -> ${want}`, () => {
      Object.assign(process.env, REQUIRED);
      // Values as an operator writes them, including a pasted newline.
      if (c.env) process.env.ACTION1_ALLOW_DESTRUCTIVE = "true\n";
      if (c.auto) process.env.ACTION1_DESTRUCTIVE_AUTO_CONFIRM = " YES";
      if (c.accountOps) process.env.ACTION1_ALLOW_ACCOUNT_OPS = "1";
      resetConfigCache();
      const op = OPS[c.op];
      const result = checkDestructiveGuard({ confirm: c.confirm, dry_run: c.dry_run }, op);
      check(result, want, op.toolName);
    });
  }
});

describe("destructive guard without a loadable config", () => {
  it.each([undefined, true])("dry_run=%s still previews (no config needed)", (dry_run) => {
    process.env.ACTION1_ALLOW_DESTRUCTIVE = "true";
    const result = checkDestructiveGuard({ confirm: "YES", dry_run }, OPS.ordinary);
    check(result, "preview", OPS.ordinary.toolName);
  });

  it("execution is refused (fail closed), even with every flag set in process.env", () => {
    for (const k of FLAGS) process.env[k] = "true";
    const result = checkDestructiveGuard({ confirm: "YES", dry_run: false }, OPS.ordinary);
    expect(result?.isError).toBe(true);
    expect((result!.content[0] as { text: string }).text).toContain(
      "configuration could not be loaded",
    );
  });
});
