import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The server contract as clients and operators see it: the guard text in
// the server instructions and the start-up warning must state what
// checkDestructiveGuard actually does, for every combination of the
// guard env flags; the version has one source (package.json).

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

const root = new URL("../../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as { version: string };

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  for (const k of FLAGS) delete process.env[k];
  Object.assign(process.env, REQUIRED);
  vi.resetModules();
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  vi.restoreAllMocks();
  vi.resetModules();
});

async function load() {
  const config = await import("../../src/config.js");
  config.resetConfigCache();
  const guard = await import("../../src/tools/destructiveGuard.js");
  const server = await import("../../src/server.js");
  return { config, guard, server };
}

const ORDINARY = {
  toolName: "action1_x",
  preview: { method: "POST", path: "/endpoints/groups/o" },
};
const ACCOUNT = {
  toolName: "action1_delete_role",
  preview: { method: "DELETE", path: "/roles/r" },
};

const COMBOS: [boolean, boolean, boolean][] = [];
for (const a of [false, true])
  for (const b of [false, true]) for (const c of [false, true]) COMBOS.push([a, b, c]);

describe("server instructions and start-up warning match the guard", () => {
  it.each(COMBOS)("allow=%s auto=%s accountOps=%s", async (allow, auto, accountOps) => {
    // Operator-style values: case and whitespace vary.
    if (allow) process.env.ACTION1_ALLOW_DESTRUCTIVE = " TRUE\n";
    if (auto) process.env.ACTION1_DESTRUCTIVE_AUTO_CONFIRM = "Yes ";
    if (accountOps) process.env.ACTION1_ALLOW_ACCOUNT_OPS = "1";
    const { config, guard, server } = await load();
    const cfg = config.loadConfig();
    const text = server.serverInstructions(cfg);
    const decide = (input: { confirm?: "YES"; dry_run?: boolean }, op = ORDINARY) =>
      guard.checkDestructiveGuard(input, op);
    const isPreview = (r: ReturnType<typeof decide>) =>
      r !== null && !r.isError && (r.structuredContent as { dry_run?: boolean }).dry_run === true;

    // Claim: dry_run defaults to true in every mode.
    expect(text).toContain("default to `dry_run: true` in every server mode");
    expect(text).not.toMatch(/dry_run[^.]*defaults? to `?false/i);
    expect(text).not.toMatch(/default to execute/i);
    expect(isPreview(decide({}))).toBe(true);
    expect(isPreview(decide({ confirm: "YES" }))).toBe(true);
    expect(isPreview(decide({}, ACCOUNT))).toBe(true);

    // Claim: execution enabled or disabled.
    const full = decide({ dry_run: false, confirm: "YES" });
    if (allow) {
      expect(text).toContain("Destructive operations are enabled on this server");
      expect(full).toBeNull();
    } else {
      expect(text).toContain("Destructive operations are disabled on this server");
      expect(full?.isError).toBe(true);
    }

    // Claim: confirm required unless auto-confirm.
    const noConfirm = decide({ dry_run: false });
    if (auto) {
      expect(text).toContain('`confirm: "YES"` is not required');
      expect(noConfirm === null).toBe(allow);
    } else {
      expect(text).toContain('pass `dry_run: false` AND `confirm: "YES"`');
      expect(noConfirm?.isError).toBe(true);
    }

    // Claim: account operations need the second opt-in.
    const account = decide({ dry_run: false, confirm: "YES" }, ACCOUNT);
    if (accountOps) {
      expect(text).toContain("Account operations");
      expect(text).toContain("are enabled on this server (ACTION1_ALLOW_ACCOUNT_OPS=true)");
      expect(account === null).toBe(allow);
    } else {
      expect(text).toContain("they need ACTION1_ALLOW_ACCOUNT_OPS=true in addition");
      expect(account?.isError).toBe(true);
    }

    // Start-up warning: present iff auto-confirm is on, and it says
    // that dry_run still defaults to true.
    const warning = guard.autoConfirmWarning(cfg);
    if (auto) {
      expect(warning?.effect).toContain("dry_run still defaults to true");
      expect(warning?.effect).not.toMatch(/dry_run defaults to false/);
    } else {
      expect(warning).toBeUndefined();
    }
  });

  it("the start-up warning uses the trimmed config value and is logged once per process", async () => {
    // Before: server.ts parsed process.env without trim, so "TRUE " turned
    // auto-confirm on in the guard but logged no warning.
    process.env.ACTION1_DESTRUCTIVE_AUTO_CONFIRM = "TRUE ";
    const { server } = await load();
    const { log } = await import("../../src/utils/logger.js");
    const warn = vi.spyOn(log, "warn");
    server.buildServer();
    server.buildServer();
    const events = warn.mock.calls.filter(([event]) => event === "auto_confirm_enabled");
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0]![1])).toContain("dry_run still defaults to true");
  });
});

describe("server contract", () => {
  it("the server reports the package.json version in initialize", async () => {
    const { server } = await load();
    const { Client } = await import("@modelcontextprotocol/client");
    const { InMemoryTransport } = await import("@modelcontextprotocol/server");
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const built = server.buildServer();
    await built.server.connect(serverTx);
    const client = new Client({ name: "contract-test", version: "0.0.0" });
    await client.connect(clientTx);
    try {
      expect(client.getServerVersion()?.version).toBe(pkg.version);
      // No MCP logging capability: logs go to stderr only.
      expect(client.getServerCapabilities()?.logging).toBeUndefined();
      expect(client.getInstructions()).toContain("## Destructive guard");
    } finally {
      await client.close();
      await built.server.close();
    }
  });

  it("SERVER_VERSION, --help and the MCPB manifest carry the package.json version", async () => {
    const { SERVER_VERSION, readPackageVersion } = await import("../../src/version.js");
    const { helpText } = await import("../../src/index.js");
    const manifest = JSON.parse(readFileSync(new URL("mcpb/manifest.json", root), "utf8")) as {
      version: string;
    };
    expect(SERVER_VERSION).toBe(pkg.version);
    expect(helpText()).toContain(`action1-mcp ${pkg.version}`);
    expect(manifest.version).toBe(pkg.version);
    // The lookup also works for the bundle layout (package.json beside the module).
    expect(readPackageVersion(new URL("package.json", root).href)).toBe(pkg.version);
  });
});
