import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENV_VARS } from "../../src/config.js";

// The MCPB manifest maps Claude Desktop's install wizard (user_config)
// to the server's environment (server.mcp_config.env). A typo on either
// side does not break `mcpb validate`, so it is checked here against the
// env schema the server actually reads. tests/e2e/artifacts.test.ts
// starts the built bundle from the same mcp_config.

interface Manifest {
  server: {
    entry_point: string;
    mcp_config: { command: string; args: string[]; env: Record<string, string> };
  };
  user_config: Record<string, { required?: boolean }>;
  compatibility?: { runtimes?: { node?: string } };
}

const manifest = JSON.parse(
  readFileSync(new URL("../../mcpb/manifest.json", import.meta.url), "utf8"),
) as Manifest;
const { mcp_config: mcpConfig, entry_point: entryPoint } = manifest.server;
const knownEnv = Object.keys(ENV_VARS);
const USER_CONFIG_REF = /^\$\{user_config\.([a-z0-9_]+)\}$/;

describe("mcpb/manifest.json mcp_config", () => {
  it("sets only env vars the server reads", () => {
    for (const key of Object.keys(mcpConfig.env)) {
      expect(knownEnv, `${key} is not read by src/config.ts`).toContain(key);
    }
  });

  it("maps every required env var", () => {
    const required = Object.entries(ENV_VARS)
      .filter(([, v]) => v.group === "required")
      .map(([k]) => k);
    expect(required.length).toBeGreaterThan(0);
    for (const key of required) expect(Object.keys(mcpConfig.env)).toContain(key);
  });

  it("fills every env var from a defined user_config field and uses every field", () => {
    const used = new Set<string>();
    for (const [key, value] of Object.entries(mcpConfig.env)) {
      const ref = USER_CONFIG_REF.exec(value)?.[1];
      expect(ref, `${key} must be exactly \${user_config.<field>}`).toBeDefined();
      expect(Object.keys(manifest.user_config), `${key} -> ${value}`).toContain(ref);
      used.add(ref!);
    }
    expect([...used].sort()).toEqual(Object.keys(manifest.user_config).sort());
  });

  it("starts the bundled entry point with node", () => {
    expect(mcpConfig.command).toBe("node");
    expect(mcpConfig.args).toEqual([`\${__dirname}/${entryPoint}`]);
  });
});

describe("mcpb/manifest.json compatibility", () => {
  it("declares the same Node range as package.json engines", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { engines: { node: string } };
    expect(manifest.compatibility?.runtimes?.node).toBe(pkg.engines.node);
  });
});

describe("mcpb/manifest.json user_config", () => {
  const fields = manifest.user_config as Record<
    string,
    { type?: string; default?: unknown; required?: boolean }
  >;

  it("models on/off switches as booleans, so the wizard shows a checkbox", () => {
    // Claude Desktop passes a boolean as the string "true" / "false",
    // which the server's flag parser accepts, as it accepts a value
    // stored by an older string-typed manifest.
    const flagFields = Object.entries(mcpConfig.env)
      .filter(([key]) => /^ACTION1_(ALLOW|REDACT)_/.test(key))
      .map(([, value]) => USER_CONFIG_REF.exec(value)![1]!);
    expect(flagFields.length).toBeGreaterThan(0);
    for (const f of flagFields) {
      expect(fields[f]!.type, f).toBe("boolean");
      expect(typeof fields[f]!.default, f).toBe("boolean");
    }
  });
});

describe("environment variable docs follow ENV_VARS in src/config.ts", () => {
  const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

  it("README's configuration table lists exactly the env vars the server reads", () => {
    const readme = read("README.md");
    const section = readme.slice(readme.indexOf("## Configuration"));
    const table = section.slice(0, section.indexOf("\n## "));
    const rows = [...table.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|/gm)].map((m) => m[1]!);
    expect(rows.sort()).toEqual([...knownEnv].sort());
  });

  it("mcpb/README.md names every non-HTTP env var the bundle does not expose", () => {
    const text = read("mcpb/README.md");
    const notExposed = Object.entries(ENV_VARS)
      .filter(([key, v]) => v.group !== "http" && !(key in mcpConfig.env))
      .map(([key]) => key);
    for (const key of notExposed) expect(text, key).toContain(`\`${key}\``);
  });
});
