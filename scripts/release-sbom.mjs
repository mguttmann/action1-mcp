#!/usr/bin/env node
// Write a CycloneDX SBOM of an installed runtime dependency tree.
//
// Usage: node scripts/release-sbom.mjs <dir> <application|library> <out-file>
//
// <dir> holds a package.json without devDependencies and the
// node_modules installed from the lockfile with `npm ci --omit=dev`:
// scripts/build-mcpb.sh prepares build/mcpb/server that way. The SBOM
// lists what is installed there (`npm sbom` reads node_modules), which
// is what the MCPB bundle ships and the runtime tree the npm package was
// tested with. `npm sbom --omit=dev --package-lock-only` on the repository
// is not used: it leaves out runtime packages that dev tools share.
// Use `application` for the MCPB bundle and `library` for the npm
// package. npm names the root component after the directory; it is set
// to the package name.
//
// Run it while <dir>/package-lock.json is still there: npm takes each
// component's hash (SHA-512) and registry URL from the lockfile.
//
// Deterministic: the timestamp is SOURCE_DATE_EPOCH (unix seconds,
// required) and the serialNumber is a UUID derived from the SHA-256 of
// the rest of the document, so two builds of the same commit with the
// same npm write the same bytes.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [dir, type, outFile] = process.argv.slice(2);
if (!dir || !["application", "library"].includes(type ?? "") || !outFile) {
  console.error("usage: release-sbom.mjs <dir> <application|library> <out-file>");
  process.exit(2);
}

const epoch = process.env.SOURCE_DATE_EPOCH ?? "";
if (!/^\d+$/.test(epoch)) {
  console.error("error: set SOURCE_DATE_EPOCH (unix seconds) for the SBOM timestamp.");
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
if (pkg.devDependencies) {
  // npm sbom would fail on the missing dev packages.
  console.error(`error: ${dir}/package.json still lists devDependencies.`);
  process.exit(2);
}
const raw = execFileSync("npm", ["sbom", "--sbom-format", "cyclonedx", "--sbom-type", type], {
  cwd: dir,
  encoding: "utf8",
});

const sbom = JSON.parse(raw);
if (sbom.bomFormat !== "CycloneDX" || !Array.isArray(sbom.components)) {
  throw new Error("npm sbom did not return a CycloneDX document");
}
sbom.metadata.component.name = pkg.name;
sbom.metadata.timestamp = new Date(Number(epoch) * 1000).toISOString();
// UUID (version 5 layout) from the content without the serialNumber.
const { serialNumber: _random, ...content } = sbom;
const digest = createHash("sha256").update(JSON.stringify(content)).digest("hex");
const variant = ((parseInt(digest[16], 16) & 0x3) | 0x8).toString(16);
sbom.serialNumber = `urn:uuid:${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
writeFileSync(outFile, JSON.stringify(sbom, null, 2) + "\n");
console.log(`Wrote ${outFile} (${sbom.components.length} components)`);
