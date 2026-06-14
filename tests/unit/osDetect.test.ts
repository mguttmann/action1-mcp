import { describe, expect, it } from "vitest";
import { detectPlatform } from "../../src/utils/osDetect.js";

describe("detectPlatform", () => {
  it("recognizes Windows variants", () => {
    expect(detectPlatform({ os: "Windows 11 Pro" })).toBe("windows");
    expect(detectPlatform({ os: { name: "Windows Server 2022" } })).toBe("windows");
    expect(detectPlatform({ platform: "Win" })).toBe("windows");
  });

  it("recognizes macOS variants", () => {
    expect(detectPlatform({ os: "macOS Sonoma 14.7" })).toBe("macos");
    expect(detectPlatform({ os: "Mac OS X 10.15" })).toBe("macos");
    expect(detectPlatform({ os: { name: "Darwin" } })).toBe("macos");
  });

  it("recognizes Linux variants", () => {
    expect(detectPlatform({ os: "Ubuntu 22.04" })).toBe("linux");
    expect(detectPlatform({ os: "Linux generic" })).toBe("linux");
  });

  it("returns unknown when nothing matches", () => {
    expect(detectPlatform({ os: "TempleOS" })).toBe("unknown");
    expect(detectPlatform(null)).toBe("unknown");
    expect(detectPlatform({})).toBe("unknown");
  });

  it("matches Action1's uppercase OS field", () => {
    expect(detectPlatform({ OS: "Windows 11 (25H2)", platform: "Windows" })).toBe("windows");
    expect(detectPlatform({ OS: "macOS Sonoma 14.7.3 (23H417)", platform: "Mac" })).toBe("macos");
    expect(detectPlatform({ OS: "Windows 11" })).toBe("windows");
    expect(detectPlatform({ OS: "macOS Sonoma" })).toBe("macos");
  });
});
