import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractCuratedToolNames } from "../../src/codegen/naming.js";
import { resetConfigCache } from "../../src/config.js";

// docs/USAGE.md is the reference for the hand-written tools. These
// checks hold it to the live tools/list: every curated tool has a
// heading, and every input parameter is named either in the tool's own
// section or, for the shared parameters, in the Conventions section.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const usage = readFileSync(join(root, "docs", "USAGE.md"), "utf8");

function curatedNames(): Set<string> {
  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        if (entry !== "generated") walk(p);
      } else if (entry.endsWith(".ts")) sources.push(readFileSync(p, "utf8"));
    }
  };
  walk(join(root, "src", "tools"));
  return extractCuratedToolNames(sources);
}

interface Section {
  heading: string;
  body: string;
}

/** Split USAGE.md into heading sections (any level), body up to the next heading. */
function sections(text: string): Section[] {
  const out: Section[] = [];
  let current: Section | undefined;
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const m = fenced ? null : /^#{1,6}\s+(.+)$/.exec(line);
    if (m) {
      current = { heading: m[1]!, body: "" };
      out.push(current);
    } else if (current) {
      current.body += line + "\n";
    }
  }
  return out;
}

const all = sections(usage);
const conventions = all.find((s) => s.heading === "Conventions")?.body ?? "";

let CLIENT: import("@modelcontextprotocol/client").Client;
let SERVER: ReturnType<typeof import("../../src/server.js").buildServer>;

beforeAll(async () => {
  process.env.ACTION1_BASE_URL = "https://127.0.0.1:1/api/3.0";
  process.env.ACTION1_CLIENT_ID = "client-id-test";
  process.env.ACTION1_CLIENT_SECRET = "client-secret-test";
  process.env.ACTION1_ORG_ID = "00000000-0000-0000-0000-000000000001";
  resetConfigCache();
  const { buildServer } = await import("../../src/server.js");
  const { Client } = await import("@modelcontextprotocol/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/server");
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  SERVER = buildServer();
  await SERVER.server.connect(serverTx);
  CLIENT = new Client({ name: "usage-docs-test", version: "0.0.0" });
  await CLIENT.connect(clientTx);
}, 30_000);

afterAll(async () => {
  await CLIENT?.close();
  await SERVER?.server.close();
});

describe("docs/USAGE.md", () => {
  it("has a Conventions section", () => {
    expect(conventions).not.toBe("");
  });

  it("documents every curated tool and every one of its input parameters", async () => {
    const curated = curatedNames();
    expect(curated.size).toBeGreaterThan(0);
    const { tools } = await CLIENT.listTools();
    const missingTools: string[] = [];
    const missingParams: string[] = [];
    for (const tool of tools) {
      if (!curated.has(tool.name)) continue;
      const own = all.filter((s) => s.heading.includes(`\`${tool.name}\``));
      if (own.length === 0) {
        missingTools.push(tool.name);
        continue;
      }
      const text = own.map((s) => s.heading + "\n" + s.body).join("\n");
      const props = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      for (const p of props) {
        const named = new RegExp(`\\b${p}\\b`);
        if (!named.test(text) && !named.test(conventions)) missingParams.push(`${tool.name}.${p}`);
      }
    }
    expect(missingTools).toEqual([]);
    expect(missingParams).toEqual([]);
  });
});

/**
 * Top-level keys of every `"arguments": { ... }` object that follows a
 * `"tool": "<name>"` line in a Markdown file. Brace-aware, so nested
 * objects and arrays do not contribute keys.
 */
function exampleCalls(text: string): Array<{ tool: string; keys: string[] }> {
  const out: Array<{ tool: string; keys: string[] }> = [];
  const re = /"tool":\s*"(action1_[a-z0-9_]+)"[\s\S]*?"arguments":\s*\{/g;
  for (const m of text.matchAll(re)) {
    let depth = 1;
    let i = m.index + m[0].length;
    let inString = false;
    let token = "";
    const keys: string[] = [];
    for (; i < text.length && depth > 0; i++) {
      const ch = text[i]!;
      if (inString) {
        if (ch === "\\") {
          token += ch + (text[i + 1] ?? "");
          i++;
        } else if (ch === '"') {
          inString = false;
          if (depth === 1 && /^\s*:/.test(text.slice(i + 1))) keys.push(token);
        } else token += ch;
      } else if (ch === '"') {
        inString = true;
        token = "";
      } else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") depth--;
    }
    out.push({ tool: m[1]!, keys });
  }
  return out;
}

describe("tool call examples in the docs", () => {
  it("use only tools and arguments the server accepts", async () => {
    const { tools } = await CLIENT.listTools();
    const props = new Map(
      tools.map((t) => [
        t.name,
        Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}),
      ]),
    );
    const files = ["README.md", ...readdirSync(join(root, "docs")).map((f) => `docs/${f}`)].filter(
      (f) => f.endsWith(".md"),
    );
    const bad: string[] = [];
    let seen = 0;
    for (const file of files) {
      for (const call of exampleCalls(readFileSync(join(root, file), "utf8"))) {
        seen++;
        const known = props.get(call.tool);
        if (!known) {
          bad.push(`${file}: unknown tool ${call.tool}`);
          continue;
        }
        for (const k of call.keys) if (!known.includes(k)) bad.push(`${file}: ${call.tool}.${k}`);
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });
});
