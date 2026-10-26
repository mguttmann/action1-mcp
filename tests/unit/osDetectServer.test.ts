import { describe, expect, it } from "vitest";
import { detectPlatform } from "../../src/utils/osDetect.js";

// Bare "Server 20xx" SKUs (without the "Windows"
// prefix) are common in Action1's `os_name` column for server-class
// endpoints and used to fall through to "unknown", breaking the
// PowerShell auto-route in execute_and_wait.

describe("detectPlatform - Windows Server SKU coverage", () => {
  it("matches bare 'Server 20xx' as Windows", () => {
    expect(detectPlatform({ os: "Server 2022" })).toBe("windows");
    expect(detectPlatform({ os: "Server 2019 Standard" })).toBe("windows");
    expect(detectPlatform({ os: "Server 2025 Datacenter" })).toBe("windows");
  });

  it("matches the explicit 'Windows Server' phrasing", () => {
    expect(detectPlatform({ os: "Windows Server 2022" })).toBe("windows");
    expect(detectPlatform({ OS: "Windows Server 2025 Standard" })).toBe("windows");
  });

  it("still ignores non-Windows products that happen to contain 'server'", () => {
    // SQL Server-style strings shouldn't accidentally route to
    // Windows when paired with a non-Windows OS hint.
    expect(detectPlatform({ os: "Ubuntu Server 22.04" })).toBe("linux");
  });
});
