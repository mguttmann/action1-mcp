import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // tests/e2e/ builds and starts the real artifacts (dist/, the MCPB
    // bundle); it runs through `npm run test:e2e` (vitest.e2e.config.ts),
    // not in the default unit/integration run.
    exclude: ["**/node_modules/**", "tests/e2e/**"],
    environment: "node",
    globals: false,
    // Many tests build the full server (every tool) or drive a real
    // HTTP app. That takes well under a second on an idle machine but
    // several seconds when other suites run in parallel, so the vitest
    // default of 5 s made them flaky under load. Tests that need more
    // still pass their own timeout.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Coverage is off in the default run and switched on by
    // `npm run test:coverage` (the CI coverage job). The thresholds are
    // a ratchet: they sit a small margin below what the suite reaches
    // today and may only go up.
    coverage: {
      enabled: false,
      provider: "v8",
      reporter: ["text-summary", "json-summary", "html"],
      // Count every source file, including ones no test imports.
      include: ["src/**/*.ts"],
      thresholds: {
        lines: 80,
        functions: 83,
        branches: 73,
        statements: 78,
        // Per-file floors for the security-relevant modules, a small
        // margin below what the suite reaches today, so a drop in one
        // of them cannot hide behind the global average.
        "src/tools/destructiveGuard.ts": {
          lines: 98,
          statements: 96,
          functions: 100,
          branches: 91,
        },
        "src/tools/orgScope.ts": { lines: 93, statements: 92, functions: 100, branches: 87 },
        "src/tools/raw.ts": { lines: 98, statements: 98, functions: 100, branches: 92 },
        "src/http.ts": { lines: 90, statements: 89, functions: 86, branches: 82 },
        "src/utils/pii.ts": { lines: 94, statements: 91, functions: 100, branches: 89 },
        "src/client/retry.ts": { lines: 95, statements: 93, functions: 100, branches: 95 },
      },
      // Exclude inputs that aren't meaningfully covered by tests:
      //   - src/codegen/spec/**: the upstream OpenAPI snapshot we
      //     consume as data, not as branching code
      //   - src/tools/generated/index.ts: generator output. Its
      //     behaviour is tested against the artifact itself
      //     (tests/integration/generatedTools.test.ts drives every
      //     destructive tool through MCP), but its sheer line count
      //     would swamp the thresholds calibrated for hand-written code
      exclude: ["src/codegen/spec/**", "src/tools/generated/index.ts"],
    },
  },
});
