import { describe, expect, it } from "vitest";
import { buildMacOsBashPayload } from "../../src/payloads/macOsBash.js";

describe("buildMacOsBashPayload", () => {
  it("emits all 10 mandatory params required by /automations/instances on macOS", () => {
    const p = buildMacOsBashPayload({
      endpointId: "ep-001",
      scriptText: "echo hello",
    });

    expect(p.endpoints).toEqual([{ id: "ep-001", type: "Endpoint" }]);
    expect(p.actions).toHaveLength(1);
    const action = p.actions[0]!;
    expect(action.template_id).toBe("run_script");
    expect(action.name).toBe("Run Script");

    const params = action.params;
    expect(params.run_script_text).toBe("echo hello");
    expect(params.run_script_language).toBe("Bash");
    expect(params.platform).toBe("Mac");
    expect(params.display_summary).toBe("");
    expect(params.condition_script_text).toBe("");
    expect(params.condition_script_file_name).toBe("");
    expect(params.condition_script_language).toBe("Bash");
    expect(params.run_script_params).toEqual([]);
    expect(params.run_script_file_name).toBe("");
    expect(params.reboot_exit_codes).toBe("");
    expect(params.reboot_options).toEqual({ auto_reboot: "no" });
  });

  it("uses string retry_minutes (not number) per API contract", () => {
    const p = buildMacOsBashPayload({ endpointId: "ep-001", scriptText: "x" });
    expect(typeof p.retry_minutes).toBe("string");
    expect(p.retry_minutes).toBe("1440");
  });

  it("accepts an explicit name override", () => {
    const p = buildMacOsBashPayload({
      endpointId: "ep-001",
      scriptText: "x",
      name: "custom-name",
    });
    expect(p.name).toBe("custom-name");
  });

  it("rejects empty endpointId or scriptText", () => {
    expect(() => buildMacOsBashPayload({ endpointId: "", scriptText: "x" })).toThrow();
    expect(() => buildMacOsBashPayload({ endpointId: "ep", scriptText: "" })).toThrow();
  });
});
