import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../../src/config.js";

// Progress notifications and post-start error reporting of the two
// long-running workflow tools, driven end to end through an MCP client
// over an in-memory transport with a mocked Action1 upstream.

const ORG = "00000000-0000-0000-0000-000000000001";
const EP = "00000000-0000-4000-8000-0000000000e1";
const INSTANCE = "inst-42";

let SERVER: ReturnType<typeof import("../../src/server.js").buildServer>;
let CLIENT: import("@modelcontextprotocol/client").Client;

beforeAll(async () => {
  process.env.ACTION1_BASE_URL = "https://app.eu.action1.test/api/3.0";
  process.env.ACTION1_CLIENT_ID = "client-id-test";
  process.env.ACTION1_CLIENT_SECRET = "client-secret-test";
  process.env.ACTION1_ORG_ID = ORG;
  resetConfigCache();
  const { buildServer } = await import("../../src/server.js");
  const { Client } = await import("@modelcontextprotocol/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/server");
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  SERVER = buildServer();
  await SERVER.server.connect(serverTx);
  CLIENT = new Client({ name: "workflows-test", version: "0.0.0" }, { capabilities: {} });
  await CLIENT.connect(clientTx);
}, 30_000);

afterAll(async () => {
  if (CLIENT) await CLIENT.close();
  if (SERVER?.server) await SERVER.server.close();
});

afterEach(() => {
  delete process.env.ACTION1_ALLOW_DESTRUCTIVE;
  resetConfigCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Upstream: token, endpoint detail, start (POST), status polls served from
 * `statuses` (a Response is returned as is), and the output details call.
 */
function upstream(opts: { start?: () => Response; statuses: (string | Response)[] }): {
  calls: { method: string; url: string }[];
} {
  const calls: { method: string; url: string }[] = [];
  const statuses = [...opts.statuses];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      if (url.endsWith("/oauth2/token")) return json({ access_token: "tkn", expires_in: 3600 });
      calls.push({ method, url });
      if (url.endsWith(`/endpoints/managed/${ORG}/${EP}`)) {
        return json({ id: EP, name: "host", OS: "Windows 11", status: "Connected" });
      }
      if (method === "POST" && url.endsWith(`/policies/instances/${ORG}`)) {
        return opts.start ? opts.start() : json({ id: INSTANCE });
      }
      if (url.endsWith(`/endpoint-results/${EP}/details`)) {
        return json({ items: [] });
      }
      if (url.endsWith(`/automations/instances/${ORG}/${INSTANCE}`)) {
        const next = statuses.shift() ?? "Success";
        return typeof next === "string" ? json({ id: INSTANCE, status: next }) : next;
      }
      return json({ error: "no route" }, 404);
    }),
  );
  return { calls };
}

function executeArgs(): Record<string, unknown> {
  return {
    endpoint_id: EP,
    mode: "template",
    template_id: "tpl-1",
    skip_connectivity_check: true,
    poll_interval_seconds: 1,
    timeout_seconds: 30,
    confirm: "YES",
    dry_run: false,
  };
}

function text(result: { content: unknown }): string {
  return (result.content as { text: string }[])[0]!.text;
}

describe("action1_execute_and_wait", () => {
  it("sends a progress notification per poll when the client asks for progress", async () => {
    process.env.ACTION1_ALLOW_DESTRUCTIVE = "true";
    resetConfigCache();
    upstream({ statuses: ["Running", "Success"] });
    const progress: { progress: number; message?: string }[] = [];
    const result = await CLIENT.callTool(
      { name: "action1_execute_and_wait", arguments: executeArgs() },
      { onprogress: (p) => progress.push(p) },
    );
    expect(result.isError ?? false).toBe(false);
    // One "started" notification right after the start, then one per poll.
    expect(progress).toHaveLength(3);
    expect(progress[0]!.progress).toBeLessThan(progress[1]!.progress);
    expect(progress[1]!.progress).toBeLessThan(progress[2]!.progress);
    expect(progress[0]!.message).toContain(INSTANCE);
    expect(progress[0]!.message).toMatch(/started/i);
    expect(progress[1]!.message).toContain("Running");
    expect(progress[2]!.message).toContain("Success");
  });

  it("announces the instance id before the first status poll", async () => {
    process.env.ACTION1_ALLOW_DESTRUCTIVE = "true";
    resetConfigCache();
    const { calls } = upstream({ statuses: ["Success"] });
    const seen: { message?: string; pollsSoFar: number }[] = [];
    const polls = (): number =>
      calls.filter((c) => c.url.endsWith(`/automations/instances/${ORG}/${INSTANCE}`)).length;
    await CLIENT.callTool(
      { name: "action1_execute_and_wait", arguments: executeArgs() },
      { onprogress: (p) => seen.push({ message: p.message, pollsSoFar: polls() }) },
    );
    expect(seen[0]!.message).toContain(INSTANCE);
    expect(seen[0]!.pollsSoFar).toBe(0);
  });

  it("logs action_started with the instance id right after the start", async () => {
    process.env.ACTION1_ALLOW_DESTRUCTIVE = "true";
    resetConfigCache();
    upstream({ statuses: [json({ error: "nope" }, 404)] });
    const lines: Record<string, unknown>[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      for (const line of String(chunk).split("\n")) {
        if (line.trim()) lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      return true;
    });
    await CLIENT.callTool({ name: "action1_execute_and_wait", arguments: executeArgs() });
    const started = lines.find((l) => l.msg === "action_started");
    expect(started?.meta).toMatchObject({
      tool: "action1_execute_and_wait",
      instance_id: INSTANCE,
    });
  });

  it("reports the instance id and warns against re-running when polling fails after the start", async () => {
    process.env.ACTION1_ALLOW_DESTRUCTIVE = "true";
    resetConfigCache();
    const { calls } = upstream({ statuses: [json({ error: "nope" }, 404)] });
    const result = await CLIENT.callTool({
      name: "action1_execute_and_wait",
      arguments: executeArgs(),
    });
    expect(result.isError).toBe(true);
    const msg = text(result);
    expect(msg).toContain(INSTANCE);
    expect(msg).toContain("action1_wait_for_automation");
    expect(msg).toMatch(/do not re-run/i);
    expect(msg).not.toMatch(/retry with a longer timeout/i);
    // Exactly one start request: nothing re-ran the action.
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("redacts the raw start response when it carries no instance id", async () => {
    process.env.ACTION1_ALLOW_DESTRUCTIVE = "true";
    resetConfigCache();
    upstream({
      start: () => json({ note: "weird", client_secret: "supersecretvalue123" }),
      statuses: [],
    });
    const result = await CLIENT.callTool({
      name: "action1_execute_and_wait",
      arguments: executeArgs(),
    });
    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain("supersecretvalue123");
    expect(text(result)).toMatch(/do not re-run/i);
  });

  it("masks personal data in the raw start response under ACTION1_REDACT_PII", async () => {
    process.env.ACTION1_ALLOW_DESTRUCTIVE = "true";
    process.env.ACTION1_REDACT_PII = "true";
    resetConfigCache();
    try {
      upstream({ start: () => json({ note: "weird", user_name: "alice.private" }), statuses: [] });
      const result = await CLIENT.callTool({
        name: "action1_execute_and_wait",
        arguments: executeArgs(),
      });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("weird");
      expect(text(result)).not.toContain("alice.private");
    } finally {
      delete process.env.ACTION1_REDACT_PII;
    }
  });

  it("reports a rejected start (4xx) with the masked upstream body and without 'may have started'", async () => {
    process.env.ACTION1_ALLOW_DESTRUCTIVE = "true";
    process.env.ACTION1_REDACT_PII = "true";
    resetConfigCache();
    try {
      upstream({
        start: () => json({ message: "template tpl-1 not found", user_name: "alice.private" }, 400),
        statuses: [],
      });
      const result = await CLIENT.callTool({
        name: "action1_execute_and_wait",
        arguments: executeArgs(),
      });
      expect(result.isError).toBe(true);
      const msg = text(result);
      expect(msg).toContain("HTTP 400");
      expect(msg).toContain("template tpl-1 not found");
      expect(msg).not.toContain("alice.private");
      expect(msg).not.toMatch(/may have started/i);
    } finally {
      delete process.env.ACTION1_REDACT_PII;
    }
  });

  it("keeps the 'may have started' note for a 5xx start error, with the upstream body", async () => {
    process.env.ACTION1_ALLOW_DESTRUCTIVE = "true";
    resetConfigCache();
    const { calls } = upstream({
      start: () => json({ message: "upstream exploded" }, 502),
      statuses: [],
    });
    const result = await CLIENT.callTool({
      name: "action1_execute_and_wait",
      arguments: executeArgs(),
    });
    expect(result.isError).toBe(true);
    const msg = text(result);
    expect(msg).toContain("HTTP 502");
    expect(msg).toContain("upstream exploded");
    expect(msg).toMatch(/may have started/i);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
});

describe("action1_wait_for_automation", () => {
  it("sends a progress notification per poll", async () => {
    upstream({ statuses: ["Running", "Running", "Success"] });
    const progress: { progress: number }[] = [];
    const result = await CLIENT.callTool(
      {
        name: "action1_wait_for_automation",
        arguments: { instance_id: INSTANCE, poll_interval_seconds: 1, timeout_seconds: 30 },
      },
      { onprogress: (p) => progress.push(p) },
    );
    expect(result.isError ?? false).toBe(false);
    expect(progress.map((p) => p.progress)).toEqual([1, 2, 3]);
  });

  it("names the instance id when polling fails", async () => {
    upstream({ statuses: [json({ error: "nope" }, 404)] });
    const result = await CLIENT.callTool({
      name: "action1_wait_for_automation",
      arguments: { instance_id: INSTANCE, poll_interval_seconds: 1, timeout_seconds: 30 },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(INSTANCE);
  });
});
