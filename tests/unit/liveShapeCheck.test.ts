import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { specExample } from "../helpers/specFixtures.js";

// scripts/live-shape-check.mjs is run by the tenant owner against the
// live API. Here it only ever talks to a stubbed fetch: the test proves
// it sends GET requests only (plus the token request) and that the
// report carries key names and enum-like words, never record values or
// the ids it followed.

const mod = (await import("../../scripts/live-shape-check.mjs")) as {
  probes: () => { id: string; template: string }[];
  describeItems: (items: unknown[]) => {
    item_keys: string[];
    enum_values: Record<string, string[]>;
    time_formats: Record<string, string[]>;
  };
  run: (opts: { out: string; env: Record<string, string> }) => Promise<{ results: unknown[] }>;
};

const SECRET_NAME = "FINANCE-LAPTOP-07";
const SECRET_USER = "alice@corp.example";
const EP_ID = "11111111-2222-4333-8444-555555555555";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("live shape check", () => {
  it("describeItems reports keys, enum words and time formats, never values", () => {
    const ep = specExample("Endpoint", {
      id: EP_ID,
      name: SECRET_NAME,
      user: SECRET_USER,
      status: "Connected",
      reboot_required: "Yes",
      last_seen: "2026-10-26_08-15-00",
    });
    const d = mod.describeItems([ep]);
    expect(d.item_keys).toEqual(expect.arrayContaining(["id", "name", "reboot_required"]));
    expect(d.enum_values.status).toEqual(["Connected"]);
    expect(d.enum_values.reboot_required).toEqual(["Yes"]);
    expect(d.time_formats.last_seen).toEqual(["9999-99-99_99-99-99"]);
    const text = JSON.stringify(d);
    for (const secret of [SECRET_NAME, SECRET_USER, EP_ID, "2026-10-26"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("run sends only GET requests after the token request and writes an anonymized report", async () => {
    const calls: { method: string; url: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init: RequestInit = {}) => {
        const url = String(input);
        calls.push({ method: init.method ?? "GET", url });
        if (url.endsWith("/oauth2/token")) return Response.json({ access_token: "tkn" });
        const path = new URL(url).pathname.replace(/^\/api\/3\.0/, "");
        if (/^\/endpoints\/managed\/[^/]+$/.test(path)) {
          return Response.json({
            items: [specExample("Endpoint", { id: EP_ID, name: SECRET_NAME, user: SECRET_USER })],
            total_items: "1",
            next_page: "",
          });
        }
        if (path.endsWith(`/endpoints/managed/org-1/${EP_ID}`)) {
          return Response.json(specExample("Endpoint", { id: EP_ID, name: SECRET_NAME }));
        }
        if (path === "/audit/events") {
          return Response.json({
            items: [specExample("AuditEvent", { user_name: SECRET_USER })],
          });
        }
        return Response.json({ error: "forbidden" }, { status: 403 });
      }),
    );
    const out = join(mkdtempSync(join(tmpdir(), "live-shape-")), "report.json");
    await mod.run({
      out,
      env: {
        ACTION1_BASE_URL: "https://app.eu.action1.test/api/3.0",
        ACTION1_CLIENT_ID: "client-id-test",
        ACTION1_CLIENT_SECRET: "client-secret-test",
        ACTION1_ORG_ID: "org-1",
      },
    });
    const [tokenCall, ...rest] = calls;
    expect(tokenCall!.method).toBe("POST");
    expect(tokenCall!.url).toMatch(/\/oauth2\/token$/);
    expect(rest.length).toBeGreaterThan(5);
    expect(rest.every((c) => c.method === "GET")).toBe(true);
    const report = readFileSync(out, "utf8");
    for (const secret of [SECRET_NAME, SECRET_USER, EP_ID, "org-1", "client-secret-test", "tkn"]) {
      expect(report).not.toContain(secret);
    }
    const parsed = JSON.parse(report) as {
      results: { id: string; status?: number; spec?: { live_keys_not_in_spec: string[] } }[];
    };
    const endpoints = parsed.results.find((r) => r.id === "endpoints")!;
    expect(endpoints.status).toBe(200);
    expect(endpoints.spec!.live_keys_not_in_spec).toEqual([]);
    expect(parsed.results.find((r) => r.id === "endpoint")!.status).toBe(200);
  });

  it("the probe list covers the curated read paths with GET only", () => {
    const templates = mod.probes().map((p) => p.template);
    expect(templates).toEqual(
      expect.arrayContaining([
        "/audit/events",
        "/installed-software/{orgId}/data/{endpointId}",
        "/vulnerabilities/{orgId}/{cveId}/endpoints",
        "/automations/instances/{orgId}",
      ]),
    );
    const src = readFileSync(
      new URL("../../scripts/live-shape-check.mjs", import.meta.url),
      "utf8",
    );
    expect(src.match(/method: "(POST|PUT|PATCH|DELETE)"/g)).toEqual(['method: "POST"']);
  });
});
