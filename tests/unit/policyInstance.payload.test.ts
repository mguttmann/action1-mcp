import { describe, expect, it } from "vitest";
import { buildSimplePolicyPayload } from "../../src/payloads/policyInstance.js";

describe("buildSimplePolicyPayload", () => {
  it("wraps a template_id with the standard envelope", () => {
    const p = buildSimplePolicyPayload({
      endpointId: "ep",
      templateId: "reboot",
    });
    expect(p.actions[0]!.template_id).toBe("reboot");
    expect(p.endpoints).toEqual([{ id: "ep", type: "Endpoint" }]);
    expect(p.actions[0]!.params).toEqual({});
  });

  it("forwards params untouched", () => {
    const p = buildSimplePolicyPayload({
      endpointId: "ep",
      templateId: "deploy_update",
      params: { updates: ["pkg-1"] },
    });
    expect(p.actions[0]!.params).toEqual({ updates: ["pkg-1"] });
  });
});
