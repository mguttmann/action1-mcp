import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globals: false,
    // Coverage is OFF by default — flipping it on at the CI level
    // would multiply test wall-clock by ~3x with v8 instrumentation.
    // It can be opted into locally via `npx vitest run --coverage`,
    // which respects the thresholds + excludes configured below.
    //
    // NOTE: The v8 provider requires the `@vitest/coverage-v8` peer
    // package. Install it before running `--coverage`:
    //
    //   npm install --save-dev @vitest/coverage-v8
    //
    // Without that package, vitest aborts with a clear error telling
    // the operator what to install — no silent skip, no false-pass.
    coverage: {
      enabled: false,
      provider: "v8",
      reporter: ["text", "json", "html"],
      thresholds: {
        lines: 75,
        functions: 70,
        branches: 60,
        statements: 75,
      },
      // Exclude inputs that aren't meaningfully covered by tests:
      //   - node_modules / dist: third-party / build output
      //   - tests/**: the tests themselves
      //   - src/codegen/spec/**: the upstream OpenAPI snapshot we
      //     consume as data, not as branching code
      //   - src/tools/generated/index.ts: a 134-tool registration
      //     index whose lines are exercised through integration
      //     tests but which inflates the line-count denominator
      //     past anything the thresholds are calibrated for
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        "tests/**",
        "src/codegen/spec/**",
        "src/tools/generated/index.ts",
      ],
    },
  },
});
