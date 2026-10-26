import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync, zipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";

// scripts/reproducible-zip.mjs rewrites the archive `mcpb pack` writes
// so that the same staged files always give the same bytes: sorted
// entries, one timestamp (SOURCE_DATE_EPOCH, UTC), modes 0644/0755.
// Here two stagings with identical content but different file order,
// timestamps, permissions and time zone must produce identical archives.

const script = fileURLToPath(new URL("../../scripts/reproducible-zip.mjs", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "action1-repro-zip-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const FILES: Record<string, string> = {
  "manifest.json": '{"name":"x"}\n',
  "server/index.js": "#!/usr/bin/env node\nconsole.log(1);\n",
  "server/node_modules/a/package.json": '{"name":"a"}\n',
  "server/node_modules/.bin/a": "#!/bin/sh\n",
  LICENSE: "MIT\n",
};
const EXECUTABLE = new Set(["server/node_modules/.bin/a"]);
const EPOCH = 1_761_500_000; // 2025-10-26T17:33:20Z

/** Stage FILES in `order`, with per-run modes and mtimes, and zip it like `mcpb pack`. */
function stageAndPack(
  name: string,
  order: string[],
  fileMode: number,
  execMode: number,
  mtime: number,
) {
  const dir = join(work, name);
  const archive: Record<string, [Uint8Array, { os: number; attrs: number }]> = {};
  for (const rel of order) {
    const file = join(dir, rel);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, FILES[rel]!);
    const mode = EXECUTABLE.has(rel) ? execMode : fileMode;
    chmodSync(file, mode);
    utimesSync(file, mtime, mtime);
    archive[rel] = [readFileSync(file), { os: 3, attrs: mode << 16 }];
  }
  const zip = join(work, `${name}.mcpb`);
  writeFileSync(zip, zipSync(archive, { level: 9, mtime: new Date(mtime * 1000) }));
  return { dir, zip };
}

function repack(zip: string, dir: string, tz: string) {
  execFileSync(process.execPath, [script, zip, dir], {
    env: { PATH: process.env.PATH ?? "", SOURCE_DATE_EPOCH: String(EPOCH), TZ: tz },
    stdio: "pipe",
  });
  return readFileSync(zip);
}

/** Central directory entries: name, external attributes, DOS date/time. */
function centralDirectory(buf: Buffer) {
  const out: Array<{ name: string; attrs: number; dosTime: number; dosDate: number }> = [];
  for (let i = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); i >= 0;) {
    const nameLen = buf.readUInt16LE(i + 28);
    const extraLen = buf.readUInt16LE(i + 30);
    const commentLen = buf.readUInt16LE(i + 32);
    out.push({
      name: buf.toString("utf8", i + 46, i + 46 + nameLen),
      attrs: buf.readUInt32LE(i + 38),
      dosTime: buf.readUInt16LE(i + 12),
      dosDate: buf.readUInt16LE(i + 14),
    });
    i += 46 + nameLen + extraLen + commentLen;
    if (buf.readUInt32LE(i) !== 0x02014b50) break;
  }
  return out;
}

describe("scripts/reproducible-zip.mjs", () => {
  const names = Object.keys(FILES);
  const a = stageAndPack("a", names, 0o644, 0o755, 1_700_000_000);
  const b = stageAndPack("b", [...names].reverse(), 0o664, 0o775, 1_750_000_000);
  const bytesA = repack(a.zip, a.dir, "UTC");
  const bytesB = repack(b.zip, b.dir, "Pacific/Chatham");

  it("produces identical bytes for identical content", () => {
    expect(bytesA.equals(bytesB)).toBe(true);
  });

  it("keeps every file and its content", () => {
    const files = unzipSync(bytesA);
    expect(Object.keys(files).sort()).toEqual([...names].sort());
    for (const [rel, text] of Object.entries(FILES)) {
      expect(Buffer.from(files[rel]!).toString("utf8"), rel).toBe(text);
    }
  });

  it("sorts entries, normalises modes and stamps SOURCE_DATE_EPOCH in UTC", () => {
    const entries = centralDirectory(bytesA);
    expect(entries.map((e) => e.name)).toEqual([...names].sort());
    const d = new Date(EPOCH * 1000);
    const dosDate =
      ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
    const dosTime = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
    for (const e of entries) {
      expect(e.attrs >>> 16, e.name).toBe(EXECUTABLE.has(e.name) ? 0o755 : 0o644);
      expect({ dosDate: e.dosDate, dosTime: e.dosTime }, e.name).toEqual({ dosDate, dosTime });
    }
  });

  it("refuses to run without SOURCE_DATE_EPOCH", () => {
    expect(() =>
      execFileSync(process.execPath, [script, a.zip, a.dir], {
        env: { PATH: process.env.PATH ?? "" },
        stdio: "pipe",
      }),
    ).toThrow(/SOURCE_DATE_EPOCH/);
  });
});
