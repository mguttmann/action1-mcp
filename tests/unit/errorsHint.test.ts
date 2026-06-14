import { describe, expect, it } from "vitest";
import { deriveHint } from "../../src/client/errors.js";

// `deriveHint(status, url)` is what turns a raw HTTP error code into a
// human/agent-readable suggestion. Pass-3 audit flagged that this lived
// untested. These cases pin the contract: every status code that the
// curated UX promises a hint for, returns one with the expected
// keywords.

describe("deriveHint", () => {
  it("returns a credentials/OAuth-flavoured hint on 401", () => {
    const hint = deriveHint(401, "https://app.eu.action1.test/api/3.0/orgs") ?? "";
    expect(hint.toLowerCase()).toMatch(/credentials|client_id|client_secret/);
  });

  it("returns a permission/scope-flavoured hint on 403 (generic)", () => {
    const hint = deriveHint(403, "https://app.eu.action1.test/api/3.0/orgs") ?? "";
    expect(hint.toLowerCase()).toMatch(/permission|scope|forbidden/);
  });

  it("returns a vulnerabilities-specific hint on 403 with /vulnerabilities URL", () => {
    const hint =
      deriveHint(403, "https://app.eu.action1.test/api/3.0/vulnerabilities/o1") ?? "";
    expect(hint.toLowerCase()).toContain("vulnerabilities");
    expect(hint.toLowerCase()).toMatch(/scope|permission|role/);
  });

  it("returns a not-found / wrong-id hint on 404", () => {
    const hint = deriveHint(404, "https://app.eu.action1.test/api/3.0/x") ?? "";
    expect(hint.toLowerCase()).toMatch(/not found|verify .*id|wrong/);
  });

  it("returns a rate-limit hint on 429", () => {
    const hint = deriveHint(429, "https://app.eu.action1.test/api/3.0/x") ?? "";
    expect(hint.toLowerCase()).toContain("rate");
    expect(hint.toLowerCase()).toMatch(/limit|retry|backoff/);
  });

  it("returns a server / retry hint on 500", () => {
    const hint = deriveHint(500, "https://app.eu.action1.test/api/3.0/x") ?? "";
    expect(hint.toLowerCase()).toMatch(/server|service|retry|upstream/);
  });

  it("returns a server / retry hint on 502", () => {
    const hint = deriveHint(502, "https://app.eu.action1.test/api/3.0/x") ?? "";
    expect(hint.toLowerCase()).toMatch(/server|service|retry|upstream/);
  });

  it("returns a server / retry hint on 503", () => {
    const hint = deriveHint(503, "https://app.eu.action1.test/api/3.0/x") ?? "";
    expect(hint.toLowerCase()).toMatch(/server|service|retry|upstream/);
  });

  it("returns undefined for unknown / unmapped codes", () => {
    // 418 isn't in the explicit table — current impl returns undefined.
    expect(deriveHint(418, "https://app.eu.action1.test/api/3.0/x")).toBeUndefined();
    // 2xx success codes also have no hint.
    expect(deriveHint(204, "https://app.eu.action1.test/api/3.0/x")).toBeUndefined();
  });

  it("returns a validation-flavoured hint on 400", () => {
    const hint = deriveHint(400, "https://app.eu.action1.test/api/3.0/x") ?? "";
    expect(hint.toLowerCase()).toMatch(/validation|schema|body|input/);
  });

  it("returns a conflict-flavoured hint on 409", () => {
    const hint = deriveHint(409, "https://app.eu.action1.test/api/3.0/x") ?? "";
    expect(hint.toLowerCase()).toMatch(/conflict|re-?read|retry/);
  });

  it("returns a validation-flavoured hint on 422", () => {
    const hint = deriveHint(422, "https://app.eu.action1.test/api/3.0/x") ?? "";
    expect(hint.toLowerCase()).toMatch(/validation|invalid/);
  });

  it("returns automations-specific hint on 403 with /automations URL", () => {
    const hint = deriveHint(403, "https://app.eu.action1.test/api/3.0/automations/x") ?? "";
    expect(hint.toLowerCase()).toContain("automations");
  });

  it("returns endpoints-specific hint on 403 with /endpoints URL", () => {
    const hint = deriveHint(403, "https://app.eu.action1.test/api/3.0/endpoints/managed/o1") ?? "";
    expect(hint.toLowerCase()).toContain("endpoints");
  });

  it("returns audit-specific hint on 403 with /audit URL", () => {
    const hint = deriveHint(403, "https://app.eu.action1.test/api/3.0/audit/events") ?? "";
    expect(hint.toLowerCase()).toContain("audit");
  });
});
