#!/usr/bin/env node
// Rewrite a zip archive in place so that the same files always give the
// same bytes. `mcpb pack` stamps every entry with the current time and
// keeps the directory listing order and the file modes of the build
// machine; scripts/build-mcpb.sh runs this script on its output.
//
// Usage: SOURCE_DATE_EPOCH=<unix seconds> node scripts/reproducible-zip.mjs <archive> <source-dir>
//
// <source-dir> is the directory the archive was packed from; it supplies
// the file modes. The rewritten archive has
//   - the entries sorted by name,
//   - one timestamp for every entry: SOURCE_DATE_EPOCH, encoded in UTC,
//   - mode 0755 for files with any execute bit and 0644 otherwise,
//   - deflate level 9 from the pinned fflate devDependency (the same
//     library and level `mcpb pack` uses).
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { unzipSync, zipSync } from "fflate";

// fflate writes the DOS timestamp from local time.
process.env.TZ = "UTC";

const [archive, sourceDir] = process.argv.slice(2);
if (!archive || !sourceDir) {
  console.error("usage: SOURCE_DATE_EPOCH=<seconds> reproducible-zip.mjs <archive> <source-dir>");
  process.exit(2);
}
const epoch = process.env.SOURCE_DATE_EPOCH ?? "";
// The zip DOS timestamp covers 1980 to 2107.
if (!/^\d+$/.test(epoch) || Number(epoch) < 315_532_800) {
  console.error("error: SOURCE_DATE_EPOCH must be set to a unix timestamp (seconds) from 1980 on.");
  process.exit(2);
}
const mtime = new Date(Number(epoch) * 1000);

const files = unzipSync(readFileSync(archive));
const out = {};
for (const name of Object.keys(files).sort()) {
  // fflate takes the entries as object keys; an integer-like key would be
  // reordered by JavaScript and break the sort.
  if (/^(0|[1-9]\d*)$/.test(name)) throw new Error(`unsupported entry name: ${name}`);
  const mode = statSync(path.join(sourceDir, name)).mode & 0o111 ? 0o755 : 0o644;
  out[name] = [files[name], { os: 3, attrs: mode << 16 }];
}
writeFileSync(archive, zipSync(out, { level: 9, mtime }));
