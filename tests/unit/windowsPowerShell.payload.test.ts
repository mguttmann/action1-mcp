import { describe, expect, it } from "vitest";
import { buildWindowsPowerShellPayload } from "../../src/payloads/windowsPowerShell.js";

describe("buildWindowsPowerShellPayload", () => {
  it("always sets success_exit_codes to a non-empty value", () => {
    const p = buildWindowsPowerShellPayload({ endpointId: "ep", scriptText: "Get-Date" });
    const params = p.actions[0]!.params;
    expect(params.success_exit_codes).toBe("0");
    expect(params.script_text).toBe("Get-Date");
    expect(params.timeout_minutes).toBe("10");
    expect(p.actions[0]!.template_id).toBe("run_powershell");
  });

  it("honors explicit success_exit_codes override", () => {
    const p = buildWindowsPowerShellPayload({
      endpointId: "ep",
      scriptText: "x",
      successExitCodes: "0,1,3010",
    });
    expect(p.actions[0]!.params.success_exit_codes).toBe("0,1,3010");
  });

  it("rejects missing inputs", () => {
    expect(() => buildWindowsPowerShellPayload({ endpointId: "", scriptText: "x" })).toThrow();
    expect(() => buildWindowsPowerShellPayload({ endpointId: "ep", scriptText: "" })).toThrow();
  });
});
