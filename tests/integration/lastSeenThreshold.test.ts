import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../../src/config.js";
import { TEST_ORG, connectHarness, setSweepEnv, type Harness } from "../helpers/mcpHarness.js";

// ACTION1_LAST_SEEN_STALE_MINUTES decides when a Connected endpoint
// counts as offline, in the read tools as in the execution tools.

const EP = "00000000-0000-4000-8000-0000000000e1";
let H: Harness;

beforeAll(async () => {
  setSweepEnv({});
  H = await connectHarness("last-seen-threshold");
}, 30_000);

afterAll(async () => {
  await H?.close();
});

afterEach(() => {
  delete process.env.ACTION1_LAST_SEEN_STALE_MINUTES;
  resetConfigCache();
  vi.unstubAllGlobals();
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** One Connected endpoint last seen 30 minutes ago. */
function upstream(): void {
  const endpoint = {
    id: EP,
    name: "host",
    OS: "Windows 11",
    status: "Connected",
    last_seen: new Date(Date.now() - 30 * 60_000).toISOString(),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/oauth2/token")) return json({ access_token: "tkn", expires_in: 3600 });
      const path = new URL(url).pathname;
      if (path.endsWith(`/endpoints/managed/${TEST_ORG}/${EP}`)) return json(endpoint);
      if (path.endsWith(`/endpoints/managed/${TEST_ORG}`)) {
        return json({ items: [endpoint], total_items: 1 });
      }
      return new Response("{}", { status: 404 });
    }),
  );
}

describe.each([
  ["default threshold (10 minutes)", undefined, false],
  ["ACTION1_LAST_SEEN_STALE_MINUTES=60", "60", true],
])("read tools with the %s", (_label, minutes, online) => {
  it("action1_get_endpoint reports connectivity.online accordingly", async () => {
    if (minutes) process.env.ACTION1_LAST_SEEN_STALE_MINUTES = minutes;
    resetConfigCache();
    upstream();
    const r = await H.client.callTool({
      name: "action1_get_endpoint",
      arguments: { endpoint_id: EP, response_format: "json" },
    });
    expect(r.isError ?? false).toBe(false);
    const s = r.structuredContent as { connectivity: { online: boolean } };
    expect(s.connectivity.online).toBe(online);
  });

  it("action1_endpoints_summary counts the endpoint as fresh or stale accordingly", async () => {
    if (minutes) process.env.ACTION1_LAST_SEEN_STALE_MINUTES = minutes;
    resetConfigCache();
    upstream();
    const r = await H.client.callTool({
      name: "action1_endpoints_summary",
      arguments: { response_format: "json" },
    });
    expect(r.isError ?? false).toBe(false);
    const s = r.structuredContent as { fresh_last_seen: number; stale_last_seen: number };
    expect(s.fresh_last_seen).toBe(online ? 1 : 0);
    expect(s.stale_last_seen).toBe(online ? 0 : 1);
  });
});
