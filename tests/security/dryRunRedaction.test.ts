import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkDestructiveGuard } from "../../src/tools/destructiveGuard.js";
import { resetConfigCache } from "../../src/config.js";

// Defence-in-depth: a destructive-tool author who hardcodes a token
// inside the request body (Authorization header, client_secret,
// api-key-style identifier, or refresh_token field) must NOT see that
// token echoed back verbatim by the dry-run preview. The preview body
// is fed to the LLM context, so any leak there bypasses every other
// redaction layer.
//
// These tests pin the redaction so a refactor of `destructiveGuard.ts`
// that forgets to route `ctx.preview.body` through `redact()` fails
// loudly instead of silently shipping a secret-leak.

describe("destructiveGuard: dry_run preview redaction", () => {
  let oldEnv: string | undefined;
  let oldAuto: string | undefined;

  beforeAll(() => {
    // destructiveGuard now reads ACTION1_DESTRUCTIVE_AUTO_CONFIRM via
    // loadConfig() which Zod-validates the full env. Provide the
    // required Action1 client env vars so the cached config can build.
    // We don't make any real HTTP calls (these tests only exercise
    // the in-process dry-run branch), but the config still has to
    // parse.
    process.env.ACTION1_BASE_URL = "https://app.eu.action1.test/api/3.0";
    process.env.ACTION1_CLIENT_ID = "x";
    process.env.ACTION1_CLIENT_SECRET = "y";
    resetConfigCache();
  });
  afterAll(() => {
    delete process.env.ACTION1_BASE_URL;
    delete process.env.ACTION1_CLIENT_ID;
    delete process.env.ACTION1_CLIENT_SECRET;
    resetConfigCache();
  });

  beforeEach(() => {
    oldEnv = process.env.ACTION1_ALLOW_DESTRUCTIVE;
    oldAuto = process.env.ACTION1_DESTRUCTIVE_AUTO_CONFIRM;
  });
  afterEach(() => {
    if (oldEnv === undefined) delete process.env.ACTION1_ALLOW_DESTRUCTIVE;
    else process.env.ACTION1_ALLOW_DESTRUCTIVE = oldEnv;
    if (oldAuto === undefined) delete process.env.ACTION1_DESTRUCTIVE_AUTO_CONFIRM;
    else process.env.ACTION1_DESTRUCTIVE_AUTO_CONFIRM = oldAuto;
    resetConfigCache();
  });

  it("redacts secret-shaped keys (authorization) in dry_run preview body", () => {
    const ctx = {
      toolName: "action1_test",
      preview: {
        method: "POST",
        path: "/test",
        body: { authorization: "Bearer secret-token-1234567890" },
      },
    };
    const r = checkDestructiveGuard({}, ctx);
    expect(r).not.toBeNull();
    expect(r!.isError).toBeFalsy();

    const sc = r!.structuredContent as Record<string, unknown>;
    const wouldSend = sc.would_send as { body?: Record<string, unknown> };
    expect(wouldSend.body?.authorization).toBe("[REDACTED]");

    // Cross-check the text content too: the LLM sees that, not the
    // structuredContent, so the redaction MUST land in both.
    const text = (r!.content[0] as { text: string }).text;
    expect(text).not.toContain("secret-token-1234567890");
    expect(text).toContain("[REDACTED]");
  });

  it("redacts client_secret value inside a nested body", () => {
    const ctx = {
      toolName: "action1_test",
      preview: {
        method: "POST",
        path: "/test",
        body: {
          script_text: "echo hi",
          credentials: { client_secret: "32hex_abcdef_secret_value" },
        },
      },
    };
    const r = checkDestructiveGuard({}, ctx);
    const sc = r!.structuredContent as Record<string, unknown>;
    const wouldSend = sc.would_send as { body?: Record<string, unknown> };
    const creds = wouldSend.body?.credentials as Record<string, unknown>;
    expect(creds.client_secret).toBe("[REDACTED]");
    // Non-secret fields survive verbatim.
    expect(wouldSend.body?.script_text).toBe("echo hi");
  });

  it("redacts Bearer tokens embedded in a string field via value-pattern", () => {
    const ctx = {
      toolName: "action1_test",
      preview: {
        method: "POST",
        path: "/test",
        body: {
          // Not a secret-shaped *key*, but a Bearer-shaped *value*;
          // the value-pattern redactor must still catch it.
          script_text: "curl -H 'Authorization: Bearer abcdef1234567890' https://example.com",
        },
      },
    };
    const r = checkDestructiveGuard({}, ctx);
    const text = (r!.content[0] as { text: string }).text;
    expect(text).not.toContain("abcdef1234567890");
    expect(text).toContain("[REDACTED]");
  });

  it("is a no-op on plain Action1 payloads (no false-positives)", () => {
    // Sanity: normal payloads pass through untouched. If this fails
    // the redactor has grown a too-aggressive pattern that would
    // mangle real Action1 bodies.
    const ctx = {
      toolName: "action1_test",
      preview: {
        method: "POST",
        path: "/automations/instances/abc",
        body: {
          name: "Reboot workstations",
          target_type: "Endpoint",
          target_id: "00000000-0000-0000-0000-000000000000",
          actions: [{ type: "reboot" }],
        },
      },
    };
    const r = checkDestructiveGuard({}, ctx);
    const sc = r!.structuredContent as Record<string, unknown>;
    const wouldSend = sc.would_send as { body?: Record<string, unknown> };
    expect(wouldSend.body).toEqual({
      name: "Reboot workstations",
      target_type: "Endpoint",
      target_id: "00000000-0000-0000-0000-000000000000",
      actions: [{ type: "reboot" }],
    });
  });

  it("preserves method, path, and description fields in the preview", () => {
    const ctx = {
      toolName: "action1_test",
      preview: {
        method: "DELETE",
        path: "/endpoints/managed/orgA/epB",
        description: "Remove endpoint",
        body: { reason: "decommissioned" },
      },
    };
    const r = checkDestructiveGuard({}, ctx);
    const sc = r!.structuredContent as Record<string, unknown>;
    const wouldSend = sc.would_send as Record<string, unknown>;
    expect(wouldSend.method).toBe("DELETE");
    expect(wouldSend.path).toBe("/endpoints/managed/orgA/epB");
    expect(wouldSend.description).toBe("Remove endpoint");
  });
  it("shows every leaf of a deeply nested body (spec MatchingFilters deploy body)", () => {
    // POST /automations/instances with a deploy_update action whose
    // update filter sits at actions[].params.filters[].values[]: the
    // person confirming must see exactly what is sent.
    const body = {
      name: "Deploy critical updates",
      settings: "ENABLED",
      endpoints: [{ id: "00000000-0000-0000-0000-0000000000e1", type: "Endpoint" }],
      actions: [
        {
          name: "Deploy Update",
          template_id: "deploy_update",
          params: {
            filters: [
              { field: "severity", values: ["Critical", "Important"] },
              { field: "update_names", values: [{ name: "KB5031356", nested: { deep: ["x"] } }] },
            ],
            reboot_options: { auto_reboot: "yes", show_message: "yes", timeout: 240 },
          },
        },
      ],
    };
    const r = checkDestructiveGuard(
      {},
      {
        toolName: "action1_test",
        preview: { method: "POST", path: "/automations/instances/o", body },
      },
    );
    const sc = r!.structuredContent as Record<string, unknown>;
    const wouldSend = sc.would_send as { body?: unknown };
    expect(wouldSend.body).toEqual(body);
    const text = (r!.content[0] as { text: string }).text;
    expect(text).not.toContain("[truncated]");
    for (const leaf of ["Critical", "Important", "KB5031356", "update_names"]) {
      expect(text).toContain(leaf);
    }
  });

  it("still masks a secret-shaped key deep inside the body", () => {
    const body = { a: { b: { c: { d: { e: { f: { g: { password: "deep-secret-value" } } } } } } } };
    const r = checkDestructiveGuard(
      {},
      { toolName: "action1_test", preview: { method: "POST", path: "/x", body } },
    );
    const text = (r!.content[0] as { text: string }).text;
    expect(text).not.toContain("deep-secret-value");
    expect(text).not.toContain("[truncated]");
  });
});
