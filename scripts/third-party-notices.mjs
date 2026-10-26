#!/usr/bin/env node
// Write THIRD_PARTY_NOTICES.md for every package installed below
// <dir>/node_modules and fail when a package's license is not on the
// allowlist. Used by scripts/build-mcpb.sh on the bundle's runtime tree,
// so the gate covers exactly what ships.
//
// Usage: node scripts/third-party-notices.mjs <dir> <out-file>
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

// Permissive licenses compatible with distributing the bundle under MIT.
// Extend only after a license review.
const ALLOWED = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Unlicense",
]);

const [dir, outFile] = process.argv.slice(2);
if (!dir || !outFile) {
  console.error("usage: third-party-notices.mjs <dir> <out-file>");
  process.exit(2);
}

/** SPDX ids from a license field: "MIT", "(MIT OR Apache-2.0)", legacy objects. */
function licenseOf(manifest) {
  const raw = manifest.license ?? manifest.licenses;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.map((l) => l.type ?? l).join(" OR ");
  if (raw && typeof raw === "object" && raw.type) return raw.type;
  return "UNKNOWN";
}

/** An OR expression passes if any alternative is allowed; AND needs all. */
function isAllowed(expr) {
  const clean = expr.replace(/[()]/g, " ").trim();
  return clean
    .split(/\s+OR\s+/)
    .some((alt) => alt.split(/\s+AND\s+/).every((id) => ALLOWED.has(id.trim())));
}

function collect(pkgRoot, out) {
  const nm = join(pkgRoot, "node_modules");
  if (!existsSync(nm)) return;
  for (const entry of readdirSync(nm).sort()) {
    if (entry.startsWith(".")) continue;
    const dirs = entry.startsWith("@")
      ? readdirSync(join(nm, entry))
          .sort()
          .map((s) => join(nm, entry, s))
      : [join(nm, entry)];
    for (const pkgDir of dirs) {
      const manifestPath = join(pkgDir, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const files = readdirSync(pkgDir)
        .filter((f) => /^(licen[cs]e|copying|notice)(\..*)?$/i.test(f))
        .sort();
      out.push({
        name: manifest.name,
        version: manifest.version,
        license: licenseOf(manifest),
        path: relative(dir, pkgDir).split("\\").join("/"),
        texts: files.map((f) => ({ file: f, text: readFileSync(join(pkgDir, f), "utf8").trim() })),
      });
      collect(pkgDir, out);
    }
  }
}

const packages = [];
collect(dir, packages);
packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const rejected = packages.filter((p) => !isAllowed(p.license));
if (rejected.length > 0) {
  for (const p of rejected) {
    console.error(
      `license not on the allowlist: ${p.name}@${p.version} (${p.license}) at ${p.path}`,
    );
  }
  process.exit(1);
}

const seen = new Set();
const sections = [];
for (const p of packages) {
  const id = `${p.name}@${p.version}`;
  if (seen.has(id)) continue;
  seen.add(id);
  const body = p.texts.length
    ? p.texts.map((t) => `${t.file}:\n\n\`\`\`\n${t.text}\n\`\`\``).join("\n\n")
    : "The package ships no separate license file; see its package.json license field.";
  sections.push(`## ${id}\n\nLicense: ${p.license}\n\n${body}\n`);
}

const header = `# Third-party notices

This bundle includes the following third-party packages, installed from
the project's package-lock.json. Each is listed with its declared license
and the license and notice files it ships.

`;
writeFileSync(outFile, header + sections.join("\n"));
console.error(`wrote ${seen.size} third-party notices to ${outFile}`);
