import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Release and supply-chain rules that live in workflow files and docs.
// The workflows are read as text (no YAML parser in the tree); jobs are
// the two-space-indented keys under `jobs:`.

const root = new URL("../../", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, root), "utf8");

/** `jobs:` of a workflow, keyed by job id, each with its raw text. */
function jobs(workflow: string): Map<string, string> {
  const body = workflow.slice(workflow.indexOf("\njobs:\n") + "\njobs:\n".length);
  const out = new Map<string, string>();
  const re = /^ {2}([a-z0-9-]+):\n/gm;
  const heads = [...body.matchAll(re)];
  heads.forEach((m, i) => {
    out.set(m[1]!, body.slice(m.index, heads[i + 1]?.index ?? body.length));
  });
  return out;
}

/** The `run:` commands of a job, one entry per line of each script. */
function runLines(job: string): string[] {
  const lines: string[] = [];
  const all = job.split("\n");
  all.forEach((line, i) => {
    const single = /^\s*(?:- )?run: (?!\|)(.+)$/.exec(line);
    if (single) lines.push(single[1]!.replace(/^["']|["']$/g, ""));
    else if (/^\s*(?:- )?run: \|\s*$/.test(line)) {
      const indent = /^\s*/.exec(all[i + 1] ?? "")![0].length;
      for (let j = i + 1; j < all.length; j++) {
        const next = all[j]!;
        if (next.trim() && /^\s*/.exec(next)![0].length < indent) break;
        lines.push(next.trim());
      }
    }
  });
  return lines.filter(Boolean);
}

/** Index of the first line containing `needle` at or after `from`, or -1. */
function after(lines: string[], needle: string, from = 0): number {
  const i = lines.slice(from).findIndex((l) => l.includes(needle));
  return i < 0 ? -1 : from + i;
}

const ci = read(".github/workflows/ci.yml");
const release = read(".github/workflows/release.yml");
const registry = read(".github/workflows/mcp-registry.yml");
const ciJobs = jobs(ci);
const releaseJobs = jobs(release);

describe("production deploy path (docs/DEPLOYMENT.md)", () => {
  const blocks = [...read("docs/DEPLOYMENT.md").matchAll(/```bash\n([\s\S]*?)```/g)].map((m) =>
    m[1]!.split("\n"),
  );
  const installs = blocks.filter((b) => b.some((l) => l.trim() === "npm run build"));

  it("prunes the dev dependencies after every source build", () => {
    expect(installs.length).toBeGreaterThan(0);
    for (const block of installs) {
      const build = after(block, "npm run build");
      expect(after(block, "npm ci"), block.join("\n")).toBeLessThan(build);
      expect(after(block, "npm prune --omit=dev", build), block.join("\n")).toBeGreaterThan(build);
    }
  });

  it("is run by CI, which audits exactly the pruned tree and starts it", () => {
    const job = ciJobs.get("deploy-path");
    expect(job, "ci.yml job deploy-path").toBeDefined();
    const run = runLines(job!);
    const ci = after(run, "npm ci");
    const build = after(run, "npm run build", ci);
    const prune = after(run, "npm prune --omit=dev", build);
    expect(ci).toBeGreaterThanOrEqual(0);
    expect(build).toBeGreaterThan(ci);
    expect(prune).toBeGreaterThan(build);
    expect(after(run, "npm query .dev", prune)).toBeGreaterThan(prune);
    expect(after(run, "npm audit --omit=dev --audit-level=high", prune)).toBeGreaterThan(prune);
    expect(after(run, "scripts/tools-list-snapshot.mjs", prune)).toBeGreaterThan(prune);
  });
});

describe("MCPB reproducibility gate", () => {
  it("CI builds the bundle twice in separate checkouts and compares SHA-256", () => {
    const job = ciJobs.get("mcpb-reproducible");
    expect(job, "ci.yml job mcpb-reproducible").toBeDefined();
    const run = runLines(job!).join("\n");
    expect(run).toContain("npm run build:mcpb");
    expect(run).toContain("sha256sum");
    expect(job!.match(/path: /g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe("release.yml", () => {
  it("runs on version tags only and runs the full CI workflow on the tag commit first", () => {
    expect(release).toMatch(/on:\n {2}push:\n {4}tags:\n {6}- "v\*\.\*\.\*"\n/);
    expect(ci).toMatch(/^ {2}workflow_call:/m);
    const gate = [...releaseJobs].find(([, j]) => /uses: \.\/\.github\/workflows\/ci\.yml/.test(j));
    expect(gate, "a job that calls ci.yml").toBeDefined();
    expect(releaseJobs.get("build")).toMatch(new RegExp(`needs: \\[?[^\\n]*\\b${gate![0]}\\b`));
  });

  it("refuses a tag that is not on main or does not match package.json", () => {
    const verify = runLines(releaseJobs.get("verify") ?? "").join("\n");
    expect(verify).toContain("git merge-base --is-ancestor");
    expect(verify).toContain("origin/main");
    expect(verify).toContain("require('./package.json').version");
  });

  it("never overwrites release assets", () => {
    expect(release).not.toContain("--clobber");
  });

  it("ships SBOMs and checksums and attests every asset", () => {
    const build = runLines(releaseJobs.get("build") ?? "").join("\n");
    expect(build).toContain("npm ci --ignore-scripts");
    // scripts/build-mcpb.sh (run by test:e2e) writes both SBOMs.
    expect(build).toContain("npm run test:e2e");
    expect(read("scripts/build-mcpb.sh")).toMatch(/release-sbom\.mjs [^\n]* application /);
    expect(read("scripts/build-mcpb.sh")).toMatch(/release-sbom\.mjs [^\n]* library /);
    expect(build).toContain("cp dist/action1-mcp-*.mcpb dist/*.cdx.json release/");
    expect(build).toContain("npm pack");
    expect(build).toContain("SHA256SUMS");
    const publish = releaseJobs.get("github-release") ?? "";
    expect(publish).toMatch(/actions\/attest-build-provenance@[0-9a-f]{40} # v\d/);
    for (const asset of ["*.mcpb", "*.tgz", "*.cdx.json"]) {
      expect(publish, asset).toContain(`release/${asset}`);
    }
  });

  it("publishes the built tarball to npm without installing anything", () => {
    const job = releaseJobs.get("npm-publish") ?? "";
    const run = runLines(job);
    expect(run.filter((l) => /\bnpm (ci|install|i)\b/.test(l))).toEqual([]);
    expect(run.some((l) => /npm publish .*\.tgz/.test(l))).toBe(true);
    expect(job).toContain("sha256sum --check");
  });
});

describe("MCP Registry listing (server.json, mcp-registry.yml)", () => {
  const pkg = JSON.parse(read("package.json")) as {
    name: string;
    version: string;
    mcpName: string;
    repository: { url: string };
  };
  const server = JSON.parse(read("server.json")) as {
    $schema: string;
    name: string;
    version: string;
    repository: { url: string; source: string };
    packages: {
      registryType: string;
      identifier: string;
      version: string;
      fileSha256?: string;
      transport: { type: string };
      environmentVariables: { name: string; isSecret?: boolean }[];
    }[];
  };
  const byType = (type: string) => server.packages.filter((p) => p.registryType === type);
  const manifest = JSON.parse(read("mcpb/manifest.json")) as {
    server: { mcp_config: { env: Record<string, string> } };
  };

  it("lists this repository's MCPB release asset under the package.json version", () => {
    expect(server.$schema).toMatch(
      /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/\d{4}-\d{2}-\d{2}\/server\.schema\.json$/,
    );
    expect(server.name).toBe("io.github.mguttmann/action1-mcp");
    expect(server.version).toBe(pkg.version);
    expect(pkg.repository.url).toContain(server.repository.url.replace("https://", ""));
    expect(server.packages.map((p) => p.registryType).sort()).toEqual(["mcpb", "npm"]);
    const [p] = byType("mcpb");
    expect(p!.version).toBe(pkg.version);
    expect(p!.identifier).toBe(
      `${server.repository.url}/releases/download/v${pkg.version}/action1-mcp-${pkg.version}.mcpb`,
    );
    expect(p!.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p!.transport.type).toBe("stdio");
  });

  it("lists the npm package under its package.json name, version and mcpName", () => {
    // The registry accepts the npm entry only when npm serves this version
    // with an mcpName equal to the server name.
    expect(pkg.mcpName).toBe(server.name);
    const [p] = byType("npm");
    expect(p!.identifier).toBe(pkg.name);
    expect(p!.version).toBe(pkg.version);
    expect(p!.transport.type).toBe("stdio");
    expect(p!.fileSha256).toBeUndefined();
  });

  it("declares exactly the environment of the bundle in every package, credentials as secrets", () => {
    for (const p of server.packages) {
      const env = p.environmentVariables;
      expect(env.map((e) => e.name).sort(), p.registryType).toEqual(
        Object.keys(manifest.server.mcp_config.env).sort(),
      );
      const secrets = env.filter((e) => e.isSecret).map((e) => e.name);
      expect(secrets.sort(), p.registryType).toEqual([
        "ACTION1_CLIENT_ID",
        "ACTION1_CLIENT_SECRET",
      ]);
    }
    expect(byType("npm")[0]!.environmentVariables).toEqual(byType("mcpb")[0]!.environmentVariables);
  });

  it("is published by release.yml after the GitHub release, through OIDC", () => {
    const job = releaseJobs.get("mcp-registry") ?? "";
    expect(job).toMatch(/needs: \[?[^\n]*\bgithub-release\b/);
    expect(job).toContain("uses: ./.github/workflows/mcp-registry.yml");
    expect(job).toContain("id-token: write");
    // The registry checks the npm version, so the listing waits for the
    // publish; a skipped publish (publishing off) must not block it.
    expect(job).toMatch(/needs: \[?[^\n]*\bnpm-publish\b/);
    expect(job).toContain("needs.npm-publish.result == 'skipped'");
    expect(job).toContain("npm-published: ${{ needs.npm-publish.result == 'success' }}");
    expect(registry).toMatch(/^ {2}workflow_call:/m);
    expect(registry).toMatch(/^ {2}workflow_dispatch:/m);
  });

  it("runs a pinned, checksum-verified mcp-publisher and reads SHA256SUMS of the release", () => {
    expect(registry).toMatch(/MCP_PUBLISHER_VERSION: v\d+\.\d+\.\d+\n/);
    expect(registry).toMatch(/MCP_PUBLISHER_SHA256: [0-9a-f]{64}\n/);
    const run = [...jobs(registry).values()].flatMap(runLines);
    expect(run.join("\n")).not.toMatch(/releases\/latest|\|\s*(ba)?sh\b/);
    const check = run.findIndex(
      (l) => l.includes("${MCP_PUBLISHER_SHA256}") && l.includes("sha256sum --check"),
    );
    const extract = after(run, "tar -xzf");
    expect(check).toBeGreaterThanOrEqual(0);
    expect(extract).toBeGreaterThan(check);
    expect(after(run, "SHA256SUMS")).toBeGreaterThanOrEqual(0);
    expect(after(run, "./mcp-publisher login github-oidc", extract)).toBeGreaterThan(extract);
    expect(after(run, "./mcp-publisher publish", extract)).toBeGreaterThan(extract);
  });

  it("sets the npm version and drops the npm entry when npm does not serve it", () => {
    const run = [...jobs(registry).values()].flatMap(runLines).join("\n");
    expect(run).toContain('elif .registryType == "npm" then');
    expect(run).toContain("https://registry.npmjs.org/${ident}/${version}");
    expect(run).toContain(".mcpName // empty");
    expect(run).toContain('.packages |= map(select(.registryType != "npm"))');
    expect(registry).toMatch(/^ {6}npm-published:\n(?: {8}.*\n)* {8}type: boolean$/m);
  });
});

describe("workflow hygiene", () => {
  const dir = ".github/workflows/";
  const workflows = Object.fromEntries(
    readdirSync(new URL(dir, root))
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => [f, read(dir + f)]),
  );

  it("covers every workflow file", () => {
    expect(Object.keys(workflows)).toEqual(
      expect.arrayContaining(["ci.yml", "release.yml", "spec-drift.yml", "mcp-registry.yml"]),
    );
  });

  it("every job that runs steps has a timeout", () => {
    const missing: string[] = [];
    for (const [file, text] of Object.entries(workflows)) {
      for (const [id, job] of jobs(text)) {
        // A job that calls a reusable workflow cannot set one.
        if (/^ {4}uses: /m.test(job)) continue;
        if (!/^ {4}timeout-minutes: \d+$/m.test(job)) missing.push(`${file} ${id}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every action is pinned to a full commit SHA", () => {
    const unpinned: string[] = [];
    for (const [file, text] of Object.entries(workflows)) {
      for (const m of text.matchAll(/^\s*(?:- )?uses: ([^\s#]+)/gm)) {
        const ref = m[1]!;
        if (ref.startsWith("./")) continue;
        if (!/@[0-9a-f]{40}$/.test(ref)) unpinned.push(`${file}: ${ref}`);
      }
    }
    expect(unpinned).toEqual([]);
  });

  it("CI verifies the registry signatures of the installed packages", () => {
    expect(runLines(ciJobs.get("audit") ?? "")).toContain("npm audit signatures");
  });
});

describe("docs/maintainers/repo-settings.md", () => {
  it("names every CI job as a required check", () => {
    const doc = read("docs/maintainers/repo-settings.md");
    for (const id of ciJobs.keys()) expect(doc, id).toContain(`\`${id}`);
  });
});

describe("pinned tools", () => {
  it("every npx call of the MCP inspector names a version", () => {
    const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((f) => /\.(md|sh|json|mjs|ts|ya?ml)$/.test(f) && f !== "package-lock.json");
    const unpinned: string[] = [];
    for (const f of files) {
      read(f)
        .split("\n")
        .forEach((line, i) => {
          if (/npx\b[^\n]*@modelcontextprotocol\/inspector(?!@\d)/.test(line)) {
            unpinned.push(`${f}:${i + 1}`);
          }
        });
    }
    expect(unpinned).toEqual([]);
  });
});

describe("npm distribution in the docs", () => {
  it("no document claims the package is unpublished or forbids installing it", () => {
    const files = execFileSync("git", ["ls-files", "*.md"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((f) => f && f !== "CHANGELOG.md");
    const stale =
      /not (?:yet )?published (?:to|on) npm|not on npm|publishing to npm is planned|npm \(not available|do not install `action1-mcp-server`|install anything named like this project from npm/i;
    const hits: string[] = [];
    for (const f of files) {
      read(f)
        .replace(/\s+/g, " ")
        .split(/(?<=\.) /)
        .forEach((sentence) => {
          if (stale.test(sentence)) hits.push(`${f}: ${sentence.slice(0, 120)}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it("README, INSTALLATION and CLAUDE.md name the npx command of the package", () => {
    const pkg = JSON.parse(read("package.json")) as { name: string };
    for (const f of ["README.md", "docs/INSTALLATION.md", "CLAUDE.md"]) {
      expect(read(f), f).toContain(`npx -y ${pkg.name}`);
    }
  });
});

describe("Glama listing (glama.json)", () => {
  it("names mguttmann as maintainer under Glama's server schema", () => {
    const glama = JSON.parse(read("glama.json")) as { $schema: string; maintainers: string[] };
    expect(glama.$schema).toBe("https://glama.ai/mcp/schemas/server.json");
    expect(glama.maintainers).toEqual(["mguttmann"]);
  });
});
