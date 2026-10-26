import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isEndpointActuallyOnline } from "../../src/utils/lastSeen.js";
import { loadConfig, resetConfigCache } from "../../src/config.js";

describe("isEndpointActuallyOnline", () => {
  it("returns offline when status is not connected", () => {
    const r = isEndpointActuallyOnline({ status: "Offline" });
    expect(r.online).toBe(false);
    expect(r.reason).toContain("Offline");
  });

  it("returns offline when last_seen is older than threshold", () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const r = isEndpointActuallyOnline({ status: "Connected", last_seen: past }, 10);
    expect(r.online).toBe(false);
    expect(r.reason).toContain("last_seen");
  });

  it("parses Action1's non-ISO last_seen format (yyyy-mm-dd_HH-MM-SS, UTC)", () => {
    const now = new Date();
    const fmt = (d: Date) => {
      const y = d.getUTCFullYear();
      const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
      const da = String(d.getUTCDate()).padStart(2, "0");
      const h = String(d.getUTCHours()).padStart(2, "0");
      const mi = String(d.getUTCMinutes()).padStart(2, "0");
      const s = String(d.getUTCSeconds()).padStart(2, "0");
      return `${y}-${mo}-${da}_${h}-${mi}-${s}`;
    };
    const fresh = fmt(new Date(now.getTime() - 60 * 1000));
    const stale = fmt(new Date(now.getTime() - 60 * 60 * 1000));
    expect(isEndpointActuallyOnline({ status: "Connected", last_seen: fresh }, 10).online).toBe(
      true,
    );
    expect(isEndpointActuallyOnline({ status: "Connected", last_seen: stale }, 10).online).toBe(
      false,
    );
  });

  it("returns online when status is connected and last_seen is fresh", () => {
    const recent = new Date(Date.now() - 60 * 1000).toISOString();
    const r = isEndpointActuallyOnline({ status: "Connected", last_seen: recent }, 10);
    expect(r.online).toBe(true);
  });

  it("returns online when status is connected and no last_seen is provided", () => {
    const r = isEndpointActuallyOnline({ status: "Connected" });
    expect(r.online).toBe(true);
  });

  it("returns offline for empty input", () => {
    expect(isEndpointActuallyOnline(null).online).toBe(false);
    expect(isEndpointActuallyOnline(undefined).online).toBe(false);
    expect(isEndpointActuallyOnline({}).online).toBe(false);
  });

  // The stale-after threshold used to be hardcoded to
  // 10 min, with no way to widen it on networks where endpoints check
  // in every 30+ minutes. The new env knob lets operators override
  // the default; the call-sites in execution.ts / workflows.ts read
  // `loadConfig().lastSeenStaleMinutes` and pass it through.

  describe("threshold override (callers pass the parsed config value)", () => {
    it("an endpoint 30min stale with a 60min threshold is still online", () => {
      const past = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const r = isEndpointActuallyOnline({ status: "Connected", last_seen: past }, 60);
      expect(r.online).toBe(true);
    });

    it("the same endpoint with the default 10min threshold is offline", () => {
      const past = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const r = isEndpointActuallyOnline({ status: "Connected", last_seen: past });
      expect(r.online).toBe(false);
    });
  });

  describe("ACTION1_LAST_SEEN_STALE_MINUTES env knob (via loadConfig)", () => {
    const ORIG_ENV: Record<string, string | undefined> = {};
    beforeEach(() => {
      // Snapshot any pre-existing values so concurrent tests survive.
      ORIG_ENV.ACTION1_LAST_SEEN_STALE_MINUTES = process.env.ACTION1_LAST_SEEN_STALE_MINUTES;
      ORIG_ENV.ACTION1_BASE_URL = process.env.ACTION1_BASE_URL;
      ORIG_ENV.ACTION1_CLIENT_ID = process.env.ACTION1_CLIENT_ID;
      ORIG_ENV.ACTION1_CLIENT_SECRET = process.env.ACTION1_CLIENT_SECRET;
      // loadConfig() requires the mandatory ACTION1_* vars even for an
      // optional-flag sanity test.
      process.env.ACTION1_BASE_URL = "https://app.eu.action1.test/api/3.0";
      process.env.ACTION1_CLIENT_ID = "client-id-test";
      process.env.ACTION1_CLIENT_SECRET = "client-secret-test";
      resetConfigCache();
    });
    afterEach(() => {
      for (const [k, v] of Object.entries(ORIG_ENV)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      resetConfigCache();
    });

    it("defaults to 10 when the env var is unset", () => {
      delete process.env.ACTION1_LAST_SEEN_STALE_MINUTES;
      resetConfigCache();
      expect(loadConfig().lastSeenStaleMinutes).toBe(10);
    });

    it("parses a valid override (45)", () => {
      process.env.ACTION1_LAST_SEEN_STALE_MINUTES = "45";
      resetConfigCache();
      expect(loadConfig().lastSeenStaleMinutes).toBe(45);
    });

    it("rejects a non-numeric override", () => {
      process.env.ACTION1_LAST_SEEN_STALE_MINUTES = "soon";
      resetConfigCache();
      expect(() => loadConfig()).toThrow(/integer/i);
    });

    it("rejects an out-of-range override (0)", () => {
      process.env.ACTION1_LAST_SEEN_STALE_MINUTES = "0";
      resetConfigCache();
      expect(() => loadConfig()).toThrow(/integer/i);
    });

    it("rejects an out-of-range override (above 1440)", () => {
      process.env.ACTION1_LAST_SEEN_STALE_MINUTES = "1441";
      resetConfigCache();
      expect(() => loadConfig()).toThrow(/integer/i);
    });

    it("end-to-end: setting the env to 60 then calling isEndpointActuallyOnline with the parsed value keeps a 30min-stale endpoint online", () => {
      process.env.ACTION1_LAST_SEEN_STALE_MINUTES = "60";
      resetConfigCache();
      const cfg = loadConfig();
      const past = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const r = isEndpointActuallyOnline(
        { status: "Connected", last_seen: past },
        cfg.lastSeenStaleMinutes,
      );
      expect(r.online).toBe(true);
    });
  });
});
