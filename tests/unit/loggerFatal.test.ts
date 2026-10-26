import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { logFatal } from "../../src/utils/logger.js";
import { runWithRequestContext } from "../../src/utils/requestContext.js";
import { log } from "../../src/utils/logger.js";

// The last line of a crashed process must be a parseable JSON record:
// DEPLOYMENT.md tells operators to alert on JSON log events.

const root = fileURLToPath(new URL("../..", import.meta.url));

describe("fatal path", () => {
  it("logFatal writes one critical JSON line with a redacted error", () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
      writes.push(String(c));
      return true;
    });
    try {
      logFatal("fatal", new Error("boom Bearer abc.def.ghi"));
    } finally {
      spy.mockRestore();
    }
    expect(writes).toHaveLength(1);
    const rec = JSON.parse(writes[0]!) as {
      level: string;
      msg: string;
      meta: { error: { message: string } };
    };
    expect(rec.level).toBe("critical");
    expect(rec.msg).toBe("fatal");
    expect(rec.meta.error.message).toContain("boom");
    expect(rec.meta.error.message).not.toContain("abc.def.ghi");
  });

  it("a start-up failure of the real entry point ends with a JSON line on stderr", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(r.status).toBe(1);
    const lines = r.stderr.split("\n").filter((l) => l.trim());
    const last = JSON.parse(lines[lines.length - 1]!) as {
      level: string;
      msg: string;
      meta: { error: { message: string } };
    };
    expect(last.level).toBe("critical");
    expect(last.msg).toBe("fatal");
    expect(last.meta.error.message).toContain("ACTION1_BASE_URL");
  }, 40_000);
});

describe("correlation id", () => {
  it("lines written inside a tool call carry its request_id, lines outside do not", () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
      writes.push(String(c));
      return true;
    });
    let id = "";
    try {
      runWithRequestContext("action1_x", (ctx) => {
        id = ctx.requestId;
        log.warn("inside");
      });
      log.warn("outside");
    } finally {
      spy.mockRestore();
    }
    const [inside, outside] = writes.map((w) => JSON.parse(w) as { request_id?: string });
    expect(inside!.request_id).toBe(id);
    expect(outside!.request_id).toBeUndefined();
  });
});
