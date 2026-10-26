#!/usr/bin/env node
// Capture the public MCP surface (tools, resources, resource templates,
// prompts) of the BUILT server over stdio, using raw newline-delimited
// JSON-RPC so the script does not depend on any MCP SDK version.
//
// Usage:
//   node scripts/tools-list-snapshot.mjs                 print snapshot to stdout
//   node scripts/tools-list-snapshot.mjs --write <file>  write snapshot to <file>
//   node scripts/tools-list-snapshot.mjs --check <file>  exit 1 if the snapshot differs
//   --protocol-version <v>  protocolVersion sent in initialize (default 2025-06-18)
//   --entry <file>          server entry to start (default dist/index.js); the
//                           E2E tests point it at the unpacked MCPB bundle
//
// The server is started with dummy credentials pointing at
// https://127.0.0.1:1/api/3.0, so no real Action1 API is ever reached.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const protocolVersion = opt("--protocol-version") ?? "2025-06-18";

const entry = path.resolve(root, opt("--entry") ?? "dist/index.js");

const child = spawn(process.execPath, [entry], {
  cwd: path.dirname(entry),
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    PATH: process.env.PATH ?? "",
    ACTION1_BASE_URL: "https://127.0.0.1:1/api/3.0",
    ACTION1_CLIENT_ID: "dummy-client-id",
    ACTION1_CLIENT_SECRET: "dummy-client-secret",
    ACTION1_ORG_ID: "00000000-0000-0000-0000-000000000000",
    ACTION1_LOG_LEVEL: "error",
  },
});

let stderr = "";
child.stderr.on("data", (d) => (stderr += d.toString()));
const pending = new Map();
let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`timeout waiting for ${method}\n${stderr}`)),
      20_000,
    );
    pending.set(id, (msg) => {
      clearTimeout(t);
      if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    });
  });
}

async function listAll(method, key) {
  const out = [];
  let cursor;
  do {
    const res = await request(method, cursor ? { cursor } : {});
    out.push(...res[key]);
    cursor = res.nextCursor;
  } while (cursor);
  return out;
}

const sortKeys = (v) =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sortKeys(v[k])]),
        )
      : v;

try {
  const init = await request("initialize", {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "tools-list-snapshot", version: "1.0.0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const tools = await listAll("tools/list", "tools");
  const resources = await listAll("resources/list", "resources");
  const templates = await listAll("resources/templates/list", "resourceTemplates");
  const prompts = await listAll("prompts/list", "prompts");

  const snapshot = {
    tools: tools
      .map((t) => ({
        name: t.name,
        inputProperties: Object.keys(t.inputSchema?.properties ?? {}).sort(),
        required: [...(t.inputSchema?.required ?? [])].sort(),
        annotations: sortKeys(t.annotations ?? {}),
        hasOutputSchema: t.outputSchema !== undefined,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    resources: resources.map((r) => r.uri).sort(),
    resourceTemplates: templates.map((r) => r.uriTemplate).sort(),
    prompts: prompts
      .map((p) => ({ name: p.name, arguments: (p.arguments ?? []).map((a) => a.name).sort() }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
  const text = JSON.stringify(snapshot, null, 2) + "\n";

  if (opt("--write")) {
    writeFileSync(opt("--write"), text);
    process.stderr.write(
      `wrote ${snapshot.tools.length} tools (negotiated protocol ${init.protocolVersion}) to ${opt("--write")}\n`,
    );
  } else if (opt("--check")) {
    const expected = JSON.parse(readFileSync(opt("--check"), "utf8"));
    if (JSON.stringify(expected) !== JSON.stringify(snapshot)) {
      process.stderr.write(`snapshot differs from ${opt("--check")}\n`);
      process.stdout.write(text);
      process.exitCode = 1;
    } else {
      process.stderr.write(
        `snapshot matches ${opt("--check")} (${snapshot.tools.length} tools, negotiated protocol ${init.protocolVersion})\n`,
      );
    }
  } else {
    process.stdout.write(text);
  }
} finally {
  child.kill();
}
