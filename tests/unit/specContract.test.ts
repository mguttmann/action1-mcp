import { describe, expect, it } from "vitest";
import {
  enumValues,
  propertyNames,
  resolveContract,
  resolvePath,
  SPEC_FIELD_SOURCES,
} from "../../src/codegen/specContract.js";
import { SPEC_ENUMS, SPEC_FIELDS } from "../../src/spec/generated.js";
import {
  auditEventView,
  automationOutcome,
  endpointRebootRequired,
  endpointSearchValues,
  installedSoftwareName,
  isTerminalAutomationStatus,
  rebootRequiredQueryValue,
  scheduleInactive,
  SPEC_USAGE,
  vulnerabilityPackages,
  vulnerableEndpointId,
} from "../../src/spec/entities.js";
import { action1TimeSchema, parseAction1Time, toAction1Time } from "../../src/spec/time.js";
import { SPEC, specExample } from "../helpers/specFixtures.js";

// The curated tools read Action1 records through src/spec/entities.ts.
// Every spec field and enum value those readers use is recorded in
// SPEC_USAGE; this file checks each one against components.schemas of
// the vendored openapi.json, so a spec refresh that renames a field or
// changes an enum fails here instead of producing silently wrong tool
// output.

const sourceOf = (entity: string) => SPEC_FIELD_SOURCES.find((s) => s.name === entity);

describe("spec contract of the curated tools", () => {
  it("records a non-trivial set of fields and enum values", () => {
    expect(SPEC_USAGE.filter((u) => u.kind === "field").length).toBeGreaterThan(10);
    expect(SPEC_USAGE.filter((u) => u.kind === "enum").length).toBeGreaterThan(3);
  });

  it("every field a reader uses exists in components.schemas", () => {
    const missing: string[] = [];
    for (const u of SPEC_USAGE.filter((x) => x.kind === "field")) {
      const src = sourceOf(u.name);
      if (!src) {
        missing.push(`${u.name} (no contract source)`);
        continue;
      }
      const names = propertyNames(resolvePath(SPEC, src.schema, src.path));
      if (!names.includes(u.value))
        missing.push(`${src.schema}.${[...src.path, u.value].join(".")}`);
    }
    expect(missing).toEqual([]);
  });

  it("every enum value a reader uses exists in components.schemas", () => {
    const resolved = resolveContract(SPEC).enums;
    const missing = SPEC_USAGE.filter((u) => u.kind === "enum")
      .filter((u) => !(resolved[u.name] ?? []).includes(u.value))
      .map((u) => `${u.name}=${u.value}`);
    expect(missing).toEqual([]);
  });

  it("src/spec/generated.ts matches the spec (run npm run codegen after a spec change)", () => {
    const fresh = resolveContract(SPEC);
    expect(SPEC_ENUMS).toEqual(fresh.enums);
    expect(SPEC_FIELDS).toEqual(fresh.fields);
  });

  it("a path that is not in the spec fails resolution", () => {
    expect(() => resolvePath(SPEC, "AuditEvent", ["no_such_field"])).toThrow(/does not resolve/);
    expect(() => resolvePath(SPEC, "NoSuchSchema", [])).toThrow(/does not exist/);
  });

  it("merges allOf parts, so composed entities expose inherited and nested fields", () => {
    const fields = propertyNames(resolvePath(SPEC, "InstalledSoftwareEndpoints", ["fields"]));
    expect(fields).toEqual(expect.arrayContaining(["Name", "Vendor", "Install Location"]));
    expect(enumValues(resolvePath(SPEC, "Endpoint", ["reboot_required"]))).toEqual(["Yes", "No"]);
  });
});

describe("readers accept the spec shape and the previously assumed shape", () => {
  it("automation status: spec enum including Warning, legacy Failed/Canceled", () => {
    expect(SPEC_ENUMS.AutomationInstanceStatus.filter(isTerminalAutomationStatus)).toEqual([
      "Stopped",
      "Success",
      "Warning",
      "Error",
    ]);
    expect(isTerminalAutomationStatus("Pending")).toBe(false);
    expect(isTerminalAutomationStatus("Running")).toBe(false);
    expect(isTerminalAutomationStatus("warning")).toBe(true);
    expect(automationOutcome("Failed")).toBe("failure");
    expect(automationOutcome("Canceled")).toBe("failure");
    expect(automationOutcome("Something new")).toBeUndefined();
    expect(isTerminalAutomationStatus(undefined)).toBe(false);
  });

  it("reboot_required: Yes/No from the spec, yes/true from before", () => {
    expect(endpointRebootRequired(specExample("Endpoint", { reboot_required: "Yes" }))).toBe(true);
    expect(endpointRebootRequired(specExample("Endpoint", { reboot_required: "No" }))).toBe(false);
    expect(endpointRebootRequired({ reboot_required: "yes" })).toBe(true);
    expect(endpointRebootRequired({ reboot_required: true })).toBe(true);
    expect(endpointRebootRequired({})).toBe(false);
    expect(rebootRequiredQueryValue("yes")).toBe("Yes");
    expect(rebootRequiredQueryValue("NO")).toBe("No");
  });

  it("endpoint search values: spec name/device_name/user/OS, legacy hostname and OS objects", () => {
    const spec = specExample("Endpoint", { name: "conf-room", user: "CORP\\bob" });
    expect(endpointSearchValues(spec, new Set(["hostname"]))).toContain("conf-room");
    expect(endpointSearchValues(spec, new Set(["user"]))).toEqual(["CORP\\bob"]);
    expect(endpointSearchValues({ hostname: "legacy-host" }, new Set(["hostname"]))).toEqual([
      "legacy-host",
    ]);
    expect(endpointSearchValues({ operating_system: { name: "Ubuntu" } }, new Set(["os"]))).toEqual(
      ["Ubuntu"],
    );
  });

  it("installed software name: fields.Name first, legacy top-level names after", () => {
    expect(installedSoftwareName(specExample("InstalledSoftwareEndpoints"))).toBe(
      "Microsoft Teams",
    );
    expect(installedSoftwareName({ display_name: "Legacy" })).toBe("Legacy");
    expect(installedSoftwareName({})).toBeUndefined();
  });

  it("vulnerable endpoint id: endpoint_id, legacy id", () => {
    expect(vulnerableEndpointId(specExample("VulnerableEndpoint", { endpoint_id: "e1" }))).toBe(
      "e1",
    );
    expect(vulnerableEndpointId({ id: "e2" })).toBe("e2");
  });

  it("vulnerability packages come from software[].available_updates", () => {
    const row = specExample("Vulnerability", {
      software: [
        { available_updates: [{ package_id: "p1", version: "1.0", version_id: "x" }] },
        { available_updates: [{ package_id: "p2" }, { version: "no id" }] },
      ],
    });
    expect(vulnerabilityPackages(row)).toEqual([{ id: "p1", version: "1.0" }, { id: "p2" }]);
    expect(vulnerabilityPackages({})).toEqual([]);
  });

  it("audit event view: spec user_name/event/object_name/timestamp and legacy names", () => {
    const spec = auditEventView(specExample("AuditEvent"));
    expect(spec.timestamp).toBe("2022-08-29_12-22-11");
    expect(spec.users).toEqual(["John"]);
    expect(spec.events).toEqual(["POST"]);
    expect(spec.targets).toContain("API");
    const legacy = auditEventView({
      time: "2026-01-01T00:00:00Z",
      user: "u",
      event_type: "login",
      target: "t",
    });
    expect(legacy).toEqual({
      timestamp: "2026-01-01T00:00:00Z",
      users: ["u"],
      events: ["login"],
      targets: ["t"],
    });
  });

  it("schedule activity: spec settings DISABLED, legacy status Paused", () => {
    expect(scheduleInactive(specExample("AutomationSchedule", { settings: "DISABLED ONCE" }))).toBe(
      true,
    );
    expect(scheduleInactive(specExample("AutomationSchedule"))).toBe(false);
    expect(scheduleInactive({ status: "Paused" })).toBe(true);
  });
});

describe("Action1 time format", () => {
  it("parses both formats to the same instant and formats for upstream", () => {
    expect(parseAction1Time("2026-10-01_12-30-00")).toBe(Date.parse("2026-10-01T12:30:00Z"));
    expect(toAction1Time("2026-10-01T12:30:00Z")).toBe("2026-10-01_12-30-00");
    expect(toAction1Time("2026-10-01T14:30:00+02:00")).toBe("2026-10-01_12-30-00");
    expect(toAction1Time("2026-10-01_12-30-00")).toBe("2026-10-01_12-30-00");
    expect(toAction1Time("nope")).toBeUndefined();
  });

  it("the input schema accepts both formats and rejects others", () => {
    expect(action1TimeSchema.safeParse("2026-10-01_00-00-00").success).toBe(true);
    expect(action1TimeSchema.safeParse("2026-10-01T00:00:00Z").success).toBe(true);
    expect(action1TimeSchema.safeParse("2026-10-01").success).toBe(false);
    expect(action1TimeSchema.safeParse("yesterday").success).toBe(false);
  });
});
