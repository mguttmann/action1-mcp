import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isStatusMarker } from "../../src/utils/filterOutput.js";
import { connectHarness, resultText, setSweepEnv, type Harness } from "../helpers/mcpHarness.js";
import { stubSpecApi } from "../helpers/specStub.js";

// evals/action1-eval.xml asks questions whose answers are facts of this
// server: template ids and parameters it sends, values it derives, tool
// names it registers. Running the eval harness needs a live tenant and a
// model; this test holds every answer against the server itself, so the
// suite cannot drift from the code without a red test. A new qa_pair
// needs a check here.

const XML = readFileSync(new URL("../../evals/action1-eval.xml", import.meta.url), "utf8");
const README = readFileSync(new URL("../../evals/README.md", import.meta.url), "utf8");

const QA = [...XML.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<qa_pair>([\s\S]*?)<\/qa_pair>/g)].map(
  (m) => ({
    question: /<question>([\s\S]*?)<\/question>/.exec(m[1]!)?.[1]?.trim() ?? "",
    answer: /<answer>([\s\S]*?)<\/answer>/.exec(m[1]!)?.[1]?.trim() ?? "",
  }),
);

const EP = "00000000-0000-4000-8000-0000000000e1";

let H: Harness;
let TOOL_NAMES: Set<string>;
let DEPLOY_UPDATE_REBOOT: string[];

beforeAll(async () => {
  setSweepEnv({});
  H = await connectHarness("evals");
  const { tools } = await H.client.listTools();
  TOOL_NAMES = new Set(tools.map((t) => t.name));
  const deploy = tools.find((t) => t.name === "action1_deploy_update")!;
  DEPLOY_UPDATE_REBOOT = (deploy.inputSchema as { properties: Record<string, { enum?: string[] }> })
    .properties.reboot_after!.enum!;
}, 30_000);

afterAll(async () => {
  await H?.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The request body a destructive tool would send (its dry-run preview). */
async function previewBody(name: string, args: Record<string, unknown>): Promise<string> {
  stubSpecApi();
  const r = await H.client.callTool({ name, arguments: { endpoint_id: EP, ...args } });
  expect(r.isError ?? false, resultText(r)).toBe(false);
  const sc = r.structuredContent as { dry_run: boolean; would_send: { body: unknown } };
  expect(sc.dry_run).toBe(true);
  return JSON.stringify(sc.would_send.body);
}

async function platformFor(os: string): Promise<string> {
  stubSpecApi({
    transform: (body) => ({ ...(body as object), OS: os, platform: os, os_name: os, name: os }),
  });
  const r = await H.client.callTool({
    name: "action1_get_endpoint",
    arguments: { endpoint_id: EP },
  });
  return (r.structuredContent as { platform: string }).platform;
}

const sorted = (xs: Iterable<string>) => [...xs].sort().join(",");

/** One check per answer; each proves the answer from the running server. */
const CHECKS: Record<string, () => Promise<void>> = {
  run_powershell: async () => {
    const body = await previewBody("action1_run_powershell", { script_text: "x" });
    expect(body).toContain('"template_id":"run_powershell"');
    expect(body).toContain('"success_exit_codes"');
  },
  run_script: async () => {
    const body = await previewBody("action1_run_bash_macos", { script_text: "x" });
    expect(body).toContain('"template_id":"run_script"');
  },
  run_script_language: async () => {
    const body = await previewBody("action1_run_bash_macos", { script_text: "x" });
    expect(body).toContain('"run_script_language":"Bash"');
  },
  Mac: async () => {
    const body = await previewBody("action1_run_bash_macos", { script_text: "x" });
    expect(body).toContain('"platform":"Mac"');
  },
  reboot: async () => {
    const body = await previewBody("action1_reboot_endpoint", {});
    expect(body).toContain('"template_id":"reboot"');
  },
  "linux,macos,unknown,windows": async () => {
    const seen = new Set<string>();
    for (const os of ["Windows 11 Pro", "macOS 14 Sonoma", "Ubuntu 22.04", "Plan 9"]) {
      seen.add(await platformFor(os));
    }
    expect(sorted(seen)).toBe("linux,macos,unknown,windows");
  },
  "Completed,Starting,Waiting": async () => {
    const candidates = ["Starting", "Waiting", "Completed", "Finished", "Failed", "Running"];
    expect(sorted(candidates.filter((w) => isStatusMarker(`${w}: x`)))).toBe(
      "Completed,Starting,Waiting",
    );
    await Promise.resolve();
  },
  "if_required,no,yes": async () => {
    expect(sorted(DEPLOY_UPDATE_REBOOT)).toBe("if_required,no,yes");
    const body = await previewBody("action1_deploy_update", {
      updates: [{ package_id: "p1", version: "" }],
      reboot_after: "if_required",
    });
    expect(body).toContain('"auto_reboot":"if_required"');
  },
  "0": async () => {
    const body = await previewBody("action1_run_powershell", { script_text: "x" });
    expect(body).toContain('"success_exit_codes":"0"');
  },
  uninstall_program: async () => {
    const body = await previewBody("action1_uninstall_program", { params: {} });
    expect(body).toContain('"template_id":"uninstall_program"');
  },
  action1_remove_endpoint_from_group: async () => {
    expect(TOOL_NAMES.has("action1_remove_endpoint_from_group")).toBe(true);
    await Promise.resolve();
  },
};

describe("evals/action1-eval.xml", () => {
  it("has well-formed qa_pairs with a question and an answer", () => {
    expect(QA.length).toBeGreaterThan(0);
    for (const qa of QA) {
      expect(qa.question.length, JSON.stringify(qa)).toBeGreaterThan(0);
      expect(qa.answer.length, JSON.stringify(qa)).toBeGreaterThan(0);
    }
  });

  it("every tool a question or answer names is registered", () => {
    const named = QA.flatMap(
      (qa) => `${qa.question} ${qa.answer}`.match(/action1_[a-z0-9_]+/g) ?? [],
    );
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((n) => !TOOL_NAMES.has(n))).toEqual([]);
  });

  it("every answer has a check against the server", () => {
    expect(QA.map((qa) => qa.answer).filter((a) => !(a in CHECKS))).toEqual([]);
  });

  it.each(QA.map((qa) => [qa.answer] as const))("answer %j holds against the server", async (a) => {
    await CHECKS[a]!();
  });

  it("the README states no fixed question count or score", () => {
    expect(README).not.toMatch(/\b\d+\s*\/\s*\d+\b/);
  });
});
