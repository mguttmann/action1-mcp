import { readFileSync } from "node:fs";

const PACKAGE_NAME = "action1-mcp-server";

/**
 * The package version from package.json, the single place it is
 * maintained. Looked up next to the compiled module first (the MCPB
 * bundle ships `server/package.json` beside `server/index.js`), then one
 * directory up (repo checkout, npm install, Docker image: `dist/` or
 * `src/` beside `package.json`).
 */
export function readPackageVersion(baseUrl: string = import.meta.url): string {
  for (const rel of ["./package.json", "../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, baseUrl), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (pkg.name === PACKAGE_NAME && typeof pkg.version === "string") return pkg.version;
    } catch {
      // not there or not readable: try the next candidate
    }
  }
  return "0.0.0-unknown";
}

/** Server version reported in `initialize`, on `/healthz` and by `--help`. */
export const SERVER_VERSION = readPackageVersion();
